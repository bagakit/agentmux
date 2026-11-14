import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import '../styles/schedule-create-popover.css'

const Close = semanticIconComponent('action.close')

/** Position against the original calendar surface, including a narrow split Region. */
export function ScheduleCreatePopover({ anchor, onClose, children }: {
  anchor: HTMLElement | null
  onClose(): void
  children: ReactNode
}) {
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useLayoutEffect(() => {
    const node = panel.current, surface = node?.closest<HTMLElement>('.mote-calendar')
    const trigger = anchor?.isConnected ? anchor : surface?.querySelector<HTMLElement>('.mote-calendar__create')
    if (!node || !trigger || !surface) return
    const doc = node.ownerDocument
    let current = true
    const position = async () => {
      const options = { boundary: surface, padding: 8 }
      const { x, y } = await computePosition(trigger, node, { placement: 'bottom-start',
        middleware: [offset(6), flip(options), shift({ ...options, crossAxis: true })] })
      if (current) {
        node.style.setProperty('--schedule-editor-left', x + 'px')
        node.style.setProperty('--schedule-editor-top', y + 'px')
      }
    }
    const release = autoUpdate(trigger, node, () => { void position() }, {
      elementResize: typeof ResizeObserver !== 'undefined', layoutShift: typeof IntersectionObserver !== 'undefined'
    })
    const focus = requestAnimationFrame(() => (node.querySelector<HTMLElement>('textarea:enabled') ?? node.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true }))
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || !node.contains(doc.activeElement)) return
      event.preventDefault(); event.stopPropagation(); close.current()
      if (trigger.isConnected) trigger.focus({ preventScroll: true })
    }
    const outside = (event: PointerEvent) => {
      if (!node.contains(event.target as Node) && !trigger.contains(event.target as Node)) close.current()
    }
    doc.addEventListener('keydown', escape)
    doc.addEventListener('pointerdown', outside, true)
    return () => {
      current = false
      release()
      cancelAnimationFrame(focus)
      doc.removeEventListener('keydown', escape)
      doc.removeEventListener('pointerdown', outside, true)
      if (node.contains(doc.activeElement) && trigger.isConnected) trigger.focus({ preventScroll: true })
    }
  }, [anchor])
  return <div ref={panel} role="dialog" aria-label="New arrangement" className="schedule-create schedule-create-popover">
    <header className="schedule-create-popover__heading">
      <h4>New arrangement</h4>
      <button type="button" title="Close" aria-label="Close arrangement editor" onClick={onClose}><Close size={15} aria-hidden /></button>
    </header>
    {children}
  </div>
}
