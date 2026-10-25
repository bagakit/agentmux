import { afterEach, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'
import { ConnectionReceivers, DurableIngressHost } from '../dist/index.js'
import { FeishuAdapter } from '@agentmux/connectors/adapters/feishu'
import * as core from '../../core/dist/index.js'
import { ingressFixture } from './fixtures/ingress.js'
import { feishuConfig, feishuPayload, feishuSdkTransport } from './fixtures/feishu.js'
import { context } from './fixtures/room-binding.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) {
    try { await close() } catch (error) { errors.push(error) }
  }
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers()
  if (errors.length) throw new AggregateError(errors, 'Original receiver fixture cleanup failed')
})

async function fixture() {
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const sdk = feishuSdkTransport(), adapter = new FeishuAdapter({ http: sdk.http })
  const f = await ingressFixture(true, feishuConfig, { resolve: async () => 'fixture-credential' }, { adapters: [adapter] })
  cleanup.push(() => f.close())
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  let available = false
  const ingress = new DurableIngressHost({ ...f.options, authenticators: [adapter], core: host => available ? f.options.core(host) : undefined })
  f.connections.ingress = ingress
  // Control only periodic scheduling. SDK callback, durable ACK, deferred dispatch and RPC remain real.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const receivers = new ConnectionReceivers(f.connections, ingress); cleanup.push(() => receivers.close())
  const dispatch = vi.spyOn(ingress, 'dispatch')
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'receiver.sock'), connections: f.connections, coreClients: f.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  const client = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => client.dispose())
  await vi.waitFor(async () => expect((await client.call('connection.inspect', { connectionId: feishuConfig.connectionId })).connection?.observation.transport.state).toBe('ready'))
  const current = async () => (await client.call('connection.inspect', { connectionId: feishuConfig.connectionId })).connection!
  const list = async () => (await client.call('connection.ingress.ls', { connectionId: feishuConfig.connectionId, limit: 100 })).ingresses
  const cli = async (args: string[]) => {
    const reply = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', ...args], objectCliEnvironment(f.root))
    expect(reply.code, reply.stderr + reply.stdout).toBe(0)
    return JSON.parse(reply.stdout).result
  }
  async function receive(id: string, userId = f.actor.userId) {
    const payload = feishuPayload({ message_id: id, content: JSON.stringify({ text: 'Original ' + id }) })
    payload.header.event_id = 'event-' + id
    payload.event.sender.sender_id.open_id = userId
    await sdk.receive(payload)
    return (await list()).find(record => record.externalMessageId === id)!
  }
  return { ...f, sdk, ingress, receivers, dispatch, rpc: client, current, list, cli, receive, available: () => { available = true } }
}

it('keeps actual SDK authentication and transport while original Core dispatch is unavailable, then recovers that same intake', async () => {
  const f = await fixture(), original = await f.receive('first-message')
  expect(f.sdk.ack()).toEqual([{ code: 200 }])
  await vi.waitFor(async () => expect((await f.current()).observation).toMatchObject({ authentication: { state: 'ready' }, transport: { state: 'ready' }, intake: { state: 'unknown', reason: 'check-failed' } }))
  const failed = await f.cli(['ingress', 'inspect', '--ingress', original.ingressId])
  expect(failed).toMatchObject({ ingress: { ...original, state: 'received' }, inputReceipt: null, observation: 'not-started' })
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect((await f.cli(['inspect', '--connection', feishuConfig.connectionId])).connection.observation).toMatchObject({ authentication: { state: 'ready' }, transport: { state: 'ready' }, intake: { state: 'unknown', reason: 'check-failed' } })

  // A different successful message cannot repair the failed original observation.
  f.available()
  const later = await f.receive('later-message')
  await vi.waitFor(async () => expect((await f.ingress.inspect({ ingressId: later.ingressId })).ingress?.state).toBe('claimed'))
  await Promise.allSettled(f.dispatch.mock.results.map(result => result.value))
  expect((await f.current()).observation.intake).toEqual({ state: 'unknown', reason: 'check-failed' })
  expect((await f.ingress.inspect({ ingressId: original.ingressId })).ingress?.state).toBe('received')

  const ws = f.sdk.sockets[0]!, status = ws.getConnectionStatus()
  const disconnected = vi.spyOn(ws, 'getConnectionStatus').mockReturnValue({ ...status, state: 'failed' })
  expect((await f.current()).observation.transport).toEqual({ state: 'unavailable', reason: 'check-failed' })
  disconnected.mockRestore()
  f.receivers.refresh()
  await vi.waitFor(async () => expect((await f.current()).observation.intake.state).toBe('ready'))
  const recovered = await f.cli(['ingress', 'inspect', '--ingress', original.ingressId])
  expect(recovered.ingress).toMatchObject({ ingressId: original.ingressId, body: original.body, state: 'claimed', input: { agentSessionId: f.input.agentSessionId, expectedRun: f.session.run } })
  expect(recovered.inputReceipt.originalControlOperationId).toBe(recovered.ingress.input.operationId)
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledTimes(2))
  const queue = await new core.DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath()).readByOperationId(recovered.ingress.input.operationId)
  expect(queue?.envelope.body).toBe(original.body)
  expect(queue?.envelope.sender).toEqual(recovered.ingress.input.author)
  await f.receive('first-message')
  await Promise.allSettled(f.dispatch.mock.results.map(result => result.value))
  expect(await f.list()).toHaveLength(2)
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(2)
  expect(f.client.agentSession(f.input.agentSessionId).run).toEqual(f.session.run)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.attach).not.toHaveBeenCalled()
  expect(JSON.stringify(recovered)).not.toMatch(/fixture-credential|transportProof|raw_payload/)
}, 20_000)

