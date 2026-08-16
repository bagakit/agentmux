import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { durableWriteFile } from '@agentmux/core'
import type {
  BrowserOperation,
  BrowserOperationPhase,
  BrowserOperationStep,
  BrowserOperator,
  BrowserReplayPlan,
  BrowserReplayStep,
  BrowserReplayTarget
} from '../shared/browser-operation.js'

/** The on-disk shape is deliberately a snapshot, rather than an append-only log. */
export const BROWSER_OPERATION_JOURNAL_VERSION = 1 as const
export const BROWSER_OPERATION_JOURNAL_FILE = 'browser-operation-journal.json'

/** Keep the journal useful after a long-running Browser session without growing without bound. */
export const MAX_BROWSER_OPERATIONS = 64
export const MAX_BROWSER_OPERATION_EVENTS = 512
export const MAX_BROWSER_OPERATION_STEPS = 128
const MAX_FIELD_LENGTH = 240
const MAX_REPLAY_ARGS = 12

export type BrowserOperationEvent =
  | {
      type: 'operation-started'
      operationId: string
      at: number
      operation: BrowserOperation
    }
  | {
      type: 'phase-changed'
      operationId: string
      at: number
      phase: BrowserOperationPhase
      warning?: string
    }
  | {
      type: 'step-started'
      operationId: string
      at: number
      step: BrowserOperationStep
    }
  | {
      type: 'step-finished'
      operationId: string
      at: number
      step: BrowserOperationStep
    }
  | {
      type: 'operation-finished'
      operationId: string
      at: number
      operation: BrowserOperation
    }
  | {
      type: 'operation-recovered'
      operationId: string
      at: number
      warning: string
    }

export type BrowserOperationJournalDocument = {
  version: typeof BROWSER_OPERATION_JOURNAL_VERSION
  operations: BrowserOperation[]
  events: BrowserOperationEvent[]
}

export interface BrowserOperationJournalStore {
  load(): Promise<BrowserOperationJournalDocument | null>
  save(document: BrowserOperationJournalDocument): Promise<void>
}

/**
 * The file store is intentionally independent of Electron. Main creates it with its userData path;
 * tests and embedders can use a temporary path. A damaged or missing journal is an empty journal,
 * because an activity history must never stop a healthy Browser from opening.
 */
export class BrowserOperationFileStore implements BrowserOperationJournalStore {
  private saveTail: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  async load(): Promise<BrowserOperationJournalDocument | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      return isJournalDocument(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  async save(document: BrowserOperationJournalDocument): Promise<void> {
    const operation = this.saveTail.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      await durableWriteFile(this.path, `${JSON.stringify(document, null, 2)}\n`)
    })
    this.saveTail = operation.then(() => {}, () => {})
    await operation
  }
}

export type BrowserOperationStart = {
  id?: string
  browserId: string
  operator: BrowserOperator
  summary: string
  url: string
  replayOf?: string
}

export type BrowserOperationStepStart = {
  method: string
  label: string
  ref?: string
  target?: BrowserReplayTarget
  replay?: BrowserReplayStep
  summary?: string
}

export type BrowserOperationStepFinish = {
  status: Exclude<BrowserOperationStep['status'], 'running'>
  summary?: string
  replay?: BrowserReplayStep
  target?: BrowserReplayTarget
}

export type BrowserOperationJournalListener = (
  event: BrowserOperationEvent,
  operation: BrowserOperation | null,
  warning?: string
) => void

type JournalOptions = {
  now?: () => number
  id?: () => string
  maxOperations?: number
  maxEvents?: number
  maxSteps?: number
  onEvent?: BrowserOperationJournalListener
}

const ACTIVE_PHASES = new Set<BrowserOperationPhase>(['preparing', 'running', 'waiting', 'human'])
const OPERATION_WARNING = 'The application restarted before this Browser operation reported its final state.'

/**
 * Main-owned operation facts for Browser RSI. This class intentionally does not know about Electron,
 * IPC, or React. It is the small state machine that gives every surface one operation id and one
 * ordered event stream. Persistence is advisory: a broken journal produces a warning while the live
 * Browser run continues.
 */
export class BrowserOperationJournal {
  private document: BrowserOperationJournalDocument = emptyDocument()
  private loaded: Promise<void> | null = null
  private readonly saveStore: BrowserOperationJournalStore
  private readonly now: () => number
  private readonly makeId: () => string
  private readonly maxOperations: number
  private readonly maxEvents: number
  private readonly maxSteps: number
  private readonly onEvent: BrowserOperationJournalListener | undefined
  private warning: string | undefined

