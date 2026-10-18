import type { ChannelQuoteRecord, ChannelQuoteResource, ChannelTranscriptQuote, ConnectionConfig } from '@agentmux/core/connections'
import type { FeishuAdapter } from './index.js'
import { feishuIdentity } from './message.js'

type Request = { externalConversationId: string; range: ChannelTranscriptQuote['range']; knownThreadIds?: string[] }
type Message = { message_id?: unknown; chat_id?: unknown; msg_type?: unknown; create_time?: unknown; update_time?: unknown; deleted?: unknown; root_id?: unknown; parent_id?: unknown; thread_id?: unknown; mentions?: unknown; sender?: { id?: unknown; id_type?: unknown; sender_type?: unknown }; body?: { content?: unknown } }
const timestamp = (value: unknown): number | undefined => typeof value === 'string' && /^\d+$/u.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value)

/** Resource keys retain their native message relationship; this read does not download or execute them. */
function resources(content: string, type: string): ChannelQuoteResource[] {
  const found = new Map<string, ChannelQuoteResource>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (!value || typeof value !== 'object') return
    const item = value as Record<string, unknown>
    for (const key of ['image_key', 'img_key', 'file_key', 'audio_key', 'media_key']) if (text(item[key])) {
      const kind = key === 'image_key' || key === 'img_key' ? 'image' : key === 'audio_key' || type === 'audio' ? 'audio' : key === 'media_key' || type === 'media' ? 'video' : 'file'
      found.set(item[key], { resourceId: item[key], kind, ...(text(item.file_name) ? { name: item.file_name } : {}) })
    }
    Object.values(item).forEach(visit)
  }
  try { visit(JSON.parse(content)) } catch { /* An opaque native body remains intact in content. */ }
  return [...found.values()]
}

