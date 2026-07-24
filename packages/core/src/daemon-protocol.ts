import type { AgentId } from './types.js'

export const AGENTMUX_DAEMON_PROTOCOL_VERSION = 4
export const AGENTMUX_DAEMON_MAX_FRAME_BYTES = 1024 * 1024
export const AGENTMUX_DAEMON_BUILD_IDENTITY = '0.1.0'
export const AGENTMUX_LOCAL_HOST_ID = 'local'

export type AgentMuxDaemonSessionState = 'running' | 'exited' | 'lost'

export type AgentMuxDaemonSessionRef = {
  sessionId: string
  incarnationId: string
}

export type AgentMuxDaemonSession = {
  sessionId: string
  incarnationId: string
  createOperationId: string
  kind: 'terminal' | 'agent'
  agentId: AgentId | null
  semanticSessionId: string | null
  cwd: string
  pid: number
  processStartedAt?: number
  state: AgentMuxDaemonSessionState
  cols: number
  rows: number
  createdAt: number
  latestSequence: number
  acceptedInputSequence: number
  exitedAt?: number
  exitCode?: number
  exitSignal?: number
  lostAt?: number
  lostReason?: 'daemon-crash'
}

export type AgentMuxDaemonDataEvent = {
  type: 'data'
  sessionId: string
  incarnationId: string
  startSequence: number
  endSequence: number
  data: string
}

export type AgentMuxDaemonExitEvent = {
  type: 'exit'
  sessionId: string
  incarnationId: string
  pid: number
  exitCode: number
  exitSignal?: number
  observedAt: number
}

export type AgentMuxDaemonHookEvent = {
  type: 'hook'
  sessionId: string
  incarnationId: string
  semanticSessionId: string
  agentId: AgentId
  eventName?: string
  payload?: Record<string, unknown>
}

export type AgentMuxDaemonEvent =
  | AgentMuxDaemonDataEvent
  | AgentMuxDaemonExitEvent
  | AgentMuxDaemonHookEvent

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
  buildIdentity: string
  hostId: string
  daemonPid: number
  daemonInstanceId: string
}

export type AgentMuxDaemonInputAck = AgentMuxDaemonSessionRef & {
  acceptedThrough: number
  duplicate: boolean
}

export type AgentMuxDaemonOutputAck = AgentMuxDaemonSessionRef & {
  acknowledgedThrough: number
}

export type AgentMuxDaemonAppliedSize = AgentMuxDaemonSessionRef & {
  cols: number
  rows: number
}

export type AgentMuxDaemonCreateRequest = {
  sessionId: string
  createOperationId: string
  kind: 'terminal' | 'agent'
  agentId: AgentId | null
  semanticSessionId: string | null
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
  | 'find-create-operation'
  | 'probe-executable'
  | 'create'
  | 'attach'
  | 'detach'
  | 'write'
  | 'resize'
  | 'ack'
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
