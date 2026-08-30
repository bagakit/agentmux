import { WORKFLOW_STATUS_LABEL, type WorkflowAgentStatus, type WorkflowStatus } from './types'
import { WorkflowSemanticIcon } from '../semantic-icons'

export function WorkflowStatusGlyph({ status, size = 12 }: { status: WorkflowAgentStatus; size?: number }) {
  // "running 就转圈"这个决定归 `WorkflowSemanticIcon` 所有，这里不再写第二遍——
  // 写两遍渲染出来就是 `class="… spin spin"`（实测），两处将来还会各自漂移。
  return <WorkflowSemanticIcon status={status} size={size} className={`wf-ico wf-ico--${status}`} />
}

export function WorkflowStatusName({ status }: { status: WorkflowStatus | 'queued' }) {
  return <span className="wf-sr">{WORKFLOW_STATUS_LABEL[status]}</span>
}
