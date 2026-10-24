import { turnWorking } from './activity-working-state.js'
import { isNeedsYouState } from './attention-vocabulary.js'
import type { AgentDisplayState, AgentMuxRunState, AgentStatus } from '@agentmux/core'
import type { AgentObservation } from '@agentmux/core/agent-status'

export type AgentPresentationFacts = {
  kind: 'agent' | 'terminal'; processState: AgentMuxRunState
  status: Pick<AgentStatus, 'state' | 'detail'> & { exitReason?: string }
  runUnobserved?: boolean; pendingInteraction?: unknown; currentActivity?: unknown
}
export type AgentPresentationBucket = 'attention' | 'working' | 'results' | 'idle'
/** Presentation consumes typed Core facts. It never qualifies input or controls a Run. */
export function agentPresentationBucket(session: AgentPresentationFacts, observation: AgentObservation | undefined,
  hasCurrentResult: boolean): AgentPresentationBucket {
  const state = session.status.state
  if (session.pendingInteraction || isNeedsYouState(state) || state === 'error') return 'attention'
  if (session.runUnobserved || session.processState !== 'running') return 'idle'
  if (observation?.semantic === 'active' || turnWorking(state) && (state === 'starting' || session.kind !== 'agent')) return 'working'
  if (hasCurrentResult && state === 'done' && !session.currentActivity) return 'results'
  return 'idle'
}
export function agentStatusLabel(session: Pick<AgentPresentationFacts, 'kind' | 'status' | 'pendingInteraction'>): string {
  const state = session.status.state
  return state === 'error' ? 'Failed' : session.pendingInteraction ? 'Request pending'
    : state === 'blocked' ? 'Blocked' : state === 'waiting' ? 'Needs reply'
      : state === 'done' ? 'Idle' : state === 'running' ? session.kind === 'agent' ? 'Status unknown' : 'Shell open'
        : state === 'disconnected' ? 'Disconnected' : state === 'exited' ? session.kind === 'terminal' && session.status.exitReason !== 'user-stopped' ? 'Exited' : 'Stopped'
          : state === 'starting' ? 'Starting' : 'Working'
}
/** Explanatory copy only; a historical work signal cannot prove current activity. */
export function activityObservationPresentation(observation: AgentObservation, observationAvailable = true): { label: string; detail: string } | null {
  if (!observation.reason) return null
  const last = observation.lastKnownActivity
  const confirmed = last ? `Last confirmed ${last.state} · ${new Date(last.observedAt).toLocaleString()}` : 'Last confirmed activity unavailable'
  return { label: observation.reason === 'activity-stale' ? 'Activity signal expired' : 'Activity not confirmed',
    detail: `${observation.reason === 'activity-stale' ? 'The last work signal is out of date; current work is unknown' : 'No current work signal has been received'} · ${confirmed} · ${observationAvailable
      ? `Run ${observation.process} · Prompt readiness ${observation.readiness}` : `Last observed Run ${observation.process} · Current input availability unconfirmed`}` }
}
export function agentPresentationState(session: AgentPresentationFacts, observation: AgentObservation | undefined,
  hasCurrentResult: boolean): { bucket: AgentPresentationBucket; state: AgentDisplayState; stateLabel: string } {
  const bucket = agentPresentationBucket(session, observation, hasCurrentResult), activity = observation?.semantic
  const stateLabel = session.runUnobserved && bucket === 'idle' ? 'Run not observed'
    : session.processState === 'interrupted' && bucket === 'idle' ? 'Interrupted'
      : session.processState === 'running' && bucket === 'idle' && activity === 'unknown'
        ? activityObservationPresentation(observation!)?.label ?? 'Activity not confirmed'
        : session.processState === 'running' && bucket === 'idle' && activity === 'unsupported' ? 'Activity not reported'
          : session.processState === 'running' && bucket === 'idle' && activity === 'idle' ? 'Idle'
            : bucket === 'working' && activity === 'active' ? 'Working' : agentStatusLabel(session)
  const state = bucket === 'working' && activity === 'active' ? 'working'
    : session.status.state === 'working' && activity !== 'active' || bucket === 'idle' && activity === 'idle' && session.currentActivity ? 'running' : session.status.state
  return { bucket, state, stateLabel }
}
