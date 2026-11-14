import { useLayoutEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useWorkbenchDocument } from '../lib/workbench-document'
import { moveReadingHost } from '../lib/move-reading-host'

/** One mounted thread, report and editor travel with the explicit reading position. */
export function GoalPlanReadingPlacement({ canvas, inline, target, explicit, children }: {
  canvas: RefObject<HTMLDivElement | null>; inline: RefObject<HTMLLIElement | null>; target: string; explicit: boolean; children: ReactNode
}) {
  const document = useWorkbenchDocument(), dock = useRef<HTMLDivElement>(null)
  const host = useMemo(() => document.createElement('div'), [document])
  useLayoutEffect(() => {
    const viewport = canvas.current, belowGraph = dock.current
    if (!viewport || !belowGraph) return
    const place = () => {
      const narrow = explicit && document.defaultView?.getComputedStyle(viewport).getPropertyValue('--goal-plan-inline-reading').trim() === '1'
      const destination = narrow && inline.current ? inline.current : belowGraph
      if (destination !== host.parentElement) moveReadingHost(host, destination)
    }
    place()
    if (!explicit || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(place)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [canvas, inline, target, explicit, document, host])
  useLayoutEffect(() => () => host.remove(), [host])
  return <><div className="goal-plan__reader-dock" ref={dock} />{createPortal(children, host)}</>
}