  constructor(store: BrowserOperationJournalStore, options: JournalOptions = {}) {
    this.saveStore = store
    this.now = options.now ?? Date.now
    this.makeId = options.id ?? randomUUID
    this.maxOperations = Math.max(1, Math.floor(options.maxOperations ?? MAX_BROWSER_OPERATIONS))
    this.maxEvents = Math.max(1, Math.floor(options.maxEvents ?? MAX_BROWSER_OPERATION_EVENTS))
    this.maxSteps = Math.max(1, Math.floor(options.maxSteps ?? MAX_BROWSER_OPERATION_STEPS))
    this.onEvent = options.onEvent
  }

  /** Load once. Any unfinished operation is made explicitly indeterminate after a restart. */
  async ready(): Promise<void> {
    if (!this.loaded) {
      this.loaded = this.load()
    }
    await this.loaded
  }

  async start(input: BrowserOperationStart): Promise<BrowserOperation> {
    await this.ready()
    const at = this.now()
    const operation = sanitizeOperation({
      id: input.id?.trim() || this.makeId(),
      browserId: input.browserId,
      operator: input.operator,
      startedAt: at,
      phase: 'preparing',
      summary: input.summary,
      url: input.url,
      steps: [],
      ...(input.replayOf ? { replayOf: input.replayOf } : {})
    })
    this.document.operations.push(operation)
    this.trim()
    this.publish({ type: 'operation-started', operationId: operation.id, at, operation })
    await this.persist()
    return cloneOperation(operation)
  }

  async setPhase(
    operationId: string,
    phase: BrowserOperationPhase,
    options: { warning?: string; summary?: string } = {}
  ): Promise<BrowserOperation | null> {
    await this.ready()
    const operation = this.find(operationId)
    if (!operation) return null
    operation.phase = phase
    if (options.summary !== undefined) operation.summary = clamp(options.summary)
    if (options.warning !== undefined) operation.warning = clamp(options.warning)
    this.publish({
      type: 'phase-changed',
      operationId,
      at: this.now(),
      phase,
      ...(options.warning ? { warning: clamp(options.warning) } : {})
    })
    await this.persist()
    return cloneOperation(operation)
  }

  async startStep(operationId: string, input: BrowserOperationStepStart): Promise<BrowserOperationStep | null> {
    await this.ready()
    const operation = this.find(operationId)
    if (!operation) return null
    const startedAt = this.now()
    const sequence = operation.steps.length === 0
      ? 1
      : Math.max(...operation.steps.map((step) => step.sequence)) + 1
    const step = sanitizeStep({
      sequence,
      method: input.method,
      label: input.label,
      startedAt,
      status: 'running',
      ...(input.ref ? { ref: input.ref } : {}),
      ...(input.target ? { target: input.target } : {}),
      ...(input.summary ? { summary: input.summary } : {}),
      ...(input.replay ? { replay: input.replay } : {})
    })
    operation.steps.push(step)
    trimSteps(operation, this.maxSteps)
    if (operation.phase === 'preparing' || operation.phase === 'waiting') operation.phase = 'running'
    this.publish({ type: 'step-started', operationId, at: startedAt, step })
    await this.persist()
    return cloneStep(step)
  }

  async finishStep(
    operationId: string,
    sequence: number,
    input: BrowserOperationStepFinish
  ): Promise<BrowserOperationStep | null> {
    await this.ready()
    const operation = this.find(operationId)
    const step = operation?.steps.find((candidate) => candidate.sequence === sequence)
    if (!operation || !step) return null
    step.status = input.status
    step.finishedAt = this.now()
    if (input.summary !== undefined) step.summary = clamp(input.summary)
    if (input.target !== undefined) step.target = sanitizeTarget(input.target)
    if (input.replay !== undefined) step.replay = sanitizeReplay(input.replay)
    this.publish({ type: 'step-finished', operationId, at: step.finishedAt, step })
    await this.persist()
    return cloneStep(step)
  }

  async finish(
    operationId: string,
    phase: Exclude<BrowserOperationPhase, 'preparing' | 'running' | 'waiting' | 'human'>,
    options: { summary?: string; warning?: string } = {}
  ): Promise<BrowserOperation | null> {
    await this.ready()
    const operation = this.find(operationId)
    if (!operation) return null
    const at = this.now()
    operation.phase = phase
    operation.finishedAt = at
    if (options.summary !== undefined) operation.summary = clamp(options.summary)
    if (options.warning !== undefined) operation.warning = clamp(options.warning)
    this.publish({ type: 'operation-finished', operationId, at, operation })
    await this.persist()
    return cloneOperation(operation)
  }

  async get(operationId: string): Promise<BrowserOperation | null> {
    await this.ready()
    const operation = this.find(operationId)
    return operation ? cloneOperation(operation) : null
  }

  async list(): Promise<BrowserOperation[]> {
    await this.ready()
    return this.document.operations.map(cloneOperation)
  }

