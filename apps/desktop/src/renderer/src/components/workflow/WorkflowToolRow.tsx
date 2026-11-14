import { SemanticIcon } from '../semantic-icons'
import { WorkflowStatusGlyph } from './WorkflowStatusGlyph'
import type { WorkflowStatus } from './types'

type WorkflowToolProps = {
  title: string
  workflowName: string
  status: WorkflowStatus
  duration: string
  notice?: string
}

export function WorkflowToolRow({
  title,
  workflowName,
  status,
  duration,
  notice
}: WorkflowToolProps) {
  return (
    <div className="wf-tool-row" data-status={status}>
      <span className="wf-tool-row__chevron" aria-hidden="true"><SemanticIcon name="navigation.disclosure" size={12} /></span>
      <SemanticIcon name="object.terminal" className="wf-ico" size={12} />
      <span className="wf-tool-row__title">{title}</span>
      <span className="wf-tool-row__workflow"><SemanticIcon name="object.branch" size={12} />Workflow {workflowName}</span>
      <span className="wf-tool-row__status"><WorkflowStatusGlyph status={status} />{duration}</span>
      {notice ? <span className="wf-note">{notice}</span> : null}
    </div>
  )
}
