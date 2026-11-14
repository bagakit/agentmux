import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { build } from 'esbuild'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { hashPublisherToken } from '@agentmux/relay/gateway'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { startHeadlessAgentMux } from '../src/headless-runtime.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { CoreRelayGateway, parseAgentMuxRelayInspection, type AgentMuxRelayGatewaySource } from '../src/public-rpc-relay-gateway.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'

// Consume the production listener worker in this source-only test before Core emit.
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, fork: ((path: string | URL, args: readonly string[], options: import('node:child_process').ForkOptions) =>
    actual.fork(String(path).endsWith('/control-endpoint-listener-worker.js')
      ? fileURLToPath(new URL('../src/control-endpoint-listener-worker.ts', import.meta.url)) : path, args, options)) as typeof actual.fork }
})

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const source = { publishers: [{ serverId: 'original-publisher', tokenHash: hashPublisherToken('private-publisher-grant') }], listen: { host: '127.0.0.1', port: 0 } }
const cli = resolve('.local/state/mesh-network-access/legacy-cli/agentmux.mjs')
beforeAll(async () => {
  await mkdir(dirname(cli), { recursive: true })
  await symlink(resolve('packages/core/node_modules'), join(dirname(cli), 'node_modules'), 'dir').catch(error => { if (error.code !== 'EEXIST') throw error })
  await build({ entryPoints: [resolve('packages/core/src/agentmux.ts')], outfile: cli, bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external' })
})

async function fixture(relayGateway?: AgentMuxRelayGatewaySource, http = false) {
  const root = await mkdtemp(join(tmpdir(), 'amrg-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const owner = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), ...(relayGateway === undefined ? {} : { relayGateway }),
    ...(http ? { http: { host: '127.0.0.1', port: 0, token: 'original-http-token' } } : {}) })
  await owner.start(); cleanup.push(() => owner.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: owner.path } }); cleanup.push(() => rpc.dispose())
  return { root, owner, rpc }
}

it('the actual RPC and compiled CLI report the default gateway disabled without opening HTTP', async () => {
  const f = await fixture()
  expect(await f.rpc.call('system.relay.inspect', {})).toEqual({ gateway: { state: 'disabled' } })
  expect(f.owner.httpAddress).toBeNull()
  const result = await promisify(execFile)(process.execPath, [cli, '--endpoint', `unix:${f.owner.path}`, 'system', 'relay', 'inspect'], { env: objectCliEnvironment(f.root), timeout: 10_000 })
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, operation: 'system.relay.inspect', result: { gateway: { state: 'disabled' } } })
})

it('the Core-owned gateway actually admits and routes its original publisher without publishing HTTP RPC', async () => {
  const f = await fixture(source)
  await vi.waitFor(async () => expect((await f.rpc.call('system.relay.inspect', {})).gateway.state).toBe('listening'))
  const observation = await f.rpc.call('system.relay.inspect', {})
  expect(f.owner.httpAddress).toBeNull()
  const endpoint = `127.0.0.1:${observation.gateway.listener!.port}`
  const response = await fetch(`http://${endpoint}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system.endpoint', params: {} }) })
  expect(response.status).toBe(404)
  const control = new WebSocket(`ws://${endpoint}/ws?v=2&serverId=original-publisher&role=server`, { headers: { Authorization: 'Bearer private-publisher-grant' } })
  cleanup.push(() => control.terminate())
  const synced = once(control, 'message'); await once(control, 'open')
  expect(JSON.parse(String((await synced)[0]))).toEqual({ type: 'sync', connectionIds: [] })
  const opened = once(control, 'message')
  const client = new WebSocket(`ws://${endpoint}/ws?v=2&serverId=original-publisher&role=client`)
  cleanup.push(() => client.terminate()); await once(client, 'open')
  const connection = JSON.parse(String((await opened)[0]))
  expect(connection).toMatchObject({ type: 'connected', connectionId: expect.any(String) })
  const publisher = new WebSocket(`ws://${endpoint}/ws?v=2&serverId=original-publisher&role=server&connectionId=${connection.connectionId}`, { headers: { Authorization: 'Bearer private-publisher-grant' } })
  cleanup.push(() => publisher.terminate()); await once(publisher, 'open')
  const received = once(publisher, 'message'); client.send('opaque-native-request')
  expect(String((await received)[0])).toBe('opaque-native-request')
  const reply = once(client, 'message'); publisher.send('opaque-native-response')
  expect(String((await reply)[0])).toBe('opaque-native-response')
  expect((await f.rpc.call('system.endpoint', {})).publication).toEqual({ state: 'available' })
})

it('a gateway borrows an explicitly configured Core HTTP listener', async () => {
  const f = await fixture({ publishers: source.publishers }, true)
  await vi.waitFor(async () => expect((await f.rpc.call('system.relay.inspect', {})).gateway.state).toBe('listening'))
  const observation = await f.rpc.call('system.relay.inspect', {})
  expect(observation.gateway.listener).toEqual({ ...f.owner.httpAddress, tls: false })
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'http', url: `http://127.0.0.1:${f.owner.httpAddress!.port}/`, token: 'original-http-token' } })
  cleanup.push(() => rpc.dispose())
  expect((await rpc.call('system.endpoint', {})).protocol).toBe('jsonrpc-2.0')
})

