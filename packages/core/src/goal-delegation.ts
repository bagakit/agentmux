import { parseFileReadParams, type FileReadParams } from './public-rpc-files.js'
import { parseDemandDelegationIntent, parseDemandDelegations, parseDemandDelegationReportInput, parseDemandDelegationCollectionInput, validateDemandDelegationReport } from '@agentmux/demand/delegations'
import { parseGrounding } from '@agentmux/demand/goals'
import type { DemandDelegation, DemandDelegationIntent, DemandDelegationReportInput, DemandDelegationCollectionInput } from '@agentmux/demand/delegations'
import type { DemandGrounding } from '@agentmux/demand/goals'
import { parseRpcNativeResult } from './rpc-native-codec.js'
import type { AgentMuxRun } from './types.js'
import type { DurableAgentMuxMessage } from './agent-global-message-queue.js'
import type { DispatchObservation } from './agent-handoff.js'
import { AgentMuxError } from './errors.js'
import type { AgentMuxRpcCallContext } from './public-rpc-service.js'

/** Goal owns business intent and reports; this port never owns a message queue. */
export const GOAL_DELEGATION_METHODS = { 'goal.delegation.prepare': 'long', 'goal.delegate': 'long', 'goal.report': 'long', 'goal.collect': 'long', 'goal.delegations': 'long' } as const
export type GoalDelegationMethod = keyof typeof GOAL_DELEGATION_METHODS
export type GoalDelegationParamsMap = {
  'goal.delegation.prepare': { goalId: string; intent: DemandDelegationIntent; materials?: FileReadParams[] }
  'goal.delegate': { goalId: string; intent: DemandDelegationIntent; materials?: FileReadParams[] }
  'goal.report': { goalId: string; operationId: string; report: DemandDelegationReportInput }
  'goal.collect': { goalId: string; operationId: string; collection: DemandDelegationCollectionInput }
  'goal.delegations': { goalId: string }
}
export type GoalDelegationObservation = { operationId: string; communication?: DispatchObservation & { hostId: string }; workerRun?: Pick<AgentMuxRun, 'runId' | 'state'>; unknown?: string; recoverableReport?: DemandDelegationReportInput; attention?: { state: 'prepared' | 'confirmed' | 'unknown'; reason: string } }
export type GoalDelegationResult = { goalId: string; goalUpdatedAt: number; delegations: DemandDelegation[]; grounding?: DemandGrounding; diskDurability: 'confirmed'; observations?: GoalDelegationObservation[] }
export type GoalDelegationResultMap = { [M in GoalDelegationMethod]: GoalDelegationResult }
/** Supplied after transport/Core caller admission, never from an editable business payload. */
export type GoalDelegationAuthority = { actor: { kind: 'agent' | 'user' | 'device'; id: string }; hostId?: string; runId?: string }
export interface GoalDelegationsOwner {
  call<M extends GoalDelegationMethod>(method: M, input: GoalDelegationParamsMap[M], context: AgentMuxRpcCallContext,
    authority: GoalDelegationAuthority): Promise<GoalDelegationResultMap[M]>
}
export function isGoalDelegationMethod(value: string): value is GoalDelegationMethod { return Object.hasOwn(GOAL_DELEGATION_METHODS, value) }
function record(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)))
    throw new AgentMuxError('The original Goal delegation object is invalid.', 'INVALID_CONTROL_REQUEST')
  return value as Record<string, unknown>
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new AgentMuxError('An exact Goal delegation identity is required.', 'INVALID_CONTROL_REQUEST')
  return value
}
export function parseGoalDelegationParams<M extends GoalDelegationMethod>(method: M, value: unknown): GoalDelegationParamsMap[M] {
  const prepares = method === 'goal.delegation.prepare' || method === 'goal.delegate'
  const p = record(value, prepares ? ['goalId', 'intent', 'materials'] : method === 'goal.report' ? ['goalId', 'operationId', 'report'] : method === 'goal.collect' ? ['goalId', 'operationId', 'collection'] : ['goalId'])
  return { goalId: id(p.goalId), ...(prepares ? { intent: parseDemandDelegationIntent(p.intent),
    ...(p.materials === undefined ? {} : { materials: Array.isArray(p.materials) ? p.materials.map(parseFileReadParams) : (() => { throw new AgentMuxError('Original materials must be exact File requests.', 'INVALID_CONTROL_REQUEST') })() }) }
    : method === 'goal.report' ? { operationId: id(p.operationId), report: parseDemandDelegationReportInput(p.report) }
    : method === 'goal.collect' ? { operationId: id(p.operationId), collection: parseDemandDelegationCollectionInput(p.collection) } : {}) } as GoalDelegationParamsMap[M]
}
export function parseGoalDelegationResult(value: unknown, input: { goalId: string }): GoalDelegationResult {
  const p = record(value, ['goalId', 'goalUpdatedAt', 'delegations', 'grounding', 'diskDurability', 'observations'])
  if (p.goalId !== input.goalId || p.diskDurability !== 'confirmed' || typeof p.goalUpdatedAt !== 'number' || !Number.isSafeInteger(p.goalUpdatedAt) || p.goalUpdatedAt <= 0) throw new AgentMuxError('The Goal delegation read belongs to another object or is unconfirmed.', 'CONTROL_PROTOCOL_ERROR')
  const delegations = parseDemandDelegations(p.delegations)
  const observations = p.observations === undefined ? undefined : (() => {
    if (!Array.isArray(p.observations)) throw new AgentMuxError('Delegation observations must refer to original intents.', 'CONTROL_PROTOCOL_ERROR')
    const seen = new Set<string>()
    return p.observations.map(value => {
      const item = record(value, ['operationId', 'communication', 'workerRun', 'unknown', 'recoverableReport', 'attention'])
      const operationId = id(item.operationId), delegation = delegations.find(d => d.operationId === operationId)
      if (!delegation || seen.has(operationId)) throw new AgentMuxError('An observation refers to another or duplicate delegation.', 'CONTROL_PROTOCOL_ERROR')
      seen.add(operationId)
      let workerRun: GoalDelegationObservation['workerRun']
      if (item.workerRun !== undefined) {
        const run = record(item.workerRun, ['runId', 'state'])
        if (run.runId !== delegation.workerRunId || !['running', 'exited', 'interrupted'].includes(String(run.state))) throw new AgentMuxError('Worker observation is not the original Run.', 'CONTROL_PROTOCOL_ERROR')
        workerRun = { runId: run.runId as string, state: run.state as AgentMuxRun['state'] }
      }
      const communication = item.communication === undefined ? undefined : parseRpcNativeResult('message.dispatch.read', item.communication,
        { sourceMessageId: delegation.sourceMessageId, hostId: delegation.hostId }) as unknown as DispatchObservation & { hostId: string }
      if (communication) assertGoalDelegationSource(delegation, communication.source)
      const recoverableReport = item.recoverableReport === undefined ? undefined : parseDemandDelegationReportInput(item.recoverableReport)
      if (recoverableReport) {
        const reply = communication?.replies.find(message => message.envelope.messageId === recoverableReport.replyMessageId)
        if (!reply ||
          goalDelegationReportBody(input.goalId, operationId, readGoalDelegationWireReport(input.goalId, delegation, reply)) !== goalDelegationReportBody(input.goalId, operationId, recoverableReport))
          throw new AgentMuxError('Recovered report differs from its actual original worker reply.', 'CONTROL_PROTOCOL_ERROR')
      }
      const attention = item.attention === undefined ? undefined : (() => {
        const a = record(item.attention, ['state', 'reason'])
        if (!delegation.attention || !['prepared', 'confirmed', 'unknown'].includes(String(a.state)))
          throw new AgentMuxError('Attention observation lacks its original reminder reference.', 'CONTROL_PROTOCOL_ERROR')
        return { state: a.state as 'prepared' | 'confirmed' | 'unknown', reason: id(a.reason) }
      })()
      return { operationId, ...(attention ? { attention } : {}), ...(recoverableReport ? { recoverableReport } : {}), ...(communication ? { communication } : {}), ...(workerRun ? { workerRun } : {}),
        ...(item.unknown === undefined ? {} : { unknown: id(item.unknown) }) }
    })
  })()
  return { goalId: input.goalId, goalUpdatedAt: p.goalUpdatedAt as number, delegations, diskDurability: 'confirmed',
    ...(p.grounding === undefined ? {} : { grounding: parseGrounding(p.grounding) }), ...(observations === undefined ? {} : { observations }) }
}

