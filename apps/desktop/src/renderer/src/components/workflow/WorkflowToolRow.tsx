import { SemanticIcon } from '../semantic-icons'
import { WorkflowStatusGlyph } from './WorkflowStatusGlyph'
import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import type { WorkflowStatus, WorkflowObservationStatus, WorkflowRecordedTime } from './types'

type WorkflowToolProps = {
  title: string
  workflowName: string
  status: WorkflowStatus
  duration: string
  notice?: string
}

type ObservedToolProps = {
  observation: {
    id: string
    title: string
    status?: WorkflowObservationStatus
    recordedTime: WorkflowRecordedTime
    source: string
    persistentSource: boolean
  }
  className: string
  icon: ReactNode
  expanded?: boolean
  onToggle?: () => void
}

export function WorkflowToolRow(props: WorkflowToolProps | ObservedToolProps) {
  return 'observation' in props ? <RecordedToolRow {...props} /> : <NamedWorkflowToolRow {...props} />
}

function RecordedToolRow({ observation, className, icon, expanded, onToggle }: ObservedToolProps) {
  const { recordedTime, status } = observation
  const content = <>
    <span className="log-row__node">{icon}</span>
    {onToggle ? <span className="log-row__time" title={recordedTime.offset}>{recordedTime.from}</span>
      : <time className="log-row__time" tabIndex={0} aria-description={recordedTime.offset} title={recordedTime.offset}>{recordedTime.from}</time>}
    <span className="log-row__title">{observation.title}</span>
    <span className="log-row__meta">
      {status === 'streaming' ? <span className="log-row__chip"><WorkflowStatusGlyph status="running" />Streaming</span> : null}
      {status === 'failed' ? <span className="log-row__chip log-row__chip--failed"><WorkflowStatusGlyph status="failed" />Failed</span> : null}
      {status === undefined ? <span className="wf-observation__recorded">Status not recorded</span> : null}
      <span className="log-row__source" data-persistent={observation.persistentSource ? '' : undefined}>{observation.source}</span>
      {onToggle ? <ChevronRight size={12} className="log-row__chevron" data-open={expanded ? '' : undefined} /> : null}
    </span>
  </>
  const rowClass = `${className} wf-tool-row wf-tool-row--observation`
  return onToggle ? <button type="button" className={rowClass} data-observation-step-id={observation.id}
    data-status={status} data-open={expanded ? '' : undefined} data-expandable="" aria-expanded={expanded} aria-description={recordedTime.offset} onClick={onToggle}>{content}</button>
    : <div className={rowClass} data-observation-step-id={observation.id} data-status={status}>{content}</div>
}

function NamedWorkflowToolRow({
  title,
  workflowName,
  status,
  duration,
  notice
}: WorkflowToolProps) {
  return (
    <div className="wf-tool-row" data-status={status}>
      <span className="wf-tool-row__chevron" aria-hidden="true">›</span>
      <SemanticIcon name="terminal" className="wf-ico" size={12} />
      <span className="wf-tool-row__title">{title}</span>
      <span className="wf-tool-row__workflow"><SemanticIcon name="branch" size={12} />Workflow {workflowName}</span>
      <span className="wf-tool-row__status"><WorkflowStatusGlyph status={status} />{duration}</span>
      {notice ? <span className="wf-note">{notice}</span> : null}
    </div>
  )
}
