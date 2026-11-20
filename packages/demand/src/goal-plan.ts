import { deriveObjectId, isObjectId } from '@agentmux/identity'
import type { DemandCriterion } from './goals.js'
import { isGoalTicketHash, parseGoalTicketProof, type GoalTicketProof, type GoalTicketTask } from './goal-ticket-proof.js'
import { delegationWorkerHostId, isGoalDeliveryHash, parseGoalPlanPredecessors, sameGoalPlanPredecessors, type DemandDelegation, type GoalPlanPredecessor } from './delegations.js'

export { isGoalTicketHash } from './goal-ticket-proof.js'

/**
 * A Goal's plan: a dependency graph of nodes inside one Goal. The plan holds only structure,
 * executor choices and review verdicts. Execution, threads, delivery and reports stay with the
 * delegation owner and Core; node state is derived from those facts, never stored.
 */
export const GOAL_PLAN_NODE_STATES = ['waiting', 'ready', 'working', 'review', 'changes', 'done', 'cancelled', 'unknown'] as const
export type GoalPlanNodeState = (typeof GOAL_PLAN_NODE_STATES)[number]

/** An exact Agent identity; placement (local, remote Host or remote project) is the Host's fact. */
export type GoalPlanExecutor = { hostId: string; agentSessionId: string }
export type GoalPlanNodeInput = {
  /** Published Ticket ID, or a revision-local reference when introducing a node. */
  id: string
  title: string
  /** The result this node must deliver, in the plan author's words. */
  outcome: string
  dependsOn: string[]
  /** Success criteria of the current Goal proposal this node covers. */
  criterionIds: string[]
  /** A check another party can repeat, e.g. a command; the reviewer runs it. */
  check: string
  executor: GoalPlanExecutor | null
  /** Only an explicit owner operation opens an unassigned node for self-claim. */
  claimOpen?: true
  cancelled?: true
}
export type GoalPlanReviewInput = {
  operationId: string
  nodeId: string
  /** The delegation attempt this verdict judges. */
  delegationOperationId: string
  deliveryHash?: string
  verdict: 'pass' | 'changes'
  /** Exactly what the reviewer ran and observed; required for a pass. */
  check: { command: string; result: string; evidence: string[] }
  note: string
}
export type GoalPlanReviewer = { kind: 'agent' | 'user' | 'device'; id: string; hostId?: string; runtimeId?: string }
export type GoalPlanReview = GoalPlanReviewInput & { reviewer: GoalPlanReviewer; reviewedAt: number; completion?: GoalTicketProof }
export type GoalPlanAssignment = { kind: 'open' } | { kind: 'close' } | { kind: 'assign'; executor: GoalPlanExecutor }
export type GoalPlanAssignmentChange = { nodeId: string; assignment: GoalPlanAssignment | { kind: 'claim' } }
export type GoalPlanOwner = { runtimeId: string; namespace: string }
export type GoalPlanClaimScope = GoalPlanOwner & { goalId: string }
export type GoalPlanClaim = { token: string; basis: string; predecessors: GoalPlanPredecessor[]; proof: GoalTicketProof }
export type GoalPlanProposal = { nodeId: string; delegationOperationId: string; replyMessageId: string }
export type GoalPlanProposalReceipt = GoalPlanProposal & { sourceMessageId: string; proposalOperationId: string; author: { agentSessionId: string; runtimeId: string } }
export type GoalPlanRevisionRecord = { operationId: string; revision: number; author: GoalPlanReviewer; revisedAt: number; change?: GoalPlanAssignmentChange; claim?: GoalPlanClaim; changedNodes?: string[]; requestHash?: string; createdTickets?: GoalTicketProof[]; proposals?: GoalPlanProposalReceipt[] }
export type GoalPlan = {
  revision: number
  /** The Goal proposal version the node criteria were written against. */
  alignmentRevision: number
  nodes: GoalPlanNodeInput[]
  reviews: GoalPlanReview[]
  /** Append-only provenance of each accepted revision. */
  history: GoalPlanRevisionRecord[]
}
export type GoalPlanRevisionInput = { operationId: string; alignmentRevision: number; proposals?: GoalPlanProposal[] } & (
  { expectedRevision: number; nodes: GoalPlanNodeInput[]; appendNodes?: never } |
  { appendNodes: GoalPlanNodeInput[]; expectedRevision?: never; nodes?: never })

