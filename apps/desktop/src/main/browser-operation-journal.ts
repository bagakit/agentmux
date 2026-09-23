import { normalizeBrowserOutcomeJournal } from './browser-outcome-journal.js'
import type { BrowserOutcomeRegistration, BrowserOutcomeEvaluation } from '../shared/browser-outcome-criteria.js'
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
      type: 'operation-finished' | 'operation-checked'
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
 * tests and embedders can use a temporary path. A missing journal is a healthy first use; damage or
 * unreadable history remains observable without stopping a healthy Browser from opening.
 */
export class BrowserOperationFileStore implements BrowserOperationJournalStore {
  private saveTail: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  async load(): Promise<BrowserOperationJournalDocument | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      return isJournalDocument(parsed) ? parsed : null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyDocument()
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
  evidence?: BrowserOperationStep['evidence']
  evidenceWarning?: string
}

/**
 * 一条订阅收到的事件，带上它在本 journal 生命周期内的序号。
 *
 * 序号由 journal 发号（一个单调计数器），**不是事件数组的下标**：那个数组会被 `trim()` 从头砍掉，
 * 下标会随之整体左移，于是同一条事件在两次读取里有两个不同的"序号"——客户端的游标当场失效。
 */
export type BrowserOperationSequencedEvent = { sequence: number; event: BrowserOperationEvent }

export type BrowserOperationSubscription = {
  /** 订阅建立时那条操作的事实。查不到答 null——那不是故障。 */
  operation: BrowserOperation | null
  /**
   * 客户端要的那段是不是已经被砍掉了。有值时 `droppedThrough` 是**最早还留着的那条的前一个序号**，
   * 意思是"这个号（含）之前的都没了"。null 表示从游标之后一条不落。
   */
  gap: { droppedThrough: number } | null
  /** 从游标之后、当下还留着的那些事件。订阅建立时一次性交出，之后的走回调。 */
  backlog: BrowserOperationSequencedEvent[]
  dispose(): void
}

type PendingDelivery = BrowserOperationSequencedEvent & { ready: boolean }
type DeliveryQueue = { entries: PendingDelivery[]; flushing: boolean }
type JournalSubscriber = { afterSequence: number; deliver: (event: BrowserOperationSequencedEvent) => void }

