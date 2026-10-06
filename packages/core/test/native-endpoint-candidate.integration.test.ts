import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, lstat, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createNetServer, type Socket } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error The existing ws runtime dependency ships no declaration here.
import { WebSocketServer } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { openNativeSocketChannel } from '../dist/agent-native-socket.js'
import { runProcess } from '../src/process-runner.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../dist/public-rpc-client.js'
import type { AgentProvider, AgentProviderRegistry } from '../src/agent-provider.js'

afterEach(() => vi.unstubAllEnvs())
const helper = fileURLToPath(new URL('../dist/native-socket-peer-darwin', import.meta.url))

// Two actual OS forms use one owner driver: raw UDS primitive and WS-over-UDS
// transport. Neither fixture claims vendor admission or a user Run.
async function ownedSockets(protocol: 'raw' | 'websocket', privateSocket = true, duplicate = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'am-endpoint-'))), identity = await lstat(root, { bigint: true })
  const endpoint = join(root, 'private.sock'), foreign = join(root, 'public.sock'), observer = join(root, 'observer.mjs')
  await writeFile(observer, 'console.log(JSON.stringify({observer:true,fd:Number(process.env.AGENTMUX_NATIVE_SOCKET_FD)}))\n')
  const rawConnections = new Set<Socket>()
  const publicServer = createNetServer(socket => { rawConnections.add(socket); socket.on('close', () => rawConnections.delete(socket)) })
  publicServer.listen(foreign); await once(publicServer, 'listening'); await chmod(foreign, 0o666)
  const server = protocol === 'websocket' ? createServer() : createNetServer(socket => {
    rawConnections.add(socket); socket.on('close', () => rawConnections.delete(socket))
  })
  const wss = protocol === 'websocket' ? new WebSocketServer({ server: server as ReturnType<typeof createServer> }) : undefined
  wss?.on('connection', (socket: { on(event: string, listener: (data: Buffer) => void): void; send(data: string): void }) => socket.on('message', data => {
    const request = JSON.parse(String(data)); socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { peerPid: process.pid, method: request.method } }))
  }))
  if (privateSocket) { server.listen(endpoint); await once(server, 'listening'); await chmod(endpoint, 0o600) }
  const wsPath = createRequire(import.meta.url).resolve('ws')
  const child = spawn(process.execPath, ['-e', `const net=require('net'),WS=require(${JSON.stringify(wsPath)});let opened=0;
const want=${privateSocket ? duplicate ? 3 : 2 : 1};const ready=()=>{if(++opened===want)console.log('ready')};
const foreign=net.connect(${JSON.stringify(foreign)},ready);foreign.on('error',()=>process.exit(2));
const openPrivate=()=>{const s=${protocol === 'websocket' ? `new WS('ws://localhost/',{createConnection:()=>net.connect(${JSON.stringify(endpoint)})})` : `net.connect(${JSON.stringify(endpoint)})`};s.on(${JSON.stringify(protocol === 'websocket' ? 'open' : 'connect')},ready);s.on('error',()=>process.exit(2));return s};
${privateSocket ? `openPrivate();${duplicate ? 'openPrivate();' : ''}` : ''}setInterval(()=>{},1000);`], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const childClosed = once(child, 'close')
  await once(child.stdout!, 'data')
  return { root, endpoint, foreign, observer, child, rawConnections,
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      const [, signal] = await childClosed
      expect(signal).toBe('SIGTERM')
      for (const socket of wss?.clients ?? []) socket.terminate()
      for (const socket of rawConnections) socket.destroy()
      const closings: Promise<void>[] = [new Promise((resolve, reject) => publicServer.close(error => error ? reject(error) : resolve()))]
      if (privateSocket) closings.push(new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
      await Promise.all(closings)
      const current = await lstat(root, { bigint: true }); expect([current.dev, current.ino]).toEqual([identity.dev, identity.ino])
      await rm(root, { recursive: true })
      console.log(JSON.stringify({ schema: 'agentmux.endpoint-fixture-exit.v1', originalPid: child.pid, signal, directory: { dev: String(identity.dev), ino: String(identity.ino) }, removed: true }))
    } }
}
const observedFailure = async (operation: Promise<unknown>) => {
  const result = await operation.then(value => ({ ok: true, value }), error => ({ ok: false, error }))
  expect(result.ok).toBe(false)
  if (!('error' in result)) throw new Error('Expected original machine refusal')
  expect(result.error.code).toBe('AGENT_NATIVE_INPUT_UNCONFIRMED')
  return JSON.parse(result.error.detail)
}
const observedChannel = async (operation: ReturnType<typeof openNativeSocketChannel>) => {
  const result = await operation.then(channel => ({ ok: true as const, channel }), error => ({ ok: false as const, error }))
  expect(result.ok, result.ok ? undefined : result.error.detail).toBe(true)
  if (!result.ok) throw result.error
  return result.channel
}
const verifyArguments = (binding: Awaited<ReturnType<typeof openNativeSocketChannel>>['binding']) => [
  '--verify', String(binding.runPid), String(binding.tuiPid), String(binding.peerPid), String(binding.tuiFd), String(binding.peerFd),
  binding.tuiSocket, binding.peerSocket, binding.runBirth, binding.tuiBirth, binding.peerBirth, binding.endpoint, `${binding.device}:${binding.inode}`
]