it('releasing the gateway preserves its borrowed listener and unrelated HTTP service', async () => {
  const server = createServer((_request, response) => response.end('original borrowed service'))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const gateway = new CoreRelayGateway({ publishers: source.publishers }); cleanup.push(() => gateway.stop())
  gateway.start({ server, tls: false })
  await vi.waitFor(() => expect(gateway.inspect().gateway.state).toBe('listening'))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Private listener missing')
  await gateway.stop()
  expect(gateway.inspect().gateway).toMatchObject({ state: 'unavailable', issue: { code: 'RELAY_GATEWAY_STOPPED' } })
  await expect(fetch(`http://127.0.0.1:${address.port}/`).then(response => response.text())).resolves.toBe('original borrowed service')
})

it.each(['missing-file', 'malformed-file', 'relative-file', 'invalid-shape', 'missing-shared-listener'] as const)('%s affects only the optional gateway, with no credential leak or Unix failure', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'amrg-config-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'gateway.json'), secret = 'do-not-print-private-publisher-or-TLS-value'
  await writeFile(path, '{"secret":"' + secret + '"')
  const config = mode === 'missing-file' ? { configurationPath: join(root, 'absent') }
    : mode === 'malformed-file' ? { configurationPath: path }
    : mode === 'relative-file' ? { configurationPath: 'relative.json' }
    : mode === 'invalid-shape' ? { publishers: [{ serverId: 'original', tokenHash: secret }], listen: source.listen }
    : { publishers: source.publishers }
  const f = await fixture(config)
  await vi.waitFor(async () => expect((await f.rpc.call('system.relay.inspect', {})).gateway.state).toBe('unavailable'))
  const observation = await f.rpc.call('system.relay.inspect', {})
  expect(observation.gateway).toMatchObject({ state: 'unavailable', issue: { code: 'RELAY_GATEWAY_UNAVAILABLE', message: expect.any(String) } })
  expect(JSON.stringify(observation)).not.toContain(secret)
  expect((await f.rpc.call('system.endpoint', {})).publication).toEqual({ state: 'available' })
})

it('an unavailable gateway port leaves the exact existing Core public owner serving', async () => {
  const occupied = createServer(); await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { occupied.closeAllConnections(); await new Promise<void>(resolve => occupied.close(() => resolve())) })
  const address = occupied.address(); if (!address || typeof address === 'string') throw new Error('Private port not occupied')
  const f = await fixture({ ...source, listen: { host: '127.0.0.1', port: address.port } })
  await vi.waitFor(async () => expect((await f.rpc.call('system.relay.inspect', {})).gateway.state).toBe('unavailable'))
  expect((await f.rpc.call('system.endpoint', {})).publication).toEqual({ state: 'available' })
})

it('the exact configuration file is read once while inspection remains passive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amrg-once-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'gateway.json'); await writeFile(path, JSON.stringify(source))
  const f = await fixture({ configurationPath: path })
  await vi.waitFor(async () => expect((await f.rpc.call('system.relay.inspect', {})).gateway.state).toBe('listening'))
  const before = await f.rpc.call('system.relay.inspect', {})
  await writeFile(path, '{}')
  expect(await f.rpc.call('system.relay.inspect', {})).toEqual(before)
})

it('startHeadlessAgentMux directly embeds the same package while original Native activation is outside this transport proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amrg-core-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  for (const [key, value] of Object.entries(objectCliEnvironment(root))) if (key.startsWith('AGENTMUX_') || key.startsWith('CTXMUX_')) vi.stubEnv(key, value)
  vi.spyOn(AgentMuxClient.prototype, 'connect').mockResolvedValue(undefined)
  const owner = await startHeadlessAgentMux({ store: new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')), providers: [], socketPath: join(root, 'core.sock'), relayGateway: source })
  cleanup.push(() => owner.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: owner.socketPath } }); cleanup.push(() => rpc.dispose())
  await vi.waitFor(async () => expect((await rpc.call('system.relay.inspect', {})).gateway.state).toBe('listening'))
  expect((await rpc.call('runtime.owner.identity', {})).owner.runtimeId).toBe(owner.ownerIdentity().runtimeId)
  expect(owner.server.httpAddress).toBeNull()
})

it.each([
  { gateway: { state: 'listening' } }, { gateway: { state: 'disabled', listener: { host: '127.0.0.1', port: 1, tls: false } } },
  { gateway: { state: 'unavailable' } }, { gateway: { state: 'listening', listener: { host: '127.0.0.1', port: 0, tls: false } } },
  { gateway: { state: 'disabled', publishers: source.publishers } }, { gateway: { state: 'unavailable', issue: { code: 'x', message: 'x', secret: 'hidden' } } },
  { gateway: { state: ['disabled'] } }, { gateway: { state: ['unavailable'] } }, { gateway: { state: false } },
])('the public observation codec refuses malformed or secret-bearing state %#', value => { expect(() => parseAgentMuxRelayInspection(value)).toThrow() })
