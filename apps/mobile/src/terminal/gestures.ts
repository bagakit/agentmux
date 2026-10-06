import type { Terminal } from '@xterm/xterm'

export const MOBILE_TERMINAL_FONT_DEFAULT = 12
const FONT_MIN = 8, FONT_MAX = 32
type Canvas = Pick<Terminal, 'options' | 'rows' | 'buffer' | 'scrollToLine' | 'element'>
type Point = { x: number; y: number }
type Anchor = { column: number; line: number; row: number }
type Pan = Point & { id: number; row: number; axis: 'x' | 'y' | null }
const center = (a: Touch, b: Touch): Point => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 })
const distance = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)

/** Local reading gestures. Protocol encoding and all remote operations remain with xterm/control. */
export function bindMobileTerminalGestures({ element, canvas, isControl, isVisible, reportFont }: {
  element: HTMLElement; canvas: Canvas; isControl(): boolean; isVisible(): boolean; reportFont(size: number): void
}) {
  let pan: Pan | null = null
  let pinch: { distance: number; size: number; anchor: Anchor | null } | null = null
  let frame: number | null = null
  let requested: { size: number; at: Point; anchor: Anchor | null } | null = null
  const screen = () => element.querySelector<HTMLElement>('.xterm-screen')
  const cellHeight = () => (screen()?.getBoundingClientRect().height ?? 0) / canvas.rows
  const fontSize = () => canvas.options.fontSize ?? MOBILE_TERMINAL_FONT_DEFAULT
  const anchorAt = (at: Point): Anchor | null => {
    const bounds = screen()?.getBoundingClientRect()
    return bounds?.width && bounds.height ? { column: (at.x - bounds.left) / bounds.width,
      line: (at.y - bounds.top) / bounds.height, row: canvas.buffer.active.viewportY } : null
  }
  const reset = () => { pan = null; pinch = null }
  const zoom = (size: number, at?: Point, anchor: Anchor | null = null) => {
    const bounds = element.getBoundingClientRect()
    requested = { size: Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(size))),
      at: at ?? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }, anchor }
    if (frame !== null) return
    frame = requestAnimationFrame(() => {
      frame = null
      const next = requested; requested = null
      if (!next || !isVisible()) return
      // Retain the gesture's original cell, so rounded scroll pixels cannot accumulate per frame.
      const reference = next.anchor ?? anchorAt(next.at)
      canvas.options.fontSize = next.size
      if (reference) canvas.scrollToLine(reference.row)
      const after = screen()?.getBoundingClientRect()
      if (reference && after) {
        element.scrollLeft += after.left + reference.column * after.width - next.at.x
        element.scrollTop += after.top + reference.line * after.height - next.at.y
      }
      reportFont(next.size)
    })
  }
  const start = (event: TouchEvent) => {
    if (!isVisible()) return reset()
    // xterm's document touch recognizer treats two fingers as two application
    // scrolls. Own the whole lifecycle so pinch cannot leave its inertia behind.
    event.stopPropagation()
    const a = event.touches[0], b = event.touches[1]
    if (a && b) {
      event.preventDefault(); pan = null
      pinch = { distance: distance(a, b), size: fontSize(), anchor: anchorAt(center(a, b)) }
    } else if (a && !pinch) pan = { id: a.identifier, x: a.clientX, y: a.clientY, row: canvas.buffer.active.viewportY, axis: null }
  }
  const move = (event: TouchEvent) => {
    if (!isVisible()) return reset()
    event.stopPropagation()
    const a = event.touches[0], b = event.touches[1]
    if (a && b) {
      event.preventDefault()
      if (!pinch) pinch = { distance: distance(a, b), size: fontSize(), anchor: anchorAt(center(a, b)) }
      if (pinch.distance > 0) zoom(pinch.size * distance(a, b) / pinch.distance, center(a, b), pinch.anchor)
      pan = null; return
    }
    if (pinch || !pan || !a || a.identifier !== pan.id) return
    const dx = pan.x - a.clientX, dy = pan.y - a.clientY
    if (!pan.axis) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return
      pan.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
    }
    event.preventDefault()
    if (pan.axis === 'x') element.scrollLeft += dx
    else if (isControl()) {
      // Standard wheel input lets the existing xterm protocol owner choose normal
      // scrollback, mouse encoding or alternate-screen application cursor keys.
      screen()?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
        deltaY: dy, deltaMode: WheelEvent.DOM_DELTA_PIXEL, clientX: a.clientX, clientY: a.clientY }))
    } else if (canvas.buffer.active.type === 'alternate') element.scrollTop += dy
    else {
      const height = cellHeight()
      if (height > 0) {
        let rest = dy
        if (rest < 0) {
          const consumed = Math.min(element.scrollTop, -rest)
          element.scrollTop -= consumed; rest += consumed
        }
        const before = pan.row
        pan.row = Math.max(0, Math.min(canvas.buffer.active.baseY, pan.row + rest / height))
        canvas.scrollToLine(Math.round(pan.row))
        rest -= (pan.row - before) * height
        if (rest > 0) element.scrollTop += rest
      }
    }
    pan.x = a.clientX; pan.y = a.clientY
  }
  const end = (event: TouchEvent) => { event.stopPropagation(); if (event.touches.length === 0) reset(); else pan = null }
  const options = { capture: true, passive: false } as const
  element.addEventListener('touchstart', start, options)
  element.addEventListener('touchmove', move, options)
  element.addEventListener('touchend', end, options)
  element.addEventListener('touchcancel', end, options)
  return {
    zoom,
    reset() {
      reset(); requested = null
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
    },
    dispose() {
      this.reset()
      element.removeEventListener('touchstart', start, options)
      element.removeEventListener('touchmove', move, options)
      element.removeEventListener('touchend', end, options)
      element.removeEventListener('touchcancel', end, options)
    }
  }
}