it.runIf(process.platform === 'darwin').each(['raw', 'websocket'] as const)('foreign public UDS cannot enter implicit %s candidate count', async protocol => {
  const f = await ownedSockets(protocol)
  let channel: Awaited<ReturnType<typeof openNativeSocketChannel>> | undefined
  try {
    expect((await lstat(f.foreign)).mode & 0o777).toBe(0o666)
    if (protocol === 'raw') {
      const result = await runProcess(helper, [String(f.child.pid), '', process.execPath, f.observer])
      expect(result.exitCode, result.stderr).toBe(0)
      const binding = JSON.parse(result.stdout.split('\n')[0]!)
      expect(binding).toMatchObject({ endpoint: f.endpoint, tuiPid: f.child.pid, peerPid: process.pid })
      expect((await runProcess(helper, verifyArguments(binding))).exitCode).toBe(0)
    } else {
      channel = await observedChannel(openNativeSocketChannel(f.child.pid!, '', AbortSignal.timeout(4000)))
      expect(channel.binding).toMatchObject({ endpoint: f.endpoint, tuiPid: f.child.pid, peerPid: process.pid })
      await channel.assertCurrent(AbortSignal.timeout(4000))
      expect((await channel.request('original-read', {})).result).toEqual({ peerPid: process.pid, method: 'original-read' })
    }
  } finally { await channel?.close(); await f.close() }
})

it.runIf(process.platform === 'darwin').each(['raw', 'websocket'] as const)('two eligible private %s objects remain ambiguous', async protocol => {
  const f = await ownedSockets(protocol, true, true)
  try {
    const result = await runProcess(helper, [String(f.child.pid), '', process.execPath, f.observer])
    expect(result.exitCode).toBe(1); expect(JSON.parse(result.stderr)).toMatchObject({ phase: 'ambiguous-original-connection', errno: null })
  } finally { await f.close() }
})

it.runIf(process.platform === 'darwin')('foreign-only observation is unknown, not a Native binding or permission grant', async () => {
  const f = await ownedSockets('raw', false)
  try {
    const result = await runProcess(helper, [String(f.child.pid), '', process.execPath, f.observer])
    expect(result.exitCode).toBe(1); expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toEqual({ code: 'NATIVE_SOCKET_PEER_UNCONFIRMED', phase: 'original-connection-absent', errno: null })
    expect(f.child.exitCode).toBeNull()
  } finally { await f.close() }
})

