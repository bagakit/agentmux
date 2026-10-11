import * as ContextMenu from '@radix-ui/react-context-menu'
import { useId, useState, type KeyboardEvent } from 'react'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import type { WorkbenchSplitMenuEntry } from '../lib/workbench-tab-actions'
import { workbenchSplitMenuIcon, workbenchSplitMenuKey } from './workbench-split-menu-icons'

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
  const id = useId()
  const [hint, setHint] = useState<string | null>(null)
  const splits = entries.filter((entry): entry is Extract<Action, { kind: 'split' }> => entry.kind === 'split')
  const layout = entries.filter((entry): entry is Exclude<Action, { kind: 'split' }> => entry.kind === 'preset' || entry.kind === 'rearrange')
  function row(label: string, clusters: readonly (readonly Action[])[], suffix: string) {
    const groups = clusters.filter(actions => actions.length > 0)
    return groups.length > 0 ? <Group className="workbench-menu-row" aria-labelledby={`${id}-${suffix}`}>
      <Label id={`${id}-${suffix}`} className="workbench-menu-row__label">{label}</Label>
      <div className="workbench-menu-row__actions">
        {groups.map((actions, cluster) => <div key={cluster} className="workbench-menu-row__cluster">
          {actions.map((entry, index) => {
            const Icon = workbenchSplitMenuIcon(entry)
            return <Item key={workbenchSplitMenuKey(entry, index)}
              className="tab-context-menu__item workbench-menu-row__item"
              aria-label={entry.label} textValue={entry.label}
              onSelect={entry.onSelect}
              onFocus={() => setHint(entry.label)} onBlur={() => setHint(null)}
              onPointerMove={() => setHint(entry.label)}
              onPointerLeave={event => {
                if (event.currentTarget.ownerDocument.activeElement !== event.currentTarget) setHint(null)
              }}
              onKeyDown={moveAlongRow}>
              {cluster > 0 && index === 0
                ? <span className="workbench-menu-row__divider" aria-hidden="true" /> : null}
              <Icon size={16} aria-hidden="true" />
            </Item>
          })}
        </div>)}
      </div>
    </Group> : null
  }
  return splits.length > 0 || layout.length > 0 ? <div className="workbench-layout-menu">
    {row(splitLabel, [splits], 'split')}
    {row('Layout', [layout.filter(entry => entry.kind === 'preset'), layout.filter(entry => entry.kind === 'rearrange')], 'layout')}
    <div className="workbench-layout-menu__hint">{hint ?? (splits.length ? 'Choose a direction' : 'Choose a layout')}</div>
  </div> : null
}
