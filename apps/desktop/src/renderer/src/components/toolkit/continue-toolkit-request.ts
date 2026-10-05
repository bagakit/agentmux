import type { ToolkitAdmission } from '@agentmux/core/control'
import type { ToolkitDesktopApi } from '../../../../shared/toolkit'

/** An explicit execution request, carrying every original identity unchanged. */
export function continueToolkitRequest(api: Pick<ToolkitDesktopApi, 'run' | 'action'>, toolId: string, admission: ToolkitAdmission) {
  return admission.action
    ? api.action(toolId, admission.action.id, { invocationId: admission.invocationId, expectedRevision: admission.definition.revision,
      sourceExecutionId: admission.action.sourceExecutionId, expectedAdmissionExecutionId: admission.action.expectedAdmissionExecutionId })
    : api.run(toolId, { invocationId: admission.invocationId, expectedRevision: admission.definition.revision,
      expectedLatestExecutionId: admission.expectedLatestExecutionId })
}

export const CONTINUE_TOOLKIT_NOTICE = 'Continues the original request. If its Run is no longer retained, the script may run now.'
