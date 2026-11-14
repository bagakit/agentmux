import type { AgentAttentionNotifyInput, AgentMuxDesktopApi, AgentTimelineSnapshot, AppConfig, RuntimeEvent, SessionSnapshot } from '../../../shared/contracts'
import { firstPromptFromTimeline } from '@agentmux/client-ui/display-name'
import { a2aNotificationPresentation } from '../../../shared/a2a-preferences'
import { agentSessionPresentationIndex } from './session-presentation'
import { composeA2AMessageNotification } from './a2a-notification-presentation'

export type A2ANotificationSnapshot = {
  config: AppConfig | null; sessions: readonly SessionSnapshot[]; ready: boolean
  windowFocused: boolean; visibleSessionIds: ReadonlySet<string>
  agentNames: Readonly<Record<string, string>>; timelines: Readonly<Record<string, AgentTimelineSnapshot>>
}
type Arrival = Extract<RuntimeEvent['event'], { type: 'agent-message-changed' }>
function target(snapshot: A2ANotificationSnapshot, hostId: string, message: Arrival) {
  if (!snapshot.ready) return null
  const presentations = agentSessionPresentationIndex(snapshot.sessions)
  const recipient = presentations.get(message.recipientSessionId)?.find(session => session.hostId === hostId && session.control.agentSessionId === message.recipientSessionId)
  if (!recipient || snapshot.windowFocused && snapshot.visibleSessionIds.has(recipient.id)) return null
  const presentation = a2aNotificationPresentation(snapshot.config)
  return presentation ? { recipient, sender: presentations.get(message.senderSessionId)?.find(session => session.hostId === hostId && session.control.agentSessionId === message.senderSessionId), presentation } : null
}

/** A bounded delivery watermark per Host, not a message or user-read Store. */
export function createA2AMessageNotifier(ports: {
  notify(input: AgentAttentionNotifyInput): Promise<unknown>
  listMessages: AgentMuxDesktopApi['sessions']['listMessages']
  snapshot(): A2ANotificationSnapshot
}) {
  const through = new Map<string, number>()
  return {
    async observe(event: RuntimeEvent): Promise<void> {
      const message = event.event
      if (message.type !== 'agent-message-changed') return
      const previous = through.get(event.hostId) ?? 0
      through.set(event.hostId, Math.max(previous, message.messageSequence))
      if (message.recordKind !== 'message' || !message.live || message.sequence !== message.messageSequence || message.messageSequence <= previous ||
        message.senderSessionId === message.recipientSessionId) return
      if (!target(ports.snapshot(), event.hostId, message)) return
      let preview: string | undefined
      // The existing participant index yields one bounded original prefix. A missing/mismatched
      // row never borrows the neighboring message, and this read marks nothing consumed or read.
      if (Number.isSafeInteger(message.messageSequence + 1)) try {
        const page = await ports.listMessages({ hostId: event.hostId, agentSessionId: message.recipientSessionId },
          { direction: 'incoming', beforeSequence: message.messageSequence + 1, limit: 1 })
        const original = page.messages[0]
        if (page.hostId === event.hostId && page.participantSessionId === message.recipientSessionId && page.direction === 'incoming' && page.messages.length === 1 &&
          original?.sequence === message.messageSequence && original.envelope.messageId === message.messageId &&
          original.envelope.senderSessionId === message.senderSessionId && original.envelope.recipientSessionId === message.recipientSessionId) preview = original.bodyPreview
      } catch { /* The banner retains the arrival and explicitly names its unavailable preview. */ }
      // A read can outlive visibility, preferences or the original subscription. Recheck those
      // exact current facts without turning a durable Session's Run replacement into a refusal.
      const snapshot = ports.snapshot(), current = target(snapshot, event.hostId, message)
      if (!current) return
      const participant = (session: SessionSnapshot | undefined, sessionId: string) => ({ sessionId, fallback: session?.label ?? sessionId,
        userName: session ? snapshot.agentNames[session.id] : undefined, firstPrompt: session ? firstPromptFromTimeline(snapshot.timelines[session.id]) : undefined })
      await ports.notify({ sessionId: current.recipient.id, ...composeA2AMessageNotification({
        sender: participant(current.sender, message.senderSessionId), recipient: participant(current.recipient, message.recipientSessionId), preview
      }), ...current.presentation })
    }
  }
}
