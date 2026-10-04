import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { ObjectCliProbe } from './helpers/object-cli-rpc.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { loadAgentSessions } from '../src/agent-session-store.js'
import { readCodexPromptExecutionEvidence } from '../src/providers/codex-prompt-execution-evidence.js'
import { observeCodexSessionStatus } from '../src/providers/codex-session-status.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession, AgentProviderSessionStatus, NativeHookEnvelope } from '../src/types.js'
import type { AgentProviderSessionStatusObservationContext } from '../src/agent-provider.js'
import type { AgentMuxRpcMethod, AgentMuxRpcParams } from '../src/public-rpc.js'

const SID = 'caller', NATIVE = 'owned-native-main', TURN = 'failed-turn'
const message = 'Selected model is at capacity. Please try a different model.'
const error = { message, codex_error_info: 'server_overloaded' }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const line = (value: unknown) => JSON.stringify(value) + '\n'
const boundary = (type: string, turn: string, ordinal: number, extra = {}, time = Date.now()) => ({
  timestamp: new Date(time).toISOString(), ordinal, type: 'event_msg', payload: { type, turn_id: turn, ...extra }
})

async function fixture(records: unknown[] = [boundary('task_complete', TURN, 1, { error })]) {
  const f = await rpcOwnerFixture([SID, 'neighbor']); cleanups.push(f.close)
  const file = join(f.root, 'rollout-owned.jsonl')
  await writeFile(file, line({ type: 'session_meta', payload: { id: NATIVE, source: 'cli' } }) + records.map(line).join(''))
  const before = (await loadAgentSessions(f.store)).find(item => item.agentSessionId === SID)!
  const nativeHandle = { kind: 'provider' as const, providerId: 'codex', sessionId: NATIVE, transcriptPath: file }
  const session = { ...before, nativeHandle }
  await f.store.compareAndSwap(before, session); await f.client.refreshAgentSession(SID, session.run)
  const events: AgentMuxClientEvent[] = []; f.client.onEvent(event => events.push(event))
  f.inner.kernel.start = vi.fn(() => { throw new Error('Forbidden model/Run start') })
  f.inner.kernel.connect = vi.fn(() => { throw new Error('Forbidden Runtime connect') })
  cleanups.push(async () => { for (const name of ['start', 'connect', 'stop', 'attach']) expect(f.inner.kernel[name]).not.toHaveBeenCalled() })
  const context = { args: [], workspacePath: f.root, nativeHandle, signal: new AbortController().signal }
  const stored = async () => (await loadAgentSessions(f.store)).find(item => item.agentSessionId === SID)!
  const semantic = () => f.client.agentSession(SID).semanticStatus
  return { ...f, file, session, nativeHandle, events, context, stored, semantic }
}

