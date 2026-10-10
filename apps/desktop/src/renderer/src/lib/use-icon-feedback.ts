import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { desktopElementVisible } from './desktop-presentation'

/** One short visual event. Callers retain all confirmation/write and revision qualification. */
export function useIconFeedback(scope: string, active: boolean, target: RefObject<HTMLElement | null>) {
  const current = useRef({ scope, active }); current.current = { scope, active }
  const consumed = useRef({ scope, tokens: new Set<string>() })
  const sequence = useRef(0)
  const [cue, setCue] = useState<{ scope: string; key: number } | null>(null)
  const stop = useCallback(() => setCue(null), [])
  const play = useCallback((expectedScope: string, token: string): boolean => {
    const owner = current.current, element = target.current
    if (owner.scope !== expectedScope || !token) return false
    if (consumed.current.scope !== owner.scope) consumed.current = { scope: owner.scope, tokens: new Set() }
    if (consumed.current.tokens.has(token)) return false
    // A hidden/reduced invocation is consumed rather than queued for its next visible mount.
    consumed.current.tokens.add(token)
    if (!owner.active || !element || element.ownerDocument.hidden || !desktopElementVisible(element) ||
        element.ownerDocument.defaultView!.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
    setCue({ scope: expectedScope, key: ++sequence.current }); return true
  }, [target])
  useLayoutEffect(() => {
    if (consumed.current.scope !== scope) consumed.current = { scope, tokens: new Set() }
    if (!active || cue?.scope !== scope) stop()
  }, [scope, active, stop])
  useEffect(() => {
    if (!cue || !target.current) return
    const element = target.current, owner = element.ownerDocument, reduced = owner.defaultView!.matchMedia('(prefers-reduced-motion: reduce)')
    const check = () => { if (owner.hidden || reduced.matches || !desktopElementVisible(element)) stop() }
    const observer = new owner.defaultView!.MutationObserver(check)
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      observer.observe(ancestor, { attributes: true, attributeFilter: ['hidden', 'inert', 'aria-hidden', 'class', 'style'] })
    }
    // User-selected drawings may have no animated part and emit no end event.
    // This releases the local event; it does not define the drawing's motion duration.
    const timeout = setTimeout(stop, 1000)
    owner.addEventListener('visibilitychange', check); reduced.addEventListener('change', check); check()
    return () => { clearTimeout(timeout); observer.disconnect(); owner.removeEventListener('visibilitychange', check); reduced.removeEventListener('change', check) }
  }, [cue, target, stop])
  const playing = active && cue?.scope === scope
  return { key: playing ? cue.key : 0, animation: playing ? 'feedback' as const : 'none' as const, play, stop }
}
