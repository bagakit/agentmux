import { useCallback, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useMoteDialogue } from '@agentmux/client-ui/use-mote-dialogue'
import type { MoteDialogueLink } from '@agentmux/core/mote-dialogue'
import { MoteWorkThreads, moteWorkEvents, type MoteWorkReader, type MoteThreadView } from '@agentmux/client-ui/components/MoteConversationThreads'
import type { MoteThreadCount } from './MoteThreadNavigation'
import { useMoteDialogueView } from '../lib/mote-dialogue-view'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import { moteMembers } from '../lib/mote-team'
import { workbenchSelectionCatalog } from '../lib/desktop-focus-navigation'
import { workbenchNavigationTabs } from '../lib/workbench-navigation-catalog'
import { sameWorkbenchProjectionSelection, type WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { useAppStore } from '../store'
import { api } from '../lib/api'
import { MoteCooperation } from './MoteCooperation'
import { MotePrivateConversations } from './MotePrivateConversations'
import { copyMoteAddress } from '../lib/mote-address-copy'
import { sessionPresentationById } from '../lib/session-presentation'

type WorkSource = Extract<MoteDialogueLink, { kind: 'work' }>

/** Threads reads original work sources even when the Main native conversation is unavailable. */
export function MoteThreadsPanel({ scope, active, observe = active, onSelect, onOpenOriginal, requestedEvent, view, onViewChange, onCount }: {
  scope: MoteWorkfaceScope; active: boolean; requestedEvent?: { eventId: string; token: string } | undefined; onSelect(reference: WorkbenchProjectionSelection): boolean
  onOpenOriginal(reference: WorkbenchProjectionSelection): boolean
  observe?: boolean; view?: MoteThreadView | undefined; onViewChange?: ((view: MoteThreadView) => void) | undefined
  onCount?: ((view: MoteThreadView, count: MoteThreadCount) => void) | undefined
}) {
  const dialogue = useMoteDialogueView()
  const workCount = dialogue?.page?.sourceStatus === 'read' ? moteWorkEvents(dialogue.page.links).length : null
  useEffect(() => { if (observe) onCount?.('work', { value: workCount, more: Boolean(dialogue?.page?.next), unavailable: Boolean(dialogue?.issue) }) }, [observe, workCount, dialogue?.page?.next, dialogue?.issue, onCount])
  const privateCount = useCallback((count: MoteThreadCount) => onCount?.('private', count), [onCount])
  const direct = useMoteDialogue(api.moteDialogue.read, dialogue?.target ?? undefined, active && requestedEvent !== undefined,
    requestedEvent?.token, requestedEvent ? { kind: 'work', eventId: requestedEvent.eventId } : undefined)
  const work = requestedEvent ? direct : dialogue
  const requestedIssue = requestedEvent && direct.page && !direct.loading && !direct.page.links.some(link => link.kind === 'work' && link.eventId === requestedEvent.eventId)
    ? '原工作 thread 尚未在这个 Mote 的关联来源中确认。准确引用仍保留；可重读同一来源。' : null
  const facts = useAppStore(useShallow(state => ({ config: state.config, tabs: workbenchNavigationTabs(state.tabs), layouts: state.layouts,
    spaceZoneBindings: state.spaceZoneBindings, topicCategories: state.topicCategories, projectGroups: state.projectGroups,
    scratchTopicSnapshots: state.scratchTopicSnapshots })))
  const members = useMemo(() => dialogue?.target ? moteMembers(workbenchSelectionCatalog(useAppStore.getState()), dialogue.target.spaceId) : [], [facts, dialogue?.target?.spaceId])
  const [issue, setIssue] = useState(''), [locations, setLocations] = useState<{ source: WorkSource; references: WorkbenchProjectionSelection[] } | null>(null)
  const readWork = useCallback<MoteWorkReader>(async source => {
    const result = await api.sessions.dispatch({ hostId: source.origin.hostId, agentSessionId: source.main.agentSessionId }, source.origin.messageId)
    if (result.hostId !== source.origin.hostId) throw new Error('工作来源的 Host 未能核对。原引用仍保留。')
    return result
  }, [])
  function originalLocations(source: WorkSource): WorkbenchProjectionSelection[] {
    const state = useAppStore.getState(), catalog = workbenchSelectionCatalog(state), sessions = sessionPresentationById(state.sessions)
    const regions = new Set(catalog.regions.filter(region => {
      if (region.kind !== 'agent' || region.agentSessionId !== source.origin.recipientSessionId) return false
      const surface = state.tabs[region.tabId]?.regions[region.regionId]
      const session = surface?.kind === 'agent' ? sessions.get(surface.sessionId) : undefined
      const bound = session?.kind === 'agent' && session.control.hostId === source.origin.hostId &&
        session.control.agentSessionId === source.origin.recipientSessionId
      if (session && !bound) return false
      return region.execution ? region.execution.hostId === source.origin.hostId : bound
    })
      .map(region => JSON.stringify([region.tabId, region.regionId])))
    const references = new Map<string, WorkbenchProjectionSelection>()
    for (const location of catalog.locations) if (regions.has(JSON.stringify([location.tabId, location.regionId]))) {
      const reference = { displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId, tabId: location.tabId, regionId: location.regionId }
      references.set(JSON.stringify(reference), reference)
    }
    return [...references.values()]
  }
  function openOriginal(source: WorkSource, selected?: WorkbenchProjectionSelection) {
    const references = originalLocations(source)
    const reference = selected ? references.find(value => sameWorkbenchProjectionSelection(value, selected)) : references.length === 1 ? references[0] : undefined
    if (reference) {
      if (onOpenOriginal(reference)) { setIssue(''); setLocations(null) }
      else setIssue('原工作位置尚未确认。原对话和工作来源仍保留；请重读同一位置。')
    } else if (!selected && references.length) { setIssue(''); setLocations({ source, references }) }
    else setIssue('这个原执行成员的位置暂未确认。原工作仍可读；请重读原空间位置。')
  }
  if (!dialogue) return null
  return <div className="mote-threads-panel" hidden={!active}>
    <MoteWorkThreads page={work?.page ?? null} issue={work?.issue ?? requestedIssue} loading={work?.loading ?? false} visible={active} readWork={readWork} requestedEvent={requestedEvent} view={view} onViewChange={onViewChange} showViews={view === undefined}
      renderEventActions={event => dialogue.target ? <button type="button" className="mote-conversation__link" aria-label="复制 thread 链接" onClick={() => {
        void copyMoteAddress({ spaceId: dialogue.target!.spaceId, eventId: event.id }, useAppStore.getState().reportError)
      }}>复制 thread 链接</button> : null}
      memberName={source => members.find(member => member.hostId === source.origin.hostId && member.agentSessionId === source.origin.recipientSessionId)?.regions.find(region => region.title)?.title ?? source.origin.recipientSessionId}
      onRefresh={() => work?.refresh()} onOlder={() => void work?.older()}
      privateChats={visible => <MotePrivateConversations scope={scope} active={visible} observe={observe} onCount={privateCount} />}
      members={{ count: null, content: visible => <MoteCooperation scope={scope} active={visible} presentation="threads" onSelect={onSelect} /> }} onOpenWork={source => openOriginal(source)} />
    {issue ? <p role="status" className="mote-conversation__issue">{issue}</p> : null}
    {locations ? <div className="mote-threads-panel__locations" role="group" aria-label="选择原工作位置">
      {locations.references.map((reference, index) => <button type="button" key={JSON.stringify(reference)} onClick={() => openOriginal(locations.source, reference)}>
        位置 {index + 1} · {facts.config?.workspaces.find(workspace => workspace.id === reference.displayWorkspaceId)?.name ?? '项目未确认'}</button>)}
      <button type="button" onClick={() => setLocations(null)}>取消</button>
    </div> : null}
  </div>
}