it('fairly rechecks later terminal records while earlier original dispatches keep failing', async () => {
  const f = await fixture(), actor = { ...f.actor, userId: 'later-external-user' }
  const laterGrant = { ...f.grant, operationId: 'grant-later', grantId: 'later-grant', actor }
  expect((await f.bindings.grant(laterGrant, context)).state).toBe('applied')
  for (let n = 0; n < 30; n++) await f.receive('retained-' + n, n < 25 ? f.actor.userId : actor.userId)
  await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(30))
  await Promise.allSettled(f.dispatch.mock.results.map(result => result.value))
  const originals = await f.list(), terminal = originals.slice(25)
  expect(originals).toHaveLength(30); expect(originals.every(record => record.state === 'received')).toBe(true)
  expect((await f.current()).observation.intake.reason).toBe('check-failed')
  expect((await f.bindings.grant({ ...laterGrant, operationId: 'revoke-later', expectedRevision: 1, state: 'revoked' }, context)).state).toBe('applied')
  for (const original of terminal) expect((await f.ingress.dispatch(original.ingressId)).ingress).toMatchObject({ ingressId: original.ingressId, state: 'refused', code: 'INGRESS_ACTOR_NOT_AUTHORIZED' })
  expect(f.ingress.received(feishuConfig.connectionId).ingressIds).toHaveLength(25)
  const before = f.dispatch.mock.calls.length
  f.receivers.refresh()
  await vi.waitFor(() => expect(f.dispatch.mock.calls.length).toBe(before + 25))
  await Promise.allSettled(f.dispatch.mock.results.map(result => result.value))
  const second = f.dispatch.mock.calls.length
  f.receivers.refresh()
  // The unfinished-observation cursor and failed-dispatch cursor both advance
  // to these five originals; overlapping candidates are dispatched only once.
  await vi.waitFor(() => expect(f.dispatch.mock.calls.length).toBe(second + 5))
  await Promise.allSettled(f.dispatch.mock.results.map(result => result.value))
  const rechecks = f.dispatch.mock.calls.slice(second).map(([id]) => id)
  for (const original of terminal) expect(rechecks).toContain(original.ingressId)
  // Persistent first-page failures do not hide the five original receipts after it.
  expect((await f.current()).observation).toMatchObject({ authentication: { state: 'ready' }, transport: { state: 'ready' }, intake: { state: 'unknown', reason: 'check-failed' } })
  const third = f.dispatch.mock.calls.length
  f.receivers.refresh()
  await vi.waitFor(() => expect(f.dispatch.mock.calls.length).toBe(third + 25))
  await Promise.allSettled(f.dispatch.mock.results.map(result => result.value))
  expect(f.dispatch.mock.calls.slice(third).every(([id]) => !terminal.some(record => record.ingressId === id))).toBe(true)
  expect((await f.cli(['inspect', '--connection', feishuConfig.connectionId])).connection.observation.transport.state).toBe('ready')
  expect((await f.list()).filter(record => record.state === 'received')).toHaveLength(25)
  expect(f.sdk.ack()).toHaveLength(30)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)
