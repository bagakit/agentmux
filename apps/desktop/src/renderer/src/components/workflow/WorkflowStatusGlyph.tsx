import { WORKFLOW_STATUS_LABEL, type WorkflowAgentStatus, type WorkflowStatus } from './types'
import { WorkflowSemanticIcon } from '../semantic-icons'

export function WorkflowStatusGlyph({ status, size = 12 }: { status: WorkflowAgentStatus; size?: number }) {
  const className = `wf-ico wf-ico--${status}`
  return <WorkflowSemanticIcon status={status} size={size} className={`${className}${status === 'running' ? ' spin' : ''}`} />
}

export function WorkflowStatusName({ status }: { status: WorkflowStatus | 'queued' }) {
  return <span className="wf-sr">{WORKFLOW_STATUS_LABEL[status]}</span>
}
