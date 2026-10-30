import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, vi } from 'vitest'
import * as Source from '../../src/index.js'
import { agentLifecycleOperationIdentity } from '../../src/agent-session-store.js'
import type { AgentMuxAgentResumeInput } from '../../src/agent-session-recovery.js'
import type { AgentMuxAgentSession, AgentMuxStoredAgentSession } from '../../src/types.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../../test/fixture-values.mjs'

export const core: typeof Source & Record<string, any> = process.env.AGENTMUX_TEST_DURABLE_RESUME_ENTRY
  ? await import(/* @vite-ignore */ process.env.AGENTMUX_TEST_DURABLE_RESUME_ENTRY)
  : { ...Source, ...await import('../../src/public-rpc-server.js'), ...await import('../../src/hosted-runtime-service.js') }
if (process.env.AGENTMUX_TEST_DURABLE_RESUME_MUTANT) expect(Reflect.get(core, 'AGENTMUX_DURABLE_RESUME_MUTANT')).toBe(process.env.AGENTMUX_TEST_DURABLE_RESUME_MUTANT)
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, fork: ((path: string | URL, args: readonly string[], options: import('node:child_process').ForkOptions) =>
    actual.fork(String(path).endsWith('/control-endpoint-listener-worker.js')
      ? fileURLToPath(new URL('../../src/control-endpoint-listener-worker.ts', import.meta.url)) : path, args, options)) as typeof actual.fork }
})
export const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Private resume fixture cleanup failed')
})
export async function fixture(delivery: 'positional-argv' | 'post-launch-only' = 'positional-argv', fatal = false, owner: 'file' | 'memory' = 'file') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'adr-')))
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key) && !key.startsWith('AGENTMUX_TEST_')) vi.stubEnv(key, undefined)
  const runtime = join(root, 'r'), state = join(root, 's')
  await mkdir(runtime, { mode: 0o700 }); await mkdir(state, { mode: 0o700 })
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtime); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', state)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const daemon = spawn(process.env.AGENTMUX_TEST_CTXMUXD ?? resolve(import.meta.dirname, '../../vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
    ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let daemonError = ''; daemon.stderr!.on('data', bytes => { daemonError += String(bytes) })
  cleanups.push(async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) { const exited = once(daemon, 'exit'); daemon.kill('SIGTERM'); await exited }
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
  })
  await Promise.race([once(daemon.stdio[3]!, 'data'), once(daemon, 'exit').then(() => { throw new Error(daemonError) })])
  const provider = core.defineAgentProvider({ catalog: { id: 'resume-process', label: 'Controlled resume process', executable: process.execPath,
    expectedProcess: 'node', promptDelivery: delivery, readySignal: { kind: 'foreground-process', expectedProcess: 'node' },
    hookStrategy: { kind: 'none' }, resumeStrategy: { kind: 'provider-native', locator: 'session-id' }, acpStrategy: { kind: 'none' },
    capabilities: { terminal: true, timeline: 'unavailable', permission: 'none', providerResume: true, replyCorrelation: 'none' } },
    ...(fatal ? { terminalHandshake: { query: '\x1b[?u', response: '\x1b[?0u' } } : {}),
    buildArgs: (_prompt, args) => [...args], buildResumeArgs: (id, _path, prompt, args) => [...args, id, ...(prompt ? [prompt] : [])], hook: { rules: [] } })
  const storePath = join(root, 'sessions.sqlite'), clients: Array<any> = []
  const memory = owner === 'memory' ? new core.AgentMuxMemoryAgentSessionStore() : undefined
  async function reader() {
    const store = memory ?? new core.AgentMuxFileAgentSessionStore(storePath), client = new core.AgentMuxClient({ store, providers: [provider] }), inner = client as any
    Object.defineProperty(inner.hookServer, 'port', { value: 0 }); await client.connect()
    const rawInput = vi.fn(), openInput = inner.kernel.openInput.bind(inner.kernel), observed = new WeakSet<object>()
    vi.spyOn(inner.kernel, 'openInput').mockImplementation(async (...args: any[]) => {
      const channel = await openInput(...args)
      if (!observed.has(channel)) {
        observed.add(channel); const dispatch = channel.input.bind(channel)
        channel.input = (data: unknown) => { rawInput(data); return dispatch(data) }
      }
      return channel
    })
    const semanticInput = vi.spyOn(inner.kernel, 'input')
    const value = { store, client, inner, rawInput, nativeStart: inner.kernel.startPrepared.bind(inner.kernel), nativeList: inner.kernel.list.bind(inner.kernel),
      start: vi.spyOn(inner.kernel, 'startPrepared'), stop: vi.spyOn(inner.kernel, 'stop'), input: semanticInput,
      inputCount: () => rawInput.mock.calls.length + semanticInput.mock.calls.length }
    clients.push(value); return value
  }
  const original = await reader()
  cleanups.push(async () => {
    const errors: unknown[] = []
    for (const value of clients.slice().reverse()) {
      try {
        if (value.inner.kernel.isConnected()) for (const run of await value.nativeList()) if (run.state.type === 'running') {
          try { await value.inner.kernel.stop(await value.inner.kernel.prepareStop(run.runId)) } catch (error) { errors.push(error) }
        }
      } catch (error) { errors.push(error) }
      try { await value.client.dispose() } catch (error) { errors.push(error) }
      // Drain original metadata owners before deleting their private fixture files.
      try { await value.inner.registry.enqueue('original-session', async () => {}) } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'Private Core clients cleanup failed')
  })

  const ended = await original.inner.kernel.start({ operationKey: 'original-seed', program: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root, env: {} })
  await vi.waitFor(async () => expect((await original.inner.kernel.status(ended.runId)).state.type).toBe('exited'))
  original.start.mockClear()
  const previous: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-session', providerId: provider.id, executorId: 'configured-resume',
    hostId: 'local', workspacePath: root, run: { runId: ended.runId }, retiredRuns: [], createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1),
    hookBindingId: 'original-binding', hookToken: 'original-token', nativeHandle: { kind: 'provider', providerId: provider.id, sessionId: 'original-native' } }
  await original.store.compareAndSwap(null, previous); await original.inner.registry.load('local')
  const program = fatal ? "console.log('Error: controlled startup exit');process.exit(1)" : "process.stdin.setRawMode(true);process.stdin.on('data',d=>process.stdout.write('INPUT:'+d.toString()));console.log('LAUNCH:'+JSON.stringify(process.argv.slice(1)));setInterval(()=>{},1000)"
  const request: AgentMuxAgentResumeInput = { agentSessionId: previous.agentSessionId, operationId: 'original-resume', prompt: 'the frozen original task',
    agentMuxNote: 'explicit context', args: ['-e', program], env: { RESUME_FIXTURE: 'original' }, cols: 81, rows: 25 }
  const resume = (changes: Partial<AgentMuxAgentResumeInput> = {}, owner = original) => owner.client.resumeAgent({ ...request, ...changes })
  const replay = async (session: Pick<AgentMuxAgentSession, 'run'>, owner = original) => (await owner.client.readRunReplay(session.run)).replay.map(chunk => chunk.data).join('')
  const write = async (session: AgentMuxAgentSession, owner = original) => {
    await vi.waitFor(async () => expect(await replay(session, owner)).toContain('LAUNCH:'))
    await owner.client.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, source: 'user', data: 'still-working' })
    await vi.waitFor(async () => expect(await replay(session, owner)).toContain('INPUT:still-working'))
  }
  const noReplacement = (inputs = 0) => {
    expect(clients.reduce((n, value) => n + value.start.mock.calls.length, 0)).toBe(1)
    expect(clients.reduce((n, value) => n + value.inputCount(), 0)).toBe(inputs)
    for (const value of clients) expect(value.stop).not.toHaveBeenCalled()
  }
  const correlation = async () => (await original.store.loadResumeCorrelation(previous.agentSessionId, agentLifecycleOperationIdentity('resume', previous.agentSessionId, request.operationId))) ?? undefined
  return { ...original, root, previous, request, provider, reader, resume, replay, write, noReplacement, correlation }
}

