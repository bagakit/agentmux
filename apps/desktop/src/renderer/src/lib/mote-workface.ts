import { createContext, useMemo } from 'react'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import type { ScratchTopicSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { useScratchTopics } from '../hooks/useScratchTopics'
import { useAppStore } from '../store'
import { activeTopicIdFromLayout } from './scratch-topic-layout'
import { scratchTopicKind } from './scratch-topic-snapshots'
import { fileExplorerRelativeRoot } from './file-explorer-scope'

export type MoteWorkfaceScope = { topic: ScratchTopicSnapshot; workspace: WorkspaceRecord; rootPath: string }
export const MoteWorkfaceContext = createContext<(MoteWorkfaceScope & {
  floating: boolean
  materials(): void
  persona(): void
  selectTab(tabId: string, groupId: string): void
}) | null>(null)

/** Original directory facts decide identity; the selected Tab decides context. */
export function useMoteWorkfaceScope(workspaceId: string | undefined, explicitTopicId?: string): MoteWorkfaceScope | null {
  const workspace = useAppStore(state => state.config?.workspaces.find(item => item.id === workspaceId))
  const topicId = useAppStore(state => {
    if (explicitTopicId) return explicitTopicId
    const choice = state.workbenchSpaceSelection
    if (choice && choice.workspaceId === workspaceId && choice.topicId) return choice.topicId
    const layout = workspaceId ? state.layouts[workspaceId] : undefined
    return layout ? activeTopicIdFromLayout(layout, state.tabs) : null
  })
  const { topics } = useScratchTopics(workspaceId === SCRATCH_WORKSPACE_ID ? workspaceId : null)
  return useMemo(() => {
    const topic = topics?.find(item => item.id === topicId)
    if (!workspace || !topic || scratchTopicKind(topic.id, topics) !== 'mote') return null
    const rootPath = fileExplorerRelativeRoot(workspace.path, topic.directoryPath)
    return rootPath === null ? null : { workspace, topic, rootPath }
  }, [workspace, topics, topicId])
}
