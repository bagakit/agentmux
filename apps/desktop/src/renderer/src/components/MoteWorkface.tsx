import { BookOpen, Check, FileText, Plus, X } from 'lucide-react'
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { regionIds } from '@agentmux/layout'
import { MOTE_SOUL_PATH } from '../../../shared/scratch-topics'
import { useAppStore } from '../store'
import { MoteWorkfaceContext, useMoteWorkfaceScope } from '../lib/mote-workface'
import { useMoteMaterialsActions } from '../lib/mote-materials-actions'
import { recordForWorkbenchTab, useWorkbenchTabSessions } from '../lib/workbench-session-subscriptions'
import { workbenchTabDisplayName, workbenchAgentFactsFor } from '../lib/workbench-tab-presentation'
import { agentDisplayName, type WorkbenchTab } from '../lib/workbench-tabs'
import { regionDisplayNames, regionSurfaceLabel } from '../lib/region-display-name'
import { isSessionSurface } from '../lib/workbench-surface-kinds'
import { isImeOwnedKeyboardEvent } from '../lib/ime-composition-keyboard-event'
import { FileExplorer } from './FileExplorer'
import { StatusDot } from './StatusDot'

/** This wrapper never owns or recreates any View, Session or input. */
export function MoteWorkface({ workspaceId, topicId, floating = false, visible = true, onTabSelect, materialsRequest, children }: {
  workspaceId: string; topicId?: string | undefined; floating?: boolean; visible?: boolean
  onTabSelect?: ((tabId: string) => void) | undefined; children: ReactNode
  materialsRequest?: { topicId: string; token: object } | null | undefined
}) {
  const scope = useMoteWorkfaceScope(workspaceId, topicId)
  const [materials, setMaterials] = useState(false)
  const [allFiles, setAllFiles] = useState(false)
  const { open, terminal } = useMoteMaterialsActions(visible ? scope : null, { floating, onTabSelect, onOpened: () => setMaterials(false) })
  const context = useMemo(() => scope ? { ...scope, floating,
    materials: () => { setAllFiles(false); setMaterials(value => !value) },
    persona: () => { void open(scope.rootPath + '/' + MOTE_SOUL_PATH) },
    selectTab: (tabId: string, groupId: string) => onTabSelect ? onTabSelect(tabId) : useAppStore.getState().activateTab(workspaceId, groupId, tabId)
  } : null, [scope, floating, open, onTabSelect, workspaceId])
  useEffect(() => { setMaterials(false); setAllFiles(false) }, [scope?.topic.id, visible])
  useEffect(() => { if (visible && scope?.topic.id === materialsRequest?.topicId) { setAllFiles(false); setMaterials(true) } }, [materialsRequest, scope?.topic.id, visible])
  return <MoteWorkfaceContext.Provider value={context}>
    <div className={scope ? 'mote-workface' : 'mote-workface mote-workface--ordinary'} data-mote-workface={scope?.topic.id}>
      <div className="mote-workface__original">{children}</div>
      {scope && materials && visible ? <aside className="mote-materials" aria-label={scope.topic.title + ' materials'}>
        <header><span><BookOpen size={13} /><strong>{allFiles ? 'All files' : scope.topic.title + ' · Materials'}</strong></span>
          <button type="button" aria-label="Close materials" onClick={() => setMaterials(false)}><X size={13} /></button></header>
        <button type="button" className="mote-materials__scope" onClick={() => setAllFiles(value => !value)}>
          {allFiles ? 'Back to this Mote' : 'Show all files'}</button>
        <FileExplorer key={scope.topic.id + ':' + allFiles} workspaceId={workspaceId} rootPath={allFiles ? '' : scope.rootPath}
          rootLabel={allFiles ? scope.workspace.name : scope.topic.title} onOpenPath={open} onOpenTerminal={terminal} />
      </aside> : null}
    </div>
  </MoteWorkfaceContext.Provider>
}

