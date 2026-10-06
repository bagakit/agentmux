import type { AgentSessionControl, SessionSnapshot } from '../../../shared/contracts'
import type { ContinuousProgressInputRequest, ContinuousProgressInputResult } from '../../../shared/continuous-progress'
import { agentSessionPresentationIndex } from './session-presentation'
import { pendingSteerInput } from './steer-queue-delivery'

export type AgentInputOccupationState = {
  loading: boolean
  sessions: SessionSnapshot[]
  agentComposerDrafts: Record<string, string>
  agentSteerQueues: Record<string, readonly (Parameters<typeof pendingSteerInput>[0] & { operationId: string })[]>
  agentSteerInFlight: Record<string, string>
}

/** Both observation and change notification read the same existing input owners. */
export function agentInputOccupied(state: AgentInputOccupationState, sessionId: string): boolean {
  const queue = state.agentSteerQueues[sessionId] ?? []
  const inFlight = state.agentSteerInFlight[sessionId]
  const original = inFlight ? queue.find(entry => entry.operationId === inFlight) : undefined
  return Boolean(state.agentComposerDrafts[sessionId]?.trim() || queue.some(pendingSteerInput) ||
    inFlight && (!original || pendingSteerInput(original)))
}

/** One lifecycle subscription; unrelated Runtime events do not read the Session index. */
export function observeAgentInputOccupation(store: {
  subscribe(listener: (state: AgentInputOccupationState, previous: AgentInputOccupationState) => void): () => void
}, notify: (control: AgentSessionControl) => Promise<void>, onFailure: (error: unknown) => void): () => void {
  return store.subscribe((state, previous) => {
    const changed = new Set<string>()
    for (const key of ['agentComposerDrafts', 'agentSteerQueues', 'agentSteerInFlight'] as const) {
      if (state[key] === previous[key]) continue
      for (const id of new Set([...Object.keys(previous[key]), ...Object.keys(state[key])])) {
        if (state[key][id] !== previous[key][id]) changed.add(id)
      }
    }
    if (!changed.size) return
    const sessions = agentSessionPresentationIndex(state.sessions)
    const notified = new Set<string>()
    for (const id of changed) {
      // Launcher drafts belong to Regions. Only an original Agent presentation owns this input.
      const matches = (sessions.get(id) ?? []).filter(session => session.id === id)
      const unknown = state.loading || matches.length !== 1 || matches.some(session => session.hostId !== session.control.hostId)
      if (!unknown && !agentInputOccupied(state, id)) continue
      for (const session of matches) {
        const control = session.control
        const ref = JSON.stringify([control.hostId, control.agentSessionId, control.run.runId])
        if (notified.has(ref)) continue
        notified.add(ref)
        try { void notify(control).catch(onFailure) }
        catch (error) { onFailure(error) }
      }
    }
  })
}

/** Request-only projection of the existing input owners. No body or duplicated input state. */
export function readContinuousProgressInput(state: AgentInputOccupationState,
  request: ContinuousProgressInputRequest, signal: AbortSignal): ContinuousProgressInputResult {
  if (signal.aborted || state.loading) throw Object.assign(new Error('User input observation is not ready.'), { code: 'CONTROL_UNAVAILABLE' })
  const control = request.control
  const matches = (agentSessionPresentationIndex(state.sessions).get(control.agentSessionId) ?? []).filter(session =>
    session.control.agentSessionId === control.agentSessionId && session.hostId === control.hostId && session.control.hostId === control.hostId && session.control.run.runId === control.run.runId)
  const session = matches.length === 1 ? matches[0] : undefined
  if (!session) throw Object.assign(new Error('User input observation has an unconfirmed or ambiguous Session, Host or Run.'), { code: 'CONTROL_UNAVAILABLE' })
  return { operation: request.operation, control: session.control,
    occupied: agentInputOccupied(state, session.id) }
}
