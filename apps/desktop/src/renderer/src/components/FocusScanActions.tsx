import { useEffect, useRef, useState } from 'react'
import { IconButton } from '@agentmux/client-ui/components/IconButton'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useAppStore } from '../store'
import type { FocusProjectOrder } from '../lib/use-focus-project-order'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import * as Menu from './HoverDropdownMenu'
import { LocalRetainedInputsPanel } from './LocalRetainedInputs'

const MoreIcon = semanticIconComponent('action.more')
const DraftIcon = semanticIconComponent('action.edit')
const SelectedIcon = semanticIconComponent('status.selected')
const orders: Record<FocusProjectOrder, string> = { priority: 'Task priority', activity: 'Recent activity', name: 'Project name' }

export function FocusScanActions({ order, onOrderChange, onOpenLocation, active = true }: {
  active?: boolean
  order: FocusProjectOrder
  onOrderChange(order: FocusProjectOrder): void
  onOpenLocation?: ((reference: WorkbenchProjectionSelection) => boolean | void) | undefined
}) {
  const hasDraft = useAppStore(state => Object.values(state.agentComposerDrafts).some(Boolean))
  const [menuOpen, setMenuOpen] = useState(false)
  const [inputsOpen, setInputsOpen] = useState(false)
  const opening = useRef(false)
  const menuRef = useRef<HTMLButtonElement>(null)
  const returnTo = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (active) return
    setMenuOpen(false)
    setInputsOpen(false)
    opening.current = false
  }, [active])
  function openInputs(origin: HTMLButtonElement | null) {
    returnTo.current = origin
    opening.current = true
    setInputsOpen(true)
  }

  return <div className="focus-scan-actions">
    {hasDraft ? <IconButton type="button" aria-label="Drafts" title="Continue an unsent draft" className="focus-scan-actions__draft"
      onClick={event => openInputs(event.currentTarget)}><DraftIcon size={14} /></IconButton> : null}
    <Menu.Root open={active && menuOpen} onOpenChange={setMenuOpen}>
      <Menu.Trigger asChild><IconButton ref={menuRef} type="button" aria-label="Focus actions" title={`Focus actions · ${orders[order]}`}><MoreIcon size={15} /></IconButton></Menu.Trigger>
      <Menu.Portal><Menu.Content className="tab-context-menu focus-scan-actions__menu" align="end" sideOffset={4} collisionPadding={8}
        onCloseAutoFocus={event => { if (opening.current) event.preventDefault() }}>
        <Menu.Label className="tab-context-menu__hint">Sort projects</Menu.Label>
        <Menu.RadioGroup value={order}>
          {(Object.entries(orders) as [FocusProjectOrder, string][]).map(([value, label]) => <Menu.RadioItem key={value} value={value} onSelect={() => onOrderChange(value)} className="tab-context-menu__item">
            <span className="focus-scan-actions__mark"><Menu.ItemIndicator><SelectedIcon size={13} /></Menu.ItemIndicator></span>{label}
          </Menu.RadioItem>)}
        </Menu.RadioGroup>
        <Menu.Separator className="tab-context-menu__separator" />
        <Menu.Item className="tab-context-menu__item" onSelect={() => openInputs(menuRef.current)}><DraftIcon size={13} />Saved inputs</Menu.Item>
      </Menu.Content></Menu.Portal>
    </Menu.Root>
    <LocalRetainedInputsPanel open={active && inputsOpen} onOpenChange={setInputsOpen} onOpenLocation={onOpenLocation} onClose={restoreFocus => {
      opening.current = false
      if (!active || !restoreFocus) return
      ;(returnTo.current?.isConnected ? returnTo.current : menuRef.current)?.focus({ preventScroll: true })
    }} />
  </div>
}
