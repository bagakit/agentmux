/** Native message request body limit, measured after JSON encoding. */
export const FEISHU_MESSAGE_BODY_BYTES = 30 * 1024

import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError } from '@agentmux/core'
import type { ConnectionApplication } from '@agentmux/core/connections'
import type { VerifiedIngressEvent } from '../../durable-ingress.js'

export const FEISHU_MESSAGE_EVENT = 'im.message.receive_v1'

export type FeishuMessageEvent = {
  schema: string
  header: { app_id: string; event_id: string; event_type: string }
  event: {
    sender: { sender_type: string; sender_id?: { open_id?: string } }
    message: {
      message_id: string; chat_id: string; chat_type: string; message_type?: unknown; content?: unknown
      parent_id?: string
      mentions?: { key?: string; name?: string; id: { open_id?: string } }[]
    }
  }
}

export function feishuFailure(code: string): never {
  throw new AgentMuxError('The original Feishu operation could not be confirmed. Existing Agents are retained.', code)
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) feishuFailure('FEISHU_EVENT_INVALID')
  return value as Record<string, unknown>
}
export function feishuIdentity(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(value)) feishuFailure('FEISHU_IDENTITY_INVALID')
  return value
}
/** Read only the original typed platform envelope. Unknown extension fields stay in the durable raw payload. */
export function readFeishuMessage(raw: string, application: ConnectionApplication): FeishuMessageEvent {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return feishuFailure('FEISHU_EVENT_INVALID') }
  const payload = object(parsed), header = object(payload.header), event = object(payload.event)
  const sender = object(event.sender), message = object(event.message)
  if (payload.schema !== '2.0' || header.event_type !== FEISHU_MESSAGE_EVENT || header.app_id !== application.appId) feishuFailure('FEISHU_EVENT_IDENTITY_MISMATCH')
  feishuIdentity(header.event_id); feishuIdentity(message.message_id); feishuIdentity(message.chat_id)
  feishuIdentity(sender.sender_type); feishuIdentity(message.chat_type)
  if (message.parent_id !== undefined) feishuIdentity(message.parent_id)
  if (message.mentions !== undefined) {
    if (!Array.isArray(message.mentions)) feishuFailure('FEISHU_EVENT_INVALID')
    for (const mention of message.mentions) {
      const id = object(object(mention).id)
      if (id.open_id !== undefined) feishuIdentity(id.open_id)
    }
  }
  if (sender.sender_type === 'user') feishuIdentity(object(sender.sender_id).open_id)
  return parsed as FeishuMessageEvent
}

/** Decode text only. The authenticated caller records unsupported projection separately from transport validity. */
export function feishuTextBody(content: string): string {
  let decoded: unknown
  try { decoded = JSON.parse(content) } catch { return feishuFailure('FEISHU_CONTENT_INVALID') }
  const value = object(decoded)
  if (typeof value.text !== 'string') feishuFailure('FEISHU_CONTENT_INVALID')
  return value.text
}

/** Inbound post at-nodes reference mention keys, not the outbound user-id namespace. */
function postBody(content: string, mentions: FeishuMessageEvent['event']['message']['mentions'], botOpenId: string): { body: string; mentioned: boolean } {
  const parsed = object(JSON.parse(content))
  let post = parsed
  if (!Array.isArray(post.content)) {
    const locales = Object.keys(parsed)
    if (locales.length !== 1 || !['zh_cn', 'en_us', 'ja_jp'].includes(locales[0]!)) feishuFailure('FEISHU_CONTENT_INVALID')
    post = object(parsed[locales[0]!])
  }
  if (Object.keys(post).some(key => !['title', 'content', 'content_v2'].includes(key)) || post.title !== undefined && typeof post.title !== 'string' || !Array.isArray(post.content)) feishuFailure('FEISHU_CONTENT_INVALID')
  if (post.content_v2 !== undefined && !isDeepStrictEqual(post.content_v2, post.content)) feishuFailure('FEISHU_CONTENT_INVALID')
  const byKey = new Map<string, NonNullable<typeof mentions>[number]>()
  for (const mention of mentions ?? []) {
    if (typeof mention.key !== 'string') continue
    if (byKey.has(mention.key)) feishuFailure('FEISHU_CONTENT_INVALID')
    byKey.set(mention.key, mention)
  }
  let mentioned = false
  const paragraphs = post.content.map(paragraph => {
    if (!Array.isArray(paragraph)) feishuFailure('FEISHU_CONTENT_INVALID')
    return paragraph.map(value => {
      const node = object(value)
      const fields = node.tag === 'text' ? ['tag', 'text', 'style', 'un_escape'] : node.tag === 'a' ? ['tag', 'text', 'href', 'style'] : node.tag === 'at' ? ['tag', 'user_id', 'user_name', 'style'] : []
      if (!fields.length || Object.keys(node).some(key => !fields.includes(key)) || node.style !== undefined && (!Array.isArray(node.style) || node.style.some(style => !['bold', 'underline', 'lineThrough', 'italic'].includes(style)))) feishuFailure('FEISHU_CONTENT_INVALID')
      if (node.tag === 'text') {
        if (typeof node.text !== 'string' || node.un_escape !== undefined && node.un_escape !== false) feishuFailure('FEISHU_CONTENT_INVALID')
        return node.text
      }
      if (node.tag === 'a') {
        if (typeof node.text !== 'string' || typeof node.href !== 'string' || !node.href) feishuFailure('FEISHU_CONTENT_INVALID')
        return `[${node.text}](${node.href})`
      }
      const key = feishuIdentity(node.user_id), target = byKey.get(key)
      if (node.user_name !== undefined && typeof node.user_name !== 'string' || target?.name !== undefined && typeof target.name !== 'string') feishuFailure('FEISHU_CONTENT_INVALID')
      if (target?.id.open_id === botOpenId) mentioned = true
      return '@' + (node.user_name || target?.name || key)
    }).join('')
  })
  return { body: (post.title ? post.title + '\n' : '') + paragraphs.join('\n'), mentioned }
}

export function projectFeishuMessage(payload: FeishuMessageEvent, application: ConnectionApplication, botOpenId: string): VerifiedIngressEvent {
  const { message, sender } = payload.event
  if (sender.sender_type !== 'user' || !['group', 'p2p'].includes(message.chat_type)) feishuFailure('FEISHU_EVENT_OUTSIDE_SCOPE')
  let body = '', mentioned = false, unsupported = message.message_type !== 'text' && message.message_type !== 'post' || typeof message.content !== 'string'
  if (!unsupported) {
    try {
      if (message.message_type === 'post') ({ body, mentioned } = postBody(message.content as string, message.mentions, botOpenId))
      else {
        body = feishuTextBody(message.content as string)
        mentioned = message.mentions?.some(mention => mention.id.open_id === botOpenId) ?? false
      }
    } catch { unsupported = true }
  }
  return {
    conversationKind: message.chat_type === 'p2p' ? 'direct' : 'group',
    eventId: payload.header.event_id, messageId: message.message_id, externalConversationId: message.chat_id,
    actor: { application: { ...application }, idType: 'open_id', userId: feishuIdentity(sender.sender_id?.open_id) },
    body, selection: mentioned ? 'mention' : 'message',
    ...(message.parent_id === undefined ? {} : { replyToMessageId: message.parent_id }),
    ...(unsupported ? { unsupportedContent: true as const } : {})
  }
}
