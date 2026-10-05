import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { agentTurnCompletionIdentity } from '../src/agent-session-identity.js'
import type { AgentMuxClientEvent } from '../src/types.js'

const scopes: Array<Awaited<ReturnType<typeof headlessFixture>>> = []
afterEach(async () => { for (const scope of scopes.splice(0)) await scope.cleanup() })
describe('Headless public Core Runtime port over real private Unix owner', () => {
  it('owns Provider, native Hook, permission, input, history and semantic resume without a Desktop', async () => {
    const scope = await headlessFixture(); scopes.push(scope)
    const client = await scope.client(), events: AgentMuxClientEvent[] = []
    client.onEvent(event => events.push(event))
    expect(client.catalog().map(entry => entry.id)).toEqual(['codex'])
    expect(client.runtimeOwnerIdentity()).toMatchObject({ runtimeId: scope.owner.runtimeId, availability: 'connected' })
    expect(client.runtimeOwnerIdentity()?.runtimeId).not.toBe(client.runtimeIdentity().instanceId)
    const command = resolve(import.meta.dirname, 'fixtures/fake-codex-cli.mjs')
    expect((await client.probeExecutorAvailability('codex', command)).availability).toBe('available')
    const session = await client.createAgent({ injectAgentMuxGuide: true, providerId: 'codex', executorId: 'codex', workspacePath: scope.root,
      createOperationId: 'headless-create', commandOverride: command,
      env: { AGENTMUX_FAKE_PERMISSION_REQUEST: '1', AGENTMUX_FAKE_SELF_CONTEXT: '1' }, cols: 80, rows: 24 })
    const attached = await client.reattachAgent(session.agentSessionId, 0, 'terminal')
    expect(attached.attachment.run.runId).toBe(session.run.runId)
    const invalidCaller = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: scope.socketPath },
      credentials: { agentSessionId: session.agentSessionId, capability: 'invalid-capability' } })
    await expect(invalidCaller.call('runtime.invoke', { consumerId: 'invalid-managed-caller', fence: { runtimeId: scope.owner.runtimeId, ownerInstanceId: scope.owner.ownerInstanceId }, invocation: { method: 'listRuns', args: [] } }))
      .rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    await invalidCaller.dispose()
    if (!client.forwardRpc) throw new Error('The actual Node Runtime client must forward native public RPC')
    expect((await client.forwardRpc('agent.ls', {})).sessions.map(value => value.session.agentSessionId)).toEqual([session.agentSessionId])
    const offlineRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: `${scope.root}/not-opened.sock` } })
    const offline = await connectHostedAgentMux({ rpc: offlineRpc, waitForReady: false })
    const federation = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'healthy', client }, { hostId: 'first-offline', client: offline }] })
    await expect(federation.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: session.agentSessionId } }))
      .resolves.toMatchObject({ session: { agentSessionId: session.agentSessionId }, status: { run: { runId: session.run.runId } } })
    await expect(federation.call('agent.inspect', { target: { kind: 'run', run: session.run } }))
      .resolves.toMatchObject({ session: { agentSessionId: session.agentSessionId } })
    await expect(federation.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'unobserved-session' } }))
      .rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    await expect(federation.call('agent.ls', {})).resolves.toMatchObject({
      errors: [{ agentSessionId: null, hostId: 'first-offline', code: 'RUNTIME_UNAVAILABLE' }] })
    await federation.dispose(); await offline.dispose(); await offlineRpc.dispose()

    // The managed guide can answer before this Terminal reader attaches. Observe
    // the authoritative raw replay cut, including bytes preceding live events.
    const selfContext = await until(async () => {
      const replay = await client.readRunReplay(session.run, 0, 'raw')
      expect(replay.gap).toBeNull()
      return Buffer.concat(replay.replay.map(event => Buffer.from(event.dataBytes))).toString('utf8')
    }, value => /codex-whoami:[^\r\n]+\r?\n/u.test(value), 'default guide exact owner whoami')
    const context = JSON.parse(selfContext.slice(selfContext.indexOf('codex-whoami:') + 'codex-whoami:'.length).split('\n')[0]!.trim())
    expect(context.ok).toBe(true)
    expect(context.operation).toBe('whoami')
    expect(context.result.session.agentSessionId).toBe(session.agentSessionId)
    expect(context.result.status.run.runId).toBe(session.run.runId)
    expect(context.result.status.capabilities).toMatchObject({ terminal: true, permission: 'respond' })
    expect(context.result.view).toEqual({ attached: false, reason: 'no-desktop-view' })
    expect(context.result.unavailable).toEqual([])
    const waiting = await until(() => client.agentSession(session.agentSessionId), value => value.pendingInteraction?.request.kind === 'permission', 'native permission')
    expect(waiting.nativeHandle).toMatchObject({ kind: 'provider', providerId: 'codex', sessionId: `native-${session.agentSessionId}` })
    const request = waiting.pendingInteraction!.request
    await client.respondAgentInteraction({ agentSessionId: session.agentSessionId, expectedRun: session.run,
      response: { kind: 'permission', requestId: request.id, decision: { outcome: 'selected', optionId: 'allow-once' } } })
    await until(() => client.agentSession(session.agentSessionId), value => !value.pendingInteraction && value.semanticStatus?.state === 'done', 'permission settlement and native Stop')
    const page = await client.sessionHistoryPage(session.agentSessionId)
    expect(page.items).toEqual([{ id: 'fixture-native-record', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'native history fixture' }] }])
    const changes: unknown[] = []
    const history = await client.observeSessionHistory(session.agentSessionId, observation => changes.push(observation), {})
    await until(() => changes, value => value.length > 0, 'native history observation'); history.dispose()
    await client.submitAgentPrompt({ ...agentPromptCondition(client.agentSession(session.agentSessionId)), agentSessionId: session.agentSessionId,
      operationId: 'headless-prompt', prompt: 'headless-port-input' })
    await until(() => events.filter(event => event.type === 'terminal-output').map(event => event.data).join(''), value => value.includes('headless-port-input'), 'same Run prompt bytes')
    await until(() => client.agentSession(session.agentSessionId), value =>
      value.promptCompletionAdmission?.submissionId === 'headless-prompt' &&
      agentTurnCompletionIdentity(value) !== undefined &&
      agentTurnCompletionIdentity(value) !== value.promptCompletionAdmission.completionId,
    'new native Stop after first prompt admission')
    const nativeSend = await client.forwardRpc('agent.send', { target: { kind: 'agent-session', agentSessionId: session.agentSessionId },
      operationId: 'headless-native-send', text: 'headless-native-port-input' })
    expect(nativeSend.delivery.state).toBe('delivered')
    expect(nativeSend.envelope.recipientRunId).toBe(session.run.runId)
    await until(() => events.filter(event => event.type === 'terminal-output').map(event => event.data).join(''), value => value.includes('headless-native-port-input'), 'native exact owner prompt bytes')
    await until(() => client.agentSession(session.agentSessionId), value =>
      value.promptCompletionAdmission?.submissionId === nativeSend.messageId &&
      agentTurnCompletionIdentity(value) !== undefined &&
      agentTurnCompletionIdentity(value) !== value.promptCompletionAdmission.completionId,
    'native Stop after owner-authenticated message')
    const RoutedService: typeof AgentMuxRpcService = process.env.AGENTMUX_TEST_PUBLIC_RPC_SERVICE_ENTRY
      ? (await import(process.env.AGENTMUX_TEST_PUBLIC_RPC_SERVICE_ENTRY)).AgentMuxRpcService : AgentMuxRpcService
    const routed = new RoutedService({ coreClients: () => [{ hostId: 'remote', client }], execute: async request => {
      if (request.operation !== 'inspect.region') throw new Error('Only the Desktop-owned address is observed here')
      return { operation: 'inspect.region', region: { kind: 'agent', tabId: 'desktop-tab', regionId: 'desktop-region', workspaceId: 'desktop-workspace',
        agentSessionId: session.agentSessionId, providerId: 'codex', executorId: 'codex', bounds: { x: 0, y: 0, width: 1, height: 1 },
        neighbors: { left: { kind: 'none' }, right: { kind: 'none' }, up: { kind: 'none' }, down: { kind: 'none' } } } }
    } })
    const routedMessage = routed.call('agent.send', { target: { kind: 'region', regionId: 'desktop-region' },
      operationId: 'desktop-region-remote-message', text: 'desktop-resolved-owner-input' })
    const routedOutcome = await routedMessage.then(value => ({ value }), error => ({ error }))
    expect(routedOutcome, 'Desktop region routes its canonical Session to the original remote owner').toMatchObject({ value: {
      envelope: { recipientSessionId: session.agentSessionId, recipientRunId: session.run.runId }, delivery: { state: 'delivered' } } })
    await until(() => events.filter(event => event.type === 'terminal-output').map(event => event.data).join(''),
      value => value.includes('desktop-resolved-owner-input'), 'Desktop region reaches actual remote Core Input')
    await routed.dispose()
    expect((await client.statusAgent(session.agentSessionId)).run.runId).toBe(session.run.runId)
    expect(events.filter(event => event.type === 'interaction')).toHaveLength(1)
    const raw = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: scope.socketPath } })
    const replay: unknown[] = []
    let finish!: () => void, fail!: (error: Error) => void
    const complete = new Promise<void>((yes, no) => { finish = yes; fail = no })
    const reader = await raw.subscribe('agent.output', { agentSessionId: session.agentSessionId, follow: false }, {
      onInitial: value => expect(value.run.runId).toBe(session.run.runId),
      onEvent: value => { if (value.type === 'output') replay.push(value.data) },
      onEnd: error => error ? fail(error) : finish()
    })
    await complete; await reader.dispose(); await raw.dispose()
    expect(replay.length).toBeGreaterThan(0)
    await client.signalAgent(session.agentSessionId, session.run, 'SIGINT')
    await until(() => events.filter(event => event.type === 'terminal-output').map(event => event.data).join(''), value => value.includes('codex-interrupt'), 'portable interrupt')
    const ended = await client.createAgent({ providerId: 'codex', executorId: 'codex', workspacePath: scope.root,
      injectAgentMuxGuide: false, createOperationId: 'native-exit-create', commandOverride: command,
      env: { AGENTMUX_FAKE_PERMISSION_REQUEST: '1', AGENTMUX_FAKE_EXIT_AFTER_PERMISSION: '1' } })
    const ending = await until(() => client.agentSession(ended.agentSessionId), value => value.pendingInteraction?.request.kind === 'permission', 'exiting fixture permission')
    await client.respondAgentInteraction({ agentSessionId: ended.agentSessionId, expectedRun: ended.run, response: { kind: 'permission',
      requestId: ending.pendingInteraction!.request.id, decision: { outcome: 'selected', optionId: 'allow-once' } } })
    await until(() => client.statusAgent(ended.agentSessionId), value => value.run.state !== 'running', 'native process exit')
    const continued = await client.ensureAgentContinuity({ agentSessionId: ended.agentSessionId, expectedRun: ended.run,
      operationId: 'headless-resume', commandOverride: command })
    expect(continued.kind).toBe('resumed')
    if (continued.kind !== 'resumed') throw new Error('Expected native resume')
    expect(continued.session.agentSessionId).toBe(ended.agentSessionId)
    expect(continued.session.run.runId).not.toBe(ended.run.runId)
    await client.stopAgent(session.agentSessionId, session.run)
    await client.stopAgent(continued.session.agentSessionId, continued.session.run)
    expect((await client.listRuns()).some(run => run.runId === continued.session.run.runId)).toBe(false)
  }, 120_000)
  it('preserves an explicit non-file Unix owner without claiming durable Session identity or stopping its live Run', async () => {
    const scope = await headlessFixture({ memoryStore: true }); scopes.push(scope)
    const client = await scope.client(), first = scope.owner
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: scope.socketPath } })
    try {
      const initial = await rpc.call('runtime.bootstrap', { consumerId: 'memory-observer', fence: { runtimeId: first.runtimeId, ownerInstanceId: first.ownerInstanceId } })
      expect(initial.storePath, 'ephemeral memory Store cannot claim a durable file').toBeNull()
      const initialIdentityFile = await readFile(join(scope.root, 's', 'semantic-runtime.json')).then(value => ({ value }), error => ({ error }))
      expect(initialIdentityFile, 'an ephemeral Store must not claim durable Runtime identity').toMatchObject({ error: { code: 'ENOENT' } })
      const run = await client.createTerminal({ createOperationId: 'ephemeral-owner-terminal', workspacePath: scope.root,
        command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] })
      await client.dispose(); await scope.restart()
      expect(scope.owner.runtimeId, 'each non-file owner has an explicit new ephemeral identity').not.toBe(first.runtimeId)
      const restartedIdentityFile = await readFile(join(scope.root, 's', 'semantic-runtime.json')).then(value => ({ value }), error => ({ error }))
      expect(restartedIdentityFile, 'an ephemeral Store must not claim durable Runtime identity').toMatchObject({ error: { code: 'ENOENT' } })
      const next = await scope.client()
      expect((await next.listRuns()).find(value => value.runId === run.runId)).toMatchObject({ state: 'running', pid: run.pid })
      await next.stopTerminal({ runId: run.runId })
    } finally { await rpc.dispose() }
  }, 120_000)
  it('serves, reports and shuts down an explicit CLI owner while keeping its Run live', async () => {
    const scope = await headlessFixture({ cli: true }); scopes.push(scope)
    const client = await scope.client()
    const command = resolve(import.meta.dirname, '../dist/headless-runtime-cli.js')
    const execute = promisify(execFile)
    const status = await execute(process.execPath, [command, '--endpoint', `unix:${scope.socketPath}`, 'status'], { env: scope.env })
    expect(JSON.parse(status.stdout).result.owner.runtimeId).toBe(scope.owner.runtimeId)
    const concurrent = execute(process.execPath, [command, 'serve'], { env: scope.env })
    await expect(concurrent).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('RUNTIME_OWNER_BUSY') })
    const run = await client.createTerminal({ createOperationId: 'explicit-cli-terminal', workspacePath: scope.root,
      command: process.execPath, args: ['-e', 'process.stdout.write("cli-run-ready");setInterval(()=>{},1000)'] })
    await client.dispose()
    const stopped = await execute(process.execPath, [command, '--endpoint', `unix:${scope.socketPath}`, 'shutdown'], { env: scope.env })
    expect(JSON.parse(stopped.stdout).result.accepted).toBe(true)
    await scope.stopOwner()
    await scope.restart()
    const recovered = await scope.client()
    const retained = (await recovered.listRuns()).find(value => value.runId === run.runId)
    expect(retained).toMatchObject({ state: 'running', pid: run.pid })
    await recovered.stopTerminal({ runId: run.runId })
  }, 120_000)

})
