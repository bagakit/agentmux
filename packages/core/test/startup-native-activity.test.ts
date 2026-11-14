import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, defineAgentProvider } from '../src/index.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Private startup activity cleanup failed')
})
const until = async <T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> => {
  const deadline = Date.now() + 10_000
  for (;;) {
    const value = await read()
    if (accept(value)) return value
    if (Date.now() > deadline) throw new Error('Private native activity did not settle')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
async function fixture(state: 'working' | 'done', expired = false) {
  const root = await mkdtemp(join(tmpdir(), 'amux-native-activity-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key) && !key.startsWith('AGENTMUX_TEST_')) vi.stubEnv(key, undefined)
  const runtime = join(root, 'r'), durable = join(root, 's'), storePath = join(durable, 'sessions.sqlite')
  await mkdir(runtime); await mkdir(durable)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtime); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', durable)
  vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', storePath); vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(durable, 'messages.ndjson'))
  let daemon: ChildProcess | undefined
  const stopDaemon = async () => {
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
      const ended = once(daemon, 'exit'); daemon.kill('SIGTERM'); await ended
    }
  }
  cleanup.push(stopDaemon)
  const startDaemon = async () => {
    daemon = spawn(resolve(import.meta.dirname, '../vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
      ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(durable, 'ctxmux'), '--readiness-fd', '3'],
      { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
    let error = ''; daemon.stderr!.on('data', data => { error += data })
    await Promise.race([once(daemon.stdio[3]!, 'data'), once(daemon, 'exit').then(() => { throw new Error(error) })])
  }
  await startDaemon()
  let originalActivityAt = 0
  const launches = join(root, 'launches.ndjson')
  const program = `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(launches)},JSON.stringify(process.argv.slice(1))+'\\n');process.stdin.setRawMode(true);process.stdin.on('data',d=>process.stdout.write('LIVE:'+d));setInterval(()=>{},1000)`
  const provider = defineAgentProvider({ catalog: { id: 'native-activity', label: 'Private native activity protocol', executable: process.execPath,
    expectedProcess: 'node', promptDelivery: 'positional-argv', readySignal: { kind: 'foreground-process', expectedProcess: 'node' },
    hookStrategy: { kind: 'none' }, resumeStrategy: { kind: 'provider-native', locator: 'session-id' }, acpStrategy: { kind: 'none' },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'none', providerResume: true, replyCorrelation: 'none', nativeInterruption: true } },
    buildArgs: (prompt) => ['-e', program, 'original-native', ...(prompt ? [prompt] : [])],
    buildResumeArgs: (id, _path, prompt) => ['-e', program, id, ...(prompt ? [prompt] : [])],
    discoverNativeSession: async () => ({ handle: { kind: 'provider', providerId: 'native-activity', sessionId: 'original-native' }, assertCurrent: async () => {} }),
    observeSessionStatus: async ({ onStatus }) => {
      originalActivityAt ||= Date.now()
      onStatus({ recordId: 'original-native-record', nativeTurnId: 'original-native-turn', state,
        nativeObservedAt: originalActivityAt, ...(state === 'done' ? { endReason: 'completed' as const } : {}) })
      return { dispose() {} }
    },
    // A recent working fact permits restoring context; it cannot declare an interrupted turn.
    readPromptExecutionEvidence: async () => ({ sourceId: 'original-native-source', id: 'original-native-record',
      nativeTurnId: 'original-native-turn', state: 'working', observedAt: originalActivityAt }),
    hook: { rules: [] } })
  const clients: AgentMuxClient[] = []
  cleanup.push(async () => {
    const errors: unknown[] = []
    const reader = clients.at(-1)
    if (reader) {
      try {
        const current = await reader.statusAgent('original-session')
        if (current.run.state === 'running') await reader.stopAgent('original-session', current.session.run)
      } catch (error) { errors.push(error) }
    }
    for (const client of clients.slice().reverse()) try { await client.dispose() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, 'Private native activity clients failed to close')
  })
  const reader = async () => {
    const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(storePath), providers: [provider] })
    clients.push(client)
    Object.defineProperty((client as any).hookServer, 'port', { value: 0 })
    await client.connect(); return client
  }
  const client = await reader()
  const original = await client.createAgent({ agentSessionId: 'original-session', providerId: provider.id, executorId: provider.id,
    createOperationId: 'original-create', workspacePath: root, prompt: 'ORIGINAL_PROMPT_DO_NOT_REPLAY', injectAgentMuxGuide: false })
  await client.statusAgent(original.agentSessionId)
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const retained = await until(() => store.readMetadata(original.agentSessionId), value => value?.semanticStatus?.state === state)
  expect(retained?.semanticStatus).toMatchObject({ state, source: 'native-transcript', nativeTurnId: 'original-native-turn' })
  // Real owner and Native process restart; reuse the original durable Session and native identity.
  await client.dispose(); await stopDaemon(); await startDaemon()
  const restarted = await reader()
  const before = await restarted.statusAgent(original.agentSessionId)
  expect(before.run).toMatchObject({ runId: original.run.runId, state: 'interrupted', interruptionReason: 'daemon_restart' })
  expect(before.session.semanticStatus?.state).toBe('running')
  expect((await store.readMetadata(original.agentSessionId))?.semanticStatus?.state).toBe(state)
  const result = await restarted.ensureAgentContinuity({ agentSessionId: original.agentSessionId, expectedRun: original.run,
    operationId: 'original-startup', trigger: 'startup', policy: { retryMaxAttempts: 0, ...(expired ? { confirmedIdleWindowMs: 0 } : {}) } })
  return { root, store, original, restarted, result, launches }
}

it.each(['working', 'done'] as const)('restores the original %s native context after a real Runtime restart while its live observation is absent', async state => {
  const f = await fixture(state)
  expect(f.result.kind, JSON.stringify(f.result)).toBe('resumed')
  const current = await f.restarted.statusAgent(f.original.agentSessionId)
  expect(current.session.agentSessionId).toBe(f.original.agentSessionId)
  expect(current.session.nativeHandle).toEqual(f.original.nativeHandle)
  expect(current.run.runId).not.toBe(f.original.run.runId)
  expect(current.run.state).toBe('running')
  const operation = (await f.store.readMetadata(f.original.agentSessionId))!.continuityOperations!['original-startup']!
  expect(operation.recoveryInputs).toEqual({ reminder: '', continuation: '' })
  const rows = await until(async () => (await readFile(f.launches, 'utf8')).trim().split('\n').map(line => JSON.parse(line)), rows => rows.length === 2)
  expect(rows).toEqual([['original-native', 'ORIGINAL_PROMPT_DO_NOT_REPLAY'], ['original-native']])
  await f.restarted.writeAgent({ agentSessionId: f.original.agentSessionId, expectedRun: current.session.run, source: 'user', data: 'original-live-input' })
  const replay = await until(() => f.restarted.readRunReplay(current.session.run), value => value.replay.some(chunk => chunk.data.includes('LIVE:original-live-input')))
  expect(replay.replay.map(chunk => chunk.data).join('')).toContain('LIVE:original-live-input')
})
it('keeps an expired native activity on demand after the same real restart', async () => {
  const f = await fixture('working', true)
  expect(f.result).toMatchObject({ kind: 'pending', reason: 'idle-window-expired' })
  expect((await f.store.readMetadata(f.original.agentSessionId))!.run).toEqual(f.original.run)
  expect((await readFile(f.launches, 'utf8')).trim().split('\n').map(line => JSON.parse(line))).toEqual([['original-native', 'ORIGINAL_PROMPT_DO_NOT_REPLAY']])
})
