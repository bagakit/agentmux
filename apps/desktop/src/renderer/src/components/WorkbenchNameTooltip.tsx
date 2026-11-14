import { autoUpdate, computePosition, flip, offset, shift, type Placement } from '@floating-ui/dom'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type FocusEvent, type ReactNode, type RefObject } from 'react'
import { markWindowOverlayDismissal, WindowOverlayPortal } from './WindowOverlayHost'

// Pointer and keyboard can occupy different anchors. The latest reading intent owns one tooltip.
const nameTooltipOwners = new WeakMap<Document, () => void>()

/** Inline identities use their enclosing button's keyboard focus, without nesting a tab stop. */
export function useWorkbenchTooltipFocus(element: RefObject<HTMLElement | null>, tooltip: ReturnType<typeof useWorkbenchNameTooltip>, suppressed: boolean, identity: string) {
  const current = useRef(tooltip); current.current = tooltip
  const [owner, setOwner] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const parent = suppressed ? null : element.current?.parentElement?.closest<HTMLElement>('button, summary, a[href], [tabindex]:not([tabindex="-1"])') ?? null
    setOwner(parent)
    if (!parent) return
    const show = () => current.current.showFor(parent), hide = () => current.current.hide()
    parent.addEventListener('focus', show); parent.addEventListener('blur', hide)
    return () => { parent.removeEventListener('focus', show); parent.removeEventListener('blur', hide) }
  }, [element, suppressed, identity])
  const describedBy = tooltip.props['aria-describedby']
  useLayoutEffect(() => {
    if (!owner || !describedBy) return
    const ids = (owner.getAttribute('aria-describedby') ?? '').split(/\s+/u).filter(Boolean)
    owner.setAttribute('aria-describedby', [...new Set([...ids, describedBy])].join(' '))
    return () => {
      const remaining = (owner.getAttribute('aria-describedby') ?? '').split(/\s+/u).filter(id => id && id !== describedBy)
      if (remaining.length) owner.setAttribute('aria-describedby', remaining.join(' ')); else owner.removeAttribute('aria-describedby')
    }
  }, [owner, describedBy])
  return owner
}

/** Full names and descriptions stay outside their original surface’s overflow. */
export function useWorkbenchNameTooltip(name: string, detail: ReactNode, suppressed: boolean,
  { placement = 'bottom-start', pointerPassThrough = false }: { placement?: Placement; pointerPassThrough?: boolean } = {}) {
  const [anchor, setAnchor] = useState<Element | null>(null)
  const [overflowing, setOverflowing] = useState(false)
  const surface = useRef<HTMLDivElement>(null), id = useId()
  const ownedDocument = useRef<Document | null>(null)
  const close = useCallback((): void => {
    const document = ownedDocument.current
    if (document && nameTooltipOwners.get(document) === close) nameTooltipOwners.delete(document)
    ownedDocument.current = null
    setAnchor(null)
  }, [])
  const departure = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const keepOpen = () => clearTimeout(departure.current)
  const hide = () => { keepOpen(); departure.current = setTimeout(close, 120) }
  const showFor = (element: Element) => {
    keepOpen()
    if (suppressed) return
    const document = element.ownerDocument, previous = nameTooltipOwners.get(document)
    if (previous && previous !== close) previous()
    ownedDocument.current = document; nameTooltipOwners.set(document, close); setAnchor(element)
  }
  useEffect(() => () => {
    clearTimeout(departure.current)
    if (ownedDocument.current && nameTooltipOwners.get(ownedDocument.current) === close) nameTooltipOwners.delete(ownedDocument.current)
  }, [close])
  const visible = anchor !== null && !suppressed
  useEffect(() => {
    if (suppressed) close()
  }, [suppressed, close])
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
    const hide = close
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) { markWindowOverlayDismissal(event); close() }
    }
    window.addEventListener('blur', hide); document.addEventListener('visibilitychange', hide)
    document.addEventListener('keydown', key, true)
    return () => { disposed = true; if (startFrame !== undefined) window.cancelAnimationFrame(startFrame); stop?.(); window.removeEventListener('blur', hide)
      document.removeEventListener('visibilitychange', hide); document.removeEventListener('keydown', key, true) }
  }, [visible, anchor, name, detail, placement, pointerPassThrough, close])
  const show = (event: MouseEvent<Element> | FocusEvent<Element>) => showFor(event.currentTarget)
  return { showFor, hide, props: { onMouseEnter: show, onMouseLeave: hide, onFocus: show,
    onBlur: hide, 'aria-describedby': visible ? id : undefined },
    content: visible ? <WindowOverlayPortal layer="tooltip"><div ref={surface} id={id} role="tooltip" tabIndex={0} className="workbench-tab-name-tooltip" style={pointerPassThrough && !overflowing ? { pointerEvents: 'none' } : undefined} onMouseEnter={keepOpen} onMouseLeave={hide} onFocus={keepOpen} onBlur={hide}>
      <strong>{name}</strong>{detail ? <span>{detail}</span> : null}
    </div></WindowOverlayPortal> : null }
}
