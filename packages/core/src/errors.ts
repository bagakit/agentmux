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
    readonly controlFailure?: AgentMuxControlFailure
  ) {
    super(message)
    this.name = 'AgentMuxError'
  }
}
