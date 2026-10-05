import type { SessionSnapshot } from '../../../shared/contracts'
import type { ContinuousProgressInputRequest, ContinuousProgressInputResult } from '../../../shared/continuous-progress'
import { agentSessionPresentationIndex } from './session-presentation'

/** Request-only projection of the existing input owners. No body or duplicated input state. */
export function readContinuousProgressInput(state: {
  loading: boolean
  sessions: SessionSnapshot[]
  agentComposerDrafts: Record<string, string>
  agentSteerQueues: Record<string, readonly unknown[]>
  agentSteerInFlight: Record<string, string>
}, request: ContinuousProgressInputRequest, signal: AbortSignal): ContinuousProgressInputResult {
  if (signal.aborted || state.loading) throw Object.assign(new Error('User input observation is not ready.'), { code: 'CONTROL_UNAVAILABLE' })
  const control = request.control
  const matches = (agentSessionPresentationIndex(state.sessions).get(control.agentSessionId) ?? []).filter(session =>
    session.control.agentSessionId === control.agentSessionId && session.hostId === control.hostId && session.control.hostId === control.hostId && session.control.run.runId === control.run.runId)
  const session = matches.length === 1 ? matches[0] : undefined
  if (!session) throw Object.assign(new Error('User input observation has an unconfirmed or ambiguous Session, Host or Run.'), { code: 'CONTROL_UNAVAILABLE' })
  return { operation: request.operation, control: session.control,
    occupied: Boolean(state.agentComposerDrafts[session.id]?.trim() || state.agentSteerQueues[session.id]?.length || state.agentSteerInFlight[session.id]) }
}
