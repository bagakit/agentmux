import type { PublicationMapping, QueryFeedbackPayload } from '../../publication-store.js'
import type { PreparedPublication } from '../../publication-wire.js'
import { discordFailure, discordId } from './protocol.js'

const reactions = { received: '👀', queued: '🕒', dispatched: '📨', started: '⚙️', completed: '✅', failed: '❌', interrupted: '⏹️' } as const
export function discordQueryReaction(channelId: string, payload: QueryFeedbackPayload, effect: 'upsert' | 'withdraw', mapping?: Readonly<PublicationMapping>): PreparedPublication['request'] {
  const messageId = discordId(payload.messageId), emoji = reactions[payload.stage]
  if (!emoji || mapping && (mapping.messageId !== messageId || mapping.reactionId !== emoji || mapping.threadId !== undefined || mapping.nativeCard !== undefined)) discordFailure('DISCORD_QUERY_FEEDBACK_INVALID')
  if (effect === 'withdraw' && !mapping) discordFailure('DISCORD_ORIGINAL_REACTION_UNCONFIRMED')
  return { method: effect === 'withdraw' ? 'DELETE' : 'PUT', path: `/channels/${discordId(channelId)}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me` }
}

/** Decode only this adapter's frozen native own-reaction request, never a user-supplied path. */
export function readDiscordQueryReaction(prepared: PreparedPublication, channelId: string): PublicationMapping | null {
  const request = prepared.request, prefix = `/channels/${discordId(channelId)}/messages/`
  if (!['PUT', 'DELETE'].includes(request.method) || request.body !== undefined || request.query !== undefined || request.multipart !== undefined || request.contentType !== undefined || !request.path.startsWith(prefix)) return null
  const match = /^([0-9]{1,20})\/reactions\/([^/]+)\/@me$/u.exec(request.path.slice(prefix.length))
  if (!match) return null
  try {
    const emoji = decodeURIComponent(match[2]!)
    return Object.values(reactions).some(value => value === emoji) && encodeURIComponent(emoji) === match[2] ? { messageId: discordId(match[1]), reactionId: emoji } : null
  } catch { return null }
}
