import { parseDemandDispatchIntent, parseDemandDispatches, sameDemandDispatchIntent, type DemandDispatch, type DemandDispatchIntent } from './dispatch.js'
import { parseDemandDelegationIntent, parseDemandDelegations, parseDemandDelegationReportInput, parseDemandDelegationCollectionInput, parseDemandDelegationCollector, sameDemandDelegationIntent, validateDemandDelegationReport,
  parseDemandDelegationAttentionInput, sameDemandDelegationAttention,
  type DemandDelegation, type DemandDelegationIntent, type DemandDelegationReportInput, type DemandDelegationCollectionInput, type DemandDelegationCollector, type DemandDelegationAttentionInput } from './delegations.js'
import { parseDemandParticipations, parseDemandCreationOrigin, parseDemandParticipationSource, type DemandParticipationSource } from './collaboration.js'
import { appendDemandContentReferences, parseDemandContentReferences } from './content-references.js'
import { randomUUID } from 'node:crypto'
import { mintObjectId } from '@agentmux/identity'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  DEMAND_RECEIPT_SCHEMA,
  DEMAND_STORE_SCHEMA,
  type CreateDemandInput,
  type DemandCreateOptions,
  type Demand,
  type DemandActivity,
  type DemandActivityInspection,
  type DemandActivityRead,
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
import { demandNameContext, parseDemandNameChange } from './demand-name-change.js'
import { alignmentConfirmationIssue, groundingAcceptanceIssue, parseAlignment, parseAlignmentProposal, parseGrounding, parseGroundingProposal, type DemandAlignmentProposal, type DemandGroundingProposal } from './goals.js'

const INITIAL_REVISION = 0
const queues = new Map<string, Promise<void>>()

/** A rejected attempt can have a committed failure record; a write failure cannot claim an ACK. */
export class DemandNameChangeError extends DemandStoreError {
  constructor(error: DemandStoreError, readonly nameChange: DemandNameChangeRecord, readonly commitStatus: 'confirmed' | 'not_applied' | 'unknown') {
    super(error.code, error.phase, error.path,
      `${error.message} ${commitStatus === 'not_applied' ? 'Title change was not applied; its record was not committed.' : commitStatus === 'unknown' ? 'Title snapshot was replaced, but its durable commit is unconfirmed. The operation was not resent.' : 'The failed title attempt was recorded; the previous title is retained.'}`, error)
  }
}

class SnapshotWriteError extends DemandStoreError {
  constructor(storePath: string, cause: unknown, readonly replacementApplied: boolean) {
    super('WRITE_FAILED', 'write', storePath, `Could not atomically write Demand snapshot at ${storePath}`, cause)
  }
}

type TitleAttempt = DemandTitleMutationOptions & { targetId: string; requested: string | null }
type ActivityAttempt = { targetId: string; kind: string; message: string; actorId: string | null }

