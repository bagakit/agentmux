import type { WorkflowSnapshot } from './types'

export type WorkflowPresentation =
  | { kind: 'card'; defaultExpanded: boolean }
  | { kind: 'tool'; notice: string }

/** Presentation policy belongs beside the view model, so rendering does not infer domain capability. */
export function workflowPresentation(workflow: WorkflowSnapshot): WorkflowPresentation {
  if (workflow.legacyNotice) return { kind: 'tool', notice: workflow.legacyNotice }
  return {
    kind: 'card',
    defaultExpanded: workflow.status === 'running' || workflow.status === 'failed'
  }
}
