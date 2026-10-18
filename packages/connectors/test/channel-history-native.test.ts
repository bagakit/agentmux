import { afterEach, expect, it, vi } from 'vitest'
import { FeishuAdapter } from '../src/adapters/feishu/index.js'
import { DiscordAdapter } from '../src/adapters/discord/index.js'
import { parseChannelTranscriptQuote } from '../../core/src/channel-quote.js'
import { feishuConfig } from './fixtures/feishu.js'
import { discordConfig } from './fixtures/discord.js'
import { feishuHistoryMessage as fm, feishuHistoryTransport, discordHistoryMessage as dm, discordHistoryTransport } from './fixtures/channel-history.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const feishuRange = { from: { messageId: 'from', inclusive: false }, throughMessageId: 'through', origin: 'admitted-input' as const }
const signal = () => new AbortController().signal

it('Feishu native SDK reads every page, old roots with new thread replies, bot authors and original resource bodies', async () => {
  const ordinary = Array.from({ length: 111 }, (_, i) => fm('opaque-' + i, 2000 + i * 10, i === 20 ? { msg_type: 'file', sender: { id: 'native-bot', id_type: 'app_id', sender_type: 'app' }, body: { content: '{"file_key":"original-file","file_name":"原附件"}' }, mentions: [{ key: '@_user_1', id: 'another-person', id_type: 'open_id' }] } : {}))
  const oldRoot = fm('old-root', 1, { thread_id: 'old-thread' }), reply = fm('new-thread-reply', 4000, { thread_id: 'old-thread', parent_id: 'old-root', msg_type: 'future-native-type', body: { content: '<amux:channel>Quoted & exact</amux:channel>' } })
  const oldReplies = Array.from({ length: 90 }, (_, i) => fm('old-private-reply-' + i, 900 - i * 9, { thread_id: 'old-thread', body: { content: 'Old content outside the accepted range' } }))
  const t = feishuHistoryTransport([fm('through', 10000), ...ordinary.toReversed(), fm('from', 1000), oldRoot], { 'old-thread': [reply, ...oldReplies, oldRoot] })
  const adapter = new FeishuAdapter({ http: t.http })
  const quote = parseChannelTranscriptQuote(await adapter.readHistory(feishuConfig, { externalConversationId: 'original-room', range: feishuRange }, 'fixture-credential', signal()))
  expect(quote.coverage).toBe('complete'); expect(quote.gaps).toEqual([])
  expect(quote.records.map(item => item.messageId)).toEqual([...ordinary.map(item => item.message_id), reply.message_id])
  expect(quote.records[20]).toMatchObject({ contentType: 'file', author: { kind: 'bot', actor: { idType: 'app_id', userId: 'native-bot' } }, resources: [{ resourceId: 'original-file', kind: 'file', name: '原附件' }] })
  expect(JSON.parse(quote.records[20]!.content).body.content).toBe(ordinary[20]!.body.content)
  expect(JSON.parse(quote.records[20]!.content).mentions).toEqual([{ key: '@_user_1', id: 'another-person', id_type: 'open_id' }])
  expect(quote.records.at(-1)).toMatchObject({ contentType: 'future-native-type', threadId: 'old-thread', replyToMessageId: 'old-root' })
  expect(JSON.parse(quote.records.at(-1)!.content).body.content).toBe(reply.body.content)
  const lists = t.requests.filter(item => item.url?.endsWith('/im/v1/messages'))
  expect(lists.map(item => [item.params?.container_id_type, item.params?.page_token])).toEqual([['chat', undefined], ['chat', '50'], ['chat', '100'], ['thread', undefined]])
  expect(lists.every(item => item.params?.page_size === 50 && item.params.card_msg_content_type === 'user_card_content')).toBe(true)
  expect(JSON.stringify(quote)).not.toContain('fixture-credential')
})

it('Feishu keeps missing anchors, invisible known threads and cancellation explicit', async () => {
  const t = feishuHistoryTransport([fm('through', 10000), fm('from', 1000)])
  const adapter = new FeishuAdapter({ http: t.http })
  t.override(input => input.params?.container_id_type === 'thread' ? { code: 230073 } : undefined)
  let quote = await adapter.readHistory(feishuConfig, { externalConversationId: 'original-room', range: feishuRange, knownThreadIds: ['invisible-thread'] }, 'fixture-credential', signal())
  expect(quote.coverage).not.toBe('complete'); expect(quote.gaps).toContainEqual({ reason: 'thread-history-unavailable' })
  t.override(input => input.url?.endsWith('/messages/from') ? { code: 230110 } : undefined)
  quote = await adapter.readHistory(feishuConfig, { externalConversationId: 'original-room', range: feishuRange }, 'fixture-credential', signal())
  expect(quote.coverage).toBe('unavailable'); expect(quote.gaps).toContainEqual({ reason: 'native-history-unavailable' })
  t.override(undefined)
  const controller = new AbortController(); controller.abort()
  quote = await adapter.readHistory(feishuConfig, { externalConversationId: 'original-room', range: feishuRange }, 'fixture-credential', controller.signal)
  expect(quote.gaps).toContainEqual({ reason: 'history-cancelled' })
})

