import * as ContextMenu from '@radix-ui/react-context-menu'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ArrowUpRight, Inbox, MoreHorizontal, PanelRightClose, Pencil } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { findGroup } from '@agentmux/layout'
import type { FocusContext } from '../lib/focus-context'
import type { WorkbenchTab } from '../lib/workbench-tabs'
import { isSessionSurface } from '../lib/workbench-surface-kinds'
import { useAppStore } from '../store'
import { resolveOverlayContainer } from './WindowOverlayHost'

export function FocusToolbar({ children, selectedId, selected, tab, onReview, onCloseWorkspace }: {
  children: ReactNode; selectedId: string | null; selected: FocusContext | undefined; tab: WorkbenchTab | null; onReview(): void; onCloseWorkspace(): void
}) {
  return <header className="focus-toolbar">
    <div className="focus-toolbar__filters">{children}</div>
    {selectedId ? <FocusToolbarContext key={selectedId} selectedId={selectedId} selected={selected} tab={tab} onReview={onReview} onCloseWorkspace={onCloseWorkspace} /> : null}
  </header>
}
function FocusToolbarContext({ selectedId, selected, tab, onReview, onCloseWorkspace }: {
  selectedId: string; selected: FocusContext | undefined; tab: WorkbenchTab | null; onReview(): void; onCloseWorkspace(): void
}) {
  const renameAgent = useAppStore(state => state.renameAgent)
  const renameTab = useAppStore(state => state.renameTab)
  const setMainSurface = useAppStore(state => state.setMainSurface)
  const [draft, setDraft] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const renameRef = useRef<HTMLInputElement>(null)
  const identityRef = useRef<HTMLButtonElement>(null)
  const menuOriginRef = useRef<HTMLButtonElement | null>(null)
  const menuEscapeReturnRef = useRef<HTMLButtonElement | null>(null)
  const renameCancelledRef = useRef(false)
  const name = (selected?.kind === 'terminal' ? tab?.name : null) || selected?.name || 'Session awaiting recovery'
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
    if (selected?.kind === 'agent') renameAgent(selectedId, value)
    else if (tab) renameTab(tab.id, value)
    setDraft(null)
  }
  function continueInSpace() {
    setMainSurface('workbench')
    const state = useAppStore.getState()
    const layout = state.activeWorkspaceId ? state.layouts[state.activeWorkspaceId] : undefined
    const tabId = layout ? findGroup(layout, layout.activeGroupId)?.activeTabId : null
    const activeTab = tabId ? state.tabs[tabId] : undefined
    const activeSurface = activeTab?.regions[activeTab.layout.activeRegionId]
    if (activeTab && activeSurface && isSessionSurface(activeSurface) && activeSurface.sessionId === selectedId) {
      state.focusRegion(activeTab.workspaceId, activeTab.id, activeSurface.regionId, 'keyboard')
    }
  }
  const actions = [
    ...(selected?.kind === 'agent' || tab ? [{ key: 'rename', label: selected?.kind === 'agent' ? 'Rename Agent' : 'Rename Tab', icon: Pencil, run: () => setDraft(name) }] : []),
    { key: 'space', label: 'Continue in Space', icon: ArrowUpRight, run: continueInSpace },
    ...(selected?.actionable ? [{ key: 'review', label: 'Review request', icon: Inbox, run: onReview }] : []),
    { key: 'close', label: 'Close Focus workspace', icon: PanelRightClose, run: onCloseWorkspace }
  ]
  return <div className="focus-toolbar__context">
    {draft !== null ? <input ref={renameRef} className="focus-toolbar__rename" aria-label="Rename Focus context" value={draft} onChange={event => setDraft(event.target.value)} onBlur={commitRename} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); commitRename() } if (event.key === 'Escape') { event.preventDefault(); renameCancelledRef.current = true; setDraft(null) } }} /> : <ContextMenu.Root>
      <ContextMenu.Trigger asChild><button ref={identityRef} type="button" className="focus-toolbar__identity" aria-label={`Focus context: ${name}`} title={`${name} · ${selected?.stateLabel ?? 'Recovery unknown'} · Right-click for Focus actions`} onKeyDown={event => { if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') { event.preventDefault(); menuOriginRef.current = event.currentTarget; setMenuOpen(true) } }}><strong>{name}</strong><small>{selected?.stateLabel}</small></button></ContextMenu.Trigger>
      <ContextMenu.Portal container={resolveOverlayContainer() as HTMLElement | undefined}><ContextMenu.Content className="tab-context-menu" collisionPadding={8} onEscapeKeyDown={() => { menuEscapeReturnRef.current = identityRef.current }} onCloseAutoFocus={closeMenuFocus}>{actions.map(action => <ContextMenu.Item key={action.key} className="tab-context-menu__item" onSelect={action.run}><action.icon size={14} /><span>{action.label}</span></ContextMenu.Item>)}</ContextMenu.Content></ContextMenu.Portal>
    </ContextMenu.Root>}
    {selected?.actionable ? <button type="button" className="focus-toolbar__review" onClick={onReview}><Inbox size={12} />Review</button> : null}
    <DropdownMenu.Root modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenu.Trigger asChild><button type="button" className="icon-button" aria-label="Focus context actions" onPointerDown={event => { menuOriginRef.current = event.currentTarget }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') menuOriginRef.current = event.currentTarget }}><MoreHorizontal size={14} /></button></DropdownMenu.Trigger>
      <DropdownMenu.Portal container={resolveOverlayContainer() as HTMLElement | undefined}><DropdownMenu.Content className="tab-context-menu" align="end" collisionPadding={8} onEscapeKeyDown={() => { menuEscapeReturnRef.current = menuOriginRef.current }} onCloseAutoFocus={closeMenuFocus}>{actions.map(action => <DropdownMenu.Item key={action.key} className="tab-context-menu__item" onSelect={action.run}><action.icon size={14} /><span>{action.label}</span></DropdownMenu.Item>)}</DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
    <button type="button" className="icon-button" aria-label="Close Focus workspace" onClick={onCloseWorkspace}><PanelRightClose size={14} /></button>
  </div>
}