it('recognizes the real native failure through Core, RPC and the compiled public CLI with the Run alive', async () => {
  const f = await fixture(), neighbor = f.client.agentSession('neighbor')
  if (process.env.AMX_FAILURE_CLI) vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', process.env.AMX_FAILURE_CLI)
  const service = new AgentMuxRpcService({ coreClients: f.coreClients })
  cleanups.push(() => service.dispose())
  const inspected = await service.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: SID } })
  if (process.env.AMX_FAILURE_PROOF) await writeFile(join(process.env.AMX_FAILURE_PROOF, 'public-inspect.json'), JSON.stringify(inspected, null, 2))
  expect(inspected.status).toMatchObject({ session: { semanticStatus: { state: 'error', source: 'native-transcript',
    failure: { code: 'AGENT_MODEL_OVERLOADED', nativeCode: 'server_overloaded', nativeTurnId: TURN, message } } },
    run: { state: 'running' } })
  expect(inspected.status!.session.semanticStatus!.failure).not.toHaveProperty('httpStatusCode')
  expect(inspected.session.run).toEqual(f.session.run)
  expect(f.client.agentSession('neighbor')).toEqual(neighbor)
  const event = f.events.find(event => event.type === 'agent-status')
  expect(event).toMatchObject({ type: 'agent-status', state: 'error', failure: { code: 'AGENT_MODEL_OVERLOADED' },
    evidence: { source: 'native-transcript', run: f.session.run } })
  const probe = new ObjectCliProbe(request => service.call(request.method as AgentMuxRpcMethod,
    request.params as AgentMuxRpcParams<AgentMuxRpcMethod>)); await probe.start(); cleanups.push(() => probe.stop())
  const cli = await probe.run(['agent', 'inspect', '--session', SID])
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout)).toMatchObject({ ok: true, result: { status: { session: { semanticStatus: { state: 'error',
    failure: { code: 'AGENT_MODEL_OVERLOADED', nativeCode: 'server_overloaded', message } } } } } })
  const help = await probe.run(['agent', 'inspect', '--help'])
  expect(help.code).toBe(0); expect(help.stdout).toContain('semanticStatus.failure')
  expect(probe.requests.map(request => request.method)).toEqual(['agent.inspect'])
  const listed = await service.call('agent.ls', { agentSessionId: SID })
  expect(listed.sessions).toEqual([expect.objectContaining({
    session: expect.objectContaining({ semanticStatus: expect.objectContaining({ failure: expect.objectContaining({ code: 'AGENT_MODEL_OVERLOADED' }) }) }) })])
  const listedCli = await probe.run(['agent', 'ls', '--session', SID])
  expect(listedCli.code, listedCli.stderr).toBe(0)
  expect(JSON.parse(listedCli.stdout).result.sessions[0].session.semanticStatus.failure.code).toBe('AGENT_MODEL_OVERLOADED')
  const self = await service.call('whoami', {}, { caller: f.credentials })
  expect(self.status?.session.semanticStatus?.failure?.code).toBe('AGENT_MODEL_OVERLOADED')
  if (process.env.AMX_FAILURE_PROOF) {
    await mkdir(process.env.AMX_FAILURE_PROOF, { recursive: true })
    await writeFile(join(process.env.AMX_FAILURE_PROOF, 'public-inspect.json'), JSON.stringify(inspected, null, 2))
    await writeFile(join(process.env.AMX_FAILURE_PROOF, 'compiled-cli.json'), cli.stdout)
  }
})

it('clears failure on a new turn in one appended batch and keeps the failure in durable history after success', async () => {
  const f = await fixture([boundary('task_started', TURN, 1)])
  await f.client.statusAgent(SID)
  const time = Date.now() - 500
  await appendFile(f.file, line(boundary('task_complete', TURN, 2, { error }, time)) +
    line(boundary('task_started', 'retry-turn', 3, {}, time + 1)))
  await vi.waitFor(() => expect(f.events.filter(event => event.type === 'agent-status').map(event => event.state)).toEqual(['working', 'error', 'working']))
  expect(f.semantic()).toMatchObject({ state: 'working', nativeTurnId: 'retry-turn' })
  expect(f.semantic()).not.toHaveProperty('failure')
  await appendFile(f.file, line(boundary('task_complete', 'retry-turn', 4, { last_agent_message: 'Finished' })))
  await vi.waitFor(() => expect(f.semantic()?.state).toBe('done'))
  expect((await f.stored()).semanticStatus).not.toHaveProperty('failure')
  const timeline = await f.store.loadTimeline(SID)
  expect(timeline.items.filter(item => item.status === 'failed')).toEqual([expect.objectContaining({
    source: 'native-transcript', content: expect.stringContaining('AGENT_MODEL_OVERLOADED') })])
  const now = f.semantic()!.observedAt
  await f.client.statusAgent(SID); await f.client.statusAgent(SID)
  expect(f.semantic()!.observedAt).toBe(now)
})