export async function otherRuntime(f: Awaited<ReturnType<typeof fixture>>) {
  const runtime = join(f.root, 'r2'), state = join(f.root, 's2')
  await mkdir(runtime, { mode: 0o700 }); await mkdir(state, { mode: 0o700 })
  const socketPath = join(runtime, 'ctxmux.sock')
  const daemon = spawn(process.env.AGENTMUX_TEST_CTXMUXD ?? resolve(import.meta.dirname, '../../vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
    ['--socket', socketPath, '--state-dir', state, '--readiness-fd', '3'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let stderr = ''; daemon.stderr!.on('data', bytes => { stderr += String(bytes) })
  const kernel = new f.inner.kernel.constructor()
  Object.defineProperty(kernel, 'socketPath', { value: socketPath, configurable: true })
  cleanups.push(async () => {
    const errors: unknown[] = []
    try { if (kernel.isConnected()) for (const run of await kernel.list()) if (run.state.type === 'running') await kernel.stop(await kernel.prepareStop(run.runId)) } catch (e) { errors.push(e) }
    if (kernel.isConnected() && f.inner.kernel.isConnected() && f.inner.kernel.creationRuntimeIdentity().runtimeId === kernel.creationRuntimeIdentity().runtimeId) f.inner.kernel.disconnect()
    kernel.disconnect()
    if (daemon.exitCode === null && daemon.signalCode === null) { const exited = once(daemon, 'exit'); daemon.kill('SIGTERM'); await exited }
    if (errors.length) throw new AggregateError(errors, 'Second private Runtime cleanup failed')
  })
  await Promise.race([once(daemon.stdio[3]!, 'data'), once(daemon, 'exit').then(() => { throw new Error(stderr) })])
  await kernel.connect()
  expect(kernel.creationRuntimeIdentity().runtimeId).not.toBe(f.inner.kernel.creationRuntimeIdentity().runtimeId)
  return { kernel, socketPath }
}
