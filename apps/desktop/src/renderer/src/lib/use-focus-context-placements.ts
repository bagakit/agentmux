import { useEffect, useLayoutEffect, useReducer, useRef, type RefObject } from 'react'
import { focusTopicContextKey } from './focus-collection-lanes'
import { FOCUS_BUCKETS, type FocusContext } from './focus-context'

function interactingContexts(root: HTMLElement | null): Set<string> {
  const result = new Set<string>()
  if (!root) return result
  const add = (node: Node | null) => {
    const element = node?.nodeType === 1 ? node as Element : node?.parentElement
    const card = element?.closest<HTMLElement>('[data-focus-card-key]')
    if (card && root.contains(card) && card.dataset.focusCardKey) result.add(card.dataset.focusCardKey)
  }
  add(root.ownerDocument.activeElement)
  for (const element of root.querySelectorAll('.focus-context--renaming, .is-menu-open')) add(element)
  const selection = root.ownerDocument.defaultView?.getSelection()
  if (selection && !selection.isCollapsed) { add(selection.anchorNode); add(selection.focusNode) }
  return result
}

/** Delay only the active Context's physical bucket; its current facts remain unchanged. */
export function useFocusContextPlacements(contexts: readonly FocusContext[], root: RefObject<HTMLElement | null>) {
  const committed = useRef(new Map<string, FocusContext['bucket']>())
  const [, update] = useReducer(value => value + 1, 0)
  const key = (context: FocusContext) => focusTopicContextKey(context.hostId, context.id)
  const changed = contexts.some(context => committed.current.has(key(context)) && committed.current.get(key(context)) !== context.bucket)
  const interacting = changed ? interactingContexts(root.current) : new Set<string>()
  const groups = Object.fromEntries(FOCUS_BUCKETS.map(bucket => [bucket, [] as FocusContext[]])) as Record<FocusContext['bucket'], FocusContext[]>
  const pending = new Set<string>()
  for (const context of contexts) {
    const id = key(context), previous = committed.current.get(id)
    const bucket = previous && previous !== context.bucket && interacting.has(id) ? previous : context.bucket
    if (bucket !== context.bucket) pending.add(id)
    groups[bucket].push(context)
  }
  useLayoutEffect(() => {
    committed.current = new Map(contexts.map(context => {
      const id = key(context)
      return [id, pending.has(id) ? committed.current.get(id)! : context.bucket]
    }))
  }, [contexts, pending])
  useEffect(() => {
    if (!pending.size || !root.current) return
    const element = root.current, document = element.ownerDocument
    const flush = () => {
      const current = interactingContexts(element)
      if ([...pending].some(id => !current.has(id))) update()
    }
    const observer = new MutationObserver(flush)
    observer.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    document.addEventListener('focusout', flush)
    document.addEventListener('pointerup', flush)
    document.addEventListener('keyup', flush)
    return () => { observer.disconnect(); document.removeEventListener('focusout', flush); document.removeEventListener('pointerup', flush); document.removeEventListener('keyup', flush) }
  }, [pending, root])
  return { groups, pending }
}
