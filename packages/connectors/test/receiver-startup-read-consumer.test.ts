import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import * as core from '../../core/src/index.js'
import { hostedTestOwner } from '../../core/test/helpers/hosted-runtime-port.js'
import { ingressFixture } from './fixtures/ingress.js'
import { feishuConfig } from './fixtures/feishu.js'
import { feishuStartupReadTransport } from './fixtures/feishu-startup-read.js'
import { FeishuAdapter } from '../src/adapters/feishu/index.js'
import { createConnectionServices } from '../src/connection-services.js'

const close: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const dispose of close.splice(0).reverse()) try { await dispose() } catch (error) { failures.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (failures.length) throw new AggregateError(failures, 'Original startup read fixture cleanup failed')
})
const wait = (read: () => void | Promise<void>, timeout = 20_000) => vi.waitFor(read, { interval: 40, timeout })
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function fixture(configure: (wire: Awaited<ReturnType<typeof feishuStartupReadTransport>>) => void) {
  const wire = await feishuStartupReadTransport(); close.push(wire.close); configure(wire)
  const original = await ingressFixture(true, feishuConfig); close.push(original.close)
  const starts = vi.spyOn(original.inner.kernel, 'start')
  const adapter = new FeishuAdapter({ http: wire.http })
  const services = await createConnectionServices({ directory: join(original.root, 'startup-read-host'), adapters: [adapter],
    bindings: { spatial: original.spatial, checkpoint: ref => original.client.conversationCheckpoint(ref) },
    ingress: { core: host => host === 'local' ? original.client : undefined } }); close.push(() => services.close())
  const secret = await services.secrets.store({ operationId: 'startup-read-secret', secret: 'fixture-credential' })
  await services.connections.configure({ operationId: 'startup-read-config', expectedRevision: null,
    connection: { ...feishuConfig, credentialRef: secret.credentialRef } })
  expect(await services.connections.bindings!.bind(original.input, { actor: { kind: 'user', id: 'original-user' } })).toMatchObject({ state: 'applied' })
  expect(await services.connections.bindings!.grant(original.grant, { actor: { kind: 'user', id: 'original-user' } })).toMatchObject({ state: 'applied' })
  const runtime = new core.AgentMuxHostedRuntimeService(original.client, original.store.path, () => hostedTestOwner(original.client)); close.push(() => runtime.dispose())
  const server = new core.AgentMuxControlServer({ socketPath: join(original.root, 'startup-read.sock'), connections: services.connections,
    coreClients: original.coreClients, hostedRuntime: () => runtime }); await server.start(); close.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); close.push(() => rpc.dispose())
  const current = async () => (await rpc.call('connection.inspect', { connectionId: feishuConfig.connectionId })).connection!
  const unchanged = () => {
    expect(original.client.agentSession(original.input.agentSessionId).run).toEqual(original.session.run)
    expect(starts).not.toHaveBeenCalled(); expect(original.inner.kernel.stop).not.toHaveBeenCalled()
  }
  return { ...original, wire, adapter, services, current, unchanged }
}

