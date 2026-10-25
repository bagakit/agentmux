import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as SourceCore from '../src/index.js'
const core: typeof SourceCore = process.env.AGENTMUX_POST_START_ENTRY
  ? await import(/* @vite-ignore */ process.env.AGENTMUX_POST_START_ENTRY) : SourceCore
const { AgentMuxClient, AgentMuxError, AgentMuxMemoryAgentSessionStore, AgentProviderRegistry, defineAgentProvider } = core
if (process.env.AGENTMUX_POST_START_MUTANT) {
  expect(Reflect.get(core, 'AGENTMUX_POST_START_MUTANT')).toBe(process.env.AGENTMUX_POST_START_MUTANT)
}
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession } from '../src/types.js'

let root: string, client: SourceCore.AgentMuxClient, inner: any, store: SourceCore.AgentMuxMemoryAgentSessionStore
let events: AgentMuxClientEvent[], old: AgentMuxStoredAgentSession, oldRun: CtxmuxAdapterRun, newRun: CtxmuxAdapterRun
let raw: string, attach: ReturnType<typeof vi.fn>, input: ReturnType<typeof vi.fn>
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'amx-start-recovery-'))
  for (const [key, path] of Object.entries({ AGENTMUX_RUNTIME_DIRECTORY: 'runtime', AGENTMUX_STATE_DIRECTORY: 'state',
    AGENTMUX_MESSAGE_QUEUE_PATH: 'messages.ndjson', CODEX_HOME: 'home' })) vi.stubEnv(key, join(root, path))
  const template = new AgentProviderRegistry().get('codex')
  const provider = defineAgentProvider({ catalog: { ...template.catalog, id: 'startup-fixture', label: 'Startup fixture',
    executable: 'fixture', expectedProcess: 'fixture', capabilities: { terminal: true, timeline: 'unavailable', permission: 'none', providerResume: true, replyCorrelation: 'none' }, hookStrategy: { kind: 'none' },
    readySignal: { kind: 'foreground-process', expectedProcess: 'fixture' } },
    hook: { rules: [], eventNameSource: { kind: 'payload', payloadKey: 'hook_event_name' } },
    terminalHandshake: { query: '\x1b[?u', response: '\x1b[?0u' },
    buildArgs: (_prompt, args) => [...args], buildResumeArgs: (id, _path, _prompt, args) => [...args, id] })
  old = { kind: 'agent', agentSessionId: 'original', providerId: provider.id, executorId: 'fixture', hostId: 'local',
    workspacePath: root, run: { runId: 'original-run' }, retiredRuns: [], hookBindingId: 'A'.repeat(43),
    hookToken: 'B'.repeat(43), createdAt: 1000, updatedAt: 1000,
    nativeHandle: { kind: 'provider', providerId: provider.id, sessionId: 'original-native' } }
  oldRun = { nativeService: null, runId: old.run.runId, lifecycleOperationId: null, program: 'fixture', args: [], workspacePath: root,
    pid: 100, state: { type: 'exited', code: 0, signal: null }, cols: 80, rows: 24,
    latestOutputBytes: 30, firstAvailableByte: 0, acceptedInputBytes: 10 }
  newRun = { ...oldRun, runId: 'failed-run', pid: 101, state: { type: 'exited', code: 1, signal: null }, acceptedInputBytes: 0 }
  raw = '\x1b[31mError: missing platform dependency\x1b[0m\r\n'
  store = new AgentMuxMemoryAgentSessionStore(); await store.compareAndSwap(null, old)
  client = new AgentMuxClient({ store, providers: [provider] }); inner = client as any
  await inner.registry.load('local'); inner.connected = true
  Object.defineProperty(inner.hookServer, 'port', { value: 0 })
  await inner.hookServer.start()
  inner.kernel.isConnected = () => true
  inner.kernel.identity = () => ({ daemonInstanceId: 'private-startup', protocolVersion: 18, buildIdentity: 'fixture' })
  inner.kernel.start = vi.fn(async () => ({ ...newRun, state: { type: 'running' } }))
  inner.kernel.status = vi.fn(async (id: string) => id === oldRun.runId ? oldRun : newRun)
  input = vi.fn(); inner.kernel.input = input
  inner.kernel.hasAttachment = () => false; inner.kernel.detach = vi.fn(async () => {})
  attach = vi.fn(async () => {
    const next = inner.registry.findByRun({ runId: newRun.runId })
    if (next) inner.publisher.publish({ type: 'agent-session', session: structuredClone(next) })
    inner.publisher.publish({ type: 'process-state', agentSessionId: next?.agentSessionId,
      run: { runId: newRun.runId }, state: 'exited', pid: newRun.pid, exitCode: 1,
      evidence: { source: 'run-process', observedAt: Date.now(), run: { runId: newRun.runId } } })
    return { terminal: { type: 'not_requested' }, terminal_restore: new Uint8Array(0), resize_revision: 0, run: newRun, replay: [{ data: raw }] }
  })
  inner.kernel.attach = attach
  vi.spyOn(client as unknown as { probePreparedAgent: typeof client.probeAgent }, 'probePreparedAgent').mockResolvedValue({ providerId: provider.id, executable: 'fixture', installed: true,
    capabilities: provider.catalog.capabilities })
  events = []; client.onEvent(event => { events.push(structuredClone(event)) })
  vi.spyOn(Date, 'now').mockReturnValue(1000)
})
afterEach(async () => {
  await client?.dispose(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true })
})
it('publishes the successful durable rollback after the failed binding in one clock tick, then the original Run state', async () => {
  await expect(client.resumeAgent({ agentSessionId: old.agentSessionId, operationId: 'resume', prompt: 'resume original draft' })).rejects.toThrow('missing platform dependency')
  const canonical = (await store.load() as AgentMuxStoredAgentSession[])[0]!
  expect(canonical).toMatchObject({ agentSessionId: old.agentSessionId, run: old.run, nativeHandle: old.nativeHandle,
    retiredRuns: [newRunRef()] })
  expect(canonical.updatedAt).toBeGreaterThan(old.updatedAt)
  const transitions = events.filter(event => event.type === 'agent-session')
  expect(transitions.map(event => event.session.run.runId)).toEqual(['failed-run', 'original-run'])
  expect(transitions[1]!.session).toEqual(client.agentSession(old.agentSessionId))
  expect(events.at(-1)).toMatchObject({ type: 'process-state', agentSessionId: old.agentSessionId, run: old.run,
    state: 'exited', exitCode: 0, pid: oldRun.pid })
  expect(input).not.toHaveBeenCalled(); expect(attach).toHaveBeenCalledTimes(1)
  expect(inner.kernel.detach).toHaveBeenCalledWith('failed-run')
})
function newRunRef() { return { runId: newRun.runId } }
it('does not publish a rollback or original Run state when its real Store CAS fails', async () => {
  const cas = store.compareAndSwapMetadata.bind(store)
  vi.spyOn(store, 'compareAndSwapMetadata').mockImplementation(async (expected, next, signal) => {
    if ((expected as AgentMuxStoredAgentSession | null)?.run?.runId === newRun.runId && (next as AgentMuxStoredAgentSession | null)?.run?.runId === oldRun.runId) throw new Error('rollback Store rejected')
    return cas(expected, next, signal)
  })
  await expect(client.resumeAgent({ agentSessionId: old.agentSessionId, operationId: 'resume', prompt: 'resume original draft' })).rejects.toBeInstanceOf(AggregateError)
  expect(events.filter(event => event.type === 'agent-session').map(event => event.session.run.runId)).toEqual(['failed-run'])
  expect(events.filter(event => event.type === 'process-state').map(event => event.run.runId)).toEqual(['failed-run'])
  expect((await store.load() as AgentMuxStoredAgentSession[])[0]!.run).toEqual(newRunRef()); expect(input).not.toHaveBeenCalled()
})
it('retains the strict stale-Run prompt fence after restoring the original identity', async () => {
  await expect(client.resumeAgent({ agentSessionId: old.agentSessionId, operationId: 'resume', prompt: 'resume original draft' })).rejects.toThrow()
  await expect(inner.registry.refresh(old.agentSessionId, newRunRef())).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect(await inner.registry.refresh(old.agentSessionId, old.run)).toMatchObject({ run: old.run })
  expect(input).not.toHaveBeenCalled()
})
it('exposes generic bounded startup output and real code through public create, without controls or capability Input', async () => {
  raw = `${'x'.repeat(12000)}\x1b]0;private title\x07\x1b[31mError: fixture cannot load its runtime\x1b[0m\n`
  let failure: any
  try { await client.createAgent({ agentSessionId: 'new-session', providerId: 'startup-fixture', executorId: 'fixture',
    workspacePath: root, createOperationId: 'create', injectAgentMuxGuide: false, args: [] }) } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(AgentMuxError)
  expect(failure).toMatchObject({ code: 'AGENT_TERMINAL_HANDSHAKE_FAILED' })
  expect(failure.message).toContain('exit code 1'); expect(failure.message).toContain('Error: fixture cannot load its runtime')
  expect(failure.message).not.toContain('\x1b'); expect(failure.message).not.toContain('private title')
  expect(failure.message.length).toBeLessThan(4300); expect(input).not.toHaveBeenCalled()
  expect(attach).toHaveBeenCalledTimes(1); expect((await store.load() as AgentMuxStoredAgentSession[]).map(item => item.agentSessionId)).toEqual(['original', 'new-session'])
  expect(client.agentSession('new-session')).toMatchObject({ run: newRunRef(), creation: { failure: { code: 'AGENT_TERMINAL_HANDSHAKE_FAILED' } } })
  const states = events.filter((event): event is Extract<AgentMuxClientEvent, { type: 'process-state' }> =>
    event.type === 'process-state' && event.agentSessionId === 'new-session')
  expect(states.at(-1)).toMatchObject({ state: 'exited', exitCode: 1 })
  expect(states.slice(1).some(event => event.state === 'running')).toBe(false)
})
it('does not invent startup text when an exited Run has no observed output', async () => {
  raw = ''
  await expect(client.resumeAgent({ agentSessionId: old.agentSessionId, operationId: 'resume', prompt: 'resume original draft' })).rejects.toThrow('No startup output was observed.')
  expect(input).not.toHaveBeenCalled()
})
it('uses an already exited Attachment snapshot without waiting for another live exit event or query timeout', async () => {
  inner.kernel.attach = vi.fn(async () => ({ terminal: { type: 'not_requested' }, terminal_restore: new Uint8Array(0), resize_revision: 0, run: newRun, replay: [{ data: raw }] }))
  let failure: unknown
  let settled = false
  const result = client.resumeAgent({ agentSessionId: old.agentSessionId, operationId: 'resume', prompt: 'keep original' })
    .catch(error => { failure = error }).finally(() => { settled = true })
  await vi.waitFor(() => expect(settled).toBe(true), { timeout: 300 })
  await result
  expect(failure).toMatchObject({ code: 'AGENT_TERMINAL_HANDSHAKE_FAILED' })
  expect((failure as Error).message).toContain('missing platform dependency')
  expect(input).not.toHaveBeenCalled()
  expect(inner.kernel.attach).toHaveBeenCalledOnce()
})
it('keeps a failed exit-state observation honest instead of attaching a guessed startup cause', async () => {
  const status = inner.kernel.status
  let reads = 0
  inner.kernel.status = vi.fn(async (id: string) => {
    if (id === newRun.runId && ++reads === 1) throw new Error('state observation unavailable')
    return status(id)
  })
  await expect(client.resumeAgent({ agentSessionId: old.agentSessionId, operationId: 'resume', prompt: 'resume original draft' })).rejects.toThrow('Agent Run exited before its terminal capability query was observed.')
  expect(events.filter(event => event.type === 'agent-session').map(event => event.session.run.runId)).toEqual(['failed-run', 'original-run'])
})

