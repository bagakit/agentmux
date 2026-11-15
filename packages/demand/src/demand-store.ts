import { isDeepStrictEqual } from 'node:util'
import { parseDemandAgentReference, parseDemandAgentReferences, demandAgentReferenceKey, mergeDemandAgentReferences, type DemandAgentReference } from './agent-reference.js'
import { parseDemandDiscussionInput, parseDemandDiscussionInputs, parseDemandDiscussionIntent, type DemandDiscussionInput, type DemandDiscussionIntent } from './discussion.js'
import { demandPatrolScope, completedGoalPlanRequest, assertPatrolExecutions, parseDemandPatrols, parseDemandPatrolAttempt, parseDemandPatrolReportInput, type DemandPatrolPreparation, type DemandPatrolAttempt, type DemandPatrolReportInput } from './goal-patrol.js'
import { parseDemandDispatch, parseDemandDispatchIntent, parseDemandDispatchRequest, parseDemandDispatches, qualifiedDemandDispatch, runBoundDemandDispatch, sameDemandDispatchIntent, type DemandDispatch, type DemandDispatchIntent, type DemandDispatchRequest, type DemandDispatchRejection } from './dispatch.js'
import { parseDemandDelegationRuntimeIdentity, type DemandDelegationRuntimeIdentity, parseDemandDelegationIntent, parseDemandDelegations, parseDemandDelegationReportInput, parseDemandDelegationCollectionInput, parseDemandDelegationCollector, sameDemandDelegationIntent, validateDemandDelegationReport,
  parseDemandDelegationAttentionInput, sameDemandDelegationAttention, delegationWorkerHostId, sameGoalPlanPredecessors,
  type GoalDeliveryScope, type DemandDelegation, type DemandDelegationIntent, type DemandDelegationReportInput, type DemandDelegationCollectionInput, type DemandDelegationCollector, type DemandDelegationAttentionInput } from './delegations.js'
import { optionalDemandInputEpoch, parseDemandParticipations, parseDemandCreationOrigin, parseDemandParticipationSource, type DemandParticipationSource } from './collaboration.js'
import { appendDemandContentReferences, parseDemandContentReferences } from './content-references.js'
import { demandExecutionReferences, demandExecutionKey, demandHandoffDestinations, demandResponsibilityScope, parseDemandProgressInput, parseDemandProgressUpdates,
  parseDemandResponsibilityBasis, sameDemandExecution, type DemandProgressInput, type DemandProgress, type DemandResponsibilityBasis } from './responsibility.js'
import { mintObjectId } from '@agentmux/identity'
import { promises as fs, type BigIntStats } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import {
  DEMAND_RECEIPT_SCHEMA,
  DEMAND_STORE_SCHEMA,
  type CreateDemandInput,
  type DemandCreateOptions,
  type Demand,
  type DemandActivity,
  type DemandActivityInspection,
  type DemandActivityRead,
  type DemandActivityCollection,
  type DemandDecision,
  type DemandReceipt,
  type DemandStoreListener,
  type DemandStoreSnapshot,
  type DemandStatus,
  type DemandPriority,
  type DemandNameChangePage,
  type DemandNameChangeRecord,
  type DemandTitleMutationOptions,
  type UpdateDemandInput,
  isDemandPriority,
  isDemandStatus,
} from './demand-types.js'
import { DemandStoreError } from './errors.js'
import { GoalActiveIndex, type GoalActivePlan } from './goal-active-index.js'
import { assertGoalPlanKeepsRecordedNodes, goalPlanChangedNodes, goalPlanDelegationIssue, goalTicketTask, matchesGoalPlanReviewInput, parseGoalPlan, parseGoalPlanReviewInput, parseGoalPlanRevisionInput, projectGoalPlan,
  type GoalPlanAssignmentChange, type GoalPlanRevisionRecord, type GoalPlanOwner, type GoalPlanReviewer, type GoalPlanReviewInput, type GoalPlanRevisionInput, type GoalPlanProposalReceipt } from './goal-plan.js'
import { assertIssuedGoalTicket, freezeGoalTicketDependencies, issueGoalTickets } from './goal-ticket-issuance.js'
import type { GoalTicketProof, GoalTicketSigner } from './goal-ticket-proof.js'
import { demandNameContext, parseDemandNameChange } from './demand-name-change.js'
import { alignmentConfirmationIssue, groundingAcceptanceIssue, parseAlignment, parseAlignmentProposal, parseGrounding, parseGroundingProposal, type DemandAlignmentProposal, type DemandGroundingProposal } from './goals.js'

const requireNative = createRequire(import.meta.url)
const WRITER_LOCK_MARKER = 'agentmux.demand-writer-lock.v1\n'
const INITIAL_REVISION = 0
const queues = new Map<string, Promise<void>>()

/** A rejected attempt can have a committed failure record; a write failure cannot claim an ACK. */
export class DemandNameChangeError extends DemandStoreError {
  constructor(error: DemandStoreError, readonly nameChange: DemandNameChangeRecord, readonly commitStatus: 'confirmed' | 'not_applied' | 'unknown') {
    super(error.code, error.phase, error.path,
      `${error.message} ${commitStatus === 'not_applied' ? 'Title change was not applied; its record was not committed.' : commitStatus === 'unknown' ? 'Title snapshot was replaced, but its durable commit is unconfirmed. The operation was not resent.' : nameChange.status === 'failed' ? 'The failed title attempt was recorded; the previous title is retained.' : 'The title change was durably recorded; inspect the original operation.'}`, error)
  }
}

class SnapshotWriteError extends DemandStoreError {
  constructor(storePath: string, cause: unknown, readonly replacementApplied: boolean) {
    super('WRITE_FAILED', 'write', storePath, `Could not atomically write Demand snapshot at ${storePath}`, cause)
  }
}

type TitleAttempt = DemandTitleMutationOptions & { targetId: string; requested: string | null }
type ActivityAttempt = { targetId: string; kind: string; message: string; actorId: string | null }
type DemandSnapshotRead = {
  identity: string | null
  snapshot: DemandStoreSnapshot
  demandsById: ReadonlyMap<string, Demand>
  namesById: ReadonlyMap<string, DemandNameChangeRecord>
}

function snapshotFileIdentity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
}

const ticketDeliverySchema = 'agentmux.ticket-delivery.v2' as const
function ticketDeliveryHash(goalId: string, attempt: DemandDelegation, report: DemandDelegationReportInput, scope: GoalDeliveryScope): string {
  return createHash('sha256').update(JSON.stringify([ticketDeliverySchema, scope.ownerRuntimeId, scope.namespace, goalId,
    attempt.planNodeId, attempt.operationId, scope.authorRuntimeId, report.authorAgentSessionId,
    attempt.predecessors!.map(ref => [ref.nodeId, ref.delegationOperationId, ref.reportOperationId, ref.reviewOperationId, ref.deliveryHash ?? null, ref.completionHash ?? null]),
    report.operationId, report.replyMessageId, report.grounding])).digest('hex')
}

export type OpenDemandStoreOptions = {
  /** Original Runtime authority for signed Goal plan writes. */
  goalTicketSigner?: () => Promise<GoalTicketSigner>
  root: string
  lockTimeoutMs?: number
  lockRetryMs?: number
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string, optional: readonly string[] = []): void {
  const expectedSet = new Set(expected)
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) throw new Error(`${label} has unknown field ${key}`)
  }
  const optionalSet = new Set(optional)
  for (const key of expected) {
    if (!(key in value) && !optionalSet.has(key)) throw new Error(`${label} is missing ${key}`)
  }
}

function optionalValue<T>(value: unknown, fallback: T): T {
  return value === undefined ? fallback : value as T
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`)
  return value
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null
  return nonEmptyString(value, label)
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer timestamp`)
  }
  return value
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  const result = value.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`))
  if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicates`)
  return result
}

