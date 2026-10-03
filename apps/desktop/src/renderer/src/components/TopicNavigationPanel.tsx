import { useState } from 'react'
import type { ScratchTopicSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { TopicKnowledgePanel } from './TopicKnowledgePanel'
import { WorkspaceTopicsPanel } from './WorkspaceTopicsPanel'
import { LiquidSelectionSurface } from './settings/LiquidSelectionSurface'

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
    <nav className="source-control-switch" role="tablist" aria-label="Topic directory view" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      const index = tabs.indexOf(event.target as HTMLButtonElement)
      if (index < 0) return
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
      tabs[next]!.focus(); tabs[next]!.click()
    }}>
      <LiquidSelectionSurface selected={view} active={visible} targetAttribute="data-topic-view" />
      {(['topics', 'knowledge'] as const).map(next => <button key={next} type="button" role="tab" data-topic-view={next}
        aria-label={next === 'topics' ? 'Show Topics' : 'Show Knowledge'} aria-selected={view === next} tabIndex={view === next ? 0 : -1}
        className={view === next ? 'selected' : ''} onClick={() => { if (next === 'knowledge') setKnowledgeOpened(true); setView(next) }}>
        {next === 'topics' ? 'Topics' : 'Knowledge'}
      </button>)}
    </nav>
    <div className="topic-navigation-panel__topics" hidden={view !== 'topics'}>
      <WorkspaceTopicsPanel workspace={workspace} categorySpaceId={categorySpaceId} onRevealDirectory={onRevealDirectory} />
    </div>
    {knowledgeOpened ? <div className="topic-navigation-panel__knowledge" hidden={view !== 'knowledge'}>
      {selectedTopicId && !topic ? <div className="surface-inline-error" role="status">The selected Topic is still restoring. Its workface and Topic directory remain available.</div> :
        <TopicKnowledgePanel key={topic?.id ?? 'all-topics'} workspace={workspace} topic={topic} topics={topics} />}
    </div> : null}
  </section>
}
