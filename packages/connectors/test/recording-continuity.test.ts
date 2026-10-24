import { afterEach, expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import { channelContextFixture } from './fixtures/channel-context.js'
import { cleanup, groupConversationFixture } from './helpers/group-conversation-fixture.js'

afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function fixture(shape: 'feishu' | 'signed') {
  if (shape === 'signed') {
    const f = await groupConversationFixture()
    return { ...f, get rpc() { return f.rpc }, get services() { return f.services }, receiveOriginal: () => f.receive(),
      captured: f.captured, outbound: () => JSON.stringify(f.wire.effects), body: 'Original group message' }
  }
  const f = await channelContextFixture(cleanup, 'native', true)
  return { ...f, get rpc() { return f.rpc }, get services() { return f.services },
    receiveOriginal: () => f.receive('retained-original', 1000, 'Original ordinary Feishu speech', false),
    captured: async () => (await f.store.readCapturedHistory('original-agent')).records.filter(record => record.item.authorExternal),
    outbound: () => f.remote!.messageCalls().filter(call => call.method === 'POST').map(call => call.body).join('\n'),
    body: 'Original ordinary Feishu speech' }
}

it.each(['feishu', 'signed'] as const)('a retained %s recording recovers once across a trigger edit without granting old intake', async shape => {
  const f = await fixture(shape), submit = vi.spyOn(f.client, 'submitAgentMessage')
  const hold = vi.spyOn(f.client, 'recordExternalConversationMessage').mockRejectedValue(new core.AgentMuxError('Original recording owner temporarily unavailable', 'EXTERNAL_RECORD_AUTHORITY_UNAVAILABLE'))
  const received = await f.receiveOriginal()
  await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: received.ingressId })).ingress).toMatchObject({
    state: 'refused', group: { target: { bindingRevision: 1 }, recording: { state: 'unavailable' } }
  }), { timeout: 8_000 })
  expect(await f.captured()).toHaveLength(0)
  await f.services.ingress!.dispatch(received.ingressId)
  const changed = await f.rpc.call('connection.binding.relink', { ...f.binding, operationId: 'only-trigger-edit', expectedRevision: 1,
    scope: { input: 'all-messages', publication: 'future-shared-conversation' } })
  expect(changed).toMatchObject({ state: 'applied', binding: { revision: 2, publicationBoundary: { revision: 1 } } })
  hold.mockRestore()
  let recovered = await f.services.ingress!.inspect({ ingressId: received.ingressId })
  await vi.waitFor(async () => {
    recovered = await f.services.ingress!.dispatch(received.ingressId)
    const page = await f.rpc.call('agent.conversation.inspect', { hostId: 'local', agentSessionId: 'original-agent' })
    expect(JSON.stringify(page), JSON.stringify(recovered.ingress)).toContain(f.body)
  }, { timeout: 8_000 })
  const captures = await f.captured()
  expect(captures).toHaveLength(1)
  expect(captures[0]!.item).toMatchObject({ content: f.body, authorExternal: { bindingRevision: 1 } })
  expect(captures[0]!.item.inputRef).toBeUndefined()
  expect(recovered.ingress).toMatchObject({ state: 'refused', group: { recorded: { ingressId: received.ingressId }, target: { bindingRevision: 1 } } })
  expect(recovered.ingress!.input).toBeUndefined()
  const originalRecord = captures[0]!.item.id
  await f.services.ingress!.dispatch(received.ingressId)
  await f.reopen()
  await f.services.ingress!.dispatch(received.ingressId)
  expect((await f.captured()).map(record => record.item.id)).toEqual([originalRecord])
  await vi.waitFor(async () => expect((await f.services.publication!.list({ connectionId: f.config.connectionId,
    bindingId: f.binding.bindingId, bindingRevision: 1 })).coverage?.origins).toHaveLength(1), { timeout: 8_000 })
  expect(f.outbound()).not.toContain(f.body)
  expect(submit).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30_000)

it('an original unavailable recording cannot borrow a paused and resumed boundary', async () => {
  const f = await fixture('signed')
  const hold = vi.spyOn(f.client, 'recordExternalConversationMessage').mockRejectedValue(new core.AgentMuxError('Original recording owner temporarily unavailable', 'EXTERNAL_RECORD_AUTHORITY_UNAVAILABLE'))
  const received = await f.receiveOriginal()
  await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: received.ingressId })).ingress).toMatchObject({ state: 'refused', group: { recording: { state: 'unavailable' } } }))
  await f.services.ingress!.dispatch(received.ingressId)
  expect(await f.rpc.call('connection.binding.pause', { operationId: 'pause-original-recording', bindingId: f.binding.bindingId, expectedRevision: 1 })).toMatchObject({ state: 'applied' })
  expect(await f.rpc.call('connection.binding.resume', { operationId: 'resume-original-recording', bindingId: f.binding.bindingId, expectedRevision: 2 })).toMatchObject({ state: 'applied' })
  hold.mockRestore()
  expect(await f.rpc.call('connection.ingress.record-authority', { agentSessionId: 'original-agent', ingressId: received.ingressId })).toMatchObject({
    authority: 'refused', code: 'INGRESS_BINDING_UNAVAILABLE'
  })
  const original = await f.services.ingress!.dispatch(received.ingressId)
  expect(original.ingress, JSON.stringify(original.ingress)).toMatchObject({ group: { target: { bindingRevision: 1 } } })
  expect(original.ingress!.kind === 'action' ? null : original.ingress!.group?.recorded).toBeUndefined()
  expect(await f.captured()).toHaveLength(0)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
