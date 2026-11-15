import { isObjectId } from '@agentmux/identity'
import { parseGoalAgentReference } from './goal-agent-reference.js'
import { parseDemandPatrols, parseDemandPatrolReportInput, type DemandPatrol, type DemandPatrolReportInput } from '@agentmux/demand'
import { parseGoalPatrolObservations, type GoalPatrolObservation } from './goal-patrol.js'
import { type GoalDelegationMethod } from './goal-delegation-methods.js'
export { GOAL_DELEGATION_METHODS, isGoalDelegationMethod, type GoalDelegationMethod } from './goal-delegation-methods.js'
import { validateAgentPromptInputKey } from './agent-prompt-condition.js'
import { parseDemandDispatch, parseDemandDispatches, runBoundDemandDispatch, type DemandDispatch, type GoalStartObservation } from '@agentmux/demand'
import { parseFileReadParams, type FileReadParams } from './public-rpc-files.js'
import { parseDemandDelegationIntent, parseDemandDelegations, parseDemandDelegationReportInput, parseDemandDelegationCollectionInput, parseGoalPlanPredecessors, sameGoalPlanPredecessors, validateDemandDelegationReport } from '@agentmux/demand/delegations'
import { parseAlignment, parseGrounding } from '@agentmux/demand/goals'
import { GOAL_PLAN_UNKNOWN_REASONS, parseGoalPlanAssignment, type GoalPlanAssignment, parseGoalPlan, parseGoalPlanReviewInput, parseGoalPlanRevisionInput, type GoalPlan, type GoalPlanReviewInput, type GoalPlanRevisionInput, type GoalPlanState } from '@agentmux/demand/goal-plan'
import { parseOwnerGoalPlanState } from './goal-plan-state.js'
import type { DemandDelegation, DemandDelegationIntent, DemandDelegationReportInput, DemandDelegationCollectionInput } from '@agentmux/demand/delegations'
import type { DemandGrounding } from '@agentmux/demand/goals'
import { parseRpcNativeResult } from './rpc-native-codec.js'
import type { AgentMuxRun } from './types.js'
import type { DurableAgentMuxMessage } from './agent-global-message-queue.js'
import type { DispatchObservation } from './agent-handoff.js'
import { AgentMuxError } from './errors.js'
import { parseGoalAddress, formatGoalTicketLink, type AmuxGoalAddress } from './sharing.js'
import { demandExecutionReferences, parseDemandProgressInput, parseDemandProgressUpdates, type DemandProgress, type DemandProgressInput } from '@agentmux/demand'
import { parseGoalResponsibility, type GoalResponsibilityObservation } from './goal-responsibility.js'
import type { AgentMuxRpcCallContext } from './public-rpc-service.js'
import type { AgentMuxRpcResult } from './public-rpc.js'
import { goalDelegationReportBody, goalReportApplication, readGoalDelegationSource, readGoalReportApplication } from './goal-delegation-source.js'
export { goalDelegationReportBody, goalDelegationApplication, goalReportApplication, readGoalDelegationSource, readGoalReportApplication, assertGoalSourceReport } from './goal-delegation-source.js'
export type { GoalDelegationSourceData } from './goal-delegation-source.js'

type GoalPlanTarget = { goalId: string; expectedOwner?: Pick<import('./sharing.js').AmuxGoalAddress, 'runtimeId' | 'namespace'> }
export type GoalActivePlanQuery = { goalId?: string; view: 'claimable' | 'manage'; expectedOwner?: import('@agentmux/demand/goal-plan').GoalPlanOwner }
export type GoalActivePlanResult = {
  owner: import('@agentmux/demand/goal-plan').GoalPlanOwner
  view: GoalActivePlanQuery['view']
  goals: { goalId: string; goalUpdatedAt: number; nodes: (Omit<import('@agentmux/demand').GoalActiveNode, 'claim'> & { claimToken?: string })[] }[]
}
type GoalPlanNodeWrite = GoalPlanTarget & { nodeId: string; operationId: string }

