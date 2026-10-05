import { RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { SCRATCH_WORKSPACE_ID, scratchTopicLogicalPath, scratchTopicPhysicalPath } from '../../../shared/scratch-topics'
import { directoryIdentity } from '../../../shared/space-addresses'
import { isKnowledgeTopicInBindings } from '../../../shared/topic-categories'
import { useScratchTopics } from '../hooks/useScratchTopics'
import { contentSlotPresentation } from '../lib/surface-tool-dock'
import { useAppStore } from '../store'
import type { FileExplorerRevealRequest } from './FileExplorer'
import { TopicNavigationPanel } from './TopicNavigationPanel'
import { WorkspaceFilesFrame, type WorkspaceFileActions } from './WorkspaceFilesFrame'

/** Topic/Category observations and original directory scope belong to this assembly. */
export function TopicFilesTool({ workspace, visible, isScratch, topicId, onOpenPath, onOpenTerminal, actions, projectContent }: WorkspaceFileActions & {
  isScratch: boolean; topicId?: string | null | undefined; actions: ReactNode; projectContent: ReactNode
}) {
  const choice = useAppStore(state => state.workbenchSpaceSelection?.workspaceId === workspace.id ? state.workbenchSpaceSelection : null)
  const scratch = useAppStore(state => state.config?.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID))
  const { topics } = useScratchTopics(scratch?.id ?? null, visible)
  const bindings = useAppStore(state => state.spaceZoneBindings)
  const selectedTopicId = topicId ?? choice?.topicId
  const topic = selectedTopicId ? topics?.find(item => item.id === selectedTopicId && isKnowledgeTopicInBindings(item, bindings)) : undefined
  const categorySpaceId = choice?.spaceId && choice.spaceId !== directoryIdentity(workspace.hostId, workspace.path) ? choice.spaceId : undefined
  const [reveal, setReveal] = useState<{ selection: string | null; categorySpaceId: string | undefined; request: FileExplorerRevealRequest }>()
  useEffect(() => setReveal(undefined), [selectedTopicId, workspace.id, categorySpaceId])
  const revealRequest = reveal?.request.workspaceId === workspace.id && reveal.selection === (selectedTopicId ?? null) && reveal.categorySpaceId === categorySpaceId ? reveal.request : undefined
  const fileTopic = revealRequest ? topics?.find(item => scratchTopicLogicalPath(workspace, item) === revealRequest.path) : topic
  const rootPath = revealRequest?.path ?? (fileTopic && scratch ? scratchTopicLogicalPath(scratch, fileTopic) : null)
  const requestId = useRef(0)
  const presentation = contentSlotPresentation(isScratch)
  const frame = (content: ReactNode) => <WorkspaceFilesFrame workspace={workspace} visible={visible} presentation={presentation}
    directoryFirst={presentation.showTopics} title={presentation.showTopics ? 'Files' : fileTopic?.title ?? workspace.name}
    subtitle={presentation.showTopics ? fileTopic?.title ?? workspace.name : workspace.branch}
    contextPath={fileTopic ? scratchTopicPhysicalPath(workspace, fileTopic) : workspace.path}
    actions={!selectedTopicId || topic && rootPath !== null ? actions : null}
    explorer={{ rootPath: rootPath ?? '', rootLabel: fileTopic?.title ?? workspace.name, revealRequest, onOpenPath, onOpenTerminal }}
    fileIssue={selectedTopicId && rootPath === null ? <div className="surface-inline-error" role="status">The selected object's file root is not confirmed. Its original workface is kept.
      {scratch ? <button type="button" className="icon-button" aria-label="Retry directory discovery" title="Retry directory discovery" onClick={() => void useAppStore.getState().refreshScratchTopics(scratch.id, true)}><RefreshCw size={13} /></button> : null}</div> : undefined}>
    {content}
  </WorkspaceFilesFrame>
  return presentation.showTopics ? frame(<TopicNavigationPanel workspace={workspace} topic={topic} selectedTopicId={selectedTopicId}
    topics={topics ?? []} categorySpaceId={categorySpaceId} visible={visible} onRevealDirectory={path => {
      setReveal({ selection: selectedTopicId ?? null, categorySpaceId, request: { workspaceId: workspace.id, path, requestId: ++requestId.current } })
      useAppStore.getState().setExplorerCollapsed(workspace.id, false)
    }} />) : frame(projectContent)
}
