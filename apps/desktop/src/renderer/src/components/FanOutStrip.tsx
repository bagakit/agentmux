import { GitCompareArrows } from 'lucide-react'
import type { SessionSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import {
  fanOutGroups,
  groupLaneNeedingYou,
  groupProgress,
  fanOutKeepSplit,
  type FanOutGroup,
  type FanOutLane
} from '../lib/fanout-group'
import { statusDotTier } from '../lib/attention-event'

// The bake-off strip above the Board.
//
// The Board answers "what is happening on each branch". After a fan-out the extra question is which
// branches are racing on the SAME prompt — otherwise the lanes sit scattered among every other branch
// and comparing them means hunting. This adds exactly that grouping and nothing else: each lane still
// shows the shared status vocabulary, and clicking one goes through the same selectSession the rest of
// the app uses. No third status treatment, no second navigation path.
//
// Absent when there is nothing to compare: a repo with no fan-out renders no strip at all.

// The lane's attention, expressed in the shared status vocabulary so the dot carries it.
//
// This is the lane's ONLY attention mark, deliberately. It used to also emit `data-attention` on the
// chip itself — an attribute no stylesheet ever read, so it painted nothing while looking like the
// signal was handled. Deleting it rather than adding a rule for it: `waiting` and `error` already put
// amber and red into `--status-ink` (the status vocabulary in chrome.css), and amber additionally
// carries a `?` pip so needs-you survives colour-blindness. A second mark on the same chip would be
// the same fact twice, which is what the Project Rail's "one signal per row" rule exists to prevent.
//
// Which tier is decided in `attention-event.ts`, shared with the roster row. A lane with no Session
// has no liveness to report, so it passes a null state and gets the resting dot.
function laneState(lane: FanOutLane): ReturnType<typeof statusDotTier> {
  return statusDotTier(lane.session?.status.state ?? null)
}

function LaneChip({
  lane,
  onSelect,
  onKeep,
  loserCount
}: {
  lane: FanOutLane
  onSelect: (sessionId: string) => void
  // Absent when the group has only one lane: keeping the only lane tears down nothing.
  onKeep?: (() => void) | undefined
  loserCount: number
}) {
  const state = laneState(lane)
  // A lane whose Agent never launched has nothing to select. It still renders — it is part of the set,
  // and hiding it would make the group look smaller than it is — but as a non-interactive marker.
  const sessionId = lane.session?.id ?? null
  const label = lane.session
    ? `${lane.branch} · ${lane.attention ?? lane.session.status.state}`
    : `${lane.branch} · no agent`
  // Say what the action does to the OTHERS, not just to this lane: "keep" alone hides that the rest are
  // about to be torn down, which is the consequential half of the decision.
  const keepLabel = `Keep ${lane.branch} and remove the other ${loserCount}`
  // A lane with no Agent is still a legitimate winner — its worktree exists and can be continued in.
  const keep = onKeep ? (
    <button
      className="fanout-lane__keep"
      type="button"
      aria-label={keepLabel}
      title={keepLabel}
      onClick={onKeep}
    >
      Keep
    </button>
  ) : null

  if (!sessionId) {
    return (
      <span className="fanout-lane fanout-lane--idle" title={`${lane.branch} — no Agent running`}>
        <span className="status" aria-hidden="true"><span className="status__dot" /></span>
        <span className="fanout-lane__branch">{lane.branch}</span>
        {keep}
      </span>
    )
  }

  return (
    <span className="fanout-lane-slot">
      <button
        className="fanout-lane"
        type="button"
        aria-label={label}
        title={label}
        onClick={() => onSelect(sessionId)}
      >
        <span className={state ? `status status--${state}` : 'status'} aria-hidden="true">
          <span className="status__dot" />
        </span>
        <span className="fanout-lane__branch">{lane.branch}</span>
      </button>
      {keep}
    </span>
  )
}

function GroupRow({
  group,
  onSelect,
  onKeepLane
}: {
  group: FanOutGroup
  onSelect: (sessionId: string) => void
  onKeepLane?: ((keepWorkspaceId: string, removeWorkspaceIds: string[]) => void) | undefined
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
          <LaneChip
            key={lane.workspaceId}
            lane={lane}
            onSelect={onSelect}
            loserCount={group.lanes.length - 1}
            {...(onKeepLane && group.lanes.length > 1
              ? {
                  onKeep: () => {
                    const split = fanOutKeepSplit(group, lane.workspaceId)
                    if (split) onKeepLane(split.keepWorkspaceId, split.removeWorkspaceIds)
                  }
                }
              : {})}
          />
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
  onSelectSession,
  onKeepLane
}: {
  workspaces: readonly WorkspaceRecord[]
  sessions: readonly SessionSnapshot[]
  onSelectSession: (sessionId: string) => void
  onKeepLane?: ((keepWorkspaceId: string, removeWorkspaceIds: string[]) => void) | undefined
}) {
  const groups = fanOutGroups({ workspaces, sessions })
  if (groups.length === 0) return null

  return (
    <div className="fanout-strip" role="group" aria-label="Fan-out comparisons">
      {groups.map((group) => (
        <GroupRow
          key={group.stem}
          group={group}
          onSelect={onSelectSession}
          {...(onKeepLane ? { onKeepLane } : {})}
        />
      ))}
    </div>
  )
}