function object(value: unknown, label: string, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const result = value as Record<string, unknown>
  if (Object.keys(result).some(key => !keys.includes(key)) || keys.some(key => !optional.includes(key) && !Object.hasOwn(result, key)))
    throw new Error(`${label} has unsupported or missing fields`)
  return result
}
export function isGoalPlanIdentity(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && !/[\0\r\n\p{Surrogate}]/u.test(value)
}
function identity(value: unknown, label: string): string {
  if (!isGoalPlanIdentity(value)) throw new Error(`${label} must be a nonempty single-line identity`)
  return value
}
function prose(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${label} must be nonempty text`)
  return value
}
function positive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`)
  return value
}
function count(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`)
  return value
}
function identities(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  const result = value.map((item, index) => identity(item, `${label}[${index}]`))
  if (new Set(result).size !== result.length) throw new Error(`${label} must not repeat an identity`)
  return result
}
function actor(value: unknown, label: string): GoalPlanReviewer {
  const data = object(value, label, ['kind', 'id', 'hostId', 'runtimeId'], ['hostId', 'runtimeId'])
  if (data.kind !== 'agent' && data.kind !== 'user' && data.kind !== 'device') throw new Error(`${label}.kind is invalid`)
  return { kind: data.kind, id: identity(data.id, `${label}.id`), ...(data.hostId === undefined ? {} : { hostId: identity(data.hostId, `${label}.hostId`) }),
    ...(data.runtimeId === undefined ? {} : { runtimeId: identity(data.runtimeId, `${label}.runtimeId`) }) }
}

function parseExecutor(value: unknown): GoalPlanExecutor {
  const item = object(value, 'plan node executor', ['hostId', 'agentSessionId'])
  return { hostId: identity(item.hostId, 'executor.hostId'), agentSessionId: identity(item.agentSessionId, 'executor.agentSessionId') }
}

export function parseGoalPlanAssignment(value: unknown): GoalPlanAssignment {
  const item = object(value, 'plan node assignment', ['kind', 'executor'], ['executor'])
  if (item.kind === 'assign') return { kind: 'assign', executor: parseExecutor(item.executor) }
  if ((item.kind === 'open' || item.kind === 'close') && !Object.hasOwn(item, 'executor')) return { kind: item.kind }
  throw new Error('A node assignment must open, close or assign an exact executor')
}

function proposal(value: unknown): GoalPlanProposal {
  const p = object(value, 'Ticket proposal', ['nodeId', 'delegationOperationId', 'replyMessageId'])
  return { nodeId: identity(p.nodeId, 'Ticket proposal node'), delegationOperationId: identity(p.delegationOperationId, 'Ticket original attempt'),
    replyMessageId: identity(p.replyMessageId, 'Ticket proposal reply') }
}

function proposalReceipt(value: unknown): GoalPlanProposalReceipt {
  const p = object(value, 'Ticket proposal receipt', ['nodeId', 'delegationOperationId', 'replyMessageId', 'sourceMessageId', 'proposalOperationId', 'author'])
  const { sourceMessageId, proposalOperationId, author, ...request } = p
  const writer = object(author, 'Ticket proposal author', ['agentSessionId', 'runtimeId'])
  return { ...proposal(request), sourceMessageId: identity(sourceMessageId, 'Ticket proposal source'),
    proposalOperationId: identity(proposalOperationId, 'Ticket proposal operation'),
    author: { agentSessionId: identity(writer.agentSessionId, 'Ticket proposal Session'), runtimeId: identity(writer.runtimeId, 'Ticket proposal Runtime') } }
}

function parseAssignmentChange(value: unknown): GoalPlanAssignmentChange {
  const change = object(value, 'plan assignment change', ['nodeId', 'assignment'])
  const a = object(change.assignment, 'plan assignment action', ['kind', 'executor'], ['executor'])
  const assignment = a.kind === 'claim' && !Object.hasOwn(a, 'executor') ? { kind: 'claim' as const } : parseGoalPlanAssignment(a)
  return { nodeId: identity(change.nodeId, 'plan assignment nodeId'), assignment }
}

export function parseGoalPlanNode(value: unknown): GoalPlanNodeInput {
  const data = object(value, 'plan node', ['id', 'title', 'outcome', 'dependsOn', 'criterionIds', 'check', 'executor', 'cancelled', 'claimOpen'], ['cancelled', 'claimOpen'])
  const executor = data.executor === null ? null : parseExecutor(data.executor)
  if (data.claimOpen !== undefined && (data.claimOpen !== true || executor !== null || data.cancelled))
    throw new Error('An open plan node must be unassigned and uncancelled')
  if (data.cancelled !== undefined && data.cancelled !== true) throw new Error('plan node cancelled must be true when present')
  return { id: identity(data.id, 'plan node id'), title: prose(data.title, 'plan node title'), outcome: prose(data.outcome, 'plan node outcome'),
    dependsOn: identities(data.dependsOn, 'plan node dependsOn'), criterionIds: identities(data.criterionIds, 'plan node criterionIds'),
    check: prose(data.check, 'plan node check'), executor, ...(data.claimOpen ? { claimOpen: true as const } : {}), ...(data.cancelled ? { cancelled: true as const } : {}) }
}

export function parseGoalPlanReviewInput(value: unknown): GoalPlanReviewInput {
  const data = object(value, 'plan review', ['operationId', 'nodeId', 'delegationOperationId', 'verdict', 'check', 'note', 'deliveryHash'], ['deliveryHash'])
  if (data.deliveryHash !== undefined && !isGoalDeliveryHash(data.deliveryHash)) throw new Error('Invalid Ticket delivery hash')
  if (data.verdict !== 'pass' && data.verdict !== 'changes') throw new Error('plan review verdict must be pass or changes')
  const check = object(data.check, 'plan review check', ['command', 'result', 'evidence'])
  if (!Array.isArray(check.evidence) || check.evidence.some(item => typeof item !== 'string' || !item.trim())) throw new Error('plan review evidence must list nonempty locations')
  const review: GoalPlanReviewInput = { operationId: identity(data.operationId, 'review operationId'), nodeId: identity(data.nodeId, 'review nodeId'),
    delegationOperationId: identity(data.delegationOperationId, 'review delegationOperationId'), verdict: data.verdict,
    ...(typeof data.deliveryHash === 'string' ? { deliveryHash: data.deliveryHash } : {}),
    check: { command: typeof check.command === 'string' ? check.command : '', result: typeof check.result === 'string' ? check.result : '', evidence: check.evidence as string[] },
    note: typeof data.note === 'string' ? data.note : '' }
  if (review.verdict === 'pass' && (!review.check.command.trim() || !review.check.result.trim() || review.check.evidence.length === 0))
    throw new Error('A passing review must record the check it ran, its result and where the evidence is')
  if (review.verdict === 'changes' && !review.note.trim()) throw new Error('A review that requests changes must say what to change')
  return review
}

/** Compare the normalized request returned in the original durable review. */
export function matchesGoalPlanReviewInput(original: GoalPlanReview, input: GoalPlanReviewInput): boolean {
  if (original.operationId !== input.operationId) return false
  const { reviewer: _reviewer, reviewedAt: _reviewedAt, completion: _completion, ...saved } = original
  return JSON.stringify(saved) === JSON.stringify(input)
}

/** Structural rules: unique ids, dependencies inside the plan, no cycle. */
export function validateGoalPlanNodes(nodes: readonly GoalPlanNodeInput[], existing?: ReadonlyMap<string, GoalPlanNodeInput>): void {
  const ids = new Set<string>()
  for (const node of nodes) {
    if (ids.has(node.id) || existing?.has(node.id)) throw new Error(`Plan node ${node.id} appears twice`)
    ids.add(node.id)
  }
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (dependency === node.id) throw new Error(`Plan node ${node.id} cannot depend on itself`)
      if (!ids.has(dependency) && !existing?.has(dependency)) throw new Error(`Plan node ${node.id} depends on ${dependency}, which is not in this plan`)
    }
  }
  const byId = new Map(nodes.map(node => [node.id, node]))
  const settled = new Set<string>(), visiting = new Set<string>()
  const visit = (id: string, path: string[]): void => {
    if (settled.has(id) || existing?.has(id)) return
    if (visiting.has(id)) throw new Error(`Plan dependencies form a cycle: ${[...path, id].join(' → ')}`)
    visiting.add(id)
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency, [...path, id])
    visiting.delete(id); settled.add(id)
  }
  for (const node of nodes) visit(node.id, [])
}

export function parseGoalPlan(value: unknown): GoalPlan {
  const data = object(value, 'plan', ['revision', 'alignmentRevision', 'nodes', 'reviews', 'history'])
  if (!Array.isArray(data.nodes) || !Array.isArray(data.reviews) || !Array.isArray(data.history)) throw new Error('plan nodes, reviews and history must be arrays')
  const nodes = data.nodes.map(parseGoalPlanNode)
  validateGoalPlanNodes(nodes)
  const ids = new Set(nodes.map(node => node.id)), issued = new Set<string>()
  const reviews = data.reviews.map(value => {
    const item = object(value, 'plan review', ['operationId', 'nodeId', 'delegationOperationId', 'verdict', 'check', 'note', 'reviewer', 'reviewedAt', 'deliveryHash', 'completion'], ['deliveryHash', 'completion'])
    const { reviewer, reviewedAt, completion: proof, ...input } = item
    const review = parseGoalPlanReviewInput(input), author = actor(reviewer, 'plan reviewer')
    const completion = proof === undefined ? undefined : parseGoalTicketProof(proof)
    if (completion && (review.verdict !== 'pass' || completion.record.kind !== 'completed' || completion.record.ticketId !== review.nodeId ||
        completion.record.operationId !== review.operationId || completion.record.attemptId !== review.delegationOperationId || completion.record.deliveryHash !== review.deliveryHash ||
        JSON.stringify(completion.record.actor) !== JSON.stringify(author) || JSON.stringify(completion.record.check) !== JSON.stringify(review.check) || completion.record.note !== review.note))
      throw new Error('Goal Ticket completion belongs to another verdict or delivery')
    return { ...review, reviewer: author, reviewedAt: positive(reviewedAt, 'plan review reviewedAt'), ...(completion ? { completion } : {}) }
  })
  if (new Set(reviews.map(review => review.operationId)).size !== reviews.length) throw new Error('plan reviews repeat an operation')
  if (reviews.some(review => !ids.has(review.nodeId))) throw new Error('plan review names an absent node')
  const history = data.history.map(value => {
    const item = object(value, 'plan revision record', ['operationId', 'revision', 'author', 'revisedAt', 'change', 'claim', 'changedNodes', 'requestHash', 'createdTickets', 'proposals'], ['change', 'claim', 'changedNodes', 'requestHash', 'createdTickets', 'proposals'])
    const change = item.change === undefined ? undefined : parseAssignmentChange(item.change)
    const claim = item.claim === undefined ? undefined : object(item.claim, 'plan claim', ['token', 'basis', 'predecessors', 'proof'])
    const changedNodes = item.changedNodes === undefined ? undefined : identities(item.changedNodes, 'plan changed nodes')
    if (item.createdTickets !== undefined && !Array.isArray(item.createdTickets)) throw new Error('Issued Tickets must be an array')
    const createdTickets = (item.createdTickets as unknown[] | undefined)?.map(parseGoalTicketProof)
    for (const proof of createdTickets ?? []) {
      if (proof.record.kind !== 'issued' || proof.record.operationId !== item.operationId || !ids.has(proof.hash) || issued.has(proof.hash))
        throw new Error('Each issued Ticket must belong to its original revision and plan')
      issued.add(proof.hash)
    }
    if (item.requestHash !== undefined && !isGoalDeliveryHash(item.requestHash)) throw new Error('Invalid plan revision request hash')
    if (item.proposals !== undefined && !Array.isArray(item.proposals)) throw new Error('Ticket proposal receipts must be an array')
    const proposals = (item.proposals as unknown[] | undefined)?.map(proposalReceipt)
    if ((changedNodes || createdTickets || proposals || item.requestHash) && change) throw new Error('An assignment cannot revise node definitions')
    if (proposals && (new Set(proposals.map(p => p.nodeId)).size !== proposals.length || proposals.some(p => !createdTickets?.some(proof => proof.hash === p.nodeId))))
      throw new Error('Ticket proposals must refer to nodes created by the same operation')
    if (claim && (change?.assignment.kind !== 'claim' || !isObjectId(claim.token) || !isObjectId(claim.basis))) throw new Error('plan claim lacks its original assignment and token')
    const proof = claim ? parseGoalTicketProof(claim.proof) : undefined
    if (proof && (proof.record.kind !== 'claim' || proof.record.ticketId !== change?.nodeId || proof.record.operationId !== item.operationId))
      throw new Error('Goal Ticket claim proof belongs to another operation or Ticket')
    return { operationId: identity(item.operationId, 'plan revision operationId'), revision: positive(item.revision, 'plan revision'),
      ...(change ? { change } : {}), ...(changedNodes ? { changedNodes } : {}),
      ...(createdTickets ? { createdTickets } : {}), ...(proposals ? { proposals } : {}),
      ...(typeof item.requestHash === 'string' ? { requestHash: item.requestHash } : {}),
      ...(claim && proof ? { claim: { token: claim.token as string, basis: claim.basis as string, predecessors: parseGoalPlanPredecessors(claim.predecessors), proof } } : {}),
      author: actor(item.author, 'plan revision author'), revisedAt: positive(item.revisedAt, 'plan revision revisedAt') }
  })
  const revision = positive(data.revision, 'plan revision')
  if (new Set(history.map(record => record.operationId)).size !== history.length) throw new Error('plan history repeats an operation')
  if (history.length !== revision || history.some((record, index) => record.revision !== index + 1)) throw new Error('plan history must record every revision in order')
  return { revision, alignmentRevision: positive(data.alignmentRevision, 'plan alignmentRevision'), nodes, reviews, history }
}

export function parseGoalPlanRevisionInput(value: unknown): GoalPlanRevisionInput {
  const data = object(value, 'plan revision', ['operationId', 'expectedRevision', 'alignmentRevision', 'nodes', 'appendNodes', 'proposals'],
    ['expectedRevision', 'nodes', 'appendNodes', 'proposals'])
  const appending = Object.hasOwn(data, 'appendNodes')
  if (appending && (Object.hasOwn(data, 'nodes') || Object.hasOwn(data, 'expectedRevision')))
    throw new Error('An append supplies only appendNodes and the Goal proposal version')
  const input = appending ? data.appendNodes : data.nodes
  if (!Array.isArray(input) || input.length === 0) throw new Error('A plan revision needs at least one node')
  const nodes = input.map(parseGoalPlanNode)
  if (!appending) validateGoalPlanNodes(nodes)
  if (data.proposals !== undefined && !Array.isArray(data.proposals)) throw new Error('Ticket proposals must be an array')
  const proposals = (data.proposals as unknown[] | undefined)?.map(proposal)
  if (proposals && (new Set(proposals.map(p => p.nodeId)).size !== proposals.length || proposals.some(p => !nodes.some(node => node.id === p.nodeId))))
    throw new Error('Each proposed Ticket must appear once in this revision')
  const original = { operationId: identity(data.operationId, 'plan revision operationId'), ...(proposals?.length ? { proposals } : {}) }
  const alignmentRevision = positive(data.alignmentRevision, 'plan alignmentRevision')
  if (appending) return { ...original, alignmentRevision, appendNodes: nodes }
  const expectedRevision = data.expectedRevision
  if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw new Error('plan expectedRevision must be a non-negative integer')
  return { ...original, expectedRevision, alignmentRevision, nodes }
}

export function goalTicketTask(node: GoalPlanNodeInput, criterionById: (id: string) => DemandCriterion | undefined): GoalTicketTask {
  return { outcome: node.outcome, check: node.check, criteria: [...node.criterionIds].sort().map(id => {
    const criterion = criterionById(id)
    if (!criterion) throw new Error('Goal Ticket needs the original version of every success criterion')
    return { id: criterion.id, text: criterion.text }
  }) }
}

/** Published nodes keep their identity. Recorded work also keeps its task contract. */
export function assertGoalPlanKeepsRecordedNodes(previous: GoalPlan | undefined, next: readonly GoalPlanNodeInput[], delegations: readonly DemandDelegation[]): void {
  if (!previous) return
  const kept = new Map(next.map(node => [node.id, node]))
  for (const node of previous.nodes) {
    const replacement = kept.get(node.id)
    if (!replacement) throw new Error(`Published Ticket ${node.id} keeps its original identity; mark it cancelled instead of removing it`)
    const recorded = delegations.some(delegation => delegation.planNodeId === node.id) || previous.reviews.some(review => review.nodeId === node.id)
    if (!recorded) continue
    if (replacement.outcome !== node.outcome || replacement.check !== node.check || replacement.criterionIds.length !== node.criterionIds.length ||
      node.criterionIds.some(id => !replacement.criterionIds.includes(id)))
      throw new Error(`Plan node ${node.id} has recorded work; cancel it and add a new node to change its outcome, check or criteria`)
  }
}

/** Compare the facts that can invalidate this node's eligibility, independently of display. */
export function goalPlanChangedNodes(previous: readonly GoalPlanNodeInput[], next: readonly GoalPlanNodeInput[]): string[] {
  const prior = new Map(previous.map(node => [node.id, node]))
  const definition = (node: GoalPlanNodeInput) => [node.outcome, node.check, [...node.dependsOn].sort(),
    [...node.criterionIds].sort(), node.executor, node.cancelled, node.claimOpen]
  const changed: string[] = []
  for (const node of next) {
    const old = prior.get(node.id)
    if (!old || JSON.stringify(definition(old)) !== JSON.stringify(definition(node))) changed.push(node.id)
    prior.delete(node.id)
  }
  return [...changed, ...prior.keys()]
}

/** Compare the current task's frozen standards, not an unrelated Goal revision number. */
export function staleGoalPlanCriteria(node: GoalPlanNodeInput, criteria: readonly DemandCriterion[], attempt?: Pick<DemandDelegation, 'capturedCriteria'> | null): string[] {
  return node.criterionIds.filter(id => {
    const current = criteria.find(criterion => criterion.id === id)
    return !current || Boolean(attempt && !attempt.capturedCriteria.some(criterion => criterion.id === id && criterion.text === current.text))
  })
}

/** The current criteria or a required dispatch, predecessor or completion receipt is unconfirmed. */
export const GOAL_PLAN_UNKNOWN_REASONS = ['criteria', 'dispatch-link', 'predecessors', 'completion-proof'] as const
export type GoalPlanUnknownReason = (typeof GOAL_PLAN_UNKNOWN_REASONS)[number]
export type GoalPlanNodeProjection = {
  node: GoalPlanNodeInput
  state: GoalPlanNodeState
  /** 0-based dependency column: one past the deepest dependency. */
  column: number
  /** The newest delegation, unless an explicit executor revision superseded its unreviewed work. */
  delegation: DemandDelegation | null
  attempts: number
  predecessors: GoalPlanPredecessor[] | null
  claimToken?: string
  claimBasis?: string
  claimOpeningOperationId?: string
  review: GoalPlanReview | null
  staleCriteria: string[]
  /** Every reason the node needs reconciliation; nonempty exactly when its state is unknown. */
  unknown: GoalPlanUnknownReason[]
}
export type GoalPlanProjection = { revision: number; nodes: GoalPlanNodeProjection[]; done: number; total: number; next: string[] }

/** Review only the current attempt and its exact content-signed delivery. */
export function currentGoalWorkflowDelivery(goal: Pick<import('./demand-types.js').Demand, 'status' | 'plan' | 'alignment' | 'delegations'>, attempt: DemandDelegation): GoalPlanNodeInput | undefined {
  if (!goal.plan || !goal.alignment || !attempt.planNodeId || !attempt.report?.delivery || goal.status === 'done' || goal.status === 'cancelled') return undefined
  const current = projectGoalPlan(goal.plan, goal.delegations ?? [], goal.alignment.criteria, undefined, goal.alignment.revision)
    .nodes.find(row => row.node.id === attempt.planNodeId)
  return current?.state === 'review' && current.delegation?.operationId === attempt.operationId &&
    current.delegation.report?.delivery?.hash === attempt.report.delivery.hash ? current.node : undefined
}

export function goalPlanClaimToken(scope: GoalPlanClaimScope, openingOperationId: string, basis: string): string {
  return deriveObjectId('agentmux.goal-plan-claim.v1', JSON.stringify([scope.runtimeId, scope.namespace, scope.goalId, openingOperationId, basis]))
}

/**
 * The only place node state is decided. It reads the plan, this Goal's delegations and the
 * current criteria; delivery or Agent idleness never reaches it.
 */
export function projectGoalPlan(plan: GoalPlan, delegations: readonly DemandDelegation[], criteria: readonly DemandCriterion[], claimScope?: GoalPlanClaimScope, alignmentRevision = plan.alignmentRevision): GoalPlanProjection {
  const byId = new Map(plan.nodes.map(node => [node.id, node]))
  const column = new Map<string, number>()
  const depth = (id: string): number => {
    const known = column.get(id)
    if (known !== undefined) return known
    const node = byId.get(id)!
    const value = node.dependsOn.length ? Math.max(...node.dependsOn.map(depth)) + 1 : 0
    column.set(id, value)
    return value
  }
  const assignment = new Map<string, GoalPlanRevisionRecord>()
  const changedAt = new Map<string, number>()
  for (const entry of plan.history) {
    if (entry.change) assignment.set(entry.change.nodeId, entry)
    for (const nodeId of entry.changedNodes ?? []) changedAt.set(nodeId, entry.revision)
  }
  const latestByNode = new Map<string, { count: number; attempt: DemandDelegation }>()
  for (const attempt of delegations) if (attempt.planNodeId) {
    const count = (latestByNode.get(attempt.planNodeId)?.count ?? 0) + 1
    latestByNode.set(attempt.planNodeId, { count, attempt })
  }
  const reviews = new Map(plan.reviews.map(review => [review.delegationOperationId, review]))
  const derived = new Map<string, Omit<GoalPlanNodeProjection, 'column'>>()
  const derive = (node: GoalPlanNodeInput): Omit<GoalPlanNodeProjection, 'column'> => {
    const known = derived.get(node.id)
    if (known) return known
    const attempts = latestByNode.get(node.id), latest = attempts?.attempt ?? null
    const recordedReview = latest ? reviews.get(latest.operationId) : undefined
    const latestReview = recordedReview?.nodeId === node.id ? recordedReview : null
    const reassigned = Boolean(latest && !latestReview && node.executor &&
      (node.executor.hostId !== delegationWorkerHostId(latest) || node.executor.agentSessionId !== latest.workerAgentSessionId))
    const current = reassigned ? null : latest
    const review = current ? latestReview : null
    const staleCriteria = staleGoalPlanCriteria(node, criteria, current)
    const refs: GoalPlanPredecessor[] = []
    for (const id of [...node.dependsOn].sort()) {
      const source = derive(byId.get(id)!)
      if (source.state !== 'done' || !source.delegation?.report || !source.review) break
      refs.push({ nodeId: id, delegationOperationId: source.delegation.operationId,
        reportOperationId: source.delegation.report.operationId, reviewOperationId: source.review.operationId,
        ...(source.review.deliveryHash ? { deliveryHash: source.review.deliveryHash } : {}),
        ...(source.review.completion ? { completionHash: source.review.completion.hash } : {}) })
    }
    const predecessors = refs.length === node.dependsOn.length ? refs : null
    const unknown: GoalPlanUnknownReason[] = node.cancelled ? [] : [
      ...(staleCriteria.length || !node.criterionIds.length ? ['criteria' as const] : []),
      ...(current && !review && current.linkedAt === undefined ? ['dispatch-link' as const] : []),
      ...(current?.predecessors && !sameGoalPlanPredecessors(current.predecessors, predecessors) ? ['predecessors' as const] : []),
      ...(review?.verdict === 'pass' && !review.completion ? ['completion-proof' as const] : []),
    ]
    const state: GoalPlanNodeState = node.cancelled ? 'cancelled' : unknown.length ? 'unknown'
      : review ? review.verdict === 'pass' ? 'done' : 'changes'
      : current ? current.report ? 'review' : 'working'
      : predecessors ? 'ready' : 'waiting'
    const lastAssignment = assignment.get(node.id)
    const claimBasis = state === 'ready' && lastAssignment && (node.claimOpen || lastAssignment.claim)
      ? deriveObjectId('agentmux.goal-plan-eligibility.v1', JSON.stringify([
        node.id, node.outcome, node.check, changedAt.get(node.id), alignmentRevision, predecessors,
        [...node.criterionIds].sort().map(id => criteria.find(criterion => criterion.id === id)),
      ])) : undefined
    const claimOpeningOperationId = claimBasis && node.claimOpen && lastAssignment?.change?.assignment.kind === 'open'
      ? lastAssignment.operationId : undefined
    const claimToken = claimScope && claimBasis && claimOpeningOperationId
      ? goalPlanClaimToken(claimScope, claimOpeningOperationId, claimBasis) : undefined
    const value = { node, state, delegation: current, attempts: attempts?.count ?? 0, review, staleCriteria, unknown, predecessors,
      ...(claimBasis ? { claimBasis } : {}), ...(claimOpeningOperationId ? { claimOpeningOperationId } : {}), ...(claimToken ? { claimToken } : {}) }
    derived.set(node.id, value)
    return value
  }
  const nodes = plan.nodes.map(node => ({ ...derive(node), column: depth(node.id) }))
  const live = nodes.filter(item => item.state !== 'cancelled')
  return { revision: plan.revision, nodes, done: live.filter(item => item.state === 'done').length, total: live.length,
    next: nodes.filter(item => item.state === 'ready' || item.state === 'changes').map(item => item.node.id) }
}

/** A reference to the same response's original delegation; all participant and thread facts stay there. */
export type GoalPlanStateAttempt = { delegationOperationId: string; reported: boolean }
export type GoalPlanStateNode = { id: string; state: GoalPlanNodeState; column: number; attempts: number; staleCriteria: string[]; unknown: GoalPlanUnknownReason[]; attempt: GoalPlanStateAttempt | null; claimToken?: string }
/** The read-only form of the derivation that the Goal owner returns with its plan. */
export type GoalPlanState = { revision: number; done: number; total: number; next: string[]; nodes: GoalPlanStateNode[] }
export function goalPlanState(projection: GoalPlanProjection): GoalPlanState {
  return { revision: projection.revision, done: projection.done, total: projection.total, next: projection.next,
    nodes: projection.nodes.map(item => ({ id: item.node.id, state: item.state, column: item.column, attempts: item.attempts, staleCriteria: item.staleCriteria, unknown: item.unknown,
      ...(item.claimToken ? { claimToken: item.claimToken } : {}),
      attempt: item.delegation ? { delegationOperationId: item.delegation.operationId, reported: Boolean(item.delegation.report) } : null })) }
}

/**
 * The owner's derivation as it arrives with its plan. Each state follows the owner's rules, which
 * a reader of another version may not share; the value must still describe exactly the plan and
 * delegations it accompanies.
 */
export function parseGoalPlanState(value: unknown, plan: GoalPlan, delegations: readonly DemandDelegation[]): GoalPlanState {
  const data = object(value, 'plan state', ['revision', 'done', 'total', 'next', 'nodes'])
  if (data.revision !== plan.revision) throw new Error('plan state describes another plan revision')
  if (!Array.isArray(data.nodes) || data.nodes.length !== plan.nodes.length) throw new Error('plan state must describe every plan node')
  const nodes = data.nodes.map((value, index): GoalPlanStateNode => {
    const id = plan.nodes[index]!.id, label = `plan state node ${id}`
    const item = object(value, label, ['id', 'state', 'column', 'attempts', 'staleCriteria', 'unknown', 'attempt', 'claimToken'], ['claimToken'])
    if (item.id !== id) throw new Error('plan state nodes must follow the plan node order')
    const state = item.state as GoalPlanNodeState
    if (!GOAL_PLAN_NODE_STATES.includes(state)) throw new Error(`${label} has an invalid state`)
    const unknown = identities(item.unknown, `${label} unknown`) as GoalPlanUnknownReason[]
    if (unknown.some(reason => !GOAL_PLAN_UNKNOWN_REASONS.includes(reason)) || (unknown.length > 0) !== (state === 'unknown'))
      throw new Error(`${label} must name valid reasons exactly when it is unknown`)
    const attempts = count(item.attempts, `${label} attempts`)
    if (attempts > delegations.filter(entry => entry.planNodeId === id).length) throw new Error(`${label} counts attempts beyond its delegations`)
    const attempt = item.attempt === null ? null : (() => {
      const named = object(item.attempt, `${label} attempt`, ['delegationOperationId', 'reported'])
      const delegation = delegations.find(entry => entry.planNodeId === id && entry.operationId === named.delegationOperationId)
      if (!delegation || typeof named.reported !== 'boolean') throw new Error(`${label} attempt is not one of its delegations`)
      return { delegationOperationId: delegation.operationId, reported: named.reported }
    })()
    if (attempt && attempts === 0) throw new Error(`${label} names a current attempt without attempts`)
    if (item.claimToken !== undefined && (!isObjectId(item.claimToken) || state !== 'ready' || !plan.nodes[index]!.claimOpen))
      throw new Error(`${label} has a claim token for an ineligible node`)
    return { id, state, column: count(item.column, `${label} column`), attempts, staleCriteria: identities(item.staleCriteria, `${label} staleCriteria`), unknown, attempt,
      ...(typeof item.claimToken === 'string' ? { claimToken: item.claimToken } : {}) }
  })
  const next = identities(data.next, 'plan state next')
  if (next.some(id => !plan.nodes.some(node => node.id === id))) throw new Error('plan state next names a node outside the plan')
  const done = count(data.done, 'plan state done'), total = count(data.total, 'plan state total')
  if (done > total || total > plan.nodes.length) throw new Error('plan state counts exceed its nodes')
  return { revision: plan.revision, done, total, next, nodes }
}

/** Whether a node may receive a new delegation now, and why not. */
export function goalPlanDelegationIssue(projection: GoalPlanNodeProjection | undefined, nodeId: string, worker: GoalPlanExecutor): string | null {
  if (!projection) return `Plan node ${nodeId} is not in the current plan.`
  if (projection.node.claimOpen) return `Plan node ${nodeId} is open for claim. Assign or claim it before delegating.`
  if (projection.state !== 'ready' && projection.state !== 'changes')
    return `Plan node ${nodeId} is ${projection.state}${projection.unknown.length ? ` (${projection.unknown.join(', ')})` : ''}; only a ready node or one whose review requested changes can be delegated.`
  if (!projection.predecessors) return `Plan node ${nodeId} needs current passing predecessor deliveries before dispatch.`
  const executor = projection.node.executor
  if (executor && (executor.hostId !== worker.hostId || executor.agentSessionId !== worker.agentSessionId))
    return `Plan node ${nodeId} names ${executor.agentSessionId} on ${executor.hostId} as its executor; revise the plan to reassign it.`
  if (projection.state === 'changes' && projection.delegation &&
      (projection.delegation.workerAgentSessionId !== worker.agentSessionId || delegationWorkerHostId(projection.delegation) !== worker.hostId) && !executor)
    return `Rework of ${nodeId} goes to its original executor unless the plan reassigns it.`
  return null
}
