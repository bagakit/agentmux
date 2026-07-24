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

export class CommandExecutionError extends AgentMuxError {
  constructor(
    message: string,
    readonly command: string,
    readonly args: readonly string[],
    readonly exitCode: number,
    detail?: string
  ) {
    super(message, 'COMMAND_FAILED', detail)
    this.name = 'CommandExecutionError'
  }
}
