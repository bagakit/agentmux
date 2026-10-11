import { useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { agentBookmarks, type AgentBookmark, type AgentBookmarkBounds } from './agent-bookmarks'
import { captureReadingAnchor, restoreReadingAnchor } from './reading-anchor'
import { markWindowOverlayDismissal } from '../components/WindowOverlayHost'

/** Preferred bounds remain durable; viewport fitting only keeps their presentation reachable. */
export function fitAgentBookmark(bounds: AgentBookmarkBounds, width: number, height: number): AgentBookmarkBounds {
  const availableWidth = Math.max(1, width - 16), availableHeight = Math.max(1, height - 16)
  const w = Math.min(availableWidth, Math.max(Math.min(320, availableWidth), bounds.width))
  const h = Math.min(availableHeight, Math.max(Math.min(260, availableHeight), bounds.height))
  return { x: Math.max(8, Math.min(bounds.x, width - w - 8)), y: Math.max(8, Math.min(bounds.y, height - h - 8)), width: w, height: h }
}
type Gesture = {
  pointerId: number; mode: 'move' | 'resize'; x: number; y: number
  start: AgentBookmarkBounds; current: AgentBookmarkBounds; target: HTMLElement
  reading: HTMLElement | null; anchor: ReturnType<typeof captureReadingAnchor>
}
export function useAgentBookmarkWindow(bookmark: AgentBookmark | undefined, panel: RefObject<HTMLDivElement | null>, reading: RefObject<HTMLDivElement | null>, document: Document) {
  const gesture = useRef<Gesture | null>(null), view = document.defaultView!
  const viewportAnchor = useRef<{ surface: HTMLElement; anchor: NonNullable<ReturnType<typeof captureReadingAnchor>>; text: string; width: number; height: number } | null>(null)
  function apply(bounds: AgentBookmarkBounds) {
    if (panel.current) Object.assign(panel.current.style, { left: `${bounds.x}px`, top: `${bounds.y}px`, width: `${bounds.width}px`, height: `${bounds.height}px`, visibility: 'visible' })
  }
  function currentBounds(): AgentBookmarkBounds | null {
    const rect = panel.current?.getBoundingClientRect()
    return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null
  }
  function reader() { return reading.current?.querySelector<HTMLElement>('[data-agent-input-reading]') ?? reading.current }
  function rememberReading(event?: Event) {
    const surface = reader(), saved = viewportAnchor.current
    if (!surface || event && (event.target !== surface || saved && (saved.width !== view.innerWidth || saved.height !== view.innerHeight))) return
    const anchor = captureReadingAnchor(surface)
    if (anchor) viewportAnchor.current = { surface, anchor, text: anchor.node.data, width: view.innerWidth, height: view.innerHeight }
  }
  function end(commit: boolean) {
    const current = gesture.current
    if (!current) return
    gesture.current = null
    if (current.target.hasPointerCapture?.(current.pointerId)) current.target.releasePointerCapture(current.pointerId)
    apply(commit ? current.current : current.start)
    if (current.reading) restoreReadingAnchor(current.reading, current.anchor)
    rememberReading()
    const changed = (['x', 'y', 'width', 'height'] as const).some(key => current.current[key] !== current.start[key])
    if (commit && changed && bookmark) agentBookmarks.setBounds(bookmark.key, current.current)
  }
  useLayoutEffect(() => {
    if (!bookmark) return
    const contain = () => {
      if (gesture.current) return
      const surface = reader(), saved = viewportAnchor.current
      // CSS viewport limits may reflow before the resize event. Keep the last actual scroll anchor.
      const anchor = surface && saved?.surface === surface && saved.text === saved.anchor.node.data && saved.anchor.offset < saved.text.length &&
        saved.anchor.node.ownerDocument === document && surface.contains(saved.anchor.node)
        ? saved.anchor : surface ? captureReadingAnchor(surface) : null
      apply(fitAgentBookmark(bookmark.bounds, view.innerWidth, view.innerHeight))
      if (surface) restoreReadingAnchor(surface, anchor)
      rememberReading()
    }
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !gesture.current) return
      event.preventDefault(); event.stopPropagation(); markWindowOverlayDismissal(event); end(false)
    }
    contain(); view.addEventListener('resize', contain); view.addEventListener('keydown', cancel, true)
    const root = panel.current
    root?.addEventListener('scroll', rememberReading, true)
    return () => { root?.removeEventListener('scroll', rememberReading, true); view.removeEventListener('resize', contain); view.removeEventListener('keydown', cancel, true); end(false) }
  }, [bookmark?.key, bookmark?.bounds, document])
  function start(event: ReactPointerEvent<HTMLElement>, mode: 'move' | 'resize') {
    if (!bookmark || event.button !== 0 || gesture.current) return
    const target = event.target as Element
    if (mode === 'move' && target.closest('button, a, input, select, textarea') && !target.closest('[data-bookmark-move]')) return
    const bounds = currentBounds()
    if (!bounds) return
    event.preventDefault()
    const surface = reader()
    gesture.current = { pointerId: event.pointerId, mode, x: event.clientX, y: event.clientY, start: bounds, current: bounds,
      target: event.currentTarget, reading: surface, anchor: surface ? captureReadingAnchor(surface) : null }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const pointer = {
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      const g = gesture.current
      if (!g || event.pointerId !== g.pointerId) return
      const dx = event.clientX - g.x, dy = event.clientY - g.y
      g.current = fitAgentBookmark(g.mode === 'move' ? { ...g.start, x: g.start.x + dx, y: g.start.y + dy }
        : { ...g.start, width: g.start.width + dx, height: g.start.height + dy }, view.innerWidth, view.innerHeight)
      apply(g.current)
      if (g.reading) restoreReadingAnchor(g.reading, g.anchor)
    },
    onPointerUp(event: ReactPointerEvent<HTMLElement>) { if (event.pointerId === gesture.current?.pointerId) end(true) },
    onPointerCancel() { end(false) }, onLostPointerCapture() { end(false) }
  }
  function keyboard(event: ReactKeyboardEvent<HTMLElement>, resize = false) {
    if (!bookmark || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault(); event.stopPropagation()
    const bounds = currentBounds()
    if (!bounds) return
    const dx = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0
    const dy = event.key === 'ArrowUp' ? -16 : event.key === 'ArrowDown' ? 16 : 0
    const surface = reader(), anchor = surface ? captureReadingAnchor(surface) : null
    const next = fitAgentBookmark(resize || event.shiftKey ? { ...bounds, width: bounds.width + dx, height: bounds.height + dy }
      : { ...bounds, x: bounds.x + dx, y: bounds.y + dy }, view.innerWidth, view.innerHeight)
    apply(next)
    if (surface) restoreReadingAnchor(surface, anchor)
    rememberReading()
    agentBookmarks.setBounds(bookmark.key, next)
  }
  return {
    header: { onPointerDown: (event: ReactPointerEvent<HTMLElement>) => start(event, 'move'), ...pointer },
    resize: { onPointerDown: (event: ReactPointerEvent<HTMLElement>) => start(event, 'resize'), ...pointer, onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => keyboard(event, true) },
    moveKey: (event: ReactKeyboardEvent<HTMLElement>) => keyboard(event),
    reset() { if (bookmark) agentBookmarks.setBounds(bookmark.key, fitAgentBookmark({ x: 32, y: 56, width: 460, height: 600 }, view.innerWidth, view.innerHeight)) }
  }
}
