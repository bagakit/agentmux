import { afterEach, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'
import * as core from '../../core/src/index.js'
import { hostedTestOwner } from '../../core/test/helpers/hosted-runtime-port.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { ingressFixture } from './fixtures/ingress.js'
import { feishuConfig } from './fixtures/feishu.js'
import { feishuSocketTransport } from './fixtures/feishu-socket.js'
import { FeishuAdapter } from '../src/adapters/feishu/index.js'
import { createConnectionServices } from '../src/connection-services.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { failures.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (failures.length) throw new AggregateError(failures, 'Original receiver lifecycle fixture cleanup failed')
})
const wait = (read: () => void | Promise<void>, timeout = 9000) => vi.waitFor(read, { interval: 40, timeout })
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function fixture(options: Parameters<typeof feishuSocketTransport>[0] = {}, ready = true) {
  const wire = await feishuSocketTransport(options); cleanup.push(wire.close)
  const f = await ingressFixture(true, feishuConfig); cleanup.push(f.close)
  const starts = vi.spyOn(f.inner.kernel, 'start')
  const adapter = new FeishuAdapter({ http: wire.http })
  const services = await createConnectionServices({ directory: join(f.root, 'receiver-host'), adapters: [adapter],
    bindings: { spatial: f.spatial, checkpoint: ref => f.client.conversationCheckpoint(ref) },
    ingress: { core: host => host === 'local' ? f.client : undefined } }); cleanup.push(() => services.close())
  const secret = await services.secrets.store({ operationId: 'receiver-secret', secret: 'fixture-credential' })
  await services.connections.configure({ operationId: 'receiver-config', expectedRevision: null,
    connection: { ...feishuConfig, credentialRef: secret.credentialRef } })
  expect(await services.connections.bindings!.bind(f.input, { actor: { kind: 'user', id: 'original-user' } })).toMatchObject({ state: 'applied' })
  expect(await services.connections.bindings!.grant(f.grant, { actor: { kind: 'user', id: 'original-user' } })).toMatchObject({ state: 'applied' })
  const runtime = new core.AgentMuxHostedRuntimeService(f.client, f.store.path, () => hostedTestOwner(f.client))
  cleanup.push(() => runtime.dispose())
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'receiver.sock'), connections: services.connections,
    coreClients: f.coreClients, hostedRuntime: () => runtime })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const hosted = await core.connectHostedAgentMux({ rpc, waitForReady: false,
    forwardRpc: (method, params, context = {}) => rpc.call(method, params, { ...(context.runtimeFence ? { runtimeFence: context.runtimeFence } : {}),
      ...(context.signal ? { signal: context.signal } : {}) }) }); cleanup.push(() => hosted.dispose())
  const current = async () => (await hosted.forwardRpc!('connection.inspect', { connectionId: feishuConfig.connectionId })).connection!
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const cli = async (args: string[]) => {
    const output = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', ...args], objectCliEnvironment(f.root))
    expect(output.code, output.stdout + output.stderr).toBe(0)
    return JSON.parse(output.stdout).result
  }
  if (ready) await wait(async () => expect((await current()).receiver?.state, JSON.stringify({ upgrades: wire.upgrades.length,
    sockets: wire.sockets.length, tlsErrors: wire.tlsErrors, requests: wire.requests.length, receiver: (await current()).receiver })).toBe('ready'), 18000)
  const unchanged = () => {
    expect(f.client.agentSession(f.input.agentSessionId).run).toEqual(f.session.run)
    expect(starts).not.toHaveBeenCalled()
    expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.attach).not.toHaveBeenCalled()
  }
  return { ...f, wire, services, hosted, rpc, current, cli, unchanged }
}

