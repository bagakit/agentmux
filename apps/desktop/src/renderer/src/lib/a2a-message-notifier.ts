import type { AgentAttentionNotifyInput, AppConfig, RuntimeEvent, SessionSnapshot } from '../../../shared/contracts'
import { a2aNotificationPresentation } from '../../../shared/a2a-preferences'
import { agentSessionPresentationIndex } from './session-presentation'

/** A bounded delivery watermark per Host, not a message or user-read Store. */
export function createA2AMessageNotifier(notify: (input: AgentAttentionNotifyInput) => Promise<unknown>) {
  const through = new Map<string, number>()
  return {
    async observe({ event, config, sessions, ready, windowFocused, visibleSessionIds }: {
      event: RuntimeEvent; config: AppConfig | null; sessions: readonly SessionSnapshot[]; ready: boolean
      windowFocused: boolean; visibleSessionIds: ReadonlySet<string>
    }): Promise<void> {
      const message = event.event
      if (message.type !== 'agent-message-changed') return
      const previous = through.get(event.hostId) ?? 0
      through.set(event.hostId, Math.max(previous, message.messageSequence))
      if (message.recordKind !== 'message' || !ready || !message.live || message.sequence !== message.messageSequence || message.messageSequence <= previous ||
        message.senderSessionId === message.recipientSessionId) return
      const presentations = agentSessionPresentationIndex(sessions)
      const recipient = presentations.get(message.recipientSessionId)?.find(session => session.hostId === event.hostId)
      if (!recipient || windowFocused && visibleSessionIds.has(recipient.id)) return
      const presentation = a2aNotificationPresentation(config)
      if (!presentation) return
      const sender = presentations.get(message.senderSessionId)?.find(session => session.hostId === event.hostId)
      await notify({ sessionId: recipient.id, title: 'New Agent message',
        body: `${sender?.label ?? message.senderSessionId} → ${recipient.label}`, ...presentation })
    }
  }
}