it('preserves a confirmed fatal exit after recovering an applied commit acknowledgement', async () => {
  const commit = inner.registry.commitLifecycle.bind(inner.registry)
  vi.spyOn(inner.registry, 'commitLifecycle').mockImplementation(async (...args: unknown[]) => {
    await commit(...args)
    throw new Error('Commit acknowledgement unavailable')
  })
  await expect(client.ensureAgentContinuity({ agentSessionId: old.agentSessionId, expectedRun: old.run, operationId: 'resume-after-commit', trigger: 'manual' }))
    .rejects.toMatchObject({ code: 'AGENT_TERMINAL_HANDSHAKE_FAILED', message: expect.stringContaining('missing platform dependency') })
  expect((await store.readMetadata(old.agentSessionId))?.continuity?.error).toContain('missing platform dependency')
  expect((await store.readMetadata(old.agentSessionId))?.run).toEqual(old.run)
  expect(events.filter(event => event.type === 'process-state').at(-1)).toMatchObject({ run: old.run, state: 'exited' })
  expect(input).not.toHaveBeenCalled()
})

it('retains the typed original direct-resume fatal operation without starting or replaying it again', async () => {
  const request = { agentSessionId: old.agentSessionId, operationId: 'fatal-original', prompt: 'resume original draft' }
  await expect(client.resumeAgent(request)).rejects.toMatchObject({ code: 'AGENT_TERMINAL_HANDSHAKE_FAILED' })
  const operation = (await store.readMetadata(old.agentSessionId))?.continuityOperations?.[request.operationId]
  expect(operation).toMatchObject({ reason: 'process-exited', errorCode: 'AGENT_TERMINAL_HANDSHAKE_FAILED', previousRun: old.run, newRun: newRunRef() })
  await expect(client.resumeAgent(request)).rejects.toMatchObject({ code: 'AGENT_TERMINAL_HANDSHAKE_FAILED' })
  expect(inner.kernel.start).toHaveBeenCalledTimes(1); expect(input).not.toHaveBeenCalled()
  expect(client.agentSession(old.agentSessionId).run).toEqual(old.run)
})

