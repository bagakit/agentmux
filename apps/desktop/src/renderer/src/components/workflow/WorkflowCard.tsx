import { useId, useLayoutEffect, useState, type ReactNode } from 'react'
import { ChevronRight, GitBranch } from 'lucide-react'
import { WorkflowPhase } from './WorkflowPhase'
import { WorkflowProgressRail } from './WorkflowProgressRail'
import { WorkflowStatusGlyph } from './WorkflowStatusGlyph'
import { workflowStatusLabel, type WorkflowSnapshot, type WorkflowVariant, type WorkflowObservationStatus, type WorkflowRecordedTime } from './types'
import { WorkflowToolRow } from './WorkflowToolRow'
import { workflowPresentation } from './presentation'

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-')
}

type SnapshotProps = {
  workflow: WorkflowSnapshot
  variant?: WorkflowVariant
  defaultExpanded?: boolean
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
}

type ObservationProps = {
  observation: {
    id: string
    stepCount: number
    counts?: { complete: number; streaming: number; failed: number; unknown: number }
    status?: WorkflowObservationStatus
    recordedTime: WorkflowRecordedTime
    elapsed?: string
    streaming?: boolean
  }
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  children: ReactNode
}

export function WorkflowCard(props: SnapshotProps | ObservationProps) {
  return 'observation' in props
    ? <RecordedStepsCard {...props} />
    : <WorkflowSnapshotCard {...props} />
}

/** The host owns the records and disclosure; a contiguous observation is not a workflow. */
function RecordedStepsCard({ observation, expanded, onExpandedChange, children }: ObservationProps) {
  const contentId = useId()
  const [readOnce, setReadOnce] = useState(expanded)
  useLayoutEffect(() => { if (expanded) setReadOnce(true) }, [expanded])
  if (observation.stepCount === 0) return null
  const { recordedTime, status } = observation
  return <article className="wf-card wf-card--observation" data-observation-id={observation.id} data-status={status}>
    <button type="button" className="log-fold wf-head" data-open={expanded ? '' : undefined}
      aria-expanded={expanded} aria-controls={contentId} aria-description={recordedTime.offset}
      onClick={() => onExpandedChange(!expanded)}>
      <span className="log-fold__node"><ChevronRight size={12} className="wf-chev log-fold__chevron" /></span>
      <span className="log-fold__label">
        <span className="log-fold__time" title={recordedTime.offset}>
          <span>{recordedTime.from}</span><span aria-hidden="true">–</span><span>{recordedTime.to}</span>
        </span>
        <span className="log-fold__steps">{observation.stepCount} steps</span>
        {observation.elapsed ? <span className="log-fold__elapsed">{observation.elapsed}</span> : null}
        {status === 'failed' ? <span className="wf-chip log-row__chip--failed"><WorkflowStatusGlyph status="failed" />Failed</span> : null}
        {observation.streaming ? <span className="wf-chip"><WorkflowStatusGlyph status="running" />Streaming</span> : null}
        {status === 'complete' ? <span className="wf-observation__recorded">Recorded</span> : null}
        {status === undefined ? <span className="wf-observation__recorded">Status not recorded</span> : null}
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

function WorkflowSnapshotCard({
  workflow,
  variant = 'inline',
  defaultExpanded,
  expanded: expandedProp,
  onExpandedChange
}: SnapshotProps) {
  const generatedId = useId()
  const contentId = `wf-card-${safeId(workflow.id)}-${safeId(generatedId)}`
  const presentation = workflowPresentation(workflow)
  const [expanded, setExpanded] = useState(defaultExpanded ?? (presentation.kind === 'card' && presentation.defaultExpanded))
  const [phasesExpanded, setPhasesExpanded] = useState(true)
  const expandedValue = expandedProp ?? expanded
  const open = expandedValue && !workflow.legacyNotice
  const setExpandedValue = (next: boolean): void => {
    if (expandedProp === undefined) setExpanded(next)
    onExpandedChange?.(next)
  }

  if (presentation.kind === 'tool') {
    return (
      <WorkflowToolRow
        title={`Workflow ${workflow.name}`}
        workflowName={workflow.name}
        status={workflow.status}
        duration={workflow.duration}
        notice={presentation.notice}
      />
    )
  }

  return (
    <article
      className={`wf-card wf-card--${variant}`}
      data-status={workflow.status}
      data-workflow-id={workflow.id}
    >
      <button
        type="button"
        className="wf-head"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setExpandedValue(!expandedValue)}
      >
        <ChevronRight className="wf-chev" size={14} aria-hidden="true" />
        <GitBranch className="wf-ico" size={12} aria-hidden="true" />
        <span className="wf-head__name">Workflow <em>{workflow.name}</em></span>
        <span className="wf-chip">
          <WorkflowStatusGlyph status={workflow.status} size={12} />
          <span>{workflowStatusLabel(workflow.status)}</span>
        </span>
        <span className="wf-head__meta">
          <WorkflowProgressRail completed={workflow.completedAgents} total={workflow.totalAgents} status={workflow.status} />
          <i>{workflow.completedAgents}/{workflow.totalAgents} agents</i>
          <i>{workflow.duration}</i>
          <i>{workflow.tokens} tokens</i>
          <i>{workflow.toolCalls} 次调用</i>
        </span>
      </button>
      {open ? (
        <div id={contentId} className="wf-body">
          {workflow.current ? <p className="wf-live"><b>当前</b><span>{workflow.current}</span></p> : null}
          {workflow.result ? <p className="wf-result">{workflow.result}</p> : null}
          <button
            type="button"
            className="wf-phase-toggle"
            aria-expanded={phasesExpanded}
            onClick={() => setPhasesExpanded((value) => !value)}
          >
            <ChevronRight className="wf-chev" size={12} aria-hidden="true" />
            <span>阶段</span>
            <span className="wf-sr">{phasesExpanded ? '已展开' : '已折叠'}</span>
          </button>
          {phasesExpanded ? workflow.phases.map((phase) => <WorkflowPhase key={phase.id} phase={phase} compact={variant === 'dock'} />) : null}
        </div>
      ) : null}
    </article>
  )
}
