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
  /** Native clients with independent execution connections, such as MCP subagents. */
  concurrentConnections?: true
  /** Provider projection after the original native response is durably recorded. */
  projectResponse?(request: Extract<AgentExecutionMessage, { kind: 'request' }>, response: Record<string, unknown>): Record<string, unknown>
  /** Optional Provider effects under the same resource journal and original generation. */
  execute?(request: Extract<AgentExecutionMessage, { kind: 'request' }>, generation: string, environment?: NodeJS.ProcessEnv): Promise<Record<string, unknown> | undefined>
  /** Explicit whole-helper shutdown only; never called for an observer or socket detach. */
  dispose?(): Promise<void>
  executor: { command: string; args: string[]; env?: Record<string, string | undefined>; cwd: string }
}