it.each(['manual', 'input'] as const)('keeps a confirmed %s recovery failure terminal across original operation reads', async trigger => {
  const request = { agentSessionId: old.agentSessionId, expectedRun: old.run, operationId: 'failed-recovery', trigger,
    ...(trigger === 'input' ? { input: { submissionId: 'original-task', prompt: 'Keep this original task' } } : {}) }
  const failure = { code: 'AGENT_TERMINAL_HANDSHAKE_FAILED', message: expect.stringContaining('missing platform dependency') }
  await expect(client.ensureAgentContinuity(request)).rejects.toMatchObject(failure)
  const saved = (await store.readMetadata(old.agentSessionId))!
  expect(saved).toMatchObject({ run: old.run, nativeHandle: old.nativeHandle, retiredRuns: [newRunRef()],
    continuity: { kind: 'unavailable', reason: 'process-exited', errorCode: failure.code, error: failure.message,
      previousRun: old.run, newRun: newRunRef(), nativeTarget: old.nativeHandle } })
  for (let i = 0; i < 2; i++) await expect(client.ensureAgentContinuity(request)).rejects.toMatchObject(failure)
  expect(await store.readMetadata(old.agentSessionId)).toEqual(saved)
  expect(inner.kernel.start).toHaveBeenCalledOnce(); expect(attach).toHaveBeenCalledOnce()
  expect(input).not.toHaveBeenCalled()
})

