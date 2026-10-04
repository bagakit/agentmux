import type { MoteDefaultConversation } from '../../../shared/mote-quick-mode'
import { createContext, useMemo, useRef } from 'react'
import { SCRATCH_WORKSPACE_ID, scratchTopicLogicalPath, scratchTopicDirectoryName } from '../../../shared/scratch-topics'
import type { ScratchTopicSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { useScratchTopics } from '../hooks/useScratchTopics'
import { useAppStore } from '../store'
import { activeTopicIdFromLayout } from './scratch-topic-layout'
import { scratchTopicKind } from './scratch-topic-snapshots'
import { homeZoneId } from '../../../shared/space-addresses'

export type MoteWorkfaceScope = { topic: ScratchTopicSnapshot; workspace: WorkspaceRecord; rootPath: string; issue?: string }
export const MoteWorkfaceContext = createContext<(MoteWorkfaceScope & {
  floating: boolean
  defaultConversation?: MoteDefaultConversation | undefined
  selectTab(tabId: string, groupId: string): void
}) | null>(null)

/** Mote identity owns its files, independently of a member Zone's display Workspace. */
export function useMoteWorkfaceScope(workspaceId: string | undefined, explicitTopicId?: string, active = true): MoteWorkfaceScope | null {
  const topicId = useAppStore(state => {
    if (explicitTopicId) return explicitTopicId
    const choice = state.workbenchSpaceSelection
    if (choice && choice.workspaceId === workspaceId) return choice.topicId
    const layout = workspaceId ? state.layouts[workspaceId] : undefined
    return layout ? activeTopicIdFromLayout(layout, state.tabs) : null
  })
  const workspace = useAppStore(state => topicId ? state.config?.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID) : undefined)
  const { topics } = useScratchTopics(topicId ? workspace?.id ?? null : null, active)
  const bindings = useAppStore(state => topicId ? state.spaceZoneBindings : null)
  const origin = useMemo(() => {
    if (!bindings || !topicId || !workspace) return undefined
    const origins = Object.entries(bindings).filter(([zoneId, origin]) => origin.topicId === topicId &&
      origin.contentKind === 'mote' && origin.workspaceId === workspace?.id && zoneId === homeZoneId(origin.spaceId)).map(([, origin]) => origin)
    return origins.length === 1 ? origins[0] : undefined
  }, [bindings, topicId, workspace?.id])
  const retained = useRef<MoteWorkfaceScope | null>(null)
  return useMemo(() => {
    if (!workspace || !topicId) { retained.current = null; return null }
    const held = retained.current?.workspace.hostId === workspace.hostId && retained.current.workspace.path === workspace.path &&
      retained.current.topic.id === topicId ? retained.current : null
    const topic = topics?.find(item => item.id === topicId)
    const issue = topic?.readError ?? 'Mote metadata is not confirmed. Its original identity, workface and material scope are retained; retry directory discovery.'
    if (topic?.readError && held) return { ...held, issue }
    if (topic && scratchTopicKind(topic.id, topics) === 'mote') {
      const rootPath = scratchTopicLogicalPath(workspace, topic)
      if (rootPath !== null) {
        const scope = { workspace, topic, rootPath, ...(topic.readError ? { issue } : {}) }
        retained.current = scope
        return scope
      }
    }
    if (held) return { ...held, issue }
    // Core's original content identity survives filesystem discovery gaps. This is
    // a bounded presentation descriptor, never a new filesystem/space registry.
    if (origin) {
      const rootPath = scratchTopicDirectoryName(topicId)
      const scope = { workspace, rootPath, issue,
        topic: topic ?? { id: topicId, title: 'Mote', summary: '', collaborators: [],
          directoryPath: rootPath, topicPath: `${rootPath}/topic.md`, readError: issue,
          ...(origin.directoryPath ? { physicalDirectoryPath: origin.directoryPath } : {}) } }
      retained.current = scope
      return scope
    }
    retained.current = null
    return null
  }, [workspace, topicId, topics, origin])
}
