import { WORKFLOW_STATUS_LABEL, type WorkflowAgentStatus, type WorkflowStatus } from './types'
import { SemanticIcon, WorkflowSemanticIcon } from '../semantic-icons'

export function WorkflowStatusGlyph({ status, size = 12, recorded = false }: { status: WorkflowAgentStatus; size?: number; recorded?: boolean }) {
  if (status === 'running') {
    return <SemanticIcon name="status.workflow-running" size={size}
      className={`wf-ico wf-ico--running${recorded ? '' : ' wf-streaming-glyph'}`} />
  }
  return <WorkflowSemanticIcon status={status} size={size} className={`wf-ico wf-ico--${status}`} />
}

export function WorkflowStatusName({ status }: { status: WorkflowStatus | 'queued' }) {
  return <span className="wf-sr">{WORKFLOW_STATUS_LABEL[status]}</span>
}