/** Goal owns business intent and reports; this port never owns a message queue. */
export type GoalDelegationParamsMap = {
  'goal.delegation.prepare': { goalId: string; intent: DemandDelegationIntent; materials?: FileReadParams[] }
  'goal.delegation.bind': { goalId: string; intent: DemandDelegationIntent }
  'goal.delegate': { goalId: string; intent: DemandDelegationIntent; materials?: FileReadParams[] }
  'goal.report': { goalId: string; operationId: string; sourceMessageId?: string; report: DemandDelegationReportInput }
  'goal.collect': { goalId: string; operationId: string; collection: DemandDelegationCollectionInput }
  'goal.delegations': { goalId: string }
  'goal.progress': { goalId: string; progress: DemandProgressInput }
  'goal.patrol': { goalId: string; operationId: string }
  'goal.patrol.continue': { goalId: string; patrolOperationId: string; operationId: string; expectedRunId: string }
  'goal.patrol.report': { goalId: string; patrolOperationId: string; report: DemandPatrolReportInput }
  'goal.plan': GoalPlanTarget
  'goal.plan.active': GoalActivePlanQuery
  'goal.plan.assignment': GoalPlanNodeWrite & { expectedRevision: number; assignment: GoalPlanAssignment }
  'goal.plan.claim': GoalPlanNodeWrite & { claimToken: string }
  'goal.plan.revise': { goalId: string; revision: GoalPlanRevisionInput }
  'goal.plan.review': { goalId: string; review: GoalPlanReviewInput }
}
export type GoalDelegationObservation = { operationId: string; communication?: DispatchObservation & { hostId: string }; workerRun?: Pick<AgentMuxRun, 'runId' | 'state'>; unknown?: string; recoverableReport?: DemandDelegationReportInput; attention?: { state: 'prepared' | 'confirmed' | 'unknown'; reason: string } }
/** `planState` is the Goal owner's derivation of `plan`; a reader keeps the owner's rules and checks only that it describes this plan and these delegations. */
export type GoalDelegationResult = { goalId: string; goalUpdatedAt: number; delegations: DemandDelegation[]; address?: AmuxGoalAddress; ticketLinks?: string[]; plan?: GoalPlan; planState?: GoalPlanState; planStateIssue?: string; grounding?: DemandGrounding; diskDurability: 'confirmed'; observations?: GoalDelegationObservation[]; dispatches?: DemandDispatch[]; startObservations?: GoalStartObservation[]; progressUpdates?: DemandProgress[]; responsibility?: GoalResponsibilityObservation; patrols?: DemandPatrol[]; patrolObservations?: GoalPatrolObservation[]; goalState?: { status: import('@agentmux/demand').DemandStatus; supervisorSessionId: import('@agentmux/demand/relations').DemandAgentReference | null; alignment?: import('@agentmux/demand').DemandAlignment } }
/** The worker submits a message at its own Core; it does not attest an update to the owner Goal. */
export type GoalReportSubmissionResult = { kind: 'report-submission'; goalId: string; delegationOperationId: string;
  sourceMessageId: string; submission: AgentMuxRpcResult<'agent.send'> }
