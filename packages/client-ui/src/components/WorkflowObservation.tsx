import { useId, useLayoutEffect, useState, type ReactNode } from 'react'
import { SemanticIcon } from '../theme/icons.js'
export type WorkflowObservationStatus = 'streaming' | 'complete' | 'failed' | 'running' | 'interrupted'
export type WorkflowRecordedTime = { from: string; to: string; offset: string }
type ObservationProps = {
  observation: {
    id: string
    stepCount: number
    counts?: { complete: number; streaming: number; failed: number; unknown: number }
    status?: WorkflowObservationStatus
    recordedTime?: WorkflowRecordedTime
    label?: string
    elapsed?: string
    streaming?: boolean
  }
  compact?: boolean
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  children: ReactNode
}

type ObservedToolProps = {
  observation: {
    id: string
    title: string
    status?: WorkflowObservationStatus
    recordedTime?: WorkflowRecordedTime
    source: string
    persistentSource: boolean
  }
  className: string
  icon: ReactNode
  expanded?: boolean
  onToggle?: () => void
  controls?: string
}

export function WorkflowStatusGlyph({ status, size = 12, recorded = false }: { status: 'running' | 'completed' | 'failed' | 'killed' | 'paused' | 'queued'; size?: number; recorded?: boolean }) {
  return <SemanticIcon name={status === 'running' ? recorded ? 'status.running' : 'status.working' : `status.${status}`}
    size={size} className={`wf-ico wf-ico--${status}`} />
}

export function RecordedStepsCard({ observation, compact = false, expanded, onExpandedChange, children }: ObservationProps) {
  const contentId = useId()
  const [readOnce, setReadOnce] = useState(expanded)
  useLayoutEffect(() => { if (expanded) setReadOnce(true) }, [expanded])
  if (observation.stepCount === 0) return null
  const { recordedTime, status } = observation
  return <article className="wf-card wf-card--observation" data-observation-id={observation.id} data-status={status}>
    <button type="button" className="log-fold wf-head" data-open={expanded ? '' : undefined}
      aria-expanded={expanded} aria-controls={contentId} aria-description={recordedTime?.offset}
      onClick={() => onExpandedChange(!expanded)}>
      <span className="log-fold__node"><SemanticIcon name="navigation.disclosure" size={12} className="wf-chev log-fold__chevron" /></span>
      <span className="log-fold__label">
        {observation.label ? <span className="wf-observation__recorded">{observation.label}</span> : null}
        {recordedTime && !compact ? <span className="log-fold__time" title={recordedTime.offset}>
          <span>{recordedTime.from}</span><span aria-hidden="true">–</span><span>{recordedTime.to}</span>
        </span> : null}
        <span className="log-fold__steps">{observation.stepCount} {compact ? '步' : 'steps'}</span>
        {observation.elapsed ? <span className="log-fold__elapsed">{observation.elapsed}</span> : null}
        {status === 'running' ? <span className="wf-chip" title="Last recorded operation status"><WorkflowStatusGlyph status="running" recorded />Recorded running</span> : null}
        {status === 'interrupted' ? <span className="wf-chip"><WorkflowStatusGlyph status="killed" recorded />Interrupted</span> : null}
        {status === 'failed' ? <span className="wf-chip log-row__chip--failed"><WorkflowStatusGlyph status="failed" />Failed</span> : null}
        {observation.streaming ? <span className="wf-chip"><WorkflowStatusGlyph status="running" />Streaming</span> : null}
        {status === 'complete' ? <span className="wf-observation__recorded">Recorded</span> : null}
        {status === undefined ? <span className="wf-observation__recorded">{compact ? '状态未记录' : 'Status not recorded'}</span> : null}
      </span>
    </button>
    {observation.counts ? <div className="wf-observation__summary" aria-label="Recorded step states">
      <span className="wf-observation__caption">Recorded activity</span>
      {observation.counts.complete > 0 ? <span className="wf-observation__stat" data-state="complete"><WorkflowStatusGlyph status="completed" />{observation.counts.complete} complete</span> : null}
      {observation.counts.streaming > 0 ? <span className="wf-observation__stat" data-state="streaming"><WorkflowStatusGlyph status="running" />{observation.counts.streaming} streaming</span> : null}
      {observation.counts.failed > 0 ? <span className="wf-observation__stat" data-state="failed"><WorkflowStatusGlyph status="failed" />{observation.counts.failed} failed</span> : null}
      {observation.counts.unknown > 0 ? <span className="wf-observation__stat">{observation.counts.unknown} status not recorded</span> : null}
    </div> : null}
    <div id={contentId} className="wf-body wf-observation__body" hidden={!expanded} inert={!expanded}>
      {expanded || readOnce ? children : null}
    </div>
  </article>
}

