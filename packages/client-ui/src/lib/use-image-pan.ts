import { useCallback, useRef, useState, type PointerEvent } from 'react'
import type { ImageViewPoint } from './image-view-geometry.js'

type Pan = { target: HTMLElement; pointer: number; start: ImageViewPoint; origin: ImageViewPoint; moving: boolean }

/** Track one captured image pointer. Consumers bound or apply the resulting offset in their own viewport. */
export function useImagePan(minimumDistance = 0) {
  const pan = useRef<Pan | null>(null)
  const [dragging, setDragging] = useState(false)

  const begin = (event: PointerEvent<HTMLElement>, origin: ImageViewPoint) => {
    if (event.button !== 0 || pan.current) return false
    const target = event.currentTarget
    pan.current = { target, pointer: event.pointerId, start: { x: event.clientX, y: event.clientY }, origin, moving: false }
    target.setPointerCapture?.(event.pointerId)
    return true
  }

  const move = (event: PointerEvent<HTMLElement>): ImageViewPoint | undefined => {
    const active = pan.current
    if (!active || active.pointer !== event.pointerId) return
    const dx = event.clientX - active.start.x
    const dy = event.clientY - active.start.y
    if (!active.moving) {
      if (Math.hypot(dx, dy) < minimumDistance) return
      active.moving = true
      setDragging(true)
    }
    return { x: active.origin.x + dx, y: active.origin.y + dy }
  }

  const end = useCallback((event?: PointerEvent<HTMLElement>) => {
    const active = pan.current
    if (!active || (event && active.pointer !== event.pointerId)) return
    pan.current = null
    setDragging(false)
    if (active.target.hasPointerCapture?.(active.pointer)) active.target.releasePointerCapture(active.pointer)
  }, [])

  return { begin, move, end, dragging }
}
