import type { AgentMuxSpaceMutationReport } from '@agentmux/core/control'
import type { AgentSessionControl } from '../../../shared/contracts'

export type AgentOperationSubject = { hostId: string; agentSessionId?: string | undefined; regionId?: string | undefined }
export type AgentOperationKind = 'stop' | 'takeover' | 'fork'
export type AgentOperationPhase = 'pending' | 'succeeded' | 'partial' | 'failed' | 'unconfirmed'
type OperationBase = {
  operationId: string; subject: AgentOperationSubject; startedAt: number
  phase: AgentOperationPhase; message?: string | undefined; canContinue?: boolean | undefined
  report?: AgentMuxSpaceMutationReport
  /** A retained Core Stop may answer with its original id, preserving the callers that joined it. */
  callerOperationIds?: string[]
}
export type AgentOperationFeedback = OperationBase & (
  { kind: 'stop'; control: AgentSessionControl } | { kind: 'takeover' | 'fork' }
)
export type AgentOperationReferences = Record<string, AgentOperationFeedback>
export const agentOperationKey = (operation: Pick<AgentOperationFeedback, 'kind' | 'operationId' | 'subject'>) =>
  JSON.stringify([operation.subject.hostId, operation.subject.agentSessionId ?? operation.subject.regionId, operation.kind, operation.operationId])

const bySubject = new WeakMap<AgentOperationReferences, Map<string, AgentOperationFeedback[]>>()
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

/** A restored reference proves an earlier intent, not a still-running operation. */
export function restoredAgentOperations(operations: AgentOperationReferences | undefined): AgentOperationReferences {
  return Object.fromEntries(Object.entries(operations ?? {}).map(([key, operation]) => [key,
    { ...operation, phase: 'unconfirmed', canContinue: false, message: '原操作已保留，需核对当前结果。' }
  ]))
}
