import { SemanticIcon } from '../semantic-icons'
import { WorkflowStatusGlyph } from './WorkflowStatusGlyph'
import type { WorkflowStatus } from './types'

export function WorkflowToolRow({
  title,
  workflowName,
  status,
  duration,
  notice
}: {
  title: string
  workflowName: string
  status: WorkflowStatus
  duration: string
  notice?: string
}) {
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