/** Stable wire encoding, distinct from display text and human acceptance. */
export function goalDelegationReportBody(goalId: string, operationId: string, report: DemandDelegationReportInput): string {
  return JSON.stringify({ schema: 'agentmux.goal-report.v1', goalId, delegationOperationId: operationId,
    report: { operationId: report.operationId, replyMessageId: report.replyMessageId, authorAgentSessionId: report.authorAgentSessionId, grounding: report.grounding } })
}
export function assertGoalDelegationSource(saved: DemandDelegation, message: DurableAgentMuxMessage): void {
  const envelope = message.envelope
  if (envelope.operationId !== saved.operationId || envelope.messageId !== saved.sourceMessageId ||
    envelope.sender.kind !== 'agent-session' || envelope.sender.agentSessionId !== saved.ownerAgentSessionId || envelope.senderSessionId !== saved.ownerAgentSessionId || envelope.senderRunId !== saved.ownerRunId ||
    envelope.recipient.kind !== 'agent-session' || envelope.recipient.agentSessionId !== saved.workerAgentSessionId || envelope.recipientSessionId !== saved.workerAgentSessionId || envelope.recipientRunId !== saved.workerRunId ||
    envelope.threadId !== saved.threadId || envelope.replyTo !== null || envelope.body !== saved.text)
    throw new AgentMuxError('The original Core source differs from the frozen Goal intent. The Agent remains available.', 'CONTROL_REQUEST_CONFLICT')
}
export function assertGoalDelegationReply(saved: DemandDelegation, report: DemandDelegationReportInput, message: DurableAgentMuxMessage, body: string): void {
  const envelope = message.envelope
  if (envelope.operationId !== report.operationId || envelope.messageId !== report.replyMessageId || envelope.sender.kind !== 'agent-session' ||
    envelope.sender.agentSessionId !== saved.workerAgentSessionId || envelope.senderSessionId !== saved.workerAgentSessionId ||
    envelope.recipient.kind !== 'agent-session' || envelope.recipient.agentSessionId !== saved.ownerAgentSessionId || envelope.recipientSessionId !== saved.ownerAgentSessionId ||
    envelope.replyTo !== saved.sourceMessageId || envelope.threadId !== saved.threadId || envelope.body !== body)
    throw new AgentMuxError('The actual worker reply differs from this original report. No result was collected or accepted.', 'CONTROL_REQUEST_CONFLICT')
}
export function readGoalDelegationWireReport(goalId: string, saved: DemandDelegation, reply: DurableAgentMuxMessage): DemandDelegationReportInput {
  let payload: unknown
  try { payload = JSON.parse(reply.envelope.body) } catch { throw new AgentMuxError('The original reply has no structured Goal report. Inspect its evidence in the original Agent.', 'CONTROL_PROTOCOL_ERROR') }
  const p = record(payload, ['schema', 'goalId', 'delegationOperationId', 'report'])
  if (p.schema !== 'agentmux.goal-report.v1' || p.goalId !== goalId || p.delegationOperationId !== saved.operationId)
    throw new AgentMuxError('The structured report refers to another original Goal or delegation.', 'CONTROL_PROTOCOL_ERROR')
  const report = parseDemandDelegationReportInput(p.report)
  validateDemandDelegationReport(saved, report)
  assertGoalDelegationReply(saved, report, reply, goalDelegationReportBody(goalId, saved.operationId, report))
  return report
}