it('retains the exact error across a separate process Store restart without replaying a prior resume turn', async () => {
  const f = await fixture(); await f.client.statusAgent(SID)
  const entry = resolve(process.env.AMX_FAILURE_COMPILED ?? 'packages/core/dist', 'agent-session-store.js')
  const program = `import { AgentMuxFileAgentSessionStore } from ${JSON.stringify(new URL('file://' + entry).href)};
    const s=new AgentMuxFileAgentSessionStore(process.argv[1]);console.log(JSON.stringify(await s.load()));`
  const result = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', program, f.store.path], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', diagnostic = ''; child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { diagnostic += data })
    child.once('error', reject); child.once('close', code => code === 0 ? resolve(output) : reject(new Error(diagnostic)))
  })
  const recovered = (JSON.parse(result) as AgentMuxStoredAgentSession[]).find(item => item.agentSessionId === SID)!
  expect(recovered).toMatchObject({ run: f.session.run, nativeHandle: f.nativeHandle,
    semanticStatus: { state: 'error', failure: { nativeCode: 'server_overloaded', code: 'AGENT_MODEL_OVERLOADED' } } })
  const evidence = await readCodexPromptExecutionEvidence(f.context)
  const observations: AgentProviderSessionStatus[] = []
  const observer = await observeCodexSessionStatus({ ...f.context,
    nativePromptPredecessor: { run: { runId: 'resumed-run' }, previousRun: f.session.run,
      sourceId: evidence!.sourceId, evidenceId: evidence!.id },
    onStatus: value => observations.push(value), onUnavailable: (_code, message) => { throw new Error(message) } })
  observer.dispose(); expect(observations).toEqual([])
})

it('keeps interrupted turns neutral, and rejects old turn ends and child failures in initial and live reads', async () => {
  const f = await fixture([boundary('task_complete', 'old-turn', 1), boundary('task_started', 'current-turn', 2),
    boundary('task_complete', 'old-turn', 3, { error }), boundary('task_complete', 'child-turn', 4, { error, thread_id: 'child-thread' })])
  await f.client.statusAgent(SID)
  expect(f.semantic()).toMatchObject({ state: 'working', nativeTurnId: 'current-turn' })
  await appendFile(f.file, line(boundary('task_complete', 'old-turn', 5, { error })) +
    line(boundary('task_complete', 'child-turn', 6, { error, thread_id: 'child-thread' })) +
    line(boundary('turn_aborted', 'current-turn', 7, { reason: 'interrupted' })))
  await vi.waitFor(() => expect(f.semantic()?.state).toBe('running'))
  expect(f.semantic()).not.toHaveProperty('failure')
  expect(f.events.some(event => event.type === 'agent-status' && event.state === 'error')).toBe(false)
})

it('does not relabel malformed current native records as a prior successful result', async () => {
  const f = await fixture([boundary('task_complete', 'old-turn', 1), { type: 'event_msg', ordinal: 2, payload: { type: 'task_complete', error } }])
  expect(await readCodexPromptExecutionEvidence(f.context)).toBeNull()
  const status = await f.client.statusAgent(SID)
  expect(status.run.state).toBe('running'); expect(status.session.semanticStatus?.state).not.toBe('done')
  expect(f.events).toContainEqual(expect.objectContaining({ type: 'agent-error', code: 'AGENT_NATIVE_STATUS_UNCONFIRMED' }))
})

it('handles a split Unicode record, observes only its exact source, and releases the watch on abort', async () => {
  const f = await fixture([]), controller = new AbortController(), seen: AgentProviderSessionStatus[] = [], failures: string[] = []
  const observer = await observeCodexSessionStatus({ ...f.context, signal: controller.signal,
    onStatus: value => seen.push(value), onUnavailable: code => failures.push(code) })
  await writeFile(join(f.root, 'unrelated.jsonl'), line(boundary('task_complete', 'foreign-turn', 1, { error })))
  const record = Buffer.from(line(boundary('task_complete', TURN, 1, { error: { ...error, message: '容量不足 中文' } })))
  const split = record.indexOf(Buffer.from('中')) + 1
  await appendFile(f.file, record.subarray(0, split)); await new Promise(resolve => setTimeout(resolve, 30))
  expect(seen).toEqual([])
  await appendFile(f.file, record.subarray(split)); await vi.waitFor(() => expect(seen).toHaveLength(1))
  expect(seen[0]).toMatchObject({ state: 'error', failure: { message: '容量不足 中文' } }); expect(failures).toEqual([])
  controller.abort(); observer.dispose()
  await appendFile(f.file, line(boundary('task_complete', 'ignored', 2)))
  await new Promise(resolve => setTimeout(resolve, 30)); expect(seen).toHaveLength(1)
})

