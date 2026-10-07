import { parseDemandPatrols, parseDemandPatrolReportInput, type DemandPatrol, type DemandPatrolReportInput } from '@agentmux/demand'
import { parseGoalPatrolObservations, type GoalPatrolObservation } from './goal-patrol.js'
import { type GoalDelegationMethod } from './goal-delegation-methods.js'
export { GOAL_DELEGATION_METHODS, isGoalDelegationMethod, type GoalDelegationMethod } from './goal-delegation-methods.js'
import { validateAgentPromptInputKey } from './agent-prompt-condition.js'
import { parseDemandDispatches, type DemandDispatch, type GoalStartObservation } from '@agentmux/demand'
import { parseFileReadParams, type FileReadParams } from './public-rpc-files.js'
import { parseDemandDelegationIntent, parseDemandDelegations, parseDemandDelegationReportInput, parseDemandDelegationCollectionInput, validateDemandDelegationReport } from '@agentmux/demand/delegations'
import { parseAlignment, parseGrounding } from '@agentmux/demand/goals'
import type { DemandDelegation, DemandDelegationIntent, DemandDelegationReportInput, DemandDelegationCollectionInput } from '@agentmux/demand/delegations'
import type { DemandGrounding } from '@agentmux/demand/goals'
import { parseRpcNativeResult } from './rpc-native-codec.js'
import type { AgentMuxRun } from './types.js'
import type { DurableAgentMuxMessage } from './agent-global-message-queue.js'
import type { DispatchObservation } from './agent-handoff.js'
import { AgentMuxError } from './errors.js'
import { demandExecutionReferences, parseDemandProgressInput, parseDemandProgressUpdates, type DemandProgress, type DemandProgressInput } from '@agentmux/demand'
import { parseGoalResponsibility, type GoalResponsibilityObservation } from './goal-responsibility.js'
import type { AgentMuxRpcCallContext } from './public-rpc-service.js'

