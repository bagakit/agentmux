import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { defineAgentProvider } from '../src/agent-provider.js'
import { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxAgentSession, AgentMuxStoredAgentSession } from '../src/types.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, `Private preparation fixture cleanup failed: ${errors.map(String).join('; ')}`)
})

const program = "process.stdin.setRawMode(true);process.stdin.on('data',d=>process.stdout.write('INPUT:'+d));console.log('READY:'+JSON.stringify({args:process.argv.slice(1),preparation:process.env.AGENTMUX_TEST_EXECUTION_PREPARED}));setInterval(()=>{},1000)"

async function fixture(seed?: 'running' | 'ended') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aep-')))
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key) && !key.startsWith('AGENTMUX_TEST_')) vi.stubEnv(key, undefined)
  const runtime = join(root, 'r'), state = join(root, 's')
  await mkdir(runtime, { mode: 0o700 }); await mkdir(state, { mode: 0o700 })
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtime); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', state)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const daemon = spawn(resolve(import.meta.dirname, '../vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
    ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let diagnostic = ''; daemon.stderr!.on('data', bytes => { diagnostic += String(bytes) })
  cleanups.push(async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) { const exited = once(daemon, 'exit'); daemon.kill('SIGTERM'); await exited }
    await rm(root, { recursive: true, force: true })
  })
  await Promise.race([once(daemon.stdio[3]!, 'data'), once(daemon, 'exit').then(() => { throw new Error(diagnostic) })])
  const provider = defineAgentProvider({ catalog: { id: 'preparation-process', label: 'Private preparation process', executable: process.execPath,
    expectedProcess: 'node', promptDelivery: 'positional-argv', readySignal: { kind: 'foreground-process', expectedProcess: 'node' },
    hookStrategy: { kind: 'none' }, resumeStrategy: { kind: 'provider-native', locator: 'session-id' }, acpStrategy: { kind: 'none' },
    capabilities: { terminal: true, timeline: 'unavailable', permission: 'none', providerResume: true, replyCorrelation: 'none' } },
    buildArgs: prompt => ['-e', program, prompt],
    buildResumeArgs: (nativeId, _path, prompt) => ['-e', program, nativeId, ...(prompt ? [prompt] : [])], hook: { rules: [] } })
  let preparations = 0, allowed = 1, observation = 'first-incomplete-observation'
  // Host's completed but incomplete attempt returns normally. Another prepare in
  // the same operation would start a fresh shell budget; fail immediately at that
  // boundary instead of making every regression spend another real 30 seconds.
  const prepareExecutionEnvironment = async () => {
    if (++preparations > allowed) throw new Error('Unexpected second shell preparation budget')
    vi.stubEnv('AGENTMUX_TEST_EXECUTION_PREPARED', observation)
  }
  const readers: Array<{ client: AgentMuxClient; store: AgentMuxFileAgentSessionStore; inner: any }> = []
  const reader = async () => {
    const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.sqlite'))
    const client = new AgentMuxClient({ store, providers: [provider], prepareExecutionEnvironment }), inner = client as any
    Object.defineProperty(inner.hookServer, 'port', { value: 0 })
    readers.push({ client, store, inner }); await client.connect()
    return { client, store, inner }
  }
  cleanups.push(async () => {
    // Remove semantic observers before stopping private Runs, so teardown cannot
    // be mistaken for a new recovery opportunity.
    for (const value of readers) await value.client.dispose()
    const cleanup = new CtxmuxRunAdapter()
    try {
      await cleanup.connect()
      for (const run of await cleanup.list()) if (run.state.type === 'running') await cleanup.stop(await cleanup.prepareStop(run.runId))
    } finally { cleanup.disconnect() }
  })
  const first = await reader()
  let original: AgentMuxStoredAgentSession | undefined
  if (seed) {
    const run = await first.inner.kernel.start({ operationKey: 'original-seed', program: process.execPath,
      args: seed === 'ended' ? ['-e', 'process.exit(0)'] : ['-e', program, 'original-native'], cwd: root, env: {} })
    if (seed === 'ended') await vi.waitFor(async () => expect((await first.inner.kernel.status(run.runId)).state.type).toBe('exited'))
    original = { kind: 'agent', agentSessionId: 'original-session', providerId: provider.id, executorId: provider.id,
      hostId: 'local', workspacePath: root, run: { runId: run.runId }, retiredRuns: [], createdAt: 1, updatedAt: 1,
      hookBindingId: 'original-hook', hookToken: 'private-hook', nativeHandle: { kind: 'provider', providerId: provider.id, sessionId: 'original-native' } }
    await first.store.compareAndSwap(null, original); await first.client.refreshAgentSession(original.agentSessionId)
  }
  const arm = (name: string, limit = 1) => {
    preparations = 0; allowed = limit; observation = name
    vi.stubEnv('AGENTMUX_TEST_EXECUTION_PREPARED', 'not-prepared')
  }
  const replay = async (session: Pick<AgentMuxAgentSession, 'run'>, owner = first) =>
    (await owner.client.readRunReplay(session.run)).replay.map(chunk => chunk.data).join('')
  const confirmed = async (session: AgentMuxAgentSession, owner = first) => {
    await vi.waitFor(async () => expect(await replay(session, owner)).toContain('"preparation":' + JSON.stringify(observation)))
    expect(preparations).toBe(1)
    expect((await owner.client.listRuns()).find(run => run.runId === session.run.runId)?.state).toBe('running')
    if (original) {
      expect(session.agentSessionId).toBe(original.agentSessionId)
      expect(session.run).not.toEqual(original.run)
      expect(session.nativeHandle).toEqual(original.nativeHandle)
      expect(await replay(session, owner)).toContain('original-native')
    }
  }
  return { ...first, root, provider, original: original!, reader, arm, confirmed, replay }
}

