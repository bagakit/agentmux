import * as ContextMenu from '@radix-ui/react-context-menu'
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import { Fragment, useEffect, useId, useRef, useState, type HTMLAttributes, type KeyboardEvent, type ReactNode } from 'react'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { WindowOverlayPortal } from './WindowOverlayHost'

type Hint = { label: string; row: string; anchor: HTMLElement }
export type WorkbenchActionRowItemProps = Pick<HTMLAttributes<HTMLElement>,
  'aria-describedby' | 'onFocus' | 'onBlur' | 'onPointerMove'>

/** Lateral navigation stays within the painted row; its edges retain Radix menu behavior. */
export function moveAlongWorkbenchActionRow(event: KeyboardEvent<HTMLDivElement>) {
  if (isImeOwnedKeyboardEvent(event.nativeEvent)) { event.stopPropagation(); return }
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  const current = event.currentTarget, row = current.closest('.workbench-menu-row__actions')
  if (!row) return
  const top = current.getBoundingClientRect().top
  const items = [...row.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(item =>
    !item.hasAttribute('data-disabled') && Math.abs(item.getBoundingClientRect().top - top) < 1)
  const rtl = current.ownerDocument.defaultView?.getComputedStyle(row).direction === 'rtl'
  const backwards = (event.key === 'ArrowLeft') !== rtl
  const next = items[items.indexOf(current) + (backwards ? -1 : 1)]
  if (!next) return
  event.preventDefault()
  event.stopPropagation()
  next.focus()
}

/** Shared alignment and descriptions; each consumer keeps its original actions and input semantics. */
export function WorkbenchActionRows<T extends { label: string }>({ rows, itemKey, renderItem,
  Group = 'div', Label = 'div'
}: {
  rows: readonly { id: string; label: string; clusters: readonly (readonly T[])[] }[]
  itemKey(item: T, index: number): string
  renderItem(item: T, props: WorkbenchActionRowItemProps, divider: ReactNode): ReactNode
  Group?: 'div' | typeof ContextMenu.Group
  Label?: 'div' | typeof ContextMenu.Label
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
  return <div className="workbench-layout-menu">
    {rows.map(row => {
      const clusters = row.clusters.filter(items => items.length > 0)
      const active = hint?.row === row.id
      return clusters.length > 0 ? <Group key={row.id} className="workbench-menu-row" role="group" aria-label={row.label}
        onPointerLeave={() => setHovered(current => current?.row === row.id ? null : current)}>
        <Label className="workbench-menu-row__label" aria-hidden="true" data-active={active || undefined}>
          <span className="workbench-menu-row__label-text">{active ? hint.label : row.label}</span>
        </Label>
        <div className="workbench-menu-row__actions">
          {clusters.map((items, cluster) => <div key={cluster} className="workbench-menu-row__cluster">
            {items.map((item, index) => <Fragment key={itemKey(item, index)}>{renderItem(item, {
              'aria-describedby': hint?.row === row.id && hint.label === item.label ? id : undefined,
              onFocus: event => setFocused({ label: item.label, row: row.id, anchor: event.currentTarget }),
              onBlur: () => setFocused(null),
              onPointerMove: event => {
                const anchor = event.currentTarget
                setHovered(current => current?.anchor === anchor ? current : { label: item.label, row: row.id, anchor })
              }
            }, cluster > 0 && index === 0 ? <span className="workbench-menu-row__divider" aria-hidden="true" /> : null)}</Fragment>)}
          </div>)}
        </div>
      </Group> : null
    })}
    {/* The explanation paints in its original menu's band, above that menu's own surface. */}
    {hint ? <WindowOverlayPortal layer="popover"><div ref={tooltip} id={id} role="tooltip"
      className="workbench-layout-menu__tooltip" style={{ visibility: 'hidden' }}>{hint.label}</div></WindowOverlayPortal> : null}
  </div>
}
