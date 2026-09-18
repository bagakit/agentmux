import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { AppConfig, ScratchTopicSnapshot, WorkspaceBranchesSnapshot } from '../../../shared/contracts'
import { isScratchWorkspaceId } from '../../../shared/contracts'
import { useAppStore } from '../store'
import { api } from './api'
import { presentError } from './error-presentation'
import { EMPTY_FOCUS_HIERARCHY, focusProjectRoots, retainedWorktreeFacts, type FocusHierarchyFacts } from './focus-project-lanes'
import type { FocusContext } from './focus-context'

type Snapshot = { id: string; topics?: ScratchTopicSnapshot[]; branches?: WorkspaceBranchesSnapshot; error?: string }
/** Query only represented workspaces; unchanged scopes reuse their requests across unrelated updates. */
export function useFocusHierarchy(rows: readonly FocusContext[], config: AppConfig | null) {
  const [facts, setFacts] = useState<FocusHierarchyFacts>(EMPTY_FOCUS_HIERARCHY)
  const scopes = useMemo(() => {
    const scopes = new Map<string, NonNullable<AppConfig>['workspaces'][number]>()
    const roots = focusProjectRoots(config)
    for (const row of rows) {
      const workspace = row.workspace
      const repoPath = workspace?.repoPath ?? facts.worktrees.find(item => item.hostId === row.hostId && item.path === row.workspacePath)?.repoPath
      const root = repoPath ? roots.get(JSON.stringify([row.hostId, repoPath])) : workspace
      const scope = root ?? workspace
      if (scope) scopes.set(scope.id, scope)
    }
    return [...scopes.values()]
  }, [rows, config, facts])
  const revisions = useAppStore(useShallow(state => scopes.map(workspace => state.workspaceFileRevisions[workspace.id] ?? 0)))
  const signature = JSON.stringify(scopes.map((scope, index) => [scope.id, scope.path, scope.branch, revisions[index]]))
  const requests = useRef(new Map<string, Promise<Snapshot>>())
  const [errors, setErrors] = useState<string[]>([])
  useEffect(() => {
    let active = true
    const jobs = scopes.map((scope, index) => {
      const key = JSON.stringify([scope.id, scope.path, scope.branch, revisions[index]])
      let job = requests.current.get(key)
      if (!job) {
        job = (isScratchWorkspaceId(scope.id)
          ? api.scratch.listTopics(scope.id).then(topics => ({ id: scope.id, topics }))
          : api.workspaces.listBranches(scope.id).then(branches => ({ id: scope.id, branches })))
          .catch(cause => ({ id: scope.id, error: `${scope.name}: ${presentError(cause)}` }))
        requests.current.set(key, job)
      }
      return job
    })
    void Promise.all(jobs).then(snapshots => {
      if (!active) return
      setErrors(snapshots.flatMap(snapshot => snapshot.error ? [snapshot.error] : []))
      setFacts(previous => {
        const topics = { ...previous.topics }
        let worktrees = previous.worktrees
        for (const snapshot of snapshots) {
          if (snapshot.topics) topics[snapshot.id] = snapshot.topics
          if (snapshot.branches) worktrees = retainedWorktreeFacts(worktrees, snapshot.branches)
        }
        return { topics, worktrees }
      })
      const keys = new Set(scopes.map((scope, index) => JSON.stringify([scope.id, scope.path, scope.branch, revisions[index]])))
      for (const key of requests.current.keys()) if (!keys.has(key)) requests.current.delete(key)
    })
    return () => { active = false }
    // Immutable signature includes each owned scope and its revision; byte/state changes don't query again.
  }, [signature])
  return { facts, errors }
}
