import type { AgentMuxRpcResult } from '@agentmux/core'
import type { AgentAttentionNotifyInput, RuntimeEvent, SessionHistoryReference, SessionMessagePageOptions } from '../../../shared/contracts'
import { composeA2AMessageNotification } from './a2a-notification-presentation'

export type A2ANotificationTarget = {
  hostId: string; senderSessionId: string; recipientSessionId: string
}
export type A2ANotificationContext = Pick<AgentAttentionNotifyInput, 'sessionId' | 'mode' | 'sound'> &
  Pick<Parameters<typeof composeA2AMessageNotification>[0], 'sender' | 'recipient'>

type MessageReader = (reference: SessionHistoryReference, options: SessionMessagePageOptions) => Promise<AgentMuxRpcResult<'message.ls'>>

/** A bounded delivery watermark per Host, never a message or user-read Store. */
export function createA2AMessageNotifier(ports: {
  notify(input: AgentAttentionNotifyInput): Promise<unknown>
  listMessages: MessageReader
  current(target: A2ANotificationTarget): A2ANotificationContext | null
}) {
  const through = new Map<string, number>()
  let disposed = false
  return {
    dispose(): void { disposed = true; through.clear() },
    async observe(event: RuntimeEvent): Promise<void> {
      if (disposed) return
      const message = event.event
      if (message.type !== 'agent-message-changed') return
      const previous = through.get(event.hostId) ?? 0
      through.set(event.hostId, Math.max(previous, message.messageSequence))
      if (message.recordKind !== 'message' || !message.live || message.sequence !== message.messageSequence || message.messageSequence <= previous ||
        message.senderSessionId === message.recipientSessionId) return
      const target = { hostId: event.hostId, senderSessionId: message.senderSessionId, recipientSessionId: message.recipientSessionId }
      if (!ports.current(target)) return
      let preview: string | undefined
      // Read the exact original prefix without consuming or acknowledging the message.
      if (Number.isSafeInteger(message.messageSequence + 1)) try {
        const page = await ports.listMessages({ hostId: event.hostId, agentSessionId: message.recipientSessionId },
          { direction: 'incoming', beforeSequence: message.messageSequence + 1, limit: 1 })
        const original = page.messages[0]
        if (page.hostId === event.hostId && page.participantSessionId === message.recipientSessionId && page.direction === 'incoming' && page.messages.length === 1 &&
          original?.sequence === message.messageSequence && original.envelope.messageId === message.messageId &&
          original.envelope.senderSessionId === message.senderSessionId && original.envelope.recipientSessionId === message.recipientSessionId) preview = original.bodyPreview
      } catch { /* The banner names the unavailable preview instead of borrowing another message. */ }
      if (disposed) return
      const current = ports.current(target)
      if (!current) return
      await ports.notify({ sessionId: current.sessionId, ...composeA2AMessageNotification({ sender: current.sender, recipient: current.recipient, preview }),
        mode: current.mode, sound: current.sound })
    }
  }
}
