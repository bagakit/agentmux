import { useMemo } from 'react'
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

/**
 * 当前 Board 的行，以及它们从哪来。
 *
 * Board 主视图与 Board 工具的次级面板显示的是同一张 Board，因此行必须**同源**：一份行来源
 * 分叉逻辑（Scratch 出 Topic 行、Git 项目出 Branch 行）、一份排序、一份状态归类。让面板自己
 * 再查一遍 topics/branches，就等于给"这个 Board 有哪些行"开第二份答案——两处会在筛选、
 * 排序、加载时序上各自漂移，而漂移时谁都不会响。
 *
 * 行的状态归类由 `project-board` 的构造函数持有（最终落到 `sessionBoardColumn`），
 * 这个 hook 不碰状态，只负责"取到行"。
 */
export type BoardRowsResult = {
  rows: BoardRow[]
  /** 行来源是 Branch 还是 Topic——两种来源共用同一套列，这只影响措辞。 */
  kind: BoardRow['kind']
  /** 行还在路上：Branch 快照未回或 Scratch 的 Topic 未回。空数组 + loading 才是"还不知道"。 */
  loading: boolean
}

export function useBoardRows(): BoardRowsResult {
  const config = useAppStore((state) => state.config)
  const sessions = useAppStore((state) => state.sessions)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
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
  const { snapshot, loading } = useWorkspaceBranches(scratch ? null : anchor?.id ?? null)
  const { topics } = useScratchTopics(scratch?.id ?? null)

  // 行来源是唯一按 Workspace 分叉的地方。分叉之后，所有消费方都不再关心它是 Branch 还是 Topic。
  const rows = useMemo<BoardRow[]>(() => {
    if (scratch) {
      if (!topics) return []
      const built = buildTopicBoardRows(topics, scratch, sessions)
      // 顺序复用 Topic 面板那份用户拖拽偏好，两处顺序不会互相打架。
      const shown = orderTopics(built.map((row) => row.id), topicOrder)
      return shown.flatMap((id) => built.filter((row) => row.id === id))
    }
    return snapshot && project
      ? buildProjectBranchLanes(snapshot, project.workspaces, sessions)
      : []
  }, [project, scratch, sessions, snapshot, topicOrder, topics])

  return {
    rows,
    kind: scratch ? 'topic' : 'branch',
    loading: scratch ? topics === null : loading
  }
}
