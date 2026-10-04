import { useState } from 'react'
import type { ScratchTopicSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { TopicKnowledgePanel } from './TopicKnowledgePanel'
import { WorkspaceTopicsPanel } from './WorkspaceTopicsPanel'
import { SurfaceModeSwitch } from './SurfaceModeSwitch'

/** Category directory and knowledge share the secondary surface; Chats live in the right Tab strip. */
export function TopicNavigationPanel({ workspace, topic, selectedTopicId, topics, categorySpaceId, visible, onRevealDirectory }: {
  workspace: WorkspaceRecord
  topic?: ScratchTopicSnapshot | undefined
  selectedTopicId?: string | null | undefined
  topics: readonly ScratchTopicSnapshot[]
  categorySpaceId?: string | undefined
  visible: boolean
  onRevealDirectory(path: string): void
}) {
  const [view, setView] = useState<'topics' | 'knowledge'>('topics')
  const [knowledgeOpened, setKnowledgeOpened] = useState(false)
  return <section className="topic-navigation-panel" aria-label="Topic directory and knowledge">
    <SurfaceModeSwitch value={view} active={visible} ariaLabel="Topic directory view"
      options={[{ value: 'topics', label: 'Topics', ariaLabel: 'Show Topics' }, { value: 'knowledge', label: 'Knowledge', ariaLabel: 'Show Knowledge' }]}
      onChange={next => { if (next === 'knowledge') setKnowledgeOpened(true); setView(next) }} />
    <div className="topic-navigation-panel__topics" hidden={view !== 'topics'}>
      <WorkspaceTopicsPanel workspace={workspace} categorySpaceId={categorySpaceId} visible={visible && view === 'topics'} onRevealDirectory={onRevealDirectory} />
    </div>
    {knowledgeOpened ? <div className="topic-navigation-panel__knowledge" hidden={view !== 'knowledge'}>
      {selectedTopicId && !topic ? <div className="surface-inline-error" role="status">The selected Topic is still restoring. Its workface and Topic directory remain available.</div> :
        <TopicKnowledgePanel key={topic?.id ?? 'all-topics'} workspace={workspace} topic={topic} topics={topics} active={visible && view === 'knowledge'} />}
    </div> : null}
  </section>
}
