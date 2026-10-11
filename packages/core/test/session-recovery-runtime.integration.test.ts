import { afterEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { createWorkspaceLayout } from '../src/spatial-layout.js'
import type { AgentMuxRpcClient } from '../src/public-rpc-client.js'
import type { AgentMuxClientEvent } from '../src/types.js'
import { until } from './helpers/headless-runtime-fixture.js'
import { recoveryRuntimeFixture } from './helpers/recovery-runtime-fixture.js'

const scopes: Array<Awaited<ReturnType<typeof recoveryRuntimeFixture>>> = []
afterEach(async () => {
  const outcomes = await Promise.allSettled(scopes.splice(0).reverse().map(scope => scope.cleanup()))
  const errors = outcomes.flatMap(value => value.status === 'rejected' ? [value.reason] : [])
  if (errors.length) throw new AggregateError(errors, 'Recovery proof cleanup failed')
})
const command = resolve(import.meta.dirname, 'fixtures/session-recovery-codex-cli.mjs')
type InputWitness = { kind: 'process' | 'stdin'; pid: number; isResume: boolean; agentSessionId?: string; cwd?: string; argv?: string[]; base64?: string }
const witnesses = async (path: string): Promise<InputWitness[]> => (await readFile(path, 'utf8')).trim().split('\n').map(value => JSON.parse(value))
const stdin = (values: InputWitness[], isResume: boolean) => values.filter(value => value.kind === 'stdin' && value.isResume === isResume)
  .map(value => Buffer.from(value.base64!, 'base64').toString('utf8')).join('')
const nativeRecords = async (path: string): Promise<Array<{ type: string; payload: Record<string, unknown> }>> =>
  (await readFile(path, 'utf8')).trim().split('\n').map(value => JSON.parse(value))

async function bindWorkface(rpc: AgentMuxRpcClient, root: string, agentSessionId: string) {
  return (await rpc.call('space.commit', { expectedRevision: 0, graph: {
    spaces: [], bindings: [],
    zones: [{ zoneId: 'recovery-zone', workspaceId: 'recovery-workspace', kind: 'directory', hostId: 'local', directoryPath: root, branch: null }],
    tabs: [{ tabId: 'recovery-tab', zoneId: 'recovery-zone', workspaceId: 'recovery-workspace', name: null, regionIds: ['recovery-region'] }],
    regions: [{ regionId: 'recovery-region', tabId: 'recovery-tab', kind: 'agent', agentSessionId,
      runId: null, execution: { hostId: 'local', cwd: root } }],
    layouts: { 'recovery-workspace': createWorkspaceLayout('recovery-group', ['recovery-tab']) },
    tabLayouts: { 'recovery-tab': { root: { type: 'leaf', regionId: 'recovery-region' }, activeRegionId: 'recovery-region' } }, resources: {}
  } })).state
}

describe('Real private ctxmux recovery through the public Core owner', () => {
  it('reattaches the original Session/Run/PID and durable workface after an owner process restart, then actually submits new input', async () => {
    const scope = await recoveryRuntimeFixture(); scopes.push(scope)
    const { client, rpc } = await scope.connect(), events: AgentMuxClientEvent[] = []
    client.onEvent(event => events.push(event))
    const witness = join(scope.root, 'input.ndjson')
    const original = await client.createAgent({ providerId: 'codex', executorId: 'codex', workspacePath: scope.root,
      commandOverride: command, createOperationId: 'private-healthy-agent', injectAgentMuxGuide: false,
      env: { AGENTMUX_FAKE_NATIVE_RECORD: '1', AGENTMUX_RECOVERY_INPUT_WITNESS: witness } })
    scope.trackRun(original.run.runId)
    const before = await client.reattachAgent(original.agentSessionId, 0, 'raw')
    scope.trackRun(original.run.runId, before.attachment.run.pid)
    const saved = await until(() => client.agentSession(original.agentSessionId), value => Boolean(value.nativeHandle) && value.semanticStatus?.state === 'done', 'original idle native Session')
    const workface = await bindWorkface(rpc, scope.root, original.agentSessionId)
    const previousOwner = scope.owner, previousNative = client.runtimeIdentity()
    await scope.stopOwner()
    await until(() => client.runtimeOwnerIdentity(), value => value?.availability === 'unverified', 'original owner offline')
    expect(client.agentSessions().map(value => value.agentSessionId)).toEqual([original.agentSessionId])
    const nextOwner = await scope.restartOwner()
    expect(nextOwner.runtimeId).toBe(previousOwner.runtimeId)
    expect(nextOwner.ownerInstanceId).not.toBe(previousOwner.ownerInstanceId)
    expect(nextOwner.ctxmux).toEqual(previousNative)
    await until(() => client.runtimeOwnerIdentity(), value => value?.ownerInstanceId === nextOwner.ownerInstanceId && value.availability === 'connected', 'original Hosted consumer reconnects')
    expect((await rpc.call('space.state', {})).state).toEqual(workface)
    const continuity = await client.ensureAgentContinuity({ agentSessionId: original.agentSessionId, expectedRun: original.run,
      operationId: 'private-owner-restarted', trigger: 'startup', commandOverride: command })
    expect(continuity.kind).toBe('reattachable')
    const after = await client.reattachAgent(original.agentSessionId, before.attachment.run.latestOutputBytes, 'raw')
    expect(after.session).toMatchObject({ agentSessionId: original.agentSessionId, nativeHandle: saved.nativeHandle, workspacePath: scope.root, run: original.run })
    expect(after.attachment.run).toMatchObject({ runId: original.run.runId, pid: before.attachment.run.pid, state: 'running' })
    const prompt = 'original-pty-after-owner-restart'
    await client.submitAgentPrompt({ ...agentPromptCondition(client.agentSession(original.agentSessionId)),
      agentSessionId: original.agentSessionId, operationId: 'new-input-on-original-pty', prompt })
    await until(() => events.flatMap(value => value.type === 'terminal-output' && value.run.runId === original.run.runId ? [value.data] : []).join(''),
      value => value.includes(`codex-submit:${prompt}:accepted`), 'original PTY accepts and responds to new public input')
    const received = await witnesses(witness)
    expect(received.filter(value => value.kind === 'process')).toHaveLength(1)
    expect(stdin(received, false)).toContain(prompt)
    expect(stdin(received, false)).not.toContain('<amux:continue />')
    expect((await client.statusAgent(original.agentSessionId)).run).toMatchObject({ runId: original.run.runId, pid: before.attachment.run.pid, state: 'running' })
    console.log(JSON.stringify({ schema: 'agentmux.private-session-recovery.v1', kind: 'original-pty-reattached',
      agentSessionId: original.agentSessionId, runId: original.run.runId, pid: before.attachment.run.pid,
      ownerRestarted: previousOwner.ownerInstanceId !== nextOwner.ownerInstanceId, sameNativeOwner: true, workfaceRetained: true, inputAccepted: true }))
  }, 120_000)

  it.each([
    { outcome: 'interrupted', nativeUnsupported: false, continuation: true },
    { outcome: 'completed', nativeUnsupported: false, continuation: false },
    { outcome: 'unknown', nativeUnsupported: false, continuation: false },
    { outcome: 'unknown', nativeUnsupported: true, continuation: false }
  ] as const)('resumes exact retained identity after $outcome termination (nativeUnsupported=$nativeUnsupported), continuation=$continuation', async scenario => {
    const scope = await recoveryRuntimeFixture({ nativeUnsupported: scenario.nativeUnsupported }); scopes.push(scope)
    const { client, rpc } = await scope.connect(), witness = join(scope.root, 'input.ndjson')
    const env = { AGENTMUX_FAKE_NATIVE_RECORD: '1', AGENTMUX_FAKE_NATIVE_PRESERVE: '1',
      AGENTMUX_FAKE_NATIVE_CONTEXT: 'Original private task and retained decision.',
      AGENTMUX_FAKE_READY_MODE: scenario.outcome === 'completed' ? 'before' : 'working-until-resume',
      AGENTMUX_RECOVERY_END_STATE: scenario.outcome, AGENTMUX_RECOVERY_INPUT_WITNESS: witness }
    const original = await client.createAgent({ providerId: 'codex', executorId: 'codex', workspacePath: scope.root,
      commandOverride: command, createOperationId: 'private-ended-agent', injectAgentMuxGuide: false, env })
    scope.trackRun(original.run.runId)
    const saved = await until(() => client.agentSession(original.agentSessionId), value => Boolean(value.nativeHandle) &&
      value.semanticStatus?.state === (scenario.outcome === 'completed' ? 'done' : 'working'), 'exact old native main activity')
    if (saved.nativeHandle?.kind !== 'provider' || !saved.nativeHandle.transcriptPath) throw new Error('Expected exact retained native record')
    const nativePath = saved.nativeHandle.transcriptPath
    const before = await client.statusAgent(original.agentSessionId)
    scope.trackRun(original.run.runId, before.run.pid)
    const workface = await bindWorkface(rpc, scope.root, original.agentSessionId)
    // The CLI actually terminates while its semantic owner is offline. The
    // daemon remains live and later reports the exact old Run as terminal.
    await scope.stopOwner()
    process.kill(before.run.pid!, 'SIGTERM')
    await until(() => {
      try { process.kill(before.run.pid!, 0); return false } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        return true
      }
    }, value => value, 'private original CLI really exits')
    const nextOwner = await scope.restartOwner()
    await until(() => client.runtimeOwnerIdentity(), value => value?.ownerInstanceId === nextOwner.ownerInstanceId && value.availability === 'connected', 'private semantic owner reconnects')
    const terminal = await client.statusAgent(original.agentSessionId)
    expect(terminal.run).toMatchObject({ runId: original.run.runId, pid: before.run.pid, state: 'exited' })
    expect((await rpc.call('space.state', {})).state).toEqual(workface)
    const request = { agentSessionId: original.agentSessionId, expectedRun: original.run, operationId: 'private-native-resume',
      trigger: 'startup' as const, commandOverride: command, env }
    const resumed = await client.ensureAgentContinuity(request)
    expect(resumed.kind).toBe('resumed')
    if (resumed.kind !== 'resumed') throw new Error(`Expected native resume, observed ${resumed.kind}`)
    scope.trackRun(resumed.run.runId)
    expect(resumed.run.runId).not.toBe(original.run.runId)
    expect(resumed.session).toMatchObject({ agentSessionId: original.agentSessionId, workspacePath: scope.root,
      nativeHandle: saved.nativeHandle, run: resumed.run })
    expect(resumed.continuity?.interruption).toMatchObject({ support: scenario.nativeUnsupported ? 'unsupported' : 'provider',
      state: scenario.continuation ? 'interrupted' : scenario.outcome === 'completed' ? 'not-interrupted' : 'unknown',
      source: scenario.nativeUnsupported ? 'none' : 'native-protocol', previousRun: original.run, nativeTarget: saved.nativeHandle })
    expect(resumed.continuity?.launchInput).toBeUndefined()
    const attached = await client.reattachAgent(original.agentSessionId, 0, 'raw')
    scope.trackRun(resumed.run.runId, attached.attachment.run.pid)
    expect(attached.attachment.run).toMatchObject({ runId: resumed.run.runId, state: 'running' })
    await until(() => nativeRecords(nativePath), values => values.some(value => value.type === 'fixture_resume'), 'new CLI reads the original native conversation')
    if (scenario.continuation) {
      const settled = await until(() => client.agentSession(original.agentSessionId), value => value.continuity?.recoveryDelivery?.phase === 'accepted', 'exact continuation receipt accepted')
      const delivery = settled.continuity!.recoveryDelivery!
      expect(delivery.continuation.text).toBe('<amux:continue />')
      expect(delivery.reminder.selected).toBe(false)
      expect((await client.inspectAgentPromptSubmission(delivery.key))?.admission).toMatchObject({ acknowledged: true,
        intent: { message: { userContent: '<amux:continue />' } } })
    } else expect(client.agentSession(original.agentSessionId).continuity?.recoveryDelivery).toBeUndefined()
    await client.ensureAgentContinuity(request)
    const received = await witnesses(witness), processes = received.filter(value => value.kind === 'process' && value.isResume)
    expect(processes).toHaveLength(1)
    expect(processes[0]).toMatchObject({ agentSessionId: original.agentSessionId, cwd: scope.root })
    expect(processes[0]!.argv).toContain(saved.nativeHandle.sessionId)
    expect(processes[0]!.argv!.join('\n')).not.toContain('<amux:continue')
    const resumedInput = stdin(received, true)
    expect(resumedInput.match(/<amux:continue \/>/gu) ?? []).toHaveLength(scenario.continuation ? 1 : 0)
    expect(resumedInput).not.toContain('Session recovery context')
    const retained = await nativeRecords(nativePath)
    expect(retained.filter(value => value.type === 'fixture_resume')).toEqual([{ type: 'fixture_resume', payload: { id: saved.nativeHandle.sessionId, cwd: scope.root } }])
    expect(retained.some(value => value.type === 'response_item' && value.payload.role === 'user')).toBe(true)
    expect(retained.some(value => value.type === 'response_item' && value.payload.role === 'assistant')).toBe(true)
    expect((await rpc.call('space.state', {})).state).toEqual(workface)
    console.log(JSON.stringify({ schema: 'agentmux.private-session-recovery.v1', kind: 'native-resume', outcome: scenario.outcome,
      nativeUnsupported: scenario.nativeUnsupported, agentSessionId: original.agentSessionId, nativeSessionId: saved.nativeHandle.sessionId,
      oldRunId: original.run.runId, oldPid: before.run.pid, newRunId: resumed.run.runId,
      workfaceRetained: true, originalConversationRead: true, continuationCount: scenario.continuation ? 1 : 0 }))
  }, 120_000)
})
