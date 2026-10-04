/** Exact command failure boundary. A known prefix never authorizes replay of the remainder. */
export type AgentMuxControlFailure = {
  disposition: 'not_applied' | 'unknown'
  confirmedInputBytes: number | null
}

export class AgentMuxError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly detail?: string,
    readonly controlFailure?: AgentMuxControlFailure,
    readonly logId?: string
  ) {
    super(message)
    this.name = 'AgentMuxError'
  }
}

/** Keep cancellation provenance while preserving the wrapper code consumed by callers. */
export function agentMuxCancellationError(message: string, code: string, reason: unknown): AgentMuxError {
  const detail = reason === undefined ? undefined : JSON.stringify(reason instanceof AgentMuxError
    ? { code: reason.code, name: reason.name, message: reason.message,
      ...(reason.detail === undefined ? {} : { detail: reason.detail }),
      ...(reason.controlFailure === undefined ? {} : { controlFailure: reason.controlFailure }) }
    : { code: reason instanceof Error ? reason.name : 'unknown', message: reason instanceof Error ? reason.message : String(reason) })
  const error = new AgentMuxError(message, code, detail)
  if (reason !== undefined) Object.defineProperty(error, 'cause', { value: reason, configurable: true })
  return error
}
