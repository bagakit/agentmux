import { useEffect, type RefObject } from 'react'

/** Start inside this many pixels of the left edge, as the platform back gesture does. */
export const EDGE_START_PX = 24
/** A committed back needs this much travel, or a quick flick. */
export const COMMIT_DISTANCE_PX = 72
const FLICK_VELOCITY = 0.45, FLICK_MIN_PX = 28, DIRECTION_LOCK_PX = 10

type Point = { x: number; y: number; t: number }
export type EdgeBackTracker = {
  start(point: Point): void
  /** The current horizontal offset to follow, or null while not tracking. */
  move(point: Point): number | null
  /** True when the release commits Back. Always ends tracking. */
  end(point: Point): boolean
  cancel(): void
}

/**
 * Left-edge swipe back as pure geometry. A touch counts only when it starts at the left edge and
 * travels mostly sideways; vertical scrolling and touches that start elsewhere never go back.
 */
export function createEdgeBackTracker(): EdgeBackTracker {
  // Release speed compares against the sample before the last move: touchend repeats the last position.
  let origin: Point | null = null, previous: Point | null = null, last: Point | null = null, locked: 'x' | 'y' | null = null
  const reset = () => { origin = null; previous = null; last = null; locked = null }
  return {
    start(point) { reset(); if (point.x <= EDGE_START_PX) { origin = point; last = point } },
    move(point) {
      if (!origin) return null
      const dx = point.x - origin.x, dy = point.y - origin.y
      if (!locked && Math.hypot(dx, dy) >= DIRECTION_LOCK_PX) locked = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y'
      if (locked === 'y') { reset(); return null }
      previous = last; last = point
      return locked === 'x' ? Math.max(0, dx) : 0
    },
    end(point) {
      if (!origin || locked !== 'x') { reset(); return false }
      const sample = last && last.t < point.t ? last : previous ?? origin
      const dx = point.x - origin.x, velocity = (point.x - sample.x) / Math.max(1, point.t - sample.t)
      reset()
      return dx >= COMMIT_DISTANCE_PX || dx >= FLICK_MIN_PX && velocity >= FLICK_VELOCITY
    },
    cancel: reset
  }
}

/**
 * Binds the tracker to one element. The layer follows the finger through a CSS variable and the
 * release either commits the same Back as the header button or springs back. Disabled when nothing
 * is behind the current layer, so the gesture never invents a destination.
 */
export function useEdgeBack(target: RefObject<HTMLElement | null>, enabled: boolean, onBack: () => void): void {
  useEffect(() => {
    const element = target.current
    if (!element || !enabled) return
    const tracker = createEdgeBackTracker()
    let tracking = false
    const point = (event: TouchEvent): Point | null => {
      const touch = event.changedTouches[0]
      return touch ? { x: touch.clientX, y: touch.clientY, t: event.timeStamp } : null
    }
    const follow = (offset: number | null) => {
      if (offset === null) {
        element.style.removeProperty('--mobile-edge-offset'); element.style.removeProperty('--mobile-edge-progress'); delete element.dataset.edgeBack; return
      }
      element.dataset.edgeBack = 'tracking'
      // Unitless progress for opacity: dividing a length by a length is not yet portable CSS.
      element.style.setProperty('--mobile-edge-offset', `${offset}px`)
      element.style.setProperty('--mobile-edge-progress', String(Math.min(1, offset / Math.max(1, element.clientWidth || window.innerWidth))))
    }
    const start = (event: TouchEvent) => {
      const at = point(event)
      if (event.touches.length !== 1 || !at) return
      tracker.start(at); tracking = at.x <= EDGE_START_PX
    }
    const move = (event: TouchEvent) => {
      if (!tracking) return
      const at = point(event); if (!at) return
      const offset = tracker.move(at)
      if (offset === null) { tracking = false; follow(null); return }
      if (offset > 0) { event.preventDefault(); follow(offset) }
    }
    const end = (event: TouchEvent) => {
      if (!tracking) return
      tracking = false
      const at = point(event), commit = at ? tracker.end(at) : (tracker.cancel(), false)
      follow(null)
      if (commit) onBack()
    }
    const cancel = () => { tracking = false; tracker.cancel(); follow(null) }
    element.addEventListener('touchstart', start, { passive: true })
    element.addEventListener('touchmove', move, { passive: false })
    element.addEventListener('touchend', end)
    element.addEventListener('touchcancel', cancel)
    return () => {
      element.removeEventListener('touchstart', start)
      element.removeEventListener('touchmove', move)
      element.removeEventListener('touchend', end)
      element.removeEventListener('touchcancel', cancel)
      follow(null)
    }
  }, [target, enabled, onBack])
}