export function createFeishuHistory(adapter: Pick<FeishuAdapter, 'withClient'>) {
  return async (config: ConnectionConfig, input: Request, credential: string, signal: AbortSignal): Promise<ChannelTranscriptQuote> => {
    const quote: ChannelTranscriptQuote = { version: 1, application: { ...config.application }, externalConversationId: input.externalConversationId,
      observedAt: Date.now(), range: structuredClone(input.range), coverage: 'unavailable', gaps: [], records: [] }
    const gap = (reason: string) => { if (!quote.gaps.some(item => item.reason === reason)) quote.gaps.push({ reason }) }
    const rows = new Map<string, { record: ChannelQuoteRecord; container: string; ordinal: number }>()
    let ordinal = 0
    const finish = () => {
      quote.observedAt = Date.now()
      const ordered = [...rows.values()].sort((a, b) => (a.record.createdAt! - b.record.createdAt!) || b.ordinal - a.ordinal)
      for (let i = 1; i < ordered.length; i++) if (ordered[i]!.record.createdAt === ordered[i - 1]!.record.createdAt && ordered[i]!.container !== ordered[i - 1]!.container) gap('cross-thread-order-unconfirmed')
      quote.records = ordered.map(item => item.record)
      quote.coverage = quote.gaps.length ? quote.records.length ? 'partial' : 'unavailable' : 'complete'
      return quote
    }
    if (!input.range.from) { gap('baseline-unconfirmed'); return finish() }
    try {
      feishuIdentity(input.externalConversationId); feishuIdentity(input.range.from.messageId); feishuIdentity(input.range.throughMessageId)
      await adapter.withClient(config, credential, async client => {
        const get = async (id: string): Promise<Message> => {
          signal.throwIfAborted()
          const response = await client.request<{ code?: number; data?: { items?: Message[] } }>({ url: '/open-apis/im/v1/messages/' + encodeURIComponent(id), method: 'GET', params: { card_msg_content_type: 'user_card_content' }, signal })
          const message = response.data?.items?.find(message => message.message_id === id)
          if (response.code !== 0 || !message || message.chat_id !== input.externalConversationId || timestamp(message.create_time) === undefined || message.thread_id !== undefined && !text(message.thread_id)) throw Error('Native anchor unavailable')
          return message
        }
        const through = await get(input.range.throughMessageId), from = input.range.from!.messageId === input.range.throughMessageId ? through : await get(input.range.from!.messageId)
        if (from.deleted || through.deleted) { gap('anchor-deleted'); return }
        const lower = timestamp(from.create_time)!, upper = timestamp(through.create_time)!
        if (lower > upper) { gap('range-order-unconfirmed'); return }
        // The exclusive current request creates an exactly empty first-observed range.
        if (from.message_id === through.message_id) return
        const threads = new Set(input.knownThreadIds ?? [])
        for (const message of [from, through]) if (text(message.thread_id)) threads.add(message.thread_id)
        const project = (message: Message, container: string, include: boolean) => {
          if (!include || message.message_id === input.range.throughMessageId || !input.range.from!.inclusive && message.message_id === input.range.from!.messageId) return
          if (!text(message.message_id) || !text(message.msg_type) || typeof message.body?.content !== 'string') { gap('native-content-unconfirmed'); return }
          const createdAt = timestamp(message.create_time)
          if (createdAt === undefined) { gap('native-order-unconfirmed'); return }
          const updatedAt = timestamp(message.update_time)
          const sender = message.sender, actor = sender && text(sender.id) && text(sender.id_type) ? { application: { ...config.application }, idType: sender.id_type, userId: sender.id } : null
          const content = JSON.stringify({ body: message.body, ...(message.mentions === undefined ? {} : { mentions: message.mentions }), ...(message.root_id === undefined ? {} : { root_id: message.root_id }) })
          const record: ChannelQuoteRecord = { messageId: message.message_id, contentType: message.msg_type, content,
            author: actor && (sender?.sender_type === 'user' || sender?.sender_type === 'app') ? { kind: sender.sender_type === 'user' ? 'user' : 'bot', actor } : { kind: 'unknown' }, createdAt,
            ...(updatedAt === undefined ? {} : { updatedAt }), ...(message.deleted ? { revision: 'deleted' } : {}),
            ...(text(message.parent_id) ? { replyToMessageId: message.parent_id } : {}), ...(text(message.thread_id) ? { threadId: message.thread_id } : {}),
            resources: resources(message.body.content, message.msg_type) }
          const existing = rows.get(record.messageId)
          if (existing && JSON.stringify(existing.record) !== JSON.stringify(record)) gap('native-revision-changed')
          else if (!existing) rows.set(record.messageId, { record, container, ordinal: ordinal++ })
          if (message.deleted) gap('native-message-deleted')
        }
        const scan = async (kind: 'chat' | 'thread', id: string) => {
          let pageToken: string | undefined, seenThrough = false, seenFrom = false
          let previousTime = Number.POSITIVE_INFINITY
          const tokens = new Set<string>(), pageEnds = new Set<string>()
          do {
            signal.throwIfAborted()
            let pastThreadRange = false
            const response = await client.request<{ code?: number; data?: { items?: Message[]; has_more?: boolean; page_token?: string } }>({ url: '/open-apis/im/v1/messages', method: 'GET',
              params: { container_id_type: kind, container_id: id, sort_type: 'ByCreateTimeDesc', page_size: 50, card_msg_content_type: 'user_card_content', ...(pageToken ? { page_token: pageToken } : {}) }, signal })
            if (response.code !== 0 || !Array.isArray(response.data?.items) || typeof response.data.has_more !== 'boolean') throw Error('Native history unavailable')
            for (const message of response.data.items) {
              if (message.chat_id !== input.externalConversationId) { gap('native-conversation-mismatch'); continue }
              if (message.thread_id !== undefined && !text(message.thread_id)) { gap('native-thread-unconfirmed'); continue }
              if (kind === 'thread' && message.thread_id !== id) { gap('native-thread-mismatch'); continue }
              if (kind === 'chat' && text(message.thread_id)) threads.add(message.thread_id)
              if (kind === 'chat' && message.deleted && !text(message.thread_id)) gap('thread-discovery-unconfirmed')
              const time = timestamp(message.create_time)
              if (time === undefined) { gap('native-order-unconfirmed'); continue }
              if (time > previousTime) gap('native-order-unconfirmed')
              previousTime = time
              if (kind === 'thread' && time < lower) { pastThreadRange = true; break }
              const isThrough = message.message_id === through.message_id, isFrom = message.message_id === from.message_id
              if (isThrough) seenThrough = true
              const bothInContainer = kind === 'chat' ? !from.thread_id && !through.thread_id : from.thread_id === id && through.thread_id === id
              let include: boolean
              if (bothInContainer) include = seenThrough && !seenFrom && (!isFrom || input.range.from!.inclusive)
              else {
                include = time > lower && time < upper || isFrom && input.range.from!.inclusive
                if (!isFrom && !isThrough && (time === lower || time === upper)) gap('range-boundary-order-unconfirmed')
              }
              project(message, kind + ':' + id, include)
              if (isFrom) seenFrom = true
            }
            if (pastThreadRange || !response.data.has_more) break
            const next = response.data.page_token
            const end = response.data.items.at(-1)?.message_id
            if (!text(next) || tokens.has(next) || !text(end) || pageEnds.has(end)) { gap('native-pagination-unconfirmed'); break }
            pageEnds.add(end)
            tokens.add(next); pageToken = next
          } while (true)
          if ((kind === 'chat' && !through.thread_id || kind === 'thread' && through.thread_id === id) && !seenThrough) gap('through-anchor-missing')
          if ((kind === 'chat' && !from.thread_id || kind === 'thread' && from.thread_id === id) && !seenFrom) gap('from-anchor-missing')
        }
        // Roots before the lower boundary may have new replies. Discover them in this
        // exact native group, without retaining their old content or a second catalog.
        await scan('chat', input.externalConversationId)
        for (const threadId of threads) {
          feishuIdentity(threadId)
          try { await scan('thread', threadId) } catch { gap(signal.aborted ? 'history-cancelled' : 'thread-history-unavailable') }
          if (signal.aborted) break
        }
      }, signal)
    } catch { gap(signal.aborted ? 'history-cancelled' : 'native-history-unavailable') }
    return finish()
  }
}
