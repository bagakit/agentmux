import type { SessionSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { SCRATCH_WORKSPACE_ID, type ScratchTopicSnapshot } from '../../../shared/scratch-topics'
import {
  attentionSortClass,
  attentionSortRank,
  categoryFor,
  isUrgentAttention,
  type AttentionCategory
} from './attention-event'
import { workingAgentCount } from './project-board'

export type ActivityContextKind = 'topic' | 'branch' | 'worktree' | 'unassigned'

export type ActivityContextInput = {
  id: string
  kind: Exclude<ActivityContextKind, 'unassigned'>
  label: string
  hostId: string
  path: string
}

export type ActivityGroup = {
  key: string
  id: string | null
  kind: ActivityContextKind
  label: string
  hostId: string | null
  path: string | null
  sessions: Extract<SessionSnapshot, { kind: 'agent' }>[]
}

/** A short, explicit noun for the context shown in an Activity row. */
export const ACTIVITY_CONTEXT_KIND_LABEL: Record<ActivityContextKind, string> = {
  topic: 'Topic',
  branch: 'Branch',
  worktree: 'Worktree',
  unassigned: 'Unassigned'
}

function pathTail(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

// Build the context facts Activity can use without inventing a registry. Project workspaces are
// branch/worktree contexts; Scratch topics come from the filesystem snapshot. Matching still happens
// by host + path, so an identically named branch on another host never merges into this one.
export function activityContextsForWorkspaces(
  workspaces: readonly WorkspaceRecord[],
  topics: readonly ScratchTopicSnapshot[] = []
): ActivityContextInput[] {
  const contexts: ActivityContextInput[] = []
  for (const workspace of workspaces) {
    if (workspace.id === SCRATCH_WORKSPACE_ID) {
      for (const topic of topics) {
        contexts.push({
          id: topic.id,
          kind: 'topic',
          label: topic.title || pathTail(topic.directoryPath),
          hostId: workspace.hostId,
          path: topic.directoryPath
        })
      }
      continue
    }
    contexts.push({
      id: workspace.id,
      kind: workspace.branch ? 'branch' : 'worktree',
      label: workspace.branch || pathTail(workspace.path),
      hostId: workspace.hostId,
      path: workspace.path
    })
  }
  return contexts
}

function groupAttention(sessions: readonly Extract<SessionSnapshot, { kind: 'agent' }>[]): AttentionCategory | null {
  let winner: AttentionCategory | null = null
  for (const session of sessions) {
    const category = categoryFor(session.status.state)
    // Same exclusion as the rail and the fan-out strip, read from the one list that owns it.
    if (!isUrgentAttention(category)) continue
    if (!winner || attentionSortRank(category) < attentionSortRank(winner)) winner = category
  }
  return winner
}

// Project the sessions under a navigation row into compact work-line groups. A Session is matched
// only to an explicit context; anything else is honestly kept in one visible “Unassigned” group.
export function buildActivityGroups(
  sessions: readonly SessionSnapshot[],
  contexts: readonly ActivityContextInput[] = []
): ActivityGroup[] {
  const agents = sessions.filter((session): session is Extract<SessionSnapshot, { kind: 'agent' }> => session.kind === 'agent')
  const contextByLocation = new Map(contexts.map((context) => [`${context.hostId}\u0000${context.path}`, context]))
  const grouped = new Map<string, ActivityGroup>()
  for (const session of agents) {
    const context = contextByLocation.get(`${session.hostId}\u0000${session.workspacePath}`)
    // An unbound Session has no honest path-based identity. It may still be grouped with other
    // unbound Sessions on the same Host, but never across Hosts: a single "Unassigned" row spanning
    // two machines would hide where a click will take the user.
    const key = context
      ? `${context.hostId}\u0000${context.kind}\u0000${context.id}`
      : `unassigned\u0000${session.hostId}`
    const current = grouped.get(key)
    if (current) current.sessions.push(session)
    else {
      grouped.set(key, {
        key,
        id: context?.id ?? null,
        kind: context?.kind ?? 'unassigned',
        label: context?.label ?? 'Unassigned',
        hostId: context?.hostId ?? session.hostId,
        path: context?.path ?? null,
        sessions: [session]
      })
    }
  }
  const groups = [...grouped.values()]
  for (const group of groups) {
    group.sessions.sort((left, right) => {
      const leftRank = attentionSortRank(attentionSortClass(left.status.state))
      const rightRank = attentionSortRank(attentionSortClass(right.status.state))
      return leftRank - rightRank || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)
    })
  }
  return groups.sort((left, right) => {
    const leftAttention = groupAttention(left.sessions)
    const rightAttention = groupAttention(right.sessions)
    const leftRank = leftAttention ? attentionSortRank(leftAttention) : workingAgentCount(left.sessions) > 0 ? attentionSortRank('working') : attentionSortRank('idle')
    const rightRank = rightAttention ? attentionSortRank(rightAttention) : workingAgentCount(right.sessions) > 0 ? attentionSortRank('working') : attentionSortRank('idle')
    return leftRank - rightRank || (right.sessions[0]?.updatedAt ?? 0) - (left.sessions[0]?.updatedAt ?? 0) || left.label.localeCompare(right.label)
  })
}
