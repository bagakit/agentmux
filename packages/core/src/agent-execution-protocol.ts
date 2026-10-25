/** Provider interpretation of native protocol facts; none of these fields grants authority. */
export type AgentExecutionRequestId = string | number
export interface AgentExecutionIntent {
  kind: 'read' | 'write' | 'process' | 'control'
  paths: { path: string; access: 'read' | 'write'; sandbox?: unknown }[]
  argv?: string[]
  cwd?: string
  processId?: string
  handle?: { kind: 'file' | 'process'; id: string; action: 'create' | 'use' | 'close' }
  initialize?: true
  handleId?: string
  resumeSessionId?: string | null
  sandbox?: unknown
  environmentConfig?: true
}
export type AgentExecutionMessage =
  | { kind: 'request'; requestId: AgentExecutionRequestId; method: string; params: Record<string, unknown> | null; payload: Record<string, unknown>; intent: AgentExecutionIntent }
  | { kind: 'notification'; method: string; payload: Record<string, unknown> }
  | { kind: 'response'; requestId: AgentExecutionRequestId; payload: Record<string, unknown> }
  | { kind: 'rejected'; requestId?: AgentExecutionRequestId; code: number; reason: string; payload: unknown }

/** The helper owns transport lifetime; only its Provider interprets native messages. */
export interface AgentExecutionProtocol {
  parse(input: unknown): AgentExecutionMessage
  parseServer(input: unknown): AgentExecutionMessage
  executor: { command: string; args: string[]; env?: Record<string, string>; cwd: string }
}
