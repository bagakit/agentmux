import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { FOCUS_BUCKETS, groupFocusContexts, focusNeutralGroupSummary, type FocusContext } from '../lib/focus-context'
import { focusCollectionTopics, focusTopicContextKey, focusTopicSections, type FocusScanLane, type FocusTopicHeading } from '../lib/focus-collection-lanes'
import { focusCreationTree, type FocusAgentCreations, type FocusCreationRow } from '../lib/focus-agent-creations'
import { FocusLaneGroups } from './FocusLaneGroups'
import { FOCUS_BUCKET_PRESENTATION } from './FocusContextState'
import { FocusPlacementScope, useFocusContextPlacements } from '../lib/use-focus-context-placements'
import type { FocusLaneCounts, FocusLaneMetrics } from '../lib/focus-lane-layout'
import { resolveFocusTopicPresentation, type FocusReplyLines, type FocusTopicPresentation } from '../../../shared/focus-preferences'

/** The actual scan and its settings example share grouping, state heads and Topic presentation. */
export function FocusScanLaneContent({ lane, contexts, heading, pins, metrics, replyLines = 2, topicPresentation = resolveFocusTopicPresentation(undefined), renderCards, list = false, compact = false, creation, visibleKeys, revealKey }: {
  list?: boolean
  pins?: ReactNode
  creation?: FocusAgentCreations | undefined
  visibleKeys?: ReadonlySet<string> | undefined
  revealKey?: string | undefined
  compact?: boolean
  lane: FocusScanLane; contexts: readonly FocusContext[]; heading: ReactNode; metrics: FocusLaneMetrics
  replyLines?: FocusReplyLines; topicPresentation?: FocusTopicPresentation
  renderCards(contexts: readonly FocusContext[], columns: number, topics?: ReadonlyMap<string, FocusTopicHeading>, sections?: ReadonlyMap<string, FocusTopicHeading>, rows?: ReadonlyMap<string, FocusCreationRow>, onToggle?: (key: string) => void): ReactNode
}) {
  const topics = useMemo(() => focusCollectionTopics(lane), [lane.collection, lane.zones, lane.zoneHeadings])
  const organization = lane.zonePresentation ?? topicPresentation
  const organized = Boolean(lane.collection || lane.zones)
  const groupsRef = useRef<HTMLDivElement>(null)
  const actual = groupFocusContexts(contexts)
  const { groups, pending, scope } = useFocusContextPlacements(contexts, groupsRef)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const withSections = organized && organization === 'sections'
  const hasLocalCreator = list && creation?.children.size && contexts.some(context => creation.children.has(focusTopicContextKey(context.hostId, context.id)))
  const tree = creation && hasLocalCreator && visibleKeys ? focusCreationTree(groups, creation, visibleKeys, collapsed, withSections ? topics : undefined, revealKey) : null
  const ancestors = tree?.revealAncestors
  useLayoutEffect(() => {
    if (!ancestors?.size) return
    setCollapsed(previous => {
      if (![...ancestors].some(key => previous.has(key))) return previous
      return new Set([...previous].filter(key => !ancestors.has(key)))
    })
  }, [ancestors])
  function toggle(key: string) {
    setCollapsed(previous => {
      const next = new Set(previous)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }
  const displayed = tree?.groups ?? groups
  const counts: FocusLaneCounts = [displayed.attention.length, displayed.working.length, displayed.results.length, displayed.idle.length]
  const sparse = contexts.length === 1
  function groupHeader(bucket: typeof FOCUS_BUCKETS[number], inline = false, moving = false) {
    const meta = FOCUS_BUCKET_PRESENTATION[bucket], Icon = meta.icon, grouped = actual[bucket]
    const neutral = bucket === 'idle' ? focusNeutralGroupSummary(grouped) : null
    const label = neutral?.label ?? meta.label, detail = neutral?.detail ?? `${label} · ${grouped.length}`
    return <header className="focus-context-group__header" data-bucket={bucket} data-visible-state={inline || undefined} data-position-pending={moving || undefined} title={detail} aria-label={detail} key={bucket}>
      <span className="focus-context-group__bucket"><Icon size={12} aria-hidden="true" /><strong>{label}</strong><span className="focus-context-group__count" aria-hidden="true">{grouped.length > 99 ? '99+' : grouped.length}</span></span>
      {moving ? <span className="focus-context-group__pending" role="status">Position held until interaction ends</span> : null}
    </header>
  }
  return <><div className="focus-project-lanes__title">{heading}<div className="focus-project-lanes__status-rail" aria-label="Context states">
    {FOCUS_BUCKETS.filter(bucket => compact || sparse || (contexts.length > 0 && displayed[bucket].length === 0)).map(bucket => {
      if (actual[bucket].length > 0) return groupHeader(bucket, true)
      const meta = FOCUS_BUCKET_PRESENTATION[bucket], Icon = meta.icon
      return <span className="focus-context-group__header" data-bucket={bucket} title={`${meta.label} · 0`} aria-label={`${meta.label} · 0`} key={bucket}><Icon size={12} aria-hidden="true" /></span>
    })}
  </div></div>{pins}{contexts.length > 0 ? <FocusPlacementScope.Provider value={scope}><FocusLaneGroups list={list} counts={counts} metrics={metrics} replyLines={replyLines} groupsRef={groupsRef}>{layout =>
    FOCUS_BUCKETS.map((bucket, index) => {
      const grouped = displayed[bucket]
      if (!grouped.length) return null
      const moving = grouped.some(context => pending.has(focusTopicContextKey(context.hostId, context.id)))
      const label = bucket === 'idle' ? focusNeutralGroupSummary(grouped).label : FOCUS_BUCKET_PRESENTATION[bucket].label
      const sectioned = withSections ? focusTopicSections(grouped, topics) : null
      return <section className="focus-context-group global-agents-group" aria-label={label} data-bucket={bucket} data-focus-sparse={sparse || undefined}
        style={{ gridRow: layout.rowByBucket[index]! + 1, '--focus-group-offset': `${layout.columnStart[index]}px`, '--focus-card-columns': layout.columns[index], '--focus-group-width': `${layout.widths[index]}px` } as CSSProperties} key={bucket}>
        {!sparse ? groupHeader(bucket, false, moving) : moving ? <span className="focus-context-group__pending" role="status">Position held until interaction ends</span> : null}
        {renderCards(sectioned?.contexts ?? grouped, layout.columns[index]!, organized && !sectioned ? topics : undefined, sectioned?.sections, tree?.rows, tree ? toggle : undefined)}
      </section>
    })
  }</FocusLaneGroups></FocusPlacementScope.Provider> : null}</>
}