export type GoalReportResult = GoalDelegationResult | GoalReportSubmissionResult
export type GoalDelegationResultMap = { [M in GoalDelegationMethod]: M extends 'goal.plan.active' ? GoalActivePlanResult : M extends 'goal.report' ? GoalReportResult : GoalDelegationResult }
/** Supplied after transport/Core caller admission, never from an editable business payload. */
export type GoalDelegationAuthority = { actor: { kind: 'agent' | 'user' | 'device'; id: string }; hostId?: string; runId?: string; runtimeId?: string }
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
  if (method === 'goal.plan.active') {
    const p = record(value, ['goalId', 'view', 'expectedOwner'])
    const goalId = p.goalId === undefined ? undefined : id(p.goalId)
    if (p.view !== 'claimable' && p.view !== 'manage' || p.view === 'manage' && !goalId)
      throw new AgentMuxError('Choose claimable work or one exact Goal for management.', 'INVALID_CONTROL_REQUEST')
    const owner = p.expectedOwner === undefined ? undefined : record(p.expectedOwner, ['runtimeId', 'namespace'])
    return { ...(goalId ? { goalId } : {}), view: p.view,
      ...(owner ? { expectedOwner: { runtimeId: id(owner.runtimeId), namespace: id(owner.namespace) } } : {}) } as GoalDelegationParamsMap[M]
  }
  if (method === 'goal.patrol' || method === 'goal.patrol.continue' || method === 'goal.patrol.report') {
    const p = record(value, method === 'goal.patrol' ? ['goalId', 'operationId'] : method === 'goal.patrol.continue' ? ['goalId', 'patrolOperationId', 'operationId', 'expectedRunId'] : ['goalId', 'patrolOperationId', 'report'])
    return { goalId: id(p.goalId), ...(method === 'goal.patrol.report' ? { patrolOperationId: id(p.patrolOperationId), report: parseDemandPatrolReportInput(p.report) }
      : { operationId: id(p.operationId), ...(method === 'goal.patrol.continue' ? { patrolOperationId: id(p.patrolOperationId), expectedRunId: id(p.expectedRunId) } : {}) }) } as GoalDelegationParamsMap[M]
  }
  if (method === 'goal.plan' || method === 'goal.plan.assignment' || method === 'goal.plan.claim') {
    const keys = ['goalId', 'expectedOwner']
    if (method !== 'goal.plan') keys.push('nodeId', 'operationId')
    if (method === 'goal.plan.assignment') keys.push('expectedRevision', 'assignment')
    if (method === 'goal.plan.claim') keys.push('claimToken')
    const p = record(value, keys)
    const target: GoalPlanTarget = { goalId: id(p.goalId) }
    if (p.expectedOwner !== undefined) {
      const owner = record(p.expectedOwner, ['runtimeId', 'namespace'])
      target.expectedOwner = { runtimeId: id(owner.runtimeId), namespace: id(owner.namespace) }
    }
    if (method === 'goal.plan') return target as GoalDelegationParamsMap[M]
    const node = { ...target, nodeId: id(p.nodeId), operationId: id(p.operationId) }
    if (method === 'goal.plan.claim') return { ...node, claimToken: id(p.claimToken) } as GoalDelegationParamsMap[M]
    if (typeof p.expectedRevision !== 'number' || !Number.isSafeInteger(p.expectedRevision) || p.expectedRevision < 1)
      throw new AgentMuxError('Read the original saved plan and supply its positive revision.', 'INVALID_CONTROL_REQUEST')
    try {
      return { ...node, expectedRevision: p.expectedRevision, assignment: parseGoalPlanAssignment(p.assignment) } as GoalDelegationParamsMap[M]
    } catch (error) {
      throw new AgentMuxError(error instanceof Error ? error.message : String(error), 'INVALID_CONTROL_REQUEST')
    }
  }
  if (method === 'goal.plan.revise' || method === 'goal.plan.review') {
    const p = record(value, method === 'goal.plan.revise' ? ['goalId', 'revision'] : ['goalId', 'review'])
    try {
      return { goalId: id(p.goalId), ...(method === 'goal.plan.revise' ? { revision: parseGoalPlanRevisionInput(p.revision) } : method === 'goal.plan.review' ? { review: parseGoalPlanReviewInput(p.review) } : {}) } as GoalDelegationParamsMap[M]
    } catch (error) {
      if (error instanceof AgentMuxError) throw error
      throw new AgentMuxError(error instanceof Error ? error.message : String(error), 'INVALID_CONTROL_REQUEST')
    }
  }
  const prepares = method === 'goal.delegation.prepare' || method === 'goal.delegate' || method === 'goal.delegation.bind'
  const p = record(value, prepares ? method === 'goal.delegation.bind' ? ['goalId', 'intent'] : ['goalId', 'intent', 'materials'] : method === 'goal.report' ? ['goalId', 'operationId', 'sourceMessageId', 'report'] : method === 'goal.collect' ? ['goalId', 'operationId', 'collection'] : method === 'goal.progress' ? ['goalId', 'progress'] : ['goalId'])
  return { goalId: id(p.goalId), ...(prepares ? { intent: parseDemandDelegationIntent(p.intent),
    ...(p.materials === undefined ? {} : { materials: Array.isArray(p.materials) ? p.materials.map(parseFileReadParams) : (() => { throw new AgentMuxError('Original materials must be exact File requests.', 'INVALID_CONTROL_REQUEST') })() }) }
    : method === 'goal.progress' ? { progress: parseDemandProgressInput(p.progress) }
    : method === 'goal.report' ? { operationId: id(p.operationId), report: parseDemandDelegationReportInput(p.report), ...(p.sourceMessageId === undefined ? {} : { sourceMessageId: id(p.sourceMessageId) }) }
    : method === 'goal.collect' ? { operationId: id(p.operationId), collection: parseDemandDelegationCollectionInput(p.collection) } : {}) } as GoalDelegationParamsMap[M]
}
export function parseGoalDelegationRpcResult<M extends GoalDelegationMethod>(method: M, value: unknown, input: GoalDelegationParamsMap[M]): GoalDelegationResultMap[M] {
  if (method === 'goal.plan.active') return parseGoalActivePlanResult(value, input as GoalActivePlanQuery) as GoalDelegationResultMap[M]
  const request = input as GoalDelegationParamsMap['goal.report']
  if (method === 'goal.report' && request.sourceMessageId !== undefined) {
    const p = record(value, ['kind', 'goalId', 'delegationOperationId', 'sourceMessageId', 'submission'])
    if (p.kind !== 'report-submission' || p.goalId !== request.goalId || p.delegationOperationId !== request.operationId || p.sourceMessageId !== request.sourceMessageId)
      throw new AgentMuxError('The report submission belongs to another original source.', 'CONTROL_PROTOCOL_ERROR')
    const submission = parseRpcNativeResult('agent.send', p.submission, { target: { kind: 'reply', sourceMessageId: request.sourceMessageId },
      operationId: request.report.operationId, messageId: request.report.replyMessageId, text: goalDelegationReportBody(request.goalId, request.operationId, request.report),
      application: goalReportApplication(request.goalId, request.operationId, request.report) }) as unknown as AgentMuxRpcResult<'agent.send'>
    const envelope = submission.envelope
    if (envelope.messageId !== request.report.replyMessageId || envelope.operationId !== request.report.operationId || envelope.replyTo !== request.sourceMessageId ||
        envelope.correlationId !== request.sourceMessageId || envelope.sender.kind !== 'agent-session' || envelope.senderSessionId !== request.report.authorAgentSessionId ||
        envelope.body !== goalDelegationReportBody(request.goalId, request.operationId, request.report) ||
        goalDelegationReportBody(request.goalId, request.operationId, readGoalReportApplication(submission, request.goalId, request.operationId)) !== goalDelegationReportBody(request.goalId, request.operationId, request.report))
      throw new AgentMuxError('The original message receipt differs from this worker report. No Goal update was attested.', 'CONTROL_PROTOCOL_ERROR')
    return { kind: 'report-submission', goalId: request.goalId, delegationOperationId: request.operationId,
      sourceMessageId: request.sourceMessageId, submission } as GoalDelegationResultMap[M]
  }
  const result = parseGoalDelegationResult(value, input as { goalId: string })
  if (method === 'goal.plan.assignment' || method === 'goal.plan.claim') {
    const { plan } = result
    const write = input as GoalDelegationParamsMap['goal.plan.assignment' | 'goal.plan.claim']
    const requested = 'assignment' in write ? write.assignment : { kind: 'claim' as const }
    const saved = 'claimToken' in write ? plan?.history.find(item => item.operationId === write.operationId && item.claim?.token === write.claimToken)
      : plan?.history[write.expectedRevision]
    const action = saved?.change?.assignment
    if (!plan || !saved || saved.operationId !== write.operationId || saved.change?.nodeId !== write.nodeId ||
        action?.kind !== requested.kind || (action.kind === 'assign' && requested.kind === 'assign' &&
          (action.executor.hostId !== requested.executor.hostId || action.executor.agentSessionId !== requested.executor.agentSessionId)) ||
        (action.kind === 'claim' && (saved.author.kind !== 'agent' || !saved.author.hostId || !saved.author.runtimeId)))
      throw new AgentMuxError('The saved plan did not confirm this original node operation. Read its plan history.', 'CONTROL_PROTOCOL_ERROR')
    if (saved.revision === plan.revision) {
      const node = plan.nodes.find(node => node.id === write.nodeId)
      const executor = action.kind === 'claim' ? { hostId: saved.author.hostId, agentSessionId: saved.author.id }
        : action.kind === 'assign' ? action.executor : null
      if (!node || Boolean(node.claimOpen) !== (action.kind === 'open') ||
          (executor ? node.executor?.hostId !== executor.hostId || node.executor?.agentSessionId !== executor.agentSessionId : node.executor !== null))
        throw new AgentMuxError('The saved node differs from its original assignment receipt. Read the current plan.', 'CONTROL_PROTOCOL_ERROR')
    }
  }
  return result as GoalDelegationResultMap[M]
}
function parseGoalActivePlanResult(value: unknown, input: GoalActivePlanQuery): GoalActivePlanResult {
  const invalid = () => { throw new AgentMuxError('The active Goal receipt did not confirm the exact requested scope and nodes.', 'CONTROL_PROTOCOL_ERROR') }
  const p = record(value, ['owner', 'view', 'goals']), coordinates = record(p.owner, ['runtimeId', 'namespace'])
  const owner = { runtimeId: id(coordinates.runtimeId), namespace: id(coordinates.namespace) }
  if (p.view !== input.view || input.expectedOwner && (owner.runtimeId !== input.expectedOwner.runtimeId || owner.namespace !== input.expectedOwner.namespace) ||
      !Array.isArray(p.goals)) return invalid()
  const goalIds = new Set<string>()
  const goals = p.goals.map(value => {
    const summary = record(value, ['goalId', 'goalUpdatedAt', 'nodes'])
    const goalId = id(summary.goalId), goalUpdatedAt = summary.goalUpdatedAt
    if (goalIds.has(goalId) || input.goalId !== undefined && goalId !== input.goalId ||
        typeof goalUpdatedAt !== 'number' || !Number.isSafeInteger(goalUpdatedAt) || goalUpdatedAt < 1 || !Array.isArray(summary.nodes)) return invalid()
    goalIds.add(goalId)
    const nodeIds = new Set<string>()
    const nodes = summary.nodes.map(value => {
      const node = record(value, ['nodeId', 'title', 'state', 'attemptOperationId', 'unknown', 'predecessors', 'claimToken'])
      const nodeId = id(node.nodeId)
      if (nodeIds.has(nodeId) || !['ready', 'working', 'review', 'changes', 'unknown'].includes(String(node.state)) ||
          (input.view === 'claimable' ? node.state !== 'ready' || !isObjectId(node.claimToken) : node.claimToken !== undefined) ||
          !Array.isArray(node.unknown) || node.unknown.some(reason => !GOAL_PLAN_UNKNOWN_REASONS.includes(reason)) ||
          typeof node.title !== 'string' || !node.title.trim())
        return invalid()
      nodeIds.add(nodeId)
      return {
        nodeId, title: node.title, state: node.state as import('@agentmux/demand').GoalActiveNode['state'], unknown: node.unknown as import('@agentmux/demand').GoalActiveNode['unknown'],
        predecessors: node.predecessors === null ? null : parseGoalPlanPredecessors(node.predecessors),
        ...(node.attemptOperationId === undefined ? {} : { attemptOperationId: id(node.attemptOperationId) }),
        ...(typeof node.claimToken === 'string' ? { claimToken: node.claimToken } : {})
      }
    })
    return { goalId, goalUpdatedAt, nodes }
  })
  return { owner, view: input.view, goals }
}

