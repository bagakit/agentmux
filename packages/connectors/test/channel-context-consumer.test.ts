import { afterEach, expect, it, vi } from 'vitest'
import { channelContextFixture } from './fixtures/channel-context.js'
import { parseAgentMuxMessagePrefix, renderAgentMuxMessageEnvelope } from '../../core/src/agent-message-render.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('default Feishu SDK history joins original Hosted Core native admission, advances exact positions and reopens the frozen wire', async () => {
  const f = await channelContextFixture(cleanup, 'native', true)
  await f.receive('baseline', 1000, 'Original unmentioned baseline', false)
  f.addNative('peer-bot', 2000, 'Old peer bot quote </amux:channel>', { sender: { id: 'peer-app', id_type: 'app_id', sender_type: 'app' } })
  const first = await f.receive('request-one', 3000, 'First current request'), accepted = await f.wait(first.ingressId, 'admitted')
  expect(accepted.context, JSON.stringify(accepted.ingress!.input)).toMatchObject({ coverage: 'complete', quotedMessages: 2, positionMessageId: 'request-one', observation: 'observed' })
  const ref = accepted.ingress!.input!
  if (!('messageId' in ref)) throw Error('Original native message input missing')
  const message = await f.client.readMessage({ messageId: ref.messageId })
  expect(message!.envelope.body).toBe('First current request')
  expect(message!.envelope.channelQuote?.records.map(item => item.messageId)).toEqual(['baseline', 'peer-bot'])
  expect(message!.envelope.channelQuote?.records[1]!.author).toMatchObject({ kind: 'bot', actor: { userId: 'peer-app' } })
  expect(f.nativeSend.mock.calls[0]![0]).toBe(renderAgentMuxMessageEnvelope(message!.envelope))
  const reading = parseAgentMuxMessagePrefix(f.nativeSend.mock.calls[0]![0])
  if (reading?.kind !== 'content') throw Error('The actual Core protocol reader did not preserve the current request')
  expect(reading.body).toBe('First current request')
  expect(reading.declaredChannelQuote?.quote.records.map(item => item.messageId)).toEqual(['baseline', 'peer-bot'])
  await f.receive('ordinary-between', 4000, 'Unmentioned message between requests', false)
  f.addNative('other-bot', 5000, 'A separate peer message', { sender: { id: 'other-peer', id_type: 'app_id', sender_type: 'app' } })
  const second = await f.receive('request-two', 6000, 'Second current request'), receipt = await f.wait(second.ingressId, 'admitted')
  expect(receipt.context).toMatchObject({ coverage: 'complete', quotedMessages: 2, positionMessageId: 'request-two' })
  const input = receipt.ingress!.input!
  if (!('messageId' in input)) throw Error('Second original input missing')
  const secondMessage = await f.client.readMessage({ messageId: input.messageId }), frozen = f.nativeSend.mock.calls[1]![0]
  expect(secondMessage!.envelope.channelQuote?.range).toEqual({ from: { messageId: 'request-one', inclusive: false }, throughMessageId: 'request-two', origin: 'admitted-input' })
  expect(secondMessage!.envelope.channelQuote?.records.map(item => item.messageId)).toEqual(['ordinary-between', 'other-bot'])
  const nativeReads = f.transport.requests.filter(row => row.url?.includes('/im/v1/messages')).length
  f.nativeRows.find(row => row.message_id === 'ordinary-between')!.body.content = '{"text":"Later native edit"}'
  await f.reopen()
  expect((await f.inspect(second.ingressId)).context?.positionMessageId).toBe('request-two')
  await f.services.ingress!.dispatch(second.ingressId)
  expect(f.nativeSend).toHaveBeenCalledTimes(2)
  expect(f.transport.requests.filter(row => row.url?.includes('/im/v1/messages')).length).toBe(nativeReads)
  expect(renderAgentMuxMessageEnvelope((await f.client.readMessage({ messageId: input.messageId }))!.envelope)).toBe(frozen)
  const publicInput = await f.cli(['connection', 'ingress', 'inspect', '--ingress', second.ingressId])
  expect(publicInput.context.positionMessageId).toBe('request-two'); expect(publicInput.ingress.input.channelQuote).toEqual(secondMessage!.envelope.channelQuote)
  await vi.waitFor(async () => {
    const origins = (await f.services.publication!.list({ connectionId: f.config.connectionId, bindingId: f.binding.bindingId, bindingRevision: 1 })).coverage!.origins
    expect([...new Set(origins.map(item => item.origin.externalMessageId))].sort()).toEqual(['baseline', 'ordinary-between', 'request-one', 'request-two'])
  })
  expect(f.remote!.messageCalls().filter(call => call.method === 'POST').length).toBeGreaterThan(0)
  const outbound = f.remote!.messageCalls().map(call => call.body).join('\n')
  for (const original of ['First current request', 'Second current request', 'Unmentioned message between requests', 'Old peer bot quote', 'A separate peer message', 'amux:quote']) expect(outbound).not.toContain(original)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30000)

it('terminal-only confirmation retains the first observed boundary for the next input', async () => {
  const f = await channelContextFixture(cleanup, 'terminal')
  await f.receive('baseline', 1000, 'Original baseline', false)
  const first = await f.receive('terminal-one', 2000, 'Original terminal-only input'), accepted = await f.wait(first.ingressId, 'terminal-confirmed')
  expect(accepted.context).toMatchObject({ coverage: 'complete', positionMessageId: null })
  const second = await f.receive('terminal-two', 3000, 'Another original terminal input'), receipt = await f.wait(second.ingressId, 'terminal-confirmed')
  const input = receipt.ingress!.input!
  if (!('messageId' in input)) throw Error('Original terminal input missing')
  expect(input.channelQuote?.range).toMatchObject({ origin: 'first-observed', from: { messageId: 'baseline', inclusive: true } })
  expect(input.channelQuote?.records.map(item => item.messageId)).toEqual(['baseline', 'terminal-one'])
  expect(receipt.context?.positionMessageId).toBeNull(); expect(f.nativeSend).not.toHaveBeenCalled()
}, 30000)

