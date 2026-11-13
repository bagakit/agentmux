import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export type MobileScreenMotion = { kind: 'push' | 'pop'; key: number } | null

/**
 * Presentation-only screen motion. A layer change animates only when an explicit navigation action
 * advanced the navigation revision; automatic chat start, late directory reads and polling never
 * animate. Sibling workfaces at the same depth switch without motion.
 */
export function useMobileScreenMotion(layer: string, depth: number, revision: number): MobileScreenMotion {
  const previous = useRef({ layer, depth, revision })
  const [motion, setMotion] = useState<MobileScreenMotion>(null)
  useLayoutEffect(() => {
    const before = previous.current
    previous.current = { layer, depth, revision }
    if (before.layer === layer || before.revision === revision || before.depth === depth) return
    setMotion(value => ({ kind: depth > before.depth ? 'push' : 'pop', key: (value?.key ?? 0) + 1 }))
  }, [layer, depth, revision])
  useEffect(() => {
    if (!motion) return
    const timer = setTimeout(() => setMotion(value => value?.key === motion.key ? null : value), 420)
    return () => clearTimeout(timer)
  }, [motion])
  return motion
}
