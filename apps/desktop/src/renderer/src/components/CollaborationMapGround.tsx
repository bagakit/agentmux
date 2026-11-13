import { memo, useLayoutEffect, useRef } from 'react'
import { useStoreApi } from '@xyflow/react'

/** World spacing of the finest ground level. Each coarser level is five times the previous. */
const BASE = 24, STEP = 5
/** A level enters at ENTER screen px and is fully inked from FULL. As the coarser level of the
 * pair it hands its ink back once the finer one is full, and is gone by RETIRE, the screen
 * spacing at which it leaves the pair. Both ends of every handover therefore draw one grid. */
const ENTER = 18, FULL = 36, RETIRE = ENTER * STEP * STEP
const smooth = (from: number, to: number, value: number) => {
  const t = Math.max(0, Math.min(1, (value - from) / (to - from)))
  return t * t * (3 - 2 * t)
}

/** The ink of a ground level from its own screen spacing alone, so one level keeps one look
 * whether it is drawn as the finer or the coarser of the pair. */
export function collaborationGroundInk(screen: number) {
  return smooth(ENTER, FULL, screen) * (1 - smooth(FULL * STEP, RETIRE, screen))
}

const groundLevel = (spacing: number, zoom: number) => ({ spacing, screen: spacing * zoom, ink: collaborationGroundInk(spacing * zoom) })

/** The pair drawn at a zoom: the finest level whose screen spacing reaches ENTER, and the next. */
export function collaborationGroundLevels(zoom: number) {
  const level = Math.max(0, Math.ceil(Math.log(ENTER / (BASE * zoom)) / Math.log(STEP)))
  const minor = BASE * STEP ** level
  return { minor: groundLevel(minor, zoom), major: groundLevel(minor * STEP, zoom) }
}

/** A screen-space grid on empty ground only: land paints over it. It follows the camera by
 * direct style writes, never a React render, and its dots keep one screen size at any zoom. */
export const CollaborationMapGround = memo(function CollaborationMapGround() {
  const store = useStoreApi(), root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const paint = ({ transform: [x, y, zoom] }: { transform: [number, number, number] }) => {
      const { minor, major } = collaborationGroundLevels(zoom)
      element.style.setProperty('--map-grid-minor-spacing', `${minor.screen}px`)
      element.style.setProperty('--map-grid-major-spacing', `${major.screen}px`)
      element.style.setProperty('--map-grid-minor-ink', String(minor.ink))
      element.style.setProperty('--map-grid-major-ink', String(major.ink))
      element.style.backgroundPosition = `${x}px ${y}px, ${x}px ${y}px`
    }
    paint(store.getState())
    return store.subscribe(paint)
  }, [store])
  return <div ref={root} className="collaboration-map-ground" aria-hidden="true" />
})
