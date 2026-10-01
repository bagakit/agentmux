import * as ContextMenu from '@radix-ui/react-context-menu'
import * as DropdownMenu from './HoverDropdownMenu'
import { ArrowUpRight, Inbox, MoreHorizontal, PanelRightClose, Pencil, Square } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { FocusContext } from '../lib/focus-context'
import type { WorkbenchTab } from '../lib/workbench-tabs'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { formatTabAddress } from '../lib/agent-address'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { createPmoTeamsTopicTargetSelector, pmoTeamsTopicFloatingTargetTopicId, usePmoTeamsTopicFloatingState } from '../lib/pmo-teams-topic-floating'
import { primaryMoteExecutorId } from '../lib/primary-mote-executor'
import { topicIdForSession } from '../lib/workbench-tabs'
import { scratchTopicKind, scratchTopicsForWorkspace } from '../lib/scratch-topic-snapshots'
import { recordForWorkbenchTab, useWorkbenchTabSessions } from '../lib/workbench-session-subscriptions'
import { workbenchTabDisplayName } from '../lib/workbench-tab-presentation'
import { useAppStore } from '../store'
import { resolveOverlayContainer } from './WindowOverlayHost'
import { MoteIcon } from './MoteIcon'

export function FocusToolbar({ children, selectedId, selected, tab, reference, onReview, onCloseWorkspace, regionOnly, onToggleRegion }: {
  children: ReactNode; selectedId: string | null; selected: FocusContext | undefined; tab: WorkbenchTab | null; reference?: WorkbenchProjectionSelection | undefined; onReview(): void; onCloseWorkspace(): void; regionOnly?: boolean | undefined; onToggleRegion?: (() => void) | undefined
}) {
  return <header className="focus-toolbar">
    <div className="focus-toolbar__filters">{children}</div>
    {selectedId ? <FocusToolbarContext key={JSON.stringify([selectedId, tab?.id])} selectedId={selectedId} selected={selected} tab={tab} reference={reference} onReview={onReview} onCloseWorkspace={onCloseWorkspace} regionOnly={regionOnly} onToggleRegion={onToggleRegion} /> : null}
  </header>
}
function FocusToolbarContext({ selectedId, selected, tab, reference, onReview, onCloseWorkspace, regionOnly, onToggleRegion }: {
  selectedId: string; selected: FocusContext | undefined; tab: WorkbenchTab | null; reference?: WorkbenchProjectionSelection | undefined; onReview(): void; onCloseWorkspace(): void; regionOnly?: boolean | undefined; onToggleRegion?: (() => void) | undefined
}) {
  const renameTab = useAppStore(state => state.renameTab)
  const sessions = useWorkbenchTabSessions(tab ?? undefined)
  const agentNames = useAppStore(useShallow(state => recordForWorkbenchTab(state.agentNames, tab ?? undefined)))
  const timelines = useAppStore(useShallow(state => recordForWorkbenchTab(state.timelines, tab ?? undefined)))
  const [floating] = usePmoTeamsTopicFloatingState()
  const [discussionPending, setDiscussionPending] = useState(false)
  const discussionFlight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [draft, setDraft] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const renameRef = useRef<HTMLInputElement>(null)
  const identityRef = useRef<HTMLButtonElement>(null)
  const menuOriginRef = useRef<HTMLButtonElement | null>(null)
  const menuEscapeReturnRef = useRef<HTMLButtonElement | null>(null)
  const renameCancelledRef = useRef(false)
  const originalTerminal = tab && Object.values(tab.regions).some(surface => surface.kind === 'terminal' && surface.sessionId === selectedId)
  const name = tab ? workbenchTabDisplayName(tab, sessions, agentNames, timelines) : selected?.name || 'Session awaiting recovery'
  const statusLabel = selected?.stateLabel ?? (originalTerminal ? 'Terminal' : 'Recovery unknown')
  useEffect(() => {
    if (draft !== null) { renameRef.current?.focus(); renameRef.current?.select() }
    else if (renameCancelledRef.current) { renameCancelledRef.current = false; identityRef.current?.focus() }
  }, [draft === null])
  function closeMenuFocus(event: Event) {
    // Selected actions and outside interaction keep their own destination.
    event.preventDefault()
    const origin = menuEscapeReturnRef.current
    menuEscapeReturnRef.current = null
    origin?.focus()
  }
  function commitRename() {
    if (draft === null) return
    const value = draft.trim() || null
    if (tab) renameTab(tab.id, value)
    setDraft(null)
  }
  function currentReference(): WorkbenchProjectionSelection | null {
    const state = useAppStore.getState()
    if (reference && tab?.id === reference.tabId && state.tabs[reference.tabId]?.regions[reference.regionId] &&
      state.layouts[reference.displayWorkspaceId]?.groups.some(group => group.id === reference.groupId && group.tabOrder.includes(reference.tabId))) return reference
    state.reportError(new Error('The displayed Tab location is unconfirmed. Its original work surface is kept; choose an available Focus location.'), { kind: 'indeterminate' })
    return null
  }
  function viewInSpace() {
    const target = currentReference()
    if (!target) return
    const state = useAppStore.getState()
    void state.selectWorkspace(target.displayWorkspaceId)
    state.focusRegion(target.displayWorkspaceId, target.tabId, target.regionId, 'keyboard', target.groupId)
  }
  async function chatAboutTab() {
    if (discussionFlight.current) return
    const target = currentReference()
    if (!target) return
    const state = useAppStore.getState()
    const topicId = pmoTeamsTopicFloatingTargetTopicId(floating, state.tabs)
    const scratch = state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
    if (scratchTopicKind(topicId, scratchTopicsForWorkspace(state.scratchTopicSnapshots, scratch)) !== 'mote') {
      state.reportError(new Error('The selected Mote identity is unconfirmed. The displayed Tab and original drafts are kept; restore the same Mote before retrying.'), { kind: 'indeterminate' })
      return
    }
    const targetTabId = createPmoTeamsTopicTargetSelector(floating)(state)
    const moteTab = targetTabId ? state.tabs[targetTabId] : undefined
    const region = moteTab?.regions[moteTab.layout.activeRegionId]
    const session = region?.kind === 'agent' ? state.sessions.find(item => item.id === region.sessionId) : undefined
    const executorId = topicId === PMO_TEAMS_TOPIC_ID ? primaryMoteExecutorId(state)
      : session?.kind === 'agent' && topicIdForSession(state.config, session) === topicId &&
        state.config?.executors[session.executorId]?.providerId === session.providerId ? session.executorId : undefined
    const prompt = `Discuss this Tab with me. Inspect this exact complete work surface before suggesting or making changes.\n\n${formatTabAddress(target.tabId)}`
    discussionFlight.current = true; setDiscussionPending(true)
    const errorBefore = state.error
    try {
      await state.openScratchTopic(topicId, SCRATCH_WORKSPACE_ID, { newTab: true, reveal: false, initialRequest: { prompt, ...(executorId ? { executorId } : {}) } })
    } catch (cause) {
      if (useAppStore.getState().error === errorBefore) useAppStore.getState().reportError(cause, { kind: 'indeterminate', summary: 'Mote discussion preparation is unconfirmed. The original Tab and drafts are kept.' })
    } finally {
      discussionFlight.current = false
      if (mounted.current) setDiscussionPending(false)
    }
  }
  const actions = [
    ...(tab ? [{ key: 'rename', label: 'Rename Tab', icon: Pencil, run: () => setDraft(name) }] : []),
    ...(tab && onToggleRegion ? [{ key: 'level', label: regionOnly ? 'Show entire Tab' : 'Show only this Region', icon: Square, run: onToggleRegion }] : []),
    ...(selected?.actionable ? [{ key: 'review', label: 'Review request', icon: Inbox, run: onReview }] : []),
    { key: 'close', label: 'Close Focus workspace', icon: PanelRightClose, run: onCloseWorkspace }
  ]
  return <div className="focus-toolbar__context">
    {draft !== null ? <input ref={renameRef} className="focus-toolbar__rename" aria-label="Rename Tab" value={draft} onChange={event => setDraft(event.target.value)} onBlur={commitRename} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); commitRename() } if (event.key === 'Escape') { event.preventDefault(); renameCancelledRef.current = true; setDraft(null) } }} /> : <ContextMenu.Root>
      <ContextMenu.Trigger asChild><button ref={identityRef} type="button" className="focus-toolbar__identity" aria-label={`Focus context: ${name}`} title={`${name} · ${statusLabel} · Right-click for Focus actions`} onKeyDown={event => { if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') { event.preventDefault(); menuOriginRef.current = event.currentTarget; setMenuOpen(true) } }}><strong>{name}</strong><small>{selected?.stateLabel}</small></button></ContextMenu.Trigger>
      <ContextMenu.Portal container={resolveOverlayContainer() as HTMLElement | undefined}><ContextMenu.Content className="tab-context-menu" collisionPadding={8} onEscapeKeyDown={() => { menuEscapeReturnRef.current = identityRef.current }} onCloseAutoFocus={closeMenuFocus}>{actions.map(action => <ContextMenu.Item key={action.key} className="tab-context-menu__item" onSelect={action.run}><action.icon size={14} /><span>{action.label}</span></ContextMenu.Item>)}</ContextMenu.Content></ContextMenu.Portal>
    </ContextMenu.Root>}
    <button type="button" className="focus-toolbar__action" aria-label="View in Space" title={`View in Space · ${name}`} onClick={viewInSpace}><ArrowUpRight size={14} aria-hidden="true" /><span>Space</span></button>
    <button type="button" className="focus-toolbar__action" aria-label="Chat about this tab with Mote" title={`Chat about this tab with Mote · ${name}`} disabled={discussionPending} aria-busy={discussionPending} onClick={() => { void chatAboutTab() }}><MoteIcon size={14} /><span>{discussionPending ? 'Preparing…' : 'Chat'}</span></button>
    {selected?.actionable ? <button type="button" className="focus-toolbar__review" aria-label="Review request" title="Review request" onClick={onReview}><Inbox size={12} /><span>Review</span></button> : null}
    <div id="focus-workspace-slot-header" className="focus-toolbar__region-slot" />
    <DropdownMenu.Root modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenu.Trigger asChild><button type="button" className="icon-button" aria-label="Focus context actions" onPointerEnter={event => { if (!menuOpen && event.pointerType === 'mouse' && event.buttons === 0) menuOriginRef.current = null }} onPointerDown={event => { menuOriginRef.current = event.currentTarget }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') menuOriginRef.current = event.currentTarget }}><MoreHorizontal size={14} /></button></DropdownMenu.Trigger>
      <DropdownMenu.Portal container={resolveOverlayContainer() as HTMLElement | undefined}><DropdownMenu.Content className="tab-context-menu" align="end" collisionPadding={8} onEscapeKeyDown={() => { menuEscapeReturnRef.current = menuOriginRef.current }} onCloseAutoFocus={closeMenuFocus}>{actions.map(action => <DropdownMenu.Item key={action.key} className="tab-context-menu__item" onSelect={action.run}><action.icon size={14} /><span>{action.label}</span></DropdownMenu.Item>)}</DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
    <button type="button" className="icon-button" aria-label="Close Focus workspace" onClick={onCloseWorkspace}><PanelRightClose size={14} /></button>
  </div>
}
