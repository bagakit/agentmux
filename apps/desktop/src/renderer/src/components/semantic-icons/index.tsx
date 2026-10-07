import { SemanticIcon, type SemanticIconId } from '@agentmux/client-ui/icons'
import type { WorkflowAgentStatus } from '../workflow/types'
export { SemanticIcon } from '@agentmux/client-ui/icons'

/** Workflow lifecycle remains a Desktop fact; drawing choice belongs to the shared theme. */
export function WorkflowSemanticIcon({ status, size = 12, className }: { status: WorkflowAgentStatus; size?: number; className?: string }) {
  const name: SemanticIconId = status === 'running' ? 'object.workflow' : `status.${status}`
  return <SemanticIcon name={name} size={size} animation={status === 'running' ? 'spin' : 'none'} {...(className ? { className } : {})} />
}
