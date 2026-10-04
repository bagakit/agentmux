import { useState } from 'react'
import { Plus } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { ScratchTopicSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { useWorkbenchObjectLayout } from '../hooks/useWorkbenchObjectLayout'
import type { WorkbenchTab } from '../lib/workbench-tabs'
import { workbenchTabDisplayName } from '../lib/workbench-tab-presentation'
import { recordForWorkbenchTab, useWorkbenchTabSessions } from '../lib/workbench-session-subscriptions'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useAppStore } from '../store'
import { SelectorListHeader, SelectorRow } from './SelectorList'
import { TopicKnowledgePanel } from './TopicKnowledgePanel'
import { LiquidSelectionSurface } from './settings/LiquidSelectionSurface'

/** The secondary directory reads the same original Zone projection as the workbench. */
export function TopicChatsPanel({ workspace, topic, visible }: { workspace: WorkspaceRecord; topic: ScratchTopicSnapshot; visible: boolean }) {
  const object = useWorkbenchObjectLayout(workspace.id)
  const tabs = useAppStore(state => state.tabs)
  const openTopic = useAppStore(state => state.openScratchTopic)
  const [view, setView] = useState<'chats' | 'knowledge'>('chats')
  const [knowledgeOpened, setKnowledgeOpened] = useState(false)
  const [choosePosition, setChoosePosition] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ownLayout = object.choice?.topicId === topic.id ? object.layout : null
  const chatIds = [...new Set(ownLayout?.groups.flatMap(group => group.tabOrder) ?? [])]
  async function openChat(tabId?: string, groupId?: string): Promise<void> {
    setError(null)
    if (tabId && !groupId) {
      const positions = ownLayout?.groups.filter(group => group.tabOrder.includes(tabId)) ?? []
      groupId = positions.find(group => object.choice?.tabId === tabId && group.id === object.choice.groupId)?.id ?? (positions.length === 1 ? positions[0]!.id : undefined)
      if (positions.length > 1 && !groupId) { setChoosePosition(tabId); return }
    }
    try { await openTopic(topic.id, workspace.id, tabId ? { tabId, ...(groupId ? { groupId } : {}) } : { newTab: true }); setChoosePosition(null) }
    catch (cause) { setError(presentError(cause)) }
  }
  return <section className="topic-chats-panel" aria-label={`Chats in ${topic.title}`}>
    <nav className="source-control-switch" aria-label="Topic content">
      <LiquidSelectionSurface selected={view} active={visible} targetAttribute="data-topic-view" />
      {(['chats', 'knowledge'] as const).map(next => <button key={next} type="button" data-topic-view={next}
        aria-label={next === 'chats' ? 'Show Topic Chats' : 'Show Topic Knowledge'} aria-pressed={view === next}
        className={view === next ? 'selected' : ''} onClick={() => { if (next === 'knowledge') setKnowledgeOpened(true); setView(next) }}>{next === 'chats' ? 'Chats' : 'Knowledge'}</button>)}
    </nav>
    {knowledgeOpened ? <div className="topic-chats-panel__knowledge" hidden={view !== 'knowledge'}><TopicKnowledgePanel workspace={workspace} topic={topic} /></div> : null}
    <div className="topic-chats-panel__chats" hidden={view !== 'chats'}>
      <SelectorListHeader title="Chats" count={chatIds.length} actions={<button type="button" className="icon-button"
        aria-label="New Chat in this Topic" title="New Chat in this Topic" onClick={() => void openChat()}><Plus size={14} /></button>} />
      {error || object.issues.length ? <div className="surface-inline-error" role="status">{error ?? object.issues.join(' ')} Existing discussions are kept.</div> : null}
      <div className="topic-chats-panel__list">{chatIds.map(id => {
        const tab = tabs[id]
        if (!tab) return null
        return <TopicChatRow key={id} tab={tab} selected={object.choice?.tabId === id} onOpen={groupId => void openChat(id, groupId)}
          positions={choosePosition === id ? ownLayout?.groups.flatMap((group, position) => group.tabOrder.includes(id) ? [{ groupId: group.id, label: `Pane ${position + 1}` }] : []) ?? [] : []} />
      })}</div>
      {ownLayout && !chatIds.length ? <p className="topic-knowledge-hint">No open Chats. Use + to start one in this Topic.</p> : null}
    </div>
  </section>
}

function TopicChatRow({ tab, selected, onOpen, positions }: {
  tab: WorkbenchTab; selected: boolean; onOpen(groupId?: string): void; positions: readonly { groupId: string; label: string }[]
}) {
  const sessions = useWorkbenchTabSessions(tab)
  const names = useAppStore(useShallow(state => recordForWorkbenchTab(state.agentNames, tab)))
  const timelines = useAppStore(useShallow(state => recordForWorkbenchTab(state.timelines, tab)))
  const title = workbenchTabDisplayName(tab, sessions, names, timelines)
  const panes = Object.keys(tab.regions).length
  return <div><div className={`workspace-topic-item ${selected ? 'current' : ''}`}>
    <button type="button" className="workspace-topic-entry" data-topic-chat-id={tab.id} aria-label={`Open Chat ${title}`}
      aria-current={selected ? 'page' : undefined} onClick={() => onOpen()}>
      <SelectorRow title={title} titleTooltip={title} subtitle={panes > 1 ? `${panes} panes` : undefined} />
    </button>
  </div>{positions.length ? <div className="topic-chats-panel__positions" role="group" aria-label={`Choose position for ${title}`}>
    {positions.map(position => <button key={position.groupId} type="button" className="small-button"
      data-topic-chat-group-id={position.groupId} onClick={() => onOpen(position.groupId)}>{position.label}</button>)}
  </div> : null}</div>
}
