import type { AgentMuxSpaceMutationReport } from '@agentmux/core/control'
import type { AgentSessionControl } from '../../../shared/contracts'
import type { TakeoverSource } from './session-takeover'
import type { AgentTakeoverCancellationInput, AgentTakeoverCancellationResult } from '@agentmux/core/agent-takeover'

export type AgentOperationSubject = { hostId: string; agentSessionId?: string | undefined; regionId?: string | undefined }
export type AgentOperationKind = 'stop' | 'takeover' | 'fork'
export type AgentOperationPhase = 'pending' | 'succeeded' | 'partial' | 'retired' | 'failed' | 'unconfirmed' | 'cancelled'
export type TakeoverCancellation = {
  input: AgentTakeoverCancellationInput
  pending: boolean
  dispatch: 'not-submitted' | 'unconfirmed'
  result?: AgentTakeoverCancellationResult
  issue?: string | undefined
  settlingFeedback?: true
}
type OperationBase = {
  operationId: string; subject: AgentOperationSubject; startedAt: number
  phase: AgentOperationPhase; message?: string | undefined; canContinue?: boolean | undefined
  report?: AgentMuxSpaceMutationReport
  /** A retained Core Stop may answer with its original id, preserving the callers that joined it. */
  callerOperationIds?: string[]
}
export type AgentOperationFeedback = OperationBase & (
  { kind: 'stop'; control: AgentSessionControl; inputCloseout?: true }
  | { kind: 'takeover'; takeoverSource: TakeoverSource; cancellation?: TakeoverCancellation; cardFeedbackDismissed?: true }
  | { kind: 'fork' }
)
export type AgentOperationReferences = Record<string, AgentOperationFeedback>
/** Historical records have only the original read action. Active and custom actions stay in feedback. */
export function isRetainedTakeoverRecord(operation: AgentOperationFeedback): boolean {
  return operation.kind === 'takeover' && operation.phase !== 'pending' && !operation.cancellation &&
    !operation.takeoverSource.coreRequest && !operation.takeoverSource.clubPreparation && !operation.takeoverSource.derived
}
export const agentOperationKey = (operation: Pick<AgentOperationFeedback, 'kind' | 'operationId' | 'subject'>) =>
  JSON.stringify([operation.subject.hostId, operation.subject.agentSessionId ?? operation.subject.regionId, operation.kind, operation.operationId])

export function canDismissTakeoverCardFeedback(operation: Extract<AgentOperationFeedback, { kind: 'takeover' }>): boolean {
  const result = operation.cancellation?.result
  return result?.outcome === 'created' && result.diskDurability === 'confirmed'
}

export function isDurableTakeoverCancellation(result: AgentTakeoverCancellationResult | undefined): boolean {
  return result?.outcome === 'cancelled' && result.diskDurability === 'confirmed'
}
export function withoutCancellationFeedback(cancellation: TakeoverCancellation): TakeoverCancellation {
  const { settlingFeedback: _transient, ...retained } = cancellation
  return retained
}

const bySubject = new WeakMap<AgentOperationReferences, Map<string, AgentOperationFeedback[]>>()
const retained = new WeakMap<AgentOperationReferences, AgentOperationReferences>()
const subjectKey = (subject: AgentOperationSubject) => JSON.stringify([subject.hostId,
  subject.agentSessionId ? 'agent' : 'region', subject.agentSessionId ?? subject.regionId])
const empty: AgentOperationFeedback[] = []
/** Index changes only with operation references, never with unrelated Session bytes. */
export function agentOperationsForSubject(operations: AgentOperationReferences, subject: AgentOperationSubject) {
  let index = bySubject.get(operations)
  if (!index) {
    index = new Map()
    for (const operation of Object.values(operations)) {
      const keys = [subjectKey(operation.subject)]
      if (operation.subject.agentSessionId && operation.subject.regionId) keys.push(subjectKey({ hostId: operation.subject.hostId, regionId: operation.subject.regionId }))
      for (const key of keys) {
        const list = index.get(key) ?? []
        list.push(operation); index.set(key, list)
      }
    }
    bySubject.set(operations, index)
  }
  return index.get(subjectKey(subject)) ?? empty
}

/** Confirmed completion needs only its finite decoration, not a durable unresolved intent. */
export function persistedAgentOperations(operations: AgentOperationReferences): AgentOperationReferences {
  let projection = retained.get(operations)
  if (!projection) {
    projection = Object.fromEntries(Object.entries(operations)
      .filter(([, operation]) => operation.phase !== 'succeeded' || isRetainedTakeoverRecord(operation) || operation.kind === 'takeover' && operation.cancellation)
      .map(([key, operation]) => [key, operation.kind === 'takeover' && operation.cancellation?.settlingFeedback
        ? { ...operation, cancellation: withoutCancellationFeedback(operation.cancellation) } : operation]))
    retained.set(operations, projection)
  }
  return projection
}

/** A restored reference proves an earlier intent, not a still-running operation. */
export function restoredAgentOperations(operations: AgentOperationReferences | undefined): AgentOperationReferences {
  return Object.fromEntries(Object.entries(operations ?? {}).map(([key, operation]) => {
    if (operation.kind === 'takeover' && operation.cancellation) {
      const result = operation.cancellation.result
      return [key, { ...operation, canContinue: false,
        phase: result?.outcome === 'cancelled' ? 'cancelled' : 'unconfirmed',
        cancellation: { ...withoutCancellationFeedback(operation.cancellation), pending: false },
        message: operation.message ?? (result?.outcome === 'cancelled' ? '这次接手已取消，原工作仍保留。' : '原接手和取消请求已保留，请核对取消结果。') }]
    }
    return [key, { ...operation, phase: 'unconfirmed', canContinue: false, message: operation.message ?? '原操作已保留，需核对当前结果。' }]
  }))
}
