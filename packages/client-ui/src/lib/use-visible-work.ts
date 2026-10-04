import { useEffect, useRef, useState } from 'react'

/** Host activity and the actual viewport both own expensive block work. Source text stays mounted. */
export function useVisibleWork<T extends HTMLElement>(active = true) {
  const ref = useRef<T>(null)
  const [intersecting, setIntersecting] = useState(false)
  const [foreground, setForeground] = useState(() => typeof document !== 'undefined' && document.visibilityState !== 'hidden')
  useEffect(() => {
    const target = ref.current
    setIntersecting(false)
    if (!active || !target) return
    if (typeof IntersectionObserver === 'undefined') {
      const rect = target.getBoundingClientRect()
      setIntersecting(rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth)
      return
    }
    const observer = new IntersectionObserver(entries => setIntersecting(entries.some(entry => entry.target === target && entry.isIntersecting)), { rootMargin: '0px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [active])
  useEffect(() => {
    if (!active || !intersecting) return
    const update = () => setForeground(document.visibilityState !== 'hidden')
    update()
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [active, intersecting])
  return { ref, visible: active && foreground && intersecting }
}
