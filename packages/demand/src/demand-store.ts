import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  DEMAND_RECEIPT_SCHEMA,
  DEMAND_STORE_SCHEMA,
  type CreateDemandInput,
  type Demand,
  type DemandActivity,
  type DemandDecision,
  type DemandReceipt,
  type DemandStoreListener,
  type DemandStoreSnapshot,
  type DemandStatus,
  type DemandPriority,
  type UpdateDemandInput,
  isDemandPriority,
  isDemandStatus,
} from './demand-types.js'
import { DemandStoreError } from './errors.js'

const INITIAL_REVISION = 0
const queues = new Map<string, Promise<void>>()

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

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const expectedSet = new Set(expected)
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) throw new Error(`${label} has unknown field ${key}`)
  }
  for (const key of expected) {
    if (!(key in value)) throw new Error(`${label} is missing ${key}`)
  }
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
  exactKeys(record, ['id', 'kind', 'message', 'createdAt', 'actorId'], label)
  return {
    id: nonEmptyString(record.id, `${label}.id`),
    kind: nonEmptyString(record.kind, `${label}.kind`),
    message: nonEmptyString(record.message, `${label}.message`),
    createdAt: timestamp(record.createdAt, `${label}.createdAt`),
    actorId: nullableString(record.actorId, `${label}.actorId`),
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
    'sessionIds',
    'activities',
    'decisions',
    'createdAt',
    'updatedAt',
  ], label)
  if (!isDemandStatus(record.status)) throw new Error(`${label}.status is invalid`)
  if (!isDemandPriority(record.priority)) throw new Error(`${label}.priority is invalid`)
  if (!Array.isArray(record.activities)) throw new Error(`${label}.activities must be an array`)
  if (!Array.isArray(record.decisions)) throw new Error(`${label}.decisions must be an array`)
  return {
    id: nonEmptyString(record.id, `${label}.id`),
    title: nonEmptyString(record.title, `${label}.title`),
    description: typeof record.description === 'string' ? record.description : (() => { throw new Error(`${label}.description must be a string`) })(),
    status: record.status,
    priority: record.priority,
    projectId: nullableString(record.projectId, `${label}.projectId`),
    projectName: nullableString(record.projectName, `${label}.projectName`),
    executorId: nullableString(record.executorId, `${label}.executorId`),
    sessionIds: stringArray(record.sessionIds, `${label}.sessionIds`),
    activities: record.activities.map((entry, index) => parseActivity(entry, `${label}.activities[${index}]`)),
    decisions: record.decisions.map((entry, index) => parseDecision(entry, `${label}.decisions[${index}]`)),
    createdAt: timestamp(record.createdAt, `${label}.createdAt`),
    updatedAt: timestamp(record.updatedAt, `${label}.updatedAt`),
  }
}

