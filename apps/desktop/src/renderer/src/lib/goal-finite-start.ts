import { parseGoalAgentReference, parseGoalQualifiedAccess, parseGoalInspectionAccess, type GoalInspectionAccess } from '@agentmux/core/goal-agent-reference'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type AgentMuxControlRequest } from '@agentmux/core/control'
import type { DemandSpaceMemberReference } from '@agentmux/demand/relations'

type GoalFiniteStartBase = {
  goalId: string
  operationId: string
  expectedUpdatedAt: number
  phase: 'not-attempted' | 'may-have-dispatched'
}
export type LegacyGoalFiniteStartIntent = GoalFiniteStartBase & { sessionId: string; agentReference?: never; access?: never; accessDraft?: never }
/** Access is private carrier input, never a saved permission. A restored Domain
 * operation can begin with read-only access; its original input is not rebuilt.
 * The first private selection remains when a later action chooses another carrier. */
export type QualifiedGoalFiniteStartIntent = GoalFiniteStartBase & {
  agentReference: DemandSpaceMemberReference
  access: GoalInspectionAccess
  accessDraft?: GoalInspectionAccess
  sessionId?: never
}
/** Retained user intent only. Delivery, Run, body and note remain with Demand/Core. */
export type GoalFiniteStartIntent = LegacyGoalFiniteStartIntent | QualifiedGoalFiniteStartIntent
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === 'string' && !!value && !/[\0\r\n]/u.test(value)

/** A typed view of one original private entry; unreadable/future bytes have no
 * dispatch meaning and are never normalized or replaced by this reader. */
export function readGoalFiniteStartIntent(value: unknown, goalId: string): GoalFiniteStartIntent | undefined {
  if (!record(value) || value.goalId !== goalId || !id(goalId) || !id(value.operationId) ||
      !Number.isSafeInteger(value.expectedUpdatedAt) || (value.expectedUpdatedAt as number) < 0 ||
      value.phase !== undefined && value.phase !== 'not-attempted' && value.phase !== 'may-have-dispatched') return
  const phase = value.phase ?? 'may-have-dispatched'
  if (value.agentReference === undefined) {
    if (Object.keys(value).some(key => !['goalId', 'operationId', 'sessionId', 'expectedUpdatedAt', 'phase'].includes(key)) || !id(value.sessionId)) return
    return { goalId, operationId: value.operationId, sessionId: value.sessionId, expectedUpdatedAt: value.expectedUpdatedAt as number, phase }
  }
  if (Object.keys(value).some(key => !['goalId', 'operationId', 'agentReference', 'access', 'accessDraft', 'expectedUpdatedAt', 'phase'].includes(key))) return
  try {
    const agentReference = parseGoalAgentReference(value.agentReference)
    if (typeof agentReference === 'string') return
    return { goalId, operationId: value.operationId, agentReference, access: parseGoalInspectionAccess(value.access),
      ...(value.accessDraft === undefined ? {} : { accessDraft: parseGoalInspectionAccess(value.accessDraft) }), expectedUpdatedAt: value.expectedUpdatedAt as number, phase }
  } catch { return } // Parsing a current view does not own future or damaged private input.
}

export function goalFiniteStartAccess(intent: QualifiedGoalFiniteStartIntent): GoalInspectionAccess {
  return intent.accessDraft ?? intent.access
}

export function goalFiniteStartInspection(goalId: string, operationId: string, access: GoalInspectionAccess): Extract<AgentMuxControlRequest, { operation: 'demand.show' }> {
  return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: operationId, operation: 'demand.show', demandId: goalId, dispatchOperationId: operationId, access }
}

export function goalFiniteStartSubmission(intent: GoalFiniteStartIntent, access?: GoalInspectionAccess, resumeOriginal = false): Extract<AgentMuxControlRequest, { operation: 'demand.start' }> {
  const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: intent.operationId, operation: 'demand.start', demandId: intent.goalId } as const
  if (intent.agentReference) return { ...base, agentReference: intent.agentReference, access: parseGoalQualifiedAccess(access ?? goalFiniteStartAccess(intent)),
    ...(resumeOriginal ? { resumeOriginal: true } : { expectedUpdatedAt: intent.expectedUpdatedAt }) }
  return { ...base, sessionId: intent.sessionId, expectedUpdatedAt: intent.expectedUpdatedAt }
}

export function restoredGoalFiniteStartIntents(value: unknown): Record<string, unknown> {
  if (!record(value)) return {}
  return { ...value }
}
