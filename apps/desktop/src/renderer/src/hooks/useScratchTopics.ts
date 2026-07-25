import { useEffect, useState } from 'react'
import type { ScratchTopicSnapshot } from '../../../shared/contracts'
import { api } from '../lib/api'
import { useAppStore } from '../store'

/**
 * 读取一个 Scratch Workspace 的 Topic 快照。
 *
 * Topic 的真相在文件系统，因此这里只是一次读取，不持有 Topic 状态：失效由 store 的
 * `workspaceFileRevisions` 驱动（新建、改名、Editor 保存 topic.md 都会推进它），
 * 于是 Topic 面板与 Board 看到的是同一份快照的同一次失效，不是两份各自过期的缓存。
 */
export function useScratchTopics(workspaceId: string | null): {
  topics: ScratchTopicSnapshot[] | null
  error: string | null
} {
  const revision = useAppStore((state) =>
    workspaceId ? state.workspaceFileRevisions[workspaceId] ?? 0 : 0)
  const [topics, setTopics] = useState<ScratchTopicSnapshot[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!workspaceId) {
      setTopics(null)
      setError(null)
      return
    }
    let active = true
    setError(null)
    void api.scratch.listTopics(workspaceId).then((snapshots) => {
      if (active) setTopics(snapshots)
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { active = false }
  }, [revision, workspaceId])

  return { topics, error }
}
