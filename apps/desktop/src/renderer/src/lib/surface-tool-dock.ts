import type { SessionSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { sessionBoardColumn } from './project-board'
import { workspaceOwnsSessionPath } from '../../../shared/scratch-topics'

export const TOOL_DOCK_DEFAULT_WIDTH = 300
export const TOOL_DOCK_MIN_WIDTH = 236
// 180px compact window chrome + 4px grid gap + three 28px workspace-tool
// buttons + two 1px button gaps + 4px end padding.
export const TOOL_DOCK_COLLAPSED_RAIL_MIN_WIDTH = 274
export const TOOL_DOCK_MAX_WIDTH = 440

export const WORKSPACE_TOOL_IDS = [
  'files-branches',
  'agents',
  'browser-tools'
] as const

export type WorkspaceTool = (typeof WORKSPACE_TOOL_IDS)[number]

/**
 * Which workspace tools the dock offers, and which one is effectively active, for a given
 * workspace. Every workspace — Scratch included — gets the same three role slots (content /
 * Agents / Browser); the stored `workspaceTool` is shared across workspaces, so we never mutate
 * it here. Scratch is NOT a hidden empty folder: it is a wiki-first workspace whose content slot
 * holds real topic / outcome / refs / .agents content, so the file view is meaningful and Scratch
 * lands on the content slot by default (the store default is already `files-branches`). What
 * changes for Scratch is only the content slot's *presentation* — see `contentSlotPresentation`.
 */
export function resolveWorkspaceTools(input: {
  workspaceTool: WorkspaceTool
  isScratch: boolean
}): { tools: readonly WorkspaceTool[]; effective: WorkspaceTool } {
  // Scratch keeps `files-branches` as the stored enum value (zero side-effect when switching back
  // to a real project); it is re-skinned as `Files + Topics`, not removed. `isScratch` is retained
  // in the signature so callers keep a single source of truth for the flag even though the tool
  // set no longer diverges.
  void input.isScratch
  const tools: readonly WorkspaceTool[] = WORKSPACE_TOOL_IDS
  const effective = tools.includes(input.workspaceTool) ? input.workspaceTool : tools[0]!
  return { tools, effective }
}

/**
 * Presentation of the content slot (the `files-branches` role). A real project shows
 * `Files + Branches`; Scratch re-skins the same slot as `Files + Topics`, because its backing dir
 * is a multi-agent collaboration wiki (topic.md + outcome/ + refs/ + .agents/) rather than a git
 * worktree. The internal enum value stays `files-branches` in both cases — only label, icon and
 * the bottom-half panel change. Kept pure and separate from `resolveWorkspaceTools` so both are
 * unit-testable without rendering.
 */
export type ContentSlotPresentation = {
  /** Label shown in the tool rail and header. */
  label: string
  /** Whether the bottom half is the Topics (wiki) panel instead of the Branches panel. */
  showTopics: boolean
  /** Vertical split: the file tree's default percentage (Topics takes the larger remainder). */
  fileTreeDefaultSize: number
  /** Vertical split: the file tree's minimum percentage. */
  fileTreeMinSize: number
}

export function contentSlotPresentation(isScratch: boolean): ContentSlotPresentation {
  if (isScratch) {
    // Topics (the wiki) is the primary view in Scratch, so the file tree shrinks to the smaller
    // share and Topics takes the larger remainder — wiki-first: filesystem is the substrate,
    // the topic is the first-class view.
    return { label: 'Files + Topics', showTopics: true, fileTreeDefaultSize: 38, fileTreeMinSize: 20 }
  }
  return { label: 'Files + Branches', showTopics: false, fileTreeDefaultSize: 68, fileTreeMinSize: 34 }
}

export const WORKSPACE_AGENT_GROUP_IDS = ['working', 'needs-you', 'recent'] as const

export type WorkspaceAgentGroupId = (typeof WORKSPACE_AGENT_GROUP_IDS)[number]
export type AgentSessionSnapshot = Extract<SessionSnapshot, { kind: 'agent' }>

export type WorkspaceAgentGroup = {
  id: WorkspaceAgentGroupId
  sessions: AgentSessionSnapshot[]
}

export function workspaceAgentGroups(
  sessions: readonly SessionSnapshot[],
  workspace: Pick<WorkspaceRecord, 'id' | 'hostId' | 'path'>
): WorkspaceAgentGroup[] {
  const grouped: Record<WorkspaceAgentGroupId, AgentSessionSnapshot[]> = {
    working: [],
    'needs-you': [],
    recent: []
  }
  for (const session of sessions) {
    if (
      session.kind !== 'agent' ||
      !workspaceOwnsSessionPath(workspace, session)
    ) continue
    const column = sessionBoardColumn(session)
    grouped[column === 'done' ? 'recent' : column].push(session)
  }
  return WORKSPACE_AGENT_GROUP_IDS.map((id) => ({
    id,
    sessions: grouped[id].sort((left, right) => right.updatedAt - left.updatedAt)
  }))
}

export function clampToolDockWidth(width: number): number {
  return Math.min(TOOL_DOCK_MAX_WIDTH, Math.max(TOOL_DOCK_MIN_WIDTH, width))
}

export function getToolDockMinimumWidth(projectRailOpen: boolean): number {
  return projectRailOpen ? TOOL_DOCK_MIN_WIDTH : TOOL_DOCK_COLLAPSED_RAIL_MIN_WIDTH
}

export function getRenderedToolDockWidth(width: number, projectRailOpen: boolean): number {
  return Math.min(
    TOOL_DOCK_MAX_WIDTH,
    Math.max(width, getToolDockMinimumWidth(projectRailOpen))
  )
}