it('native no-close loss recovers within the same SDK consumer and public Hosted/CLI facts retain one original input', async () => {
  const f = await fixture(), original = await f.current(), ref = original.receiver!.ref
  expect(f.wire.sockets).toHaveLength(1)
  await wait(() => expect(f.wire.pings.length).toBeGreaterThan(0))
  f.wire.message('receiver-original')
  await wait(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  expect(f.wire.acknowledgements).toEqual([{ code: 200 }])
  const publicRead = await f.cli(['inspect', '--connection', feishuConfig.connectionId])
  expect(publicRead.connection.receiver).toMatchObject({ ref, state: 'ready' })
  const diagnosis = await f.cli(['diagnose', '--host', 'local', '--session', f.input.agentSessionId])
  expect(diagnosis.groups.value.items[0].connection.value.receiver).toMatchObject({ ref, state: 'ready' })
  f.wire.state.pong = false
  f.wire.sockets[0]!.once('close', () => { f.wire.state.pong = true })
  await wait(() => expect(f.wire.sockets).toHaveLength(2), 36000)
  await wait(async () => expect((await f.current()).receiver).toMatchObject({ ref, state: 'ready' }))
  f.wire.message('receiver-original')
  await wait(() => expect(f.wire.acknowledgements).toEqual([{ code: 200 }, { code: 200 }]))
  expect((await f.services.ingress!.list({ connectionId: feishuConfig.connectionId })).ingresses).toHaveLength(1)
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  f.unchanged()
}, 55000)

it('SDK terminal failure hands the original consumer to Host recovery while native rejection remains an original observation', async () => {
  const f = await fixture(), old = (await f.current()).receiver!.ref
  f.wire.state.nextEndpointCode = 1
  f.wire.sockets[0]!.terminate()
  await wait(async () => expect((await f.current()).receiver).toMatchObject({ ref: old, state: 'ended', reason: 'native-unavailable' }))
  await wait(async () => {
    const current = (await f.current()).receiver!
    expect(current.ref).not.toBe(old); expect(current.state).toBe('ready')
  })
  expect((await f.current()).revision).toBe(1)
  const current = (await f.current()).receiver!.ref
  f.wire.state.nextEndpointCode = 403
  f.wire.sockets.at(-1)!.terminate()
  await wait(async () => expect((await f.current()).receiver).toMatchObject({ ref: current, state: 'ended', reason: 'native-rejected' }))
  const requests = f.wire.requests.filter(row => row.url?.endsWith('/callback/ws/endpoint')).length
  await pause(5500)
  expect(f.wire.requests.filter(row => row.url?.endsWith('/callback/ws/endpoint'))).toHaveLength(requests)
  expect((await f.current()).config.enabled).toBe(true)
  f.unchanged()
}, 20000)

it('an initial native rejection is retained even when it races transport startup completion', async () => {
  const f = await fixture({ endpointCode: 514 }, false)
  await wait(async () => expect((await f.current()).receiver).toMatchObject({ state: 'ended', reason: 'native-rejected' }))
  expect(f.wire.sockets).toEqual([])
  expect((await f.current()).revision).toBe(1)
  expect((await f.current()).config.enabled).toBe(true)
  f.unchanged()
})

it('slow native handshake and pong inside their own budgets keep an idle healthy receiver without a business event', async () => {
  const f = await fixture({ handshakeDelay: 14000, pongDelay: 14000 }), original = (await f.current()).receiver!.ref
  await pause(14200)
  expect(f.wire.upgrades).toHaveLength(1); expect(f.wire.sockets).toHaveLength(1)
  expect(f.wire.pings.length).toBeGreaterThan(0)
  expect(f.wire.acknowledgements).toEqual([])
  expect((await f.current()).receiver).toMatchObject({ ref: original, state: 'ready' })
  expect((await f.services.ingress!.list({ connectionId: feishuConfig.connectionId })).ingresses).toEqual([])
  f.unchanged()
}, 40000)

it('a native handshake beyond its budget is retried by the SDK and a late old upgrade cannot affect the healthy generation', async () => {
  const f = await fixture({ handshakeDelay: 16500 }), original = (await f.current()).receiver!.ref
  expect(f.wire.upgrades).toHaveLength(2); expect(f.wire.sockets).toHaveLength(1)
  await pause(1800)
  expect(f.wire.sockets).toHaveLength(1)
  expect((await f.current()).receiver).toMatchObject({ ref: original, state: 'ready' })
  f.unchanged()
}, 30000)