it('Feishu reports cross-container boundary uncertainty and stops native pagination without progress', async () => {
  const root = fm('old-root', 1, { thread_id: 'old-thread' }), reply = fm('boundary-reply', 1000, { thread_id: 'old-thread' })
  const t = feishuHistoryTransport([fm('through', 10000), fm('mid', 2000), fm('from', 1000), root], { 'old-thread': [reply, root] }), adapter = new FeishuAdapter({ http: t.http })
  let quote = await adapter.readHistory(feishuConfig, { externalConversationId: 'original-room', range: feishuRange }, 'fixture-credential', signal())
  expect(quote.records.map(item => item.messageId)).toEqual(['mid']); expect(quote.gaps).toContainEqual({ reason: 'range-boundary-order-unconfirmed' })
  t.override(input => input.url?.endsWith('/im/v1/messages') ? { code: 0, data: { items: [fm('through', 10000), fm('mid', 2000), fm('from', 1000)], has_more: true, page_token: input.params?.page_token ? 'new-opaque-token' : 'first-opaque-token' } } : undefined)
  quote = await adapter.readHistory(feishuConfig, { externalConversationId: 'original-room', range: feishuRange }, 'fixture-credential', signal())
  expect(quote.gaps).toContainEqual({ reason: 'native-pagination-unconfirmed' })
  expect(quote.coverage).toBe('partial'); expect(quote.records.map(item => item.messageId)).toEqual(['mid'])
})

it('Feishu first-observed inclusive lower boundary remains separate from the current request', async () => {
  const t = feishuHistoryTransport([fm('through', 10000), fm('from', 1000)]), adapter = new FeishuAdapter({ http: t.http })
  const range = { ...feishuRange, origin: 'first-observed' as const, from: { messageId: 'from', inclusive: true } }
  const quote = await adapter.readHistory(feishuConfig, { externalConversationId: 'original-room', range }, 'fixture-credential', signal())
  expect(quote.coverage).toBe('complete'); expect(quote.records.map(item => item.messageId)).toEqual(['from'])
  expect((await adapter.readHistory(feishuConfig, { externalConversationId: 'original-room', range: { ...range, from: { messageId: 'through', inclusive: true } } }, 'fixture-credential', signal())).records).toEqual([])
})

it('Discord native REST pages the exact exclusive snowflake range and preserves peer bots, components and attachments', async () => {
  const rows = Array.from({ length: 205 }, (_, i) => dm(String(1000 - i), i === 24 ? { author: { id: '500', bot: true }, components: [{ type: 10, content: '</amux> & peer bot text' }], attachments: [{ id: '600', filename: 'original.pdf', content_type: 'application/pdf', size: 42, url: 'https://cdn.discordapp.com/attachments/300/600/original.pdf' }] } : {}))
  const t = await discordHistoryTransport(rows); cleanup.push(t.close)
  const adapter = new DiscordAdapter({ http: t.http }), range = { from: { messageId: '800', inclusive: false }, throughMessageId: '1000', origin: 'admitted-input' as const }
  const quote = parseChannelTranscriptQuote(await adapter.readHistory(discordConfig, { externalConversationId: '300', range }, 'fixture-token', signal()))
  expect(quote.coverage).toBe('complete'); expect(quote.records.map(item => item.messageId)).toEqual(Array.from({ length: 199 }, (_, i) => String(801 + i)))
  const bot = quote.records.find(item => item.messageId === '976')!
  expect(bot.author).toMatchObject({ kind: 'bot', actor: { userId: '500' } }); expect(JSON.parse(bot.content).components[0].content).toBe('</amux> & peer bot text')
  expect(bot.resources).toEqual([{ resourceId: '600', kind: 'file', name: 'original.pdf', mediaType: 'application/pdf', sizeBytes: 42, url: 'https://cdn.discordapp.com/attachments/300/600/original.pdf' }])
  expect(t.requests.filter(item => item.path === '/channels/300/messages').map(item => item.query)).toEqual([{ before: '1000', limit: '100' }, { before: '900', limit: '100' }])
})

