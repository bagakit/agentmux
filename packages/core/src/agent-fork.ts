import { AgentMuxError } from './errors.js'
import { parseNativeConfirmationHandle } from './agent-native-session-confirmation.js'
import type { AgentMuxAgentSession, AgentMuxRunRef, AgentNativeSessionHandle } from './types.js'

/** Exact current source; this carries no authority to stop or redirect its Run. */
export type AgentMuxAgentForkSource = {
  agentSessionId: string
  expectedRun: AgentMuxRunRef
  expectedNativeHandle: Extract<AgentNativeSessionHandle, { kind: 'provider' }>
}

export function parseAgentForkSource(value: unknown): AgentMuxAgentForkSource {
  const invalid = (): never => { throw new AgentMuxError('Fork requires the exact source Session, Run and native conversation.', 'INVALID_AGENT_FORK_SOURCE') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const source = value as Record<string, unknown>
  if (Object.keys(source).some(key => !['agentSessionId', 'expectedRun', 'expectedNativeHandle'].includes(key)) ||
    typeof source.agentSessionId !== 'string' || !source.agentSessionId || source.agentSessionId === 'self' ||
    source.agentSessionId.length > 256 || /[\0\r\n]/u.test(source.agentSessionId)) invalid()
  if (!source.expectedRun || typeof source.expectedRun !== 'object' || Array.isArray(source.expectedRun)) invalid()
  const run = source.expectedRun as Record<string, unknown>
  if (Object.keys(run).some(key => key !== 'runId') || typeof run.runId !== 'string' || !run.runId ||
    run.runId.length > 256 || /[\0\r\n]/u.test(run.runId)) invalid()
  return { agentSessionId: source.agentSessionId as string, expectedRun: { runId: run.runId as string },
    expectedNativeHandle: parseNativeConfirmationHandle(source.expectedNativeHandle) }
}

export function assertAgentForkSource(source: AgentMuxAgentForkSource, current: AgentMuxAgentSession,
  target: { providerId: string; executorId: string; workspacePath: string }): void {
  const native = current.nativeHandle, expected = source.expectedNativeHandle
  if (current.hostId !== 'local' || current.agentSessionId !== source.agentSessionId || current.run.runId !== source.expectedRun.runId ||
    native?.kind !== 'provider' || native.providerId !== expected.providerId || native.sessionId !== expected.sessionId ||
    native.transcriptPath !== expected.transcriptPath || current.providerId !== target.providerId ||
    current.executorId !== target.executorId || current.workspacePath !== target.workspacePath || current.nativeSourceObservation) {
    throw new AgentMuxError('The fork source is no longer the confirmed current conversation. Inspect or confirm this Session first; its input and work surface are retained.', 'AGENT_FORK_SOURCE_CHANGED')
  }
}

/** Parent addresses may be present in copied native history; the new identity takes precedence. */
export function agentForkIdentityReminder(agentSessionId: string, source: AgentMuxAgentForkSource): string {
  return `This is a new AgentMux fork. Your current AgentMux Session ID is ${agentSessionId}.\n` +
    `The source AgentMux Session ${source.agentSessionId} and native conversation ${source.expectedNativeHandle.sessionId} are ancestry only.\n` +
    'Use amux whoami for your current Run and Region. Addresses in inherited history belong to the source; use your new identity for current actions.'
}
