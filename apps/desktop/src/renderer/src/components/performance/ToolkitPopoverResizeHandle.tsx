import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useContext, useEffect, useLayoutEffect, useRef } from 'react'
import { ToolkitPopoverSurface } from './PerformancePopover'

const ResizeIcon = semanticIconComponent('layout.resize-window')

/** CSS owns size constraints; this local gesture only changes its original surface. */
export function ToolkitPopoverResizeHandle() {
  const surface = useContext(ToolkitPopoverSurface)
  const drag = useRef<{ pointerId: number; handle: HTMLButtonElement; x: number; y: number; nextX: number; nextY: number; frame: number | null } | null>(null)
  function resize(width: number, height: number) {
    const panel = surface?.panel.current
    if (!panel) return
    const bounds = panel.getBoundingClientRect()
    panel.style.width = `${Math.max(1, bounds.width + width)}px`
    panel.style.height = `${Math.max(1, bounds.height + height)}px`
  }
  function apply() {
    const gesture = drag.current
    if (!gesture) return
    gesture.frame = null
    resize(gesture.x - gesture.nextX, gesture.y - gesture.nextY)
    gesture.x = gesture.nextX; gesture.y = gesture.nextY
  }
  function finish(flush: boolean) {
    const gesture = drag.current
    if (!gesture) return
    if (gesture.frame !== null) gesture.handle.ownerDocument.defaultView!.cancelAnimationFrame(gesture.frame)
    if (flush) apply()
    drag.current = null
    if (gesture.handle.hasPointerCapture(gesture.pointerId)) gesture.handle.releasePointerCapture(gesture.pointerId)
  }
  useLayoutEffect(() => {
    surface?.setResizable(true)
    return () => surface?.setResizable(false)
  }, [surface])
  useEffect(() => {
    // Ancestor host refs attach after descendant layout effects.
    const panel = surface?.panel.current
    if (!panel) return
    const previous = { width: panel.style.width, height: panel.style.height }
    const window = panel.ownerDocument.defaultView!
    const cancel = () => finish(false)
    window.addEventListener('blur', cancel)
    return () => {
      finish(false); window.removeEventListener('blur', cancel)
      Object.assign(panel.style, previous)
    }
  }, [surface])
  if (!surface) return null
  return <button type="button" className="toolkit-popover-resize" aria-label="Resize terminal panel"
    title="Drag up or left to enlarge · Arrow keys resize" aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
    onPointerDown={event => {
      if (event.button !== 0 || drag.current) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { pointerId: event.pointerId, handle: event.currentTarget, x: event.clientX, y: event.clientY, nextX: event.clientX, nextY: event.clientY, frame: null }
    }}
    onPointerMove={event => {
      const gesture = drag.current
      if (!gesture || gesture.pointerId !== event.pointerId) return
      gesture.nextX = event.clientX; gesture.nextY = event.clientY
      if (gesture.frame === null) gesture.frame = event.currentTarget.ownerDocument.defaultView!.requestAnimationFrame(apply)
    }}
    onPointerUp={event => {
      if (drag.current?.pointerId !== event.pointerId) return
      drag.current.nextX = event.clientX; drag.current.nextY = event.clientY; finish(true)
    }}
    onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) finish(false) }}
    onLostPointerCapture={event => { if (drag.current?.pointerId === event.pointerId) finish(false) }}
    onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || drag.current) return
      event.preventDefault(); event.stopPropagation()
      const step = event.shiftKey ? 20 : 10
      resize(event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0,
        event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0)
    }}><ResizeIcon size={13} aria-hidden="true" /></button>
}
