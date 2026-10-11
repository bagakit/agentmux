import * as ContextMenu from '@radix-ui/react-context-menu'
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import type { WorkbenchSplitMenuEntry } from '../lib/workbench-tab-actions'
import { workbenchSplitMenuIcon, workbenchSplitMenuKey } from './workbench-split-menu-icons'
import { WindowOverlayPortal } from './WindowOverlayHost'

type Action = Exclude<WorkbenchSplitMenuEntry, { kind: 'separator' }>
type Hint = { label: string; row: string; anchor: HTMLElement }

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
  const [hovered, setHovered] = useState<Hint | null>(null)
  const [focused, setFocused] = useState<Hint | null>(null)
  const hint = focused ?? hovered
  const tooltip = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!hint || !tooltip.current) return
    const panel = tooltip.current
    const label = hint.anchor.closest('.workbench-menu-row')?.querySelector('.workbench-menu-row__label-text')
    if (!label) return
    let disposed = false
    const update = async () => {
      if (label.scrollWidth <= label.clientWidth) { panel.style.visibility = 'hidden'; return }
      const position = await computePosition(hint.anchor, panel, { strategy: 'fixed', placement: 'bottom-start',
        middleware: [offset(4), flip(), shift({ padding: 8 })] })
      if (!disposed) Object.assign(panel.style, { left: `${position.x}px`, top: `${position.y}px`, visibility: 'visible' })
    }
    const stop = autoUpdate(hint.anchor, panel, () => { void update() })
    return () => { disposed = true; stop() }
  }, [hint])
  const splits = entries.filter((entry): entry is Extract<Action, { kind: 'split' }> => entry.kind === 'split')
  const layout = entries.filter((entry): entry is Exclude<Action, { kind: 'split' }> => entry.kind === 'preset' || entry.kind === 'rearrange')
  function row(label: string, clusters: readonly (readonly Action[])[], suffix: string) {
    const groups = clusters.filter(actions => actions.length > 0)
    const active = hint?.row === suffix
    return groups.length > 0 ? <Group className="workbench-menu-row" aria-label={label}
      onPointerLeave={() => setHovered(current => current?.row === suffix ? null : current)}>
      <Label className="workbench-menu-row__label" aria-hidden="true" data-active={active || undefined}>
        <span className="workbench-menu-row__label-text">{active ? hint.label : label}</span>
      </Label>
      <div className="workbench-menu-row__actions">
        {groups.map((actions, cluster) => <div key={cluster} className="workbench-menu-row__cluster">
          {actions.map((entry, index) => {
            const Icon = workbenchSplitMenuIcon(entry)
            return <Item key={workbenchSplitMenuKey(entry, index)}
              className="tab-context-menu__item workbench-menu-row__item"
              aria-label={entry.label} textValue={entry.label}
              aria-describedby={hint?.anchor && hint.row === suffix && hint.label === entry.label ? id : undefined}
              onSelect={entry.onSelect}
              onFocus={event => setFocused({ label: entry.label, row: suffix, anchor: event.currentTarget })}
              onBlur={() => setFocused(null)}
              onPointerMove={event => {
                const anchor = event.currentTarget
                setHovered(current => current?.anchor === anchor ? current : { label: entry.label, row: suffix, anchor })
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
    {/* This menu's explanation must paint above its own popover, including inside its bounds. */}
    {hint ? <WindowOverlayPortal layer="popover"><div ref={tooltip} id={id} role="tooltip"
      className="workbench-layout-menu__tooltip" style={{ visibility: 'hidden' }}>{hint.label}</div></WindowOverlayPortal> : null}
  </div> : null
}
