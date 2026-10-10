import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useClientUiOwnerDocument } from '../platform.js'

/** Host activity and the actual viewport both own expensive block work. Source text stays mounted. */
export function useVisibleWork<T extends HTMLElement>(active = true) {
  const platformDocument = useClientUiOwnerDocument()
  const ref = useRef<T>(null)
  const [target, setTarget] = useState<T | null>(null)
  // Keep the original ref/current API while tracking committed node replacements.
  useLayoutEffect(() => { if (ref.current !== target) setTarget(ref.current) })
  const [viewport, setViewport] = useState<{ target: T; document: Document; intersecting: boolean } | null>(null)
  const [foreground, setForeground] = useState<{ document: Document; visible: boolean } | null>(null)
  useEffect(() => {
    if (!active || !target) { setViewport(null); return }
    const owner = target.ownerDocument, view = owner.defaultView
    let alive = true
    const update = (intersecting: boolean) => {
      if (alive && target.ownerDocument === owner) setViewport({ target, document: owner, intersecting })
    }
    update(false)
    const Observer = view?.IntersectionObserver
    if (!Observer) {
      const rect = target.getBoundingClientRect()
      update(Boolean(view && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < view.innerHeight && rect.right > 0 && rect.left < view.innerWidth))
      return () => { alive = false }
    }
    const observer = new Observer(entries => update(entries.some(entry => entry.target === target && entry.isIntersecting)))
    observer.observe(target)
    return () => { alive = false; observer.disconnect() }
  }, [active, target, platformDocument])
  const current = viewport?.target === target && viewport.document === target?.ownerDocument ? viewport : null
  useEffect(() => {
    if (!active || !current?.intersecting) return
    const owner = current.document
    const update = () => setForeground({ document: owner, visible: owner.visibilityState !== 'hidden' })
    update()
    owner.addEventListener('visibilitychange', update)
    return () => owner.removeEventListener('visibilitychange', update)
  }, [active, current?.document, current?.intersecting])
  // A stale realm or parked foreground bit cannot authorize work after adoption or hiding.
  return { ref, visible: Boolean(active && current?.intersecting && foreground?.document === current.document && foreground.visible && current.document.visibilityState !== 'hidden') }
}
