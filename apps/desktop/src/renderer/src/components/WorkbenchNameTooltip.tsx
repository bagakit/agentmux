import { autoUpdate, computePosition, flip, offset, shift, type Placement } from '@floating-ui/dom'
import { useEffect, useId, useRef, useState, type MouseEvent, type FocusEvent } from 'react'
import { WindowOverlayPortal } from './WindowOverlayHost'

/** Full names and descriptions stay outside their original surface’s overflow. */
export function useWorkbenchNameTooltip(name: string, detail: string, suppressed: boolean,
  { placement = 'bottom-start', pointerPassThrough = false }: { placement?: Placement; pointerPassThrough?: boolean } = {}) {
  const [anchor, setAnchor] = useState<Element | null>(null)
  const [overflowing, setOverflowing] = useState(false)
  const surface = useRef<HTMLDivElement>(null), id = useId()
  const departure = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const keepOpen = () => clearTimeout(departure.current)
  const hide = () => { keepOpen(); departure.current = setTimeout(() => setAnchor(null), 120) }
  const showFor = (element: Element) => { keepOpen(); if (!suppressed) setAnchor(element) }
  useEffect(() => () => clearTimeout(departure.current), [])
  const visible = anchor !== null && !suppressed
  useEffect(() => {
    if (suppressed) setAnchor(null)
  }, [suppressed])
  useEffect(() => {
    if (!visible || !anchor || !surface.current) return
    let disposed = false
    const panel = surface.current, document = anchor.ownerDocument, window = document.defaultView!
    const update = async () => {
      const position = await computePosition(anchor, panel, { strategy: 'fixed', placement,
        middleware: [offset(8), flip(), shift({ padding: 8, crossAxis: true })] })
      if (!disposed) {
        Object.assign(panel.style, { left: `${position.x}px`, top: `${position.y}px`, visibility: 'visible' })
        if (pointerPassThrough) setOverflowing(panel.scrollHeight > panel.clientHeight + 1)
      }
    }
    const svgAnchor = anchor.namespaceURI === 'http://www.w3.org/2000/svg'
    let stop: (() => void) | undefined, startFrame: number | undefined
    const subscribe = () => { stop = autoUpdate(anchor, panel, () => { void update() }, { animationFrame: svgAnchor }) }
    if (svgAnchor) {
      // Canvas node observations can mount this shallower window portal during
      // ResizeObserver delivery. Subscribe outside that depth-constrained turn.
      void update()
      startFrame = window.requestAnimationFrame(() => { startFrame = undefined; subscribe() })
    } else subscribe()
    const hide = () => setAnchor(null)
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') hide() }
    window.addEventListener('blur', hide); document.addEventListener('visibilitychange', hide)
    window.addEventListener('keydown', key)
    return () => { disposed = true; if (startFrame !== undefined) window.cancelAnimationFrame(startFrame); stop?.(); window.removeEventListener('blur', hide)
      document.removeEventListener('visibilitychange', hide); window.removeEventListener('keydown', key) }
  }, [visible, anchor, name, detail, placement, pointerPassThrough])
  const show = (event: MouseEvent<Element> | FocusEvent<Element>) => showFor(event.currentTarget)
  return { showFor, hide, props: { onMouseEnter: show, onMouseLeave: hide, onFocus: show,
    onBlur: hide, 'aria-describedby': visible ? id : undefined },
    content: visible ? <WindowOverlayPortal layer="tooltip"><div ref={surface} id={id} role="tooltip" tabIndex={0} className="workbench-tab-name-tooltip" style={pointerPassThrough && !overflowing ? { pointerEvents: 'none' } : undefined} onMouseEnter={keepOpen} onMouseLeave={hide} onFocus={keepOpen} onBlur={hide}>
      <strong>{name}</strong>{detail ? <span>{detail}</span> : null}
    </div></WindowOverlayPortal> : null }
}
