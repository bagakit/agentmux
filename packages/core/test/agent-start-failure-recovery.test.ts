import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentProviderRegistry, defineAgentProvider } from '../src/agent-provider.js'
import { AgentHookServer } from '../src/hook-server.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession } from '../src/types.js'

let root: string, client: AgentMuxClient, inner: any, store: AgentMuxMemoryAgentSessionStore
let events: AgentMuxClientEvent[], old: AgentMuxStoredAgentSession, oldRun: CtxmuxAdapterRun, newRun: CtxmuxAdapterRun
let raw: string, attach: ReturnType<typeof vi.fn>, input: ReturnType<typeof vi.fn>
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'amx-start-recovery-'))
  for (const [key, path] of Object.entries({ AGENTMUX_RUNTIME_DIRECTORY: 'runtime', AGENTMUX_STATE_DIRECTORY: 'state',
    AGENTMUX_MESSAGE_QUEUE_PATH: 'messages.ndjson', CODEX_HOME: 'home' })) vi.stubEnv(key, join(root, path))
  const template = new AgentProviderRegistry().get('codex')
  const provider = defineAgentProvider({ catalog: { ...template.catalog, id: 'startup-fixture', label: 'Startup fixture',
    executable: 'fixture', expectedProcess: 'fixture', hookStrategy: { kind: 'none' },
    readySignal: { kind: 'foreground-process', expectedProcess: 'fixture' } },
    hook: { rules: [], eventNameSource: { kind: 'payload', payloadKey: 'hook_event_name' } },
    terminalHandshake: { query: '\x1b[?u', response: '\x1b[?0u' },
    buildArgs: (_prompt, args) => [...args], buildResumeArgs: (id, _path, _prompt, args) => [...args, id] })
  old = { kind: 'agent', agentSessionId: 'original', providerId: provider.id, executorId: 'fixture', hostId: 'local',
    workspacePath: root, run: { runId: 'original-run' }, retiredRuns: [], hookBindingId: 'A'.repeat(43),
    hookToken: 'B'.repeat(43), createdAt: 1000, updatedAt: 1000,
    nativeHandle: { kind: 'provider', providerId: provider.id, sessionId: 'original-native' } }
  oldRun = { runId: old.run.runId, lifecycleOperationId: null, program: 'fixture', args: [], workspacePath: root,
    pid: 100, state: { type: 'exited', code: 0, signal: null }, cols: 80, rows: 24,
    latestOutputBytes: 30, firstAvailableByte: 0, acceptedInputBytes: 10 }
  newRun = { ...oldRun, runId: 'failed-run', pid: 101, state: { type: 'exited', code: 1, signal: null }, acceptedInputBytes: 0 }
  raw = '\x1b[31mError: missing platform dependency\x1b[0m\r\n'
  store = new AgentMuxMemoryAgentSessionStore(); await store.compareAndSwap(null, old)
  client = new AgentMuxClient({ store, providers: [provider] }); inner = client as any
  await inner.registry.load('local'); inner.connected = true
  inner.hookServer = new AgentHookServer((event, signal) => inner.acceptHookEvent(event, signal), 0)
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
    return { run: newRun, replay: [{ data: raw }] }
  })
  inner.kernel.attach = attach
  vi.spyOn(client, 'probeAgent').mockResolvedValue({ providerId: provider.id, executable: 'fixture', installed: true,
    capabilities: provider.catalog.capabilities })
  events = []; client.onEvent(event => { events.push(structuredClone(event)) })
  vi.spyOn(Date, 'now').mockReturnValue(1000)
})
afterEach(async () => {
  await client.dispose(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true })
})
it('publishes the successful durable rollback after the failed binding in one clock tick, then the original Run state', async () => {
  await expect(client.resumeAgent({ agentSessionId: old.agentSessionId, operationId: 'resume', prompt: 'resume original draft' })).rejects.toThrow('missing platform dependency')
  const canonical = (await store.load() as AgentMuxStoredAgentSession[])[0]!
  expect(canonical).toMatchObject({ agentSessionId: old.agentSessionId, run: old.run, nativeHandle: old.nativeHandle,
    retiredRuns: [newRunRef()], updatedAt: 1001 })
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
  const cas = store.compareAndSwap.bind(store)
  vi.spyOn(store, 'compareAndSwap').mockImplementation(async (expected, next, signal) => {
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
  expect(attach).toHaveBeenCalledTimes(1); expect((await store.load() as AgentMuxStoredAgentSession[]).map(item => item.agentSessionId)).toEqual(['original'])
})
it('does not invent startup text when an exited Run has no observed output', async () => {
  raw = ''
  await expect(client.resumeAgent({ agentSessionId: old.agentSessionId, operationId: 'resume', prompt: 'resume original draft' })).rejects.toThrow('No startup output was observed.')
  expect(input).not.toHaveBeenCalled()
})
it('uses an already exited Attachment snapshot without waiting for another live exit event or query timeout', async () => {
  inner.kernel.attach = vi.fn(async () => ({ run: newRun, replay: [{ data: raw }] }))
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