it.each(['token', 'bot'] as const)('original %s startup HTTP stops waiting and the same Host automatically receives a new ingress', async resource => {
  const f = await fixture(wire => { wire.policy[resource].hold = true })
  await wait(() => expect(f.wire.reads.find(read => read.resource === resource)?.serverReceived).toBe(true))
  const read = f.wire.reads.find(read => read.resource === resource)!
  await wait(() => expect(read.signal?.aborted, 'The actual startup request must end its accurate observation').toBe(true))
  await wait(async () => expect((await f.current()).observation.transport).toMatchObject({ state: 'unavailable', reason: 'check-failed' }))
  expect(f.wire.sockets).toHaveLength(0)
  f.wire.policy[resource].hold = false
  await wait(async () => expect((await f.current()).receiver?.state).toBe('ready'))
  expect((await f.current()).revision).toBe(1); expect(f.wire.sockets).toHaveLength(1)
  if (resource === 'bot') expect(f.wire.reads.filter(read => read.resource === 'token')).toHaveLength(1)
  f.wire.message('startup-read-' + resource)
  await wait(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  expect(f.wire.acknowledgements).toEqual([{ code: 200 }])
  f.unchanged()
}, 45_000)

it('closing the original startup reader preserves a concurrent cached Client read and healthy exact input', async () => {
  const f = await fixture(wire => { wire.policy.bot.hold = true })
  await wait(() => expect(f.wire.reads.find(read => read.resource === 'bot')?.serverReceived).toBe(true))
  const startup = f.wire.reads.find(read => read.resource === 'bot')!
  const healthy = new AbortController()
  const reading = f.adapter.withClient(feishuConfig, 'fixture-credential', client =>
    client.request({ url: '/open-apis/bot/v3/info', method: 'GET' }), healthy.signal)
  void reading.catch(() => {}) // Failure cleanup may close the held native leaf before this case awaits it.
  await wait(() => expect(f.wire.reads.filter(read => read.resource === 'bot' && read.serverReceived)).toHaveLength(2))
  const other = f.wire.reads.filter(read => read.resource === 'bot')[1]!
  expect(f.wire.reads.filter(read => read.resource === 'token')).toHaveLength(1)
  await f.client.submitAgentPrompt({ agentSessionId: f.input.agentSessionId, operationId: 'startup-independent-healthy-input',
    prompt: 'Independent healthy input while one receiver identity read is held.', expectedRun: f.session.run, afterSubmissionId: null, authorHuman: true })
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  await f.services.close()
  await wait(() => expect(startup.signal?.aborted, 'The exact old startup HTTP observes its original receiver cancellation').toBe(true), 1_000)
  expect(other.signal).toBeDefined(); expect(other.signal?.aborted).toBe(false); expect(healthy.signal.aborted).toBe(false)
  f.wire.release('bot')
  expect(await reading).toMatchObject({ code: 0, bot: { open_id: expect.any(String) } })
  expect(f.wire.sockets).toHaveLength(0)
  f.unchanged()
}, 10_000)

it('cold-cache token14s then bot14s have independent real windows and ready WS outlives startup reads', async () => {
  const f = await fixture(wire => { wire.policy.token.delayMs = 14_000; wire.policy.bot.delayMs = 14_000 })
  await wait(async () => expect((await f.current()).receiver?.state).toBe('ready'), 35_000)
  expect(f.wire.reads.map(read => [read.resource, read.method.toUpperCase()])).toEqual([['token', 'POST'], ['bot', 'GET']])
  const [token, bot] = f.wire.reads
  expect(bot!.completedAt! - token!.startedAt).toBeGreaterThan(27_000)
  expect(f.wire.reads.every(read => read.abortedAt === undefined)).toBe(true)
  const ref = (await f.current()).receiver!.ref
  await pause(15_300)
  expect((await f.current()).receiver).toMatchObject({ ref, state: 'ready' })
  expect(f.wire.sockets).toHaveLength(1); expect(f.wire.acknowledgements).toEqual([])
  f.unchanged()
}, 60_000)

it.each(['success', 'rejection'] as const)('ignored-abort old token %s cannot advance bot or replace the automatically ready receiver', async result => {
  const f = await fixture(wire => { wire.policy.token = { hold: true, ignoreAbort: true } })
  await wait(() => expect(f.wire.reads[0]?.serverReceived).toBe(true))
  const old = f.wire.reads[0]!
  await wait(() => expect(old.signal?.aborted).toBe(true))
  expect(old.completedAt).toBeUndefined()
  f.wire.policy.token = {}
  await wait(async () => expect((await f.current()).receiver?.state).toBe('ready'))
  const ref = (await f.current()).receiver!.ref, reads = f.wire.reads.length
  if (result === 'success') f.wire.release('token')
  else f.wire.reject('token')
  await wait(() => expect(old.completedAt).toBeDefined())
  await pause(100)
  expect(f.wire.reads).toHaveLength(reads)
  expect((await f.current()).receiver).toMatchObject({ ref, state: 'ready' })
  expect(f.wire.sockets).toHaveLength(1)
  f.unchanged()
}, 45_000)
