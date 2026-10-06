import { useLayoutEffect, useRef, useState } from 'react'

/** Geometry belongs to this scroll surface; source and native scrolling stay untouched. */
export function useHorizontalReading<T extends HTMLElement>(active: boolean, content: unknown) {
  const ref = useRef<T>(null)
  const [edges, setEdges] = useState({ start: false, end: false })
  useLayoutEffect(() => {
    const element = ref.current
    if (!active || !element) return
    const measure = () => {
      const maximum = element.scrollWidth - element.clientWidth
      const start = maximum > 1 && element.scrollLeft > 1
      const end = maximum > 1 && element.scrollLeft < maximum - 1
      setEdges(previous => previous.start === start && previous.end === end ? previous : { start, end })
    }
    const resize = new ResizeObserver(measure)
    resize.observe(element)
    for (const child of element.children) resize.observe(child)
    element.addEventListener('scroll', measure, { passive: true })
    measure()
    return () => { resize.disconnect(); element.removeEventListener('scroll', measure) }
  }, [active, content])
  const start = active && edges.start, end = active && edges.end
  return { ref, tabIndex: start || end ? 0 : undefined, 'data-scroll-start': start || undefined, 'data-scroll-end': end || undefined }
}
