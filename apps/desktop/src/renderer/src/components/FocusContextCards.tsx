import { useLayoutEffect, useReducer, useRef, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import type { FocusContext } from '../lib/focus-context'
import { focusContextIdentityKey, type FocusContextIdentity } from '../lib/focus-context-identity'
import { focusGoalCardKey, type FocusGoalLinks } from '../lib/focus-goal-links'
import { FocusContextCardBody } from './FocusContextCardBody'

const CARD_HEIGHT = 52
const VIEWPORT_MARGIN = CARD_HEIGHT * 2
const contextKey = (context: FocusContext) => JSON.stringify([context.hostId, context.id])

/** Slots stay in the natural CSS grid. Actual intersection controls only a
 * body's first creation; visited bodies retain their original React parent. */
export function FocusContextCards({ contexts, columns, scrollRef, visible, layoutReady = true, selectedId, goalLinks, identities, onSelect }: {
  contexts: readonly FocusContext[]; columns: number; scrollRef: RefObject<HTMLDivElement | null>; visible: boolean
  layoutReady?: boolean
  selectedId: string | null; goalLinks: ReadonlyMap<string, FocusGoalLinks>; identities: ReadonlyMap<string, FocusContextIdentity>
  onSelect(id: string): void
}) {
  const grid = useRef<HTMLDivElement>(null)
  const visited = useRef(new Set<string>())
  const [, render] = useReducer(value => value + 1, 0)
  useLayoutEffect(() => {
    const element = grid.current
    if (!visible || !element) return
    // The outer ref attaches after child layout effects on first mount; its
    // actual containing scrollport is already present in the same DOM tree.
    const rows = scrollRef.current ?? element.closest<HTMLDivElement>('.focus-project-lanes__rows')
    // The original lane owner resolves columns in this same layout phase.
    // Avoid creating an intermediate one-column body tree on its first pass.
    // Unknown/zero geometry or absent observers retain full usable bodies.
    if (!layoutReady && rows && rows.clientWidth > 0 && rows.clientHeight > 0
      && typeof ResizeObserver !== 'undefined' && typeof IntersectionObserver !== 'undefined') return
    const slots = [...element.children] as HTMLDivElement[]
    const viewport = rows?.getBoundingClientRect()
    const usable = layoutReady && rows && viewport && rows.clientHeight > 0 && rows.clientWidth > 0 && typeof IntersectionObserver !== 'undefined'
    const bounds = usable ? element.getBoundingClientRect() : null
    const overlaps = !usable || !bounds || (bounds.bottom >= viewport.top - VIEWPORT_MARGIN && bounds.top <= viewport.bottom + VIEWPORT_MARGIN
      && bounds.right >= viewport.left && bounds.left <= viewport.right)
    let changed = false
    // First real viewport, columns and order are resolved before paint, not
    // deferred to IntersectionObserver's first asynchronous delivery.
    if (overlaps) for (const slot of slots) {
      const key = slot.dataset.focusCardKey!
      if (visited.current.has(key)) continue
      const rect = usable ? slot.getBoundingClientRect() : null
      // Natural grid order is row-major. Once below the overscan boundary,
      // every later slot is below it too; IO owns their future intersection.
      if (rect && rect.top > viewport!.bottom + VIEWPORT_MARGIN) break
      if (!usable || !rect || (rect.bottom >= viewport.top - VIEWPORT_MARGIN && rect.top <= viewport.bottom + VIEWPORT_MARGIN
        && rect.right >= viewport.left && rect.left <= viewport.right)) {
        visited.current.add(key); changed = true
      }
    }
    if (changed) render()
    // Missing physical observation retains all original usable bodies above.
    if (!rows || typeof IntersectionObserver === 'undefined') return
    let active = true
    const observer = new IntersectionObserver(entries => {
      if (!active) return
      let added = false
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const key = (entry.target as HTMLElement).dataset.focusCardKey!
        if (!visited.current.has(key)) { visited.current.add(key); added = true }
        observer.unobserve(entry.target)
      }
      if (added) flushSync(render)
    }, { root: rows, rootMargin: `${VIEWPORT_MARGIN}px 0px` })
    for (const slot of slots) if (!visited.current.has(slot.dataset.focusCardKey!)) observer.observe(slot)
    return () => { active = false; observer.disconnect() }
  }, [visible, layoutReady, columns, contexts, scrollRef])

  function reveal(context: FocusContext, slot: HTMLDivElement) {
    flushSync(() => { visited.current.add(contextKey(context)); render() })
    const button = slot.querySelector<HTMLButtonElement>('button.focus-context[data-session-id]')
    slot.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    button?.focus({ preventScroll: true })
    return button
  }
  return <div ref={grid} className="focus-context-group__cards">{contexts.map(context => {
    const full = visited.current.has(contextKey(context))
    return <div className="focus-context-card" style={{ display: 'grid', minHeight: CARD_HEIGHT }} key={contextKey(context)}
      data-focus-card-key={contextKey(context)} data-focus-card-body={full ? 'mounted' : 'pending'}>
      {full ? <FocusContextCardBody context={context} goalLinks={goalLinks.get(focusGoalCardKey(context.hostId, context.id))}
        identity={identities.get(focusContextIdentityKey(context.hostId, context.id))} selected={selectedId === context.id} onSelect={onSelect} />
        : <button type="button" className={`focus-context focus-context--card${selectedId === context.id ? ' is-selected' : ''}`}
          data-session-id={context.id} data-state={context.state} data-bucket={context.bucket} data-activity={context.activitySemantic}
          aria-pressed={selectedId === context.id} aria-label={`${context.name} · ${context.stateLabel}${context.detailKind === 'service' ? ` · ${context.detail}` : ''}`} aria-description={context.originAddress}
          onMouseDown={event => { if (event.button === 0) event.preventDefault() }}
          onClick={() => onSelect(context.id)}
          onFocus={event => { reveal(context, event.currentTarget.parentElement as HTMLDivElement) }}
          onContextMenu={event => {
            event.preventDefault(); event.stopPropagation()
            const button = reveal(context, event.currentTarget.parentElement as HTMLDivElement)
            button?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: event.clientX, clientY: event.clientY }))
          }}><span className="focus-context__copy"><strong>{context.name}</strong><span className="focus-context__detail">{context.stateLabel}</span></span></button>}
    </div>
  })}</div>
}