export function RecordedToolRow({ observation, className, icon, expanded, onToggle, controls }: ObservedToolProps) {
  const { recordedTime, status } = observation
  const content = <>
    <span className="log-row__node">{icon}</span>
    {recordedTime ? onToggle ? <span className="log-row__time" title={recordedTime.offset}>{recordedTime.from}</span>
      : <time className="log-row__time" tabIndex={0} aria-description={recordedTime.offset} title={recordedTime.offset}>{recordedTime.from}</time> : null}
    <span className="log-row__title">{observation.title}</span>
    <span className="log-row__meta">
      {status === 'streaming' ? <span className="log-row__chip"><WorkflowStatusGlyph status="running" />Streaming</span> : null}
      {status === 'running' ? <span className="log-row__chip" title="Last recorded operation status"><WorkflowStatusGlyph status="running" recorded />Recorded running</span> : null}
      {status === 'interrupted' ? <span className="log-row__chip" title="Last recorded operation status"><WorkflowStatusGlyph status="killed" recorded />Interrupted</span> : null}
      {status === 'failed' ? <span className="log-row__chip log-row__chip--failed"><WorkflowStatusGlyph status="failed" />Failed</span> : null}
      {status === undefined ? <span className="wf-observation__recorded">Status not recorded</span> : null}
      <span className="log-row__source" data-persistent={observation.persistentSource ? '' : undefined}>{observation.source}</span>
      {onToggle ? <SemanticIcon name="navigation.disclosure" size={12} className="log-row__chevron" data-open={expanded ? '' : undefined} /> : null}
    </span>
  </>
  const rowClass = `${className} wf-tool-row wf-tool-row--observation`
  return onToggle ? <button type="button" className={rowClass} data-recorded-time={Boolean(recordedTime)} data-observation-step-id={observation.id}
    data-status={status} data-open={expanded ? '' : undefined} data-expandable="" aria-expanded={expanded} aria-controls={controls} aria-description={recordedTime?.offset} onClick={onToggle}>{content}</button>
    : <div className={rowClass} data-recorded-time={Boolean(recordedTime)} data-observation-step-id={observation.id} data-status={status}>{content}</div>
}

export function RecordedAgentRow({ observation }: {
  observation: {
    id: string
    label: string
    source: string
    state?: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'stopped' | 'not-found'
    message?: string
  }
}) {
  const [expanded, setExpanded] = useState(false)
  const detailId = useId()
  const state = observation.state
  const glyph = state === 'running' ? 'running' : state === 'completed' ? 'completed'
    : state === 'failed' ? 'failed' : state === 'interrupted' || state === 'stopped' ? 'killed'
    : state === 'pending' ? 'queued' : 'paused'
  return <>
    <li className="wf-agent wf-agent--observation" data-recorded-agent-id={observation.id}>
      <button type="button" className="wf-agent__button" aria-expanded={expanded}
        aria-controls={detailId} onClick={() => setExpanded(value => !value)}>
        <span className="wf-agent__state">{state === undefined || state === 'not-found' ? <SemanticIcon name="status.neutral" size={12} className="semantic-icon" aria-hidden="true" /> : <WorkflowStatusGlyph status={glyph} recorded />}</span>
        <span className="wf-agent__label"><span className="wf-agent__name" title={observation.label}>{observation.label}</span></span>
        <span className="wf-agent__meta" title="Last recorded target state">
          <span>{state ?? 'State not recorded'}</span><SemanticIcon name="navigation.disclosure" className="wf-chev" size={12} aria-hidden="true" />
        </span>
      </button>
    </li>
    <li id={detailId} className="wf-detail" data-for-recorded-agent={observation.id} hidden={!expanded} inert={!expanded}>
      <dl><div><dt>Native reference</dt><dd>{observation.source}</dd></div>
        {state ? <div><dt>Last recorded state</dt><dd>{state}</dd></div> : null}</dl>
      {observation.message === undefined ? null : <pre className="wf-native-process__text">{observation.message}</pre>}
    </li>
  </>
}
