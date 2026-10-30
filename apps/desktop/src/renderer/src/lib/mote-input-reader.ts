import type { MoteInputInspection } from '@agentmux/core'
import type { ClientUiPlatform, MoteInputNoticeOwner } from '@agentmux/client-ui/platform'
import type { SessionHistoryReference, SessionSnapshot } from '../../../shared/contracts'
import { agentSessionPresentationIndex } from './session-presentation'

/** The notice's original Host routes the member observation; current selection is irrelevant. */
export function createDesktopMoteInputReader(inspect: (reference: SessionHistoryReference, observationId: string) => Promise<MoteInputInspection | null>): NonNullable<ClientUiPlatform['readMoteInput']> {
  return (owner, memberAgentSessionId, observationId) => inspect({ hostId: owner.routeHostId, agentSessionId: memberAgentSessionId }, observationId)
}

/** Reuse the Store's cached canonical index, then qualify Host before reading a display name. */
export function desktopMoteMemberName(owner: MoteInputNoticeOwner, memberAgentSessionId: string, sessions: readonly SessionSnapshot[], names: Readonly<Record<string, string>>): string | undefined {
  const candidates = (agentSessionPresentationIndex(sessions).get(memberAgentSessionId) ?? []).filter(session =>
    session.control.hostId === owner.routeHostId && session.control.agentSessionId === memberAgentSessionId)
  const member = candidates.length === 1 ? candidates[0] : undefined
  return member ? names[member.id] ?? member.label : undefined
}
