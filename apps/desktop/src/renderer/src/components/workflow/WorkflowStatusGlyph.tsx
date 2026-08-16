import { Ban, CheckCircle2, Circle, CircleX, LoaderCircle, PauseCircle } from 'lucide-react'
import { WORKFLOW_STATUS_LABEL, type WorkflowAgentStatus, type WorkflowStatus } from './types'

export function WorkflowStatusGlyph({ status, size = 12 }: { status: WorkflowAgentStatus; size?: number }) {
  const className = `wf-ico wf-ico--${status}`
  if (status === 'running') return <LoaderCircle className={`${className} wf-spin`} size={size} aria-hidden="true" />
  if (status === 'completed') return <CheckCircle2 className={className} size={size} aria-hidden="true" />
  if (status === 'failed') return <CircleX className={className} size={size} aria-hidden="true" />
  if (status === 'killed') return <Ban className={className} size={size} aria-hidden="true" />
  if (status === 'paused') return <PauseCircle className={className} size={size} aria-hidden="true" />
  return <Circle className={className} size={size} aria-hidden="true" />
}

export function WorkflowStatusName({ status }: { status: WorkflowStatus | 'queued' }) {
  return <span className="wf-sr">{WORKFLOW_STATUS_LABEL[status]}</span>
}
