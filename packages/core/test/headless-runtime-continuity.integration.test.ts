import { fixturePath as upstreamFixturePath } from './helpers/fixture-values.js'
import { afterEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import type { AgentMuxClientEvent } from '../src/types.js'

const scopes: Array<Awaited<ReturnType<typeof headlessFixture>>> = []
afterEach(async () => { for (const scope of scopes.splice(0)) await scope.cleanup() })
describe('Headless semantic owner ordinary process continuity', () => {
  it('refreshes the original Hosted native identity after its private daemon restarts without replacing the semantic owner or RPC stream', async () => {
    // No Run is created before the restart. This private daemon cannot own a healthy user process.
    const scope = await headlessFixture(); scopes.push(scope)
    const client = await scope.client(), original = client.runtimeOwnerIdentity()!, events: AgentMuxClientEvent[] = []
    client.onEvent(event => events.push(event))
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: scope.socketPath } })
    try {
      await scope.restartNativeDaemon()
      const current = await until(async () => {
        try { return (await rpc.call('runtime.owner.identity', {})).owner } catch { return null }
      }, owner => Boolean(owner && owner.ctxmux.instanceId !== original.ctxmux.instanceId), 'original semantic owner observes the new private native identity')
      await until(() => events, values => values.some(event => event.type === 'connection-state' && event.state === 'restored'), 'actual Core native connection restored event')
      expect(current).toMatchObject({ runtimeId: original.runtimeId, ownerInstanceId: original.ownerInstanceId })
      expect(client.runtimeOwnerIdentity()).toMatchObject({ runtimeId: original.runtimeId, ownerInstanceId: original.ownerInstanceId, availability: 'connected' })
      expect(client.runtimeIdentity(), 'the same Hosted stream carries the current Native identity before a new input fence').toEqual(current!.ctxmux)
      const run = await client.createTerminal({ createOperationId: 'after-native-only-restart', workspacePath: scope.root, command: process.execPath,
        args: ['-e', 'process.stdin.setRawMode(true);process.stdout.write("ready");process.stdin.on("data",b=>process.stdout.write(b));setInterval(()=>{},1000)'] })
      await until(() => client.listRuns(), values => values.some(value => value.runId === run.runId && value.latestOutputBytes === 5), 'new Native Run ready')
      await client.attachTerminal(run.runId, 0, 'raw')
      const status = (await client.listRuns()).find(value => value.runId === run.runId)!
      expect(status.acceptedInputBytes).not.toBeNull()
      await client.writeTerminal({ runId: run.runId }, { ownerInstanceId: client.runtimeIdentity().instanceId,
        operationId: 'new-native-fence-input', expectedByte: status.acceptedInputBytes!, data: 'new-native-owner-input' })
      await until(() => events.filter(event => event.type === 'terminal-output').map(event => event.data).join(''), value => value.includes('new-native-owner-input'), 'the refreshed Native fence admits original new Run input')
      await client.stopTerminal({ runId: run.runId })
    } finally { await rpc.dispose() }
  }, 120_000)
  it('keeps a healthy Agent Session/Run/PID through failed Provider probe and owner restart', async () => {
    const scope = await headlessFixture(); scopes.push(scope)
    const client = await scope.client(), events: AgentMuxClientEvent[] = []
    client.onEvent(event => events.push(event))
    const command = resolve(import.meta.dirname, 'fixtures/fake-codex-cli.mjs')
    const session = await client.createAgent({ providerId: 'codex', executorId: 'codex', workspacePath: scope.root,
      injectAgentMuxGuide: false, createOperationId: 'continuity-create', commandOverride: command })
    const original = await client.reattachAgent(session.agentSessionId, 0, 'terminal')
    await until(() => client.agentSession(session.agentSessionId), value => Boolean(value.nativeHandle) && value.semanticStatus?.state === 'done', 'original native locator')
    await scope.failProbe()
    await expect(client.probeAgent('codex', command)).rejects.toThrow('fixture Provider probe failed')
    const continuing = client.ensureAgentContinuity({ agentSessionId: session.agentSessionId, expectedRun: session.run,
      operationId: 'live-probe-failed', commandOverride: command, env: {} })
    const continuityOutcome = await continuing.then(value => ({ value }), error => ({ error }))
    expect(continuityOutcome, 'healthy Run remains reattachable through failed Provider probe').toMatchObject({ value: { kind: 'reattachable' } })
    const cloned = client.agentSessions(); cloned[0]!.workspacePath = upstreamFixturePath("mutated-projection")
    expect(client.agentSession(session.agentSessionId).workspacePath).toBe(scope.root)
    const owner = scope.owner
    await scope.stopOwner()
    await until(() => client.runtimeOwnerIdentity(), value => value?.availability === 'unverified', 'offline owner availability')
    expect(client.agentSessions().map(value => value.agentSessionId)).toEqual([session.agentSessionId])
    expect(() => client.agentSession(session.agentSessionId)).toThrow('unverified')
    const restarted = await scope.restart()
    expect(restarted.owner.runtimeId).toBe(owner.runtimeId)
    expect(restarted.owner.ownerInstanceId).not.toBe(owner.ownerInstanceId)
    await until(() => events, values => values.some(value => value.type === 'connection-state' && value.state === 'restored'), 'remote service recovery')
    const restored = await client.statusAgent(session.agentSessionId)
    expect(restored.session.agentSessionId).toBe(session.agentSessionId)
    expect(restored.run.runId).toBe(session.run.runId)
    expect(restored.run.pid).toBe(original.attachment.run.pid)
    expect(restored.run.state).toBe('running')
    const snapshots = events.filter(value => value.type === 'terminal-snapshot')
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.run.runId).toBe(session.run.runId)
    await client.submitAgentPrompt({ ...agentPromptCondition(client.agentSession(session.agentSessionId)), agentSessionId: session.agentSessionId,
      operationId: 'same-agent-after-owner-restart', prompt: 'same-agent-after-restart' })
    await until(() => events.filter(value => value.type === 'terminal-output').map(value => value.data).join(''), value => value.includes('same-agent-after-restart'), 'restored same Run input/output')
    await client.stopAgent(session.agentSessionId, session.run)
  }, 120_000)
})
