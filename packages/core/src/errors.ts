export class AgentMuxError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly detail?: string
  ) {
    super(message)
    this.name = 'AgentMuxError'
  }
}
