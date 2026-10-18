import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { defineAgentProvider } from '../src/agent-provider.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'

const cliLoaded = process.env.AGENTMUX_RESUMED_INBOX_CLI_LOADED
const cliLoader = new URL('./fixtures/a2a-resumed-inbox/source-loader.mjs', import.meta.url)
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, fork: ((path: string | URL, args: readonly string[], options: import('node:child_process').ForkOptions) =>
    actual.fork(String(path).endsWith('/control-endpoint-listener-worker.js')
      ? fileURLToPath(new URL('../src/control-endpoint-listener-worker.ts', import.meta.url)) : path, args, options)) as typeof actual.fork }
})
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { failures.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (failures.length) throw new AggregateError(failures, 'Private Runtime cleanup failed')
})

it('source CLI delivers the historical MID reference through a real private resumed Runtime and reopens the original notice without another input', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arn-'))), runtime = join(root, 'r'), state = join(root, 's')
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key) && !key.startsWith('AGENTMUX_TEST_')) vi.stubEnv(key, undefined)
  await mkdir(runtime); await mkdir(state)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtime); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', state)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const daemon = spawn(resolve(import.meta.dirname, '../vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
    ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let daemonError = ''; daemon.stderr!.on('data', bytes => { daemonError += String(bytes) })
  cleanup.push(async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) { const exited = once(daemon, 'exit'); daemon.kill('SIGTERM'); await exited }
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
  })
  await Promise.race([once(daemon.stdio[3]!, 'data'), once(daemon, 'exit').then(() => { throw new Error(daemonError) })])
  const provider = defineAgentProvider({ catalog: { id: 'private-inbox-process', label: 'Private Inbox process', executable: process.execPath,
    expectedProcess: 'node', promptDelivery: 'positional-argv', readySignal: { kind: 'foreground-process', expectedProcess: 'node' },
    hookStrategy: { kind: 'none' }, resumeStrategy: { kind: 'provider-native', locator: 'session-id' }, acpStrategy: { kind: 'none' },
    capabilities: { terminal: true, timeline: 'unavailable', permission: 'none', providerResume: true, replyCorrelation: 'none' } },
    buildArgs: (_prompt, args) => [...args], buildResumeArgs: (id, _path, prompt, args) => [...args, id, ...(prompt ? [prompt] : [])], hook: { rules: [] } })
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.sqlite')), client = new AgentMuxClient({ store, providers: [provider] }), inner = client as any
  Object.defineProperty(inner.hookServer, 'port', { value: 0 }); await client.connect()
  cleanup.push(async () => {
    if (inner.kernel.isConnected()) for (const run of await inner.kernel.list()) if (run.state.type === 'running') await inner.kernel.stop(await inner.kernel.prepareStop(run.runId))
    await client.dispose(); await inner.registry.enqueue('original-session', async () => {})
  })
  const ended = await inner.kernel.start({ operationKey: 'original-seed', program: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root, env: {} })
  await vi.waitFor(async () => expect((await inner.kernel.status(ended.runId)).state.type).toBe('exited'))
  const previous = { kind: 'agent' as const, agentSessionId: 'original-session', providerId: provider.id, executorId: 'private-configured', hostId: 'local',
    workspacePath: root, run: { runId: ended.runId }, retiredRuns: [], createdAt: 1, updatedAt: 1,
    hookBindingId: 'original-binding', hookToken: 'original-token', nativeHandle: { kind: 'provider' as const, providerId: provider.id, sessionId: 'original-native' } }
  await store.compareAndSwap(null, previous); await inner.registry.load('local')
  const queue = new DurableAgentMuxMessageQueue(join(root, 'messages.ndjson'))
  const original = await queue.append({ messageId: 'real-historical-mid', operationId: 'real-original-send', createdAt: 1,
    sender: { kind: 'agent-session', agentSessionId: 'original-peer' }, recipient: { kind: 'agent-session', agentSessionId: previous.agentSessionId },
    senderSessionId: 'original-peer', senderRunId: 'original-peer-run', recipientSessionId: previous.agentSessionId, recipientRunId: previous.run.runId,
    threadId: 'real-original-thread', correlationId: 'real-correlation', replyTo: null, workspaceId: null, body: 'OPAQUE_BODY_NEVER_IN_REFERENCE_INPUT' }, { deliveryMode: 'reference' })
  const program = "process.stdin.setRawMode(true);process.stdin.on('data',d=>process.stdout.write('INPUT:'+d.toString()));console.log('LAUNCH:'+JSON.stringify(process.argv.slice(1)));setInterval(()=>{},1000)"
  const resumed = await client.resumeAgent({ agentSessionId: previous.agentSessionId, operationId: 'real-native-resume', prompt: 'Original private task', args: ['-e', program] })
  expect(resumed.run).not.toEqual(previous.run); expect(resumed.nativeHandle).toEqual(previous.nativeHandle)
  expect(resumed.continuity).toMatchObject({ kind: 'resumed', previousRun: previous.run, newRun: resumed.run, nativeTarget: previous.nativeHandle })
  const replay = async () => (await client.readRunReplay(resumed.run)).replay.map(chunk => chunk.data).join('')
  await vi.waitFor(async () => expect(await replay()).toContain('LAUNCH:'))
  const input = vi.spyOn(inner.kernel, 'input'), server = new AgentMuxControlServer({ socketPath: join(root, 'rpc.sock'), coreClients: () => [{ hostId: 'local', client }] })
  await server.start(); cleanup.push(() => server.stop())
  const cli = async (args: string[]) => {
    const result = await runSourceObjectCli(['--endpoint', 'unix://' + server.path, ...args], objectCliEnvironment(root,
      cliLoaded ? { AGENTMUX_RESUMED_INBOX_CLI_LOADED: cliLoaded } : {}), '', 20_000, cliLoader)
    expect(result.code, result.stderr + result.stdout).toBe(0); return JSON.parse(result.stdout).result
  }
  const result = await cli(['message', 'notify', '--host', 'local', '--message-id', 'real-historical-mid', '--operation-id', 'real-notice'])
  expect(result.notification).toMatchObject({ state: 'submitted', key: { expectedRun: resumed.run } })
  await vi.waitFor(async () => expect(await replay()).toContain('msg-id="real-historical-mid"'))
  expect(await replay()).not.toContain(original.envelope.body); expect((await queue.readByMessageId('real-historical-mid'))?.envelope).toEqual(original.envelope)
  const before = await queue.readJournal(), count = input.mock.calls.length
  const reopened = await cli(['message', 'notify', 'inspect', '--host', 'local', '--operation-id', 'real-notice'])
  expect(reopened.notification).toEqual(result.notification); expect(reopened.input).toBeTruthy()
  expect(await queue.readJournal()).toEqual(before); expect(input).toHaveBeenCalledTimes(count)
})
