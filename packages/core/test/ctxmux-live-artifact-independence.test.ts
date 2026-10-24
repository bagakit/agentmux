import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CtxmuxClient, createOperationKey, defineRun, PROTOCOL_VERSION } from '@ctxmux/sdk'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'

const boundary = vi.hoisted(() => ({ artifact: 'healthy', spawn: vi.fn() }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: boundary.spawn }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    if (String(args[0]).includes(join('vendor', 'ctxmux') + '/') && String(args[0]).endsWith('/manifest.json')) {
      if (boundary.artifact === 'missing') throw Object.assign(new Error('Selected artifact unavailable'), { code: 'ENOENT' })
      if (boundary.artifact === 'corrupt') return Buffer.from('{}')
    }
    return await Reflect.apply(actual.readFile, actual, args)
  } }
})
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  boundary.artifact = 'healthy'
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllEnvs(); boundary.spawn.mockReset()
})
async function namespace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-artifact-scope-')))
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }))
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key) && !key.startsWith('AGENTMUX_TEST_')) vi.stubEnv(key, undefined)
  const runtime = join(root, 'runtime'), state = join(root, 'state')
  await mkdir(runtime); await mkdir(state)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtime); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', state)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  boundary.spawn.mockImplementation(actual.spawn)
  return { root, runtime, state, actual }
}
async function serving() {
  const f = await namespace(), socket = join(f.runtime, 'ctxmux.sock')
  const daemon = f.actual.spawn(process.env.AGENTMUX_TEST_CTXMUXD ?? resolve(import.meta.dirname, '../vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
    ['--socket', socket, '--state-dir', join(f.state, 'ctxmux'), '--readiness-fd', '3'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let stderr = ''; daemon.stderr!.on('data', bytes => { stderr += String(bytes) })
  cleanup.push(async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) { const done = once(daemon, 'exit'); daemon.kill('SIGTERM'); await done }
  })
  await Promise.race([once(daemon.stdio[3]!, 'data'), once(daemon, 'exit').then(() => { throw new Error(stderr) })])
  const native = new CtxmuxClient({ socketPath: socket }), identity = await native.runtimeInfo()
  const run = await native.start(defineRun(process.execPath, { cwd: f.root,
    args: ['-e', "process.stdin.setRawMode(true);process.stdin.on('data',d=>process.stdout.write('INPUT:'+d));console.log('READY');setInterval(()=>{},1000)"] }), createOperationKey('original-native-creation'))
  cleanup.push(async () => { if ((await native.status(run.id)).state.type === 'running') await native.stop(await native.prepareStop(run.id)) })
  return { ...f, daemon, native, identity, run }
}
it.each(['missing', 'corrupt'])('keeps the real original Run usable when local activation artifacts are %s', async fault => {
  const f = await serving(); boundary.artifact = fault
  const client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
  Object.defineProperty((client as any).hookServer, 'port', { value: 0 }); cleanup.push(() => client.dispose())
  await expect(client.connect()).resolves.toBeUndefined()
  expect(client.runtimeIdentity()).toMatchObject({ instanceId: f.identity.daemonInstanceId, ownership: 'unverified' })
  expect(await client.listRuns()).toContainEqual(expect.objectContaining({ runId: f.run.id, pid: f.run.pid, state: 'running' }))
  const replay = async () => (await client.readRunReplay({ runId: f.run.id })).replay.map(chunk => chunk.data).join('')
  await vi.waitFor(async () => expect(await replay()).toContain('READY'))
  await client.writeTerminal({ runId: f.run.id }, { ownerInstanceId: f.identity.daemonInstanceId,
    operationId: 'original-input', expectedByte: 0, data: 'still-working' })
  await vi.waitFor(async () => expect(await replay()).toContain('INPUT:still-working'))
  expect((await f.native.status(f.run.id)).pid).toBe(f.run.pid)
  expect(f.daemon.exitCode).toBeNull(); expect(f.daemon.signalCode).toBeNull()
  expect(boundary.spawn).not.toHaveBeenCalled()
})
it.each(['missing', 'corrupt'])('refuses a new activation with %s artifacts before any child is created', async fault => {
  await namespace(); boundary.artifact = fault
  const adapter = new CtxmuxRunAdapter()
  await expect(adapter.connect()).rejects.toMatchObject({ code: 'CTXMUX_ARTIFACT_INVALID' })
  expect(adapter.isConnected()).toBe(false); expect(boundary.spawn).not.toHaveBeenCalled()
})
it('rejects an incompatible existing wire listener without replacing or closing it', async () => {
  const f = await namespace(); boundary.artifact = 'missing'
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket))
    socket.once('data', () => socket.write(JSON.stringify({ type: 'hello', runtime: {
      daemonInstanceId: '11111111-1111-4111-8111-111111111111', runtimeId: '22222222-2222-4222-8222-222222222222',
      runtimeIdPersistence: 'state_dir', buildId: 'ctxmuxd/incompatible', protocolGeneration: PROTOCOL_VERSION,
      platform: 'macos', arch: 'aarch64', capabilities: { 'native.start': 1, 'native.recoverable_input': 1,
        'native.recoverable_stop': 1, 'services.persistent_state': 1, 'services.planned_exec_upgrade_continuity': 1 }
    } }) + '\n'))
  })
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(done => server.close(() => done())) })
  await new Promise<void>(done => server.listen(join(f.runtime, 'ctxmux.sock'), done))
  const adapter = new CtxmuxRunAdapter()
  await expect(adapter.connect()).rejects.toMatchObject({ code: 'CTXMUX_OWNER_IDENTITY_UNPROVEN' })
  expect(adapter.isConnected()).toBe(false); expect(server.listening).toBe(true); expect(boundary.spawn).not.toHaveBeenCalled()
})
