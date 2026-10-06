import { useEffect, useRef, useState, type RefObject } from 'react'
import type { FocusProjectLane } from './focus-project-lanes'

/** Coalesce only presentation order. Facts stay current and continuous activity
 * cannot postpone an update forever. Hidden Focus owns no reorder timer. */
export function useFocusProjectOrder(lanes: readonly FocusProjectLane[], visible: boolean, rows: RefObject<HTMLElement | null>): FocusProjectLane[] {
  const desired = lanes.map(lane => lane.id)
  const signature = JSON.stringify(desired)
  const latest = useRef(desired)
  latest.current = desired
  const [order, setOrder] = useState(desired)
  const ordered = JSON.stringify(order)
  const wasVisible = useRef(visible)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pressed = useRef(false)
  useEffect(() => {
    if (!visible) return
    const down = (event: PointerEvent) => { pressed.current = Boolean(event.target instanceof Node && rows.current?.contains(event.target)) }
    const up = () => { pressed.current = false }
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('pointerup', up, true)
    document.addEventListener('pointercancel', up, true)
    window.addEventListener('blur', up)
    return () => {
      up()
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('pointerup', up, true)
      document.removeEventListener('pointercancel', up, true)
      window.removeEventListener('blur', up)
    }
  }, [visible, rows])
  useEffect(() => {
    const entering = visible && !wasVisible.current
    wasVisible.current = visible
    if (!visible || entering) {
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = null
      if (entering) setOrder(latest.current)
      return
    }
    if (signature === ordered || timer.current !== null) return
    // Keep one bounded window even if task activity keeps changing the target order.
    const apply = () => {
      const selection = window.getSelection()
      const reading = !selection?.isCollapsed && Boolean(selection?.anchorNode && rows.current?.contains(selection.anchorNode))
      if (pressed.current || reading || rows.current?.contains(document.activeElement) || rows.current?.querySelector('.is-menu-open')) {
        timer.current = setTimeout(apply, 3000)
        return
      }
      timer.current = null; setOrder(latest.current)
    }
    timer.current = setTimeout(apply, 3000)
  }, [visible, ordered, signature, rows])
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])
  const ranks = new Map(order.map((id, index) => [id, index]))
  return [...lanes].sort((a, b) => (ranks.get(a.id) ?? order.length) - (ranks.get(b.id) ?? order.length))
}
