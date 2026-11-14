import type { RefObject } from 'react'
import { flushSync } from 'react-dom'
import { SegmentedControl } from '@agentmux/client-ui/components/SegmentedControl'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useAppStore } from '../store'

const GridIcon = semanticIconComponent('layout.grid')
const ListIcon = semanticIconComponent('object.list')
const options = [
  { value: 'cards', label: <><GridIcon size={13} /><span>Cards</span></>, 'aria-label': 'Cards' },
  { value: 'list', label: <><ListIcon size={13} /><span>List</span></>, 'aria-label': 'List' },
] as const

export function FocusTaskLayoutSwitch({ value, rows }: { value: 'cards' | 'list'; rows: RefObject<HTMLDivElement | null> }) {
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
  return <SegmentedControl aria-label="Task layout" className="focus-task-layout" options={options} value={value} onValueChange={change} />
}