  async events(operationId?: string): Promise<BrowserOperationEvent[]> {
    await this.ready()
    const events = operationId
      ? this.document.events.filter((event) => event.operationId === operationId)
      : this.document.events
    return events.map(cloneEvent)
  }

  async replayPlan(operationId: string): Promise<BrowserReplayPlan | null> {
    const operation = await this.get(operationId)
    if (!operation) return null
    const steps = operation.steps
      .filter((step) => step.status === 'completed' && step.replay)
      .map((step) => sanitizeReplay(step.replay as BrowserReplayStep))
    return {
      schema: 'agentmux.browser-replay.v1',
      operationId: operation.id,
      url: stripUrl(operation.url),
      steps
    }
  }

  /** Useful for the Browser rail when the disk journal is unavailable. */
  getPersistenceWarning(): string | undefined {
    return this.warning
  }

  private async load(): Promise<void> {
    try {
      const loaded = await this.saveStore.load()
      if (loaded && isJournalDocument(loaded)) {
        this.document = normalizeDocument(loaded)
      } else {
        this.document = emptyDocument()
        this.warning = 'Browser activity history is unavailable because its journal is damaged or unreadable.'
      }
    } catch (error) {
      this.document = emptyDocument()
      this.warning = `Browser activity history is unavailable: ${error instanceof Error ? error.message : String(error)}`
      return
    }
    let recovered = false
    const at = this.now()
    for (const operation of this.document.operations) {
      if (!ACTIVE_PHASES.has(operation.phase)) continue
      operation.phase = 'indeterminate'
      operation.finishedAt = at
      operation.warning = OPERATION_WARNING
      for (const step of operation.steps) {
        if (step.status !== 'running') continue
        step.status = 'stopped'
        step.finishedAt = at
        step.summary = 'Operation was interrupted by application restart'
      }
      this.document.events.push({
        type: 'operation-recovered',
        operationId: operation.id,
        at,
        warning: OPERATION_WARNING
      })
      recovered = true
    }
    if (recovered) {
      this.trim()
      await this.persist()
    }
  }

  private find(operationId: string): BrowserOperation | undefined {
    return this.document.operations.find((operation) => operation.id === operationId)
  }

  private publish(event: BrowserOperationEvent): void {
    this.document.events.push(cloneEvent(event))
    this.trim()
    try {
      this.onEvent?.(
        cloneEvent(event),
        this.find(event.operationId) ? cloneOperation(this.find(event.operationId) as BrowserOperation) : null,
        this.warning
      )
    } catch {
      // An activity projection is a view of the Browser, never a gate in its control path.
    }
  }

  private trim(): void {
    trimOperations(this.document, this.maxOperations)
    if (this.document.events.length > this.maxEvents) {
      this.document.events = this.document.events.slice(-this.maxEvents)
    }
  }