export function parseGoalDelegationResult(value: unknown, input: { goalId: string }): GoalDelegationResult {
  const p = record(value, ['goalId', 'goalUpdatedAt', 'delegations', 'address', 'ticketLinks', 'plan', 'planState', 'planStateIssue', 'grounding', 'diskDurability', 'observations', 'dispatches', 'startObservations', 'progressUpdates', 'responsibility', 'patrols', 'patrolObservations', 'goalState'])
  if (p.goalId !== input.goalId || p.diskDurability !== 'confirmed' || typeof p.goalUpdatedAt !== 'number' || !Number.isSafeInteger(p.goalUpdatedAt) || p.goalUpdatedAt <= 0) throw new AgentMuxError('The Goal delegation read belongs to another object or is unconfirmed.', 'CONTROL_PROTOCOL_ERROR')
  const goalState = p.goalState === undefined ? undefined : (() => {
    const state = record(p.goalState, ['status', 'supervisorSessionId', 'alignment'])
    if (!['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'].includes(String(state.status))) throw new AgentMuxError('Invalid original Goal business state.', 'CONTROL_PROTOCOL_ERROR')
    return { status: state.status as import('@agentmux/demand').DemandStatus, supervisorSessionId: state.supervisorSessionId === null ? null : parseGoalAgentReference(state.supervisorSessionId, 'CONTROL_PROTOCOL_ERROR'), ...(state.alignment === undefined ? {} : { alignment: parseAlignment(state.alignment) }) }
  })()
  const patrols = p.patrols === undefined ? undefined : parseDemandPatrols(p.patrols)
  const patrolObservations = p.patrolObservations === undefined ? undefined : parseGoalPatrolObservations(p.patrolObservations, (patrols ?? []).map(p => p.operationId))
  const delegations = parseDemandDelegations(p.delegations)
  const plan = p.plan === undefined ? undefined : (() => { try { return parseGoalPlan(p.plan) } catch (error) { throw new AgentMuxError(error instanceof Error ? error.message : String(error), 'CONTROL_PROTOCOL_ERROR') } })()
  let address: AmuxGoalAddress | undefined, ticketLinks: string[] | undefined
  if (p.address !== undefined || p.ticketLinks !== undefined) {
    try {
      const parsed = parseGoalAddress(p.address, input.goalId)
      if (!plan || !Array.isArray(p.ticketLinks) || p.ticketLinks.length !== plan.nodes.length ||
          p.ticketLinks.some((link, index) => link !== formatGoalTicketLink(input.goalId, parsed, plan.nodes[index]!.id)))
        throw new Error('Ticket links do not match their original Goal and node identity.')
      address = parsed
      ticketLinks = p.ticketLinks as string[]
    } catch (error) {
      throw new AgentMuxError(error instanceof Error ? error.message : String(error), 'CONTROL_PROTOCOL_ERROR')
    }
  }
  const planStateRead = parseOwnerGoalPlanState(p.planState, plan, delegations, p.planStateIssue)
  const dispatches = p.dispatches === undefined ? undefined : parseDemandDispatches(p.dispatches, id(p.goalId))
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
      if (communication) assertGoalDelegationSource(delegation, communication.source, input.goalId)
      const recoverableReport = item.recoverableReport === undefined ? undefined : parseDemandDelegationReportInput(item.recoverableReport)
      if (recoverableReport) {
        const reply = communication?.replies.find(message => message.envelope.messageId === recoverableReport.replyMessageId)
        if (!communication || !reply ||
          goalDelegationReportBody(input.goalId, operationId, readGoalDelegationWireReport(input.goalId, delegation, reply, communication.source)) !== goalDelegationReportBody(input.goalId, operationId, recoverableReport))
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
  return { goalId: input.goalId, goalUpdatedAt: p.goalUpdatedAt as number, delegations, ...(address && ticketLinks ? { address, ticketLinks } : {}), ...(plan ? { plan } : {}), ...planStateRead, diskDurability: 'confirmed',
    ...(dispatches ? { dispatches } : {}), ...(startObservations ? { startObservations } : {}),
    ...(goalState ? { goalState } : {}), ...(patrols ? { patrols } : {}), ...(patrolObservations ? { patrolObservations } : {}),
    ...(progressUpdates ? { progressUpdates } : {}), ...(responsibility ? { responsibility } : {}),
    ...(p.grounding === undefined ? {} : { grounding: parseGrounding(p.grounding) }), ...(observations === undefined ? {} : { observations }) }
}

export function assertGoalDelegationSource(saved: DemandDelegationIntent & Partial<Pick<DemandDelegation, 'capturedCriteria' | 'runtimeIdentity' | 'predecessors'>>, message: DurableAgentMuxMessage, goalId?: string): void {
  const envelope = message.envelope
  if (envelope.operationId !== saved.operationId || envelope.messageId !== saved.sourceMessageId ||
    envelope.sender.kind !== 'agent-session' || envelope.sender.agentSessionId !== saved.ownerAgentSessionId || envelope.senderSessionId !== saved.ownerAgentSessionId || envelope.senderRunId !== saved.ownerRunId ||
    envelope.recipient.kind !== 'agent-session' || envelope.recipient.agentSessionId !== saved.workerAgentSessionId || envelope.recipientSessionId !== saved.workerAgentSessionId || envelope.recipientRunId !== saved.workerRunId ||
    envelope.threadId !== saved.threadId || envelope.replyTo !== null || envelope.body !== saved.text)
    throw new AgentMuxError('The original Core source differs from the frozen Goal intent. The Agent remains available.', 'CONTROL_REQUEST_CONFLICT')
  if (saved.runtimeIdentity && (!message.provenance || envelope.senderRuntimeId !== saved.runtimeIdentity.ownerRuntimeId ||
      envelope.recipientRuntimeId !== saved.runtimeIdentity.workerRuntimeId || message.provenance.source.runtimeId !== saved.runtimeIdentity.ownerRuntimeId ||
      message.provenance.target.runtimeId !== saved.runtimeIdentity.workerRuntimeId))
    throw new AgentMuxError('The original Core source Runtime identities differ from this linked delegation.', 'CONTROL_REQUEST_CONFLICT')
  if (saved.predecessors?.length && !envelope.application)
    throw new AgentMuxError('The original Core source has no receipt for this delegation’s predecessors.', 'CONTROL_REQUEST_CONFLICT')
  if (envelope.application) {
    const source = readGoalDelegationSource(message)
    if ((saved.predecessors?.length || source.predecessors?.length) && saved.predecessors !== undefined &&
        !sameGoalPlanPredecessors(saved.predecessors, source.predecessors))
      throw new AgentMuxError('The original Core source names different predecessor receipts.', 'CONTROL_REQUEST_CONFLICT')
    if (source.delegationOperationId !== saved.operationId || goalId !== undefined && source.goalId !== goalId ||
        source.alignmentRevision !== saved.alignmentRevision || source.planNodeId !== saved.planNodeId ||
        source.criteria.length !== saved.criterionIds.length || source.criteria.some(criterion => !saved.criterionIds.includes(criterion.id)) ||
        saved.capturedCriteria && saved.capturedCriteria.some((criterion, index) => criterion.id !== source.criteria[index]?.id || criterion.text !== source.criteria[index]?.text))
      throw new AgentMuxError('The signed Goal application differs from the frozen delegation standards.', 'CONTROL_REQUEST_CONFLICT')
  }
}
/** For unsigned local replies the Host reads these from the original Core, never from wire text. */
export type GoalDelegationReplyRuns = { workerSourceRuns?: readonly string[]; ownerSourceRuns?: readonly string[] }
export function assertGoalDelegationReply(saved: DemandDelegation, report: DemandDelegationReportInput, message: DurableAgentMuxMessage, body: string, source?: DurableAgentMuxMessage, runs?: GoalDelegationReplyRuns): void {
  const envelope = message.envelope
  // Signed peers admit successors at their signing Core. A local business owner
  // supplies its Core read here; a wire reader only checks the owner's returned structure.
  const signed = Boolean(message.provenance && (saved.runtimeIdentity || source?.provenance))
  const successor = (actual: string | null, original: string, chain?: readonly string[]) => actual === original ||
    Boolean(actual && chain && chain.indexOf(actual) >= 0 && chain.indexOf(original) > chain.indexOf(actual))
  if (envelope.operationId !== report.operationId || envelope.messageId !== report.replyMessageId || envelope.sender.kind !== 'agent-session' ||
    envelope.sender.agentSessionId !== saved.workerAgentSessionId || envelope.senderSessionId !== saved.workerAgentSessionId ||
    envelope.recipient.kind !== 'agent-session' || envelope.recipient.agentSessionId !== saved.ownerAgentSessionId || envelope.recipientSessionId !== saved.ownerAgentSessionId ||
    !signed && runs !== undefined && (!successor(envelope.senderRunId, saved.workerRunId, runs.workerSourceRuns) || !successor(envelope.recipientRunId, saved.ownerRunId, runs.ownerSourceRuns)) ||
    envelope.replyTo !== saved.sourceMessageId || envelope.threadId !== saved.threadId || envelope.body !== body ||
    saved.runtimeIdentity && (!message.provenance || envelope.senderRuntimeId !== saved.runtimeIdentity.workerRuntimeId || envelope.recipientRuntimeId !== saved.runtimeIdentity.ownerRuntimeId) ||
    source && (envelope.senderRuntimeId !== source.envelope.recipientRuntimeId || envelope.recipientRuntimeId !== source.envelope.senderRuntimeId ||
      source.provenance && !message.provenance))
    throw new AgentMuxError('The actual worker reply differs from this original report. No result was collected or accepted.', 'CONTROL_REQUEST_CONFLICT')
}
export function readGoalDelegationWireReport(goalId: string, saved: DemandDelegation, reply: DurableAgentMuxMessage, source?: DurableAgentMuxMessage, runs?: GoalDelegationReplyRuns): DemandDelegationReportInput {
  const report = reply.envelope.application ? readGoalReportApplication(reply, goalId, saved.operationId) : (() => {
    if (reply.provenance) throw new AgentMuxError('A signed remote report requires its explicit Goal application.', 'CONTROL_PROTOCOL_ERROR')
    let payload: unknown
    try { payload = JSON.parse(reply.envelope.body) } catch { throw new AgentMuxError('The original reply has no structured Goal report. Inspect its evidence in the original Agent.', 'CONTROL_PROTOCOL_ERROR') }
    const p = record(payload, ['schema', 'goalId', 'delegationOperationId', 'report'])
    if (p.schema !== 'agentmux.goal-report.v1' || p.goalId !== goalId || p.delegationOperationId !== saved.operationId)
      throw new AgentMuxError('The structured report refers to another original Goal or delegation.', 'CONTROL_PROTOCOL_ERROR')
    return parseDemandDelegationReportInput(p.report)
  })()
  validateDemandDelegationReport(saved, report)
  assertGoalDelegationReply(saved, report, reply, goalDelegationReportBody(goalId, saved.operationId, report), source, runs)
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
    if (!runBoundDemandDispatch(start)) {
      if (input.state !== 'unknown' || input.retainedReceipt !== undefined || input.proof !== undefined ||
          item.originalRun !== undefined || item.goalResult !== undefined || item.supervisor !== undefined || item.attention !== undefined || item.responsibility !== 'observation-unknown')
        throw new AgentMuxError('A business request without a prepared Run cannot prove Runtime input or execution.', 'CONTROL_PROTOCOL_ERROR')
      return { operationId, input: { state: 'unknown' as const, ...(input.reason === undefined ? {} : { reason: id(input.reason) }) },
        responsibility: 'observation-unknown' as const, ...(item.unknown === undefined ? {} : { unknown: id(item.unknown) }) }
    }
    if (input.retainedReceipt !== undefined) {
      if ('target' in start) {
        if (!start.receipt) throw new AgentMuxError('The original qualified Start has no retained input receipt.', 'CONTROL_PROTOCOL_ERROR')
        const retained = parseDemandDispatch({ ...start, receipt: input.retainedReceipt }).receipt
        if (JSON.stringify(retained) !== JSON.stringify(start.receipt)) throw new AgentMuxError('The retained receipt does not belong to this original qualified Start.', 'CONTROL_PROTOCOL_ERROR')
      } else {
        const receipt = record(input.retainedReceipt, ['kind', 'itemId', 'createdAt'])
        if (!start.receipt || receipt.kind !== start.receipt.kind || receipt.itemId !== start.receipt.itemId || receipt.createdAt !== start.receipt.createdAt)
          throw new AgentMuxError('The retained receipt does not belong to this original Start.', 'CONTROL_PROTOCOL_ERROR')
      }
    }
    const proof = input.proof === undefined ? undefined : (() => {
      if ('target' in start) throw new AgentMuxError('A legacy Core proof cannot stand for this Source-qualified original input.', 'CONTROL_PROTOCOL_ERROR')
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
      if ('target' in start || !attention || target.agentSessionId !== attention.supervisorAgentSessionId || target.hostId !== start.hostId || target.runId !== attention.supervisorRunId)
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
