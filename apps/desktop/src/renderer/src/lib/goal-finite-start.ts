import { parseGoalAgentReference, parseGoalQualifiedAccess, parseGoalInspectionAccess, type GoalInspectionAccess } from '@agentmux/core/goal-agent-reference'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type AgentMuxControlRequest } from '@agentmux/core/control'
import type { DemandSpaceMemberReference } from '@agentmux/demand/relations'
import { optionalInputEpoch } from '@agentmux/core/prompt-condition'

type GoalFiniteStartBase = {
  goalId: string
  operationId: string
  expectedUpdatedAt: number
  phase: 'not-attempted' | 'may-have-dispatched'
  inputEpoch?: string
}
export type LegacyGoalFiniteStartIntent = GoalFiniteStartBase & { sessionId: string; agentReference?: never; access?: never; accessDraft?: never }
/** Access is private carrier input, never a saved permission. A restored Domain
 * operation can begin with read-only access; its original input is not rebuilt.
 * The first private selection remains when a later action chooses another carrier. */
export type QualifiedGoalFiniteStartIntent = GoalFiniteStartBase & {
  agentReference: DemandSpaceMemberReference
  access?: GoalInspectionAccess
  accessDraft?: GoalInspectionAccess
  sessionId?: never
}
/** Retained user intent only. Delivery, Run, body and note remain with Demand/Core. */
export type GoalFiniteStartIntent = LegacyGoalFiniteStartIntent | QualifiedGoalFiniteStartIntent
/** Partial connection choices are a form draft, without a business operation or input cut. */
export type GoalFiniteStartAccessSelection = {
  goalId: string; agentReference: DemandSpaceMemberReference; expectedUpdatedAt: number; phase: 'selecting-access'
  accessDraft?: GoalInspectionAccess; operationId?: never; inputEpoch?: never; sessionId?: never; access?: never
}
export type GoalFiniteStartInput = GoalFiniteStartIntent | GoalFiniteStartAccessSelection
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === 'string' && !!value && !/[\0\r\n]/u.test(value)

/** A typed view of one original private entry; unreadable/future bytes have no
 * dispatch meaning and are never normalized or replaced by this reader. */
export function readGoalFiniteStartIntent(value: unknown, goalId: string): GoalFiniteStartInput | undefined {
  if (record(value) && value.phase === 'selecting-access') {
    if (Object.keys(value).some(key => !['goalId', 'agentReference', 'expectedUpdatedAt', 'phase', 'accessDraft'].includes(key)) || value.goalId !== goalId || !id(goalId) ||
      !Number.isSafeInteger(value.expectedUpdatedAt) || (value.expectedUpdatedAt as number) < 0) return
    try {
      const agentReference = parseGoalAgentReference(value.agentReference)
      if (typeof agentReference === 'string') return
      return { goalId, agentReference, expectedUpdatedAt: value.expectedUpdatedAt as number, phase: 'selecting-access',
        ...(value.accessDraft === undefined ? {} : { accessDraft: parseGoalInspectionAccess(value.accessDraft) }) }
    } catch { return }
  }
  if (!record(value) || value.goalId !== goalId || !id(goalId) || !id(value.operationId) ||
      !Number.isSafeInteger(value.expectedUpdatedAt) || (value.expectedUpdatedAt as number) < 0 ||
      value.phase !== undefined && value.phase !== 'not-attempted' && value.phase !== 'may-have-dispatched') return
  const phase = value.phase ?? 'may-have-dispatched'
  let epoch: { inputEpoch?: string }
  try { epoch = optionalInputEpoch(value.inputEpoch) } catch { return }
  if (value.agentReference === undefined) {
    if (Object.keys(value).some(key => !['goalId', 'operationId', 'sessionId', 'expectedUpdatedAt', 'phase', 'inputEpoch'].includes(key)) || !id(value.sessionId)) return
    return { goalId, operationId: value.operationId, sessionId: value.sessionId, expectedUpdatedAt: value.expectedUpdatedAt as number, phase, ...epoch }
  }
  if (Object.keys(value).some(key => !['goalId', 'operationId', 'agentReference', 'access', 'accessDraft', 'expectedUpdatedAt', 'phase', 'inputEpoch'].includes(key))) return
  try {
    const agentReference = parseGoalAgentReference(value.agentReference)
    if (typeof agentReference === 'string') return
    // A new private task may have no connection selected yet. The public
    // access validator remains unchanged, and a submitted empty input stays opaque.
    const access = value.access === undefined ? undefined : parseGoalInspectionAccess(value.access)
    const accessDraft = value.accessDraft === undefined ? undefined : parseGoalInspectionAccess(value.accessDraft)
    if (phase === 'may-have-dispatched' && !accessDraft && !access) return
    return { goalId, operationId: value.operationId, agentReference, ...epoch,
      ...(access === undefined ? {} : { access }), ...(accessDraft === undefined ? {} : { accessDraft }), expectedUpdatedAt: value.expectedUpdatedAt as number, phase }
  } catch { return } // Parsing a current view does not own future or damaged private input.
}

export function goalFiniteStartAccess(intent: QualifiedGoalFiniteStartIntent | GoalFiniteStartAccessSelection): GoalInspectionAccess | undefined {
  return intent.accessDraft ?? intent.access
}

export function goalFiniteStartInspection(goalId: string, operationId: string, access: GoalInspectionAccess | undefined): Extract<AgentMuxControlRequest, { operation: 'demand.show' }> {
  return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: operationId, operation: 'demand.show', demandId: goalId, dispatchOperationId: operationId, ...(access === undefined ? {} : { access }) }
}

export function goalFiniteStartSubmission(intent: GoalFiniteStartInput, access?: GoalInspectionAccess, resumeOriginal = false): Extract<AgentMuxControlRequest, { operation: 'demand.start' }> {
  if (intent.phase === 'selecting-access') throw new Error('Choose the task connections before preparing its Start request.')
  const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: intent.operationId, operation: 'demand.start', demandId: intent.goalId, ...optionalInputEpoch(intent.inputEpoch) } as const
  if (intent.agentReference) return { ...base, agentReference: intent.agentReference, access: parseGoalQualifiedAccess(access ?? goalFiniteStartAccess(intent)),
    ...(resumeOriginal ? { resumeOriginal: true } : { expectedUpdatedAt: intent.expectedUpdatedAt }) }
  return { ...base, sessionId: intent.sessionId, expectedUpdatedAt: intent.expectedUpdatedAt }
}

export function restoredGoalFiniteStartIntents(value: unknown): Record<string, unknown> {
  if (!record(value)) return {}
  return { ...value }
}
