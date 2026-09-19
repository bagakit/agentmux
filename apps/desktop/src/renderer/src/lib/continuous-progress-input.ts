import type { SessionSnapshot } from '../../../shared/contracts'
import type { ContinuousProgressInputRequest, ContinuousProgressInputResult } from '../../../shared/continuous-progress'
import { sessionPresentationById } from './session-presentation'

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
  const session = sessionPresentationById(state.sessions).get(control.agentSessionId)
  if (!session || session.kind !== 'agent' || session.control.hostId !== control.hostId ||
      session.control.run.runId !== control.run.runId) throw Object.assign(new Error('User input observation targets another Session or Run.'), { code: 'CONTROL_UNAVAILABLE' })
  return { operation: request.operation, control: session.control,
    occupied: Boolean(state.agentComposerDrafts[session.id]?.trim() || state.agentSteerQueues[session.id]?.length || state.agentSteerInFlight[session.id]) }
}
