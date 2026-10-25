import type { ConnectionApplication } from '@agentmux/core/connections'
import type { PublicationMapping, PublicationReceipt, QueryFeedbackPayload } from '../../publication-store.js'
import type { PreparedPublication } from '../../publication-wire.js'
import { feishuFailure, feishuIdentity } from './message.js'

const path = '/open-apis/im/v1/messages/'
const reactions = { received: 'Get', queued: 'OneSecond', dispatched: 'CheckMark', started: 'OnIt', completed: 'DONE', failed: 'CrossMark', interrupted: 'MinusOne' } as const
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
export type FeishuQueryReaction = { messageId: string; emojiType?: string; reactionId?: string }

/** Stage changes retire only an exact retained reaction, never the original user message. */
export function feishuQueryReaction(payload: QueryFeedbackPayload, effect: 'upsert' | 'withdraw', mapping?: Readonly<PublicationMapping>): PreparedPublication['request'] {
  const messageId = feishuIdentity(payload.messageId), emojiType = reactions[payload.stage]
  if (!emojiType) feishuFailure('FEISHU_QUERY_FEEDBACK_INVALID')
  if (effect === 'withdraw') return { method: 'DELETE', path: `${path}${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(feishuIdentity(mapping?.reactionId))}` }
  return { method: 'POST', path: `${path}${encodeURIComponent(messageId)}/reactions`, contentType: 'application/json',
    body: JSON.stringify({ reaction_type: { emoji_type: emojiType } }) }
}

/** The publication envelope owns version validation; this reader validates the frozen native reaction wire. */
export function readFeishuQueryReaction(prepared: PreparedPublication): FeishuQueryReaction | null {
  try {
    const request = prepared.request
    if (request.method === 'DELETE' && request.query === undefined && request.body === undefined && request.contentType === undefined && request.multipart === undefined && request.path.startsWith(path)) {
      const pieces = request.path.slice(path.length).split('/reactions/')
      if (pieces.length !== 2) return null
      const messageId = feishuIdentity(decodeURIComponent(pieces[0]!)), reactionId = feishuIdentity(decodeURIComponent(pieces[1]!))
      return request.path === `${path}${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}` ? { messageId, reactionId } : null
    }
    if (request.method !== 'POST' || request.query !== undefined ||
        request.contentType !== 'application/json' || request.multipart !== undefined || !request.path.startsWith(path) || !request.path.endsWith('/reactions')) return null
    const messageId = feishuIdentity(decodeURIComponent(request.path.slice(path.length, -'/reactions'.length)))
    if (request.path !== `${path}${encodeURIComponent(messageId)}/reactions`) return null
    const body = object(JSON.parse(request.body!)), reaction = object(body?.reaction_type)
    if (!body || Object.keys(body).length !== 1 || !reaction || Object.keys(reaction).length !== 1 ||
        !Object.values(reactions).some(emojiType => emojiType === reaction.emoji_type)) return null
    return { messageId, emojiType: reaction.emoji_type as string }
  } catch { return null }
}

/** Native reaction authors use app_id, unlike user-message senders and bot open_id. */
export function feishuReactionMapping(value: unknown, expected: FeishuQueryReaction, application: ConnectionApplication, mapping?: Readonly<PublicationMapping>): PublicationMapping | null {
  try {
    const reaction = object(value), operator = object(reaction?.operator), type = object(reaction?.reaction_type)
    if (!reaction || operator?.operator_type !== 'app' || operator.operator_id !== application.appId ||
        expected.emojiType !== undefined && type?.emoji_type !== expected.emojiType || expected.reactionId !== undefined && reaction.reaction_id !== expected.reactionId ||
        mapping && (mapping.messageId !== expected.messageId || mapping.threadId !== undefined || mapping.reactionId !== undefined && mapping.reactionId !== reaction.reaction_id)) return null
    return { messageId: expected.messageId, reactionId: feishuIdentity(reaction.reaction_id) }
  } catch { return null }
}

/** An API response only confirms its exact reaction; transport/duplicate-in-flight stays unknown. */
export function feishuReactionReceipt(response: unknown, status: number | undefined, expected: FeishuQueryReaction, application: ConnectionApplication, mapping?: Readonly<PublicationMapping>): PublicationReceipt {
  const result = object(response), code = result?.code
  if (status !== undefined && status >= 500) return { state: 'unknown', reason: 'platform-unavailable' }
  if (code === 231015) return { state: 'unknown', reason: 'effect-unconfirmed' }
  if (status === 429 || code === 230020) return { state: 'not-applied', reason: 'rate-limited' }
  if ([231003, 231004, 231005].includes(code as number) || status === 404) return { state: 'not-applied', reason: 'thread-unavailable' }
  if ([231001, 231010, 231011, 231017].includes(code as number)) return { state: 'not-applied', reason: 'unsupported-format' }
  // 99991672 is the documented shared missing-API-scope rejection, including HTTP 200 envelopes.
  if ([231002, 231006, 231007, 231008, 231013, 231014, 231018, 231019, 231020, 231021, 231022, 99991672].includes(code as number) || status === 401 || status === 403)
    return { state: 'not-applied', reason: 'platform-rejected' }
  if (code === 0 && (status === undefined || status >= 200 && status < 300)) {
    const confirmed = feishuReactionMapping(result?.data, expected, application, mapping)
    if (confirmed) return { state: 'confirmed', mapping: confirmed }
  }
  return { state: 'unknown', reason: 'effect-unconfirmed' }
}
