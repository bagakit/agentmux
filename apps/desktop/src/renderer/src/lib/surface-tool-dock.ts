import type { SessionSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { sessionBoardColumn } from './project-board'
import { categoryFor, type AttentionCategory } from './attention-event'
import type { AgentDisplayState } from '@agentmux/core'
import {
  scratchTopicIdFromWorkspacePath,
  workspaceOwnsSessionPath,
  type ScratchTopicSnapshot
} from '../../../shared/scratch-topics'

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

// One Agent as it appears under a Topic. `sessionId` is the stable identity used to dedupe the
// on-disk collaborator record against a live Session projection; `live` is present only when a
// running Session currently projects into this Topic.
export type TopicAgent = {
  sessionId: string
  providerId: string
  live: AgentSessionSnapshot | null
}

export type TopicWithAgents = ScratchTopicSnapshot & { agents: TopicAgent[] }

// Projects each filesystem Topic's Agents as the union of its on-disk collaborators (durable
// short memory in `.agents/`) and the live Agent Sessions whose cwd currently resolves to that
// Topic directory. The Topic list is authoritative and comes straight from the filesystem
// snapshot — Sessions are only *matched onto* it by their own workspace path, never used to
// invent or reverse-derive a Topic. A Topic with zero Agents keeps an empty list rather than
// disappearing.
export function topicsWithAgents(
  topics: readonly ScratchTopicSnapshot[],
  sessions: readonly SessionSnapshot[],
  workspace: Pick<WorkspaceRecord, 'id' | 'hostId' | 'path'>
): TopicWithAgents[] {
  const liveByTopic = new Map<string, Map<string, AgentSessionSnapshot>>()
  for (const session of sessions) {
    if (session.kind !== 'agent' || !workspaceOwnsSessionPath(workspace, session)) continue
    const topicId = scratchTopicIdFromWorkspacePath(workspace.path, session.workspacePath)
    if (!topicId) continue
    const bucket = liveByTopic.get(topicId) ?? new Map<string, AgentSessionSnapshot>()
    bucket.set(session.id, session)
    liveByTopic.set(topicId, bucket)
  }
  return topics.map((topic) => {
    const live = liveByTopic.get(topic.id) ?? new Map<string, AgentSessionSnapshot>()
    const seen = new Set<string>()
    const agents: TopicAgent[] = []
    for (const collaborator of topic.collaborators) {
      seen.add(collaborator.sessionId)
      agents.push({
        sessionId: collaborator.sessionId,
        providerId: live.get(collaborator.sessionId)?.providerId ?? collaborator.providerId,
        live: live.get(collaborator.sessionId) ?? null
      })
    }
    for (const [sessionId, session] of live) {
      if (seen.has(sessionId)) continue
      agents.push({ sessionId, providerId: session.providerId, live: session })
    }
    return { ...topic, agents }
  })
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

/**
 * 一个 Topic 里某个 Agent 现在怎么样了。
 *
 * Topic 行要回答的是状态，不是把每个 Agent 的全名平铺出来——名字用户已经知道，
 * 他想知道的是"有没有在等我"。状态语汇复用窗口里那一套（`categoryFor` + `status--<state>`），
 * 使这里的一个点与 Tab 角、名册行、注意力栏含义完全一致，不发明第三套。
 *
 * 没有 live Session 的协作者如实报 `disconnected`——它在磁盘上留了记录，但此刻没在跑，
 * 假装它在运行会让整行的状态失去意义。
 */
export function topicAgentPresentation(agent: TopicAgent): {
  state: AgentDisplayState
  attention: AttentionCategory | null
} {
  if (!agent.live) return { state: 'disconnected', attention: null }
  const state = agent.live.status.state
  return { state, attention: categoryFor(state) }
}
