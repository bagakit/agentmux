import { createContext, createElement, useContext, useMemo, type ReactNode } from 'react'
import { isScratchWorkspaceId } from '../../../shared/contracts'
import { useAppStore } from '../store'
import { useScratchTopics } from './useScratchTopics'
import { useWorkspaceBranches } from './useWorkspaceBranches'
import {
  buildProjectBranchLanes,
  buildTopicBoardRows,
  type BoardRow
} from '../lib/project-board'
import { orderTopics } from '../lib/topic-order'
import { projectWorkspaces } from '../lib/workspace-projects'

// Board and dock consume one request owner. Calling the same hook twice does not share state.
const BoardRowsContext = createContext<ReturnType<typeof useBoardData> | null>(null)

export function BoardRowsProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const value = useBoardData(enabled)
  return createElement(BoardRowsContext.Provider, { value }, children)
}

export function useBoardRows() {
  const value = useContext(BoardRowsContext)
  if (!value) throw new Error('BoardRowsProvider is required for the Board and its tools')
  return value
}

function useBoardData(enabled: boolean) {
  const config = useAppStore((state) => state.config)
  const sessions = useAppStore((state) => state.sessions)
  const activeWorkspaceId = useAppStore((state) => enabled ? state.activeWorkspaceId : null)
  const topicOrder = useAppStore((state) => state.scratchTopicOrder)

  const scratch = isScratchWorkspaceId(activeWorkspaceId)
    ? config?.workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null
    : null
  const projects = useMemo(
    () => projectWorkspaces((config?.workspaces ?? []).filter((workspace) => !isScratchWorkspaceId(workspace.id))),
    [config?.workspaces]
  )
  const project = projects.find((candidate) =>
    candidate.workspaces.some((workspace) => workspace.id === activeWorkspaceId)
  )
  const anchor = scratch
    ?? project?.workspaces.find((workspace) => workspace.id === activeWorkspaceId)
    ?? project?.workspaces.find((workspace) => workspace.id === project.preferredWorkspaceId)
    ?? null
  // Scratch 没有 Branch 可读，因此不去读——把 workspaceId 传成 null 使这条请求根本不发生。
  const { snapshot, loading, error: loadError, refresh } = useWorkspaceBranches(scratch ? null : anchor?.id ?? null)
  const { topics, error: topicsError } = useScratchTopics(scratch?.id ?? null)

  // 行来源是唯一按 Workspace 分叉的地方。分叉之后，所有消费方都不再关心它是 Branch 还是 Topic。
  const rows = useMemo<BoardRow[]>(() => {
    if (scratch) {
      if (!topics) return []
      const built = buildTopicBoardRows(topics, scratch, sessions)
      // 顺序复用 Topic 面板那份用户拖拽偏好，两处顺序不会互相打架。
      const shown = orderTopics(built.map((row) => row.id), topicOrder)
      const byId = new Map(built.map((row) => [row.id, row]))
      return shown.map((id) => byId.get(id)!)
    }
    return snapshot && project
      ? buildProjectBranchLanes(snapshot, project.workspaces, sessions)
      : []
  }, [project, scratch, sessions, snapshot, topicOrder, topics])

  return {
    rows, project, scratch, anchor, snapshot, topics, loadError, topicsError, refresh,
    error: loadError ?? topicsError,
    kind: scratch ? 'topic' as const : 'branch' as const,
    loading: scratch ? topics === null && !topicsError : loading
  }
}
