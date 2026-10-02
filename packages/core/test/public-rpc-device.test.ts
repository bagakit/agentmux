import { fixturePath as upstreamFixturePath, fixtureDisplayPath as upstreamFixtureDisplayPath } from './helpers/fixture-values.js'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxRpcService, type AgentMuxRpcCallContext } from '../src/public-rpc-service.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { forwardAgentMuxRpcStdio } from '../src/agentmux-rpc-stdio.js'
import { AgentMuxRpcLines, rpcEncode } from '../src/public-rpc-frame.js'
import { AgentMuxError } from '../src/errors.js'
import { AGENTMUX_RPC_DEVICE_METHODS, type AgentMuxRpcDeviceAdministration,
  type AgentMuxRpcDeviceMethod, type AgentMuxRpcDeviceParams, type AgentMuxRpcDeviceResult } from '../src/public-rpc-device.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })
const device = { deviceId: 'device-original', name: 'Original device', createdAt: 7 }
const pending = { device: { ...device, deviceId: 'pending-original' }, confirmationCode: '012345', expiresAt: 800 }
const local: AgentMuxRpcCallContext = { transport: 'unix', principal: { kind: 'user', id: 'original-local-user' } }
const inputs = {
  'device.ls': {}, 'device.invite': {}, 'device.approve': { deviceId: 'device-original', confirmationCode: '012345' },
  'device.reject': { deviceId: 'pending-original' }, 'device.revoke': { deviceId: 'device-original' }
} satisfies { [M in AgentMuxRpcDeviceMethod]: AgentMuxRpcDeviceParams<M> }
function result<M extends AgentMuxRpcDeviceMethod>(method: M, params: AgentMuxRpcDeviceParams<M>): AgentMuxRpcDeviceResult<M> {
  const body = method === 'device.ls' ? { hostId: 'original-host', devices: [device], requests: [pending], privateAccess: { state: 'unavailable', message: 'Private access is not observed by this controlled fixture.' } }
    : method === 'device.invite' ? { hostId: 'original-host', invitation: 'private-fixture-invitation', expiresAt: 900 }
    : method === 'device.reject' ? { hostId: 'original-host', deviceId: (params as typeof inputs['device.reject']).deviceId, state: 'denied' }
    : { hostId: 'original-host', device: { ...device, ...(method === 'device.revoke' ? { revokedAt: 20 } : {}) } }
  return body as AgentMuxRpcDeviceResult<M>
}
async function root() {
  const path = await mkdtemp(upstreamFixtureDisplayPath("tmp/amx-device-")); cleanups.push(() => rm(path, { recursive: true, force: true })); return path
}
function fixtureOwner() {
  const calls: Array<{ method: AgentMuxRpcDeviceMethod; params: unknown; context: AgentMuxRpcCallContext }> = []
  const owner: AgentMuxRpcDeviceAdministration = { async call(method, params, context) {
    calls.push({ method, params, context }); return result(method, params)
  } }
  return { owner, calls }
}
async function server(owner?: AgentMuxRpcDeviceAdministration) {
  const path = join(await root(), 'control.sock')
  const service = new AgentMuxControlServer({ socketPath: path, coreClients: () => [],
    ...(owner ? { deviceAdministration: owner } : {}), http: { host: '127.0.0.1', port: 0, token: 'private-device' } })
  await service.start(); cleanups.push(() => service.stop())
  return { path, service, url: `http://127.0.0.1:${service.httpAddress!.port}/` }
}
async function rawRequest(path: string, request: unknown): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ path }), lines = new AgentMuxRpcLines()
    socket.once('error', reject)
    socket.once('connect', () => socket.write(rpcEncode(request)))
    socket.on('data', chunk => { try { lines.accept(chunk, value => { socket.destroy(); resolve(value) }) } catch (error) { socket.destroy(); reject(error) } })
  })
}
function output() {
  const chunks: Buffer[] = [], frames: unknown[] = [], lines = new AgentMuxRpcLines()
  const stream = new Writable({ write(chunk: Buffer, _encoding, callback) {
    chunks.push(Buffer.from(chunk)); try { lines.accept(chunk, value => frames.push(value)); callback() } catch (error) { callback(error as Error) }
  } })
  return { stream, chunks, frames }
}
async function rawServer() {
  const path = join(await root(), 'relay.sock'), sockets: Socket[] = [], chunks: Buffer[] = [], frames: unknown[] = []
  const host = createServer(socket => { sockets.push(socket); const lines = new AgentMuxRpcLines()
    socket.on('error', () => {}); socket.on('data', chunk => { chunks.push(Buffer.from(chunk)); lines.accept(chunk, frame => frames.push(frame)) })
  })
  await new Promise<void>(resolve => host.listen(path, resolve))
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => host.close(() => resolve())) })
  return { path, sockets, chunks, frames }
}