export type OpenDemandStoreOptions = {
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
    'phaseIndex',
    'sessionIds',
    'assigneeSessionIds',
    'supervisorSessionId',
    'participations',
    'creationOrigin',
    'contentRefs',
    'dispatches',
    'delegations',
    'activities',
    'decisions',
    'alignment',
    'grounding',
    'createdAt',
    'updatedAt',
  ], label, ['tags', 'plannedStartAt', 'targetAt', 'parentDemandId', 'phaseIndex', 'alignment', 'grounding', 'contentRefs', 'assigneeSessionIds', 'supervisorSessionId', 'participations', 'creationOrigin', 'dispatches', 'delegations'])
  if (!isDemandStatus(record.status)) throw new Error(`${label}.status is invalid`)
  if (!isDemandPriority(record.priority)) throw new Error(`${label}.priority is invalid`)
  if (!Array.isArray(record.activities)) throw new Error(`${label}.activities must be an array`)
  if (!Array.isArray(record.decisions)) throw new Error(`${label}.decisions must be an array`)
  const tags = record.tags === undefined ? [] : stringArray(record.tags, `${label}.tags`)
  const plannedStartAt = record.plannedStartAt === undefined || record.plannedStartAt === null ? null : timestamp(record.plannedStartAt, `${label}.plannedStartAt`)
  const targetAt = record.targetAt === undefined || record.targetAt === null ? null : timestamp(record.targetAt, `${label}.targetAt`)
  const parentDemandId = record.parentDemandId === undefined ? null : nullableString(record.parentDemandId, `${label}.parentDemandId`)
  const phaseIndex = record.phaseIndex === undefined || record.phaseIndex === null ? null : (typeof record.phaseIndex === 'number' && Number.isSafeInteger(record.phaseIndex) && record.phaseIndex >= 0 ? record.phaseIndex : (() => { throw new Error(`${label}.phaseIndex must be a non-negative integer`) })())
  const activities = record.activities.map((entry, index) => parseActivity(entry, `${label}.activities[${index}]`))
  const sessionIds = stringArray(record.sessionIds, `${label}.sessionIds`)
  const assigneeSessionIds = record.assigneeSessionIds === undefined ? [] : stringArray(record.assigneeSessionIds, `${label}.assigneeSessionIds`)
  const supervisorSessionId = record.supervisorSessionId === undefined ? null : nullableString(record.supervisorSessionId, `${label}.supervisorSessionId`)
  if (assigneeSessionIds.some(id => !sessionIds.includes(id)) || supervisorSessionId !== null && !assigneeSessionIds.includes(supervisorSessionId)) throw new Error(`${label} has inconsistent collaboration relations`)
  const participations = parseDemandParticipations(record.participations ?? [])
  const creationOrigin = record.creationOrigin === undefined ? undefined : parseDemandCreationOrigin(record.creationOrigin)
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
    parentDemandId,
    phaseIndex,
    sessionIds, assigneeSessionIds, supervisorSessionId, participations,
    ...(creationOrigin === undefined ? {} : { creationOrigin }),
    ...(record.contentRefs === undefined ? {} : { contentRefs: parseDemandContentReferences(record.contentRefs) }),
    dispatches: parseDemandDispatches(record.dispatches ?? []),
    ...(record.delegations === undefined ? {} : { delegations: parseDemandDelegations(record.delegations) }),
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
    exactKeys(record, ['schema', 'revision', 'updatedAt', 'demands', 'nameHistory'], 'snapshot', ['nameHistory'])
    if (record.schema !== DEMAND_STORE_SCHEMA) throw new Error('snapshot.schema is invalid')
    if (typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision) || record.revision < 0) {
      throw new Error('snapshot.revision must be a non-negative integer')
    }
    if (!Array.isArray(record.demands)) throw new Error('snapshot.demands must be an array')
    const demands = record.demands.map((entry, index) => parseDemand(entry, `snapshot.demands[${index}]`))
    if (new Set(demands.map((demand) => demand.id)).size !== demands.length) {
      throw new Error('snapshot.demands contains duplicate IDs')
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
  private readonly lockTimeoutMs: number
  private readonly lockRetryMs: number
  private readonly listeners = new Set<DemandStoreListener>()

  constructor(options: OpenDemandStoreOptions) {
    if (typeof options.root !== 'string' || options.root.trim() === '') {
      throw new DemandStoreError('INVALID_INPUT', 'validate', '', 'root must be a non-empty path')
    }
    this.root = path.resolve(options.root)
    this.storePath = path.join(this.root, 'store.json')
    this.lockPath = path.join(this.root, 'store.lock')
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
    return projectNameHistory(await this.readSnapshot())
  }

  private async readSnapshot(): Promise<DemandStoreSnapshot> {
    try {
      const raw = await fs.readFile(this.storePath, 'utf8')
      return parseSnapshot(JSON.parse(raw) as unknown, this.storePath)
    } catch (error) {
      if (error instanceof DemandStoreError) throw error
      if (isNodeError(error, 'ENOENT')) return emptySnapshot()
      if (error instanceof SyntaxError) {
        throw new DemandStoreError('INVALID_SNAPSHOT', 'read', this.storePath, `Demand snapshot is not valid JSON at ${this.storePath}`, error)
      }
      throw new DemandStoreError('READ_FAILED', 'read', this.storePath, `Could not read Demand snapshot at ${this.storePath}`, error)
    }
  }

  async list(): Promise<Demand[]> {
    return (await this.snapshot()).demands
  }

  async get(id: string): Promise<Demand | null> {
    const demand = (await this.snapshot()).demands.find((entry) => entry.id === id)
    return demand ? clone(demand) : null
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
    const operationId = options.operationId ?? `demand-create-${randomUUID()}`
    return this.mutate('create', (snapshot) => {
      const title = inputString(input.title, 'title')
      if (!title) throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'title is required')
      const id = input.id ?? mintObjectId()
      inputString(id, 'id')
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
        phaseIndex: input.phaseIndex ?? null,
        sessionIds: [...new Set([...(input.sessionIds ?? []), ...(input.assigneeSessionIds ?? [])])],
        assigneeSessionIds: [...(input.assigneeSessionIds ?? [])],
        supervisorSessionId: input.supervisorSessionId ?? null,
        participations: [],
        ...(options.creationOrigin ? { creationOrigin: { operationId, requesterAsSupervisor: options.creationOrigin.requesterAsSupervisor,
          requesterParticipationId: null, supervisorDefaultPending: options.creationOrigin.requesterAsSupervisor && !Object.hasOwn(input, 'supervisorSessionId') } } : {}),
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

  /** Only the explicit business Start owner calls this; ordinary updates cannot write it. */
  async prepareDispatch(id: string, input: DemandDispatchIntent): Promise<DemandReceipt> {
    const intent = parseDemandDispatchIntent(input)
    return this.mutate('dispatch.prepare', snapshot => {
      const demand = findDemand(snapshot, id, this.storePath)
      const owner = snapshot.demands.find(item => item.dispatches?.some(dispatch => dispatch.operationId === intent.operationId))
      const original = owner?.dispatches?.find(dispatch => dispatch.operationId === intent.operationId)
      if (original) {
        if (owner!.id !== id || !sameDemandDispatchIntent(original, intent)) throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'The original Start operation belongs to another Goal, Session, Run or input. Inspect it without resending.')
        return { unchanged: demand }
      }
      demand.dispatches = [...(demand.dispatches ?? []), { ...intent, stage: 'prepared', preparedAt: Date.now() }]
      demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
      return demand
    }, undefined, intent.operationId)
  }

  async inspectDispatch(id: string, operationId: string): Promise<DemandDispatch | null> {
    nonEmptyString(operationId, 'dispatch.operationId')
    return enqueue(this.root, async () => {
      const release = await this.acquireLock()
      try {
        const snapshot = await this.readSnapshot(), demand = findDemand(snapshot, id, this.storePath)
        await this.confirmSnapshot()
        return clone(demand.dispatches?.find(dispatch => dispatch.operationId === operationId) ?? null)
      } finally { await release() }
    })
  }

  /** A confirmed native input never regresses because a later reply or observation fails. */
  async recordDispatchPhase(id: string, operationId: string, phase: { stage: 'submitted' | 'unknown'; issue?: string } | { stage: 'confirmed'; receipt: NonNullable<DemandDispatch['receipt']> }): Promise<DemandReceipt> {
    return this.mutate('dispatch.' + phase.stage, snapshot => {
      const demand = findDemand(snapshot, id, this.storePath)
      const dispatches = demand.dispatches ?? [], index = dispatches.findIndex(dispatch => dispatch.operationId === operationId), original = dispatches[index]
      if (!original) throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'The original Start has not been prepared. Preserve the Agent and inspect its exact operation.')
      if (original.stage === 'confirmed') return { unchanged: demand }
      const { issue: _issue, ...frozen } = original
      const next: DemandDispatch = { ...frozen, stage: phase.stage, submittedAt: original.submittedAt ?? Date.now(), ...(phase.stage === 'confirmed' ? { receipt: phase.receipt } : phase.issue ? { issue: phase.issue } : {}) }
      parseDemandDispatches([next])
      if (JSON.stringify(original) === JSON.stringify(next)) return { unchanged: demand }
      demand.dispatches = dispatches.map((dispatch, at) => at === index ? next : dispatch)
      demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
      return demand
    }, undefined, operationId)
  }

  /** The host admits the caller and original Session/Run identities before preparing. */
  async prepareDelegation(id: string, input: DemandDelegationIntent, actorSessionId: string): Promise<DemandReceipt> {
    const intent = parseDemandDelegationIntent(input)
    return this.mutate('delegation.prepare', snapshot => {
      const demand = findDemand(snapshot, id, this.storePath)
      const owner = snapshot.demands.find(item => item.delegations?.some(entry => entry.operationId === intent.operationId || entry.sourceMessageId === intent.sourceMessageId))
      const original = owner?.delegations?.find(entry => entry.operationId === intent.operationId || entry.sourceMessageId === intent.sourceMessageId)
      if (actorSessionId !== intent.ownerAgentSessionId) this.rejectDelegation('Only the original authenticated owner can prepare this delegation.')
      if (original) {
        if (owner!.id !== id || !sameDemandDelegationIntent(original, intent)) this.rejectDelegation('The original delegation identity belongs to a different Goal, worker, Run or frozen input. Inspect it without resending.')
        return { unchanged: demand }
      }
      if (demand.supervisorSessionId !== actorSessionId || !demand.assigneeSessionIds.includes(intent.workerAgentSessionId) || !demand.sessionIds.includes(intent.workerAgentSessionId) || intent.workerAgentSessionId === actorSessionId)
        this.rejectDelegation('A new delegation requires the current Supervisor and a distinct accurate assigned worker Session.')
      const alignment = demand.alignment
      if (!alignment || alignment.revision !== intent.alignmentRevision || intent.criterionIds.some(criterionId => !alignment.criteria.some(criterion => criterion.id === criterionId)))
        this.rejectDelegation('A new delegation must reference the current proposal and its original success criteria.')
      demand.delegations = [...(demand.delegations ?? []), { ...intent, preparedAt: Date.now(), capturedCriteria: clone(alignment.criteria.filter(criterion => intent.criterionIds.includes(criterion.id))) }]
      demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
      validateNewDemand(demand, this.storePath)
      return demand
    }, undefined, intent.operationId)
  }

  async inspectDelegation(id: string, operationId: string): Promise<DemandDelegation | null> {
    nonEmptyString(operationId, 'delegation.operationId')
    return enqueue(this.root, async () => {
      const release = await this.acquireLock()
      try {
        const snapshot = await this.readSnapshot(), demand = findDemand(snapshot, id, this.storePath)
        await this.confirmSnapshot()
        return clone(demand.delegations?.find(entry => entry.operationId === operationId) ?? null)
      } finally { await release() }
    })
  }

  /** Call only after Main has verified this exact source envelope through Core. */
  async linkDelegation(id: string, operationId: string, sourceMessageId: string, actorSessionId: string): Promise<DemandReceipt> {
    return this.mutate('delegation.link', snapshot => {
      const demand = findDemand(snapshot, id, this.storePath), entry = this.findDelegation(demand, operationId)
      if (entry.sourceMessageId !== sourceMessageId || actorSessionId !== entry.ownerAgentSessionId && actorSessionId !== demand.supervisorSessionId)
        this.rejectDelegation('The original source message and authenticated owner must match this delegation.')
      if (entry.linkedAt !== undefined) return { unchanged: demand }
      entry.linkedAt = Date.now()
      demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
      return demand
    }, undefined, operationId)
  }

  /** Core verifies replyTo/thread/author; Demand verifies the frozen business scope. */
  async submitDelegationReport(id: string, delegationOperationId: string, input: DemandDelegationReportInput, actorSessionId: string): Promise<DemandReceipt> {
    const report = parseDemandDelegationReportInput(input)
    return this.recordDelegationReport(id, delegationOperationId, report, { worker: actorSessionId })
  }

  /** Main must verify the original structured Core reply before calling this owner. */
  async recoverDelegationReport(id: string, delegationOperationId: string, input: DemandDelegationReportInput, admittedCollector: DemandDelegationCollector): Promise<DemandReceipt> {
    const report = parseDemandDelegationReportInput(input), collector = parseDemandDelegationCollector(admittedCollector)
    return this.recordDelegationReport(id, delegationOperationId, report, { collector })
  }

  private async recordDelegationReport(id: string, delegationOperationId: string, report: DemandDelegationReportInput,
    author: { worker: string } | { collector: DemandDelegationCollector }): Promise<DemandReceipt> {
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
        const { submittedAt: _time, recovery: _recovery, ...original } = entry.report
        if (JSON.stringify(original) !== JSON.stringify(report)) this.rejectDelegation('The original worker report is frozen. A duplicate or late report cannot replace its evidence or collection.')
        return { unchanged: demand }
      }
      if (entry.linkedAt === undefined) this.rejectDelegation('The original Core dispatch association is not confirmed. Inspect it before recording its reply.')
      const submittedAt = Date.now()
      entry.report = { ...report, submittedAt, ...('collector' in author ? { recovery: { collector: author.collector, recoveredAt: submittedAt } } : {}) }
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
            if (distinct.size > 1) return { criterionId: criterion.id, outcome: 'unknown' as const, evidence: [...new Set(sources.flatMap(source => source.check.evidence))], note: `Conflicting reports: ${sources.map(source => source.replyMessageId).join(', ')}. Review the original reports.` }
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
      const previous = snapshot.demands.flatMap(item => (item.delegations ?? []).map(delegation => ({ goalId: item.id, delegation })))
        .find(item => item.delegation.attention?.operationId === attention.operationId || item.delegation.attention?.intentId === attention.intentId)
      if (previous && (previous.goalId !== id || previous.delegation.operationId !== delegationOperationId)) this.rejectDelegation('The original attention input belongs to another delegation. Inspect that exact reference.')
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
        demand.sessionIds = [...new Set([...demand.sessionIds, ...patch.assigneeSessionIds])]
      }
      if (Object.hasOwn(patch, 'supervisorSessionId')) {
        demand.supervisorSessionId = patch.supervisorSessionId ?? null
        if (demand.creationOrigin) demand.creationOrigin.supervisorDefaultPending = false
      }
      if (patch.tags !== undefined) demand.tags = [...patch.tags]
      if (patch.plannedStartAt !== undefined) demand.plannedStartAt = patch.plannedStartAt
      if (patch.targetAt !== undefined) demand.targetAt = patch.targetAt
      if (patch.parentDemandId !== undefined) demand.parentDemandId = patch.parentDemandId
      if (patch.phaseIndex !== undefined) demand.phaseIndex = patch.phaseIndex
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
      if (options.participation) appendParticipation(demand, options.participation, options.operationId ?? `demand-participation-${randomUUID()}`, Date.now())
      demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
      validateNewDemand(demand, this.storePath)
      return demand
    }, patch.title === undefined ? undefined : { ...options, targetId: id, requested: typeof patch.title === 'string' ? patch.title : null }, options.operationId)
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
  async acceptGrounding(id: string, expectedAlignmentRevision: number, expectedSubmissionId: string, acceptGaps = false): Promise<DemandReceipt> {
    return this.mutate('accept-grounding', snapshot => {
      const demand = findDemand(snapshot, id, this.storePath)
      if (demand.alignment?.revision !== expectedAlignmentRevision || demand.grounding?.submissionId !== expectedSubmissionId) {
        throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'The goal or results changed. Read the current results before accepting them.')
      }
      if (typeof acceptGaps !== 'boolean') throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'Accepting with gaps requires an explicit boolean choice.')
      const issue = groundingAcceptanceIssue(demand.alignment, demand.grounding, acceptGaps)
      if (issue) throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, issue)
      if (demand.grounding.acceptedAt === null) {
        demand.grounding.acceptedAt = Date.now()
        demand.activities.push({ id: mintObjectId(), kind: 'results-accepted', message: acceptGaps ? 'User accepted these results while retaining the reported gaps.' : 'User accepted these results.', createdAt: demand.grounding.acceptedAt, actorId: null })
      }
      demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
      return demand
    })
  }

  async remove(id: string): Promise<{ schema: typeof DEMAND_RECEIPT_SCHEMA; operation: 'remove'; operationId: string; revision: number; demand: Demand }> {
    return this.mutate('remove', (snapshot) => {
      const index = snapshot.demands.findIndex((entry) => entry.id === id)
      if (index < 0) throw new DemandStoreError('NOT_FOUND', 'validate', this.storePath, `Demand ${id} was not found`)
      return snapshot.demands.splice(index, 1)[0]!
    }) as Promise<{ schema: typeof DEMAND_RECEIPT_SCHEMA; operation: 'remove'; operationId: string; revision: number; demand: Demand }>
  }

  async delete(id: string): Promise<{ schema: typeof DEMAND_RECEIPT_SCHEMA; operation: 'remove'; operationId: string; revision: number; demand: Demand }> {
    return this.remove(id)
  }

  async linkSession(id: string, sessionId: string): Promise<DemandReceipt> {
    return this.mutate('link-session', (snapshot) => {
      const demand = findDemand(snapshot, id, this.storePath)
      inputString(sessionId, 'sessionId')
      if (!demand.sessionIds.includes(sessionId)) demand.sessionIds.push(sessionId)
      demand.updatedAt = Math.max(Date.now(), demand.updatedAt + 1)
      return demand
    })
  }

  async unlinkSession(id: string, sessionId: string): Promise<DemandReceipt> {
    return this.mutate('unlink-session', (snapshot) => {
      const demand = findDemand(snapshot, id, this.storePath)
      demand.sessionIds = demand.sessionIds.filter((entry) => entry !== sessionId)
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
      const release = await this.acquireLock()
      try {
        const snapshot = await this.readSnapshot()
        const demand = findDemand(snapshot, id, this.storePath)
        await this.confirmSnapshot()
        return { demandId: id, operationId, activity: clone(demand.activities.find(activity => activity.operationId === operationId) ?? null), diskDurability: 'confirmed' }
      } finally { await release() }
    })
  }

  async readActivities(id: string): Promise<DemandActivityRead> {
    return enqueue(this.root, async () => {
      const release = await this.acquireLock()
      try {
        const snapshot = await this.readSnapshot()
        const demand = findDemand(snapshot, id, this.storePath)
        await this.confirmSnapshot()
        return { demandId: id, activities: clone(demand.activities), diskDurability: 'confirmed' }
      } finally { await release() }
    })
  }

  async addDecision(id: string, input: Omit<DemandDecision, 'id' | 'createdAt'> & { id?: string; createdAt?: number }): Promise<DemandReceipt> {
    return this.mutate('decision-log', (snapshot) => {
      const demand = findDemand(snapshot, id, this.storePath)
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
      const release = await this.acquireLock()
      try {
        let snapshot = await this.readSnapshot()
        const operationId = titleAttempt?.operationId ?? requestedOperationId ?? `demand-op-${snapshot.revision + 1}-${randomUUID()}`
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
        const published = projectNameHistory(snapshot)
        const result: DemandReceipt = { schema: DEMAND_RECEIPT_SCHEMA, operation, operationId, revision: snapshot.revision,
          demand: { ...clone(demand), activities: projectActivities(demand.activities, new Map(snapshot.nameHistory.map(change => [change.id, change]))) }, ...(nameChange ? { nameChange: clone(nameChange) } : {}) }
        for (const listener of this.listeners) {
          try { listener(published) } catch {
            console.warn(`Demand snapshot observer failed after confirmed revision ${snapshot.revision}, operation ${operationId}.`)
          }
        }
        if (failure) throw new DemandNameChangeError(failure, clone(nameChange!), 'confirmed')
        return result
      } finally {
        await release()
      }
    })
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const startedAt = Date.now()
    while (true) {
      try {
        const handle = await fs.open(this.lockPath, 'wx', 0o600)
        await handle.writeFile(`${process.pid}\n${Date.now()}\n`, 'utf8')
        await handle.sync()
        await handle.close()
        return async () => {
          await fs.rm(this.lockPath, { force: true })
        }
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) {
          throw new DemandStoreError('WRITE_FAILED', 'lock', this.lockPath, `Could not acquire Demand lock at ${this.lockPath}`, error)
        }
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new DemandStoreError('LOCK_TIMEOUT', 'lock', this.lockPath, `Timed out waiting for Demand lock at ${this.lockPath}`)
        }
        await delay(this.lockRetryMs)
      }
    }
  }

  private async writeSnapshot(snapshot: DemandStoreSnapshot): Promise<void> {
    const tempPath = `${this.storePath}.tmp-${process.pid}-${randomUUID()}`
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
  if (Object.hasOwn(value, 'delegations')) throw new DemandStoreError('INVALID_INPUT', 'validate', '', 'Only the actual delegation owner can prepare, link, report or collect original business work.')
  if (['participations', 'creationOrigin', 'requesterParticipationId', 'requesterAsSupervisor', 'supervisorDefaultPending', 'assigneeExecutorId'].some(key => Object.hasOwn(value, key)))
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
    demand.assigneeSessionIds = [...new Set([...demand.assigneeSessionIds, source.agentSessionId])]
    demand.sessionIds = [...new Set([...demand.sessionIds, source.agentSessionId])]
  }
  origin.supervisorDefaultPending = false
}
