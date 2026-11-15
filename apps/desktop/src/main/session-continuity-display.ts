import type { AgentMuxAgentSession, AgentMuxClientEvent } from '@agentmux/core'
import { hostedPromptAdmissionSummary } from '@agentmux/core/hosted'
import type { AgentMuxContinuityOperation } from '@agentmux/core/agent-session-recovery'
import {
  DESKTOP_CONTINUITY_OPERATION_FIELDS,
  type DesktopContinuityFacts, type DesktopContinuityOperation,
  type DesktopRecoverySession, type DesktopRuntimeEvent
} from '../shared/contracts'

export function projectContinuityOperation(operation: AgentMuxContinuityOperation): DesktopContinuityOperation {
  const display: Record<string, unknown> = {}
  for (const field of DESKTOP_CONTINUITY_OPERATION_FIELDS) {
    if (Object.hasOwn(operation, field)) display[field] = operation[field]
  }
  return display as DesktopContinuityOperation
}

export function projectSessionContinuity(session: Pick<AgentMuxAgentSession, 'continuity' | 'continuityOperations'>): DesktopContinuityFacts {
  const { continuity, continuityOperations } = session
  return {
    ...(continuity ? { continuity: projectContinuityOperation(continuity) } : {}),
    ...(continuityOperations ? { continuityOperations: Object.fromEntries(Object.entries(continuityOperations)
      .map(([id, operation]) => [id, projectContinuityOperation(operation)])) } : {})
  }
}

export function projectDesktopRecoverySession(session: AgentMuxAgentSession): DesktopRecoverySession {
  const { continuity: _continuity, continuityOperations: _operations, ...fields } = session
  return { ...fields, ...projectSessionContinuity(session) }
}

export function projectDesktopRuntimeEvent(event: AgentMuxClientEvent): DesktopRuntimeEvent {
  if (event.type !== 'agent-session') return event
  const { promptCompletionAdmission, ...session } = projectDesktopRecoverySession(event.session)
  return { ...event, session: { ...session,
    ...(promptCompletionAdmission ? { promptCompletionAdmission: hostedPromptAdmissionSummary(promptCompletionAdmission) } : {}) } }
}
