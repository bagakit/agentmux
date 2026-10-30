import { useMemo, type CSSProperties, type ReactNode } from 'react'
import { FOCUS_BUCKETS, groupFocusContexts, focusNeutralGroupSummary, type FocusContext } from '../lib/focus-context'
import { focusCollectionTopics, focusTopicSections, type FocusScanLane, type FocusTopicHeading } from '../lib/focus-collection-lanes'
import { FocusLaneGroups } from './FocusLaneGroups'
import { FOCUS_BUCKET_PRESENTATION } from './FocusContextState'
import type { FocusLaneCounts, FocusLaneMetrics } from '../lib/focus-lane-layout'
import type { FocusReplyLines, FocusTopicPresentation } from '../../../shared/focus-preferences'

/** The actual scan and its settings example share grouping, state heads and Topic presentation. */
export function FocusScanLaneContent({ lane, contexts, heading, metrics, replyLines = 2, topicPresentation = 'cards', renderCards }: {
  lane: FocusScanLane; contexts: readonly FocusContext[]; heading: ReactNode; metrics: FocusLaneMetrics
  replyLines?: FocusReplyLines; topicPresentation?: FocusTopicPresentation
  renderCards(contexts: readonly FocusContext[], columns: number, topics?: ReadonlyMap<string, FocusTopicHeading>, sections?: ReadonlyMap<string, FocusTopicHeading>): ReactNode
}) {
  const topics = useMemo(() => focusCollectionTopics(lane), [lane.collection])
  const groups = groupFocusContexts(contexts)
  const counts: FocusLaneCounts = [groups.attention.length, groups.working.length, groups.results.length, groups.idle.length]
  const sparse = contexts.length === 1
  function groupHeader(bucket: typeof FOCUS_BUCKETS[number], inline = false) {
    const meta = FOCUS_BUCKET_PRESENTATION[bucket], Icon = meta.icon, grouped = groups[bucket]
    const neutral = bucket === 'idle' ? focusNeutralGroupSummary(grouped) : null
    const label = neutral?.label ?? meta.label, detail = neutral?.detail ?? `${label} · ${grouped.length}`
    return <header className="focus-context-group__header" data-bucket={bucket} data-visible-state={inline || undefined} title={detail} aria-label={detail} key={bucket}>
      <span className="focus-context-group__bucket"><Icon size={12} aria-hidden="true" /><strong>{label}</strong><span className="focus-context-group__count" aria-hidden="true">{grouped.length > 99 ? '99+' : grouped.length}</span></span>
    </header>
  }
  return <><div className="focus-project-lanes__title">{heading}<div className="focus-project-lanes__status-rail" aria-label="Context states">
    {FOCUS_BUCKETS.filter(bucket => sparse || (contexts.length > 0 && groups[bucket].length === 0)).map(bucket => {
      if (groups[bucket].length > 0) return groupHeader(bucket, true)
      const meta = FOCUS_BUCKET_PRESENTATION[bucket], Icon = meta.icon
      return <span className="focus-context-group__header" data-bucket={bucket} title={`${meta.label} · 0`} aria-label={`${meta.label} · 0`} key={bucket}><Icon size={12} aria-hidden="true" /></span>
    })}
  </div></div>{contexts.length > 0 ? <FocusLaneGroups counts={counts} metrics={metrics} replyLines={replyLines}>{layout =>
    FOCUS_BUCKETS.map((bucket, index) => {
      const grouped = groups[bucket]
      if (!grouped.length) return null
      const label = bucket === 'idle' ? focusNeutralGroupSummary(grouped).label : FOCUS_BUCKET_PRESENTATION[bucket].label
      const sectioned = lane.collection && topicPresentation === 'sections' ? focusTopicSections(grouped, topics) : null
      return <section className="focus-context-group global-agents-group" aria-label={label} data-bucket={bucket} data-focus-sparse={sparse || undefined}
        style={{ gridRow: layout.rowByBucket[index]! + 1, '--focus-group-offset': `${layout.columnStart[index]}px`, '--focus-card-columns': layout.columns[index], '--focus-group-width': `${layout.widths[index]}px` } as CSSProperties} key={bucket}>
        {!sparse ? groupHeader(bucket) : null}
        {renderCards(sectioned?.contexts ?? grouped, layout.columns[index]!, lane.collection && !sectioned ? topics : undefined, sectioned?.sections)}
      </section>
    })
  }</FocusLaneGroups> : null}</>
}