it('keeps healthy input and the retained error during observation failure, then reconnects on Inspect', async () => {
  const f = await fixture(); await f.client.statusAgent(SID)
  const retained = f.semantic(), originalRun = f.client.agentSession(SID).run
  await rename(f.file, f.file + '.removed')
  await vi.waitFor(() => expect(f.events.some(event => event.type === 'agent-error')).toBe(true))
  expect(f.semantic()).toEqual(retained)
  f.inner.kernel.identity = () => ({ daemonInstanceId: 'private' })
  f.inner.kernel.input = vi.fn(async () => ({ run: f.run(originalRun.runId), appliedByteRange: { startByte: 0, endByte: 1 } }))
  await expect(f.client.writeAgent({ agentSessionId: SID, expectedRun: originalRun, source: 'user', data: 'x' })).resolves.toMatchObject({ appliedByteRange: { endByte: 1 } })
  await rename(f.file + '.removed', f.file); await f.client.statusAgent(SID)
  await appendFile(f.file, line(boundary('task_started', 'new-turn', 2)))
  await vi.waitFor(() => expect(f.semantic()).toMatchObject({ state: 'working', nativeTurnId: 'new-turn' }))
  expect(f.client.agentSession(SID).run).toEqual(originalRun)
})

it.each([TURN, undefined, 'prior-turn'])('does not let a delayed Stop Hook with turn %s erase the confirmed native error', async turnId => {
  const f = await fixture(); await f.client.statusAgent(SID)
  Reflect.get(f.client, 'hookNativeWitnesses').set(f.session.run.runId, { candidate: JSON.stringify(NATIVE), handle: f.nativeHandle })
  const envelope: NativeHookEnvelope = { receiptId: 'late-stop', agentSessionId: SID, runId: f.session.run.runId,
    providerId: 'codex', eventName: 'Stop', payload: { hook_event_name: 'Stop', session_id: NATIVE,
      transcript_path: f.file, ...(turnId ? { turn_id: turnId } : {}) } }
  await Reflect.get(f.client, 'acceptHookEvent').call(f.client, envelope, new AbortController().signal)
  expect(f.semantic()).toMatchObject({ state: 'error', failure: { code: 'AGENT_MODEL_OVERLOADED' } })
  expect(f.events.filter(event => event.type === 'agent-status').map(event => event.state)).toEqual(['error'])
})

it.each([undefined, 'prior-turn', 'current-turn'])('uses native outcomes after mid-turn tool activity and Stop with turn %s', async turnId => {
  const f = await fixture([boundary('task_started', 'current-turn', 1)]); await f.client.statusAgent(SID)
  Reflect.get(f.client, 'hookNativeWitnesses').set(f.session.run.runId, { candidate: JSON.stringify(NATIVE), handle: f.nativeHandle })
  const feed = async (eventName: string, turn: string | undefined) => {
    const envelope: NativeHookEnvelope = { receiptId: eventName + '-' + String(turn), agentSessionId: SID, runId: f.session.run.runId,
      providerId: 'codex', eventName, payload: { hook_event_name: eventName, session_id: NATIVE,
        transcript_path: f.file, tool_name: 'shell', ...(turn ? { turn_id: turn } : {}) } }
    await Reflect.get(f.client, 'acceptHookEvent').call(f.client, envelope, new AbortController().signal)
  }
  await feed('PostToolUse', 'current-turn')
  expect(f.semantic()).toMatchObject({ state: 'working', source: 'native-hook' })
  await feed('Stop', turnId)
  expect(f.semantic()?.state).toBe('working')
  expect(f.events.some(event => event.type === 'agent-status' && event.state === 'done')).toBe(false)
  await appendFile(f.file, line(boundary('task_complete', 'current-turn', 2, { error })))
  await vi.waitFor(() => expect(f.semantic()).toMatchObject({ state: 'error', failure: { code: 'AGENT_MODEL_OVERLOADED' } }))
})

