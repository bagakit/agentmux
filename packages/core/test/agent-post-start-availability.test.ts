import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as SourceCore from '../src/index.js'
import type { AgentMuxStoredAgentSession, AgentMuxClientEvent } from '../src/types.js'

const core: typeof SourceCore = process.env.AGENTMUX_POST_START_ENTRY
  ? await import(/* @vite-ignore */ process.env.AGENTMUX_POST_START_ENTRY) : SourceCore
if (process.env.AGENTMUX_POST_START_MUTANT) {
  expect(Reflect.get(core, 'AGENTMUX_POST_START_MUTANT')).toBe(process.env.AGENTMUX_POST_START_MUTANT)
}
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aps-')))
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
  const runtime = join(root, 'r'), state = join(root, 's')
  await mkdir(runtime); await mkdir(state)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtime)
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', state)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const daemon = spawn(resolve(import.meta.dirname, '../vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
    ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let daemonError = ''
  daemon.stderr!.on('data', data => { daemonError += String(data) })
  cleanups.push(async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const exited = once(daemon, 'exit'); daemon.kill('SIGTERM'); await exited
    }
    await rm(root, { recursive: true, force: true })
  })
  await Promise.race([once(daemon.stdio[3]!, 'data'), once(daemon, 'exit').then(() => { throw new Error(daemonError) })])
  const base = core.defineAgentProvider({ catalog: {
    id: 'process-observer', label: 'Controlled process observer', executable: process.execPath,
    expectedProcess: 'node', promptDelivery: 'positional-argv', readySignal: { kind: 'foreground-process', expectedProcess: 'node' },
    hookStrategy: { kind: 'none' }, resumeStrategy: { kind: 'provider-native', locator: 'session-id' }, acpStrategy: { kind: 'none' },
    capabilities: { terminal: true, timeline: 'unavailable', permission: 'none', providerResume: true, replyCorrelation: 'none' }
  }, buildArgs: (_prompt, args) => [...args], buildResumeArgs: (_id, _path, _prompt, args) => [...args], hook: { rules: [] },
  discoverNativeSession: async () => ({ handle: { kind: 'provider', providerId: 'process-observer', sessionId: 'controlled-main' },
    assertCurrent: async () => {} }) })
  const store = new core.AgentMuxFileAgentSessionStore(join(root, 'sessions.sqlite'))
  const client = new core.AgentMuxClient({ store, providers: [base] }), inner = client as any
  Object.defineProperty(inner.hookServer, 'port', { value: 0 })
  await client.connect()
  cleanups.push(async () => {
    for (const run of await inner.kernel.list()) if (run.state.type === 'running') {
      await inner.kernel.stop(await inner.kernel.prepareStop(run.runId))
    }
    await client.dispose()
  })
  const events: AgentMuxClientEvent[] = []; client.onEvent(event => { events.push(event) })
  const start = vi.spyOn(inner.kernel, 'start'), stop = vi.spyOn(inner.kernel, 'stop'), input = vi.spyOn(inner.kernel, 'input')
  const program = "process.stdin.setRawMode(true);process.stdin.on('data',d=>process.stdout.write('INPUT:'+d.toString()));process.on('SIGINT',()=>process.exit(0));console.log('PRIVATE_READY')"
  const args = ['-e', program]
  const create = () => client.createAgentWithDelivery({ agentSessionId: 'original-agent', createOperationId: 'original-create',
    providerId: base.id, executorId: base.id, workspacePath: root, args, injectAgentMuxGuide: false })
  const replay = async (session: { run: { runId: string } }) => (await client.readRunReplay(session.run)).replay.map(chunk => chunk.data).join('')
  const write = async (session: { agentSessionId: string; run: { runId: string } }, text: string) => {
    await vi.waitFor(async () => expect(await replay(session)).toContain('PRIVATE_READY'))
    await client.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, source: 'user', data: text })
    await vi.waitFor(async () => expect(await replay(session)).toContain('INPUT:' + text))
  }
  let failBinding = false
  const boundRuns: string[] = []
  const createBinding = inner.hookServer.createBinding.bind(inner.hookServer)
  vi.spyOn(inner.hookServer, 'createBinding').mockImplementation((...values: unknown[]) => {
    const binding = createBinding(...values), bindRun = binding.bindRun.bind(binding)
    return { ...binding, bindRun: async (run: string) => {
      if (failBinding) throw new Error('Controlled Hook observation is unavailable')
      await bindRun(run); boundRuns.push(run)
    } }
  })
  const handshake = vi.spyOn(inner, 'ensureTerminalHandshakeOrDegrade')
  const fail = (phase: 'hook' | 'terminal') => {
    if (phase === 'hook') failBinding = true
    else handshake.mockRejectedValueOnce(new core.AgentMuxError('Controlled terminal observation is unavailable', 'CONTROL_UNAVAILABLE'))
  }
  return { root, store, client, inner, events, start, stop, input, create, args, write, fail, boundRuns,
    repair: () => { failBinding = false } }
}