function parseSnapshot(value: unknown, storePath: string): DemandStoreSnapshot {
  try {
    const record = object(value, 'snapshot')
    exactKeys(record, ['schema', 'revision', 'updatedAt', 'demands'], 'snapshot')
    if (record.schema !== DEMAND_STORE_SCHEMA) throw new Error('snapshot.schema is invalid')
    if (typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision) || record.revision < 0) {
      throw new Error('snapshot.revision must be a non-negative integer')
    }
    if (!Array.isArray(record.demands)) throw new Error('snapshot.demands must be an array')
    const demands = record.demands.map((entry, index) => parseDemand(entry, `snapshot.demands[${index}]`))
    if (new Set(demands.map((demand) => demand.id)).size !== demands.length) {
      throw new Error('snapshot.demands contains duplicate IDs')
    }
    return {
      schema: DEMAND_STORE_SCHEMA,
      revision: record.revision,
      updatedAt: timestamp(record.updatedAt, 'snapshot.updatedAt'),
      demands,
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
    try {
      const raw = await fs.readFile(this.storePath, 'utf8')
      return clone(parseSnapshot(JSON.parse(raw) as unknown, this.storePath))
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

  async create(input: CreateDemandInput): Promise<DemandReceipt> {
    return this.mutate('create', (snapshot) => {
      const title = inputString(input.title, 'title')
      if (!title) throw new DemandStoreError('INVALID_INPUT', 'validate', this.storePath, 'title is required')
      const id = input.id ?? `demand_${randomUUID()}`
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
        executorId: input.executorId ?? null,
        sessionIds: [...(input.sessionIds ?? [])],
        activities: [],
        decisions: [],
        createdAt: now,
        updatedAt: now,
      }
      validateNewDemand(demand, this.storePath)
      snapshot.demands.push(demand)
      return demand
    })
  }

  async update(id: string, patch: UpdateDemandInput): Promise<DemandReceipt> {
    return this.mutate('update', (snapshot) => {
      const demand = findDemand(snapshot, id, this.storePath)
      if (patch.title !== undefined) demand.title = inputString(patch.title, 'title') ?? demand.title
      if (patch.description !== undefined) demand.description = patch.description
      if (patch.status !== undefined) demand.status = ensureStatus(patch.status, 'status') ?? demand.status
      if (patch.priority !== undefined) demand.priority = ensurePriority(patch.priority, 'priority') ?? demand.priority
      if (patch.projectId !== undefined) demand.projectId = patch.projectId
      if (patch.projectName !== undefined) demand.projectName = patch.projectName
      if (patch.executorId !== undefined) demand.executorId = patch.executorId
      demand.updatedAt = Date.now()
      validateNewDemand(demand, this.storePath)
      return demand
    })
  }

  async remove(id: string): Promise<{ schema: typeof DEMAND_RECEIPT_SCHEMA; operation: 'remove'; revision: number; demand: Demand }> {
    return this.mutate('remove', (snapshot) => {
      const index = snapshot.demands.findIndex((entry) => entry.id === id)
      if (index < 0) throw new DemandStoreError('NOT_FOUND', 'validate', this.storePath, `Demand ${id} was not found`)
      return snapshot.demands.splice(index, 1)[0]!
    }) as Promise<{ schema: typeof DEMAND_RECEIPT_SCHEMA; operation: 'remove'; revision: number; demand: Demand }>
  }

  async linkSession(id: string, sessionId: string): Promise<DemandReceipt> {
    return this.mutate('link-session', (snapshot) => {
      const demand = findDemand(snapshot, id, this.storePath)
      inputString(sessionId, 'sessionId')
      if (!demand.sessionIds.includes(sessionId)) demand.sessionIds.push(sessionId)
      demand.updatedAt = Date.now()
      return demand
    })
  }

  async unlinkSession(id: string, sessionId: string): Promise<DemandReceipt> {
    return this.mutate('unlink-session', (snapshot) => {
      const demand = findDemand(snapshot, id, this.storePath)
      demand.sessionIds = demand.sessionIds.filter((entry) => entry !== sessionId)
      demand.updatedAt = Date.now()
      return demand
    })
  }

  async linkProject(id: string, projectId: string, projectName?: string | null): Promise<DemandReceipt> {
    return this.update(id, { projectId, ...(projectName === undefined ? {} : { projectName }) })
  }

  async unlinkProject(id: string): Promise<DemandReceipt> {
    return this.update(id, { projectId: null, projectName: null })
  }

  async addActivity(id: string, input: Omit<DemandActivity, 'id' | 'createdAt'> & { id?: string; createdAt?: number }): Promise<DemandReceipt> {
    return this.mutate('activity', (snapshot) => {
      const demand = findDemand(snapshot, id, this.storePath)
      const activity: DemandActivity = {
        id: input.id ?? `activity_${randomUUID()}`,
        kind: input.kind,
        message: input.message,
        actorId: input.actorId,
        createdAt: input.createdAt ?? Date.now(),
      }
      parseActivity(activity, 'activity')
      demand.activities.push(activity)
      demand.updatedAt = Date.now()
      return demand
    })
  }

  async addDecision(id: string, input: Omit<DemandDecision, 'id' | 'createdAt'> & { id?: string; createdAt?: number }): Promise<DemandReceipt> {
    return this.mutate('decision-log', (snapshot) => {
      const demand = findDemand(snapshot, id, this.storePath)
      const decision: DemandDecision = {
        id: input.id ?? `decision_${randomUUID()}`,
        question: input.question,
        decision: input.decision,
        rationale: input.rationale,
        actorId: input.actorId,
        createdAt: input.createdAt ?? Date.now(),
      }
      parseDecision(decision, 'decision')
      demand.decisions.push(decision)
      demand.updatedAt = Date.now()
      return demand
    })
  }

  private async mutate(operation: string, fn: (snapshot: DemandStoreSnapshot) => Demand): Promise<DemandReceipt> {
    return enqueue(this.root, async () => {
      await fs.mkdir(this.root, { recursive: true })
      const release = await this.acquireLock()
      try {
        const snapshot = await this.snapshot()
        const demand = fn(snapshot)
        snapshot.revision += 1
        snapshot.updatedAt = Date.now()
        await this.writeSnapshot(snapshot)
        const result = { schema: 'agentmux.demand-receipt.v1' as const, operation, revision: snapshot.revision, demand: clone(demand) }
        const published = clone(snapshot)
        for (const listener of this.listeners) listener(published)
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
    try {
      const handle = await fs.open(tempPath, 'wx', 0o600)
      await handle.writeFile(data, 'utf8')
      await handle.sync()
      await handle.close()
      await fs.rename(tempPath, this.storePath)
      try {
        const directory = await fs.open(this.root, 'r')
        await directory.sync()
        await directory.close()
      } catch (error) {
        if (!isNodeError(error, 'EINVAL') && !isNodeError(error, 'ENOTSUP')) throw error
      }
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined)
      if (error instanceof DemandStoreError) throw error
      throw new DemandStoreError('WRITE_FAILED', 'write', this.storePath, `Could not atomically write Demand snapshot at ${this.storePath}`, error)
    }
  }
}

export function openDemandStore(options: OpenDemandStoreOptions): DemandStore {
  return new DemandStore(options)
}

function emptySnapshot(): DemandStoreSnapshot {
  return { schema: DEMAND_STORE_SCHEMA, revision: INITIAL_REVISION, updatedAt: Date.now(), demands: [] }
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
