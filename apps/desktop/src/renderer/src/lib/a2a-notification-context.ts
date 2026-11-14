import { firstPromptFromTimeline } from '@agentmux/client-ui/display-name'
import type { AgentTimelineSnapshot, AppConfig, SessionSnapshot } from '../../../shared/contracts'
import { a2aNotificationPresentation } from '../../../shared/a2a-preferences'
import { agentSessionPresentationIndex } from './session-presentation'
import type { A2ANotificationContext, A2ANotificationTarget } from './a2a-message-notifier'

/** Client facts are borrowed only while resolving this arrival's two original participants. */
export function a2aNotificationContext(snapshot: {
  ready: boolean; config: AppConfig | null; sessions: readonly SessionSnapshot[]
  windowFocused: boolean; visibleSessionIds: ReadonlySet<string>
  agentNames: Readonly<Record<string, string>>; timelines: Readonly<Record<string, AgentTimelineSnapshot>>
}, target: A2ANotificationTarget): A2ANotificationContext | null {
  if (!snapshot.ready) return null
  const presentation = a2aNotificationPresentation(snapshot.config)
  if (!presentation) return null
  const index = agentSessionPresentationIndex(snapshot.sessions)
  const matches = (id: string) => index.get(id)?.filter(session => session.hostId === target.hostId && session.control.agentSessionId === id) ?? []
  const recipients = matches(target.recipientSessionId), recipient = recipients[0]
  if (!recipient || snapshot.windowFocused && recipients.some(session => snapshot.visibleSessionIds.has(session.id))) return null
  const participant = (session: SessionSnapshot | undefined, sessionId: string) => ({ sessionId, fallback: session?.label ?? sessionId,
    userName: session ? snapshot.agentNames[session.id] : undefined, firstPrompt: session ? firstPromptFromTimeline(snapshot.timelines[session.id]) : undefined })
  return { sessionId: recipient.id, ...presentation, recipient: participant(recipient, target.recipientSessionId),
    sender: participant(matches(target.senderSessionId)[0], target.senderSessionId) }
}
