import { useEffect, type RefObject } from 'react'
import { findNoteCanvasBlockRows, measureNoteCanvasBlockPorts, type NoteCanvasBlockPort } from './note-canvas-block-geometry'

/** Observe geometry only while the saved original is explicitly open and active. */
export function useNoteCanvasBlockPorts(body: RefObject<HTMLDivElement | null>, active: boolean, blockIds: readonly string[], onPorts: (ports: NoteCanvasBlockPort[]) => void) {
  useEffect(() => {
    const element = body.current, card = element?.closest<HTMLElement>('.note-canvas-card')
    if (!active || !blockIds.length || !element || !card) { onPorts([]); return }
    let frame = 0, stopped = false
    let rows: ReturnType<typeof findNoteCanvasBlockRows> = { original: null, byId: new Map() }
    const watched = new Set<Element>()
    const schedule = () => { if (!stopped && !frame) frame = requestAnimationFrame(measure) }
    const resize = new ResizeObserver(schedule)
    function refreshRows() {
      rows = findNoteCanvasBlockRows(element!, blockIds)
      const current = new Set<Element>([element!, card!, ...rows.original ? [rows.original] : [], ...[...rows.byId.values()].flat()])
      for (const target of watched) if (!current.has(target)) { resize.unobserve(target); watched.delete(target) }
      for (const target of current) if (!watched.has(target)) { resize.observe(target); watched.add(target) }
      schedule()
    }
    function measure() { frame = 0; if (!stopped) onPorts(measureNoteCanvasBlockPorts(card!, element!, rows)) }
    const mutation = new MutationObserver(refreshRows)
    mutation.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-block-id'] })
    element.addEventListener('scroll', schedule, { passive: true })
    refreshRows()
    return () => { stopped = true; cancelAnimationFrame(frame); resize.disconnect(); mutation.disconnect(); element.removeEventListener('scroll', schedule); onPorts([]) }
  }, [body, active, blockIds, onPorts])
}
