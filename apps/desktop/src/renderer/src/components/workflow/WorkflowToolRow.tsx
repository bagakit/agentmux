import { GitBranch, Terminal } from 'lucide-react'
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
      <Terminal className="wf-ico" size={12} aria-hidden="true" />
      <span className="wf-tool-row__title">{title}</span>
      <span className="wf-tool-row__workflow"><GitBranch size={12} aria-hidden="true" />Workflow {workflowName}</span>
      <span className="wf-tool-row__status"><WorkflowStatusGlyph status={status} />{duration}</span>
      {notice ? <span className="wf-note">{notice}</span> : null}
    </div>
  )
}
