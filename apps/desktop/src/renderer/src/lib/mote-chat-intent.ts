import { parseMoteChatParams, type MoteChatAllocate, type MoteChatConfigure } from '@agentmux/core/mote-chat'

/** Original client input only; configuration, quota and receipts stay with the public chat owner. */
export type MoteChatIntent = (
  | { method: 'space.mote.chat.configure'; input: MoteChatConfigure }
  | { method: 'space.mote.chat.allocate'; input: MoteChatAllocate }
) & { phase: 'not-dispatched' | 'may-have-dispatched' }

export function restoredMoteChatIntents(value: unknown): Record<string, MoteChatIntent> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, MoteChatIntent> = {}
  for (const [key, raw] of Object.entries(value)) {
    try {
      const entry = raw as MoteChatIntent
      if (entry.method !== 'space.mote.chat.configure' && entry.method !== 'space.mote.chat.allocate') continue
      const input = parseMoteChatParams(entry.method, entry.input)
      if (key !== input.operationId) continue
      result[key] = { method: entry.method, input, phase: entry.phase === 'not-dispatched' ? 'not-dispatched' : 'may-have-dispatched' } as MoteChatIntent
    } catch { /* Invalid input correlation cannot dispatch a request or alter owner facts. */ }
  }
  return result
}