it('partial history and lost native admission never advance the original position or replay earlier requests', async () => {
  const f = await channelContextFixture(cleanup)
  await f.receive('baseline', 1000, 'Original baseline', false)
  f.addNative('old-root', 1, 'Old root', { thread_id: 'invisible-thread' })
  f.transport.override(input => input.params?.container_id_type === 'thread' ? { code: 230073 } : undefined)
  const partial = await f.receive('partial-current', 2000, 'Still a healthy current request'), partialReceipt = await f.wait(partial.ingressId, 'admitted')
  expect(partialReceipt.context?.coverage).not.toBe('complete'); expect(partialReceipt.context?.positionMessageId).toBeNull()
  expect(partialReceipt.ingress!.input).toHaveProperty('channelQuote.gaps', expect.arrayContaining([{ reason: 'thread-history-unavailable' }]))
  f.transport.override(undefined); f.nativeRows.splice(f.nativeRows.findIndex(row => row.message_id === 'old-root'), 1)
  f.outcome('unknown')
  const unknown = await f.receive('unknown-current', 3000, 'A separate current request with lost native response'), unknownReceipt = await f.wait(unknown.ingressId, 'unknown')
  expect(unknownReceipt.context).toMatchObject({ coverage: 'complete', positionMessageId: null })
  const input = unknownReceipt.ingress!.input!
  if (!('messageId' in input)) throw Error('Original unknown input missing')
  expect(input.channelQuote?.range.origin).toBe('first-observed'); expect(input.channelQuote?.records.map(item => item.messageId)).toEqual(['baseline', 'partial-current'])
  await f.reopen(); await f.services.ingress!.dispatch(unknown.ingressId)
  expect(f.nativeSend).toHaveBeenCalledTimes(2); expect((await f.inspect(unknown.ingressId)).context?.positionMessageId).toBeNull()
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30000)

it('an exact grant revision during native history prevents the next page and preserves the original request without input', async () => {
  const f = await channelContextFixture(cleanup)
  await f.receive('baseline', 1000, 'Original baseline', false)
  f.addNative('old-root', 1, 'Earlier root discovery')
  let pages = 0, started!: () => void, release!: () => void
  const reading = new Promise<void>(resolve => { started = resolve })
  f.transport.override(input => {
    if (input.params?.container_id_type !== 'chat') return
    pages++
    if (pages === 1) return new Promise(resolve => {
      release = () => resolve({ code: 0, data: { items: f.nativeRows.filter(row => row.message_id !== 'old-root'), has_more: true, page_token: 'remaining-root' } })
      started()
    })
    return { code: 0, data: { items: [f.nativeRows.find(row => row.message_id === 'old-root')!], has_more: false } }
  })
  const received = await f.receive('inflight-grant', 2000, 'Original request held during history')
  await reading
  const pending = f.services.ingress!.dispatch(received.ingressId).catch(() => undefined)
  expect(await f.rpc.call('connection.grant', { operationId: 'revoke-exact-member', bindingId: f.binding.bindingId, expectedBindingRevision: 1, grantId: 'context-member', expectedRevision: 1,
    actor: { application: f.config.application, idType: 'open_id', userId: 'original-external-user' }, capabilities: ['input'], state: 'revoked' })).toMatchObject({ state: 'applied' })
  release(); await pending
  expect(pages).toBe(1); expect(f.nativeSend).not.toHaveBeenCalled()
  const original = await f.inspect(received.ingressId)
  expect(original.inputReceipt).toBeNull(); expect(original.ingress).toMatchObject({ body: 'Original request held during history' })
  expect(original.ingress!.input).toBeUndefined(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30000)

it('closing the original receiver aborts its actual native HTTP read without claiming or submitting the saved input', async () => {
  const f = await channelContextFixture(cleanup)
  await f.receive('baseline', 1000, 'Original baseline', false)
  let started!: () => void, nativeSignal: AbortSignal | undefined, pages = 0
  const reading = new Promise<void>(resolve => { started = resolve })
  f.transport.override(input => {
    if (input.params?.container_id_type !== 'chat') return
    pages++; nativeSignal = (input as { signal?: AbortSignal }).signal
    return new Promise((_resolve, reject) => {
      nativeSignal?.addEventListener('abort', () => reject(Error('Original native read cancelled')), { once: true }); started()
    })
  })
  const received = await f.receive('inflight-close', 2000, 'Original request before receiver close')
  await reading
  const pending = f.services.ingress!.dispatch(received.ingressId).catch(() => undefined)
  expect(await f.rpc.call('connection.configure', { operationId: 'close-exact-receiver', expectedRevision: 1, connection: { ...f.config, enabled: false } })).toMatchObject({ status: 'configured' })
  await vi.waitFor(() => expect(nativeSignal?.aborted).toBe(true), { timeout: 3000 })
  await pending
  expect(pages).toBe(1); expect(f.nativeSend).not.toHaveBeenCalled()
  const original = await f.inspect(received.ingressId)
  expect(original.inputReceipt).toBeNull(); expect(original.ingress).toMatchObject({ state: 'received', body: 'Original request before receiver close' })
  expect(original.ingress!.input).toBeUndefined(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30000)