/** Real public transports and the finite borrowed Host tuple. These controlled
 * callbacks do not claim actual OS confirmation, Authority mutation or Phone approval. */
describe('source: public device administration', () => {
  it('routes all five methods once through actual Unix provenance and retains their original public fields', async () => {
    const h = fixtureOwner(), endpoint = await server(h.owner), client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: endpoint.path } })
    cleanups.push(() => client.dispose())
    const methods = Object.keys(AGENTMUX_RPC_DEVICE_METHODS) as AgentMuxRpcDeviceMethod[]
    expect(methods).toEqual(['device.ls', 'device.invite', 'device.approve', 'device.reject', 'device.revoke'])
    const observed = []
    for (const method of methods) observed.push(await client.call(method, inputs[method]))
    expect(observed).toEqual(methods.map(method => result(method, inputs[method])))
    expect(h.calls.map(call => [call.method, call.params])).toEqual(methods.map(method => [method, inputs[method]]))
    for (const call of h.calls) {
      expect(call.context.transport).toBe('unix'); expect(call.context.principal).toMatchObject({ kind: 'user', id: expect.any(String) })
      expect(call.context.signal).toBeInstanceOf(AbortSignal); expect(call.context.caller).toBeUndefined()
    }
  })
  it('rejects missing provenance, HTTP, devices and every managed caller before borrowing or reading Core', async () => {
    const h = fixtureOwner(), coreClients = vi.fn(() => []), service = new AgentMuxRpcService({ coreClients, deviceAdministration: h.owner })
    cleanups.push(() => service.dispose())
    const forbidden: AgentMuxRpcCallContext[] = [{}, { principal: local.principal! }, { transport: 'unix' },
      { ...local, transport: 'http' }, { ...local, principal: { kind: 'device', id: 'approved-device' } },
      { ...local, caller: { agentSessionId: 'agent-original', capability: 'managed-fixture' } },
      { ...local, principal: { kind: 'user', id: '' } }]
    expect(forbidden).toHaveLength(7)
    for (const context of forbidden) await expect(service.call('device.invite', {}, context)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    expect(h.calls).toEqual([]); expect(coreClients).not.toHaveBeenCalled()
  })
  it('passes actual HTTP and managed-wire requests through the same dispatcher without a management callback', async () => {
    const h = fixtureOwner(), endpoint = await server(h.owner)
    const attempts = [
      { method: 'device.ls', params: {} },
      { method: 'device.approve', params: { ...inputs['device.approve'], transport: 'unix', principal: local.principal, confirmed: true } },
      { method: 'device.invite', params: { caller: { agentSessionId: 'original-agent', capability: 'private-fixture' } } }
    ]
    expect(attempts).toHaveLength(3)
    for (const [id, request] of attempts.entries()) {
      const response = await fetch(endpoint.url, { method: 'POST', headers: { Authorization: 'Bearer private-device', 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, ...request }) })
      expect(await response.json()).toMatchObject({ id, error: { data: { code: 'CONTROL_PERMISSION_DENIED' } } })
    }
    expect(await rawRequest(endpoint.path, { jsonrpc: '2.0', id: 'managed', method: 'device.ls', params: attempts[2]!.params }))
      .toMatchObject({ id: 'managed', error: { data: { code: 'CONTROL_PERMISSION_DENIED' } } })
    expect(h.calls).toEqual([])
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'http', url: endpoint.url, token: 'private-device' } }); cleanups.push(() => client.dispose())
    expect((await client.call('system.endpoint', {})).endpoint).toEqual({ transport: 'unix', path: endpoint.path })
  })
  it('does not admit JSON confirmation, identity or extra parameters even from a real Unix user', async () => {
    const h = fixtureOwner(), endpoint = await server(h.owner)
    const invalid = [{ method: 'device.invite', params: { confirmed: true } },
      { method: 'device.ls', params: { transport: 'unix', principal: local.principal } },
      { method: 'device.approve', params: { deviceId: device.deviceId } },
      { method: 'device.approve', params: { deviceId: device.deviceId, confirmationCode: 'bad' } },
      { method: 'device.approve', params: { ...inputs['device.approve'], operationId: 'not-an-administration-parameter' } },
      { method: 'device.revoke', params: { deviceId: [] } }]
    expect(invalid).toHaveLength(6)
    for (const [id, request] of invalid.entries()) expect(await rawRequest(endpoint.path, { jsonrpc: '2.0', id, ...request }))
      .toMatchObject({ id, error: { data: { code: 'INVALID_CONTROL_REQUEST' } } })
    expect(h.calls).toEqual([])
  })
  it('reports a missing original owner and leaves ordinary Core discovery available', async () => {
    const endpoint = await server(), client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: endpoint.path } }); cleanups.push(() => client.dispose())
    await expect(client.call('device.invite', {})).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    expect((await client.call('system.endpoint', {})).protocol).toBe('jsonrpc-2.0')
  })
  it('carries cancellation to the borrowed original owner without retry or a confirmation claim', async () => {
    let arrived!: () => void, cancelled!: () => void
    const ready = new Promise<void>(resolve => { arrived = resolve }), ended = new Promise<void>(resolve => { cancelled = resolve })
    const call = vi.fn(async (_method: unknown, _params: unknown, context: AgentMuxRpcCallContext) => {
      arrived(); await new Promise<void>(resolve => context.signal!.addEventListener('abort', () => { cancelled(); resolve() }, { once: true }))
      throw new AgentMuxError('The original request was cancelled before confirmation.', 'CONTROL_CANCELLED')
    })
    const endpoint = await server({ call }), client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: endpoint.path } }); cleanups.push(() => client.dispose())
    const controller = new AbortController(), request = client.call('device.approve', inputs['device.approve'], { signal: controller.signal })
    const rejected = expect(request).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
    await ready; controller.abort(); await rejected; await ended; expect(call).toHaveBeenCalledOnce()
  })
  it('keeps admitted device work past response deadlines and explains cancellation read-back without inventing or replaying an invitation', async () => {
    let arrived!: () => void
    const call = vi.fn(async (_method: unknown, _params: unknown, context: AgentMuxRpcCallContext) => {
      arrived(); await new Promise<void>(resolve => context.signal!.addEventListener('abort', () => resolve(), { once: true }))
      throw new AgentMuxError('The original request was cancelled before confirmation.', 'CONTROL_CANCELLED')
    })
    const endpoint = await server({ call }), client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: endpoint.path } }); cleanups.push(() => client.dispose())
    const methods = ['device.ls', 'device.invite'] as const
    expect(methods).toHaveLength(2)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    for (const method of methods) {
      const ready = new Promise<void>(resolve => { arrived = resolve })
      const controller = new AbortController()
      let settled = false
      const pending = client.call(method, {}, { signal: controller.signal })
      const failed = pending.catch(error => error as AgentMuxError).finally(() => { settled = true })
      await ready; await vi.advanceTimersByTimeAsync(method === 'device.ls' ? 2_500 : 61_000)
      expect(settled, 'an admitted owner has no external finite response deadline').toBe(false)
      controller.abort()
      const error = await failed
      expect(error).toMatchObject({ code: 'CONTROL_CANCELLED' })
      if (!(error instanceof AgentMuxError)) throw new Error('Explicit cancellation did not return its original typed error')
      expect(error.message).toContain('Read agentmux device ls'); expect(error.message).not.toContain('operation ID')
      if (method === 'device.invite') {
        expect(error.message).toContain('lost invitation token cannot be recovered')
        expect(error.message).toContain('do not automatically request another invitation')
      } else expect(error.message).toContain('exact device ID facts')
    }
    expect(call).toHaveBeenCalledTimes(2)
  })
  it('rejects secrets, malformed records and foreign devices in actual owner responses', async () => {
    let response: unknown
    const call = vi.fn(async () => response), endpoint = await server({ call: call as AgentMuxRpcDeviceAdministration['call'] })
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: endpoint.path } }); cleanups.push(() => client.dispose())
    const invalid = [
      { hostId: 'original-host', device: { ...device, credentialHash: 'fixture-secret-hash' } },
      { hostId: 'original-host', device: { ...device, deviceId: 'foreign-device' } },
      { hostId: 'original-host', device, credential: 'fixture-secret' },
      { hostId: 'original-host', device: { ...device, createdAt: -1 } }
    ]
    expect(invalid).toHaveLength(4)
    for (const value of invalid) { response = value; await expect(client.call('device.approve', inputs['device.approve'])).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' }) }
    response = { hostId: 'original-host', devices: [device], requests: [{ ...pending, claim: 'fixture-claim' }], privateAccess: { state: 'unavailable', message: 'Private fixture unavailable.' } }
    await expect(client.call('device.ls', {})).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    response = invalid[0]
    const raw = await rawRequest(endpoint.path, { jsonrpc: '2.0', id: 'no-secrets', method: 'device.approve', params: inputs['device.approve'] })
    expect(raw).toMatchObject({ id: 'no-secrets', error: { data: { code: 'CONTROL_PROTOCOL_ERROR' } } })
    expect(JSON.stringify(raw)).not.toContain('fixture-secret'); expect(call).toHaveBeenCalledTimes(6)
  })
  it('refuses non-Unix SDK requests before any HTTP or SSH connection', async () => {
    const host = createServer(socket => { connections++; socket.destroy() }); let connections = 0
    await new Promise<void>(resolve => host.listen(0, '127.0.0.1', resolve)); cleanups.push(() => new Promise<void>(resolve => host.close(() => resolve())))
    const address = host.address(); if (!address || typeof address === 'string') throw new Error('Missing private listener')
    const endpoints = [{ transport: 'http' as const, url: `http://127.0.0.1:${address.port}/`, token: 'private-device' },
      { transport: 'ssh' as const, host: '127.0.0.1', port: address.port, command: 'fixture-unreachable' }]
    expect(endpoints).toHaveLength(2)
    for (const endpoint of endpoints) { const client = await connectAgentMuxRpc({ endpoint }); cleanups.push(() => client.dispose())
      await expect(client.call('device.ls', {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' }) }
    expect(connections).toBe(0)
  })
  it('denies whole stdio requests/batches/notifications before forwarding and preserves ordinary byte spelling', async () => {
    const host = await rawServer(), input = new PassThrough(), out = output(), controller = new AbortController()
    const relay = forwardAgentMuxRpcStdio({ endpoint: { transport: 'unix', path: host.path }, input, output: out.stream, signal: controller.signal })
    cleanups.push(async () => { controller.abort(); await relay; input.destroy(); out.stream.destroy() })
    await vi.waitFor(() => expect(host.sockets).toHaveLength(1))
    input.write(rpcEncode({ jsonrpc: '2.0', id: 'local-denial', method: 'device.invite', params: {} }))
    await vi.waitFor(() => expect(out.frames).toHaveLength(1)); expect(out.frames[0]).toMatchObject({ id: 'local-denial', error: { data: { code: 'CONTROL_PERMISSION_DENIED' } } })
    const batch = rpcEncode([{ jsonrpc: '2.0', id: 17, method: 'system.endpoint', params: {} },
      { jsonrpc: '2.0', method: 'device.approve', params: inputs['device.approve'] },
      { jsonrpc: '2.0', id: 'batch-device', method: 'device.revoke', params: inputs['device.revoke'] }])
    input.write(batch.slice(0, batch.length - 2)); expect(host.frames).toEqual([])
    input.write(batch.slice(-2)); await vi.waitFor(() => expect(out.frames).toHaveLength(2))
    expect(out.frames[1]).toEqual([expect.objectContaining({ id: 17, error: expect.objectContaining({ data: { code: 'CONTROL_PERMISSION_DENIED' } }) }),
      expect.objectContaining({ id: 'batch-device', error: expect.objectContaining({ data: { code: 'CONTROL_PERMISSION_DENIED' } }) })])
    input.write(rpcEncode({ jsonrpc: '2.0', method: 'device.ls', params: {} }))
    const ordinary = ' { "jsonrpc": "2.0", "id": "ordinary", "method": "system.endpoint", "params": {} } \n'
    input.write(ordinary); await vi.waitFor(() => expect(host.frames).toHaveLength(1))
    expect(Buffer.concat(host.chunks).toString()).toBe(ordinary); expect(host.frames[0]).toMatchObject({ id: 'ordinary' }); expect(out.frames).toHaveLength(2)
    const reply = ' {"jsonrpc":"2.0","id":"ordinary","result":{"text":"中文 / \\n"}} \n'
    host.sockets[0]!.write(reply); await vi.waitFor(() => expect(out.frames).toHaveLength(3))
    expect(Buffer.concat(out.chunks).toString().endsWith(reply)).toBe(true)
    controller.abort(); await relay; expect(host.frames).toHaveLength(1)
  })
  it('keeps a held upstream half-response intact when a local device denial is produced', async () => {
    const host = await rawServer(), input = new PassThrough(), out = output(), controller = new AbortController()
    const relay = forwardAgentMuxRpcStdio({ endpoint: { transport: 'unix', path: host.path }, input, output: out.stream, signal: controller.signal })
    cleanups.push(async () => { controller.abort(); await relay; input.destroy(); out.stream.destroy() })
    await vi.waitFor(() => expect(host.sockets).toHaveLength(1))
    const ordinary = ' {"jsonrpc":"2.0","id":"original-upstream","result":{"text":"original 中文"}} \n', split = 38
    const accept = vi.spyOn(AgentMuxRpcLines.prototype, 'accept')
    host.sockets[0]!.write(ordinary.slice(0, split))
    await vi.waitFor(() => expect(accept.mock.calls.some(([bytes]) => Buffer.from(bytes).toString() === ordinary.slice(0, split))).toBe(true))
    // A subsequent denied request must produce its own complete frame; no fragment can have reached stdout.
    input.write(rpcEncode({ jsonrpc: '2.0', id: 'deny-between-halves', method: 'device.ls', params: {} }))
    await vi.waitFor(() => expect(out.frames).toHaveLength(1))
    expect(out.frames[0]).toMatchObject({ id: 'deny-between-halves', error: { data: { code: 'CONTROL_PERMISSION_DENIED' } } })
    host.sockets[0]!.write(ordinary.slice(split)); await vi.waitFor(() => expect(out.frames).toHaveLength(2))
    expect(out.frames[1]).toEqual({ jsonrpc: '2.0', id: 'original-upstream', result: { text: 'original 中文' } })
    expect(Buffer.concat(out.chunks).toString().endsWith(ordinary)).toBe(true); expect(host.frames).toEqual([])
  })
  it('uses standard writable backpressure for complete upstream frames and the local denial', async () => {
    const host = await rawServer(), input = new PassThrough(), controller = new AbortController(), observed: unknown[] = []
    const lines = new AgentMuxRpcLines(); let release!: () => void
    const held = new Writable({ highWaterMark: 1, write(chunk: Buffer, _encoding, callback) {
      lines.accept(chunk, frame => observed.push(frame))
      if (observed.length === 1) release = () => callback(); else callback()
    } })
    const relay = forwardAgentMuxRpcStdio({ endpoint: { transport: 'unix', path: host.path }, input, output: held, signal: controller.signal })
    cleanups.push(async () => { release?.(); controller.abort(); await relay; input.destroy(); held.destroy() })
    await vi.waitFor(() => expect(host.sockets).toHaveLength(1))
    const notifications = [1, 2].map(sequence => ({ jsonrpc: '2.0', method: 'system.subscription.event', params: { sequence, text: 'x'.repeat(32 * 1024) } }))
    expect(notifications).toHaveLength(2)
    host.sockets[0]!.write(notifications.map(rpcEncode).join(''))
    await vi.waitFor(() => expect(observed).toHaveLength(1))
    input.write(rpcEncode({ jsonrpc: '2.0', id: 'held-local', method: 'device.ls', params: {} }))
    expect(observed).toEqual([notifications[0]])
    release(); await vi.waitFor(() => expect(observed).toHaveLength(3))
    expect(observed.filter(frame => (frame as { method?: string }).method === 'system.subscription.event')).toEqual(notifications)
    expect(observed.find(frame => (frame as { id?: string }).id === 'held-local')).toMatchObject({ error: { data: { code: 'CONTROL_PERMISSION_DENIED' } } })
    expect(host.frames).toEqual([])
  })
})

const bin = fileURLToPath(new URL('../bin/agentmux', import.meta.url))
describe('compiled: public device entry points', () => {
  it('refuses actual CLI HTTP/SSH endpoints without a network connection', async () => {
    const path = await root(); let connections = 0
    const listener = createServer(socket => { connections++; socket.destroy() })
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve)); cleanups.push(() => new Promise<void>(resolve => listener.close(() => resolve())))
    const address = listener.address(); if (!address || typeof address === 'string') throw new Error('Missing private address')
    const endpoints = [`http://127.0.0.1:${address.port}/`, `ssh://127.0.0.1:${address.port}/`]
    expect(endpoints).toHaveLength(2)
    for (const endpoint of endpoints) {
      const response = await new Promise<{ code: number | string | null; stdout: string; stderr: string }>(resolve => {
        execFile(process.execPath, [bin, '--endpoint', endpoint, 'device', 'ls'], { env: objectCliEnvironment(path, { AGENTMUX_RPC_HTTP_TOKEN: 'private-fixture' }) },
          (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }))
      })
      expect(response.code).not.toBe(0); expect(response.stdout + response.stderr).toContain('CONTROL_PERMISSION_DENIED')
    }
    expect(connections).toBe(0)
  })
  it('returns typed original-ID denials in the actual stdio process and continues ordinary request/notifications', async () => {
    const host = await rawServer(), env = objectCliEnvironment(await root())
    const child = spawn(process.execPath, [bin, '--endpoint', `unix:${host.path}`, 'system', 'endpoint', '--stdio'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    const out = output(), errors: Buffer[] = []
    child.stdout.pipe(out.stream); child.stderr.on('data', chunk => errors.push(Buffer.from(chunk)))
    const ended = new Promise<void>(resolve => child.once('close', () => resolve()))
    cleanups.push(async () => { child.kill('SIGTERM'); await ended; out.stream.destroy() })
    await vi.waitFor(() => expect(host.sockets).toHaveLength(1))
    child.stdin.write(rpcEncode({ jsonrpc: '2.0', id: 'child-denial', method: 'device.invite', params: {} }))
    child.stdin.write(rpcEncode([{ jsonrpc: '2.0', id: 9, method: 'system.endpoint', params: {} },
      { jsonrpc: '2.0', method: 'device.reject', params: inputs['device.reject'] }]))
    await vi.waitFor(() => expect(out.frames).toHaveLength(2))
    expect(out.frames).toEqual([expect.objectContaining({ id: 'child-denial', error: expect.objectContaining({ data: { code: 'CONTROL_PERMISSION_DENIED' } }) }),
      [expect.objectContaining({ id: 9, error: expect.objectContaining({ data: { code: 'CONTROL_PERMISSION_DENIED' } }) })]])
    expect(host.frames).toEqual([])
    const ordinary = ' {"jsonrpc":"2.0","id":"child-ordinary","method":"system.endpoint","params":{}} \n'
    child.stdin.write(ordinary); await vi.waitFor(() => expect(host.frames).toHaveLength(1)); expect(Buffer.concat(host.chunks).toString()).toBe(ordinary)
    const reply = rpcEncode({ jsonrpc: '2.0', id: 'child-ordinary', result: { original: true } })
    const notification = rpcEncode({ jsonrpc: '2.0', method: 'system.subscription.event', params: { original: 'nonempty 中文' } })
    host.sockets[0]!.write(reply + notification); await vi.waitFor(() => expect(out.frames).toHaveLength(4))
    expect(Buffer.concat(out.chunks).toString().endsWith(reply + notification)).toBe(true); expect(Buffer.concat(errors).toString()).toBe('')
    child.kill('SIGINT'); await ended; expect(host.frames).toHaveLength(1)
  })
})