function phaseIndex(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer or null`)
  return value as number
}

function parseActivity(value: unknown, label: string): DemandActivity {
  const record = object(value, label)
  exactKeys(record, ['id', 'kind', 'message', 'createdAt', 'actorId', 'operationId', 'nameChangeId'], label, ['operationId', 'nameChangeId'])
  if (record.nameChangeId !== undefined && record.kind !== 'name-change') throw new Error(`${label}.nameChangeId requires the owner activity kind`)
  return {
    id: nonEmptyString(record.id, `${label}.id`),
    kind: nonEmptyString(record.kind, `${label}.kind`),
    message: nonEmptyString(record.message, `${label}.message`),
    createdAt: timestamp(record.createdAt, `${label}.createdAt`),
    actorId: nullableString(record.actorId, `${label}.actorId`),
    ...(record.operationId === undefined ? {} : { operationId: nonEmptyString(record.operationId, `${label}.operationId`) }),
    ...(record.nameChangeId === undefined ? {} : { nameChangeId: nonEmptyString(record.nameChangeId, `${label}.nameChangeId`) }),
  }
}

function parseDecision(value: unknown, label: string): DemandDecision {
  const record = object(value, label)
  exactKeys(record, ['id', 'question', 'decision', 'rationale', 'createdAt', 'actorId'], label)
  return {
    id: nonEmptyString(record.id, `${label}.id`),
    question: nonEmptyString(record.question, `${label}.question`),
    decision: nonEmptyString(record.decision, `${label}.decision`),
    rationale: nonEmptyString(record.rationale, `${label}.rationale`),
    createdAt: timestamp(record.createdAt, `${label}.createdAt`),
    actorId: nullableString(record.actorId, `${label}.actorId`),
  }
}

function parseDemand(value: unknown, label: string): Demand {
  const record = object(value, label)
  exactKeys(record, [
    'id',
    'title',
    'description',
    'status',
    'priority',
    'projectId',
    'projectName',
    'executorId',
    'tags',
    'plannedStartAt',
    'targetAt',
    'parentDemandId',
    // Retired: a Goal plan now carries ordering; an existing null key is dropped on read.
    'phaseIndex',
    'sessionIds',
    'assigneeSessionIds',
    'supervisorSessionId',
    'participations',
    'creationOrigin',
    'discussionOperationId',
    'discussionIntent',
    'discussionInputs',
    'contentRefs',
    'dispatches',
    'delegations',
    'progressUpdates',
    'patrols',
    'plan',
    'activities',
    'decisions',
    'alignment',
    'grounding',
    'createdAt',
    'updatedAt',
  ], label, ['tags', 'plannedStartAt', 'targetAt', 'parentDemandId', 'phaseIndex', 'alignment', 'grounding', 'contentRefs', 'assigneeSessionIds', 'supervisorSessionId', 'participations', 'creationOrigin', 'discussionOperationId', 'discussionIntent', 'discussionInputs', 'dispatches', 'delegations', 'progressUpdates', 'patrols', 'plan'])
  if (!isDemandStatus(record.status)) throw new Error(`${label}.status is invalid`)
  if (!isDemandPriority(record.priority)) throw new Error(`${label}.priority is invalid`)
  if (!Array.isArray(record.activities)) throw new Error(`${label}.activities must be an array`)
  if (!Array.isArray(record.decisions)) throw new Error(`${label}.decisions must be an array`)
  const tags = record.tags === undefined ? [] : stringArray(record.tags, `${label}.tags`)
  const plannedStartAt = record.plannedStartAt === undefined || record.plannedStartAt === null ? null : timestamp(record.plannedStartAt, `${label}.plannedStartAt`)
  const targetAt = record.targetAt === undefined || record.targetAt === null ? null : timestamp(record.targetAt, `${label}.targetAt`)
  const parentDemandId = record.parentDemandId === undefined ? null : nullableString(record.parentDemandId, `${label}.parentDemandId`)
  const activities = record.activities.map((entry, index) => parseActivity(entry, `${label}.activities[${index}]`))
  const sessionIds = parseDemandAgentReferences(record.sessionIds)
  const assigneeSessionIds = record.assigneeSessionIds === undefined ? [] : parseDemandAgentReferences(record.assigneeSessionIds)
  const supervisorSessionId = record.supervisorSessionId === undefined ? null : record.supervisorSessionId === null ? null : parseDemandAgentReference(record.supervisorSessionId)
  const related = new Set(sessionIds.map(demandAgentReferenceKey)), assigned = new Set(assigneeSessionIds.map(demandAgentReferenceKey))
  if (assigneeSessionIds.some(ref => !related.has(demandAgentReferenceKey(ref))) || supervisorSessionId !== null && !assigned.has(demandAgentReferenceKey(supervisorSessionId))) throw new Error(`${label} has inconsistent collaboration relations`)
  const participations = parseDemandParticipations(record.participations ?? [])
  const creationOrigin = record.creationOrigin === undefined ? undefined : parseDemandCreationOrigin(record.creationOrigin)
  if (record.discussionIntent !== undefined && record.discussionOperationId === undefined) throw new Error(`${label} has no original discussion operation`)
  if (creationOrigin?.requesterParticipationId && !participations.some(item => item.id === creationOrigin.requesterParticipationId)) throw new Error(`${label} references an absent original requester`)
  return {
    id: nonEmptyString(record.id, `${label}.id`),
    title: nonEmptyString(record.title, `${label}.title`),
    description: typeof record.description === 'string' ? record.description : (() => { throw new Error(`${label}.description must be a string`) })(),
    status: record.status,
    priority: record.priority,
    projectId: nullableString(record.projectId, `${label}.projectId`),
    projectName: nullableString(record.projectName, `${label}.projectName`),
    executorId: nullableString(record.executorId, `${label}.executorId`),
    tags,
    plannedStartAt,
    targetAt,
    parentDemandId, phaseIndex: phaseIndex(record.phaseIndex, `${label}.phaseIndex`),
    sessionIds, assigneeSessionIds, supervisorSessionId, participations,
    ...(creationOrigin === undefined ? {} : { creationOrigin }),
    ...(record.discussionOperationId === undefined ? {} : { discussionOperationId: nonEmptyString(record.discussionOperationId, `${label}.discussionOperationId`) }),
    ...(record.discussionInputs === undefined ? {} : { discussionInputs: parseDemandDiscussionInputs(record.discussionInputs) }),
    ...(record.discussionIntent === undefined ? {} : { discussionIntent: parseDemandDiscussionIntent(record.discussionIntent) }),
    ...(record.contentRefs === undefined ? {} : { contentRefs: parseDemandContentReferences(record.contentRefs) }),
    dispatches: parseDemandDispatches(record.dispatches ?? [], nonEmptyString(record.id, `${label}.id`)),
    ...(record.delegations === undefined ? {} : { delegations: parseDemandDelegations(record.delegations) }),
    ...(record.progressUpdates === undefined ? {} : { progressUpdates: parseDemandProgressUpdates(record.progressUpdates) }),
    ...(record.patrols === undefined ? {} : { patrols: parseDemandPatrols(record.patrols) }),
    ...(record.plan === undefined ? {} : { plan: parseGoalPlan(record.plan) }),
    activities,
    decisions: record.decisions.map((entry, index) => parseDecision(entry, `${label}.decisions[${index}]`)),
    ...(record.alignment === undefined ? {} : { alignment: parseAlignment(record.alignment) }),
    ...(record.grounding === undefined ? {} : { grounding: parseGrounding(record.grounding) }),
    createdAt: timestamp(record.createdAt, `${label}.createdAt`),
    updatedAt: timestamp(record.updatedAt, `${label}.updatedAt`),
  }
}

function parseSnapshot(value: unknown, storePath: string): DemandStoreSnapshot {
  try {
    const record = object(value, 'snapshot')
    exactKeys(record, ['schema', 'revision', 'updatedAt', 'demands', 'nameHistory', 'retiredGoals'], 'snapshot', ['nameHistory', 'retiredGoals'])
    if (record.schema !== DEMAND_STORE_SCHEMA) throw new Error('snapshot.schema is invalid')
    if (typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision) || record.revision < 0) {
      throw new Error('snapshot.revision must be a non-negative integer')
    }
    if (!Array.isArray(record.demands)) throw new Error('snapshot.demands must be an array')
    const demands = record.demands.map((entry, index) => parseDemand(entry, `snapshot.demands[${index}]`))
    if (new Set(demands.map((demand) => demand.id)).size !== demands.length) {
      throw new Error('snapshot.demands contains duplicate IDs')
    }
    if (record.retiredGoals !== undefined && !Array.isArray(record.retiredGoals)) throw new Error('snapshot.retiredGoals must be an array')
    const retiredGoals = (record.retiredGoals ?? [] as unknown[]).map(value => {
      const item = object(value, 'retired Goal')
      exactKeys(item, ['id', 'creationOperationId'], 'retired Goal', ['creationOperationId'])
      return { id: nonEmptyString(item.id, 'retired Goal ID'),
        ...(item.creationOperationId === undefined ? {} : { creationOperationId: nonEmptyString(item.creationOperationId, 'retired Goal creation operation') }) }
    })
    const allIds = new Set(demands.map(demand => demand.id))
    for (const goal of retiredGoals) {
      if (allIds.has(goal.id)) throw new Error('snapshot reuses a retired Goal ID')
      allIds.add(goal.id)
    }
    const activityOperations = demands.flatMap(demand => demand.activities.flatMap(activity => activity.operationId === undefined ? [] : [activity.operationId]))
    if (new Set(activityOperations).size !== activityOperations.length) throw new Error('snapshot.activities contains duplicate operation IDs')
    if (record.nameHistory !== undefined && !Array.isArray(record.nameHistory)) throw new Error('snapshot.nameHistory must be an array')
    const nameHistory = (record.nameHistory ?? [] as unknown[]).map(parseDemandNameChange)
    const names = new Map(nameHistory.map(change => [change.id, change]))
    if (names.size !== nameHistory.length) throw new Error('snapshot.nameHistory contains duplicate operation IDs')
    for (const demand of demands) for (const activity of demand.activities) {
      if (activity.nameChangeId !== undefined && names.get(activity.nameChangeId)?.target.id !== demand.id)
        throw new Error('snapshot activity references an absent or different name target')
    }
    return {
      schema: DEMAND_STORE_SCHEMA,
      revision: record.revision,
      updatedAt: timestamp(record.updatedAt, 'snapshot.updatedAt'),
      demands,
      nameHistory,
      ...(retiredGoals.length ? { retiredGoals } : {}),
    }
  } catch (error) {
    throw new DemandStoreError('INVALID_SNAPSHOT', 'validate', storePath, `Invalid Demand snapshot at ${storePath}: ${error instanceof Error ? error.message : String(error)}`, error)
  }
}

function inputString(value: string | undefined, label: string, allowEmpty = false): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) throw new DemandStoreError('INVALID_INPUT', 'validate', '', `${label} must be a non-empty string`)
  return value
}

function ensureStatus(value: DemandStatus | undefined, label: string): DemandStatus | undefined {
  if (value === undefined) return undefined
  if (!isDemandStatus(value)) throw new DemandStoreError('INVALID_INPUT', 'validate', '', `${label} is invalid`)
  return value
}

function ensurePriority(value: DemandPriority | undefined, label: string): DemandPriority | undefined {
  if (value === undefined) return undefined
  if (!isDemandPriority(value)) throw new DemandStoreError('INVALID_INPUT', 'validate', '', `${label} is invalid`)
  return value
}

export class DemandStore {
  readonly root: string
  readonly storePath: string
  readonly lockPath: string
  private readonly goalTicketSigner: OpenDemandStoreOptions['goalTicketSigner']
  private readonly lockTimeoutMs: number
  private readonly lockRetryMs: number
  private readonly listeners = new Set<DemandStoreListener>()
  private readonly activeIndex: GoalActiveIndex
  private readonly activeIndexPath: string
  private activeIndexRepair: Promise<void> | undefined
  private snapshotReadCache: DemandSnapshotRead | undefined
  private snapshotReadFlight: { identity: string; promise: Promise<DemandSnapshotRead> } | undefined

  constructor(options: OpenDemandStoreOptions) {
    if (typeof options.root !== 'string' || options.root.trim() === '') {
      throw new DemandStoreError('INVALID_INPUT', 'validate', '', 'root must be a non-empty path')
    }
    this.root = path.resolve(options.root)
    this.goalTicketSigner = options.goalTicketSigner
    this.storePath = path.join(this.root, 'store.json')
    this.lockPath = path.join(this.root, 'store.lock')
    this.activeIndexPath = path.join(this.root, 'active-goals.sqlite')
    this.activeIndex = new GoalActiveIndex(this.activeIndexPath)
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000
    this.lockRetryMs = options.lockRetryMs ?? 25
    if (!Number.isSafeInteger(this.lockTimeoutMs) || this.lockTimeoutMs < 0) {
      throw new DemandStoreError('INVALID_INPUT', 'validate', this.root, 'lockTimeoutMs must be a non-negative integer')
    }
  }

  subscribe(listener: DemandStoreListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async snapshot(): Promise<DemandStoreSnapshot> {
    return projectNameHistory((await this.readConfirmedSnapshot()).snapshot)
  }

  /** Mutable transactions/readers receive their own copy, never the retained parsed file. */
  private async readSnapshot(): Promise<DemandStoreSnapshot> {
    return clone((await this.readConfirmedSnapshot()).snapshot)
  }

  /** File identity is checked on every read; only one stable original file is cached. */
  private async readConfirmedSnapshot(): Promise<DemandSnapshotRead> {
    try {
      const identity = snapshotFileIdentity(await fs.stat(this.storePath, { bigint: true }))
      if (this.snapshotReadCache?.identity === identity) return this.snapshotReadCache
      let flight = this.snapshotReadFlight
      if (flight?.identity !== identity) {
        const pending: { identity: string; promise: Promise<DemandSnapshotRead> } = {
          identity, promise: this.readStableSnapshot().finally(() => {
            if (this.snapshotReadFlight === pending) this.snapshotReadFlight = undefined
          }) }
        this.snapshotReadFlight = pending
        flight = pending
      }
      return await flight!.promise
    } catch (error) {
      this.snapshotReadCache = undefined
      if (error instanceof DemandStoreError) throw error
      if (isNodeError(error, 'ENOENT')) return this.indexSnapshot(emptySnapshot(), null)
      if (error instanceof SyntaxError) {
        throw new DemandStoreError('INVALID_SNAPSHOT', 'read', this.storePath, `Demand snapshot is not valid JSON at ${this.storePath}`, error)
      }
      throw new DemandStoreError('READ_FAILED', 'read', this.storePath, `Could not read Demand snapshot at ${this.storePath}`, error)
    }
  }

  private async readStableSnapshot(): Promise<DemandSnapshotRead> {
    const file = await fs.open(this.storePath, 'r')
    try {
      const before = await file.stat({ bigint: true }), identity = snapshotFileIdentity(before)
      const raw = await fs.readFile(file, 'utf8')
      const after = await file.stat({ bigint: true })
      // Replacing the path unlinks this old inode (ctime/nlink), without editing its bytes.
      const contentChanged = before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs
      const changedInPlace = before.ctimeNs !== after.ctimeNs && before.nlink === after.nlink
      if (contentChanged || changedInPlace) throw new DemandStoreError('READ_FAILED', 'read', this.storePath,
        `Demand snapshot changed while its original file was being read at ${this.storePath}; current facts are unconfirmed. Read the original store again.`)
      const read = this.indexSnapshot(parseSnapshot(JSON.parse(raw) as unknown, this.storePath), identity)
      this.snapshotReadCache = read
      return read
    } finally { await file.close() }
  }

  private indexSnapshot(snapshot: DemandStoreSnapshot, identity: string | null): DemandSnapshotRead {
    return { identity, snapshot, demandsById: new Map(snapshot.demands.map(demand => [demand.id, demand])),
      namesById: new Map(snapshot.nameHistory.map(change => [change.id, change])) }
  }

  async list(): Promise<Demand[]> {
    return (await this.snapshot()).demands
  }

  async get(id: string): Promise<Demand | null> {
    const read = await this.readConfirmedSnapshot(), demand = read.demandsById.get(id)
    if (!demand) return null
    const { activities, ...content } = demand
    return { ...clone(content), activities: projectActivities(activities, read.namesById) }
  }

  async readActivePlans(target: { goalId?: string; agentSessionId?: string }): Promise<GoalActivePlan[]> {
    try {
      const generation = await this.currentSnapshotIdentity()
      if (generation === null) return []
      const rows = this.activeIndex.read(generation, target)
      if (rows && generation === await this.currentSnapshotIdentity()) return rows
    } catch (error) {
      if (!(error instanceof Error)) throw error
    }
    this.scheduleActiveIndexRepair()
    throw new DemandStoreError('READ_FAILED', 'read', this.storePath,
      'The original active Goal index is unconfirmed and is being rebuilt. The original plans and retained history can still be read.')
  }

  private async currentSnapshotIdentity(): Promise<string | null> {
    try { return snapshotFileIdentity(await fs.stat(this.storePath, { bigint: true })) }
    catch (error) { if (isNodeError(error, 'ENOENT')) return null; throw error }
  }

  private scheduleActiveIndexRepair(): void {
    if (this.activeIndexRepair) return
    const repair = enqueue(this.root, () => this.withWriterLock(async () => {
      const { identity, snapshot } = await this.readConfirmedSnapshot()
      if (!identity) return
      const rebuilding = path.join(this.root, 'active-goals.rebuilding-' + mintObjectId() + '.sqlite')
      try {
        new GoalActiveIndex(rebuilding).publish(identity, null, null, () => snapshot.demands)
        if (identity === await this.currentSnapshotIdentity()) {
          // An interrupted projection transaction can leave its own journal. Both files
          // belong to this derived index. The original writer lock excludes index producers.
          await fs.rm(this.activeIndexPath + '-journal', { force: true })
          await fs.rename(rebuilding, this.activeIndexPath)
        }
      } finally {
        await fs.rm(rebuilding, { force: true }).catch(() => undefined)
      }
    })).catch(error => {
      console.warn('The active Goal index could not be repaired. Original Goals and history are retained.', error)
    }).finally(() => {
      if (this.activeIndexRepair === repair) this.activeIndexRepair = undefined
    })
    this.activeIndexRepair = repair
  }

  async originalGoalCreationId(operationId: string): Promise<string | undefined> {
    const { snapshot } = await this.readConfirmedSnapshot()
    if (snapshot.retiredGoals?.some(goal => goal.creationOperationId === operationId))
      throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'This creation operation belongs to a removed Goal. Use a new Goal identity for new work.')
    const matches = snapshot.demands.filter(goal => goal.creationOrigin?.operationId === operationId)
    if (matches.length > 1) throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'The original Goal creation operation names multiple Goals; use its exact Goal ID.')
    return matches[0]?.id
  }

  async read(id: string): Promise<Demand | null> {
    return this.get(id)
  }

  async listNameChanges(id: string, options: { offset?: number; limit?: number } = {}): Promise<DemandNameChangePage> {
    const offset = options.offset ?? 0
    const limit = options.limit ?? 50
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'Name history requires a non-negative offset and a limit from 1 to 100.')
    }
    const snapshot = await this.readSnapshot()
    const records = snapshot.nameHistory.filter(change => change.target.id === id)
    return { revision: snapshot.revision, records: records.slice(offset, offset + limit), nextOffset: offset + limit < records.length ? offset + limit : null }
  }

  async create(input: CreateDemandInput, options: DemandCreateOptions = {}): Promise<DemandReceipt> {
    rejectProvenanceInput(input)
    if (Object.hasOwn(input, 'dispatches')) throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'Only the actual Goal Start input owner records dispatch facts.')
    const operationId = options.operationId ?? mintObjectId()
    return this.mutate('create', (snapshot) => {
      const title = inputString(input.title, 'title')
      if (!title) throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'title is required')
      const id = input.id ?? mintObjectId()
      inputString(id, 'id')
      if (snapshot.retiredGoals?.some(goal => goal.id === id || goal.creationOperationId === operationId))
        throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'This original Goal identity or creation operation has been retired.')
      const original = snapshot.demands.find(goal => goal.id === id)
      if (original && options.discussionOperationId && original.discussionOperationId === options.discussionOperationId && original.creationOrigin?.operationId === operationId) {
        const expected = { title, description: input.description ?? '', projectId: input.projectId ?? null, priority: input.priority ?? 'normal', status: input.status ?? 'backlog',
          assigneeSessionIds: [...(input.assigneeSessionIds ?? [])], supervisorSessionId: input.supervisorSessionId ?? null,
          sessionIds: mergeDemandAgentReferences(input.sessionIds ?? [], input.assigneeSessionIds ?? []), tags: [...(input.tags ?? [])],
          plannedStartAt: input.plannedStartAt ?? null, targetAt: input.targetAt ?? null, parentDemandId: input.parentDemandId ?? null, phaseIndex: phaseIndex(input.phaseIndex, 'phaseIndex'), contentRefs: input.contentRefs }
        if (Object.entries(expected).some(([key, value]) => JSON.stringify(original[key as keyof Demand]) !== JSON.stringify(value)))
          throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'The original Goal creation is retained but its current content differs. Inspect that same Goal without creating another.')
        return { unchanged: original }
      }
      if (snapshot.demands.some((entry) => entry.id === id)) {
        throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, `Demand ${id} already exists`)
      }
      const now = Date.now()
      const demand: Demand = {
        id,
        title,
        description: input.description ?? '',
        status: ensureStatus(input.status, 'status') ?? 'backlog',
        priority: ensurePriority(input.priority, 'priority') ?? 'normal',
        projectId: input.projectId ?? null,
        projectName: input.projectName ?? null,
        executorId: null,
        tags: [...(input.tags ?? [])],
        plannedStartAt: input.plannedStartAt ?? null,
        targetAt: input.targetAt ?? null,
        parentDemandId: input.parentDemandId ?? null,
        phaseIndex: phaseIndex(input.phaseIndex, 'phaseIndex'),
        sessionIds: mergeDemandAgentReferences(input.sessionIds ?? [], input.assigneeSessionIds ?? []),
        assigneeSessionIds: [...(input.assigneeSessionIds ?? [])],
        supervisorSessionId: input.supervisorSessionId ?? null,
        participations: [],
        ...(options.creationOrigin ? { creationOrigin: { operationId, ...optionalDemandInputEpoch(options.creationOrigin.inputEpoch), ...(options.creationOrigin.inputRuntimeId === undefined ? {} : { inputRuntimeId: options.creationOrigin.inputRuntimeId }), requesterAsSupervisor: options.creationOrigin.requesterAsSupervisor,
          requesterParticipationId: null, supervisorDefaultPending: options.creationOrigin.requesterAsSupervisor && !Object.hasOwn(input, 'supervisorSessionId') } } : {}),
        ...(options.discussionOperationId === undefined ? {} : { discussionOperationId: nonEmptyString(options.discussionOperationId, 'discussionOperationId') }),
        ...(input.contentRefs === undefined ? {} : { contentRefs: [...input.contentRefs] }),
        activities: [],
        decisions: [],
        createdAt: now,
        updatedAt: now,
      }
      if (options.participation) appendParticipation(demand, options.participation, operationId, now)
      if (options.participation?.kind === 'create' && demand.creationOrigin) resolveCreationRequester(demand, options.participation, operationId, true)
      validateNewDemand(demand, this.storePath)
      snapshot.demands.push(demand)
      return demand
    }, undefined, operationId)
  }

  /** Authenticated Host supplies author and observed basis; an editable phase cannot release work. */
  async recordProgress(id: string, raw: DemandProgressInput, authority: {
    author: DemandProgress['author']; reportingRunId: string | null; basis: DemandResponsibilityBasis
  }): Promise<DemandReceipt> {
    const input = parseDemandProgressInput(raw), basis = parseDemandResponsibilityBasis(authority.basis)
    return this.mutate('responsibility.progress', snapshot => {
      const goal = findDemand(snapshot, id, this.storePath)
      const priorGoal = snapshot.demands.find(item => item.progressUpdates?.some(update => update.operationId === input.operationId))
      const prior = priorGoal?.progressUpdates?.find(update => update.operationId === input.operationId)
      if (prior) {
        const { author, reportingRunId: _run, recordedAt: _at, basis: _basis, managerVerified: _verified, reviewForHuman: _human, ...original } = prior
        if (priorGoal!.id !== id || JSON.stringify(original) !== JSON.stringify(input) || author.kind !== authority.author.kind || author.id !== authority.author.id)
          this.rejectDelegation('This original progress operation belongs to another input or author. Read it without rewriting responsibility.')
        return { unchanged: goal }
      }
      if (demandResponsibilityScope(goal) !== input.expectedScope) this.rejectDelegation('The original responsibility changed. Read this same Goal before recording progress.')
      this.applyProgress(goal, input, authority, basis)
      return goal
    }, undefined, input.operationId)
  }

  private applyProgress(goal: Demand, input: DemandProgressInput, authority: { author: DemandProgress['author']; reportingRunId: string | null; reviewForHuman?: boolean }, basis: DemandResponsibilityBasis): void {
    if (!demandExecutionReferences(goal).some(ref => sameDemandExecution(ref, input.execution))) this.rejectDelegation('Progress is not for an original execution in this Goal.')
    const managerVerified = authority.author.kind !== 'agent' || authority.author.id === goal.supervisorSessionId
    if (!managerVerified && ('target' in input.execution || authority.author.id !== input.execution.agentSessionId || authority.reportingRunId !== input.execution.runId))
      this.rejectDelegation('Only the original worker Run or current management authority can record this progress.')
    if (input.phase === 'waiting-external' && (basis.stateEnteredAt === null || !input.evidence.length))
      this.rejectDelegation('External waiting needs an observed original state basis and evidence for its condition; existing Agent input remains available.')
    if (input.phase === 'review') {
      const delegation = input.execution.kind === 'delegation' ? goal.delegations?.find(item => item.operationId === input.execution.operationId) : undefined
      const grounding = managerVerified && input.groundingSubmissionId && goal.grounding?.submissionId === input.groundingSubmissionId && goal.grounding.alignmentRevision === goal.alignment?.revision
      if (!delegation?.report && !grounding) this.rejectDelegation('Review requires this worker report or a current result explicitly associated by its manager. Goal-level result timing is not attribution.')
    }
    if (input.handoffExecution) {
      const target = demandExecutionReferences(goal).find(ref => sameDemandExecution(ref, input.handoffExecution!))
      const confirmed = target?.kind === 'start' ? goal.dispatches?.some(item => item.operationId === target.operationId && item.stage === 'confirmed')
        : target && goal.delegations?.some(item => item.operationId === target.operationId && item.linkedAt !== undefined)
      if (!confirmed || sameDemandExecution(input.execution, input.handoffExecution)) this.rejectDelegation('Handoff requires a different already-bound original execution, not a proposed next Agent.')
    }
    const now = Date.now()
    const updates = [...goal.progressUpdates ?? [], { ...input, ...authority, basis, managerVerified, recordedAt: now, ...(input.phase === 'review' ? { reviewForHuman: managerVerified && (authority.reviewForHuman ?? true) } : {}) }]
    if (input.handoffExecution && managerVerified && demandHandoffDestinations({ ...goal, progressUpdates: updates }).get(demandExecutionKey(input.execution)) === null)
      this.rejectDelegation('Accepted handoffs cannot form a cycle or lose the actual responsible execution.')
    goal.progressUpdates = updates
    goal.activities.push({ id: mintObjectId(), kind: 'progress', message: input.summary, actorId: authority.author.id, operationId: input.operationId, createdAt: now })
    goal.updatedAt = Math.max(now, goal.updatedAt + 1)
  }

  /** Main freezes the original Goal/manager/input before any native attempt. */
  async preparePatrol(id: string, input: DemandPatrolPreparation): Promise<DemandReceipt> {
    return this.mutate('patrol.prepare', snapshot => {
      const goal = findDemand(snapshot, id, this.storePath)
      const priorGoal = snapshot.demands.find(item => item.patrols?.some(p => (p.operationId === input.operationId || p.requestOperationIds?.includes(input.operationId))))
      if (priorGoal) {
        if (priorGoal.id !== id || priorGoal.patrols!.find(p => (p.operationId === input.operationId || p.requestOperationIds?.includes(input.operationId)))!.purpose !== input.purpose) this.rejectDelegation('This patrol operation belongs to another original Goal.')
        return { unchanged: goal }
      }
      if (demandPatrolScope(goal, input.purpose) !== input.expectedScope || goal.supervisorSessionId !== input.supervisorAgentSessionId)
        this.rejectDelegation('The frozen Goal responsibility changed before inspection preparation.')
      const retained = [...goal.patrols ?? []].reverse().find(p => !p.report && p.purpose === input.purpose && !completedGoalPlanRequest(goal, p) && p.expectedScope === input.expectedScope)
      if (retained) {
        if (input.purpose !== 'plan') return { unchanged: goal }
        retained.requestOperationIds = [...retained.requestOperationIds ?? [], input.operationId]
        goal.updatedAt = Math.max(Date.now(), goal.updatedAt + 1)
        return goal
      }
      if (input.purpose !== 'plan') assertPatrolExecutions(goal, input)
      if (input.attempt && input.attempt.target.agentSessionId !== goal.supervisorSessionId) this.rejectDelegation('The original patrol target is not this Goal Supervisor.')
      const now = Date.now(), { attempt, ...request } = input
      const patrol = parseDemandPatrols([{ ...request, ...(goal.alignment ? { alignment: goal.alignment } : {}), requestedAt: now, attempts: attempt ? [{ ...attempt, preparedAt: now }] : [] }])[0]!
      goal.patrols = [...goal.patrols ?? [], patrol]; goal.updatedAt = Math.max(now, goal.updatedAt + 1)
      return goal
    }, undefined, input.operationId)
  }

  async markPatrolAttempt(id: string, patrolId: string, inputOperationId: string): Promise<DemandReceipt> {
    return this.mutate('patrol.attempt', snapshot => {
      const goal = findDemand(snapshot, id, this.storePath), patrol = goal.patrols?.find(p => p.operationId === patrolId), attempt = patrol?.attempts.at(-1)
      if (!patrol || !attempt || attempt.operationId !== inputOperationId || attempt.supersededAt || patrol.report ||
        demandPatrolScope(goal, patrol.purpose) !== patrol.expectedScope || goal.supervisorSessionId !== attempt.target.agentSessionId)
        this.rejectDelegation('The original patrol admission was superseded; its native input was not replaced.')
      if (attempt.attemptedAt) return { unchanged: goal }
      attempt.attemptedAt = Date.now(); goal.updatedAt = Math.max(attempt.attemptedAt, goal.updatedAt + 1)
      return goal
    })
  }

  /** Only after old Core claim absence and future-intent cancellation; original attempts stay immutable. */
  async continuePatrol(id: string, patrolId: string, oldInputOperationId: string | null, raw: Omit<DemandPatrolAttempt, 'preparedAt'>): Promise<DemandReceipt> {
    const next = parseDemandPatrolAttempt({ ...raw, preparedAt: Date.now() })
    return this.mutate('patrol.continue', snapshot => {
      const goal = findDemand(snapshot, id, this.storePath), patrol = goal.patrols?.find(p => p.operationId === patrolId)
      if (!patrol) this.rejectDelegation('The original patrol is absent.')
      const sameAction = patrol.attempts.find(a => a.actionOperationId === next.actionOperationId)
      if (sameAction) {
        const { preparedAt: _a, attemptedAt: _b, supersededAt: _c, ...original } = sameAction
        const { preparedAt: _d, ...intent } = next
        if (JSON.stringify(original) !== JSON.stringify(intent)) this.rejectDelegation('The original continuation action has different frozen content.')
        return { unchanged: goal }
      }
      const old = patrol.attempts.at(-1)
      if (patrol.report || patrol.attempts.some(a => a.attemptedAt) || (old?.operationId ?? null) !== oldInputOperationId || old?.supersededAt ||
        patrol.supervisorAgentSessionId !== next.target.agentSessionId || goal.supervisorSessionId !== next.target.agentSessionId || demandPatrolScope(goal, patrol.purpose) !== patrol.expectedScope)
        this.rejectDelegation('The old request changed or may have attempted input. Keep its exact receipt; no new attempt is admitted.')
      if (old) old.supersededAt = next.preparedAt
      patrol.attempts.push(next); goal.updatedAt = Math.max(next.preparedAt, goal.updatedAt + 1)
      return goal
    }, undefined, next.actionOperationId)
  }

  /** A stale actual PMO report is retained, but cannot overwrite later Goal work. */
  async recordPatrolReport(id: string, patrolId: string, raw: DemandPatrolReportInput, author: { agentSessionId: string; runId: string },
    bases: ReadonlyMap<string, DemandResponsibilityBasis | null>): Promise<DemandReceipt> {
    const report = parseDemandPatrolReportInput(raw)
    return this.mutate('patrol.report', snapshot => {
      const goal = findDemand(snapshot, id, this.storePath), patrol = goal.patrols?.find(p => p.operationId === patrolId)
      if (patrol?.purpose === 'plan') this.rejectDelegation('A planning request is completed by saving a Goal plan, not by an inspection report. Read goal plan and goal plan revise.')
      if (!patrol || patrol.supervisorAgentSessionId !== author.agentSessionId) this.rejectDelegation('Only the original PMO can return this retained inspection.')
      const duplicate = snapshot.demands.flatMap(g => g.patrols ?? []).find(p => p.report?.operationId === report.operationId)
      if (duplicate && duplicate !== patrol) this.rejectDelegation('This report operation belongs to another original patrol.')
      if (patrol.report) {
        const { authorAgentSessionId, reportingRunId: _run, reportedAt: _at, applied: _applied, reason: _reason, ...original } = patrol.report
        if (authorAgentSessionId !== author.agentSessionId || JSON.stringify(original) !== JSON.stringify(report)) this.rejectDelegation('The original inspection report is immutable. Read its saved result.')
        return { unchanged: goal }
      }
      const criteria = patrol.alignment?.criteria ?? []
      if (patrol.alignment ? !report.grounding || report.grounding.alignmentRevision !== patrol.alignment.revision || report.grounding.checks.length !== criteria.length ||
        criteria.some(c => !report.grounding!.checks.some(check => check.criterionId === c.id)) : report.grounding !== undefined)
        this.rejectDelegation('Inspection must return each frozen criterion with evidence, a gap or an unknown; missing original alignment remains unknown.')
      for (const update of report.progress) {
        if (update.expectedScope !== patrol.expectedScope || !patrol.executions.some(ref => sameDemandExecution(ref, update.execution))) this.rejectDelegation('Inspection progress must name this patrol’s exact original execution scope.')
        if (snapshot.demands.some(g => g.progressUpdates?.some(u => u.operationId === update.operationId))) this.rejectDelegation('This inspection progress operation was already used. Keep the original declaration.')
      }
      const applied = demandPatrolScope(goal, patrol.purpose) === patrol.expectedScope && goal.supervisorSessionId === author.agentSessionId && goal.grounding?.acceptedAt == null
      if (applied && report.nextOwner.kind === 'agent' && report.nextOwner.agentSessionId !== goal.supervisorSessionId &&
        !demandExecutionReferences(goal).some(ref => !('target' in ref) && ref.agentSessionId === report.nextOwner.agentSessionId)) this.rejectDelegation('The next responsible Agent must be bound to this original Goal.')
      const now = Date.now()
      if (applied) {
        if (report.grounding) goal.grounding = { ...report.grounding, submissionId: mintObjectId(), acceptedAt: null }
        for (const declared of report.progress) {
          const update = declared.phase === 'review' && !declared.groundingSubmissionId && goal.grounding ? { ...declared, groundingSubmissionId: goal.grounding.submissionId } : declared
          this.applyProgress(goal, update, { author: { kind: 'agent', id: author.agentSessionId }, reportingRunId: author.runId, reviewForHuman: report.nextOwner.kind === 'human' },
            bases.get(JSON.stringify(update.execution)) ?? { stateEnteredAt: null, activityRevision: null, inputSubmissionId: null })
          const delegation = update.execution.kind === 'delegation' && update.phase === 'review' ? goal.delegations?.find(d => d.operationId === update.execution.operationId) : undefined
          if (delegation?.report && !delegation.collection) delegation.collection = { operationId: 'patrol-collect:' + report.operationId + ':' + delegation.operationId,
            replyMessageId: delegation.report.replyMessageId, collector: { kind: 'agent', id: author.agentSessionId }, collectedAt: now,
            ...(goal.grounding ? { groundingSubmissionId: goal.grounding.submissionId } : {}) }
        }
        if (report.status !== undefined) goal.status = report.status
      }
      patrol.report = { ...report, authorAgentSessionId: author.agentSessionId, reportingRunId: author.runId, reportedAt: now, applied,
        reason: applied ? 'Actual PMO inspection was written to this original Goal. Human confirmation and acceptance remain separate.' : 'The frozen responsibility or accepted result changed. This late inspection is retained without replacing current work.' }
      goal.activities.push({ id: mintObjectId(), kind: 'progress', message: report.summary + '\nNext: ' + report.nextOwner.action, actorId: author.agentSessionId, operationId: report.operationId, createdAt: now })
      goal.updatedAt = Math.max(now, goal.updatedAt + 1)
      return goal
    }, undefined, report.operationId)
  }

  /** Reserve the original business request before fallible execution preparation.
   * The existing kernel writer lock owns first acceptance across Host processes. */
  async requestDispatch(id: string, input: DemandDispatchRequest, expectedUpdatedAt?: number): Promise<DemandReceipt> {
    const request = parseDemandDispatchRequest(input)
    if (expectedUpdatedAt !== undefined && (!Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt < 0))
      throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'Expected Goal version is invalid.')
    return this.mutate('dispatch.request', snapshot => {
      const demand = findDemand(snapshot, id, this.storePath)
      const owner = snapshot.demands.find(item => item.dispatches?.some(dispatch => dispatch.operationId === request.operationId))
      const original = owner?.dispatches?.find(dispatch => dispatch.operationId === request.operationId)
      if (original) {
        if (owner!.id !== id || !qualifiedDemandDispatch(original) || demandAgentReferenceKey(original.target) !== demandAgentReferenceKey(request.target))
          throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'The original Start operation belongs to another Goal or member. Inspect it without replacing it.')
        return { unchanged: demand }
      }
      const requestedAt = Date.now(), goalUpdatedAt = demand.updatedAt
      const rejection: DemandDispatchRejection | undefined = !demand.assigneeSessionIds.some(value => demandAgentReferenceKey(value) === demandAgentReferenceKey(request.target))
        ? { kind: 'goal-start-assignee-conflict', goalId: id, operationId: request.operationId, currentUpdatedAt: goalUpdatedAt, target: request.target }
        : expectedUpdatedAt !== undefined && expectedUpdatedAt !== goalUpdatedAt
          ? { kind: 'goal-start-version-conflict', goalId: id, operationId: request.operationId, currentUpdatedAt: goalUpdatedAt } : undefined
      const saved: DemandDispatch = rejection ? { ...request, execution: 'finite', stage: 'rejected', requestedAt, observedGoalUpdatedAt: goalUpdatedAt,
        ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }), rejection }
        : { ...request, execution: 'finite', stage: 'requested', prompt: demand.description.trim() || demand.title,
          request: { requestedAt, goalUpdatedAt }, resultBasis: { alignmentRevision: demand.alignment?.revision ?? null,
            criteria: clone(demand.alignment?.criteria ?? []), groundingSubmissionId: demand.grounding?.submissionId ?? null } }
      demand.dispatches = [...(demand.dispatches ?? []), saved]
      demand.updatedAt = Math.max(requestedAt, demand.updatedAt + 1)
      return demand
    }, undefined, request.operationId)
  }

  /** Only the explicit business Start owner calls this; ordinary updates cannot write it. */
  async prepareDispatch(id: string, input: DemandDispatchIntent, expectedUpdatedAt?: number): Promise<DemandReceipt> {
    const intent = parseDemandDispatchIntent(input)
    return this.mutate('dispatch.prepare', snapshot => {
      const demand = findDemand(snapshot, id, this.storePath)
      const owner = snapshot.demands.find(item => item.dispatches?.some(dispatch => dispatch.operationId === intent.operationId))
      const original = owner?.dispatches?.find(dispatch => dispatch.operationId === intent.operationId)
      if (original) {
        if (owner!.id === id && original.stage === 'requested' && qualifiedDemandDispatch(intent) &&
            demandAgentReferenceKey(original.target) === demandAgentReferenceKey(intent.target) && original.prompt === intent.prompt && original.inputEpoch === intent.inputEpoch) {
          demand.dispatches = demand.dispatches!.map(value => value.operationId === intent.operationId
            ? { ...intent, stage: 'prepared', preparedAt: Date.now(), request: original.request, resultBasis: original.resultBasis } : value)
          demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
          return demand
        }
        if (owner!.id !== id || !runBoundDemandDispatch(original) || !sameDemandDispatchIntent(original, intent)) throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'The original Start operation belongs to another Goal, Session, Run or input. Inspect it without resending.')
        return { unchanged: demand }
      }
      if (expectedUpdatedAt !== undefined && (!Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt < 0 || demand.updatedAt !== expectedUpdatedAt)) {
        throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'The Goal changed before this new Start was prepared. Read the current Goal and explicitly start that version. The original Agent remains available.', { kind: 'goal-start-version-conflict', goalId: id, operationId: intent.operationId, currentUpdatedAt: demand.updatedAt })
      }
      demand.dispatches = [...(demand.dispatches ?? []), { ...intent, stage: 'prepared', preparedAt: Date.now(),
        ...(intent.execution === 'finite' ? { resultBasis: { alignmentRevision: demand.alignment?.revision ?? null,
          criteria: clone(demand.alignment?.criteria ?? []), groundingSubmissionId: demand.grounding?.submissionId ?? null } } : {}) }]
      demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
      return demand
    }, undefined, intent.operationId)
  }

  async inspectDispatch(id: string, operationId: string): Promise<DemandDispatch | null> {
    nonEmptyString(operationId, 'dispatch.operationId')
    return enqueue(this.root, async () => {
      return this.withWriterLock(async () => {
        const snapshot = await this.readSnapshot(), demand = findDemand(snapshot, id, this.storePath)
        await this.confirmSnapshot()
        return clone(demand.dispatches?.find(dispatch => dispatch.operationId === operationId) ?? null)
      })
    })
  }

  /** A confirmed native input never regresses because a later reply or observation fails. */
  async recordDispatchPhase(id: string, operationId: string, phase: { stage: 'submitted' | 'unknown'; issue?: string } | { stage: 'confirmed'; receipt: NonNullable<DemandDispatch['receipt']> }): Promise<DemandReceipt> {
    return this.mutate('dispatch.' + phase.stage, snapshot => {
      const demand = findDemand(snapshot, id, this.storePath)
      const dispatches = demand.dispatches ?? [], index = dispatches.findIndex(dispatch => dispatch.operationId === operationId), original = dispatches[index]
      if (!original) throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'The original Start has not been prepared. Preserve the Agent and inspect its exact operation.')
      if (!runBoundDemandDispatch(original)) throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'This business request has no prepared input. Inspect its original request before an explicit continuation.')
      if (original.stage === 'confirmed') return { unchanged: demand }
      const { issue: _issue, ...frozen } = original
      const next = parseDemandDispatch({ ...frozen, stage: phase.stage, submittedAt: original.submittedAt ?? Date.now(), ...(phase.stage === 'confirmed' ? { receipt: phase.receipt } : phase.issue ? { issue: phase.issue } : {}) })
      if (JSON.stringify(original) === JSON.stringify(next)) return { unchanged: demand }
      demand.dispatches = dispatches.map((dispatch, at) => at === index ? next : dispatch)
      demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
      return demand
    }, undefined, operationId)
  }

  /** One notice for the original finite Start; Core retains its native input fact. */
  async prepareDispatchAttention(id: string, operationId: string, input: DemandDelegationAttentionInput): Promise<DemandReceipt> {
    const attention = parseDemandDelegationAttentionInput(input)
    return this.mutate('dispatch.attention-prepare', snapshot => {
      const demand = findDemand(snapshot, id, this.storePath), original = demand.dispatches?.find(item => item.operationId === operationId)
      if (!original) this.rejectDelegation('The original Goal Start is unavailable. Preserve its identity and inspect that operation.')
      const prior = snapshot.demands.flatMap(goal => [
        ...(goal.dispatches ?? []).map(item => ({ kind: 'start', goalId: goal.id, operationId: item.operationId, attention: item.attention })),
        ...(goal.delegations ?? []).map(item => ({ kind: 'delegation', goalId: goal.id, operationId: item.operationId, attention: item.attention }))
      ]).filter(item => item.attention)
        .find(item => item.attention!.operationId === attention.operationId || item.attention!.intentId === attention.intentId)
      if (prior && (prior.kind !== 'start' || prior.goalId !== id || prior.operationId !== operationId)) this.rejectDelegation('The original notice belongs to another business source.')
      if (original.attention) {
        if (!sameDemandDelegationAttention(original.attention, attention)) this.rejectDelegation('The original Start notice is frozen. Inspect it without moving its target or changing its text.')
        return { unchanged: demand }
      }
      if (qualifiedDemandDispatch(original) || original.execution !== 'finite' || original.hostId !== attention.hostId || demand.supervisorSessionId !== attention.supervisorAgentSessionId ||
        demand.status === 'done' || demand.status === 'cancelled') this.rejectDelegation('A Start notice needs its original Host and exact current Supervisor for an open Goal.')
      original.attention = { ...attention, preparedAt: Date.now() }
      demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
      validateNewDemand(demand, this.storePath)
      return demand
    }, undefined, attention.operationId)
  }

  /** Persist the single attempt before any Native claim; uncertainty never resends it. */
  async markDispatchAttentionAttempt(id: string, operationId: string, attentionOperationId: string): Promise<DemandReceipt> {
    return this.mutate('dispatch.attention-attempt', snapshot => {
      const demand = findDemand(snapshot, id, this.storePath), original = demand.dispatches?.find(item => item.operationId === operationId)
      if (!original?.attention || original.attention.operationId !== attentionOperationId) this.rejectDelegation('The notice attempt must name the exact original Start input.')
      if (original.attention.attemptedAt !== undefined) return { unchanged: demand }
      original.attention.attemptedAt = Date.now()
      demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
      return demand
    }, undefined, attentionOperationId)
  }

  private async readTicketSigner(): Promise<GoalTicketSigner | Error> {
    try {
      if (this.goalTicketSigner) return await this.goalTicketSigner()
    } catch (error) {
      return new Error('The original Goal Ticket signing authority is unavailable', { cause: error })
    }
    return new Error('This Demand Store has no original Goal Ticket signing authority')
  }

  private requireTicketSigner(prepared: GoalTicketSigner | Error | undefined): GoalTicketSigner {
    if (prepared instanceof Error || !prepared) this.rejectDelegation(prepared?.message ?? 'The Goal Ticket signing authority is unavailable')
    return prepared
  }

  /** The host admits the caller and original Session/Run identities before preparing. */
  async prepareDelegation(id: string, input: DemandDelegationIntent, actorSessionId: string, participants?: { ownerRuntimeId: string; workerRuntimeId: string }): Promise<DemandReceipt> {
    const intent = parseDemandDelegationIntent(input)
    const signing = intent.planNodeId ? await this.readTicketSigner() : undefined
    return this.mutate('delegation.prepare', snapshot => {
      const demand = findDemand(snapshot, id, this.storePath)
      const owner = snapshot.demands.find(item => item.delegations?.some(entry => entry.operationId === intent.operationId || entry.sourceMessageId === intent.sourceMessageId))
      const original = owner?.delegations?.find(entry => entry.operationId === intent.operationId || entry.sourceMessageId === intent.sourceMessageId)
      if (actorSessionId !== intent.ownerAgentSessionId) this.rejectDelegation('Only the original authenticated owner can prepare this delegation.')
      if (original) {
        if (owner!.id !== id || !sameDemandDelegationIntent(original, intent)) this.rejectDelegation('The original delegation identity belongs to a different Goal, worker, Run or frozen input. Inspect it without resending.')
        return { unchanged: demand }
      }
      if (demand.supervisorSessionId !== actorSessionId || !demand.assigneeSessionIds.includes(intent.workerAgentSessionId) || !demand.sessionIds.includes(intent.workerAgentSessionId) ||
          intent.workerAgentSessionId === actorSessionId && delegationWorkerHostId(intent) === intent.hostId)
        this.rejectDelegation('A new delegation requires the current Supervisor and a distinct accurate assigned worker Session.')
      const alignment = demand.alignment
      if (!alignment || alignment.revision !== intent.alignmentRevision || intent.criterionIds.some(criterionId => !alignment.criteria.some(criterion => criterion.id === criterionId)))
        this.rejectDelegation('A new delegation must reference the current proposal and its original success criteria.')
      let predecessors: DemandDelegation['predecessors']
      let claimRecord: GoalPlanRevisionRecord | undefined
      let dispatchProof: GoalTicketProof | undefined
      if (intent.planNodeId !== undefined) {
        if (!demand.plan) this.rejectDelegation('This Goal has no plan; delegate without a plan node or revise the plan first.')
        const target = projectGoalPlan(demand.plan, demand.delegations ?? [], alignment.criteria, undefined, alignment.revision).nodes.find(item => item.node.id === intent.planNodeId)
        const issue = goalPlanDelegationIssue(target, intent.planNodeId, { hostId: delegationWorkerHostId(intent), agentSessionId: intent.workerAgentSessionId })
        if (issue) this.rejectDelegation(issue)
        const { node } = target!
        if (target!.state === 'ready') {
          for (let index = demand.plan.history.length - 1; index >= 0; index--) {
            const entry = demand.plan.history[index]!
            if (entry.change?.nodeId !== node.id) continue
            if (entry.claim && entry.author.id === intent.workerAgentSessionId && entry.author.hostId === delegationWorkerHostId(intent))
              claimRecord = entry
            break
          }
        }
        const claim = claimRecord?.claim
        if (claim && claim.basis !== target!.claimBasis)
          this.rejectDelegation('This claim names earlier task requirements or predecessor deliveries. Read the original claim and confirm a current assignment before dispatch.')
        predecessors = claim?.predecessors ?? target!.predecessors!
        if (intent.criterionIds.length !== node.criterionIds.length || node.criterionIds.some(id => !intent.criterionIds.includes(id)))
          this.rejectDelegation('A node delegation must carry the same success criteria as its plan node. The original node and Agents are retained.')
        const signer = this.requireTicketSigner(signing)
        assertIssuedGoalTicket(signer, id, demand.plan, node.id)
        const dependencies = freezeGoalTicketDependencies(signer, id, demand.plan, predecessors)
        const task = goalTicketTask(node, id => alignment.criteria.find(criterion => criterion.id === id))
        if (claim) {
          signer.verify(claim.proof)
          const record = claim.proof.record
          if (record.kind !== 'claim' || record.scope.goalId !== id || record.ticketId !== node.id ||
              record.executor.id !== intent.workerAgentSessionId || record.executor.hostId !== delegationWorkerHostId(intent) ||
              participants && record.executor.runtimeId !== participants.workerRuntimeId || !isDeepStrictEqual(record.predecessors, dependencies) ||
              !isDeepStrictEqual(record.task, task))
            this.rejectDelegation('The original signed Ticket claim differs from this exact execution')
        } else {
          dispatchProof = signer.issue({ kind: 'dispatch', scope: { ...signer.owner, goalId: id }, ticketId: node.id,
            operationId: intent.operationId, actor: { kind: 'agent', id: actorSessionId, hostId: intent.hostId,
              ...(participants ? { runtimeId: participants.ownerRuntimeId } : {}) },
            executor: { id: intent.workerAgentSessionId, hostId: delegationWorkerHostId(intent), ...(participants ? { runtimeId: participants.workerRuntimeId } : {}) },
            task, predecessors: dependencies })
        }
      }
      demand.delegations = [...(demand.delegations ?? []), { ...intent, ...(predecessors ? { predecessors } : {}), ...(claimRecord ? { claimOperationId: claimRecord.operationId } : {}), ...(dispatchProof ? { dispatchProof } : {}), preparedAt: Date.now(),
        capturedCriteria: clone(alignment.criteria.filter(criterion => intent.criterionIds.includes(criterion.id))) }]
      demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
      validateNewDemand(demand, this.storePath)
      return demand
    }, undefined, intent.operationId)
  }

  /**
   * Revise the Goal plan as a whole. The caller names the revision it read; a later revision by
   * someone else is rejected so nobody overwrites a plan they have not seen.
   */
  async revisePlan(id: string, input: GoalPlanRevisionInput, author: GoalPlanReviewer, proposals: GoalPlanProposalReceipt[] = []): Promise<DemandReceipt> {
    let revision: GoalPlanRevisionInput
    try { revision = parseGoalPlanRevisionInput(input) } catch (error) { this.rejectDelegation(error instanceof Error ? error.message : String(error)) }
    const signing = await this.readTicketSigner()
    const requestHash = createHash('sha256').update(JSON.stringify(revision)).digest('hex')
    return this.mutate('plan.revise', snapshot => {
      const demand = findDemand(snapshot, id, this.storePath), current = demand.plan
      const proposalRefs = (receipts: GoalPlanProposalReceipt[]) => receipts.map(({ nodeId, delegationOperationId, replyMessageId }) => ({ nodeId, delegationOperationId, replyMessageId }))
      if (current?.history.some(record => record.operationId === revision.operationId)) {
        const original = current.history.find(record => record.operationId === revision.operationId)!
        if (original.change) this.rejectDelegation('This operation already belongs to a node assignment. Read its original plan history.')
        if (original.author.kind !== author.kind || original.author.id !== author.id || (original.author.runtimeId ? original.author.runtimeId !== author.runtimeId : original.author.hostId !== undefined && original.author.hostId !== author.hostId)) this.rejectDelegation('This plan revision operation belongs to another author.')
        if (original.revision !== current.revision)
          this.rejectDelegation(`This operation already applied at plan revision ${original.revision}; the current plan is revision ${current.revision}. Read the current plan instead of repeating the revision.`)
        if (requestHash !== original.requestHash)
          this.rejectDelegation('This plan revision operation was already recorded with different content. Read the original plan before another revision.')
        return { unchanged: demand }
      }
      if ((current?.revision ?? 0) !== revision.expectedRevision)
        this.rejectDelegation(`The plan changed to revision ${current?.revision ?? 0} after you read revision ${revision.expectedRevision}. Read the current plan before revising it.`)
      if (!demand.alignment || demand.alignment.revision !== revision.alignmentRevision)
        this.rejectDelegation('A plan must be written against the current Goal proposal version.')
      if (!isDeepStrictEqual(revision.proposals ?? [], proposalRefs(proposals)))
        this.rejectDelegation('A Ticket proposal requires its verified original Core reply.')
      const previousNodes = new Map(current?.nodes.map(node => [node.id, node]))
      for (const node of revision.nodes) {
        const previous = previousNodes.get(node.id)
        if (node.claimOpen && !previous?.claimOpen)
          this.rejectDelegation('Open a ready node using the explicit plan assignment operation.')
        if (previous?.claimOpen && node.executor)
          this.rejectDelegation('Assign an open node using the explicit plan assignment operation.')
        const criteriaWritten = !previous || previous.criterionIds.length !== node.criterionIds.length || previous.criterionIds.some(id => !node.criterionIds.includes(id))
        if (criteriaWritten && (!node.criterionIds.length || node.criterionIds.some(id => !demand.alignment!.criteria.some(criterion => criterion.id === id))))
          this.rejectDelegation(`Plan node ${node.id} must write at least one success criterion, all from the current Goal proposal. Unchanged existing criteria and recorded work are retained.`)
      }
      const now = Date.now(), next = (current?.revision ?? 0) + 1
      for (const proposal of proposals) {
        const attempt = demand.delegations?.find(item => item.operationId === proposal.delegationOperationId)
        if (previousNodes.has(proposal.nodeId) || attempt?.sourceMessageId !== proposal.sourceMessageId ||
            attempt?.workerAgentSessionId !== proposal.author.agentSessionId ||
            attempt.runtimeIdentity && attempt.runtimeIdentity.workerRuntimeId !== proposal.author.runtimeId)
          this.rejectDelegation('Ticket proposals must tie a new node to its original worker and attempt.')
      }
      const signer = this.requireTicketSigner(signing)
      const issued = issueGoalTickets(signer, id, revision.operationId, author, revision.nodes, current, demand.alignment.criteria, proposals)
      try { assertGoalPlanKeepsRecordedNodes(current, issued.nodes, demand.delegations ?? []) } catch (error) { this.rejectDelegation(error instanceof Error ? error.message : String(error)) }
      const changedNodes = goalPlanChangedNodes(current?.nodes ?? [], issued.nodes)
      demand.plan = { revision: next, alignmentRevision: revision.alignmentRevision, nodes: clone(issued.nodes), reviews: current?.reviews ?? [],
        history: [...(current?.history ?? []), { operationId: revision.operationId, revision: next, author, revisedAt: now, requestHash, ...(changedNodes.length ? { changedNodes } : {}),
          ...(issued.createdTickets.length ? { createdTickets: issued.createdTickets } : {}), ...(issued.proposals.length ? { proposals: issued.proposals } : {}) }] }
      demand.updatedAt = Math.max(now, demand.updatedAt + 1)
      validateNewDemand(demand, this.storePath)
      return demand
    }, undefined, revision.operationId)
  }

  /** Compare the observed plan and write one node under the original store's writer lock. */
  async changePlanAssignment(id: string, expected: number | string, operationId: string, change: GoalPlanAssignmentChange,
    author: GoalPlanReviewer, assertAuthorized: (current: Demand) => void, owner?: GoalPlanOwner): Promise<DemandReceipt> {
    const signing = change.assignment.kind === 'claim' ? await this.readTicketSigner() : undefined
    return this.mutate(change.assignment.kind === 'claim' ? 'plan.claim' : 'plan.assignment', snapshot => {
      const demand = findDemand(snapshot, id, this.storePath), plan = demand.plan
      if (!plan) this.rejectDelegation('This Goal has no saved plan.')
      const claiming = change.assignment.kind === 'claim'
      const original = plan.history.find(record => record.operationId === operationId)
      if (original) {
        if (original.author.kind !== author.kind || original.author.id !== author.id || original.author.hostId !== author.hostId ||
            original.author.runtimeId !== author.runtimeId || (claiming ? original.claim?.token !== expected : original.revision - 1 !== expected) || !isDeepStrictEqual(original.change, change))
          this.rejectDelegation('This operation belongs to another original request or actor. Read plan history to reconcile it.')
        return { unchanged: demand }
      }
      assertAuthorized(demand)
      if (!claiming && expected !== plan.revision)
        this.rejectDelegation(`The plan changed to revision ${plan.revision} after you read revision ${expected}. Read the current plan and its executor.`)
      const projection = projectGoalPlan(plan, demand.delegations ?? [], demand.alignment?.criteria ?? [],
        owner ? { ...owner, goalId: demand.id } : undefined, demand.alignment?.revision).nodes.find(item => item.node.id === change.nodeId)
      if (!projection) this.rejectDelegation(`Plan node ${change.nodeId} is not in the current plan.`)
      const { node, claimToken, claimBasis, predecessors } = projection, action = change.assignment
      const basis = claimToken && claimToken === expected && claimBasis && predecessors ? { token: claimToken, basis: claimBasis, predecessors } : undefined
      let claim: GoalPlanRevisionRecord['claim']
      if (claiming && !basis)
        this.rejectDelegation('This node or its prerequisites changed. Read the original node and its current claim token.')
      if (action.kind !== 'close' && (demand.status === 'done' || demand.status === 'cancelled' || projection.state !== 'ready' || projection.delegation))
        this.rejectDelegation(`This assignment requires an unfinished Goal and a ready node with no current delegation. Read the current plan (${demand.status}, ${projection.state}).`)
      if (action.kind === 'open') {
        if (node.executor || node.claimOpen) this.rejectDelegation('Only an unassigned node with closed claims can be opened.')
        node.claimOpen = true
      } else {
        if ((action.kind === 'claim' || action.kind === 'close') && !node.claimOpen) this.rejectDelegation('This node is not open for claim. Read its current executor.')
        if (action.kind === 'claim') {
          if (node.executor || author.kind !== 'agent' || !author.hostId || !author.runtimeId)
            this.rejectDelegation('Claiming requires an unassigned node and an authenticated Agent, Host and Runtime.')
          const signer = this.requireTicketSigner(signing)
          if (!basis || !owner || !isDeepStrictEqual(owner, signer.owner)) this.rejectDelegation('The original Ticket claim scope is unconfirmed')
          assertIssuedGoalTicket(signer, id, plan, node.id)
          claim = { ...basis, proof: signer.issue({ kind: 'claim', scope: { ...signer.owner, goalId: id }, ticketId: node.id, operationId, actor: author,
            executor: { id: author.id, hostId: author.hostId, runtimeId: author.runtimeId }, task: goalTicketTask(node, id => demand.alignment!.criteria.find(criterion => criterion.id === id)),
            predecessors: freezeGoalTicketDependencies(signer, id, plan, basis.predecessors) }) }
          node.executor = { hostId: author.hostId, agentSessionId: author.id }
        } else if (action.kind === 'assign') {
          node.executor = clone(action.executor)
        }
        delete node.claimOpen
      }
      const now = Date.now()
      plan.revision += 1
      plan.history.push({ operationId, revision: plan.revision, author, revisedAt: now, change: clone(change),
        ...(claim ? { claim } : {}) })
      demand.updatedAt = Math.max(now, demand.updatedAt + 1)
      validateNewDemand(demand, this.storePath)
      return demand
    }, undefined, operationId)
  }

  /**
   * Record one node verdict on its current attempt. The reviewer is admitted by the host and must
   * not be the attempt's executor; a pass carries the check that was actually run.
   */
  async reviewPlanNode(id: string, input: GoalPlanReviewInput, reviewer: GoalPlanReviewer): Promise<DemandReceipt> {
    let review: GoalPlanReviewInput
    try { review = parseGoalPlanReviewInput(input) } catch (error) { this.rejectDelegation(error instanceof Error ? error.message : String(error)) }
    const signing = review.verdict === 'pass' ? await this.readTicketSigner() : undefined
    return this.mutate('plan.review', snapshot => {
      const demand = findDemand(snapshot, id, this.storePath), plan = demand.plan
      if (!plan) this.rejectDelegation('This Goal has no plan to review.')
      const original = plan.reviews.find(item => item.operationId === review.operationId)
      if (original) {
        const before = original.reviewer
        const ownerHost = demand.delegations?.find(entry => entry.operationId === review.delegationOperationId)?.hostId
        if (!matchesGoalPlanReviewInput(original, review) || before.kind !== reviewer.kind || before.id !== reviewer.id ||
            (before.runtimeId ? before.runtimeId !== reviewer.runtimeId : (before.hostId ?? ownerHost) !== (reviewer.hostId ?? ownerHost)))
          this.rejectDelegation('This review operation was already recorded with a different verdict or reviewer.')
        return { unchanged: demand }
      }
      const projection = projectGoalPlan(plan, demand.delegations ?? [], demand.alignment?.criteria ?? []).nodes.find(item => item.node.id === review.nodeId)
      if (!projection) this.rejectDelegation(`Plan node ${review.nodeId} is not in the current plan.`)
      if (!projection.delegation || projection.delegation.operationId !== review.delegationOperationId)
        this.rejectDelegation('A review must judge the node\'s current attempt.')
      if (projection.delegation.report?.delivery?.hash !== review.deliveryHash)
        this.rejectDelegation('The review must name the exact original Ticket delivery hash. Read the current reported attempt.')
      if (projection.state !== 'review') this.rejectDelegation(`Plan node ${review.nodeId} is ${projection.state}; only a reported attempt can be reviewed.`)
      if (reviewer.kind === 'agent' && projection.delegation.runtimeIdentity && !reviewer.runtimeId)
        this.rejectDelegation('The reviewer Runtime is not yet confirmed for this signed delegation. Keep the original work and review evidence.')
      if (reviewer.kind === 'agent' && reviewer.id === projection.delegation.workerAgentSessionId &&
          (projection.delegation.runtimeIdentity ? reviewer.runtimeId === projection.delegation.runtimeIdentity.workerRuntimeId
            : (reviewer.hostId ?? projection.delegation.hostId) === delegationWorkerHostId(projection.delegation)))
        this.rejectDelegation('The executor of a node cannot review its own work.')
      const now = Date.now()
      let completion: GoalTicketProof | undefined
      if (review.verdict === 'pass') {
        const signer = this.requireTicketSigner(signing), attempt = projection.delegation
        const execution = attempt.dispatchProof ?? plan.history.find(entry => entry.operationId === attempt.claimOperationId)?.claim?.proof
        const report = attempt.report, delivery = report?.delivery
        if (!execution || !review.deliveryHash || !report || !delivery || !attempt.predecessors)
          this.rejectDelegation('Ticket completion needs the original signed execution and delivery evidence')
        if (ticketDeliveryHash(id, attempt, report, { ownerRuntimeId: signer.owner.runtimeId, namespace: signer.owner.namespace, authorRuntimeId: delivery.authorRuntimeId }) !== delivery.hash)
          this.rejectDelegation('The original delivery contents fail the Ticket digest check')
        signer.verify(execution)
        if (execution.record.scope.goalId !== id || (execution.record.kind !== 'claim' && execution.record.kind !== 'dispatch') || execution.record.ticketId !== review.nodeId ||
            execution.record.executor.id !== attempt.workerAgentSessionId || execution.record.executor.hostId !== delegationWorkerHostId(attempt) ||
            !isDeepStrictEqual(execution.record.predecessors, freezeGoalTicketDependencies(signer, id, plan, attempt.predecessors)) ||
            execution.record.executor.runtimeId !== undefined && execution.record.executor.runtimeId !== attempt.report?.delivery?.authorRuntimeId)
          this.rejectDelegation('Ticket completion does not match its original signed execution')
        completion = signer.issue({ kind: 'completed', scope: { ...signer.owner, goalId: id }, ticketId: review.nodeId,
          operationId: review.operationId, actor: reviewer, attemptId: review.delegationOperationId, executionHash: execution.hash,
          deliveryHash: review.deliveryHash, check: review.check, note: review.note })
      }
      plan.reviews = [...plan.reviews, { ...clone(review), reviewer, reviewedAt: now, ...(completion ? { completion } : {}) }]
      demand.updatedAt = Math.max(now, demand.updatedAt + 1)
      validateNewDemand(demand, this.storePath)
      return demand
    }, undefined, review.operationId)
  }

  /** Confirm a saved intent can still be submitted for the first time. Original message reconciliation reads remain independent. */
  async confirmDelegationSubmission(id: string, original: Pick<DemandDelegation, 'operationId' | 'planNodeId'>): Promise<{
    workerRuntimeId?: string
    creationOrigin?: Demand['creationOrigin']
  }> {
    const { operationId, planNodeId } = original
    const signing = planNodeId ? await this.readTicketSigner() : undefined
    return enqueue(this.root, () => this.withWriterLock(async () => {
      const snapshot = await this.readSnapshot(), demand = findDemand(snapshot, id, this.storePath)
      const entry = this.findDelegation(demand, operationId)
      if (entry.planNodeId !== planNodeId)
        this.rejectDelegation('The prepared attempt no longer matches its original Ticket association')
      if (!entry.planNodeId) return {}
      const target = demand.plan && projectGoalPlan(demand.plan, demand.delegations ?? [], demand.alignment?.criteria ?? [])
        .nodes.find(item => item.node.id === entry.planNodeId)
      if (!target || target.delegation?.operationId !== operationId || target.node.cancelled || target.staleCriteria.length ||
          !target.predecessors || !sameGoalPlanPredecessors(entry.predecessors ?? [], target.predecessors) ||
          demand.status === 'done' || demand.status === 'cancelled')
        this.rejectDelegation('The saved attempt no longer has current task requirements or passing predecessor receipts. Read the original plan and retain the prepared input.')
      const assignment = [...demand.plan!.history].reverse().find(record => record.change?.nodeId === entry.planNodeId)
      if (entry.claimOperationId && (entry.claimOperationId !== assignment?.operationId || !assignment.author.runtimeId))
        this.rejectDelegation('The attempt’s original claim was superseded or its worker Runtime is unconfirmed. Retain the original intent and read the current plan.')
      const signer = this.requireTicketSigner(signing), proof = entry.dispatchProof ?? assignment?.claim?.proof
      if (!proof || proof.record.scope.goalId !== id || (proof.record.kind !== 'claim' && proof.record.kind !== 'dispatch') ||
          proof.record.ticketId !== entry.planNodeId || proof.record.executor.id !== entry.workerAgentSessionId || proof.record.executor.hostId !== delegationWorkerHostId(entry) ||
          !isDeepStrictEqual(proof.record.predecessors, freezeGoalTicketDependencies(signer, id, demand.plan!, entry.predecessors!)))
        this.rejectDelegation('The signed execution differs from the original Ticket and its dependencies')
      signer.verify(proof)
      await this.confirmSnapshot()
      const workerRuntimeId = entry.claimOperationId ? assignment!.author.runtimeId
        : entry.dispatchProof?.record.kind === 'dispatch' ? entry.dispatchProof.record.executor.runtimeId : undefined
      return { ...(workerRuntimeId ? { workerRuntimeId } : {}),
        ...(demand.creationOrigin ? { creationOrigin: clone(demand.creationOrigin) } : {}) }
    }))
  }

  async inspectDelegation(id: string, operationId: string): Promise<DemandDelegation | null> {
    nonEmptyString(operationId, 'delegation.operationId')
    return enqueue(this.root, async () => {
      return this.withWriterLock(async () => {
        const snapshot = await this.readSnapshot(), demand = findDemand(snapshot, id, this.storePath)
        await this.confirmSnapshot()
        return clone(demand.delegations?.find(entry => entry.operationId === operationId) ?? null)
      })
    })
  }

  /** Call only after Main has verified this exact source envelope through Core. */
  async linkDelegation(id: string, operationId: string, sourceMessageId: string, actorSessionId: string, verifiedRuntimeIdentity?: DemandDelegationRuntimeIdentity): Promise<DemandReceipt> {
    const runtimeIdentity = verifiedRuntimeIdentity === undefined ? undefined : parseDemandDelegationRuntimeIdentity(verifiedRuntimeIdentity)
    return this.mutate('delegation.link', snapshot => {
      const demand = findDemand(snapshot, id, this.storePath), entry = this.findDelegation(demand, operationId)
      if (entry.sourceMessageId !== sourceMessageId || actorSessionId !== entry.ownerAgentSessionId && actorSessionId !== demand.supervisorSessionId)
        this.rejectDelegation('The original source message and authenticated owner must match this delegation.')
      if (entry.linkedAt !== undefined) {
        if (runtimeIdentity && JSON.stringify(entry.runtimeIdentity) !== JSON.stringify(runtimeIdentity))
          this.rejectDelegation('The original linked Core Runtime identities differ. Keep the original signed source.')
        return { unchanged: demand }
      }
      entry.linkedAt = Date.now()
      if (runtimeIdentity) entry.runtimeIdentity = runtimeIdentity
      demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
      return demand
    }, undefined, operationId)
  }

  /** Core verifies replyTo/thread/author; Demand verifies the frozen business scope. */
  async submitDelegationReport(id: string, delegationOperationId: string, input: DemandDelegationReportInput, actorSessionId: string, scope?: GoalDeliveryScope): Promise<DemandReceipt> {
    const report = parseDemandDelegationReportInput(input)
    return this.recordDelegationReport(id, delegationOperationId, report, { worker: actorSessionId }, scope)
  }

  /** Main must verify the original structured Core reply before calling this owner. */
  async recoverDelegationReport(id: string, delegationOperationId: string, input: DemandDelegationReportInput, admittedCollector: DemandDelegationCollector, scope?: GoalDeliveryScope): Promise<DemandReceipt> {
    const report = parseDemandDelegationReportInput(input), collector = parseDemandDelegationCollector(admittedCollector)
    return this.recordDelegationReport(id, delegationOperationId, report, { collector }, scope)
  }

  private async recordDelegationReport(id: string, delegationOperationId: string, report: DemandDelegationReportInput,
    author: { worker: string } | { collector: DemandDelegationCollector }, scope?: GoalDeliveryScope): Promise<DemandReceipt> {
    return this.mutate('collector' in author ? 'delegation.report-recover' : 'delegation.report', snapshot => {
      const demand = findDemand(snapshot, id, this.storePath), entry = this.findDelegation(demand, delegationOperationId)
      if ('worker' in author) {
        const actorSessionId = author.worker
        if (actorSessionId !== entry.workerAgentSessionId || actorSessionId !== report.authorAgentSessionId) this.rejectDelegation('Only the original authenticated worker can report this delegation.')
      } else if (author.collector.kind === 'agent' && author.collector.id !== entry.ownerAgentSessionId && author.collector.id !== demand.supervisorSessionId)
        this.rejectDelegation('Only the original owner, current Supervisor or an admitted person/device can recover the verified original report.')
      try { validateDemandDelegationReport(entry, report) } catch (error) { this.rejectDelegation(error instanceof Error ? error.message : String(error)) }
      const previous = snapshot.demands.flatMap(item => (item.delegations ?? []).map(delegation => ({ goalId: item.id, delegation })))
        .find(item => item.delegation.report?.operationId === report.operationId || item.delegation.report?.replyMessageId === report.replyMessageId)
      if (previous && (previous.goalId !== id || previous.delegation.operationId !== delegationOperationId)) this.rejectDelegation('The original report identity belongs to another delegation. Inspect its original source.')
      if (entry.report) {
        const { submittedAt: _time, recovery: _recovery, delivery: _delivery, ...original } = entry.report
        if (JSON.stringify(original) !== JSON.stringify(report)) this.rejectDelegation('The original worker report is frozen. A duplicate or late report cannot replace its evidence or collection.')
        return { unchanged: demand }
      }
      if (entry.linkedAt === undefined) this.rejectDelegation('The original Core dispatch association is not confirmed. Inspect it before recording its reply.')
      const submittedAt = Date.now()
      if (scope && entry.runtimeIdentity && (scope.ownerRuntimeId !== entry.runtimeIdentity.ownerRuntimeId ||
          scope.authorRuntimeId !== entry.runtimeIdentity.workerRuntimeId))
        this.rejectDelegation('The delivery identity disagrees with the original signed Goal delegation.')
      const delivery = entry.planNodeId && scope && entry.predecessors ? {
        schema: ticketDeliverySchema, authorRuntimeId: scope.authorRuntimeId, hash: ticketDeliveryHash(id, entry, report, scope),
      } : undefined
      entry.report = { ...report, ...(delivery ? { delivery } : {}), submittedAt, ...('collector' in author ? { recovery: { collector: author.collector, recoveredAt: submittedAt } } : {}) }
      demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
      validateNewDemand(demand, this.storePath)
      return demand
    }, undefined, report.operationId)
  }

  /** Explicit collection proposes results; it never supplies human acceptance. */
  async collectDelegationReport(id: string, delegationOperationId: string, input: DemandDelegationCollectionInput, admittedCollector: DemandDelegationCollector): Promise<DemandReceipt> {
    const request = parseDemandDelegationCollectionInput(input), collector = parseDemandDelegationCollector(admittedCollector)
    return this.mutate('delegation.collect', snapshot => {
      const demand = findDemand(snapshot, id, this.storePath), entry = this.findDelegation(demand, delegationOperationId)
      if (collector.kind === 'agent' && collector.id !== entry.ownerAgentSessionId && collector.id !== demand.supervisorSessionId)
        this.rejectDelegation('Only the original owner, current Supervisor or an admitted person/device can collect this report.')
      if (!entry.report || request.replyMessageId !== entry.report.replyMessageId) this.rejectDelegation('Collection must reference the exact original submitted report.')
      const previous = snapshot.demands.flatMap(item => (item.delegations ?? []).map(delegation => ({ goalId: item.id, delegation })))
        .find(item => item.delegation.collection?.operationId === request.operationId)
      if (previous && (previous.goalId !== id || previous.delegation.operationId !== delegationOperationId)) this.rejectDelegation('The original collection operation belongs to another delegation.')
      if (entry.collection) {
        if (entry.collection.operationId !== request.operationId || entry.collection.replyMessageId !== request.replyMessageId || JSON.stringify(entry.collection.collector) !== JSON.stringify(collector))
          this.rejectDelegation('The report was already collected by its original operation and actor. Inspect that receipt.')
        return { unchanged: demand }
      }
      entry.collection = { ...request, collector, collectedAt: Date.now() }
      const alignment = demand.alignment
      if (alignment?.revision === entry.alignmentRevision && !(demand.grounding?.alignmentRevision === alignment.revision && demand.grounding.acceptedAt !== null)) {
        const reports = (demand.delegations ?? []).filter(delegation => delegation.collection && delegation.report && delegation.alignmentRevision === alignment.revision)
        const proposal: DemandGroundingProposal = { alignmentRevision: alignment.revision, summary: reports.map(delegation => `${delegation.sourceMessageId}: ${delegation.report!.grounding.summary}`).join('\n'),
          checks: alignment.criteria.map(criterion => {
            const sources = reports.flatMap(delegation => delegation.report!.grounding.checks.filter(check => check.criterionId === criterion.id).map(check => ({ check, replyMessageId: delegation.report!.replyMessageId })))
            if (sources.length === 0) return { criterionId: criterion.id, outcome: 'unknown' as const, evidence: [], note: 'No collected report for this current success criterion.' }
            const distinct = new Set(sources.map(source => JSON.stringify(source.check)))
            if (distinct.size > 1) return { criterionId: criterion.id, outcome: 'unknown' as const, evidence: [...new Map(sources.flatMap(source => source.check.evidence).map(evidence => [JSON.stringify(evidence), evidence])).values()], note: `Conflicting reports: ${sources.map(source => source.replyMessageId).join(', ')}. Review the original reports.` }
            return clone(sources[0]!.check)
          }) }
        const current = demand.grounding
        if (!current || JSON.stringify({ alignmentRevision: current.alignmentRevision, summary: current.summary, checks: current.checks }) !== JSON.stringify(proposal))
          demand.grounding = { ...proposal, submissionId: mintObjectId(), acceptedAt: null }
        entry.collection.groundingSubmissionId = demand.grounding!.submissionId
      }
      demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
      validateNewDemand(demand, this.storePath)
      return demand
    }, undefined, request.operationId)
  }

  /** Trusted Main captures one exact existing Supervisor input, never a new queue. */
  async prepareDelegationAttention(id: string, delegationOperationId: string, input: DemandDelegationAttentionInput): Promise<DemandReceipt> {
    const attention = parseDemandDelegationAttentionInput(input)
    return this.mutate('delegation.attention-prepare', snapshot => {
      const demand = findDemand(snapshot, id, this.storePath), entry = this.findDelegation(demand, delegationOperationId)
      const previous = snapshot.demands.flatMap(goal => [
        ...(goal.delegations ?? []).map(item => ({ kind: 'delegation', goalId: goal.id, operationId: item.operationId, attention: item.attention })),
        ...(goal.dispatches ?? []).map(item => ({ kind: 'start', goalId: goal.id, operationId: item.operationId, attention: item.attention }))
      ]).find(item => item.attention?.operationId === attention.operationId || item.attention?.intentId === attention.intentId)
      if (previous && (previous.kind !== 'delegation' || previous.goalId !== id || previous.operationId !== delegationOperationId)) this.rejectDelegation('The original attention input belongs to another delegation. Inspect that exact reference.')
      if (entry.attention) {
        if (!sameDemandDelegationAttention(entry.attention, attention)) this.rejectDelegation('The original attention input is frozen. It cannot silently move to another Supervisor, Run or note.')
        return { unchanged: demand }
      }
      if (!entry.linkedAt || attention.hostId !== entry.hostId || attention.supervisorAgentSessionId !== demand.supervisorSessionId || entry.collection)
        this.rejectDelegation('A new attention reference needs the original linked Host, exact current Supervisor and work awaiting collection.')
      entry.attention = { ...attention, preparedAt: Date.now() }
      demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
      validateNewDemand(demand, this.storePath)
      return demand
    }, undefined, attention.operationId)
  }

  /** Persist before the one actual Core submission; uncertainty is inspected, not resent. */
  async markDelegationAttentionAttempt(id: string, delegationOperationId: string, operationId: string): Promise<DemandReceipt> {
    return this.mutate('delegation.attention-attempt', snapshot => {
      const demand = findDemand(snapshot, id, this.storePath), entry = this.findDelegation(demand, delegationOperationId)
      if (!entry.attention || entry.attention.operationId !== operationId) this.rejectDelegation('An attention attempt must refer to the exact original prepared input.')
      if (entry.attention.attemptedAt !== undefined) return { unchanged: demand }
      entry.attention.attemptedAt = Date.now()
      demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
      return demand
    }, undefined, operationId)
  }

  private rejectDelegation(message: string): never {
    throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, message)
  }

  private findDelegation(demand: Demand, operationId: string): DemandDelegation {
    const entry = demand.delegations?.find(delegation => delegation.operationId === operationId)
    if (!entry) this.rejectDelegation('The original delegation is not prepared. Preserve the Goal and inspect the exact operation.')
    return entry
  }

  async update(id: string, patch: UpdateDemandInput, options: DemandTitleMutationOptions = {}): Promise<DemandReceipt> {
    rejectProvenanceInput(patch)
    if (Object.hasOwn(patch, 'dispatches')) throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'Only the actual Goal Start input owner records dispatch facts.')
    patch = structuredClone(patch)
    return this.mutate('update', (snapshot) => {
      const demand = findDemand(snapshot, id, this.storePath)
      if (options.expectedUpdatedAt !== undefined && (!Number.isSafeInteger(options.expectedUpdatedAt) || options.expectedUpdatedAt < 0 || options.expectedUpdatedAt !== demand.updatedAt)) {
        throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'Goal changed. Inspect the original record before appending its content association.')
      }
      if (patch.contentRefs !== undefined) {
        try { demand.contentRefs = appendDemandContentReferences(demand.contentRefs ?? [], patch.contentRefs) } catch (error) {
          throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, error instanceof Error ? error.message : String(error), error)
        }
      }
      if ('confirmedAt' in patch || 'acceptedAt' in patch || 'revision' in patch || 'submissionId' in patch) {
        throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'Agent updates cannot supply acknowledgement fields.')
      }
      if (patch.title !== undefined) demand.title = inputString(patch.title, 'title') ?? demand.title
      if (patch.description !== undefined) demand.description = patch.description
      if (patch.status !== undefined) demand.status = ensureStatus(patch.status, 'status') ?? demand.status
      if (patch.priority !== undefined) demand.priority = ensurePriority(patch.priority, 'priority') ?? demand.priority
      if (patch.projectId !== undefined) demand.projectId = patch.projectId
      if (patch.projectName !== undefined) demand.projectName = patch.projectName
      if (patch.sessionIds !== undefined) demand.sessionIds = [...patch.sessionIds]
      if (patch.assigneeSessionIds !== undefined) {
        demand.assigneeSessionIds = [...patch.assigneeSessionIds]
        demand.sessionIds = mergeDemandAgentReferences(demand.sessionIds, patch.assigneeSessionIds)
      }
      if (Object.hasOwn(patch, 'supervisorSessionId')) {
        demand.supervisorSessionId = patch.supervisorSessionId ?? null
        if (demand.creationOrigin) demand.creationOrigin.supervisorDefaultPending = false
      }
      if (patch.tags !== undefined) demand.tags = [...patch.tags]
      if (patch.plannedStartAt !== undefined) demand.plannedStartAt = patch.plannedStartAt
      if (patch.targetAt !== undefined) demand.targetAt = patch.targetAt
      if (patch.parentDemandId !== undefined) demand.parentDemandId = patch.parentDemandId
      if (patch.phaseIndex !== undefined) demand.phaseIndex = phaseIndex(patch.phaseIndex, 'phaseIndex')
      try {
        if (patch.alignment !== undefined) {
          const proposal = parseAlignmentProposal(patch.alignment)
          const current = demand.alignment
          const content = current && { summary: current.summary, criteria: current.criteria, openQuestions: current.openQuestions }
          if (JSON.stringify(proposal) !== JSON.stringify(content)) {
            demand.alignment = { ...proposal, revision: (current?.revision ?? 0) + 1, confirmedAt: null }
          }
        }
        if (patch.grounding !== undefined) {
          const proposal = parseGroundingProposal(patch.grounding)
          const alignment = demand.alignment
          if (!alignment || proposal.alignmentRevision !== alignment.revision) throw new Error('Grounding must reference the current goal revision.')
          const criterionIds = new Set(alignment.criteria.map(criterion => criterion.id))
          if (proposal.checks.some(check => !criterionIds.has(check.criterionId))) throw new Error('Grounding references an unknown success criterion.')
          const current = demand.grounding
          const content = current && { alignmentRevision: current.alignmentRevision, summary: current.summary, checks: current.checks }
          if (JSON.stringify(proposal) !== JSON.stringify(content)) {
            demand.grounding = { ...proposal, submissionId: mintObjectId(), acceptedAt: null }
          }
        }
      } catch (error) {
        throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, error instanceof Error ? error.message : String(error), error)
      }
      if (options.participation) appendParticipation(demand, options.participation, options.operationId ?? mintObjectId(), Date.now())
      demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
      validateNewDemand(demand, this.storePath)
      return demand
    }, patch.title === undefined ? undefined : { ...options, targetId: id, requested: typeof patch.title === 'string' ? patch.title : null }, options.operationId)
  }

  /** Atomically reserve the first explicit discussion source before any Core creation. */
  async prepareDiscussion(id: string, operationId: string, input: DemandDiscussionIntent, expectedUpdatedAt: number): Promise<DemandReceipt> {
    const intent = parseDemandDiscussionIntent(input)
    return this.mutate('discussion-prepare', snapshot => {
      const demand = findDemand(snapshot, id, this.storePath)
      if (demand.discussionOperationId !== undefined && demand.discussionOperationId !== operationId) throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'The original Goal discussion operation is unconfirmed. Existing workfaces are retained.')
      if (demand.discussionIntent) {
        if (JSON.stringify(demand.discussionIntent) !== JSON.stringify(intent)) throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'The original Goal discussion request is frozen. Inspect that same request.')
        return { unchanged: demand }
      }
      if (demand.updatedAt !== expectedUpdatedAt) throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'Goal changed before preparing its original discussion.')
      demand.discussionOperationId = operationId
      demand.discussionIntent = intent; demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
      return demand
    }, undefined, operationId)
  }

  /** Freeze this exact later PMO input in its original Goal before crossing Core. */
  async prepareDiscussionInput(id: string, input: DemandDiscussionInput): Promise<DemandReceipt> {
    const intent = parseDemandDiscussionInput(input)
    return this.mutate('discussion-input-prepare', snapshot => {
      const demand = findDemand(snapshot, id, this.storePath), original = demand.discussionInputs?.find(item => item.operationId === intent.operationId)
      if (original) {
        if (JSON.stringify(original) !== JSON.stringify(intent)) throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'The original discussion input is frozen.')
        return { unchanged: demand }
      }
      demand.discussionInputs = [...(demand.discussionInputs ?? []), intent]
      demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
      return demand
    }, undefined, intent.operationId)
  }

  async recordParticipation(id: string, source: DemandParticipationSource, options: { operationId: string; expectedUpdatedAt?: number }): Promise<DemandReceipt> {
    const parsed = parseDemandParticipationSource(source)
    return this.mutate('participation', snapshot => {
      const demand = findDemand(snapshot, id, this.storePath)
      const previous = demand.participations.find(item => item.operationId === options.operationId && item.kind === parsed.kind && item.agentSessionId === parsed.agentSessionId)
      if (!previous && options.expectedUpdatedAt !== undefined && options.expectedUpdatedAt !== demand.updatedAt) throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'Goal changed. Inspect the original Goal before recording its source.')
      appendParticipation(demand, parsed, options.operationId, Date.now())
      if (!previous) demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
      validateNewDemand(demand, this.storePath)
      return demand
    }, undefined, options.operationId)
  }

  /** Only the trusted host may confirm the source of this exact original creation. */
  async resolveCreationOrigin(id: string, input: { creationOperationId: string; source: DemandParticipationSource; sourceOperationId: string },
    options: { expectedUpdatedAt: number; allowSupervisorDefault: boolean }): Promise<DemandReceipt> {
    const source = parseDemandParticipationSource(input.source)
    if (source.kind === 'requirements') throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'Later requirements cannot resolve the original creation source.')
    return this.mutate('creation-origin', snapshot => {
      const demand = findDemand(snapshot, id, this.storePath)
      if (!demand.creationOrigin || demand.creationOrigin.operationId !== input.creationOperationId)
        throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'The original Goal creation operation is unconfirmed. Existing Goal and Agent are retained.')
      const previous = demand.participations.find(item => item.id === demand.creationOrigin!.requesterParticipationId)
      if (previous && (previous.operationId !== input.sourceOperationId || previous.agentSessionId !== source.agentSessionId || previous.kind !== source.kind))
        throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'This creation already has a different confirmed original requester.')
      if (!previous && demand.updatedAt !== options.expectedUpdatedAt)
        throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'Goal changed before its original requester was confirmed. Inspect the same creation operation.')
      appendParticipation(demand, source, input.sourceOperationId, Date.now())
      resolveCreationRequester(demand, source, input.sourceOperationId, options.allowSupervisorDefault)
      if (!previous) demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
      validateNewDemand(demand, this.storePath)
      return demand
    }, undefined, input.sourceOperationId)
  }

  async proposeAlignment(id: string, proposal: DemandAlignmentProposal): Promise<DemandReceipt> {
    return this.update(id, { alignment: proposal })
  }

  async proposeGrounding(id: string, proposal: DemandGroundingProposal): Promise<DemandReceipt> {
    return this.update(id, { grounding: proposal })
  }

  /** Human acknowledgement. Hosts expose this through an explicit user action, never Agent update. */
  async confirmAlignment(id: string, expectedRevision: number): Promise<DemandReceipt> {
    return this.mutate('confirm-alignment', snapshot => {
      const demand = findDemand(snapshot, id, this.storePath)
      if (!demand.alignment || demand.alignment.revision !== expectedRevision) {
        throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'The goal changed. Read the current proposal before confirming it.')
      }
      const issue = alignmentConfirmationIssue(demand.alignment)
      if (issue) throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, issue)
      if (demand.alignment.confirmedAt === null) {
        demand.alignment.confirmedAt = Date.now()
        demand.activities.push({ id: mintObjectId(), kind: 'goal-confirmed', message: `User confirmed goal revision ${expectedRevision}.`, createdAt: demand.alignment.confirmedAt, actorId: null })
      }
      demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
      return demand
    })
  }

  /** Acceptance binds the exact result shown to the user; retaining gaps is a distinct choice. */
  async acceptGrounding(id: string, expectedAlignmentRevision: number, expectedSubmissionId: string, acceptGaps = false, finish = false): Promise<DemandReceipt> {
    return this.mutate('accept-grounding', snapshot => {
      const demand = findDemand(snapshot, id, this.storePath)
      if (demand.alignment?.revision !== expectedAlignmentRevision || demand.grounding?.submissionId !== expectedSubmissionId) {
        throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'The goal or results changed. Read the current results before accepting them.')
      }
      if (typeof acceptGaps !== 'boolean') throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'Accepting with gaps requires an explicit boolean choice.')
      if (typeof finish !== 'boolean') throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'Finishing a goal requires an explicit boolean choice.')
      const issue = groundingAcceptanceIssue(demand.alignment, demand.grounding, acceptGaps)
      if (issue) throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, issue)
      if (demand.grounding.acceptedAt === null) {
        demand.grounding.acceptedAt = Date.now()
        demand.activities.push({ id: mintObjectId(), kind: 'results-accepted', message: acceptGaps ? 'User accepted these results while retaining the reported gaps.' : 'User accepted these results.', createdAt: demand.grounding.acceptedAt, actorId: null })
      }
      if (finish && demand.status !== 'done') {
        demand.status = 'done'
        demand.activities.push({ id: mintObjectId(), kind: 'status', message: 'User finished the goal after accepting its current results.', createdAt: Date.now(), actorId: null })
      }
      demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
      return demand
    })
  }

  async remove(id: string): Promise<{ schema: typeof DEMAND_RECEIPT_SCHEMA; operation: 'remove'; operationId: string; revision: number; demand: Demand }> {
    return this.mutate('remove', (snapshot) => {
      const index = snapshot.demands.findIndex((entry) => entry.id === id)
      if (index < 0) throw new DemandStoreError('NOT_FOUND', 'validate', this.storePath, `Demand ${id} was not found`)
      const [removed] = snapshot.demands.splice(index, 1)
      const creationOperationId = removed!.creationOrigin?.operationId
      snapshot.retiredGoals = [...(snapshot.retiredGoals ?? []), { id, ...(creationOperationId ? { creationOperationId } : {}) }]
      return removed!
    }) as Promise<{ schema: typeof DEMAND_RECEIPT_SCHEMA; operation: 'remove'; operationId: string; revision: number; demand: Demand }>
  }

  async delete(id: string): Promise<{ schema: typeof DEMAND_RECEIPT_SCHEMA; operation: 'remove'; operationId: string; revision: number; demand: Demand }> {
    return this.remove(id)
  }

  async linkSession(id: string, sessionId: DemandAgentReference): Promise<DemandReceipt> {
    return this.mutate('link-session', (snapshot) => {
      const demand = findDemand(snapshot, id, this.storePath)
      const reference = parseDemandAgentReference(sessionId)
      demand.sessionIds = mergeDemandAgentReferences(demand.sessionIds, [reference])
      demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
      return demand
    })
  }

  async unlinkSession(id: string, sessionId: DemandAgentReference): Promise<DemandReceipt> {
    return this.mutate('unlink-session', (snapshot) => {
      const demand = findDemand(snapshot, id, this.storePath)
      demand.sessionIds = demand.sessionIds.filter(entry => demandAgentReferenceKey(entry) !== demandAgentReferenceKey(parseDemandAgentReference(sessionId)))
      validateNewDemand(demand, this.storePath)
      demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
      return demand
    })
  }

  async linkProject(id: string, projectId: string, projectName?: string | null): Promise<DemandReceipt> {
    return this.update(id, { projectId, ...(projectName === undefined ? {} : { projectName }) })
  }

  async unlinkProject(id: string): Promise<DemandReceipt> {
    return this.update(id, { projectId: null, projectName: null })
  }

  async addActivity(id: string, input: Omit<DemandActivity, 'id' | 'createdAt'> & { id?: string; createdAt?: number }, options: { participation?: DemandParticipationSource } = {}): Promise<DemandReceipt> {
    if (input.kind === 'name-change' || input.nameChange !== undefined || input.nameChangeId !== undefined) {
      throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'Name change activities are created only by the title owner.')
    }
    return this.mutate('activity', (snapshot) => {
      const demand = findDemand(snapshot, id, this.storePath)
      const activity: DemandActivity = {
        id: input.id ?? mintObjectId(),
        kind: input.kind,
        message: input.message,
        actorId: input.actorId,
        ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
        createdAt: input.createdAt ?? Date.now(),
      }
      parseActivity(activity, 'activity')
      demand.activities.push(activity)
      if (options.participation) appendParticipation(demand, options.participation, input.operationId ?? activity.id, activity.createdAt)
      demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
      return demand
    }, undefined, input.operationId, input.operationId === undefined ? undefined : { targetId: id, kind: input.kind, message: input.message, actorId: input.actorId })
  }

  async appendActivity(id: string, input: Omit<DemandActivity, 'id' | 'createdAt'> & { id?: string; createdAt?: number }): Promise<DemandReceipt> {
    return this.addActivity(id, input)
  }

  async inspectActivity(id: string, operationId: string): Promise<DemandActivityInspection> {
    nonEmptyString(operationId, 'activity.operationId')
    return enqueue(this.root, async () => {
      return this.withWriterLock(async () => {
        const snapshot = await this.readSnapshot()
        const demand = findDemand(snapshot, id, this.storePath)
        await this.confirmSnapshot()
        return { demandId: id, operationId, activity: clone(demand.activities.find(activity => activity.operationId === operationId) ?? null), diskDurability: 'confirmed' }
      })
    })
  }

  async readActivities(id: string): Promise<DemandActivityRead> {
    const read = await this.readActivityCollection([id])
    return { ...read.groups[0]!, diskDurability: read.diskDurability }
  }

  /** One original file confirmation for the exact selected Goals, without cloning unrelated records per Goal. */
  async readActivityCollection(ids: readonly string[]): Promise<DemandActivityCollection> {
    const selected = [...ids]
    if (!selected.length || new Set(selected).size !== selected.length || selected.some(id => typeof id !== 'string' || !id.trim()))
      throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'Activity collection needs unique exact Goal IDs.')
    return enqueue(this.root, async () => this.withWriterLock(async () => {
      const read = await this.readConfirmedSnapshot()
      const groups = selected.map(id => {
        const demand = read.demandsById.get(id) ?? findDemand(read.snapshot, id, this.storePath)
        return { demandId: id, activities: clone(demand.activities) }
      })
      await this.confirmSnapshot()
      return { groups, diskDurability: 'confirmed' }
    }))
  }

  async addDecision(id: string, input: Omit<DemandDecision, 'id' | 'createdAt'> & { id?: string; createdAt?: number }): Promise<DemandReceipt> {
    return this.mutate('decision-log', (snapshot) => {
      const demand = findDemand(snapshot, id, this.storePath)
      const original = input.id ? demand.decisions.find(decision => decision.id === input.id) : undefined
      if (original) {
        if (original.question !== input.question || original.decision !== input.decision || original.rationale !== input.rationale || original.actorId !== input.actorId)
          throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'The original decision identity belongs to different content or author.')
        return { unchanged: demand }
      }
      const decision: DemandDecision = {
        id: input.id ?? mintObjectId(),
        question: input.question,
        decision: input.decision,
        rationale: input.rationale,
        actorId: input.actorId,
        createdAt: input.createdAt ?? Date.now(),
      }
      parseDecision(decision, 'decision')
      demand.decisions.push(decision)
      demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
      return demand
    })
  }

  async appendDecision(id: string, input: Omit<DemandDecision, 'id' | 'createdAt'> & { id?: string; createdAt?: number }): Promise<DemandReceipt> {
    return this.addDecision(id, input)
  }

  private async mutate(operation: string, fn: (snapshot: DemandStoreSnapshot) => Demand | { unchanged: Demand }, titleAttempt?: TitleAttempt, requestedOperationId?: string, activityAttempt?: ActivityAttempt): Promise<DemandReceipt> {
    if (requestedOperationId !== undefined && (typeof requestedOperationId !== 'string' || !requestedOperationId.trim() || requestedOperationId.length > 4096 || requestedOperationId.includes('\0')))
      throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'A Goal operation ID must be a non-empty string.')
    let context: DemandNameChangeRecord['context'] | undefined
    if (titleAttempt) {
      try { context = demandNameContext(titleAttempt.context) } catch (error) {
        throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, error instanceof Error ? error.message : String(error), error)
      }
      context.location.demandRoot = this.root
      if (titleAttempt.operationId !== undefined && (typeof titleAttempt.operationId !== 'string' || !titleAttempt.operationId.trim() || titleAttempt.operationId.length > 4096 || titleAttempt.operationId.includes('\0'))) {
        throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'A title operation ID must be a non-empty string.')
      }
      if (titleAttempt.expectedRevision !== undefined && (!Number.isSafeInteger(titleAttempt.expectedRevision) || titleAttempt.expectedRevision < 0)) {
        throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'Expected Demand revision must be a non-negative integer.')
      }
    }
    return enqueue(this.root, async () => {
      await fs.mkdir(this.root, { recursive: true })
      let confirmedTitle: DemandNameChangeRecord | undefined
      try { return await this.withWriterLock(async () => {
        const prior = await this.readConfirmedSnapshot()
        let snapshot = clone(prior.snapshot)
        const operationId = titleAttempt?.operationId ?? requestedOperationId ?? mintObjectId()
        if (activityAttempt) {
          const originalDemand = snapshot.demands.find(demand => demand.activities.some(activity => activity.operationId === operationId))
          const previousActivity = originalDemand?.activities.find(activity => activity.operationId === operationId)
          if (previousActivity) {
            if (originalDemand!.id !== activityAttempt.targetId || previousActivity.kind !== activityAttempt.kind || previousActivity.message !== activityAttempt.message || previousActivity.actorId !== activityAttempt.actorId)
              throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'The activity operation ID already belongs to a different Goal, payload or authenticated author.')
            await this.confirmSnapshot()
            return { schema: DEMAND_RECEIPT_SCHEMA, operation, operationId, revision: snapshot.revision, demand: projectNameHistory(snapshot).demands.find(demand => demand.id === originalDemand!.id)!, replayed: true }
          }
        }
        const original = titleAttempt ? findDemand(snapshot, titleAttempt.targetId, this.storePath) : undefined
        const previous = titleAttempt ? snapshot.nameHistory.find(change => change.operationId === operationId) : undefined
        if (previous) {
          if (previous.target.id !== titleAttempt!.targetId || previous.requested !== titleAttempt!.requested || previous.context.source !== context!.source ||
              previous.context.actor.kind !== context!.actor.kind || previous.context.actor.id !== context!.actor.id || previous.context.actor.verified !== context!.actor.verified) {
            throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'The title operation ID already belongs to a different request or caller.')
          }
          try { await this.confirmSnapshot() } catch (error) {
            const failure = new DemandStoreError('WRITE_FAILED', 'write', this.storePath,
              'Could not confirm the current Demand snapshot without replaying the title operation.', error)
            throw new DemandNameChangeError(failure, { ...clone(previous), status: 'unknown', actual: original!.title,
              ownerRevision: null, reason: failure.message }, 'unknown')
          }
          if (previous.status === 'failed') throw new DemandNameChangeError(new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, previous.reason ?? 'The original title attempt failed.'), clone(previous), 'confirmed')
          confirmedTitle = clone(previous)
          return { schema: DEMAND_RECEIPT_SCHEMA, operation, operationId, revision: previous.ownerRevision!, demand: clone(original!), nameChange: clone(previous), replayed: true }
        }
        const startedAt = Date.now()
        let failure: DemandStoreError | undefined
        let demand: Demand
        if (titleAttempt) {
          const candidate = clone(snapshot)
          try {
            if (titleAttempt.expectedRevision !== undefined && titleAttempt.expectedRevision !== snapshot.revision) {
              throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, `Demand revision conflict: expected ${titleAttempt.expectedRevision}, actual ${snapshot.revision}.`)
            }
            demand = fn(candidate) as Demand
            snapshot = candidate
          } catch (error) {
            if (!(error instanceof DemandStoreError)) throw error
            failure = error
            demand = original!
          }
        } else {
          const updated = fn(snapshot)
          if ('unchanged' in updated) {
            await this.confirmSnapshot()
            return { schema: DEMAND_RECEIPT_SCHEMA, operation, operationId, revision: snapshot.revision, demand: clone(updated.unchanged), replayed: true }
          }
          demand = updated
        }
        snapshot.revision += 1
        snapshot.updatedAt = Date.now()
        let nameChange: DemandNameChangeRecord | undefined
        if (titleAttempt) {
          nameChange = { id: operationId, operationId, target: { kind: 'demand', id: demand.id }, before: original!.title,
            requested: titleAttempt.requested, actual: demand.title, context: context!, ownerRevision: snapshot.revision,
            status: failure ? 'failed' : 'applied', startedAt, settledAt: Math.max(startedAt, Date.now()),
            reason: failure?.message ?? (original!.title === demand.title ? 'unchanged' : null) }
          snapshot.nameHistory.push(nameChange)
          demand.activities.push({ id: mintObjectId(), kind: 'name-change', message: failure ? 'Title change failed.' : nameChange.reason === 'unchanged' ? 'Title unchanged.' : 'Title changed.',
            createdAt: nameChange.settledAt, actorId: context!.actor.verified ? context!.actor.id : null, nameChangeId: nameChange.id })
          demand.updatedAt = Math.max(snapshot.updatedAt, original!.updatedAt + 1, demand.updatedAt)
        }
        try { await this.writeSnapshot(snapshot) } catch (error) {
          if (!nameChange || !(error instanceof SnapshotWriteError)) throw error
          const applied = error.replacementApplied
          throw new DemandNameChangeError(error, { ...nameChange, ownerRevision: null, status: applied ? 'unknown' : 'failed', actual: applied ? demand.title : original!.title, reason: error.message }, applied ? 'unknown' : 'not_applied')
        }
        try {
          const generation = await this.currentSnapshotIdentity()
          const indexed = demand.plan || await fs.stat(this.activeIndexPath).then(() => true, error => {
            if (isNodeError(error, 'ENOENT')) return false
            throw error
          })
          if (generation && indexed) this.activeIndex.publish(generation, prior.identity,
            { id: demand.id, goal: operation === 'remove' ? null : demand }, () => snapshot.demands)
        } catch (error) {
          // The original write is already durable. A projection fault only affects its bounded reader.
          console.warn('The active Goal index could not be updated. Original Goal writes are retained.', error)
          this.scheduleActiveIndexRepair()
        }
        confirmedTitle = nameChange ? clone(nameChange) : undefined
        const published = projectNameHistory(snapshot)
        const result: DemandReceipt = { schema: DEMAND_RECEIPT_SCHEMA, operation, operationId, revision: snapshot.revision,
          demand: { ...clone(demand), activities: projectActivities(demand.activities, new Map(snapshot.nameHistory.map(change => [change.id, change]))) }, ...(nameChange ? { nameChange: clone(nameChange) } : {}) }
        const changes = new Map([[demand.id, operation === 'remove' ? null : result.demand]])
        for (const listener of this.listeners) {
          try { listener(published, [demand.id], changes) } catch {
            console.warn(`Demand snapshot observer failed after confirmed revision ${snapshot.revision}, operation ${operationId}.`)
          }
        }
        if (failure) throw new DemandNameChangeError(failure, clone(nameChange!), 'confirmed')
        return result
      }) } catch (error) {
        // The name owner already confirmed this exact business record. A later
        // physical close error cannot turn an applied title into not_applied.
        if (confirmedTitle && error instanceof DemandStoreError && error.phase === 'lock')
          throw new DemandNameChangeError(error, confirmedTitle, 'confirmed')
        throw error
      }
    })
  }

  /** Keep original business receipts when closing the physical owner also fails. */
  private async withWriterLock<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireLock()
    let failure: unknown
    try { return await operation() } catch (error) { failure = error; throw error } finally {
      try { await release() } catch (closeError) {
        if (failure instanceof Error) {
          Object.defineProperty(failure, 'cleanup', { configurable: true, value: [closeError] })
          failure.message += ' Closing the Demand writer lock also failed; the original operation receipt is retained.'
        } else { throw closeError }
      }
    }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const startedAt = Date.now()
    let handle: FileHandle | undefined
    let temporary: string | undefined
    let locked = false
    try {
      const native: { tryLock(fd: number): boolean } = requireNative('fs-native-extensions')
      while (!handle) {
        try { handle = await fs.open(this.lockPath, 'r+') } catch (error) {
          if (!isNodeError(error, 'ENOENT')) throw error
          const candidate = `${this.lockPath}.tmp-${process.pid}-${mintObjectId()}`
          handle = await fs.open(candidate, 'wx+', 0o600)
          temporary = candidate
          // Publish only a complete, already locked inode. A crash before link
          // leaves no authoritative path; after link, the kernel releases it.
          await handle.writeFile(WRITER_LOCK_MARKER, 'utf8')
          await handle.sync()
          if (!native.tryLock(handle.fd)) throw new Error('Could not lock the private Demand writer inode')
          locked = true
          try { await fs.link(temporary, this.lockPath) } catch (error) {
            if (!isNodeError(error, 'EEXIST')) throw error
            await handle.close()
            handle = undefined
            locked = false
            await fs.rm(temporary)
            temporary = undefined
            continue
          }
          const directory = await fs.open(this.root, 'r')
          try { await directory.sync() } finally { await directory.close() }
          await fs.rm(temporary)
          temporary = undefined
        }
        // The marker is immutable. No protocol owner replaces or unlinks its
        // path; old writers never publish it and may still hold an unknown lock.
        const marker = Buffer.alloc(Buffer.byteLength(WRITER_LOCK_MARKER) + 1)
        const { bytesRead } = await handle.read(marker, 0, marker.length, 0)
        if (marker.subarray(0, bytesRead).toString('utf8') !== WRITER_LOCK_MARKER) {
          throw new DemandStoreError('WRITE_FAILED', 'lock', this.lockPath,
            'Demand writer ownership is unknown: the lock has an old, incomplete or unrecognized format. Lock and data are retained; ordinary reads remain available. Retry after the original writer releases its lock.')
        }
      }
      while (!locked && !native.tryLock(handle.fd)) {
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new DemandStoreError('LOCK_TIMEOUT', 'lock', this.lockPath, `Timed out waiting for Demand lock at ${this.lockPath}; retry the original operation.`)
        }
        await delay(this.lockRetryMs)
      }
      const acquired = handle
      return async () => {
        // Stable pathname: close (including process death) releases ownership.
        // Unlink would split waiters on this inode from the next opener.
        try { await acquired.close() } catch (error) {
          throw new DemandStoreError('WRITE_FAILED', 'lock', this.lockPath,
            'Could not close the Demand writer lock. A completed write is not undone; inspect the original operation before retrying.', error)
        }
      }
    } catch (error) {
      const failures: unknown[] = [error]
      try { await handle?.close() } catch (cleanup) { failures.push(cleanup) }
      try { if (temporary) await fs.rm(temporary, { force: true }) } catch (cleanup) { failures.push(cleanup) }
      if (failures.length === 1 && error instanceof DemandStoreError) throw error
      throw new DemandStoreError('WRITE_FAILED', 'lock', this.lockPath, `Could not acquire Demand lock at ${this.lockPath}`,
        failures.length === 1 ? error : new AggregateError(failures, 'Demand lock acquisition and cleanup failed'))
    }
  }

  private async writeSnapshot(snapshot: DemandStoreSnapshot): Promise<void> {
    const tempPath = `${this.storePath}.tmp-${process.pid}-${mintObjectId()}`
    const data = `${JSON.stringify(snapshot, null, 2)}\n`
    let replacementApplied = false
    try {
      const handle = await fs.open(tempPath, 'wx', 0o600)
      try {
        await handle.writeFile(data, 'utf8')
        await handle.sync()
      } finally { await handle.close() }
      await fs.rename(tempPath, this.storePath)
      replacementApplied = true
      const directory = await fs.open(this.root, 'r')
      try { await directory.sync() } finally { await directory.close() }
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined)
      if (error instanceof DemandStoreError) throw error
      throw new SnapshotWriteError(this.storePath, error, replacementApplied)
    }
  }

  /** Called under the original writer lock: confirm current facts, never reapply a past title. */
  private async confirmSnapshot(): Promise<void> {
    const file = await fs.open(this.storePath, 'r')
    try { await file.sync() } finally { await file.close() }
    const directory = await fs.open(this.root, 'r')
    try { await directory.sync() } finally { await directory.close() }
  }
}

export function openDemandStore(options: OpenDemandStoreOptions): DemandStore {
  return new DemandStore(options)
}

function emptySnapshot(): DemandStoreSnapshot {
  return { schema: DEMAND_STORE_SCHEMA, revision: INITIAL_REVISION, updatedAt: Date.now(), demands: [], nameHistory: [] }
}

function projectActivities(activities: readonly DemandActivity[], names: ReadonlyMap<string, DemandNameChangeRecord>): DemandActivity[] {
  return activities.map(({ nameChange: _projection, ...activity }) => ({ ...clone(activity),
    ...(activity.nameChangeId === undefined ? {} : { nameChange: clone(names.get(activity.nameChangeId)!) }) }))
}

function projectNameHistory(snapshot: DemandStoreSnapshot): DemandStoreSnapshot {
  const names = new Map(snapshot.nameHistory.map(change => [change.id, change]))
  return { ...clone(snapshot), demands: snapshot.demands.map(demand => ({ ...clone(demand),
    activities: projectActivities(demand.activities, names) })) }
}

function findDemand(snapshot: DemandStoreSnapshot, id: string, storePath: string): Demand {
  const demand = snapshot.demands.find((entry) => entry.id === id)
  if (!demand) throw new DemandStoreError('NOT_FOUND', 'validate', storePath, `Demand ${id} was not found`)
  return demand
}

function validateNewDemand(demand: Demand, storePath: string): void {
  try {
    parseDemand(demand, 'demand')
  } catch (error) {
    if (error instanceof DemandStoreError) throw error
    throw new DemandStoreError('INVALID_INPUT', 'validate', storePath, error instanceof Error ? error.message : String(error), error)
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function enqueue<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(root) ?? Promise.resolve()
  let release!: () => void
  const turn = new Promise<void>((resolve) => { release = resolve })
  const chained = previous.then(() => turn)
  queues.set(root, chained)
  await previous
  try {
    return await fn()
  } finally {
    release()
    if (queues.get(root) === chained) queues.delete(root)
  }
}

function rejectProvenanceInput(value: object): void {
  if (Object.hasOwn(value, 'progressUpdates') || Object.hasOwn(value, 'patrols')) throw new DemandStoreError('INVALID_INPUT', 'validate', '', 'Only the original responsibility owner records progress and inspection facts')
  if (Object.hasOwn(value, 'delegations')) throw new DemandStoreError('INVALID_INPUT', 'validate', '', 'Only the actual delegation owner can prepare, link, report or collect original business work.')
  if (Object.hasOwn(value, 'plan')) throw new DemandStoreError('INVALID_INPUT', 'validate', '', 'Revise the Goal plan through its plan revision, and record node verdicts through plan review.')
  if (['participations', 'creationOrigin', 'discussionOperationId', 'discussionIntent', 'discussionInputs', 'requesterParticipationId', 'requesterAsSupervisor', 'supervisorDefaultPending', 'assigneeExecutorId'].some(key => Object.hasOwn(value, key)))
    throw new DemandStoreError('INVALID_INPUT', 'validate', '', 'Original Goal provenance is authored only by the trusted host; assign accurate Sessions.')
  if (Object.hasOwn(value, 'executorId')) throw new DemandStoreError('INVALID_INPUT', 'validate', '', 'Executor is creation configuration, not a Goal assignee. Assign accurate Sessions.')
}
function appendParticipation(demand: Demand, source: DemandParticipationSource, operationId: string, recordedAt: number): void {
  const parsed = parseDemandParticipationSource(source)
  const previous = demand.participations.find(item => item.operationId === operationId && item.kind === parsed.kind && item.agentSessionId === parsed.agentSessionId)
  if (previous) {
    const { id: _id, operationId: _operation, recordedAt: _time, ...original } = previous
    if (JSON.stringify(original) !== JSON.stringify(parsed)) throw new DemandStoreError('INVALID_INPUT', 'validate', '', 'Original participation operation conflicts with its authenticated source.')
    return
  }
  demand.participations.push({ ...parsed, id: mintObjectId(), operationId, recordedAt })
}

function resolveCreationRequester(demand: Demand, source: DemandParticipationSource, operationId: string, allowSupervisorDefault: boolean): void {
  const origin = demand.creationOrigin!
  const participation = demand.participations.find(item => item.operationId === operationId && item.kind === source.kind && item.agentSessionId === source.agentSessionId)!
  origin.requesterParticipationId = participation.id
  if (origin.supervisorDefaultPending && origin.requesterAsSupervisor && allowSupervisorDefault && demand.supervisorSessionId === null) {
    demand.supervisorSessionId = source.agentSessionId
    demand.assigneeSessionIds = mergeDemandAgentReferences(demand.assigneeSessionIds, [source.agentSessionId])
    demand.sessionIds = mergeDemandAgentReferences(demand.sessionIds, [source.agentSessionId])
  }
  origin.supervisorDefaultPending = false
}