  private async persist(): Promise<void> {
    try {
      await this.saveStore.save(normalizeDocument(this.document))
    } catch (error) {
      this.warning = `Browser activity history could not be saved: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

function emptyDocument(): BrowserOperationJournalDocument {
  return { version: BROWSER_OPERATION_JOURNAL_VERSION, operations: [], events: [] }
}

function cloneOperation(operation: BrowserOperation): BrowserOperation {
  return JSON.parse(JSON.stringify(operation)) as BrowserOperation
}

function cloneStep(step: BrowserOperationStep): BrowserOperationStep {
  return JSON.parse(JSON.stringify(step)) as BrowserOperationStep
}

function cloneEvent(event: BrowserOperationEvent): BrowserOperationEvent {
  return JSON.parse(JSON.stringify(event)) as BrowserOperationEvent
}

function clamp(value: string): string {
  return value.length > MAX_FIELD_LENGTH ? `${value.slice(0, MAX_FIELD_LENGTH - 1)}…` : value
}

function stripUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return clamp(value)
  }
}

function sanitizeOperation(operation: BrowserOperation): BrowserOperation {
  return {
    ...operation,
    id: clamp(operation.id),
    browserId: clamp(operation.browserId),
    operator: {
      id: clamp(operation.operator.id),
      name: clamp(operation.operator.name),
      ...(operation.operator.providerId ? { providerId: clamp(operation.operator.providerId) } : {})
    },
    summary: clamp(operation.summary),
    url: stripUrl(operation.url),
    steps: operation.steps.slice(-MAX_BROWSER_OPERATION_STEPS).map(sanitizeStep),
    ...(operation.warning ? { warning: clamp(operation.warning) } : {})
  }
}

function sanitizeStep(step: BrowserOperationStep): BrowserOperationStep {
  return {
    ...step,
    method: clamp(step.method),
    label: clamp(step.label),
    ...(step.ref ? { ref: clamp(step.ref) } : {}),
    ...(step.target ? { target: sanitizeTarget(step.target) } : {}),
    ...(step.summary ? { summary: clamp(step.summary) } : {}),
    ...(step.replay ? { replay: sanitizeReplay(step.replay) } : {})
  }
}

function sanitizeTarget(target: BrowserReplayTarget): BrowserReplayTarget {
  return {
    role: clamp(target.role),
    name: clamp(target.name),
    ordinal: Number.isInteger(target.ordinal) && target.ordinal >= 1 ? target.ordinal : 1,
    count: Number.isInteger(target.count) && target.count >= 1 ? target.count : 1
  }
}

/** Opaque code and text input never enter the journal. A replay consumer must ask for them again. */
function sanitizeReplay(replay: BrowserReplayStep): BrowserReplayStep {
  const sensitive = replay.method === 'fillInput' || replay.method === 'typeText' || replay.method === 'js' || replay.method === 'cdp'
  const navigationWithQuery = replay.method === 'gotoUrl' && typeof replay.args[0] === 'string'
  const navigationArgs = navigationWithQuery ? [] : replay.args
  return {
    method: clamp(replay.method),
    url: stripUrl(replay.url),
    ...(replay.target ? { target: sanitizeTarget(replay.target) } : {}),
    args: sensitive || navigationWithQuery ? [] : navigationArgs.slice(0, MAX_REPLAY_ARGS).map(sanitizeScalar),
    ...(replay.inputKey ? { inputKey: clamp(replay.inputKey) } : {}),
    ...(sensitive || navigationWithQuery || replay.blockedReason
      ? { blockedReason: clamp(replay.blockedReason ?? (navigationWithQuery
        ? 'Navigation arguments require explicit review before replay.'
        : 'Requires a fresh value or explicit review before replay.')) }
      : {})
  }
}

function sanitizeScalar(value: unknown): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return clamp(value)
  // Keep replay records inspectable without accidentally writing page objects, cookies, or blobs.
  return typeof value === 'undefined' ? null : `[${typeof value}]`
}

function trimSteps(operation: BrowserOperation, maxSteps: number): void {
  if (operation.steps.length > maxSteps) operation.steps = operation.steps.slice(-maxSteps)
}

function trimOperations(document: BrowserOperationJournalDocument, maxOperations: number): void {
  if (document.operations.length <= maxOperations) return
  // Keep active operations even if they are old: dropping one would erase the fact that a restart
  // interrupted it. If there are too many active runs, keep the newest entries consistently.
  const active = document.operations.filter((operation) => ACTIVE_PHASES.has(operation.phase))
  const inactive = document.operations.filter((operation) => !ACTIVE_PHASES.has(operation.phase))
  const keepInactive = Math.max(0, maxOperations - Math.min(active.length, maxOperations))
  const keepIds = new Set([
    ...active.slice(-maxOperations).map((operation) => operation.id),
    ...inactive.slice(-keepInactive).map((operation) => operation.id)
  ])
  // Filter the original sequence so the resulting history remains chronological. Concatenating
  // active and inactive partitions would make a still-running old operation appear after newer
  // completed work, which makes a timeline jump backwards.
  document.operations = document.operations.filter((operation) => keepIds.has(operation.id)).slice(-maxOperations)
  const ids = new Set(document.operations.map((operation) => operation.id))
  document.events = document.events.filter((event) => ids.has(event.operationId))
}

function normalizeDocument(document: BrowserOperationJournalDocument): BrowserOperationJournalDocument {
  const normalized: BrowserOperationJournalDocument = {
    version: BROWSER_OPERATION_JOURNAL_VERSION,
    operations: document.operations.map(sanitizeOperation),
    events: document.events.map(sanitizeEvent)
  }
  trimOperations(normalized, MAX_BROWSER_OPERATIONS)
  if (normalized.events.length > MAX_BROWSER_OPERATION_EVENTS) {
    normalized.events = normalized.events.slice(-MAX_BROWSER_OPERATION_EVENTS)
  }
  return normalized
}

function sanitizeEvent(event: BrowserOperationEvent): BrowserOperationEvent {
  switch (event.type) {
    case 'operation-started':
    case 'operation-finished':
      return { ...event, operationId: clamp(event.operationId), operation: sanitizeOperation(event.operation) }
    case 'step-started':
    case 'step-finished':
      return { ...event, operationId: clamp(event.operationId), step: sanitizeStep(event.step) }
    case 'phase-changed':
      return { ...event, operationId: clamp(event.operationId), ...(event.warning ? { warning: clamp(event.warning) } : {}) }
    case 'operation-recovered':
      return { ...event, operationId: clamp(event.operationId), warning: clamp(event.warning) }
  }
}

function isJournalDocument(value: unknown): value is BrowserOperationJournalDocument {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<BrowserOperationJournalDocument>
  return candidate.version === BROWSER_OPERATION_JOURNAL_VERSION && Array.isArray(candidate.operations) && Array.isArray(candidate.events)
}