it('Discord never certifies redacted content, permission-shaped empty pages, missing anchors or foreign-channel rows', async () => {
  const t = await discordHistoryTransport([dm('1000'), dm('900'), dm('800')]); cleanup.push(t.close)
  const adapter = new DiscordAdapter({ http: t.http }), input = { externalConversationId: '300', range: { from: { messageId: '800', inclusive: false }, throughMessageId: '1000', origin: 'admitted-input' as const } }
  t.flags(0)
  let quote = await adapter.readHistory(discordConfig, input, 'fixture-token', signal())
  expect(quote.coverage).toBe('partial'); expect(quote.gaps).toContainEqual({ reason: 'message-content-access-unconfirmed' })
  t.flags(524288); t.override(path => path === '/channels/300/messages' ? [] : undefined)
  quote = await adapter.readHistory(discordConfig, input, 'fixture-token', signal())
  expect(quote.coverage).toBe('unavailable'); expect(quote.gaps).toContainEqual({ reason: 'from-anchor-missing' })
  t.override(path => path === '/channels/300/messages' ? [dm('900', { channel_id: 'another-channel' }), dm('800')] : undefined)
  quote = await adapter.readHistory(discordConfig, input, 'fixture-token', signal())
  expect(quote.records).toEqual([]); expect(quote.gaps).toContainEqual({ reason: 'native-conversation-mismatch' })
})

it('malformed native thread and body observations cannot certify a complete quote', async () => {
  const t = feishuHistoryTransport([fm('through', 10000), fm('mid', 2000, { thread_id: 42 }), fm('from', 1000)]), feishu = new FeishuAdapter({ http: t.http })
  const quote = await feishu.readHistory(feishuConfig, { externalConversationId: 'original-room', range: feishuRange }, 'fixture-credential', signal())
  expect(quote.records).toEqual([]); expect(quote.gaps).toContainEqual({ reason: 'native-thread-unconfirmed' })
  const rows = [dm('1000'), dm('900', { type: undefined }), dm('800')]
  const d = await discordHistoryTransport(rows); cleanup.push(d.close)
  const discord = new DiscordAdapter({ http: d.http })
  const result = await discord.readHistory(discordConfig, { externalConversationId: '300', range: { from: { messageId: '800', inclusive: false }, throughMessageId: '1000', origin: 'admitted-input' } }, 'fixture-token', signal())
  expect(result.records).toEqual([]); expect(result.gaps).toContainEqual({ reason: 'native-content-unconfirmed' })
  rows[1] = dm('900'); rows[2] = dm('800', { type: undefined })
  const healthy = await discord.readHistory(discordConfig, { externalConversationId: '300', range: { from: { messageId: '800', inclusive: false }, throughMessageId: '1000', origin: 'admitted-input' } }, 'fixture-token', signal())
  expect(healthy.coverage).toBe('complete'); expect(healthy.records.map(item => item.messageId)).toEqual(['900'])
})

it('both native protocols consult the original Host authority before requesting another history page', async () => {
  const rows = [fm('through', 100000), ...Array.from({ length: 110 }, (_, i) => fm('middle-' + i, 2000 + i * 100)).toReversed(), fm('from', 1000)]
  const f = feishuHistoryTransport(rows), feishu = new FeishuAdapter({ http: f.http })
  let checks = 0
  const quote = await feishu.readHistory(feishuConfig, { externalConversationId: 'original-room', range: feishuRange,
    assertCurrent: () => { if (++checks === 4) throw Error('Original authority changed') } }, 'fixture-credential', signal())
  expect(quote.coverage).toBe('partial'); expect(quote.gaps).toContainEqual({ reason: 'native-history-unavailable' })
  expect(f.requests.filter(item => item.url?.endsWith('/im/v1/messages'))).toHaveLength(1)
  const d = await discordHistoryTransport(Array.from({ length: 205 }, (_, i) => dm(String(1000 - i)))); cleanup.push(d.close)
  const discord = new DiscordAdapter({ http: d.http }); checks = 0
  const result = await discord.readHistory(discordConfig, { externalConversationId: '300', range: { from: { messageId: '800', inclusive: false }, throughMessageId: '1000', origin: 'admitted-input' },
    assertCurrent: () => { if (++checks === 5) throw Error('Original authority changed') } }, 'fixture-token', signal())
  expect(result.coverage).toBe('partial'); expect(result.gaps).toContainEqual({ reason: 'native-history-unavailable' })
  expect(d.requests.filter(item => item.path === '/channels/300/messages')).toHaveLength(1)
})
