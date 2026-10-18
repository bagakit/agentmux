import { useLayoutEffect, useReducer, useRef, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import type { FocusContext } from '../lib/focus-context'
import { focusContextIdentityKey, type FocusContextIdentity } from '../lib/focus-context-identity'
import { focusGoalCardKey, type FocusGoalLinks } from '../lib/focus-goal-links'
import { FocusContextCardBody } from './FocusContextCardBody'
import type { FocusReplyLines } from '../../../shared/focus-preferences'
import type { FocusAgentReveal } from '../lib/focus-agent-navigation'
import { desktopPresentationCommitted } from '../lib/desktop-presentation'
import { focusCardTrackHeight } from '../lib/focus-lane-layout'

const contextKey = (context: FocusContext) => JSON.stringify([context.hostId, context.id])

/** Slots stay in the natural CSS grid. Actual intersection controls only a
 * body's first creation; visited bodies retain their original React parent. */
export function FocusContextCards({ contexts, columns, scrollRef, visible, layoutReady = true, replyLines = 2, selectedId, selectedKey, revealRequest, onRevealed, goalLinks, identities, onSelect }: {
  contexts: readonly FocusContext[]; columns: number; scrollRef: RefObject<HTMLDivElement | null>; visible: boolean
  layoutReady?: boolean
  replyLines?: FocusReplyLines
  selectedKey?: string | undefined
  revealRequest?: FocusAgentReveal | null | undefined
  onRevealed?: ((requestId: string) => void) | undefined
  selectedId: string | null; goalLinks: ReadonlyMap<string, FocusGoalLinks>; identities: ReadonlyMap<string, FocusContextIdentity>
  onSelect(id: string): void
}) {
  const grid = useRef<HTMLDivElement>(null)
  const cardHeight = focusCardTrackHeight(replyLines), viewportMargin = cardHeight * 2
  const visited = useRef(new Set<string>())
  const [, render] = useReducer(value => value + 1, 0)
  // Live card facts do not change the slots. Keep their observer through those
  // updates; it already follows natural geometry changes between renders.
  const cardOrder = contexts.map(contextKey).join('\n')
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
    const overlaps = !usable || !bounds || (bounds.bottom >= viewport.top - viewportMargin && bounds.top <= viewport.bottom + viewportMargin
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
      if (rect && rect.top > viewport!.bottom + viewportMargin) break
      if (!usable || !rect || (rect.bottom >= viewport.top - viewportMargin && rect.top <= viewport.bottom + viewportMargin
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
    }, { root: rows, rootMargin: `${viewportMargin}px 0px` })
    for (const slot of slots) if (!visited.current.has(slot.dataset.focusCardKey!)) observer.observe(slot)
    return () => { active = false; observer.disconnect() }
  }, [visible, layoutReady, columns, cardOrder, scrollRef, viewportMargin])

  const revealed = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!visible || !layoutReady || !revealRequest?.pending || revealed.current === revealRequest.requestId) return
    const target = contexts.find(context => (context.control?.hostId ?? context.hostId) === revealRequest.hostId &&
      (context.control?.agentSessionId ?? context.id) === revealRequest.agentSessionId &&
      (revealRequest.presentationSessionId === undefined || context.id === revealRequest.presentationSessionId))
    if (!target) return
    const slot = [...(grid.current?.children ?? [])].find(element => (element as HTMLElement).dataset.focusCardKey === contextKey(target)) as HTMLElement | undefined
    const rows = scrollRef.current ?? grid.current?.closest<HTMLElement>('.focus-project-lanes__rows')
    if (!slot || !rows || !slot.querySelector('button.focus-context')) return
    const box = slot.getBoundingClientRect(), viewport = rows.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return
    const dy = box.top < viewport.top ? box.top - viewport.top : box.bottom > viewport.bottom ? box.bottom - viewport.bottom : 0
    const dx = box.left < viewport.left ? box.left - viewport.left : box.right > viewport.right ? box.right - viewport.right : 0
    if (dy || dx) rows.scrollBy({ top: dy, left: dx, behavior: 'instant' })
    visited.current.add(contextKey(target)); revealed.current = revealRequest.requestId
    onRevealed?.(revealRequest.requestId)
    desktopPresentationCommitted()
  }, [visible, layoutReady, revealRequest, cardOrder, onRevealed, scrollRef])
  function reveal(context: FocusContext, slot: HTMLDivElement) {
    flushSync(() => { visited.current.add(contextKey(context)); render() })
    const button = slot.querySelector<HTMLButtonElement>('button.focus-context[data-session-id]')
    slot.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    button?.focus({ preventScroll: true })
    return button
  }
  return <div ref={grid} className="focus-context-group__cards">{contexts.map(context => {
    const requested = revealRequest?.pending && (context.control?.hostId ?? context.hostId) === revealRequest.hostId && (context.control?.agentSessionId ?? context.id) === revealRequest.agentSessionId &&
      (revealRequest.presentationSessionId === undefined || revealRequest.presentationSessionId === context.id)
    const full = visited.current.has(contextKey(context)) || requested
    const selected = selectedKey === undefined ? selectedId === context.id : selectedKey === contextKey(context)
    return <div className="focus-context-card" style={{ display: 'grid', minHeight: cardHeight }} key={contextKey(context)}
      data-focus-card-key={contextKey(context)} data-focus-card-body={full ? 'mounted' : 'pending'}
      data-focus-agent-host={context.control?.hostId ?? context.hostId} data-focus-agent-session={context.control?.agentSessionId ?? context.id}
      data-focus-presentation-session={context.id} data-focus-agent-selected={selected ? 'true' : undefined}>
      {full ? <FocusContextCardBody context={context} goalLinks={goalLinks.get(focusGoalCardKey(context.hostId, context.id))}
        identity={identities.get(focusContextIdentityKey(context.hostId, context.id))} selected={selected} onSelect={onSelect} />
        : <button type="button" className={`focus-context focus-context--card${selected ? ' is-selected' : ''}`}
          data-session-id={context.id} data-state={context.state} data-bucket={context.bucket} data-activity={context.activitySemantic}
          aria-pressed={selected} aria-label={`${context.name} · ${context.stateLabel}${context.detailKind === 'service' ? ` · ${context.detail}` : ''}`} aria-description={context.originAddress}
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
