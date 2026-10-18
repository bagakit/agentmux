import { AgentMuxError, parseAgentMuxErrorData, type AgentMuxErrorData } from '@agentmux/core/control'

/** Configuration errors cross both Electron boundaries as data, not lossy Error objects. */
export type ToolkitConfigurationResult<T> = { ok: true; result: T } | { ok: false; error: AgentMuxErrorData }

export async function toolkitConfigurationResult<T>(save: () => Promise<T>): Promise<ToolkitConfigurationResult<T>> {
  try { return { ok: true, result: await save() } }
  catch (cause) {
    const error = cause instanceof Error ? cause as Error & Partial<AgentMuxErrorData> : null
    return { ok: false, error: {
      code: typeof error?.code === 'string' ? error.code : 'TOOLKIT_CONFIGURATION_FAILED',
      message: error?.message ?? String(cause),
      ...(typeof error?.detail === 'string' ? { detail: error.detail } : {}),
      ...(error?.controlFailure ? { controlFailure: error.controlFailure } : {}),
      ...(error?.logId ? { logId: error.logId } : {})
    } }
  }
}

export function unwrapToolkitConfigurationResult<T>(reply: ToolkitConfigurationResult<T>): T {
  if (!reply.ok) {
    const error = parseAgentMuxErrorData(reply.error)
    throw new AgentMuxError(error.message, error.code, error.detail, error.controlFailure, error.logId)
  }
  return reply.result
}
