import { AgentMuxError } from '@agentmux/core'
import type { ConnectionApplication } from '@agentmux/core/connections'
import type { VerifiedIngressEvent } from '../../durable-ingress.js'

export type FeishuMessageEvent = {
  schema: string
  header: { app_id: string; event_id: string; event_type: string }
  event: {
    sender: { sender_type: string; sender_id?: { open_id?: string } }
    message: {
      message_id: string; chat_id: string; chat_type: string; message_type?: unknown; content?: unknown
      parent_id?: string
      mentions?: { id: { open_id?: string } }[]
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
  if (payload.schema !== '2.0' || header.event_type !== 'im.message.receive_v1' || header.app_id !== application.appId) feishuFailure('FEISHU_EVENT_IDENTITY_MISMATCH')
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

export function projectFeishuMessage(payload: FeishuMessageEvent, application: ConnectionApplication, botOpenId: string): VerifiedIngressEvent {
  const { message, sender } = payload.event
  if (sender.sender_type !== 'user' || message.chat_type !== 'group') feishuFailure('FEISHU_EVENT_OUTSIDE_SCOPE')
  let body = '', unsupported = message.message_type !== 'text' || typeof message.content !== 'string'
  if (!unsupported) {
    try { body = feishuTextBody(message.content as string) } catch { unsupported = true }
  }
  const mentioned = message.mentions?.some(mention => mention.id.open_id === botOpenId) ?? false
  return {
    eventId: payload.header.event_id, messageId: message.message_id, externalConversationId: message.chat_id,
    actor: { application: { ...application }, idType: 'open_id', userId: feishuIdentity(sender.sender_id?.open_id) },
    body, selection: mentioned ? 'mention' : 'message',
    ...(message.parent_id === undefined ? {} : { replyToMessageId: message.parent_id }),
    ...(unsupported ? { unsupportedContent: true as const } : {})
  }
}
