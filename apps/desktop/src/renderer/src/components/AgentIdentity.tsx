import type { AgentAvatarAppearance, SessionSnapshot } from '../../../shared/contracts'
import { AgentAvatar } from './AgentAvatar'

/** Composer identity uses the same disclosure as tabs, trees and every other Executor surface. */
export function AgentIdentity({ session, name, appearance }: {
  session: Extract<SessionSnapshot, { kind: 'agent' }>
  name: string
  executorLabel: string
  appearance?: AgentAvatarAppearance | undefined
}) {
  return <span className="composer-agent-identity"><AgentAvatar sessionId={session.id} executorId={session.executorId}
    providerId={session.providerId} state={session.status.state} detail={session.status.detail} label={name} appearance={appearance} /></span>
}
