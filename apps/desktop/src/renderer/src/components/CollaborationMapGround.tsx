import { memo, useLayoutEffect, useRef } from 'react'
import { useStoreApi } from '@xyflow/react'

/** World spacings of the ground grid. Each level is five times the previous one. */
const SPACINGS = [24, 120, 600, 3000, 15000] as const
/** Screen spacing range in which a level is shown; outside it the next level takes over. */
const MIN_SCREEN = 18, FADE_SCREEN = 36

/** The minor and major levels for a zoom, with the minor level fading in over its range so
 * one spacing hands over to the next continuously instead of popping. */
export function collaborationGroundLevels(zoom: number) {
  const index = Math.max(0, SPACINGS.findIndex(spacing => spacing * zoom >= MIN_SCREEN))
  const minor = SPACINGS[index]!, major = SPACINGS[Math.min(index + 1, SPACINGS.length - 1)]!
  const t = Math.max(0, Math.min(1, (minor * zoom - MIN_SCREEN) / (FADE_SCREEN - MIN_SCREEN)))
  return { minor: minor * zoom, major: major * zoom, minorInk: t * t * (3 - 2 * t) }
}

/** A screen-space grid on empty ground only: land paints over it. It follows the camera by
 * direct style writes, never a React render, and its dots keep one screen size at any zoom. */
export const CollaborationMapGround = memo(function CollaborationMapGround() {
  const store = useStoreApi(), root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const paint = ({ transform: [x, y, zoom] }: { transform: [number, number, number] }) => {
      const { minor, major, minorInk } = collaborationGroundLevels(zoom)
      element.style.setProperty('--map-grid-minor-spacing', `${minor}px`)
      element.style.setProperty('--map-grid-major-spacing', `${major}px`)
      element.style.setProperty('--map-grid-minor-ink', String(minorInk))
      element.style.backgroundPosition = `${x}px ${y}px, ${x}px ${y}px`
    }
    paint(store.getState())
    return store.subscribe(paint)
  }, [store])
  return <div ref={root} className="collaboration-map-ground" aria-hidden="true" />
})
