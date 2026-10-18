import { afterEach, expect, it, vi } from 'vitest'
import { ConnectionReceivers, DurableIngressHost } from '../dist/index.js'
import { DurableAgentMuxMessageQueue } from '../../core/dist/index.js'
import { parseConnectionIngressRecord } from '@agentmux/core/connections'
import { FeishuAdapter } from '@agentmux/connectors/adapters/feishu'
import { ingressFixture } from './fixtures/ingress.js'
import { feishuConfig, feishuPayload, feishuSdkTransport } from './fixtures/feishu.js'
import { context } from './fixtures/room-binding.js'

const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture() {
  const transport = feishuSdkTransport(), adapter = new FeishuAdapter({ http: transport.http })
  const target = { ...feishuConfig, connectionId: 'target-application-alias' }
  const f = await ingressFixture(true, target, { resolve: async () => 'controlled-alias-credential' }, { adapters: [adapter] })
  cleanup.push(f.close)
  await f.connections.configure({ operationId: 'configure-receiver-alias', expectedRevision: null, connection: feishuConfig })
  const ingress = new DurableIngressHost({ ...f.options, authenticators: [adapter] }); f.connections.ingress = ingress
  const receivers = new ConnectionReceivers(f.connections, ingress); cleanup.push(() => receivers.close())
  await vi.waitFor(() => expect(transport.sockets).toHaveLength(1))
  await vi.waitFor(async () => expect((await f.connections.inspect({ connectionId: feishuConfig.connectionId })).connection?.observation.transport.state).toBe('ready'))
  async function intake(eventId = 'alias-original-event', messageId = 'alias-original-message') {
    const payload = feishuPayload({ message_id: messageId }); payload.header.event_id = eventId
    await transport.receive(payload, transport.sockets[0]!)
    const record = (await ingress.list({ connectionId: feishuConfig.connectionId })).ingresses.find(item => item.kind !== 'action' && item.externalMessageId === messageId)!
    expect(record, 'the original SDK receiver durably retained the event').toBeDefined()
    return record
  }
  const receive = async (eventId?: string, messageId?: string) => ingress.dispatch((await intake(eventId, messageId)).ingressId)
  return { ...f, ingress, receivers, target, transport, adapter, intake, receive }
}

