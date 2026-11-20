import { AgentWorkModeBadge } from './AgentWorkModeBadge'
import { Fragment, useCallback, useLayoutEffect, useReducer, useRef, type ComponentPropsWithoutRef, type CSSProperties, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import type { FocusContext } from '../lib/focus-context'
import type { FocusAgentPinGroup } from '../lib/focus-agent-pins'
import { focusContextIdentityKey, type FocusContextIdentity } from '../lib/focus-context-identity'
import { focusGoalCardKey, type FocusGoalLinks } from '../lib/focus-goal-links'
import { FocusContextCardBody } from './FocusContextCardBody'
import { focusListActivityKey, type FocusListActivity } from '../lib/focus-list-activity'
import type { FocusReplyLines } from '../../../shared/focus-preferences'
import type { FocusAgentReveal } from '../lib/focus-agent-navigation'
import { desktopPresentationCommitted } from '../lib/desktop-presentation'
import { focusCardTrackHeight } from '../lib/focus-lane-layout'
import { focusContextHeat, focusContextVisit } from '../lib/focus-attention'
import { focusTopicContextKey, type FocusTopicHeading } from '../lib/focus-collection-lanes'
import { FocusTopicLabel } from './FocusTopicLabel'
import { FocusZoneFooter } from './FocusZoneFooter'
import { FocusPlacementCard } from './FocusPlacementCard'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { FocusAgentCreations, FocusCreationRow } from '../lib/focus-agent-creations'
import { FOCUS_BUCKET_PRESENTATION } from './FocusContextState'
import { FocusCreationMark } from './FocusCreationConnections'
import { FocusInteractionAge } from './FocusInteractionAge'
import { FocusTaskListContent, focusTaskListDescription } from './FocusTaskListContent'

const DisclosureIcon = semanticIconComponent('navigation.disclosure')
const contextKey = (context: FocusContext) => JSON.stringify([context.hostId, context.id])

type CardIntersection = { observedAt: number; enter: () => void }
type ViewportObservation = { observer: IntersectionObserver; targets: Map<Element, CardIntersection> }

/** A Focus surface shares the browser's observation for slots in the same scrollport. */
export function createFocusCardViewport() {
  const roots = new Map<HTMLElement, Map<number, ViewportObservation>>()
  return {
    observe(root: HTMLElement, margin: number, target: HTMLElement, enter: () => void) {
      const window = root.ownerDocument.defaultView!
      let margins = roots.get(root)
      if (!margins) roots.set(root, margins = new Map())
      let observation = margins.get(margin)
      if (!observation) {
        const targets = new Map<Element, CardIntersection>()
        const observer = new window.IntersectionObserver(entries => {
          const entered = new Set<CardIntersection>()
          for (const entry of entries) {
            const current = targets.get(entry.target)
            // A slot can be hidden and observed again before its old record is delivered.
            if (entry.isIntersecting && current && entry.time >= current.observedAt) entered.add(current)
          }
          if (entered.size) flushSync(() => { for (const current of entered) current.enter() })
        }, { root, rootMargin: `${margin}px 0px` })
        margins.set(margin, observation = { observer, targets })
      }
      const { targets, observer } = observation
      const current = { observedAt: window.performance.now(), enter }
      targets.set(target, current)
      observer.observe(target)
      return () => {
        if (targets.get(target) !== current) return
        targets.delete(target)
        observer.unobserve(target)
        if (!targets.size) {
          observer.disconnect()
          margins.delete(margin)
          if (!margins.size) roots.delete(root)
        }
      }
    }
  }
}

type CardSlot = { key: string; node: HTMLDivElement }
type RegisterCardSlot = (key: string, node: HTMLDivElement) => () => void
function FocusCardSlot({ cardKey, register, ...props }: ComponentPropsWithoutRef<'div'> & { cardKey: string; register: RegisterCardSlot }) {
  const ref = useCallback((node: HTMLDivElement | null) => {
    if (node) return register(cardKey, node)
  }, [cardKey, register])
  return <FocusPlacementCard {...props} ref={ref} cardKey={cardKey} />
}

function cardScrollport(scrollRef: RefObject<HTMLDivElement | null>, element: HTMLDivElement) {
  // On first mount the ancestor ref attaches after its children's layout effects.
  return scrollRef.current?.contains(element) ? scrollRef.current
    : element.closest<HTMLDivElement>('.focus-project-lanes__rows, [data-focus-reveal-scroll]')
}

/** Slots stay in the natural CSS grid. Actual intersection controls only a
 * body's first creation; visited bodies retain their original React parent. */
export function FocusContextCards({ contexts, viewport, scrollRef, visible, list = false, pinGroup, layoutReady = true, replyLines = 2, selectedId, selectedKey, revealRequest, onRevealed, goalLinks, identities, onSelect, topics, sections, visits, activity, interactionTimes,
  creation, creationRows, onToggleCreation, onOpenRelated }: {
  creation?: FocusAgentCreations | undefined
  creationRows?: ReadonlyMap<string, FocusCreationRow> | undefined
  onToggleCreation?: ((key: string) => void) | undefined
  onOpenRelated?: ((context: FocusContext) => void) | undefined
  interactionTimes?: ReadonlyMap<string, number> | undefined
  activity?: ReadonlyMap<string, FocusListActivity> | undefined
  visits?: ReadonlyMap<string, number>
  contexts: readonly FocusContext[]; viewport: ReturnType<typeof createFocusCardViewport>; scrollRef: RefObject<HTMLDivElement | null>; visible: boolean
  list?: boolean
  pinGroup?: FocusAgentPinGroup | undefined
  layoutReady?: boolean
  replyLines?: FocusReplyLines
  selectedKey?: string | undefined
  revealRequest?: FocusAgentReveal | null | undefined
  onRevealed?: ((requestId: string) => void) | undefined
  selectedId: string | null; goalLinks: ReadonlyMap<string, FocusGoalLinks>; identities: ReadonlyMap<string, FocusContextIdentity>
  onSelect(id: string): void
  topics?: ReadonlyMap<string, FocusTopicHeading> | undefined
  sections?: ReadonlyMap<string, FocusTopicHeading> | undefined
}) {
  const grid = useRef<HTMLDivElement>(null)
  const cardHeight = list ? 34 : focusCardTrackHeight(replyLines), viewportMargin = cardHeight * 2
  const visited = useRef(new Set<string>())
  const slots = useRef(new Map<string, CardSlot>())
  const added = useRef(new Set<CardSlot>())
  const watching = useRef(new Map<CardSlot, () => void>())
  const observation = useRef<{ viewport: typeof viewport; rows: HTMLDivElement | null; margin: number; ready: boolean } | null>(null)
  const [, render] = useReducer(value => value + 1, 0)
  const unwatch = useCallback((slot: CardSlot) => {
    watching.current.get(slot)?.()
    watching.current.delete(slot)
  }, [])
  const register = useCallback<RegisterCardSlot>((key, node) => {
    const slot: CardSlot = { key, node }
    slots.current.set(key, slot)
    if (!visited.current.has(key)) added.current.add(slot)
    return () => {
      unwatch(slot)
      added.current.delete(slot)
      slots.current.delete(key)
    }
  }, [unwatch])
  function stopObserving() {
    for (const release of watching.current.values()) release()
    watching.current.clear()
  }
  function mount(key: string) {
    const slot = slots.current.get(key)
    if (slot) {
      unwatch(slot)
      added.current.delete(slot)
    }
    visited.current.add(key)
  }

  useLayoutEffect(() => {
    const element = grid.current
    const previous = observation.current
    if (!element) return
    if (!visible) {
      if (previous) {
        stopObserving()
        observation.current = null
      }
      return
    }
    const rows = cardScrollport(scrollRef, element)
    const changedViewport = !previous || previous.rows !== rows || previous.viewport !== viewport ||
      previous.margin !== viewportMargin || previous.ready !== layoutReady
    if (!changedViewport && !added.current.size) return
    const candidates: CardSlot[] = []
    if (changedViewport) {
      stopObserving()
      // The same order renders the CSS grid. It includes previously attached
      // cards after a real scrollport change, without a DOM query or sort.
      for (const context of contexts) {
        const key = contextKey(context), slot = slots.current.get(key)
        if (slot && !visited.current.has(key)) candidates.push(slot)
      }
    } else {
      candidates.push(...added.current)
    }
    if (!candidates.length) {
      observation.current = { viewport, rows, margin: viewportMargin, ready: layoutReady }
      return
    }
    const window = rows?.ownerDocument.defaultView
    const observable = rows && rows.clientWidth > 0 && rows.clientHeight > 0 && typeof window?.IntersectionObserver !== 'undefined'
    // The lane owner measures real columns in this same phase. Without a
    // physical observation, the original full bodies remain usable.
    if (!layoutReady && observable && typeof window?.ResizeObserver !== 'undefined') {
      observation.current = null
      return
    }
    observation.current = { viewport, rows, margin: viewportMargin, ready: layoutReady }
    added.current.clear()
    const view = layoutReady && observable ? rows.getBoundingClientRect() : null
    const bounds = view ? element.getBoundingClientRect() : null
    let changed = false
    if (!view || !bounds || (bounds.bottom >= view.top - viewportMargin && bounds.top <= view.bottom + viewportMargin
      && bounds.right >= view.left && bounds.left <= view.right)) {
      // First presentation and newly attached slots are complete before paint.
      // Existing slots that merely move are already watched by the browser.
      if (view && !changedViewport) candidates.sort((left, right) =>
        left.node.compareDocumentPosition(right.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
      for (const slot of candidates) {
        const rect = view ? slot.node.getBoundingClientRect() : null
        if (view && rect && rect.top > view.bottom + viewportMargin) break
        if (!view || !rect || (rect.bottom >= view.top - viewportMargin && rect.right >= view.left && rect.left <= view.right)) {
          mount(slot.key)
          changed = true
        }
      }
    }
    if (view && rows) {
      for (const slot of candidates) if (!visited.current.has(slot.key)) {
        watching.current.set(slot, viewport.observe(rows, viewportMargin, slot.node, () => {
          mount(slot.key)
          render()
        }))
      }
    }
    if (changed) render()
  })

  const revealed = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!visible || !layoutReady || !revealRequest?.pending || revealed.current === revealRequest.requestId) return
    const target = contexts.find(context => (context.control?.hostId ?? context.hostId) === revealRequest.hostId &&
      (context.control?.agentSessionId ?? context.id) === revealRequest.agentSessionId &&
      (revealRequest.presentationSessionId === undefined || context.id === revealRequest.presentationSessionId))
    if (!target) return
    const slot = slots.current.get(contextKey(target))?.node, element = grid.current
    const rows = element && cardScrollport(scrollRef, element)
    if (!slot || !rows || !slot.querySelector('button.focus-context')) return
    const box = slot.getBoundingClientRect(), viewport = rows.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return
    const dy = box.top < viewport.top ? box.top - viewport.top : box.bottom > viewport.bottom ? box.bottom - viewport.bottom : 0
    const dx = box.left < viewport.left ? box.left - viewport.left : box.right > viewport.right ? box.right - viewport.right : 0
    if (dy || dx) rows.scrollBy({ top: dy, left: dx, behavior: 'instant' })
    mount(contextKey(target)); revealed.current = revealRequest.requestId
    onRevealed?.(revealRequest.requestId)
    desktopPresentationCommitted()
  }, [visible, layoutReady, revealRequest, contexts, onRevealed, scrollRef])
  function reveal(context: FocusContext, slot: HTMLDivElement) {
    flushSync(() => { mount(contextKey(context)); render() })
    const button = slot.querySelector<HTMLButtonElement>('button.focus-context[data-session-id]')
    slot.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    button?.focus({ preventScroll: true })
    return button
  }
  const hasTree = list && contexts.some(context => {
    const row = creationRows?.get(contextKey(context))
    return row && (row.depth > 0 || row.childCount > 0)
  })
  return <div ref={grid} className="focus-context-group__cards" data-focus-creation-tree={hasTree || undefined}>{contexts.map(context => {
    const key = contextKey(context)
    const requested = revealRequest?.pending && (context.control?.hostId ?? context.hostId) === revealRequest.hostId && (context.control?.agentSessionId ?? context.id) === revealRequest.agentSessionId &&
      (revealRequest.presentationSessionId === undefined || revealRequest.presentationSessionId === context.id)
    const full = visited.current.has(key) || requested
    const goals = goalLinks.get(focusGoalCardKey(context.hostId, context.id))
    const selected = selectedKey === undefined ? selectedId === context.id : selectedKey === key
    const sourceKey = focusTopicContextKey(context.hostId, context.id), topic = topics?.get(sourceKey), section = sections?.get(sourceKey)
    const interactionAt = interactionTimes?.get(sourceKey)
    const branch = creationRows?.get(key)
    const parent = creation?.parents.get(key), created = creation?.children.get(key)?.length
    const creationLabel = [parent && `Created by ${parent.creatorName}`, created && `Created ${created} ${created === 1 ? 'Agent' : 'Agents'}`].filter(Boolean).join(' · ') || undefined
    const branchStyle = list ? { minHeight: cardHeight, '--focus-creation-depth': Math.min(branch?.depth ?? 0, 4) } as CSSProperties
      : { display: 'flex', flexDirection: 'column', minHeight: cardHeight + (topic ? 22 : 0) } as const
    return <Fragment key={key}>{section ? <div className="focus-topic-section" data-focus-topic-section={section.kind === 'worktree' ? undefined : section.id} aria-label={`${section.kind === 'worktree' ? 'Zone' : 'Topic'} · ${section.name}`} data-focus-zone-section={section.kind === 'worktree' ? section.id : undefined}>{section.content ?? <FocusTopicLabel topic={section} />}</div> : null}
    <FocusCardSlot cardKey={key} register={register} className="focus-context-card" style={branchStyle}
      data-focus-creation-depth={branch?.depth ? branch.depth : undefined} data-focus-creation-parent={branch?.childCount ? true : undefined}
      data-focus-card-body={full ? 'mounted' : 'pending'} data-focus-heat={focusContextHeat(context, visits ? focusContextVisit(context, visits) : undefined, Date.now())}
      data-focus-agent-host={context.control?.hostId ?? context.hostId} data-focus-agent-session={context.control?.agentSessionId ?? context.id}
      data-focus-presentation-session={context.id} data-focus-agent-selected={selected ? 'true' : undefined}>
      {full ? <FocusContextCardBody context={context} list={list} pinGroup={pinGroup} topic={list ? topic : undefined} summaryActive={visible} goalLinks={goals}
        identity={identities.get(focusContextIdentityKey(context.hostId, context.id))} selected={selected} activity={activity?.get(focusListActivityKey(context))} interactionAt={interactionAt} creationLabel={creationLabel} creationMark={Boolean(creationLabel && (!list || parent && !branch?.depth && !branch?.childCount))} onSelect={onSelect} />
        : <button type="button" className={`focus-context focus-context--card${list ? ' focus-context--list' : ''}${selected ? ' is-selected' : ''}`}
          data-session-id={context.id} data-state={context.state} data-bucket={context.bucket} data-activity={context.activitySemantic}
          data-focus-list-goal={list && Boolean(goals) || undefined} aria-pressed={selected} aria-label={`${context.name} · ${context.stateLabel}${!list && context.detailKind === 'service' ? ` · ${context.detail}` : ''}${topic ? ` · ${topic.kind === 'worktree' ? 'Zone' : 'Topic'} · ${topic.name}` : ''}`} aria-description={[list ? focusTaskListDescription(context) : context.originAddress, creationLabel].filter(Boolean).join(' · ') || undefined}
          onMouseDown={event => { if (event.button === 0) event.preventDefault() }}
          onClick={() => onSelect(context.id)}
          onFocus={event => { reveal(context, event.currentTarget.parentElement as HTMLDivElement) }}
          onContextMenu={event => {
            event.preventDefault(); event.stopPropagation()
            const button = reveal(context, event.currentTarget.parentElement as HTMLDivElement)
            button?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: event.clientX, clientY: event.clientY }))
          }}>
            {list ? <FocusTaskListContent context={context} interactionAt={interactionAt} placeholder
              creationLabel={parent && !branch?.depth && !branch?.childCount ? creationLabel : undefined} /> : <span className="focus-context__copy"><strong>{context.name}</strong>{creationLabel ? <FocusCreationMark label={creationLabel} /> : null}{interactionAt ? <FocusInteractionAge at={interactionAt} /> : null}{context.kind === 'agent' ? <AgentWorkModeBadge source={context} embedded /> : null}<span className="focus-context__detail">{context.stateLabel}</span></span>}
          </button>}
      {branch?.childCount && onToggleCreation ? <button type="button" className="focus-creation-disclosure"
        aria-expanded={branch.expanded} aria-label={`${branch.expanded ? 'Collapse' : 'Expand'} agents created by ${context.name}`}
        title={`${branch.childCount} directly created ${branch.childCount === 1 ? 'Agent' : 'Agents'}`}
        onClick={() => onToggleCreation(key)}><DisclosureIcon size={12} /></button> : null}
      {branch?.references.length && onOpenRelated ? <div className="focus-creation-references">
        {branch.references.map(({ context: child, label }) => <button key={contextKey(child)} type="button" title={`Open ${child.name} · ${child.workspaceName}`}
          onClick={() => onOpenRelated(child)}><strong>{child.name}</strong><small>{label ?? FOCUS_BUCKET_PRESENTATION[child.bucket].label}</small></button>)}
      </div> : null}
      {topic?.notice ? <div className="focus-zone-notices" data-focus-zone-notices="" role="status">{topic.notice}</div> : null}
      <FocusZoneFooter zone={topic} />
    </FocusCardSlot></Fragment>
  })}</div>
}
