import type { SessionSnapshot } from '../../../shared/contracts'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useSessionStop } from './SessionStop'

const CloseIcon = semanticIconComponent('action.close')

/** Closing a retained Agent still uses the original Core Stop/retirement owner. */
export function AgentCloseAction({ session, className = 'small-button' }: {
  session: Extract<SessionSnapshot, { kind: 'agent' }>; className?: string
}) {
  const stop = useSessionStop()
  return <><button type="button" className={className}
    onClick={event => stop.requestStop(session, session.label, event.currentTarget)}><CloseIcon size={12} /> Close Agent</button>{stop.dialog}</>
}
