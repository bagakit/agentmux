import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { BrowserPageMenuChoice, BrowserPageMenuEvent, BrowserPageMenuItem } from '../../../shared/browser-page-menu'
import { api } from '../lib/api'
import { WorkbenchDocumentContext } from '../lib/workbench-document'
import { WORKBENCH_TAB_SPLIT_ACTIONS } from '../lib/workbench-tab-actions'
import { workbenchDocumentIdentity, workbenchDocuments } from '../lib/workbench-window-registry'
import { useAppStore } from '../store'
import { DocumentOverlayPortal, getWindowOverlayHost } from './WindowOverlayHost'
import { WorkbenchLayoutMenuRows } from './WorkbenchLayoutMenuRows'

const SubmenuIcon = semanticIconComponent('navigation.submenu')
type OpenMenu = Extract<BrowserPageMenuEvent, { kind: 'opened' }>

function inMenu(target: EventTarget | null, id: string): boolean {
  return (target as Element | null)?.closest?.('[data-browser-page-menu-id]')?.getAttribute('data-browser-page-menu-id') === id
}

function Rows({ menuId, items, choose }: { menuId: string; items: BrowserPageMenuItem[]; choose(input: BrowserPageMenuChoice): void }) {
  return items.map((item, index) => {
    if (item.kind === 'separator') return <DropdownMenu.Separator key={`row-${index}`} className="tab-context-menu__separator" />
    if (item.kind === 'submenu') return <DropdownMenu.Sub key={`row-${index}`}>
      <DropdownMenu.SubTrigger className="tab-context-menu__item">
        <span>{item.label}</span><span className="tab-context-menu__chevron"><SubmenuIcon size={12} /></span>
      </DropdownMenu.SubTrigger>
      <DocumentOverlayPortal component={DropdownMenu.Portal}>
        <DropdownMenu.SubContent className="tab-context-menu" data-browser-page-menu-id={menuId} collisionPadding={8} sideOffset={4}
          onFocusOutside={event => { if (inMenu(event.detail.originalEvent.target, menuId)) event.preventDefault() }}>
          <Rows menuId={menuId} items={item.items} choose={choose} />
        </DropdownMenu.SubContent>
      </DocumentOverlayPortal>
    </DropdownMenu.Sub>
    if (item.kind === 'split') return item.enabled ? <WorkbenchLayoutMenuRows key={`row-${index}`} splitLabel="Split link"
      entries={WORKBENCH_TAB_SPLIT_ACTIONS.map(action => ({ ...action, kind: 'split', onSelect: () => choose({ kind: 'select', itemId: item.directions[action.direction] }) }))}
      Item={DropdownMenu.Item} Group={DropdownMenu.Group} Label={DropdownMenu.Label} />
      : <DropdownMenu.Item key={`row-${index}`} className="tab-context-menu__item" disabled>Split link</DropdownMenu.Item>
    return <DropdownMenu.Item key={item.id} className="tab-context-menu__item" disabled={!item.enabled}
      onSelect={() => choose({ kind: 'select', itemId: item.id })}>{item.label}</DropdownMenu.Item>
  })
}

/** One presenter handles an actual native menu request, including detached documents. */
export function BrowserPageContextMenuHost() {
  const [menu, setMenu] = useState<{ request: OpenMenu; document: Document } | null>(null)
  const active = useRef<string | null>(null)
  const complete = (id: string, choice: BrowserPageMenuChoice) => {
    if (active.current !== id) return
    active.current = null
    setMenu(null)
    void api.browser.choosePageMenu(id, choice).then(accepted => {
      if (!accepted && choice.kind === 'select') useAppStore.getState().reportError(new Error('The original page menu is no longer current. Right-click the target again.'))
    }).catch(error => useAppStore.getState().reportError(error))
  }
  useEffect(() => api.browser.onPageMenu(event => {
    if (event.kind === 'closed') {
      if (active.current === event.id) { active.current = null; setMenu(null) }
      return
    }
    const document = workbenchDocuments().find(candidate => {
      const identity = workbenchDocumentIdentity(candidate)
      return identity?.windowId === event.document.windowId && identity.documentGeneration === event.document.documentGeneration
    })
    if (!document) {
      void api.browser.choosePageMenu(event.id, { kind: 'dismiss', restorePageFocus: true }).catch(error => useAppStore.getState().reportError(error))
      return
    }
    active.current = event.id
    setMenu({ request: event, document })
  }), [])
  if (!menu) return null
  const { request, document } = menu, zoom = api.ui.getZoomFactor()
  const host = getWindowOverlayHost(document)
  if (!host) return null
  const choose = (input: BrowserPageMenuChoice) => complete(request.id, input)
  return <WorkbenchDocumentContext.Provider value={{ document, window: request.document }}>
    <DropdownMenu.Root key={request.id} open modal={false}
      onOpenChange={open => { if (!open) choose({ kind: 'dismiss', restorePageFocus: false }) }}>
      {createPortal(
        <DropdownMenu.Trigger asChild>
          <span tabIndex={-1} style={{ position: 'fixed', left: request.x / zoom, top: request.y / zoom, pointerEvents: 'none' }} />
        </DropdownMenu.Trigger>, host)}
      <DocumentOverlayPortal component={DropdownMenu.Portal}>
        <DropdownMenu.Content className="tab-context-menu" data-browser-page-menu-id={request.id}
          aria-label="Browser page menu" align="start" collisionPadding={8}
          onInteractOutside={event => { if (inMenu(event.detail.originalEvent.target, request.id)) event.preventDefault() }}
          onCloseAutoFocus={event => event.preventDefault()}
          onEscapeKeyDown={event => { event.preventDefault(); choose({ kind: 'dismiss', restorePageFocus: true }) }}>
          <Rows menuId={request.id} items={request.items} choose={choose} />
        </DropdownMenu.Content>
      </DocumentOverlayPortal>
    </DropdownMenu.Root>
  </WorkbenchDocumentContext.Provider>
}