/** Goal owns business intent and reports; this port never owns a message queue. */
export type GoalDelegationParamsMap = {
  'goal.delegation.prepare': { goalId: string; intent: DemandDelegationIntent; materials?: FileReadParams[] }
  'goal.delegation.bind': { goalId: string; intent: DemandDelegationIntent }
  'goal.delegate': { goalId: string; intent: DemandDelegationIntent; materials?: FileReadParams[] }
  'goal.report': { goalId: string; operationId: string; report: DemandDelegationReportInput }
  'goal.collect': { goalId: string; operationId: string; collection: DemandDelegationCollectionInput }
  'goal.delegations': { goalId: string }
  'goal.progress': { goalId: string; progress: DemandProgressInput }
  'goal.patrol': { goalId: string; operationId: string }
  'goal.patrol.continue': { goalId: string; patrolOperationId: string; operationId: string; expectedRunId: string }
  'goal.patrol.report': { goalId: string; patrolOperationId: string; report: DemandPatrolReportInput }
}
export type GoalDelegationObservation = { operationId: string; communication?: DispatchObservation & { hostId: string }; workerRun?: Pick<AgentMuxRun, 'runId' | 'state'>; unknown?: string; recoverableReport?: DemandDelegationReportInput; attention?: { state: 'prepared' | 'confirmed' | 'unknown'; reason: string } }
export type GoalDelegationResult = { goalId: string; goalUpdatedAt: number; delegations: DemandDelegation[]; grounding?: DemandGrounding; diskDurability: 'confirmed'; observations?: GoalDelegationObservation[]; dispatches?: DemandDispatch[]; startObservations?: GoalStartObservation[]; progressUpdates?: DemandProgress[]; responsibility?: GoalResponsibilityObservation; patrols?: DemandPatrol[]; patrolObservations?: GoalPatrolObservation[]; goalState?: { status: import('@agentmux/demand').DemandStatus; supervisorSessionId: string | null; alignment?: import('@agentmux/demand').DemandAlignment } }
export type GoalDelegationResultMap = { [M in GoalDelegationMethod]: GoalDelegationResult }
/** Supplied after transport/Core caller admission, never from an editable business payload. */
export type GoalDelegationAuthority = { actor: { kind: 'agent' | 'user' | 'device'; id: string }; hostId?: string; runId?: string }
export interface GoalDelegationsOwner {
  call<M extends GoalDelegationMethod>(method: M, input: GoalDelegationParamsMap[M], context: AgentMuxRpcCallContext,
    authority: GoalDelegationAuthority): Promise<GoalDelegationResultMap[M]>
}
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
  if (method === 'goal.patrol' || method === 'goal.patrol.continue' || method === 'goal.patrol.report') {
    const p = record(value, method === 'goal.patrol' ? ['goalId', 'operationId'] : method === 'goal.patrol.continue' ? ['goalId', 'patrolOperationId', 'operationId', 'expectedRunId'] : ['goalId', 'patrolOperationId', 'report'])
    return { goalId: id(p.goalId), ...(method === 'goal.patrol.report' ? { patrolOperationId: id(p.patrolOperationId), report: parseDemandPatrolReportInput(p.report) }
      : { operationId: id(p.operationId), ...(method === 'goal.patrol.continue' ? { patrolOperationId: id(p.patrolOperationId), expectedRunId: id(p.expectedRunId) } : {}) }) } as GoalDelegationParamsMap[M]
  }
  const prepares = method === 'goal.delegation.prepare' || method === 'goal.delegate' || method === 'goal.delegation.bind'
  const p = record(value, prepares ? method === 'goal.delegation.bind' ? ['goalId', 'intent'] : ['goalId', 'intent', 'materials'] : method === 'goal.report' ? ['goalId', 'operationId', 'report'] : method === 'goal.collect' ? ['goalId', 'operationId', 'collection'] : method === 'goal.progress' ? ['goalId', 'progress'] : ['goalId'])
  return { goalId: id(p.goalId), ...(prepares ? { intent: parseDemandDelegationIntent(p.intent),
    ...(p.materials === undefined ? {} : { materials: Array.isArray(p.materials) ? p.materials.map(parseFileReadParams) : (() => { throw new AgentMuxError('Original materials must be exact File requests.', 'INVALID_CONTROL_REQUEST') })() }) }
    : method === 'goal.progress' ? { progress: parseDemandProgressInput(p.progress) }
    : method === 'goal.report' ? { operationId: id(p.operationId), report: parseDemandDelegationReportInput(p.report) }
    : method === 'goal.collect' ? { operationId: id(p.operationId), collection: parseDemandDelegationCollectionInput(p.collection) } : {}) } as GoalDelegationParamsMap[M]
}
export function parseGoalDelegationResult(value: unknown, input: { goalId: string }): GoalDelegationResult {
  const p = record(value, ['goalId', 'goalUpdatedAt', 'delegations', 'grounding', 'diskDurability', 'observations', 'dispatches', 'startObservations', 'progressUpdates', 'responsibility', 'patrols', 'patrolObservations', 'goalState'])
  if (p.goalId !== input.goalId || p.diskDurability !== 'confirmed' || typeof p.goalUpdatedAt !== 'number' || !Number.isSafeInteger(p.goalUpdatedAt) || p.goalUpdatedAt <= 0) throw new AgentMuxError('The Goal delegation read belongs to another object or is unconfirmed.', 'CONTROL_PROTOCOL_ERROR')
  const goalState = p.goalState === undefined ? undefined : (() => {
    const state = record(p.goalState, ['status', 'supervisorSessionId', 'alignment'])
    if (!['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'].includes(String(state.status))) throw new AgentMuxError('Invalid original Goal business state.', 'CONTROL_PROTOCOL_ERROR')
    return { status: state.status as import('@agentmux/demand').DemandStatus, supervisorSessionId: state.supervisorSessionId === null ? null : id(state.supervisorSessionId), ...(state.alignment === undefined ? {} : { alignment: parseAlignment(state.alignment) }) }
  })()
  const patrols = p.patrols === undefined ? undefined : parseDemandPatrols(p.patrols)
  const patrolObservations = p.patrolObservations === undefined ? undefined : parseGoalPatrolObservations(p.patrolObservations, (patrols ?? []).map(p => p.operationId))
  const delegations = parseDemandDelegations(p.delegations)
  const dispatches = p.dispatches === undefined ? undefined : parseDemandDispatches(p.dispatches)
  const startObservations = p.startObservations === undefined ? undefined : parseGoalStartObservations(p.startObservations, dispatches ?? [], p.grounding)
  const progressUpdates = p.progressUpdates === undefined ? undefined : parseDemandProgressUpdates(p.progressUpdates)
  const responsibility = p.responsibility === undefined ? undefined : parseGoalResponsibility(p.responsibility, demandExecutionReferences({ ...(dispatches ? { dispatches } : {}), delegations }))
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
    ...(dispatches ? { dispatches } : {}), ...(startObservations ? { startObservations } : {}),
    ...(goalState ? { goalState } : {}), ...(patrols ? { patrols } : {}), ...(patrolObservations ? { patrolObservations } : {}),
    ...(progressUpdates ? { progressUpdates } : {}), ...(responsibility ? { responsibility } : {}),
    ...(p.grounding === undefined ? {} : { grounding: parseGrounding(p.grounding) }), ...(observations === undefined ? {} : { observations }) }
}

