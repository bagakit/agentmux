import { ApplicationFlags, type APIMessage } from 'discord-api-types/v10'
import type { ChannelQuoteRecord, ChannelTranscriptQuote, ConnectionConfig } from '@agentmux/core/connections'
import type { DiscordClients } from './client.js'
import { discordConfig, discordId } from './protocol.js'

type Request = { externalConversationId: string; range: ChannelTranscriptQuote['range']; knownThreadIds?: string[] }
const timestamp = (value: unknown): number | undefined => typeof value === 'string' && Number.isSafeInteger(Date.parse(value)) ? Date.parse(value) : undefined

/** A Discord thread has its own channel identity and Binding; it is not an implicit parent audience. */
export function createDiscordHistory(clients: DiscordClients) {
  return async (config: ConnectionConfig, input: Request, credential: string, signal: AbortSignal): Promise<ChannelTranscriptQuote> => {
    const quote: ChannelTranscriptQuote = { version: 1, application: { ...config.application }, externalConversationId: input.externalConversationId,
      observedAt: Date.now(), range: structuredClone(input.range), coverage: 'unavailable', gaps: [], records: [] }
    const gap = (reason: string) => { if (!quote.gaps.some(item => item.reason === reason)) quote.gaps.push({ reason }) }
    const finish = () => {
      quote.observedAt = Date.now()
      quote.records.sort((a, b) => BigInt(a.messageId) < BigInt(b.messageId) ? -1 : BigInt(a.messageId) > BigInt(b.messageId) ? 1 : 0)
      quote.coverage = quote.gaps.length ? quote.records.length ? 'partial' : 'unavailable' : 'complete'
      return quote
    }
    if (!input.range.from) { gap('baseline-unconfirmed'); return finish() }
    try {
      discordConfig(config)
      const channelId = discordId(input.externalConversationId), lowerId = discordId(input.range.from.messageId), throughId = discordId(input.range.throughMessageId)
      if (input.knownThreadIds?.some(id => id !== channelId)) gap('thread-scope-unconfirmed')
      if (BigInt(lowerId) > BigInt(throughId)) { gap('range-order-unconfirmed'); return finish() }
      const rest = clients.rest(config, credential)
      const application = await rest.get('/oauth2/applications/@me', { signal }) as { id?: string; flags?: number; bot?: { id?: string } }
      if (application.id !== config.application.appId || !application.bot?.id) { gap('native-application-mismatch'); return finish() }
      const get = async (id: string) => {
        signal.throwIfAborted()
        const row = await rest.get(`/channels/${channelId}/messages/${id}`, { signal }) as APIMessage
        if (row.id !== id || row.channel_id !== channelId) throw Error('Native anchor mismatch')
        return row
      }
      // Exact reads require native history permission; a list-only empty array does not prove it.
      const through = await get(throughId)
      if (lowerId !== throughId) await get(lowerId)
      else return finish()
      const contentAccess = typeof application.flags === 'number' && Boolean(application.flags & (ApplicationFlags.GatewayMessageContent | ApplicationFlags.GatewayMessageContentLimited))
      if (!contentAccess) gap('message-content-access-unconfirmed')
      const project = (message: APIMessage): ChannelQuoteRecord | null => {
        if (!Number.isSafeInteger(message.type) || typeof message.content !== 'string' || !Array.isArray(message.attachments) || !Array.isArray(message.embeds)) { gap('native-content-unconfirmed'); return null }
        // Retain every native content shape, including components, forwards, polls and attachments.
        // Interaction tokens, member permissions and transport metadata are not message content.
        const body = Object.fromEntries(['content', 'embeds', 'components', 'attachments', 'sticker_items', 'poll', 'message_snapshots', 'message_reference', 'mentions', 'mention_roles', 'mention_everyone'].filter(key => Object.hasOwn(message, key)).map(key => [key, (message as unknown as Record<string, unknown>)[key]]))
        const author = message.author
        const createdAt = timestamp(message.timestamp), updatedAt = timestamp(message.edited_timestamp)
        const resources = message.attachments?.map(attachment => ({ resourceId: discordId(attachment.id), kind: 'file' as const,
          ...(attachment.filename ? { name: attachment.filename } : {}), ...(attachment.content_type ? { mediaType: attachment.content_type } : {}),
          ...(Number.isSafeInteger(attachment.size) && attachment.size >= 0 ? { sizeBytes: attachment.size } : {}), ...(attachment.url ? { url: attachment.url } : {}) })) ?? []
        return { messageId: discordId(message.id), contentType: 'discord.message.' + message.type, content: JSON.stringify(body),
          author: author?.id ? { kind: author.bot || message.webhook_id ? 'bot' : 'user', actor: { application: { ...config.application }, idType: message.webhook_id ? 'webhook_id' : 'snowflake', userId: discordId(message.webhook_id ?? author.id) } } : { kind: 'unknown' },
          ...(createdAt === undefined ? {} : { createdAt }), ...(updatedAt === undefined ? {} : { updatedAt }),
          ...(message.message_reference?.message_id ? { replyToMessageId: discordId(message.message_reference.message_id) } : {}), resources }
      }
      let before = throughId, reached = false
      const ids = new Set<string>()
      while (!reached) {
        signal.throwIfAborted()
        const response = await rest.get(`/channels/${channelId}/messages`, { query: new URLSearchParams({ before, limit: '100' }), signal })
        if (!Array.isArray(response)) { gap('native-history-unconfirmed'); break }
        if (response.length === 0) { gap('from-anchor-missing'); break }
        let next: string | undefined
        for (const message of response as APIMessage[]) {
          if (message.channel_id !== channelId) { gap('native-conversation-mismatch'); continue }
          const id = discordId(message.id)
          if (BigInt(id) >= BigInt(before) || next && BigInt(id) >= BigInt(next)) { gap('native-order-unconfirmed'); continue }
          next = id
          if (id === lowerId) { reached = true; if (input.range.from.inclusive) { const record = project(message); if (record) quote.records.push(record) } break }
          if (BigInt(id) < BigInt(lowerId)) { gap('from-anchor-missing'); reached = true; break }
          if (!ids.has(id)) { ids.add(id); const record = project(message); if (record) quote.records.push(record) }
        }
        if (reached) break
        if (!next || next === before) { gap('native-pagination-unconfirmed'); break }
        before = next
      }
      // An exact current request read is separate from this quote and never repeated here.
      if (through.id !== throughId) gap('through-anchor-missing')
    } catch { gap(signal.aborted ? 'history-cancelled' : 'native-history-unavailable') }
    return finish()
  }
}
