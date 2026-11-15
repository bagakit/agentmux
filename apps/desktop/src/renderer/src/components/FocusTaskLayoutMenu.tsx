import { useEffect, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import * as Menu from '@radix-ui/react-dropdown-menu'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useAppStore } from '../store'
import { DocumentOverlayPortal } from './WindowOverlayHost'

const GridIcon = semanticIconComponent('layout.grid')
const ListIcon = semanticIconComponent('object.list')
const Down = semanticIconComponent('navigation.down')
const Selected = semanticIconComponent('status.selected')
const options = [
  { value: 'cards', label: 'Cards', Icon: GridIcon },
  { value: 'list', label: 'Compact list', Icon: ListIcon },
] as const

export function FocusTaskLayoutMenu({ rows, active }: { rows: RefObject<HTMLDivElement | null>; active: boolean }) {
  const value = useAppStore(state => state.focusTaskLayout)
  const [open, setOpen] = useState(false)
  useEffect(() => { if (!active) setOpen(false) }, [active])
  function change(layout: typeof value) {
    if (layout === value) return
    const port = rows.current
    const viewport = port?.getBoundingClientRect()
    const visible = (node: Element) => {
      const box = node.getBoundingClientRect()
      return viewport && box.height > 0 && box.bottom > viewport.top && box.top < viewport.bottom
    }
    const selected = port?.querySelector('[data-focus-agent-selected="true"]')
    const anchor = selected && visible(selected) ? selected : port && Array.from(
      port.querySelectorAll('[data-focus-card-key], .focus-project-frame__heading'),
    ).find(visible)
    const before = anchor?.getBoundingClientRect().top
    flushSync(() => useAppStore.getState().setFocusTaskLayout(layout))
    if (port && anchor?.isConnected && before !== undefined) port.scrollTop += anchor.getBoundingClientRect().top - before
  }
  return <Menu.Root modal={false} open={active && open} onOpenChange={setOpen}>
    <Menu.Trigger className="focus-view-switch__layout" aria-label="Task layout" aria-description={value === 'cards' ? 'Cards' : 'Compact list'}
      title={value === 'cards' ? 'Task layout · Cards' : 'Task layout · Compact list'}><Down size={13} aria-hidden="true" /></Menu.Trigger>
    <DocumentOverlayPortal component={Menu.Portal}>
      <Menu.Content className="tab-context-menu focus-view-layout-menu" aria-label="Task layout" align="start" sideOffset={7} collisionPadding={8}>
        <Menu.RadioGroup value={value}>
          {options.map(({ value: layout, label, Icon }) => <Menu.RadioItem key={layout} value={layout} data-focus-layout={layout}
            className="tab-context-menu__item" onSelect={() => change(layout)}>
            <Icon size={14} aria-hidden="true" /><span>{label}</span>
            <span className="focus-view-layout-menu__check"><Menu.ItemIndicator><Selected size={13} aria-hidden="true" /></Menu.ItemIndicator></span>
          </Menu.RadioItem>)}
        </Menu.RadioGroup>
      </Menu.Content>
    </DocumentOverlayPortal>
  </Menu.Root>
}
