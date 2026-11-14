import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { MoteDialogueViewProvider } from '../lib/mote-dialogue-view'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { moteConnectionTarget } from '../lib/mote-connection-default'
import { useMoteWorkfaceScope } from '../lib/mote-workface'
import { useSpaceContentPresentation } from '../lib/space-content-presentation'
import { SidebarToggleChrome, WindowSidebarLayoutContext } from './TopRowChrome'
import { useAppStore } from '../store'
import { MotePageNavigation } from './MotePageNavigation'
import type { MoteThreadView } from '@agentmux/client-ui/components/MoteConversationThreads'
import { emptyMoteThreadCounts, type MoteThreadCount } from './MoteThreadNavigation'

export type MoteContentSection = 'profile' | 'ideas' | 'calendar'
export type MoteSpaceSection = MoteContentSection | 'discussion' | 'threads'
const MoteSpaceContext = createContext<{
  actionsHost: HTMLSpanElement | null
  topicId: string
  section: MoteSpaceSection
  entryToken?: string | undefined
  threadReference?: WorkbenchProjectionSelection | undefined
  threadEvent?: { eventId: string; token: string } | undefined
  navigationRevision: number
  threadView: MoteThreadView
  selectThreads(view: MoteThreadView, event?: { eventId: string; token: string }): void
  reportCount(view: MoteThreadView, count: MoteThreadCount): void
  select(section: MoteSpaceSection, reference?: WorkbenchProjectionSelection): void
} | null>(null)
export const useMoteSpace = () => useContext(MoteSpaceContext)

/** Local presentation only. The original workbench subtree stays in place in every mode. */
export function MoteSpaceFrame({ workspaceId, active, children }: {
  workspaceId: string | undefined; active: boolean; children: ReactNode
}) {
  const [actionsHost, setActionsHost] = useState<HTMLSpanElement | null>(null)
  const scope = useMoteWorkfaceScope(workspaceId, undefined, active)
  const presentation = useSpaceContentPresentation()
  const bindings = useAppStore(state => state.spaceZoneBindings)
  const objectTarget = scope ? moteConnectionTarget(scope, bindings) : null
  const preferredProjects = useAppStore(state => state.projectRailOpen)
  const sidebars = useContext(WindowSidebarLayoutContext)
  const projectRailOpen = sidebars?.projectRailOpen ?? preferredProjects
  const owner = scope ? JSON.stringify([scope.workspace.hostId, scope.workspace.id, scope.workspace.path, scope.topic.id, scope.rootPath]) : ''
  const [content, setContent] = useState<{ owner: string; section: MoteSpaceSection; revision: number; entryToken?: string; threadReference?: WorkbenchProjectionSelection; threadEvent?: { eventId: string; token: string } }>({ owner, section: 'discussion', revision: 0 })
  const [threads, setThreads] = useState({ owner, view: 'work' as MoteThreadView, counts: emptyMoteThreadCounts() })
  const currentThreads = threads.owner === owner ? threads : { owner, view: 'work' as MoteThreadView, counts: emptyMoteThreadCounts() }
  const reportCount = useCallback((view: MoteThreadView, count: MoteThreadCount) => setThreads(previous => {
    const current = previous.owner === owner ? previous : { owner, view: 'work' as MoteThreadView, counts: emptyMoteThreadCounts() }
    const retained = count.value === null && count.unavailable && current.counts[view].value !== null ? { ...current.counts[view], unavailable: true } : count
    return JSON.stringify(current.counts[view]) === JSON.stringify(retained) ? current : { ...current, counts: { ...current.counts, [view]: retained } }
  }), [owner])
  const consumedEntry = useRef<string | undefined>(undefined)
  const explicitEntry = useAppStore(state => state.moteDiscussionEntry)
  useEffect(() => {
    if (!active || !scope || explicitEntry?.workspaceId !== scope.workspace.id || explicitEntry.topicId !== scope.topic.id || consumedEntry.current === explicitEntry.token) return
    consumedEntry.current = explicitEntry.token
    if (explicitEntry.eventId !== undefined) setThreads(previous => ({ ...(previous.owner === owner ? previous : { owner, counts: emptyMoteThreadCounts() }), view: 'work' }))
    setContent(previous => ({ owner, section: explicitEntry.memberReference || explicitEntry.eventId !== undefined ? 'threads' : 'discussion', revision: previous.revision + 1,
      ...(explicitEntry.memberReference ? { threadReference: explicitEntry.memberReference } : explicitEntry.eventId !== undefined ? { threadEvent: { eventId: explicitEntry.eventId, token: explicitEntry.token } } : { entryToken: explicitEntry.token }) }))
    presentation?.collapse()
  }, [explicitEntry?.token, owner, active])
  const section: MoteSpaceSection = presentation?.expanded ? content.owner === owner && !['discussion', 'threads'].includes(content.section) ? content.section : 'profile' : content.owner === owner && content.section === 'threads' ? 'threads' : 'discussion'
  const select = (next: MoteSpaceSection, reference?: WorkbenchProjectionSelection) => {
    if (next === 'threads' && reference) setThreads(previous => ({ ...(previous.owner === owner ? previous : { owner, counts: emptyMoteThreadCounts() }), view: 'members' }))
    setContent(previous => ({ owner, section: next, revision: previous.revision + 1, ...(next === 'discussion' ? { entryToken: crypto.randomUUID() } : {}),
      ...(next === 'threads' && reference ? { threadReference: reference } : {}) }))
    if (next === 'discussion' || next === 'threads') presentation?.collapse()
    else presentation?.expand()
  }
  const visible = active && scope !== null && presentation !== null
  const selectThreads = (view: MoteThreadView, event?: { eventId: string; token: string }) => {
    setThreads(previous => ({ ...(previous.owner === owner ? previous : { owner, counts: emptyMoteThreadCounts() }), view }))
    setContent(previous => ({ owner, section: 'threads', revision: previous.revision + 1, ...(event ? { threadEvent: event } : {}) }))
    presentation?.collapse()
  }
  return <MoteDialogueViewProvider scope={scope} active={visible}><MoteSpaceContext.Provider value={scope && presentation ? { actionsHost, topicId: scope.topic.id, section, select, threadView: currentThreads.view, selectThreads, reportCount, navigationRevision: content.revision, threadReference: content.owner === owner && section === 'threads' ? content.threadReference : undefined, threadEvent: content.owner === owner && section === 'threads' ? content.threadEvent : undefined, entryToken: content.owner === owner && section === 'discussion' ? content.entryToken : undefined } : null}>
    <WindowSidebarLayoutContext.Provider value={sidebars ? { ...sidebars, chromeInFrame: visible } : null}>
    <div className="mote-space-frame" data-mote-space={visible ? scope.topic.id : undefined} data-mote-space-id={visible ? objectTarget?.spaceId : undefined} data-mote-page={visible ? section : undefined}>
      {scope && presentation ? <MotePageNavigation surface="space" scope={scope} active={visible}
        value={section === 'threads' ? currentThreads.view : section} counts={currentThreads.counts}
        onChange={next => next === 'work' || next === 'private' || next === 'members' ? selectThreads(next) : select(next)}
        leading={!projectRailOpen ? <SidebarToggleChrome /> : null}
        actions={<span className="mote-main-slot" hidden={section !== 'discussion'} ref={setActionsHost} />} /> : null}
      {children}
    </div>
    </WindowSidebarLayoutContext.Provider>
  </MoteSpaceContext.Provider></MoteDialogueViewProvider>
}
