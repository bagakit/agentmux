import * as ContextMenu from '@radix-ui/react-context-menu'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ArrowUpRight, Inbox, MoreHorizontal, PanelRightClose, Pencil } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { FocusContext } from '../lib/focus-context'
import type { WorkbenchTab } from '../lib/workbench-tabs'
import { useAppStore } from '../store'
import { resolveOverlayContainer } from './WindowOverlayHost'

export function FocusToolbar({ children, selectedId, selected, tab, onReview }: {
  children: ReactNode; selectedId: string | null; selected: FocusContext | undefined; tab: WorkbenchTab | null; onReview(): void
}) {
  return <header className="focus-toolbar">
    <div className="focus-toolbar__filters">{children}</div>
    {selectedId ? <FocusToolbarContext key={selectedId} selectedId={selectedId} selected={selected} tab={tab} onReview={onReview} /> : null}
  </header>
}
function FocusToolbarContext({ selectedId, selected, tab, onReview }: {
  selectedId: string; selected: FocusContext | undefined; tab: WorkbenchTab | null; onReview(): void
}) {
  const renameAgent = useAppStore(state => state.renameAgent)
  const renameTab = useAppStore(state => state.renameTab)
  const setMainSurface = useAppStore(state => state.setMainSurface)
  const focusExecutionSession = useAppStore(state => state.focusExecutionSession)
  const [draft, setDraft] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const renameRef = useRef<HTMLInputElement>(null)
  const name = (selected?.kind === 'terminal' ? tab?.name : null) || selected?.name || 'Session awaiting recovery'
  useEffect(() => { if (draft !== null) { renameRef.current?.focus(); renameRef.current?.select() } }, [draft === null])
  function commitRename() {
    if (draft === null) return
    const value = draft.trim() || null
    if (selected?.kind === 'agent') renameAgent(selectedId, value)
    else if (tab) renameTab(tab.id, value)
    setDraft(null)
  }
  const actions = [
    ...(selected?.kind === 'agent' || tab ? [{ key: 'rename', label: selected?.kind === 'agent' ? 'Rename Agent' : 'Rename Tab', icon: Pencil, run: () => setDraft(name) }] : []),
    { key: 'space', label: 'Continue in Space', icon: ArrowUpRight, run: () => setMainSurface('workbench') },
    ...(selected?.actionable ? [{ key: 'review', label: 'Review request', icon: Inbox, run: onReview }] : []),
    { key: 'close', label: 'Close Focus workspace', icon: PanelRightClose, run: () => focusExecutionSession(null) }
  ]
  return <div className="focus-toolbar__context">
    {draft !== null ? <input ref={renameRef} className="focus-toolbar__rename" aria-label="Rename Focus context" value={draft} onChange={event => setDraft(event.target.value)} onBlur={commitRename} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); commitRename() } if (event.key === 'Escape') { event.preventDefault(); setDraft(null) } }} /> : <ContextMenu.Root>
      <ContextMenu.Trigger asChild><button type="button" className="focus-toolbar__identity" aria-label={`Focus context: ${name}`} title={`${name} · ${selected?.stateLabel ?? 'Recovery unknown'} · Right-click for Focus actions`} onKeyDown={event => { if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') { event.preventDefault(); setMenuOpen(true) } }}><strong>{name}</strong><small>{selected?.stateLabel}</small></button></ContextMenu.Trigger>
      <ContextMenu.Portal container={resolveOverlayContainer() as HTMLElement | undefined}><ContextMenu.Content className="tab-context-menu" collisionPadding={8} onCloseAutoFocus={event => event.preventDefault()}>{actions.map(action => <ContextMenu.Item key={action.key} className="tab-context-menu__item" onSelect={action.run}><action.icon size={14} /><span>{action.label}</span></ContextMenu.Item>)}</ContextMenu.Content></ContextMenu.Portal>
    </ContextMenu.Root>}
    {selected?.actionable ? <button type="button" className="focus-toolbar__review" onClick={onReview}><Inbox size={12} />Review</button> : null}
    <DropdownMenu.Root modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenu.Trigger asChild><button type="button" className="icon-button" aria-label="Focus context actions"><MoreHorizontal size={14} /></button></DropdownMenu.Trigger>
      <DropdownMenu.Portal container={resolveOverlayContainer() as HTMLElement | undefined}><DropdownMenu.Content className="tab-context-menu" align="end" collisionPadding={8} onCloseAutoFocus={event => event.preventDefault()}>{actions.map(action => <DropdownMenu.Item key={action.key} className="tab-context-menu__item" onSelect={action.run}><action.icon size={14} /><span>{action.label}</span></DropdownMenu.Item>)}</DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
    <button type="button" className="icon-button" aria-label="Close Focus workspace" onClick={() => focusExecutionSession(null)}><PanelRightClose size={14} /></button>
  </div>
}