it('keeps a failed rollback unconfirmed with its actual successor instead of claiming the original Run was restored', async () => {
  const cas = store.compareAndSwapMetadata.bind(store)
  vi.spyOn(store, 'compareAndSwapMetadata').mockImplementation(async (expected, next, ...rest) => {
    if (expected?.run.runId === newRun.runId && next?.run.runId === oldRun.runId) throw new Error('rollback Store rejected')
    return cas(expected, next, ...rest)
  })
  await expect(client.ensureAgentContinuity({ agentSessionId: old.agentSessionId, expectedRun: old.run,
    operationId: 'unconfirmed-rollback', trigger: 'manual' })).resolves.toMatchObject({ kind: 'pending', reason: 'operation-unconfirmed' })
  expect((await store.readMetadata(old.agentSessionId))!.run).toEqual(newRunRef())
  expect(inner.kernel.start).toHaveBeenCalledOnce(); expect(input).not.toHaveBeenCalled()
})

it('preserves cleanup failures as the cause of the original confirmed recovery failure', async () => {
  const create = inner.hookServer.createBinding.bind(inner.hookServer)
  vi.spyOn(inner.hookServer, 'createBinding').mockImplementation((...args: unknown[]) => {
    const binding = create(...args)
    vi.spyOn(binding, 'close').mockRejectedValueOnce(new Error('original hook cleanup unconfirmed'))
    return binding
  })
  let failure: any
  try { await client.ensureAgentContinuity({ agentSessionId: old.agentSessionId, expectedRun: old.run,
    operationId: 'failed-with-cleanup', trigger: 'manual' }) } catch (error) { failure = error }
  expect(failure).toMatchObject({ code: 'AGENT_TERMINAL_HANDSHAKE_FAILED', message: expect.stringContaining('missing platform dependency') })
  expect(failure.cause).toBeInstanceOf(AggregateError)
  expect(failure.cause.errors).toEqual([expect.objectContaining({ code: failure.code }),
    expect.objectContaining({ message: 'original hook cleanup unconfirmed' })])
  expect((await store.readMetadata(old.agentSessionId))!.run).toEqual(old.run)
})