it.each(['hook', 'terminal'] as const)('keeps_committed_create_usable_after_%s_observation_failure', async phase => {
  const f = await fixture(); f.fail(phase)
  const result = await f.create().then(value => ({ value }), error => ({ error }))
  expect(result).not.toHaveProperty('error')
  const created = (result as { value: Awaited<ReturnType<typeof f.create>> }).value
  expect(created.promptConfirmed).toBe(false)
  expect(created.creation.failure?.step).toBe(phase === 'hook' ? 'hook-bind' : 'handshake')
  expect(created.session.agentSessionId).toBe('original-agent')
  expect((await f.store.readMetadata('original-agent'))?.run).toEqual(created.session.run)
  expect(await f.store.loadRetiredAgentSessions()).toEqual([])
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
  await vi.waitFor(async () => expect((await f.store.readMetadata('original-agent'))?.nativeHandle?.sessionId).toBe('controlled-main'))
  await f.write(created.session, 'still-usable')
  expect(f.events).toContainEqual(expect.objectContaining({ type: 'agent-error', code: 'AGENT_CREATION_UNCONFIRMED',
    evidence: expect.objectContaining({ run: created.session.run }) }))
  if (phase === 'hook') {
    expect(f.client.agentSession('original-agent').hookIngressObservation?.phase).toBe('binding')
    const inputs = f.input.mock.calls.length
    f.repair(); await f.client.refreshAgentSession('original-agent', created.session.run)
    expect(f.client.agentSession('original-agent').hookIngressObservation).toBeUndefined()
    expect(f.boundRuns).toContain(created.session.run.runId)
    expect(f.input).toHaveBeenCalledTimes(inputs)
  }
})

it.each(['hook', 'terminal'] as const)('keeps_committed_resume_usable_after_%s_observation_failure', async phase => {
  const f = await fixture(), created = (await f.create()).session
  await vi.waitFor(async () => expect((await f.store.readMetadata('original-agent'))?.nativeHandle?.sessionId).toBe('controlled-main'))
  await f.write(created, 'original-input')
  await f.client.signalAgent('original-agent', created.run, 'SIGINT')
  await vi.waitFor(async () => expect((await f.client.statusAgent('original-agent')).run.state).toBe('exited'))
  f.start.mockClear(); f.stop.mockClear(); f.input.mockClear(); f.fail(phase)
  const result = await f.client.resumeAgent({ agentSessionId: 'original-agent', operationId: 'explicit-resume', prompt: 'continue',
    args: f.args, commandOverride: process.execPath }).then(value => ({ value }), error => ({ error }))
  expect(result).not.toHaveProperty('error')
  const resumed = (result as { value: AgentMuxStoredAgentSession }).value
  expect(resumed.agentSessionId).toBe(created.agentSessionId)
  expect(resumed.nativeHandle).toEqual({ kind: 'provider', providerId: 'process-observer', sessionId: 'controlled-main' })
  expect(resumed.run).not.toEqual(created.run)
  expect((await f.store.readMetadata('original-agent'))?.run).toEqual(resumed.run)
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
  expect(f.events).toContainEqual(expect.objectContaining({ type: 'agent-error', code: 'AGENT_REOPEN_OBSERVATION_UNCONFIRMED',
    evidence: expect.objectContaining({ run: resumed.run }) }))
  await f.write(resumed, 'resumed-input')
  if (phase === 'hook') {
    expect(f.client.agentSession('original-agent').hookIngressObservation?.phase).toBe('binding')
    const inputs = f.input.mock.calls.length
    f.repair(); await f.client.refreshAgentSession('original-agent', resumed.run)
    expect(f.client.agentSession('original-agent').hookIngressObservation).toBeUndefined()
    expect(f.boundRuns).toContain(resumed.run.runId)
    expect(f.input).toHaveBeenCalledTimes(inputs)
  }
  await expect(f.client.writeAgent({ agentSessionId: 'original-agent', expectedRun: created.run, source: 'user', data: 'stale-input' }))
    .rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
})