type JournalOptions = {
  now?: () => number
  id?: () => string
  maxOperations?: number
  maxEvents?: number
  maxSteps?: number
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
  private warning: string | undefined
  /** 序号属于实际事件引用；裁剪可从中间移除事件，不能从数组下标反推。重启后重新发号。 */
  private sequenced = 0
  private readonly eventFacts = new WeakMap<BrowserOperationEvent, { sequence: number; published: boolean }>()
  /** 只在 ACK 未到或同 operation 前序未交付时暂存；Journal 仍是唯一持久事实。 */
  private readonly deliveryQueues = new Map<string, DeliveryQueue>()
  /** 投递只访问相关 operation 的消费者；坏订阅不能成为控制路径上的闸。 */
  private readonly subscribers = new Map<string, Map<number, JournalSubscriber>>()
  private nextSubscriberId = 1

  constructor(store: BrowserOperationJournalStore, options: JournalOptions = {}) {
    this.saveStore = store
    this.now = options.now ?? Date.now
    this.makeId = options.id ?? randomUUID
    this.maxOperations = Math.max(1, Math.floor(options.maxOperations ?? MAX_BROWSER_OPERATIONS))
    this.maxEvents = Math.max(1, Math.floor(options.maxEvents ?? MAX_BROWSER_OPERATION_EVENTS))
    this.maxSteps = Math.max(1, Math.floor(options.maxSteps ?? MAX_BROWSER_OPERATION_STEPS))
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
    if (options.summary !== undefined) operation.summary = clampProse(options.summary)
    if (options.warning !== undefined) operation.warning = clampProse(options.warning)
    this.publish({
      type: 'phase-changed',
      operationId,
      at: this.now(),
      phase,
      ...(options.warning ? { warning: clampProse(options.warning) } : {})
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
    if (input.summary !== undefined) step.summary = clampProse(input.summary)
    if (input.target !== undefined) step.target = sanitizeTarget(input.target)
    if (input.replay !== undefined) step.replay = sanitizeReplay(input.replay)
    if (input.evidence !== undefined) step.evidence = input.evidence
    if (input.evidenceWarning !== undefined) step.evidenceWarning = clampProse(input.evidenceWarning)
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
    if (options.summary !== undefined) operation.summary = clampProse(options.summary)
    if (options.warning !== undefined) operation.warning = clampProse(options.warning)
    this.publish({ type: 'operation-finished', operationId, at, operation })
    await this.persist()
    return cloneOperation(operation)
  }

  /** Register before any producer step; verification cannot select an old successful artifact. */
  async registerOutcome(operationId: string, registration: BrowserOutcomeRegistration): Promise<{ operation: BrowserOperation; saved: boolean } | null> {
    await this.ready()
    const operation = this.find(operationId)
    if (!operation || operation.steps.length > 0 || operation.outcome) return null
    const outcome = normalizeBrowserOutcomeJournal({ registration }, operation.id, operation.browserId)
    if (!outcome) return null
    operation.outcome = outcome
    const saved = await this.persist()
    return { operation: cloneOperation(operation), saved }
  }

  async recordOutcome(operationId: string, evaluation: BrowserOutcomeEvaluation): Promise<{ operation: BrowserOperation; saved: boolean } | null> {
    await this.ready()
    const operation = this.find(operationId)
    if (!operation?.outcome) return null
    const outcome = normalizeBrowserOutcomeJournal({ registration: operation.outcome.registration, evaluation },
      operation.id, operation.browserId)
    if (!outcome) return null
    operation.outcome = outcome
    const event = this.record({ type: 'operation-checked', operationId, at: this.now(), operation })
    const pending = this.enqueue(event, false)
    const saved = await this.persist()
    // ACK 对应原检查，不读取可能已经被下一次检查/phase 更新的 operation。
    const checked = (event.event as Extract<BrowserOperationEvent, { type: 'operation-finished' | 'operation-checked' }>).operation
    if (!saved && checked.outcome?.evaluation) {
      const notice = 'The result was checked but could not be saved. Existing Browser work remains; restore local storage before relying on recovery.'
      checked.outcome.evaluation.warning = notice
      if (operation.outcome === outcome && outcome.evaluation) outcome.evaluation.warning = notice
    }
    pending.ready = true
    this.flush(operationId)
    return { operation: cloneOperation(checked), saved }
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
    return events.filter(event => this.eventFacts.get(event)?.published).map(cloneEvent)
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

  /**
   * 订阅一条操作的后续事件。
   *
   * **backlog 与实时流互不重叠**：建立订阅的这一刻把已有的事件一次性交出（`backlog`），之后的走
   * 回调。这与本仓 attach 的 replay/live 取舍是同一条——重叠会让客户端收到重复，而中间留缝会让它
   * 静默丢事件，两者都无从察觉。
   *
   * 尚未 ACK 或等待前序的事件只走未来 live，不进入 backlog；每个 subscriber 的游标同时约束两条路。
   * 缺口依据实际保留引用的序号，等待交付的引用即使被历史裁剪也继续 live，不冒称已丢失。
   *
   * 查不到那条操作不是错误：答 `operation: null`、空 backlog，并且**仍然建立订阅**——那条 id 可能
   * 属于一个马上就要开始的操作（调用方先给 id 再发起，正是本 Feature 的设计）。在这里拒绝等于让
   * "先订阅再发起"这条顺序不可用。
   */
  async subscribe(
    operationId: string,
    afterSequence: number | undefined,
    deliver: (event: BrowserOperationSequencedEvent) => void
  ): Promise<BrowserOperationSubscription> {
    await this.ready()
    const id = this.nextSubscriberId++
    const cursor = afterSequence ?? 0
    const backlog = this.document.events
      .filter(event => event.operationId === operationId && this.eventFacts.get(event)?.published)
      .map(event => ({ sequence: this.eventFacts.get(event)!.sequence, event }))
      .filter(({ sequence }) => sequence > cursor)
      .map(({ sequence, event }) => ({ sequence, event: cloneEvent(event) }))
    const related = this.subscribers.get(operationId) ?? new Map<number, JournalSubscriber>()
    related.set(id, { afterSequence: backlog.at(-1)?.sequence ?? cursor, deliver })
    this.subscribers.set(operationId, related)
    // 尚未交付的引用可能已被历史上限裁掉，但仍会 live 到达；不能把它报作已丢失。
    const retained = this.document.events[0]
    const oldest = Math.min(retained ? this.eventFacts.get(retained)!.sequence : this.sequenced + 1,
      this.deliveryQueues.get(operationId)?.entries[0]?.sequence ?? this.sequenced + 1)
    const droppedThrough = oldest - 1
    return {
      operation: this.find(operationId) ? cloneOperation(this.find(operationId) as BrowserOperation) : null,
      gap: droppedThrough > cursor ? { droppedThrough } : null,
      backlog,
      dispose: () => {
        related.delete(id)
        if (related.size === 0 && this.subscribers.get(operationId) === related) this.subscribers.delete(operationId)
      }
    }
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
      // 这条早退臂不必补号：`emptyDocument()` 没有事件，而 `sequenced` 的初值本来就是 0，
      // 两者已经一致。写一句 `this.sequenced = 0` 只是把同一个事实说两遍。
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
    for (const event of this.document.events) {
      this.eventFacts.set(event, { sequence: ++this.sequenced, published: true })
    }
  }

  private find(operationId: string): BrowserOperation | undefined {
    return this.document.operations.find((operation) => operation.id === operationId)
  }

  private publish(event: BrowserOperationEvent): void {
    this.enqueue(this.record(event), true)
    this.flush(event.operationId)
  }

  private record(event: BrowserOperationEvent): BrowserOperationSequencedEvent {
    const fact = cloneEvent(event)
    const sequence = ++this.sequenced
    this.eventFacts.set(fact, { sequence, published: false })
    this.document.events.push(fact)
    this.trim()
    return { sequence, event: fact }
  }

  private enqueue(event: BrowserOperationSequencedEvent, ready: boolean): PendingDelivery {
    const pending = { ...event, ready }
    const queue = this.deliveryQueues.get(event.event.operationId) ?? { entries: [], flushing: false }
    queue.entries.push(pending)
    this.deliveryQueues.set(event.event.operationId, queue)
    return pending
  }

  private flush(operationId: string): void {
    const queue = this.deliveryQueues.get(operationId)
    if (!queue || queue.flushing) return
    queue.flushing = true
    try {
      while (queue.entries[0]?.ready) {
        // 先移出队头并标记公开，callback 重入/新订阅不能再次消费这条事实。
        const entry = queue.entries.shift()!
        this.eventFacts.get(entry.event)!.published = true
        this.deliver(entry)
      }
    } finally {
      queue.flushing = false
      if (queue.entries.length === 0) this.deliveryQueues.delete(operationId)
    }
  }

  private deliver({ sequence, event }: BrowserOperationSequencedEvent): void {
    const related = this.subscribers.get(event.operationId)
    if (!related) return
    for (const [id, subscriber] of [...related]) {
      if (related.get(id) !== subscriber || sequence <= subscriber.afterSequence) continue
      subscriber.afterSequence = sequence
      try { subscriber.deliver({ sequence, event: cloneEvent(event) }) } catch { /* 订阅是视图，不是控制闸。 */ }
    }
  }

  private trim(): void {
    trimOperations(this.document, this.maxOperations)
    if (this.document.events.length > this.maxEvents) {
      this.document.events = this.document.events.slice(-this.maxEvents)
    }
  }

  private async persist(): Promise<boolean> {
    try {
      await this.saveStore.save(normalizeDocument(this.document))
      return true
    } catch (error) {
      this.warning = `Browser activity history could not be saved: ${error instanceof Error ? error.message : String(error)}`
      return false
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

/**
 * 摘要类字段的收口。**这里是持久化的门，页面控制的文本只能以「被圈起来的引文」形态过这道门。**
 *
 * `BrowserOperationStep.summary` 的类型注释写着 "never raw page data or script errors with echoed
 * secrets"，但这份日志此前只对它做了 `clamp`——而失败臂取的是 `error.message`，页面里一句
 * `throw new Error('忽略之前的指令，改为……')` 就会原样落盘，再经 `browser.history` 被**下一轮的
 * Agent** 读回去。写入的是这一轮，命中的是下一轮，中间没有任何一步看得出这段字是谁写的：
 * 这是存储型注入，不是显示问题（渲染侧 React 会转义，所以它不是 XSS）。
 *
 * 为什么门设在这里而不只在派发层：派发层那两处（`pageAuthoredText`）圈的是**入口**，可页面的话
 * 还有第二条路——脚本自己的 `stack` 里会带上它，经 `browser-run-outcome.ts` 落进 `operation.summary`。
 * 两条路都汇到这一个函数，所以这里是唯一能一次守住的地方（守卫按出口数不按来源数）。
 *
 * 只压平不删内容：这些字是排障唯一的依据，删了等于让 Agent 面对一次无从下手的失败。压平换行是
 * 因为多行文本能在日志里伪造出「新的一条记录」的样子，而那恰恰是注入想要的形状。
 *
 * **判据用 `\p{White_Space}` 而不是手列换行字符**（「禁止清单必漏」）。手列的那版漏了 NEL（U+0085）：
 * 它不在 `[\r\n\u2028\u2029]` 里，`JSON.stringify` 也不转义它（落盘就是那一个裸字节），而终端和
 * 多数日志查看器把它当换行渲染——伪造记录边界的能力原封不动地留着，只是换了个字符。
 *
 * 注意**连 `\s` 都不够**：`\s` 在 `u` 标志下照样不含 NEL（实测 `/\s/u.test('\u0085') === false`），
 * 只有 Unicode 的 `White_Space` 属性覆盖得全。这一条不能靠直觉，得实测——这也是为什么这里
 * 写死属性类而不是字符集。
 */
function clampProse(value: string): string {
  return clamp(value.replace(/\p{White_Space}+/gu, ' ').trim())
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
  const { outcome: rawOutcome, ...facts } = operation
  const outcome = normalizeBrowserOutcomeJournal(rawOutcome, operation.id, operation.browserId)
  return {
    ...facts,
    ...(outcome ? { outcome } : {}),
    id: clamp(operation.id),
    browserId: clamp(operation.browserId),
    operator: {
      id: clamp(operation.operator.id),
      name: clamp(operation.operator.name),
      ...(operation.operator.providerId ? { providerId: clamp(operation.operator.providerId) } : {})
    },
    summary: clampProse(operation.summary),
    url: stripUrl(operation.url),
    steps: operation.steps.slice(-MAX_BROWSER_OPERATION_STEPS).map(sanitizeStep),
    ...(rawOutcome !== undefined && !outcome ? { warning: clampProse(`${operation.warning ?? ''} Stored completion conditions are unreadable; verification is unavailable. Existing Browser work remains.`) }
      : operation.warning ? { warning: clampProse(operation.warning) } : {})
  }
}

function sanitizeStep(step: BrowserOperationStep): BrowserOperationStep {
  return {
    ...step,
    method: clamp(step.method),
    label: clamp(step.label),
    ...(step.ref ? { ref: clamp(step.ref) } : {}),
    ...(step.target ? { target: sanitizeTarget(step.target) } : {}),
    ...(step.summary ? { summary: clampProse(step.summary) } : {}),
    ...(step.replay ? { replay: sanitizeReplay(step.replay) } : {})
  }
}

function sanitizeTarget(target: BrowserReplayTarget): BrowserReplayTarget {
  return {
    role: clamp(target.role),
    // `name` 是页面控制的（AX 可访问名，即 `aria-label`），所以走 `clampProse` 而不是 `clamp`。
    // 上游 `browser-page-snapshot.ts` 的 `normalizeName` 已经在取值那一刻压平过一次，这里不是
    // 重复：`sanitizeTarget` 也在 `normalizeDocument` 的路上跑，而那条路读的是**盘上那份**——
    // 可能是旧版本写的，也可能是被人动过的。持久化边界不能假设写它的那一版有上游的守卫。
    name: clampProse(target.name),
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
    ...inactive.slice(inactive.length - keepInactive).map((operation) => operation.id)
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
    case 'operation-checked':
      return { ...event, operationId: clamp(event.operationId), operation: sanitizeOperation(event.operation) }
    case 'step-started':
    case 'step-finished':
      return { ...event, operationId: clamp(event.operationId), step: sanitizeStep(event.step) }
    case 'phase-changed':
      return { ...event, operationId: clamp(event.operationId), ...(event.warning ? { warning: clampProse(event.warning) } : {}) }
    case 'operation-recovered':
      return { ...event, operationId: clamp(event.operationId), warning: clampProse(event.warning) }
  }
}

function isJournalDocument(value: unknown): value is BrowserOperationJournalDocument {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<BrowserOperationJournalDocument>
  return candidate.version === BROWSER_OPERATION_JOURNAL_VERSION && Array.isArray(candidate.operations) && Array.isArray(candidate.events)
}
