import { useEffect } from 'react'
import type { ScratchTopicSnapshot } from '../../../shared/contracts'
import { scratchTopicsScope } from '../lib/scratch-topic-snapshots'
import { useAppStore } from '../store'

/**
 * Every consumer reads the same raw filesystem snapshot and revision-owned request.
 */
export function useScratchTopics(workspaceId: string | null): {
  topics: readonly ScratchTopicSnapshot[] | null
  error: string | null
} {
  const workspace = useAppStore(state => state.config?.workspaces.find(workspace => workspace.id === workspaceId))
  const revision = useAppStore(state => workspaceId ? state.workspaceFileRevisions[workspaceId] ?? 0 : 0)
  const snapshot = useAppStore(state => workspaceId ? state.scratchTopicSnapshots[workspaceId] : undefined)
  const refresh = useAppStore(state => state.refreshScratchTopics)
  const scope = workspace ? scratchTopicsScope(workspace) : null
  useEffect(() => {
    if (workspaceId && scope) void refresh(workspaceId)
  }, [workspaceId, scope, revision, refresh])
  return snapshot?.scope === scope ? { topics: snapshot.topics, error: snapshot.error } : { topics: null, error: null }
}
