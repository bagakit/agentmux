import type { ConnectionApplication } from '@agentmux/core/connections'
import type { VerifiedIngressAction } from '../../durable-ingress.js'
import { feishuFailure, feishuIdentity } from './message.js'

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
function identity(value: unknown): string | undefined {
  try { return feishuIdentity(value) } catch { return undefined }
}
/** Authentication belongs to the private SDK witness. Unsupported fields remain complete in raw. */
export function readFeishuAction(raw: string, application: ConnectionApplication): VerifiedIngressAction | null {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return feishuFailure('FEISHU_EVENT_INVALID') }
  const payload = object(parsed), header = object(payload?.header)
  if (header?.event_type !== 'card.action.trigger') return null
  if (payload?.schema !== '2.0' || header.app_id !== application.appId) feishuFailure('FEISHU_EVENT_IDENTITY_MISMATCH')
  const event = object(payload.event), operator = object(event?.operator), context = object(event?.context)
  const userId = identity(operator?.open_id), externalConversationId = identity(context?.open_chat_id), sourceMessageId = identity(context?.open_message_id)
  const actionRef = identity(object(object(event?.action)?.value)?.actionRef)
  return { kind: 'action', eventId: feishuIdentity(header.event_id),
    ...(userId === undefined ? {} : { actor: { application: { ...application }, idType: 'open_id', userId } }),
    ...(externalConversationId === undefined ? {} : { externalConversationId }),
    ...(sourceMessageId === undefined ? {} : { sourceMessageId }), ...(actionRef === undefined ? {} : { actionRef }) }
}
