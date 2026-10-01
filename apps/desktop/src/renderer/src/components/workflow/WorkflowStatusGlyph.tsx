import { WORKFLOW_STATUS_LABEL, type WorkflowAgentStatus, type WorkflowStatus } from './types'
import { WorkflowSemanticIcon } from '../semantic-icons'

export function WorkflowStatusGlyph({ status, size = 12 }: { status: WorkflowAgentStatus; size?: number }) {
  if (status === 'running') {
    return <svg className="wf-ico wf-ico--running wf-streaming-glyph" width={size} height={size}
      viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.5" opacity=".16" />
      <circle cx="8" cy="8" r="5.5" pathLength="100" strokeDasharray="30 70" strokeLinecap="round" />
    </svg>
  }
  return <WorkflowSemanticIcon status={status} size={size} className={`wf-ico wf-ico--${status}`} />
}

export function WorkflowStatusName({ status }: { status: WorkflowStatus | 'queued' }) {
  return <span className="wf-sr">{WORKFLOW_STATUS_LABEL[status]}</span>
}