/** Stable wire encoding, distinct from display text and human acceptance. */
export function goalDelegationReportBody(goalId: string, operationId: string, report: DemandDelegationReportInput): string {
  return JSON.stringify({ schema: 'agentmux.goal-report.v1', goalId, delegationOperationId: operationId,
    report: { operationId: report.operationId, replyMessageId: report.replyMessageId, authorAgentSessionId: report.authorAgentSessionId, grounding: report.grounding } })
}
export function assertGoalDelegationSource(saved: DemandDelegationIntent, message: DurableAgentMuxMessage): void {
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

export function parseGoalStartObservations(value: unknown, starts: readonly DemandDispatch[], grounding: unknown): GoalStartObservation[] {
  if (!Array.isArray(value)) throw new AgentMuxError('Original Start observations must be an array.', 'CONTROL_PROTOCOL_ERROR')
  const seen = new Set<string>()
  return value.map(raw => {
    const item = record(raw, ['operationId', 'input', 'originalRun', 'goalResult', 'responsibility', 'supervisor', 'attention', 'unknown'])
    const operationId = id(item.operationId), start = starts.find(entry => entry.operationId === operationId)
    if (!start || start.execution !== 'finite' || seen.has(operationId)) throw new AgentMuxError('An observation does not belong to this original finite Start.', 'CONTROL_PROTOCOL_ERROR')
    seen.add(operationId)
    const input = record(item.input, ['state', 'reason', 'retainedReceipt', 'proof'])
    if (!['confirmed', 'unknown'].includes(String(input.state))) throw new AgentMuxError('Start input state is invalid.', 'CONTROL_PROTOCOL_ERROR')
    if (input.retainedReceipt !== undefined) {
      const receipt = record(input.retainedReceipt, ['kind', 'itemId', 'createdAt'])
      if (!start.receipt || receipt.kind !== start.receipt.kind || receipt.itemId !== start.receipt.itemId || receipt.createdAt !== start.receipt.createdAt)
        throw new AgentMuxError('The retained receipt does not belong to this original Start.', 'CONTROL_PROTOCOL_ERROR')
    }
    const proof = input.proof === undefined ? undefined : (() => {
      const value = record(input.proof, ['kind', 'agentSessionId', 'runId', 'operationId', 'acknowledged', 'prompt', 'inputKey'])
      const key = validateAgentPromptInputKey(value.inputKey)
      if (value.kind !== 'core-prompt' || value.agentSessionId !== start.agentSessionId || value.runId !== start.runId ||
        value.operationId !== start.operationId || value.acknowledged !== true || value.prompt !== start.prompt || key.kind !== 'prompt' ||
        key.agentSessionId !== start.agentSessionId || key.expectedRun.runId !== start.runId || key.submissionId !== start.operationId)
        throw new AgentMuxError('The actual Core input proof is not this original Start.', 'CONTROL_PROTOCOL_ERROR')
      return { kind: 'core-prompt' as const, agentSessionId: start.agentSessionId, runId: start.runId, operationId: start.operationId,
        acknowledged: true as const, prompt: start.prompt, inputKey: key }
    })()
    if ((input.state === 'confirmed') !== Boolean(proof)) throw new AgentMuxError('Confirmed Start input requires its original Core proof.', 'CONTROL_PROTOCOL_ERROR')
    const originalRun = item.originalRun === undefined ? undefined : (() => {
      const run = record(item.originalRun, ['runId', 'state'])
      if (run.runId !== start.runId || !['running', 'exited', 'interrupted'].includes(String(run.state))) throw new AgentMuxError('The observed Run is not this original Start.', 'CONTROL_PROTOCOL_ERROR')
      return { runId: start.runId, state: run.state as 'running' | 'exited' | 'interrupted' }
    })()
    const goalResult = item.goalResult === undefined ? undefined : (() => {
      const result = record(item.goalResult, ['grounding', 'association', 'basis', 'changedSinceStart'])
      const actual = parseGrounding(result.grounding), retained = parseGrounding(grounding)
      if (result.association !== 'unknown' || result.basis !== (start.resultBasis ? 'captured' : 'unknown') ||
        result.changedSinceStart !== (start.resultBasis ? retained.submissionId !== start.resultBasis.groundingSubmissionId : null) ||
        JSON.stringify(actual) !== JSON.stringify(retained)) throw new AgentMuxError('Goal-level results cannot become a worker report or another result.', 'CONTROL_PROTOCOL_ERROR')
      return { grounding: actual, association: 'unknown' as const, basis: result.basis as 'captured' | 'unknown', changedSinceStart: result.changedSinceStart as boolean | null }
    })()
    if (!['working', 'original-worker-continuation', 'goal-result-review', 'observation-unknown'].includes(String(item.responsibility)))
      throw new AgentMuxError('Original Start responsibility is invalid.', 'CONTROL_PROTOCOL_ERROR')
    if (item.responsibility === 'working' && (originalRun?.state !== 'running' || input.state !== 'confirmed') ||
      item.responsibility === 'original-worker-continuation' && originalRun?.state !== 'exited' && originalRun?.state !== 'interrupted' ||
      item.responsibility === 'goal-result-review' && (!goalResult || goalResult.changedSinceStart !== true))
      throw new AgentMuxError('Start responsibility contradicts its original facts.', 'CONTROL_PROTOCOL_ERROR')
    const supervisor = item.supervisor === undefined ? undefined : (() => {
      const target = record(item.supervisor, ['agentSessionId', 'hostId', 'runId']), attention = start.attention
      if (!attention || target.agentSessionId !== attention.supervisorAgentSessionId || target.hostId !== start.hostId || target.runId !== attention.supervisorRunId)
        throw new AgentMuxError('The Start notice belongs to another Supervisor input.', 'CONTROL_PROTOCOL_ERROR')
      return { agentSessionId: id(target.agentSessionId), hostId: id(target.hostId), runId: id(target.runId) }
    })()
    const attention = item.attention === undefined ? undefined : (() => {
      const notice = record(item.attention, ['state', 'reason'])
      if (!start.attention || !supervisor || !['prepared', 'confirmed', 'unknown'].includes(String(notice.state))) throw new AgentMuxError('Start notice has no original reference.', 'CONTROL_PROTOCOL_ERROR')
      return { state: notice.state as 'prepared' | 'confirmed' | 'unknown', reason: id(notice.reason) }
    })()
    return { operationId, input: { state: input.state as 'confirmed' | 'unknown', ...(input.reason === undefined ? {} : { reason: id(input.reason) }),
      ...(input.retainedReceipt === undefined ? {} : { retainedReceipt: start.receipt! }), ...(proof ? { proof } : {}) }, responsibility: item.responsibility as GoalStartObservation['responsibility'],
      ...(originalRun ? { originalRun } : {}), ...(goalResult ? { goalResult } : {}), ...(supervisor ? { supervisor } : {}), ...(attention ? { attention } : {}),
      ...(item.unknown === undefined ? {} : { unknown: id(item.unknown) }) }
  })
}
