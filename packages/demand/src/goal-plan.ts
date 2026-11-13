import type { DemandCriterion } from './goals.js'
import type { DemandDelegation } from './delegations.js'

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
  cancelled?: true
}
export type GoalPlanReviewInput = {
  operationId: string
  nodeId: string
  /** The delegation attempt this verdict judges. */
  delegationOperationId: string
  verdict: 'pass' | 'changes'
  /** Exactly what the reviewer ran and observed; required for a pass. */
  check: { command: string; result: string; evidence: string[] }
  note: string
}
export type GoalPlanReviewer = { kind: 'agent' | 'user' | 'device'; id: string }
export type GoalPlanReview = GoalPlanReviewInput & { reviewer: GoalPlanReviewer; reviewedAt: number }
export type GoalPlanRevisionRecord = { operationId: string; revision: number; author: GoalPlanReviewer; revisedAt: number }
export type GoalPlan = {
  revision: number
  /** The Goal proposal version the node criteria were written against. */
  alignmentRevision: number
  nodes: GoalPlanNodeInput[]
  reviews: GoalPlanReview[]
  /** Append-only provenance of each accepted revision. */
  history: GoalPlanRevisionRecord[]
}
export type GoalPlanRevisionInput = { operationId: string; expectedRevision: number; alignmentRevision: number; nodes: GoalPlanNodeInput[] }

function object(value: unknown, label: string, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const result = value as Record<string, unknown>
  if (Object.keys(result).some(key => !keys.includes(key)) || keys.some(key => !optional.includes(key) && !Object.hasOwn(result, key)))
    throw new Error(`${label} has unsupported or missing fields`)
  return result
}
function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value)) throw new Error(`${label} must be a nonempty single-line identity`)
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
function identities(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  const result = value.map((item, index) => identity(item, `${label}[${index}]`))
  if (new Set(result).size !== result.length) throw new Error(`${label} must not repeat an identity`)
  return result
}
function actor(value: unknown, label: string): GoalPlanReviewer {
  const data = object(value, label, ['kind', 'id'])
  if (data.kind !== 'agent' && data.kind !== 'user' && data.kind !== 'device') throw new Error(`${label}.kind is invalid`)
  return { kind: data.kind, id: identity(data.id, `${label}.id`) }
}

export function parseGoalPlanNode(value: unknown): GoalPlanNodeInput {
  const data = object(value, 'plan node', ['id', 'title', 'outcome', 'dependsOn', 'criterionIds', 'check', 'executor', 'cancelled'], ['cancelled'])
  const executor = data.executor === null ? null : (() => {
    const item = object(data.executor, 'plan node executor', ['hostId', 'agentSessionId'])
    return { hostId: identity(item.hostId, 'executor.hostId'), agentSessionId: identity(item.agentSessionId, 'executor.agentSessionId') }
  })()
  if (data.cancelled !== undefined && data.cancelled !== true) throw new Error('plan node cancelled must be true when present')
  return { id: identity(data.id, 'plan node id'), title: prose(data.title, 'plan node title'), outcome: prose(data.outcome, 'plan node outcome'),
    dependsOn: identities(data.dependsOn, 'plan node dependsOn'), criterionIds: identities(data.criterionIds, 'plan node criterionIds'),
    check: prose(data.check, 'plan node check'), executor, ...(data.cancelled ? { cancelled: true as const } : {}) }
}

export function parseGoalPlanReviewInput(value: unknown): GoalPlanReviewInput {
  const data = object(value, 'plan review', ['operationId', 'nodeId', 'delegationOperationId', 'verdict', 'check', 'note'])
  if (data.verdict !== 'pass' && data.verdict !== 'changes') throw new Error('plan review verdict must be pass or changes')
  const check = object(data.check, 'plan review check', ['command', 'result', 'evidence'])
  if (!Array.isArray(check.evidence) || check.evidence.some(item => typeof item !== 'string' || !item.trim())) throw new Error('plan review evidence must list nonempty locations')
  const review: GoalPlanReviewInput = { operationId: identity(data.operationId, 'review operationId'), nodeId: identity(data.nodeId, 'review nodeId'),
    delegationOperationId: identity(data.delegationOperationId, 'review delegationOperationId'), verdict: data.verdict,
    check: { command: typeof check.command === 'string' ? check.command : '', result: typeof check.result === 'string' ? check.result : '', evidence: check.evidence as string[] },
    note: typeof data.note === 'string' ? data.note : '' }
  if (review.verdict === 'pass' && (!review.check.command.trim() || !review.check.result.trim() || review.check.evidence.length === 0))
    throw new Error('A passing review must record the check it ran, its result and where the evidence is')
  if (review.verdict === 'changes' && !review.note.trim()) throw new Error('A review that requests changes must say what to change')
  return review
}

