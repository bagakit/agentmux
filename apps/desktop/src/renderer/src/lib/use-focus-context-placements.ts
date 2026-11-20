import { createContext, useEffect, useId, useLayoutEffect, useReducer, useRef, type RefObject } from 'react'
import { focusTopicContextKey } from './focus-collection-lanes'
import { FOCUS_BUCKETS, type FocusContext } from './focus-context'

export const FocusPlacementScope = createContext<string | null>(null)

export function focusPlacementCardId(scope: string, key: string): string {
  return `focus-card-${scope}-${encodeURIComponent(key)}`
}

function interacting(card: HTMLElement): boolean {
  const document = card.ownerDocument
  if (card.contains(document.activeElement) || card.querySelector('.focus-context--renaming, .is-menu-open')) return true
  const selection = document.getSelection()
  return Boolean(selection && !selection.isCollapsed && (card.contains(selection.anchorNode) || card.contains(selection.focusNode)))
}

type Bucket = FocusContext['bucket']
type Pending = ReadonlyMap<string, HTMLElement>

/** Hold the position of exactly the mounted card whose current bucket is changing. */
export function useFocusContextPlacements(contexts: readonly FocusContext[], root: RefObject<HTMLElement | null>) {
  const scope = useId()
  const committed = useRef<{ buckets: ReadonlyMap<string, Bucket>; pending: Pending }>({ buckets: new Map(), pending: new Map() })
  const [, update] = useReducer(value => value + 1, 0)
  const lane = root.current
  const prior = committed.current
  const buckets = new Map<string, Bucket>(), pending = new Map<string, HTMLElement>()
  const groups = Object.fromEntries(FOCUS_BUCKETS.map(bucket => [bucket, [] as FocusContext[]])) as Record<Bucket, FocusContext[]>
  for (const context of contexts) {
    const key = focusTopicContextKey(context.hostId, context.id)
    const previous = prior.buckets.get(key)
    let bucket = context.bucket
    if (lane && previous && previous !== bucket) {
      const card = lane.ownerDocument.getElementById(focusPlacementCardId(scope, key))
      if (card && lane.contains(card) && interacting(card)) {
        pending.set(key, card)
        bucket = previous
      }
    }
    buckets.set(key, bucket)
    groups[bucket].push(context)
  }
  const held = pending.size === prior.pending.size && [...pending].every(([key, card]) => prior.pending.get(key) === card)
    ? prior.pending : pending
  useLayoutEffect(() => { committed.current = { buckets, pending: held } })
  useEffect(() => {
    if (!held.size || !lane) return
    const document = lane.ownerDocument
    const flush = () => {
      for (const card of held.values()) {
        if (lane.contains(card) && interacting(card)) continue
        update()
        return
      }
    }
    const observer = new MutationObserver(flush)
    for (const card of held.values()) {
      observer.observe(card, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    }
    document.addEventListener('focusin', flush)
    document.addEventListener('focusout', flush)
    document.addEventListener('selectionchange', flush)
    // A layout effect can release the interaction between render and subscription.
    flush()
    return () => {
      observer.disconnect()
      document.removeEventListener('focusin', flush)
      document.removeEventListener('focusout', flush)
      document.removeEventListener('selectionchange', flush)
    }
  }, [held, lane])
  return { groups, pending: held, scope }
}