it.runIf(process.platform === 'darwin')('explicit and verify retain exact endpoint machine predicates and syscall errno', async () => {
  const f = await ownedSockets('websocket'); let channel: Awaited<ReturnType<typeof openNativeSocketChannel>> | undefined
  try {
    const publicFailure = await observedFailure(openNativeSocketChannel(f.child.pid!, f.foreign, AbortSignal.timeout(4000)))
    expect(publicFailure.observation).toMatchObject({ phase: 'endpoint-owner', reason: 'permissions-mismatch', errno: null, expectedUid: process.getuid!(), stat: { uid: process.getuid!(), mode: 0o666 } })
    const missing = await observedFailure(openNativeSocketChannel(f.child.pid!, join(f.root, 'missing'), AbortSignal.timeout(4000)))
    expect(missing.observation).toMatchObject({ phase: 'endpoint-owner', reason: 'stat-failed', errno: 2 })
    expect(missing.observation).not.toHaveProperty('stat')
    const file = join(f.root, 'file'); await writeFile(file, 'original fixture')
    const nonSocket = await observedFailure(openNativeSocketChannel(f.child.pid!, file, AbortSignal.timeout(4000)))
    expect(nonSocket.observation).toMatchObject({ reason: 'not-socket', errno: null })
    channel = await observedChannel(openNativeSocketChannel(f.child.pid!, f.endpoint, AbortSignal.timeout(4000)))
    await chmod(f.endpoint, 0o666)
    const verify = await observedFailure(channel.assertCurrent(AbortSignal.timeout(4000)))
    expect(verify.observation).toMatchObject({ phase: 'endpoint-changed', reason: 'permissions-mismatch', errno: null, stat: { mode: 0o666 } })
    await chmod(f.endpoint, 0o600); await channel.assertCurrent(AbortSignal.timeout(4000))
    await rename(f.endpoint, join(f.root, 'old.sock'))
    const verifyMissing = await observedFailure(channel.assertCurrent(AbortSignal.timeout(4000)))
    expect(verifyMissing.observation).toMatchObject({ phase: 'endpoint-changed', reason: 'stat-failed', errno: 2 })
    expect(verifyMissing.observation).not.toHaveProperty('stat')
    await writeFile(f.endpoint, 'replacement')
    const replaced = await observedFailure(channel.assertCurrent(AbortSignal.timeout(4000)))
    expect(replaced.observation).toMatchObject({ phase: 'endpoint-changed', reason: 'not-socket', errno: null })
  } finally { await channel?.close(); await f.close() }
})

it.runIf(process.platform === 'darwin').each(['root-uid', 'EIO', 'EACCES'] as const)('controlled %s lstat facts do not impersonate a root peer or silently grant uniqueness', async fault => {
  const f = await ownedSockets('raw'), controlledHelper = join(f.root, 'controlled-helper')
  try {
    const compiled = await runProcess('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-include',
      fileURLToPath(new URL('./fixtures/native-endpoint-observation.h', import.meta.url)), fileURLToPath(new URL('../native/native-socket-peer.c', import.meta.url)), '-o', controlledHelper])
    expect(compiled.exitCode, compiled.stderr).toBe(0)
    const env = { AMX_ENDPOINT_FIXTURE_PATH: f.foreign, AMX_ENDPOINT_FIXTURE_FAULT: fault }
    const implicit = await runProcess(controlledHelper, [String(f.child.pid), '', process.execPath, f.observer], { env })
    const explicit = await runProcess(controlledHelper, [String(f.child.pid), f.foreign, process.execPath, f.observer], { env })
    const original = await runProcess(helper, [String(f.child.pid), f.endpoint, process.execPath, f.observer])
    expect(original.exitCode, original.stderr).toBe(0)
    const binding = JSON.parse(original.stdout.split('\n')[0]!)
    const verify = await runProcess(controlledHelper, verifyArguments(binding), { env: { ...env, AMX_ENDPOINT_FIXTURE_PATH: f.endpoint } })
    expect(explicit.exitCode).toBe(1)
    expect(verify.exitCode).toBe(1)
    if (fault === 'root-uid') {
      expect(implicit.exitCode, implicit.stderr).toBe(0); expect(JSON.parse(implicit.stdout.split('\n')[0]!).endpoint).toBe(f.endpoint)
      expect(JSON.parse(explicit.stderr)).toMatchObject({ phase: 'endpoint-owner', reason: 'uid-mismatch', errno: null, stat: { uid: 0, mode: 0o600 } })
      expect(JSON.parse(verify.stderr)).toMatchObject({ phase: 'endpoint-changed', reason: 'uid-mismatch', errno: null, stat: { uid: 0, mode: 0o600 } })
    } else {
      expect(implicit.exitCode).toBe(1); expect(implicit.stdout).toBe('')
      const expected = fault === 'EIO' ? 5 : 13
      expect(JSON.parse(implicit.stderr)).toMatchObject({ phase: 'endpoint-observation', reason: 'stat-failed', errno: expected })
      expect(JSON.parse(explicit.stderr)).toMatchObject({ phase: 'endpoint-owner', reason: 'stat-failed', errno: expected })
      expect(JSON.parse(verify.stderr)).toMatchObject({ phase: 'endpoint-changed', reason: 'stat-failed', errno: expected })
    }
  } finally { await f.close() }
})

