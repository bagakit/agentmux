import { NotebookText } from 'lucide-react'
import { useState } from 'react'
import { selectedKnowledgeSources } from '../lib/topic-knowledge-actions'
import { useMoteWorkfaceScope } from '../lib/mote-workface'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { useAppStore } from '../store'
import { TopicKnowledgeCapture } from './TopicKnowledgeEditor'
import { TopicFilesTool } from './TopicFilesTool'
import { MoteFilesTool } from './MoteFilesTool'
import { ProjectFilesTool, ProjectSourceControl } from './ProjectFilesTool'
import type { WorkspaceFileActions } from './WorkspaceFilesFrame'

/** Select the original domain; common layout and business observations stay separate. */
export function WorkspaceFilesTool(props: WorkspaceFileActions & {
  isScratch: boolean; topicId?: string | undefined; reference?: WorkbenchProjectionSelection | null | undefined
}) {
  const { workspace, visible, topicId, isScratch } = props
  const selectedTopicId = useAppStore(state => topicId ?? (state.workbenchSpaceSelection?.workspaceId === workspace.id ? state.workbenchSpaceSelection.topicId : null))
  const mote = useMoteWorkfaceScope(workspace.id, topicId, visible)
  const [capture, setCapture] = useState<ReturnType<typeof selectedKnowledgeSources>>(null)
  const collect = <button type="button" className="icon-button" aria-label="Collect sources in a knowledge topic" title="Collect sources in a knowledge topic" onClick={() => {
    try {
      const target = selectedKnowledgeSources(workspace.id)
      if (!target) throw new Error('Choose a file, page or discussion to collect its reference in a knowledge topic.')
      setCapture(target)
    } catch (error) { useAppStore.getState().reportError(error) }
  }}><NotebookText size={13} /></button>
  return <ProjectSourceControl workspace={workspace} visible={visible && !isScratch && !mote}>{projectContent => <>
    {capture ? <TopicKnowledgeCapture target={capture} onClose={() => setCapture(null)} /> : null}
    {mote ? <MoteFilesTool {...props} scope={mote} /> : isScratch || selectedTopicId ?
      <TopicFilesTool {...props} topicId={selectedTopicId} actions={collect} projectContent={projectContent} /> : <ProjectFilesTool {...props} actions={collect} content={projectContent} />}
  </>}</ProjectSourceControl>
}
