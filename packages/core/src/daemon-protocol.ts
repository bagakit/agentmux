import type { AgentId } from './types.js'

export const AGENTMUX_DAEMON_PROTOCOL_VERSION = 1
export const AGENTMUX_DAEMON_MAX_FRAME_BYTES = 1024 * 1024

export type AgentMuxDaemonSessionState = 'running' | 'exited'

export type AgentMuxDaemonSession = {
  sessionId: string
  incarnationId: string
  createOperationId: string
  kind: 'terminal' | 'agent'
  agentId: AgentId | null
  cwd: string
  pid: number
  state: AgentMuxDaemonSessionState
  cols: number
  rows: number
  createdAt: number
  latestSequence: number
  exitedAt?: number
  exitCode?: number
  exitSignal?: number
}

export type AgentMuxDaemonDataEvent = {
  type: 'data'
  sessionId: string
  incarnationId: string
  sequence: number
  data: string
}

export type AgentMuxDaemonExitEvent = {
  type: 'exit'
  sessionId: string
  incarnationId: string
  exitCode: number
  exitSignal?: number
  observedAt: number
}

export type AgentMuxDaemonEvent = AgentMuxDaemonDataEvent | AgentMuxDaemonExitEvent

export type AgentMuxReplayGap = {
  requestedAfterSequence: number
  firstAvailableSequence: number
}

export type AgentMuxDaemonAttachResult = {
  session: AgentMuxDaemonSession
  replay: AgentMuxDaemonDataEvent[]
  gap: AgentMuxReplayGap | null
}

export type AgentMuxDaemonHello = {
  protocolVersion: number
  daemonPid: number
}

export type AgentMuxDaemonCreateRequest = {
  sessionId: string
  createOperationId: string
  kind: 'terminal' | 'agent'
  agentId: AgentId | null
  cwd: string
  cols: number
  rows: number
  env: Record<string, string>
  command?: string
  args?: string[]
}

export type AgentMuxDaemonMethod =
  | 'hello'
  | 'list'
  | 'create'
  | 'attach'
  | 'detach'
  | 'write'
  | 'resize'
  | 'signal'
  | 'stop'

export type AgentMuxDaemonRequestFrame = {
  type: 'request'
  id: string
  method: AgentMuxDaemonMethod
  params: unknown
}

export type AgentMuxDaemonResponseFrame =
  | { type: 'response'; id: string; ok: true; result: unknown }
  | { type: 'response'; id: string; ok: false; error: { code: string; message: string } }

export type AgentMuxDaemonEventFrame = {
  type: 'event'
  event: AgentMuxDaemonEvent
}

export type AgentMuxDaemonFrame =
  | AgentMuxDaemonRequestFrame
  | AgentMuxDaemonResponseFrame
  | AgentMuxDaemonEventFrame

export function encodeAgentMuxDaemonFrame(frame: AgentMuxDaemonFrame): string {
  return `${JSON.stringify(frame)}\n`
}

export function parseAgentMuxDaemonFrame(line: string): AgentMuxDaemonFrame {
  const value: unknown = JSON.parse(line)
  if (!value || typeof value !== 'object' || !('type' in value)) {
    throw new Error('Invalid AgentMux daemon frame.')
  }
  return value as AgentMuxDaemonFrame
}