it('routes a verified application event from its original receiver alias to the exact bound alias and Core input once', async () => {
  const f = await fixture(), delivery = f.receive()
  await expect(delivery, 'an authenticated alias route must survive the original strict record codec').resolves.toMatchObject({ ingress: { state: 'claimed' } })
  const result = await delivery
  expect(result.ingress?.state, JSON.stringify({ state: result.ingress?.state, code: result.ingress?.code, receiver: result.ingress?.connectionId, bindingConnection: f.target.connectionId })).toBe('claimed')
  expect(result.ingress).toMatchObject({ connectionId: feishuConfig.connectionId, state: 'claimed', application: feishuConfig.application,
    input: { hostId: 'local', agentSessionId: 'original-agent', expectedRun: f.session.run,
      author: { connectionId: f.target.connectionId, bindingId: f.input.bindingId, bindingRevision: 1, grantId: f.grant.grantId, actor: f.actor } } })
  await expect.poll(async () => (await f.ingress.inspect({ ingressId: result.ingress!.ingressId })).inputReceipt?.status).toBe('terminal-confirmed')
  const queued = await new DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath()).readByOperationId(result.ingress!.input!.operationId)
  expect(queued!.envelope.sender).toEqual(result.ingress!.input!.author)
  expect(queued!.envelope.body).toBe(result.ingress!.body)
  expect(parseConnectionIngressRecord(result.ingress)).toEqual(result.ingress)
  const record = result.ingress!, input = record.input!, author = input.author
  for (const foreign of [
    { actor: { ...author.actor, userId: 'another-member' } },
    { actor: { ...author.actor, application: { ...author.actor.application, appId: 'another-application' } } },
    { externalConversationId: 'another-room' }, { externalMessageId: 'another-message' }
  ]) expect(() => parseConnectionIngressRecord({ ...record, input: { ...input, author: { ...author, ...foreign } } })).toThrow()
  expect(() => parseConnectionIngressRecord({ ...record, input: { ...input, expectedRun: { runId: 'another-run' } } })).toThrow()
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(1)
  const duplicate = await f.receive()
  expect(duplicate.ingress).toEqual(result.ingress)
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(1)
  expect(f.transport.sockets).toHaveLength(1)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it.each(['source', 'target'] as const)('refuses a retained alias intake when the %s configuration is disabled, without stopping the original Agent', async side => {
  const f = await fixture(), record = await f.intake()
  f.receivers.close() // Freeze the scheduler after the real SDK ACK; policy changes precede the original dispatch.
  expect(record.state).toBe('received')
  const connection = side === 'source' ? feishuConfig : f.target
  expect((await f.connections.configure({ operationId: 'disable-alias', expectedRevision: 1, connection: { ...connection, enabled: false } })).status).toBe('configured')
  const result = await f.ingress.dispatch(record.ingressId)
  expect(result.ingress).toMatchObject({ connectionId: feishuConfig.connectionId, state: 'refused', code: 'INGRESS_CONNECTION_UNAVAILABLE' })
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  await f.client.submitAgentPrompt({ agentSessionId: f.input.agentSessionId, expectedRun: f.session.run, operationId: 'local-input-after-disabled-alias', prompt: 'The original local input still works', admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', authorHuman: true })
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it.each(['source', 'target'] as const)('requires the current %s alias configuration to describe the original native application', async side => {
  const f = await fixture(), record = await f.intake()
  f.receivers.close()
  expect(record.state).toBe('received')
  const read = f.connections.readConfiguration.bind(f.connections), connectionId = side === 'source' ? feishuConfig.connectionId : f.target.connectionId
  // A changed owner observation is controlled at its read port; no invalid configuration is installed.
  vi.spyOn(f.connections, 'readConfiguration').mockImplementation(id => {
    const value = read(id)
    return id === connectionId && value ? { ...value, config: { ...value.config, application: { ...value.config.application, appId: 'foreign-application' } } } : value
  })
  expect((await f.ingress.dispatch(record.ingressId)).ingress).toMatchObject({ state: 'refused', code: 'INGRESS_CONNECTION_UNAVAILABLE' })
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('selects only the exact active native audience and never borrows a paused or foreign audience', async () => {
  const f = await fixture(), audience = { application: feishuConfig.application, externalConversationId: f.input.externalConversationId }
  expect(f.bindings.findActiveAudience(audience)?.connectionId).toBe(f.target.connectionId)
  for (const foreign of [
    { ...audience, application: { ...audience.application, domain: 'open.larksuite.com' } },
    { ...audience, application: { ...audience.application, appId: 'foreign-application' } },
    { ...audience, externalConversationId: 'foreign-group' }
  ]) expect(f.bindings.findActiveAudience(foreign)).toBeNull()
  expect(await f.bindings.pause({ operationId: 'pause-target-binding', bindingId: f.input.bindingId, expectedRevision: 1 }, context)).toMatchObject({ state: 'applied' })
  expect(f.bindings.findActiveAudience(audience)).toBeNull()
  expect((await f.receive()).ingress).toMatchObject({ state: 'refused', code: 'INGRESS_BINDING_UNAVAILABLE' })
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('keeps a revoked target grant refusal original after authorization returns; only a new event can enter Core', async () => {
  const f = await fixture()
  expect(await f.bindings.grant({ ...f.grant, operationId: 'revoke-target-grant', expectedRevision: 1, state: 'revoked' }, context)).toMatchObject({ state: 'applied' })
  const refused = await f.receive()
  expect(refused.ingress).toMatchObject({ connectionId: feishuConfig.connectionId, state: 'refused', code: 'INGRESS_ACTOR_NOT_AUTHORIZED' })
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect(await f.bindings.grant({ ...f.grant, operationId: 'restore-target-grant', expectedRevision: 2 }, context)).toMatchObject({ state: 'applied' })
  expect((await f.receive()).ingress).toEqual(refused.ingress)
  const restarted = new DurableIngressHost({ ...f.options, authenticators: [f.adapter] })
  expect((await restarted.dispatch(refused.ingress!.ingressId)).ingress).toEqual(refused.ingress)
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  const later = await f.receive('new-authorized-event', 'new-authorized-message')
  expect(later.ingress).toMatchObject({ state: 'claimed', input: { author: { connectionId: f.target.connectionId, grantRevision: 3 } } })
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
})

it('requires a current target grant after the original Binding is revised', async () => {
  const f = await fixture()
  expect(await f.bindings.relink({ ...f.input, operationId: 'revise-target-binding', expectedRevision: 1 }, context)).toMatchObject({ state: 'applied', binding: { revision: 2 } })
  const result = await f.receive()
  expect(result.ingress).toMatchObject({ state: 'refused', code: 'INGRESS_ACTOR_NOT_AUTHORIZED' })
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('retains a claimed alias event with an unknown Core result without submitting it again', async () => {
  const f = await fixture(), submit = vi.spyOn(f.client, 'submitAgentMessage').mockRejectedValue(new Error('Controlled loss before the original Core receipt'))
  const unknown = await f.receive()
  expect(unknown).toMatchObject({ ingress: { state: 'claimed', connectionId: feishuConfig.connectionId, input: { author: { connectionId: f.target.connectionId } } }, inputReceipt: null })
  const restarted = new DurableIngressHost({ ...f.options, authenticators: [f.adapter] })
  expect((await restarted.dispatch(unknown.ingress!.ingressId)).ingress).toEqual(unknown.ingress)
  expect((await f.receive()).ingress).toEqual(unknown.ingress)
  expect(submit).toHaveBeenCalledOnce()
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
