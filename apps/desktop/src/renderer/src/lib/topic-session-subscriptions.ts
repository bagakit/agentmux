import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { ScratchTopicSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { scratchTopicDirectoryName, scratchTopicIdFromWorkspacePath, scratchTopicStorageRoots } from '../../../shared/scratch-topics'
import { useAppStore } from '../store'
import { agentSessionPresentationIndex, sessionPresentationById, sessionPresentationsAtPath } from './session-presentation'
import { useRetainedSessionPresentation } from './workbench-session-subscriptions'

const NO_REGION_SESSION_IDS: readonly string[] = []

/** Resolve original directory aliases once per filesystem snapshot, including ambiguity checks. */
export function topicSessionPaths(workspace: Pick<WorkspaceRecord, 'path'>, topics: readonly ScratchTopicSnapshot[]): ReadonlyMap<string, readonly string[]> {
  const candidates = new Set<string>()
  for (const topic of topics) {
    for (const path of topic.confirmedDirectoryPaths ?? []) candidates.add(path)
    if (topic.identityDirectoryPath) candidates.add(topic.identityDirectoryPath)
    if (topic.physicalDirectoryPath) candidates.add(topic.physicalDirectoryPath)
    if (topic.confirmedDirectoryPaths === undefined && !topic.readError) {
      const name = scratchTopicDirectoryName(topic.id)
      for (const root of Object.values(scratchTopicStorageRoots(workspace.path))) {
        candidates.add(`${root}/${name}`); candidates.add(`${root}\\${name}`)
      }
    }
  }
  const resolved = new Map<string, string[]>()
  for (const path of candidates) {
    const id = scratchTopicIdFromWorkspacePath(workspace.path, path, topics)
    if (!id) continue
    const paths = resolved.get(id) ?? []
    paths.push(path); resolved.set(id, paths)
  }
  return resolved
}

/** A displayed Topic consumes its original directory Sessions and its actual open Regions only. */
export function useTopicSessions(hostId: string, paths: readonly string[], regionSessionIds: readonly string[] = NO_REGION_SESSION_IDS, active = true) {
  const scope = useMemo(() => JSON.stringify([hostId, [...new Set(paths)].sort(), [...new Set(regionSessionIds)].sort()]), [hostId, paths, regionSessionIds])
  const current = useAppStore(useShallow(state => {
    if (!active) return null
    if (paths.length === 0 && regionSessionIds.length === 0) return []
    const key = (session: { hostId: string; id: string }) => JSON.stringify([session.hostId, session.id])
    const own = new Map(paths.flatMap(path => sessionPresentationsAtPath(state.sessions, hostId, path)
      .map(session => [key(session), session] as const)))
    const agents = agentSessionPresentationIndex(state.sessions)
    for (const id of regionSessionIds) {
      const candidates = agents.get(id)
      if (candidates?.length) {
        for (const session of candidates) own.set(key(session), session)
        continue
      }
      const session = sessionPresentationById(state.sessions).get(id)
      if (session) own.set(key(session), session)
    }
    return [...own.values()]
  }))
  return useRetainedSessionPresentation(scope, current)
}

export function useTopicSessionPaths(workspace: Pick<WorkspaceRecord, 'path'>, topics: readonly ScratchTopicSnapshot[]) {
  return useMemo(() => topicSessionPaths(workspace, topics), [workspace.path, topics])
}