it.runIf(process.platform === 'darwin').each(['implicit', 'explicit'] as const)('actual public RPC and compiled CLI retain original %s C diagnostic without dispatch', async mode => {
  const f = await ownedSockets('raw', false), h = await rpcOwnerFixture()
  const provider = (Reflect.get(h.client, 'providers') as AgentProviderRegistry).get('codex')
  const original = (await h.store.readMetadata('recipient'))!
  await h.store.compareAndSwapMetadata(original, { ...original, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'fixture-native', transcriptPath: join(f.root, 'unread') } })
  h.inner.kernel.status = vi.fn(async (id: string) => ({ ...h.run(id), pid: f.child.pid!, args: mode === 'explicit' ? ['--remote', 'unix://' + f.foreign] : [] }))
  h.inner.kernel.input = vi.fn(); h.inner.kernel.identity = () => ({ daemonInstanceId: 'fixture-runtime' })
  const prepare = vi.spyOn(provider as Required<Pick<AgentProvider, 'prepareNativePromptInput'>>, 'prepareNativePromptInput')
  const server = new AgentMuxControlServer({ socketPath: join(h.root, 'rpc.sock'), coreClients: h.coreClients }); await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const observed = (detail: string) => {
    const core = JSON.parse(detail), provider = JSON.parse(core.cause.detail), transport = JSON.parse(provider.observation.detail)
    return transport.observation
  }
  try {
    const input = { target: { kind: 'agent-session' as const, agentSessionId: 'recipient' }, text: 'Original body {"ready":true}', sourceChannel: 'cli' as const,
      execution: 'immediate' as const, operationId: 'endpoint-original-control', messageId: 'endpoint-original-message' }
    const result = await rpc.call('agent.send', input).then(value => ({ ok: true, value }), error => ({ ok: false, error }))
    expect(result.ok).toBe(false); if (!('error' in result)) throw new Error('Expected exact RPC error')
    console.log(JSON.stringify({ schema: 'agentmux.endpoint-public-refusal.v1', code: result.error.code, detail: result.error.detail, message: result.error.message }))
    expect(result.error.code).toBe('AGENT_NATIVE_INPUT_WAITING')
    if (mode === 'implicit') expect(observed(result.error.detail)).toEqual({ code: 'NATIVE_SOCKET_PEER_UNCONFIRMED', phase: 'original-connection-absent', errno: null })
    else expect(observed(result.error.detail)).toEqual({ code: 'NATIVE_SOCKET_PEER_UNCONFIRMED', phase: 'endpoint-owner', reason: 'permissions-mismatch', errno: null,
      expectedUid: process.getuid!(), stat: { type: 0o140000, uid: process.getuid!(), mode: 0o666 } })
    const cli = await runCompiledObjectCli(['--endpoint', 'unix://' + server.path, 'agent', 'send', '--to-session', 'recipient', '--text', input.text,
      '--execution', 'immediate', '--operation-id', input.operationId, '--message-id', input.messageId], objectCliEnvironment(h.root, {}))
    expect(cli.code).toBe(1)
    expect(observed(JSON.parse(cli.stderr).error.detail)).toEqual(observed(result.error.detail))
    expect(prepare).toHaveBeenCalledTimes(2); expect(h.inner.kernel.input).not.toHaveBeenCalled()
    expect(h.client.agentSession('recipient').promptCompletionAdmission).toBeUndefined(); expect(f.child.exitCode).toBeNull()
    expect(h.inner.kernel.stop).not.toHaveBeenCalled(); expect(h.inner.kernel.attach).not.toHaveBeenCalled()
  } finally { prepare.mockRestore(); await rpc.dispose(); await server.stop(); await h.close(); await f.close() }
})
