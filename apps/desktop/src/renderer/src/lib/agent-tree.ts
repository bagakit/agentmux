import type { AgentCatalogEntry } from '@agentmux/core'
import type { SessionSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { workspaceOwnsSessionPath } from '../../../shared/scratch-topics'
import { attentionSortRank } from './attention-event'
import { sessionBoardColumn } from './project-board'
import { buildAgentRoster, type RosterRow } from './agent-roster'

// The project→Agent tree behind each status-bar count.
//
// The bar states HOW MANY Agents are in a class and, for needs-you/error, can jump to the ONE that has
// waited longest. That is the right answer to "who first" but the wrong shape for "show me everything in
// this state and where it lives". This is that second shape: the same enumerable rows the roster already
// builds, but bucketed by PROJECT (the Workspace that owns each Session's path) and narrowed to one
// attention class — so the working count opens the working agents grouped by project, needs-you opens
// the ones waiting on you, and so on.
//
// It reuses `buildAgentRoster` rather than re-deriving rows: a row's label, state, scope, usage and
// attention already have one definition, and this only regroups them. No new Store read, no second
// status machine.

export type AgentTreeFilter = 'all' | 'working' | 'needs-you' | 'error'

export type AgentTreeProject = {
  // Stable identity for React keys: the owning Workspace, or an unassigned bucket scoped to a Host so a
  // single "Unassigned" node never spans two machines and hides where a click lands.
  key: string
  // The Project's display name — the Workspace's own name (Scratch included, its name is "Scratch"), or
  // "Unassigned" for a Session whose path matches no Workspace. Never a guessed path fragment.
  name: string
  hostId: string
  rows: RosterRow[]
}

// A row's rank for ORDERING projects: its attention class, or idle for anything not waiting/broken.
// Working is intentionally NOT distinguished from idle here — project ordering only floats the urgent
// projects (needs-you above error above the rest); which non-urgent project sorts first is not a fact
// worth a second board-column read. The working NARROWING (below) is the one place that needs the board
// column, and it delegates to `sessionBoardColumn` rather than re-judging "is it running".
function rowRank(row: RosterRow): number {
  return row.attention ? attentionSortRank(row.attention) : attentionSortRank('idle')
}

function rowMatchesFilter(session: SessionSnapshot, row: RosterRow, filter: AgentTreeFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'needs-you') return row.attention === 'needs-you'
  if (filter === 'error') return row.attention === 'error'
  // filter === 'working'. The working count is the Board's working column (starting/running/working),
  // not `state === 'working'`. The tree under it must show exactly those Sessions or it disagrees with
  // the number above it — the #582 class. So it delegates to the one switch, it does not re-decide.
  return sessionBoardColumn(session) === 'working'
}

/**
 * Group the roster's rows into projects, narrowed to one attention class.
 *
 * Pure: Sessions and catalog in, tree out. "Project" is the Workspace that owns a Session's path
 * (`workspaceOwnsSessionPath`, the shared predicate that also resolves a Scratch topic to the Scratch
 * workspace); a Session no Workspace claims goes into an honest "Unassigned" bucket per Host rather than
 * being dropped or given an invented name.
 *
 * Rows keep the roster's global order inside each project (needs-you first, then error, then working,
 * then idle — longest wait first within a class). Projects are ordered by their most urgent row, so a
 * project with an Agent waiting on you sorts above one that is merely busy.
 */
export function buildAgentTree(input: {
  sessions: readonly SessionSnapshot[]
  providerCatalog: readonly AgentCatalogEntry[]
  workspaces: readonly WorkspaceRecord[]
  filter: AgentTreeFilter
}): AgentTreeProject[] {
  const rows = buildAgentRoster({ sessions: input.sessions, providerCatalog: input.providerCatalog })
  const sessionById = new Map(input.sessions.map((session) => [session.id, session]))
  const byProject = new Map<string, AgentTreeProject>()
  for (const row of rows) {
    const session = sessionById.get(row.sessionId)
    if (!session || !rowMatchesFilter(session, row, input.filter)) continue
    const workspace = input.workspaces.find((candidate) => workspaceOwnsSessionPath(candidate, session))
    const key = workspace ? `${workspace.hostId}\0${workspace.id}` : `unassigned\0${session.hostId}`
    const project = byProject.get(key)
    if (project) project.rows.push(row)
    else {
      byProject.set(key, {
        key,
        name: workspace?.name ?? 'Unassigned',
        hostId: workspace?.hostId ?? session.hostId,
        rows: [row]
      })
    }
  }
  // Stable sort: the first row in each bucket is already the most urgent (rows arrive pre-sorted), so
  // ranking by it orders projects by urgency while ties keep first-appearance order.
  return [...byProject.values()].sort((left, right) => rowRank(left.rows[0]!) - rowRank(right.rows[0]!))
}