it('keeps the completed Hook contract of a Provider that owns outcomes through Hooks', async () => {
  const f = await fixture([]), previous = await f.stored()
  const session = { ...previous, providerId: 'hermes', executorId: 'hermes' }
  delete session.nativeHandle
  await f.store.compareAndSwap(previous, session); await f.client.refreshAgentSession(SID, session.run)
  const feed = async (eventName: string, extra = {}) => {
    await Reflect.get(f.client, 'acceptHookEvent').call(f.client, { receiptId: eventName, agentSessionId: SID, runId: session.run.runId,
      providerId: 'hermes', eventName, payload: { hook_event_name: eventName, session_id: NATIVE, extra } }, new AbortController().signal)
  }
  await feed('pre_llm_call'); expect(f.semantic()?.state).toBe('working')
  await feed('on_session_end', { completed: true }); expect(f.semantic()?.state).toBe('done')
  expect(f.events.some(event => event.type === 'agent-status' && event.state === 'done')).toBe(true)
})

it('drains an in-flight durable write without resurrecting a disconnected native turn phase or emitting stale status', async () => {
  const f = await fixture(), apply = f.store.applyTimelineMutation.bind(f.store)
  let release!: () => void, started!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { started = resolve })
  vi.spyOn(f.store, 'applyTimelineMutation').mockImplementationOnce(async (...args) => {
    started(); await blocked; return apply(...args)
  })
  const read = f.client.statusAgent(SID)
  await entered; f.client.disconnect()
  let disposed = false
  const disposal = f.client.dispose().then(() => { disposed = true })
  await new Promise(resolve => setTimeout(resolve, 20)); expect(disposed).toBe(false)
  release(); await read; await disposal
  expect(Reflect.get(f.client, 'hookTurnPhases').size).toBe(0)
  expect(f.events.some(event => event.type === 'agent-status')).toBe(false)
  expect((await f.stored()).semanticStatus?.failure?.code).toBe('AGENT_MODEL_OVERLOADED')
})

it('never renews the old working clock from repeated snapshots', async () => {
  const old = Date.now() - 20 * 60_000, f = await fixture([boundary('task_started', TURN, 1, {}, old)])
  await f.client.statusAgent(SID); expect(f.semantic()?.observedAt).toBe(old)
  expect((await f.client.statusAgent(SID)).observation.semantic).toBe('unknown')
  expect(f.semantic()?.observedAt).toBe(old)
})

it.each(['Run', 'native source'])('rejects callbacks after a changed %s, and disposes on disconnect', async target => {
  const f = await fixture([]), providers = Reflect.get(f.client, 'providers'), original = providers.get('codex')
  let observation!: AgentProviderSessionStatusObservationContext
  const dispose = vi.fn()
  vi.spyOn(providers, 'get').mockReturnValue({ ...original, observeSessionStatus: async (context: AgentProviderSessionStatusObservationContext) => {
    observation = context; return { dispose }
  } })
  await f.client.statusAgent(SID)
  const previous = await f.stored()
  const replacement = target === 'Run' ? { ...previous, run: { runId: 'replacement-run' }, retiredRuns: [previous.run], updatedAt: Date.now() }
    : { ...previous, nativeHandle: { ...f.nativeHandle, sessionId: 'replacement-native' }, updatedAt: Date.now() }
  await f.store.compareAndSwap(previous, replacement)
  await f.client.refreshAgentSession(SID, replacement.run)
  observation.onStatus({ recordId: 'late', nativeTurnId: TURN, state: 'error', failure: {
    code: 'AGENT_MODEL_OVERLOADED', message, nativeTurnId: TURN, recovery: 'Retry later' } })
  // Wait for the actual owner lane; a fixed delay can assert before durable writes finish.
  await Reflect.get(f.client, 'nativeStatusWatches').get(SID).pending
  expect(f.semantic()).toBeUndefined(); expect(f.events.some(event => event.type === 'agent-status')).toBe(false)
  await f.client.disconnect(); expect(dispose).toHaveBeenCalled(); expect(observation.signal.aborted).toBe(true)
})