/** Structural rules: unique ids, dependencies inside the plan, no cycle. */
export function validateGoalPlanNodes(nodes: readonly GoalPlanNodeInput[]): void {
  const ids = new Set<string>()
  for (const node of nodes) {
    if (ids.has(node.id)) throw new Error(`Plan node ${node.id} appears twice`)
    ids.add(node.id)
  }
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (dependency === node.id) throw new Error(`Plan node ${node.id} cannot depend on itself`)
      if (!ids.has(dependency)) throw new Error(`Plan node ${node.id} depends on ${dependency}, which is not in this plan`)
    }
  }
  const byId = new Map(nodes.map(node => [node.id, node]))
  const settled = new Set<string>(), visiting = new Set<string>()
  const visit = (id: string, path: string[]): void => {
    if (settled.has(id)) return
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
  const reviews = data.reviews.map(value => {
    const item = object(value, 'plan review', ['operationId', 'nodeId', 'delegationOperationId', 'verdict', 'check', 'note', 'reviewer', 'reviewedAt'])
    const { reviewer, reviewedAt, ...input } = item
    return { ...parseGoalPlanReviewInput(input), reviewer: actor(reviewer, 'plan reviewer'), reviewedAt: positive(reviewedAt, 'plan review reviewedAt') }
  })
  if (new Set(reviews.map(review => review.operationId)).size !== reviews.length) throw new Error('plan reviews repeat an operation')
  if (reviews.some(review => !nodes.some(node => node.id === review.nodeId))) throw new Error('plan review names an absent node')
  const history = data.history.map(value => {
    const item = object(value, 'plan revision record', ['operationId', 'revision', 'author', 'revisedAt'])
    return { operationId: identity(item.operationId, 'plan revision operationId'), revision: positive(item.revision, 'plan revision'),
      author: actor(item.author, 'plan revision author'), revisedAt: positive(item.revisedAt, 'plan revision revisedAt') }
  })
  const revision = positive(data.revision, 'plan revision')
  if (history.length !== revision || history.some((record, index) => record.revision !== index + 1)) throw new Error('plan history must record every revision in order')
  return { revision, alignmentRevision: positive(data.alignmentRevision, 'plan alignmentRevision'), nodes, reviews, history }
}

export function parseGoalPlanRevisionInput(value: unknown): GoalPlanRevisionInput {
  const data = object(value, 'plan revision', ['operationId', 'expectedRevision', 'alignmentRevision', 'nodes'])
  if (typeof data.expectedRevision !== 'number' || !Number.isSafeInteger(data.expectedRevision) || data.expectedRevision < 0) throw new Error('plan expectedRevision must be a non-negative integer')
  if (!Array.isArray(data.nodes) || data.nodes.length === 0) throw new Error('A plan needs at least one node')
  const nodes = data.nodes.map(parseGoalPlanNode)
  validateGoalPlanNodes(nodes)
  return { operationId: identity(data.operationId, 'plan revision operationId'), expectedRevision: data.expectedRevision,
    alignmentRevision: positive(data.alignmentRevision, 'plan alignmentRevision'), nodes }
}

/** Nodes with recorded work cannot disappear; they are cancelled and keep their records. */
export function assertGoalPlanKeepsRecordedNodes(previous: GoalPlan | undefined, next: readonly GoalPlanNodeInput[], delegations: readonly DemandDelegation[]): void {
  if (!previous) return
  const kept = new Set(next.map(node => node.id))
  for (const node of previous.nodes) {
    if (kept.has(node.id)) continue
    const recorded = delegations.some(delegation => delegation.planNodeId === node.id) || previous.reviews.some(review => review.nodeId === node.id)
    if (recorded) throw new Error(`Plan node ${node.id} has delegations or reviews; mark it cancelled instead of removing it`)
  }
}

