import { GitCompareArrows } from 'lucide-react'
import type { SessionSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import {
  fanOutGroups,
  groupLaneNeedingYou,
  groupProgress,
  type FanOutGroup,
  type FanOutLane
} from '../lib/fanout-group'

// The bake-off strip above the Board.
//
// The Board answers "what is happening on each branch". After a fan-out the extra question is which
// branches are racing on the SAME prompt — otherwise the lanes sit scattered among every other branch
// and comparing them means hunting. This adds exactly that grouping and nothing else: each lane still
// shows the shared status vocabulary, and clicking one goes through the same selectSession the rest of
// the app uses. No third status treatment, no second navigation path.
//
// Absent when there is nothing to compare: a repo with no fan-out renders no strip at all.

function laneState(lane: FanOutLane): 'working' | 'waiting' | 'error' | null {
  if (lane.attention === 'needs-you') return 'waiting'
  if (lane.attention === 'error') return 'error'
  if (!lane.session) return null
  return lane.session.status.state === 'working' ? 'working' : null
}

function LaneChip({
  lane,
  onSelect
}: {
  lane: FanOutLane
  onSelect: (sessionId: string) => void
}) {
  const state = laneState(lane)
  // A lane whose Agent never launched has nothing to select. It still renders — it is part of the set,
  // and hiding it would make the group look smaller than it is — but as a non-interactive marker.
  const sessionId = lane.session?.id ?? null
  const label = lane.session
    ? `${lane.branch} · ${lane.attention ?? lane.session.status.state}`
    : `${lane.branch} · no agent`

  if (!sessionId) {
    return (
      <span className="fanout-lane fanout-lane--idle" title={`${lane.branch} — no Agent running`}>
        <span className="status" aria-hidden="true"><span className="status__dot" /></span>
        <span className="fanout-lane__branch">{lane.branch}</span>
      </span>
    )
  }

  return (
    <button
      className="fanout-lane"
      type="button"
      {...(lane.attention ? { 'data-attention': lane.attention } : {})}
      aria-label={label}
      title={label}
      onClick={() => onSelect(sessionId)}
    >
      <span className={state ? `status status--${state}` : 'status'} aria-hidden="true">
        <span className="status__dot" />
      </span>
      <span className="fanout-lane__branch">{lane.branch}</span>
    </button>
  )
}

function GroupRow({
  group,
  onSelect
}: {
  group: FanOutGroup
  onSelect: (sessionId: string) => void
}) {
  const progress = groupProgress(group)
  const needsYou = groupLaneNeedingYou(group)
  return (
    <div className="fanout-group" data-stem={group.stem}>
      <div className="fanout-group__identity">
        <GitCompareArrows size={12} aria-hidden="true" />
        <strong>{group.stem}</strong>
        {/* One honest line: how many lanes, how many finished, how many want you. */}
        <small>
          {progress.total} lanes · {progress.done} done
          {progress.needsYou > 0 ? ` · ${progress.needsYou} need you` : ''}
          {progress.error > 0 ? ` · ${progress.error} failed` : ''}
        </small>
      </div>
      <div className="fanout-group__lanes">
        {group.lanes.map((lane) => (
          <LaneChip key={lane.workspaceId} lane={lane} onSelect={onSelect} />
        ))}
      </div>
      {needsYou?.session ? (
        <button
          className="fanout-group__jump"
          type="button"
          aria-label={`Go to ${needsYou.branch}, the lane waiting longest`}
          title="Go to the lane waiting longest"
          onClick={() => onSelect(needsYou.session!.id)}
        >
          Answer {needsYou.branch}
        </button>
      ) : null}
    </div>
  )
}

export function FanOutStrip({
  workspaces,
  sessions,
  onSelectSession
}: {
  workspaces: readonly WorkspaceRecord[]
  sessions: readonly SessionSnapshot[]
  onSelectSession: (sessionId: string) => void
}) {
  const groups = fanOutGroups({ workspaces, sessions })
  if (groups.length === 0) return null

  return (
    <div className="fanout-strip" role="group" aria-label="Fan-out comparisons">
      {groups.map((group) => (
        <GroupRow key={group.stem} group={group} onSelect={onSelectSession} />
      ))}
    </div>
  )
}
