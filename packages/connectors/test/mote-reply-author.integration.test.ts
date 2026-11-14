import { expect, it, vi } from 'vitest'
import { connectAgentMuxRpc } from '@agentmux/core'
import { moteChatJourneyFixture } from './fixtures/mote-chat-journey.js'
import { feishuCardElements } from './fixtures/feishu-publication.js'
import { publicationPlainText } from '../src/publication-plain-text.js'

const fixture = (protocol: 'feishu' | 'signed-room' = 'feishu') => moteChatJourneyFixture(4, 60_000, 'headless', false, 'grok', undefined, 'bound', protocol)
async function received(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  expect(await f.wire.post(f.message(id))).toBe(202)
  const source = await f.claimed(id)
  await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: source.ingressId })).inputReceipt?.status).toBe('terminal-confirmed'))
  return source
}
it.each(['feishu', 'signed-room'] as const)('the authenticated original reply freezes its Agent author through the %s public consumer', async protocol => {
  const f = await fixture(protocol), source = await received(f, 'authored-source')
  const named = await f.spatial.mutateDisplayLabel({ target: { kind: 'agent-session', id: 'original-main' }, operationId: 'original-display-name', value: 'Follow up the original request', expectedNameRevision: 0, source: 'derived' },
    { actor: { kind: 'agent', id: 'original-main', verified: true }, source: 'derived', entryPoint: 'author-test-original-name', transport: 'unix', location: {} })
  expect(named.diskDurability).toBe('confirmed')
  const request = { operationId: 'authored-reply', ingressId: source.ingressId, body: 'The concrete original answer. '.repeat(protocol === 'signed-room' ? 500 : 1).trimEnd() }
  const result = await f.cli('reply', request, f.credentials(0))
  await vi.waitFor(() => expect(protocol === 'feishu' ? f.feishu!.messageCalls().length : f.wire.effects.length).toBe(result.operation.deliveryOperationIds.length))
  const operations = result.operation.deliveryOperationIds.map((id: string) => f.services.publication!.store.inspect(id)!)
  expect(operations.length).toBeGreaterThan(0)
  for (const op of operations) {
    expect(op.speaker).toMatchObject({ kind: 'agent', reference: { hostId: source.input!.hostId, agentSessionId: 'original-main' }, name: 'Follow up the original request' })
    expect(publicationPlainText(op)).toContain('Follow up the original request · Agent')
    expect(publicationPlainText(op)).not.toContain('Unknown author')
  }
  if (protocol === 'feishu') {
    const body = JSON.parse(f.feishu!.messageCalls()[0]!.body), card = JSON.parse(body.content)
    expect(feishuCardElements(card)[0].text.content).toBe('Follow up the original request · Agent')
    expect(JSON.stringify(card)).toContain(request.body)
  } else expect(f.wire.effects.map(effect => effect.text).join('')).toBe(request.body)
  const frozen = structuredClone(operations)
  await f.restart()
  expect((await f.cli('reply', request, f.credentials(0))).operation).toEqual(result.operation)
  expect(result.operation.deliveryOperationIds.map((id: string) => f.services.publication!.store.inspect(id)!.speaker)).toEqual(frozen.map(op => op.speaker))
  expect(protocol === 'feishu' ? f.feishu!.messageCalls().filter(call => call.method === 'POST').length : f.wire.effects.length).toBe(operations.length)
})
it('optional display failure preserves known authorship and never borrows a later Main', async () => {
  const f = await fixture('signed-room'), source = await received(f, 'no-profile-source')
  const options = Reflect.get(f.services.publication!, 'options')
  vi.spyOn(options, 'speaker').mockRejectedValue(Error('Original optional metadata unavailable'))
  await f.bindMain('replacement-main')
  const request = { operationId: 'reply-from-original', ingressId: source.ingressId, body: 'Same original Agent answers.' }
  const result = await f.cli('reply', request, f.credentials(0))
  await vi.waitFor(() => expect(f.wire.effects).toHaveLength(1))
  expect(f.services.publication!.store.inspect(result.operation.deliveryOperationIds[0])?.speaker).toEqual({ kind: 'agent', reference: { hostId: source.input!.hostId, agentSessionId: 'original-main' } })
  const sdk = await connectAgentMuxRpc({ endpoint: f.endpoint, credentials: f.credentials(1) })
  try { await expect(sdk.call('space.mote.chat.reply', { ...request, operationId: 'wrong-original-author' })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' }) }
  finally { await sdk.dispose() }
  expect(f.wire.effects).toHaveLength(1)
})
it('an unknown original reply retains its frozen author across restart without another dispatch or metadata read', async () => {
  const f = await fixture('signed-room'), source = await received(f, 'unknown-author-source')
  const adapter = f.wire.adapter.publication!, dispatch = adapter.dispatch.bind(adapter), inspect = adapter.inspect!.bind(adapter)
  let readable = false
  const sent = vi.spyOn(adapter, 'dispatch').mockImplementation(async (...args) => { await dispatch(...args); throw Error('Original ACK lost') })
  vi.spyOn(adapter, 'inspect').mockImplementation(async (...args) => readable ? await inspect(...args) : null)
  const request = { operationId: 'original-unknown-author', ingressId: source.ingressId, body: 'Only this original authored reply.' }
  const result = await f.cli('reply', request, f.credentials(0))
  await vi.waitFor(async () => expect((await f.cli('inspect', { operationId: request.operationId }, f.credentials(0))).deliveries).toMatchObject([{ state: 'unknown' }]))
  const author = structuredClone(f.services.publication!.store.inspect(result.operation.deliveryOperationIds[0])!.speaker)
  expect(author).toMatchObject({ kind: 'agent', reference: { hostId: source.input!.hostId, agentSessionId: 'original-main' } })
  await f.restart()
  const metadata = vi.spyOn(Reflect.get(f.services.publication!, 'options'), 'speaker').mockRejectedValue(Error('Must not reread retained author'))
  expect((await f.cli('reply', request, f.credentials(0))).operation).toEqual(result.operation)
  expect(metadata).not.toHaveBeenCalled()
  readable = true; f.services.publication!.refresh()
  await vi.waitFor(async () => expect((await f.cli('inspect', { operationId: request.operationId }, f.credentials(0))).deliveries).toMatchObject([{ state: 'confirmed' }]))
  expect(f.services.publication!.store.inspect(result.operation.deliveryOperationIds[0])!.speaker).toEqual(author)
  expect(sent).toHaveBeenCalledOnce(); expect(f.wire.effects).toHaveLength(1)
})