/** Criteria of the node that the current proposal no longer has; the plan keeps them, and the reader is told. */
export function staleGoalPlanCriteria(node: GoalPlanNodeInput, criteria: readonly DemandCriterion[]): string[] {
  return node.criterionIds.filter(id => !criteria.some(criterion => criterion.id === id))
}

export type GoalPlanNodeProjection = {
  node: GoalPlanNodeInput
  state: GoalPlanNodeState
  /** 0-based dependency column: one past the deepest dependency. */
  column: number
  /** The current attempt, the newest delegation of this node. */
  delegation: DemandDelegation | null
  attempts: number
  review: GoalPlanReview | null
  staleCriteria: string[]
}
export type GoalPlanProjection = { revision: number; nodes: GoalPlanNodeProjection[]; done: number; total: number; next: string[] }

/**
 * The only place node state is decided. It reads the plan, this Goal's delegations and the
 * current criteria; delivery or Agent idleness never reaches it. Unknown means the delegation
 * was prepared but its Core dispatch link is not confirmed, so the Supervisor must reconcile.
 */
export function projectGoalPlan(plan: GoalPlan, delegations: readonly DemandDelegation[], criteria: readonly DemandCriterion[]): GoalPlanProjection {
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
  const states = new Map<string, GoalPlanNodeState>()
  const attemptsOf = (id: string) => delegations.filter(delegation => delegation.planNodeId === id)
  const stateOf = (node: GoalPlanNodeInput): GoalPlanNodeState => {
    const cached = states.get(node.id)
    if (cached) return cached
    let state: GoalPlanNodeState
    const attempts = attemptsOf(node.id), current = attempts.at(-1)
    const review = current ? plan.reviews.filter(item => item.nodeId === node.id && item.delegationOperationId === current.operationId).at(-1) : undefined
    if (node.cancelled) state = 'cancelled'
    else if (review?.verdict === 'pass') state = 'done'
    else if (review?.verdict === 'changes') state = 'changes'
    else if (current) state = current.linkedAt === undefined ? 'unknown' : current.report ? 'review' : 'working'
    else state = node.dependsOn.every(dependency => stateOf(byId.get(dependency)!) === 'done') ? 'ready' : 'waiting'
    states.set(node.id, state)
    return state
  }
  const nodes = plan.nodes.map(node => {
    const attempts = attemptsOf(node.id), current = attempts.at(-1) ?? null
    const review = current ? plan.reviews.filter(item => item.nodeId === node.id && item.delegationOperationId === current.operationId).at(-1) ?? null : null
    return { node, state: stateOf(node), column: depth(node.id), delegation: current, attempts: attempts.length, review, staleCriteria: staleGoalPlanCriteria(node, criteria) }
  })
  const live = nodes.filter(item => item.state !== 'cancelled')
  return { revision: plan.revision, nodes, done: live.filter(item => item.state === 'done').length, total: live.length,
    next: nodes.filter(item => item.state === 'ready' || item.state === 'changes').map(item => item.node.id) }
}

/** Whether a node may receive a new delegation now, and why not. */
export function goalPlanDelegationIssue(plan: GoalPlan, delegations: readonly DemandDelegation[], criteria: readonly DemandCriterion[], nodeId: string, worker: GoalPlanExecutor): string | null {
  const projection = projectGoalPlan(plan, delegations, criteria).nodes.find(item => item.node.id === nodeId)
  if (!projection) return `Plan node ${nodeId} is not in the current plan.`
  if (projection.state !== 'ready' && projection.state !== 'changes')
    return `Plan node ${nodeId} is ${projection.state}; only a ready node or one whose review requested changes can be delegated.`
  const executor = projection.node.executor
  if (executor && (executor.hostId !== worker.hostId || executor.agentSessionId !== worker.agentSessionId))
    return `Plan node ${nodeId} names ${executor.agentSessionId} on ${executor.hostId} as its executor; revise the plan to reassign it.`
  if (projection.state === 'changes' && projection.delegation && projection.delegation.workerAgentSessionId !== worker.agentSessionId && !executor)
    return `Rework of ${nodeId} goes to its original executor unless the plan reassigns it.`
  return null
}
