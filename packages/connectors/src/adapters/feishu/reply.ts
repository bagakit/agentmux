import type { ConnectionApplication } from '@agentmux/core/connections'
import { feishuIdentity } from './message.js'

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
/** Interpret only the exact parent returned by the original authenticated message read. No display field grants reply scope. */
export function feishuParentAddressing(response: unknown, application: ConnectionApplication, parentId: string, chatId: string): 'reply' | 'message' | 'unknown' {
  const result = object(response), data = object(result?.data)
  if (result?.code !== 0 || !Array.isArray(data?.items)) return 'unknown'
  const parents = data.items.map(object).filter(item => item?.message_id === parentId)
  if (parents.length !== 1) return 'unknown'
  const parent = parents[0]!
  if (parent.chat_id !== chatId || parent.deleted === true || parent.deleted !== undefined && typeof parent.deleted !== 'boolean') return 'unknown'
  const sender = object(parent.sender)
  if (!sender) return 'unknown'
  try { feishuIdentity(sender.id) } catch { return 'unknown' }
  if (sender.sender_type === 'app' && sender.id_type === 'app_id') return sender.id === application.appId ? 'reply' : 'message'
  if (sender.sender_type === 'user' && typeof sender.id_type === 'string' && ['open_id', 'user_id', 'union_id'].includes(sender.id_type)) return 'message'
  return 'unknown'
}
