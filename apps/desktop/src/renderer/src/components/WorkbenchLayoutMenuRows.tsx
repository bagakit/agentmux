import * as ContextMenu from '@radix-ui/react-context-menu'
import type { KeyboardEvent } from 'react'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import type { WorkbenchSplitMenuEntry } from '../lib/workbench-tab-actions'
import { workbenchSplitMenuIcon, workbenchSplitMenuKey } from './workbench-split-menu-icons'
import { WorkbenchActionRows } from './WorkbenchActionRows'

type Action = Exclude<WorkbenchSplitMenuEntry, { kind: 'separator' }>

/** Only the same visible row adds lateral navigation; Radix keeps menu navigation and dismissal. */
function moveAlongRow(event: KeyboardEvent<HTMLDivElement>) {
  if (isImeOwnedKeyboardEvent(event.nativeEvent)) {
    event.stopPropagation()
    return
  }
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  const current = event.currentTarget, row = current.closest('.workbench-menu-row__actions')
  if (!row) return
  const top = current.getBoundingClientRect().top
  const items = [...row.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(item =>
    !item.hasAttribute('data-disabled') && Math.abs(item.getBoundingClientRect().top - top) < 1)
  const rtl = current.ownerDocument.defaultView?.getComputedStyle(row).direction === 'rtl'
  const backwards = (event.key === 'ArrowLeft') !== rtl
  const next = items[items.indexOf(current) + (backwards ? -1 : 1)]
  // At the edge, the original submenu can still return to its parent.
  if (!next) return
  event.preventDefault()
  event.stopPropagation()
  next.focus()
}

/** Shared presentation of the existing commands, not another layout or selection owner. */
export function WorkbenchLayoutMenuRows({ entries, Item, Group = ContextMenu.Group, Label = ContextMenu.Label, splitLabel = 'New region' }: {
  entries: readonly WorkbenchSplitMenuEntry[]
  Item: typeof ContextMenu.Item
  Group?: typeof ContextMenu.Group
  Label?: typeof ContextMenu.Label
  splitLabel?: string
}) {
  const splits = entries.filter((entry): entry is Extract<Action, { kind: 'split' }> => entry.kind === 'split')
  const layout = entries.filter((entry): entry is Exclude<Action, { kind: 'split' }> => entry.kind === 'preset' || entry.kind === 'rearrange')
  if (splits.length === 0 && layout.length === 0) return null
  return <WorkbenchActionRows<Action> Group={Group} Label={Label} rows={[
    { id: 'split', label: splitLabel, clusters: [splits] },
    { id: 'layout', label: 'Layout', clusters: [layout.filter(entry => entry.kind === 'preset'), layout.filter(entry => entry.kind === 'rearrange')] }
  ]} itemKey={workbenchSplitMenuKey} renderItem={(entry, props, divider) => {
    const Icon = workbenchSplitMenuIcon(entry)
    return <Item {...props} className="tab-context-menu__item workbench-menu-row__item"
      aria-label={entry.label} textValue={entry.label} onSelect={entry.onSelect} onKeyDown={moveAlongRow}>
      {divider}<Icon size={16} aria-hidden="true" />
    </Item>
  }} />
}
