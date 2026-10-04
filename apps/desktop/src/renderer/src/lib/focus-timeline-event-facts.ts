import { formatDuration } from '@agentmux/client-ui/conversation-time'
import type { AgentFocusHistoryIdentity } from './agent-focus'
import type { FocusTimeSegment } from './focus-time-window'
import type { FocusWorkInterval } from './focus-work-history'
import type { FocusTimeFormatters } from './focus-timeline-ruler'

/** A disposable description of facts already in this track, never a history read. */
export type FocusTimelineEventFacts = {
  kind: 'work' | 'focus' | 'live' | 'gap'
  name: string
  event: string
  time: string
  duration?: string
  project: string
  note: string
}

const known = (value: number | null | undefined): value is number => value != null && Number.isFinite(value)
const stamp = (value: number | null | undefined, time: FocusTimeFormatters) => known(value) ? time.detailed(value) : 'Time not recorded'

export function focusVisitFacts(segment: FocusTimeSegment, time: FocusTimeFormatters): FocusTimelineEventFacts {
  const bounded = known(segment.focusedAt) && known(segment.end) && segment.end >= segment.focusedAt
  return {
    kind: 'focus', name: segment.identity?.name ?? 'Retained Context', event: 'Focus visit',
    time: `${stamp(segment.focusedAt, time)} → ${known(segment.end) ? stamp(segment.end, time) : 'Next focus not recorded'}`,
    ...(bounded ? { duration: formatDuration(segment.end! - segment.focusedAt) } : {}),
    project: segment.identity?.project ? `Observed project · ${segment.identity.project.name}` : 'Project not recorded',
    note: 'Focus record · Until the next recorded focus, not Run duration'
  }
}

export function focusWorkingFacts(segment: Pick<FocusWorkInterval, 'startAt' | 'startKnown' | 'endAt' | 'end'>, time: FocusTimeFormatters, identity: AgentFocusHistoryIdentity | undefined,
  current: { name: string; project?: string | undefined } | undefined, now: number): FocusTimelineEventFacts {
  const active = segment.end === 'current' && current !== undefined
  const through = active ? now : segment.endAt
  const complete = segment.end === 'state-change' || segment.end === 'run-ended' || active
  const bounded = complete && known(segment.startAt) && known(through) && through >= segment.startAt
  const endings = { 'state-change': 'State changed', 'run-ended': 'Run ended', 'observation-gap': 'Observation gap', unknown: 'End not recorded', current: 'Currently working' }
  return {
    kind: 'work', name: active ? current.name : identity?.name ?? (current ? `${current.name} · Current Context` : 'Recorded Context'),
    event: 'Working observation',
    time: `${segment.startKnown ? 'Started' : 'Observed'} ${stamp(segment.startAt, time)} → ${active ? 'Now' : known(segment.endAt) ? stamp(segment.endAt, time) : 'End not recorded'}`,
    ...(bounded ? { duration: `${segment.startKnown ? '' : 'Observed for at least '}${formatDuration(through! - segment.startAt)}` } : {}),
    project: active && current.project ? `Current project · ${current.project}` : identity?.project ? `Observed Context project · ${identity.project.name}` : 'Project not recorded',
    note: `${endings[segment.end]}${segment.startKnown ? '' : ' · Start not recorded'} · State observation, not Run duration`
  }
}

export function focusLiveFacts(name: string, state: string | undefined, project: string | undefined, now: number, time: FocusTimeFormatters): FocusTimelineEventFacts {
  return { kind: 'live', name, event: 'Run online now', time: stamp(now, time),
    project: project ? `Current project · ${project}` : 'Current project not recorded',
    note: `${state ?? 'Activity not recorded'} · Run start not recorded` }
}

export function focusGapFacts(name: string, at: number | undefined, time: FocusTimeFormatters): FocusTimelineEventFacts {
  return { kind: 'gap', name, event: 'Observation gap', time: stamp(at, time), project: 'Project not recorded',
    note: 'Working start and end not recorded · This does not prove inactivity' }
}
