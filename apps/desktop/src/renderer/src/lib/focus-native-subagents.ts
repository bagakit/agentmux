import { agentEvidenceStale } from '@agentmux/core/agent-status'
import type { SessionSnapshot } from '../../../shared/contracts'
import { canObserveCurrentSubagents, nativeSubagentRefreshDelay, observedNativeSubagents } from './agent-observation'

export const SUBAGENT_LABELS = {
  waiting: 'Waiting for input', failed: 'Failed', running: 'Running',
  completed: 'Completed', interrupted: 'Interrupted', refused: 'Refused', unknown: 'Status unknown',
} as const
type ChildState = keyof typeof SUBAGENT_LABELS
type AgentSnapshot = Extract<SessionSnapshot, { kind: 'agent' }>
type Roster = NonNullable<AgentSnapshot['nativeSubagents']>

export type FocusNativeSubagents = {
  rows: ReadonlyArray<{ id: string; state: ChildState; waitingFor?: 'question' | 'permission' }>
  summary: string
  coverageUnknown: boolean
  refreshAt: number
}

const held = new WeakMap<Roster, { current: boolean; projection: FocusNativeSubagents }>()

function displayState(child: Roster['sessions'][number], current: boolean, now: number): ChildState {
  if (child.phase === 'ended') return child.outcome ?? (child.state === 'done' ? 'completed' : child.state === 'error' ? 'failed' : 'unknown')
  if (!current) return 'unknown'
  if (child.state === 'waiting') return 'waiting'
  return child.state === 'working' && !agentEvidenceStale(child, now) ? 'running' : 'unknown'
}

/** One presentation of the held Core roster for both the task row and its Quick Look. */
export function focusNativeSubagents(session: AgentSnapshot, now: number): FocusNativeSubagents | undefined {
  const roster = observedNativeSubagents(session)
  if (!roster || (!roster.sessions.length && !roster.unconfirmed)) return undefined
  const current = canObserveCurrentSubagents(session), cached = held.get(roster)
  if (cached?.current === current && now < cached.projection.refreshAt) return cached.projection

  const counts = new Map<ChildState, number>()
  const rows = roster.sessions.map(child => {
    const state = displayState(child, current, now)
    counts.set(state, (counts.get(state) ?? 0) + 1)
    return { id: child.nativeAgentId, state, ...(state === 'waiting' && child.waitingFor ? { waitingFor: child.waitingFor } : {}) }
  })
  const summary = (Object.keys(SUBAGENT_LABELS) as ChildState[]).flatMap(state => {
    const count = counts.get(state)
    return count ? `${count} ${state}` : []
  })
  if (roster.unconfirmed) summary.push('Coverage unknown')
  const delay = nativeSubagentRefreshDelay(session, now)
  const projection = { rows, summary: summary.join(' · '), coverageUnknown: roster.unconfirmed, refreshAt: delay ? now + delay : Infinity }
  held.set(roster, { current, projection })
  return projection
}
