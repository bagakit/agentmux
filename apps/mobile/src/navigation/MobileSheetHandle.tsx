import { useRef, type PointerEvent as ReactPointerEvent } from 'react'

/** A release past this distance, or a quick downward flick, closes the sheet. */
export const SHEET_CLOSE_DISTANCE_PX = 96
const SHEET_FLICK_VELOCITY = 0.5, SHEET_FLICK_MIN_PX = 24

/** Whether a downward drag on the handle should close the sheet when released. */
export function sheetDragCloses(distance: number, velocity: number): boolean {
  return distance >= SHEET_CLOSE_DISTANCE_PX || distance >= SHEET_FLICK_MIN_PX && velocity >= SHEET_FLICK_VELOCITY
}

/**
 * The grab handle of a bottom sheet. Dragging it down moves the sheet with the finger and dims the
 * backdrop; releasing far or fast enough closes through the sheet's own close, otherwise the sheet
 * springs back. The sheet's close button stays the accessible way to close; the handle is pointer only.
 */
export function MobileSheetHandle({ onClose }: { onClose(): void }) {
  const drag = useRef<{ id: number; y: number; lastY: number; lastT: number; previousY: number; previousT: number; sheet: HTMLElement } | null>(null)
  const place = (sheet: HTMLElement, offset: number | null) => {
    if (offset === null) { delete sheet.dataset.sheetDrag; sheet.style.removeProperty('--mobile-sheet-drag'); return }
    sheet.dataset.sheetDrag = 'tracking'
    sheet.style.setProperty('--mobile-sheet-drag', `${offset}px`)
  }
  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    const sheet = event.currentTarget.closest<HTMLElement>('.mobile-sheet')
    if (!sheet || event.button !== 0 || drag.current) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    drag.current = { id: event.pointerId, y: event.clientY, lastY: event.clientY, lastT: event.timeStamp, previousY: event.clientY, previousT: event.timeStamp, sheet }
  }
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.id !== event.pointerId) return
    current.previousY = current.lastY; current.previousT = current.lastT
    current.lastY = event.clientY; current.lastT = event.timeStamp
    place(current.sheet, Math.max(0, event.clientY - current.y))
  }
  const up = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.id !== event.pointerId) return
    drag.current = null
    const distance = Math.max(0, event.clientY - current.y)
    const since = current.lastT < event.timeStamp ? { y: current.lastY, t: current.lastT } : { y: current.previousY, t: current.previousT }
    const velocity = (event.clientY - since.y) / Math.max(1, event.timeStamp - since.t)
    place(current.sheet, null)
    if (sheetDragCloses(distance, velocity)) onClose()
  }
  const cancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.id !== event.pointerId) return
    drag.current = null
    place(current.sheet, null)
  }
  return <div className="mobile-sheet-handle" aria-hidden="true" data-draggable="" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} onLostPointerCapture={cancel} />
}
