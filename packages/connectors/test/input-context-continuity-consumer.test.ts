import { afterEach, expect, it, vi } from 'vitest'
import { channelContextFixture } from './fixtures/channel-context.js'
import type { RoomBindingScope } from '@agentmux/core/connections'
import { ingressFixture } from './fixtures/ingress.js'
import { config, context } from './fixtures/room-binding.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function trigger(f: Awaited<ReturnType<typeof channelContextFixture>>, revision: number, input: RoomBindingScope['input']) {
  const result = await f.rpc.call('connection.binding.relink', { ...f.binding, operationId: 'trigger-' + revision,
    expectedRevision: revision, scope: { input, publication: 'future-shared-conversation' } })
  expect(result).toMatchObject({ state: 'applied', binding: { revision: revision + 1, publicationBoundary: { revision: 1 } } })
}

it('authenticated intake freezes its original publication target before claim and keeps intake usable when only that optional root observation fails', async () => {
  const f = await ingressFixture(true, config, undefined, { publication: 'future-shared-conversation' }); cleanup.push(f.close)
  expect(await f.bindings.relink({ ...f.input, operationId: 'first-trigger-before-intake', expectedRevision: 1,
    scope: { input: 'all-messages', publication: 'future-shared-conversation' } }, context)).toMatchObject({ state: 'applied' })
  const first = await f.receive({ conversationKind: 'group' })
  expect(first.ingress).toMatchObject({ state: 'received', group: { target: { bindingRevision: 2, publicationRevision: 1 } } })
  expect(first.ingress.input).toBeUndefined()
  const exact = f.bindings.readExact.bind(f.bindings)
  vi.spyOn(f.bindings, 'readExact').mockImplementation((id, revision) => { if (revision === 1) throw Error('Optional original row temporarily unreadable'); return exact(id, revision) })
  const second = await f.receive({ conversationKind: 'group', eventId: 'independent-intake', messageId: 'independent-message' })
  expect(second.ingress).toMatchObject({ state: 'received', group: { target: { bindingRevision: 2 } } })
  expect(second.ingress.group!.target!.publicationRevision).toBeUndefined()
  expect(second.ingress.input).toBeUndefined(); expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it.each(['feishu', 'discord'] as const)('default %s ingress retains the original accepted quote position through both trigger directions and reopen', async channel => {
  const f = await channelContextFixture(cleanup, 'native', false, channel)
  const run = f.client.agentSession('original-agent').run
  // The first intake is after the first edit: its unclaimed root must already be frozen/indexed.
  await trigger(f, 1, 'all-messages')
  const first = await f.receive('1100', 1100, 'First original request after configuration edit')
  const accepted = await f.wait(first.ingressId, 'admitted')
  expect(accepted.ingress!.group!.target).toMatchObject({ bindingRevision: 2, publicationRevision: 1 })
  expect(accepted.ingress!.input!.author.bindingRevision).toBe(2)
  expect(accepted.context).toMatchObject({ coverage: 'complete', positionMessageId: '1100', observation: 'observed' })
  expect(accepted.ingress!.input!.channelQuote!.range).toEqual({ from: { messageId: '1100', inclusive: true }, throughMessageId: '1100', origin: 'first-observed' })
  const originalInput = structuredClone(accepted.ingress!.input)
  f.addHistory('1200', 1200, 'Unseen original context between requests')
  await trigger(f, 2, 'mentions-and-replies')
  const second = await f.receive('1300', 1300, 'Second exact original request'), observed = await f.wait(second.ingressId, 'admitted')
  expect(observed.ingress!.input!.channelQuote!.range).toEqual({ from: { messageId: '1100', inclusive: false }, throughMessageId: '1300', origin: 'admitted-input' })
  expect(observed.ingress!.input!.channelQuote!.records.map(record => record.messageId)).toEqual(['1200'])
  expect(observed.ingress!.input!.author.bindingRevision).toBe(3)
  f.addHistory('1400', 1400, 'Another unseen original context')
  await trigger(f, 3, 'all-messages')
  const third = await f.receive('1500', 1500, 'Third exact original request'), latest = await f.wait(third.ingressId, 'admitted')
  expect(latest.ingress!.input!.channelQuote!.range).toEqual({ from: { messageId: '1300', inclusive: false }, throughMessageId: '1500', origin: 'admitted-input' })
  expect(latest.ingress!.input!.channelQuote!.records.map(record => record.messageId)).toEqual(['1400'])
  expect(latest.ingress!.input!.author.bindingRevision).toBe(4)
  await f.reopen()
  expect((await f.inspect(third.ingressId)).context?.positionMessageId).toBe('1500')
  expect((await f.inspect(first.ingressId)).ingress!.input).toEqual(originalInput)
  expect(f.nativeSend).toHaveBeenCalledTimes(3)
  const cli = await f.cli(['connection', 'ingress', 'inspect', '--ingress', third.ingressId])
  expect(cli.ingress.group.target).toMatchObject({ bindingRevision: 4, publicationRevision: 1 })
  expect(cli.context.positionMessageId).toBe('1500')
  // A real paused interval gets its own baseline; it does not borrow the old root's position.
  expect(await f.rpc.call('connection.binding.pause', { operationId: 'pause-original', bindingId: f.binding.bindingId, expectedRevision: 4 })).toMatchObject({ state: 'applied' })
  expect(await f.rpc.call('connection.binding.resume', { operationId: 'resume-original', bindingId: f.binding.bindingId, expectedRevision: 5 })).toMatchObject({ state: 'applied', binding: { revision: 6 } })
  const resumed = await f.receive('1700', 1700, 'Original request after the paused interval'), resumedReceipt = await f.wait(resumed.ingressId, 'admitted')
  expect(resumedReceipt.ingress!.group!.target).toMatchObject({ bindingRevision: 6, publicationRevision: 6 })
  expect(resumedReceipt.ingress!.input!.channelQuote!.range).toEqual({ from: { messageId: '1700', inclusive: true }, throughMessageId: '1700', origin: 'first-observed' })
  expect(resumedReceipt.ingress!.input!.channelQuote!.records).toEqual([])
  expect(f.client.agentSession('original-agent').run).toEqual(run)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 45_000)

it('a late actual native receipt remains historical after current revocation and is retained through owner reopen', async () => {
  const f = await channelContextFixture(cleanup)
  const originalSend = f.nativeSend.getMockImplementation()!
  let release!: () => void, started!: () => void
  const sent = new Promise<void>(resolve => { started = resolve }), held = new Promise<void>(resolve => { release = resolve })
  f.nativeSend.mockImplementation(async (...args) => { const result = await originalSend(...args); started(); await held; return result })
  const received = await f.receive('1100', 1100, 'Original native effect before revocation')
  await sent
  const original = (await f.inspect(received.ingressId)).ingress!.input!
  await trigger(f, 1, 'all-messages')
  expect(await f.rpc.call('connection.grant', { operationId: 'revoke-after-native-effect', grantId: 'context-member', bindingId: f.binding.bindingId,
    expectedBindingRevision: 2, expectedRevision: 1, actor: f.actor, capabilities: [], state: 'revoked' })).toMatchObject({ state: 'applied' })
  release()
  const receipt = await f.wait(received.ingressId, 'admitted')
  expect(receipt.ingress!.input).toEqual(original)
  expect(receipt.context).toMatchObject({ positionMessageId: '1100', observation: 'observed' })
  await f.reopen()
  expect((await f.inspect(received.ingressId)).context?.positionMessageId).toBe('1100')
  expect((await f.services.ingress!.authority({ operationId: original.operationId })).authority).toBe('refused')
  expect(f.nativeSend).toHaveBeenCalledOnce(); expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 35_000)