export function MoteDiscussionTitle({ tab }: { tab: WorkbenchTab | null }) {
  const sessions = useWorkbenchTabSessions(tab ?? undefined)
  const names = useAppStore(useShallow(state => recordForWorkbenchTab(state.agentNames, tab ?? undefined)))
  const timelines = useAppStore(useShallow(state => recordForWorkbenchTab(state.timelines, tab ?? undefined)))
  const title = tab ? workbenchTabDisplayName(tab, sessions, names, timelines) : 'No discussion yet'
  return <span className="mote-discussion-title" title={title}>{title}</span>
}

export function MoteWorkfaceNavigation({ children, onNewTab, root }: { children: ReactNode; onNewTab(): void; root: boolean }) {
  const context = useContext(MoteWorkfaceContext)
  if (!context) return null
  return <>
    {root && !context.floating ? <div className="mote-conversations__identity"><small>Mote</small><strong title={context.topic.title}>{context.topic.title}</strong></div> : null}
    <div className="mote-conversations__heading"><span>Discussions</span><button type="button" title="New discussion" aria-label="New discussion" onClick={onNewTab}><Plus size={13} /></button></div>
    <div className="mote-conversations__list">{children}</div>
    {root ? <div className="mote-conversations__secondary">
      <button type="button" onClick={context.materials}><BookOpen size={13} /> Materials</button>
      <button type="button" onClick={context.persona}><FileText size={13} /> Edit persona</button>
    </div> : null}
  </>
}

export function MoteTabRegions({ tab, groupId }: { tab: WorkbenchTab; groupId: string }) {
  const context = useContext(MoteWorkfaceContext)
  const sessions = useWorkbenchTabSessions(tab)
  const names = useAppStore(useShallow(state => recordForWorkbenchTab(state.agentNames, tab)))
  const timelines = useAppStore(useShallow(state => recordForWorkbenchTab(state.timelines, tab)))
  const facts = useMemo(() => workbenchAgentFactsFor(sessions, names, timelines), [sessions, names, timelines])
  const regions = regionIds(tab.layout.root).flatMap(id => tab.regions[id] ? [tab.regions[id]!] : [])
  const labels = regionDisplayNames(regions.map(region => ({ regionId: region.regionId,
    label: region.kind === 'agent' && facts(region.sessionId) ? agentDisplayName(facts(region.sessionId)!) : regionSurfaceLabel(region, sessions) })))
  return <div className="mote-conversations__regions" role="group" aria-label="Sessions and Regions in this discussion">
    {regions.map((region, index) => {
      const session = isSessionSurface(region) ? sessions.find(item => item.id === region.sessionId) : undefined
      return <button key={region.regionId} type="button" data-mote-session-region={region.regionId} data-mote-session-id={session?.id}
        aria-current={tab.layout.activeRegionId === region.regionId ? 'true' : undefined} title={labels[index]?.name}
        onClick={() => { context?.selectTab(tab.id, groupId); useAppStore.getState().focusRegion(tab.workspaceId, tab.id, region.regionId, context?.floating ? 'floating-pointer' : 'pointer', groupId) }}>
        {session ? <StatusDot status={session.status} /> : <span className="mote-conversations__region-mark" aria-hidden="true">·</span>}
        <span>{labels[index]?.name}</span>{tab.layout.activeRegionId === region.regionId ? <Check size={10} /> : null}
      </button>
    })}
  </div>
}

/** A single local width observer, independent of Session output. */
export function useMoteNavigationWidth(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(true)
  const [override, setOverride] = useState<boolean | null>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!enabled || !element) return
    const read = () => setNarrow(element.getBoundingClientRect().width < 620)
    const observer = new ResizeObserver(read); observer.observe(element); read()
    return () => observer.disconnect()
  }, [enabled])
  const open = override ?? !narrow
  useEffect(() => setOverride(null), [narrow, enabled])
  return { ref, narrow, open, toggle: () => setOverride(!open), close: () => { if (narrow) setOverride(false) },
    onKeyDown: (event: React.KeyboardEvent) => { if (event.key === 'Escape' && narrow && open && !isImeOwnedKeyboardEvent(event.nativeEvent)) { event.preventDefault(); event.stopPropagation(); setOverride(false) } } }
}
