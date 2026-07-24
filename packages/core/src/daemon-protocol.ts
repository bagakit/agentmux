import type { AgentId } from './types.js'

export const AGENTMUX_DAEMON_PROTOCOL_VERSION = 5
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
  agentSessionId: string | null
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
  agentSessionId: string
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

export type AgentMuxDaemonDiagnostics = {
  nodeVersion: string
  platform: NodeJS.Platform
  arch: string
  supported: boolean
  pty: {
    packageName: 'node-pty'
    version: string
    artifact: string
    artifactPresent: boolean
    helperArtifact: string | null
    helperExecutable: boolean | null
    ready: boolean
  }
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
  agentSessionId: string | null
  cwd: string
  cols: number
  rows: number
  env: Record<string, string>
  command?: string
  args?: string[]
}

export type AgentMuxDaemonMethod =
  | 'hello'
  | 'diagnose'
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

const daemonMethods = new Set<string>([
  'hello',
  'diagnose',
  'list',
  'find-create-operation',
  'probe-executable',
  'create',
  'attach',
  'detach',
  'write',
  'resize',
  'ack',
  'signal',
  'stop'
])

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function boundedString(value: unknown, maxBytes = 16 * 1024): value is string {
  return typeof value === 'string' && Buffer.byteLength(value) <= maxBytes && !/[\0\r\n]/.test(value)
}

function safeSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function validEvent(value: unknown): value is AgentMuxDaemonEvent {
  const event = record(value)
  if (
    !event ||
    !boundedString(event.sessionId, 256) || !event.sessionId ||
    !boundedString(event.incarnationId, 256) || !event.incarnationId
  ) {
    return false
  }
  if (event.type === 'data') {
    return (
      safeSequence(event.startSequence) &&
      safeSequence(event.endSequence) &&
      typeof event.data === 'string' &&
      event.endSequence >= event.startSequence &&
      event.endSequence - event.startSequence === Buffer.byteLength(event.data)
    )
  }
  if (event.type === 'exit') {
    return (
      Number.isInteger(event.pid) && (event.pid as number) > 0 &&
      Number.isInteger(event.exitCode) &&
      (event.exitSignal === undefined || Number.isInteger(event.exitSignal)) &&
      safeSequence(event.observedAt)
    )
  }
  if (event.type === 'hook') {
    return (
      boundedString(event.agentSessionId, 256) && Boolean(event.agentSessionId) &&
      boundedString(event.agentId, 256) && Boolean(event.agentId) &&
      (event.eventName === undefined || boundedString(event.eventName, 4 * 1024)) &&
      (event.payload === undefined || record(event.payload) !== null)
    )
  }
  return false
}

export function encodeAgentMuxDaemonFrame(frame: AgentMuxDaemonFrame): string {
  return `${JSON.stringify(frame)}\n`
}

export function parseAgentMuxDaemonFrame(line: string): AgentMuxDaemonFrame {
  const value: unknown = JSON.parse(line)
  const frame = record(value)
  if (!frame) throw new Error('Invalid AgentMux daemon frame.')
  if (frame.type === 'request') {
    if (
      !boundedString(frame.id, 256) || !frame.id ||
      typeof frame.method !== 'string' || !daemonMethods.has(frame.method) ||
      record(frame.params) === null
    ) {
      throw new Error('Invalid AgentMux daemon request frame.')
    }
    return frame as AgentMuxDaemonRequestFrame
  }
  if (frame.type === 'response') {
    if (!boundedString(frame.id, 256) || !frame.id || typeof frame.ok !== 'boolean') {
      throw new Error('Invalid AgentMux daemon response frame.')
    }
    if (frame.ok) {
      if (!('result' in frame)) throw new Error('Invalid AgentMux daemon response frame.')
    } else {
      const error = record(frame.error)
      if (
        !error ||
        !boundedString(error.code, 256) || !error.code ||
        !boundedString(error.message, 16 * 1024)
      ) {
        throw new Error('Invalid AgentMux daemon error frame.')
      }
    }
    return frame as AgentMuxDaemonResponseFrame
  }
  if (frame.type === 'event' && validEvent(frame.event)) return frame as AgentMuxDaemonEventFrame
  throw new Error('Invalid AgentMux daemon frame.')
}