it('public create consumes one incomplete preparation and launches from that observation', async () => {
  const f = await fixture(); f.arm('create-observation')
  const session = await f.client.createAgent({ agentSessionId: 'created-session', createOperationId: 'original-create',
    providerId: f.provider.id, executorId: f.provider.id, workspacePath: f.root, prompt: 'original task', injectAgentMuxGuide: false })
  await f.confirmed(session)
})

it('direct resume consumes one preparation and reentry reads the original completed receipt without preparing', async () => {
  const f = await fixture('ended'); f.arm('direct-resume-observation')
  const request = { agentSessionId: f.original.agentSessionId, operationId: 'original-resume', prompt: 'continue original task' }
  const resumed = await f.client.resumeAgent(request); await f.confirmed(resumed)
  const runs = await f.client.listRuns()
  f.arm('must-not-prepare', 0)
  expect((await f.client.resumeAgent(request)).run).toEqual(resumed.run)
  expect((await f.client.listRuns()).map(run => run.runId)).toEqual(runs.map(run => run.runId))
})

it('continuity reuses its prepared probe through the actual native resume', async () => {
  const f = await fixture('ended'); f.arm('continuity-observation')
  const result = await f.client.ensureAgentContinuity({ agentSessionId: f.original.agentSessionId,
    expectedRun: f.original.run, operationId: 'original-continuity', trigger: 'manual' })
  expect(result.kind, JSON.stringify(result)).toBe('resumed')
  if (result.kind !== 'resumed') throw new Error(JSON.stringify(result))
  await f.confirmed(result.session)
})

it('new restart reuses its local preflight preparation before replacing the original Run', async () => {
  const f = await fixture('running'); f.arm('restart-observation')
  const request = { agentSessionId: f.original.agentSessionId, expectedRun: f.original.run, operationId: 'original-restart' }
  const resumed = await f.client.restartAgent(request); await f.confirmed(resumed)
  f.arm('must-not-prepare', 0)
  expect((await f.client.restartAgent(request)).run).toEqual(resumed.run)
  expect(await f.client.inspectAgentRestart(request)).toMatchObject({ phase: 'restarted', newRun: resumed.run })
})

it('restart reentry prepares once when only its durable reservation survives the previous Core owner', async () => {
  const f = await fixture('running'); f.arm('original-preflight')
  const request = { agentSessionId: f.original.agentSessionId, expectedRun: f.original.run, operationId: 'interrupted-restart' }
  const reserve = f.inner.registry.reserveRestart.bind(f.inner.registry)
  vi.spyOn(f.inner.registry, 'reserveRestart').mockImplementationOnce(async (...args: any[]) => {
    await reserve(...args); throw new Error('Private interruption after durable restart admission')
  })
  await expect(f.client.restartAgent(request)).rejects.toThrow('Private interruption after durable restart admission')
  expect(await f.store.readLifecycleReservation(f.original.agentSessionId)).toMatchObject({ kind: 'resume', expectedRun: f.original.run })
  await f.client.dispose()
  f.arm('new-owner-preparation')
  const next = await f.reader()
  const resumed = await next.client.restartAgent(request); await f.confirmed(resumed, next)
})

it('healthy original Run reattachment, reads and input do not wait for environment preparation', async () => {
  const f = await fixture('running'); f.arm('must-not-prepare', 0)
  const result = await f.client.ensureAgentContinuity({ agentSessionId: f.original.agentSessionId,
    expectedRun: f.original.run, operationId: 'healthy-observation', trigger: 'manual' })
  expect(result.kind).toBe('reattachable')
  expect((await f.client.readAgentSession(f.original.agentSessionId))?.run).toEqual(f.original.run)
  await vi.waitFor(async () => expect(await f.replay(f.original)).toContain('READY:'))
  await f.client.writeAgent({ agentSessionId: f.original.agentSessionId, expectedRun: f.original.run, source: 'user', data: 'still-healthy' })
  await vi.waitFor(async () => expect(await f.replay(f.original)).toContain('INPUT:still-healthy'))
})
