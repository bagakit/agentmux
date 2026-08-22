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
  /**
   * 事件发号器。每 publish 一条 +1，**本进程生命周期内**单调。
   *
   * 不把号写进事件对象：那是落盘格式（版本号钉住的），而号是进程内的概念——重启后事件从盘上读回来，
   * 谈"接着上次的游标"没有意义（旧号属于上一个进程）。也不另存一份「号 → 事件」的边表：
   * `trimOperations` 会按 operationId **从中间**滤掉事件（不只从头砍），边表与事件数组会当场错位，
   * 而错位之后两边各自看起来都正常（本仓的「两个数据源一条生命周期＝鬼影」）。
   */
  private sequenced = 0
  /** 活着的订阅。事件流不许成为控制路径上的闸，所以往它们投递时抛出的异常一律吞掉。 */
  private readonly subscribers = new Map<number, { operationId: string; deliver: (event: BrowserOperationSequencedEvent) => void }>()
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

  /**
   * 订阅一条操作的后续事件。
   *
   * **backlog 与实时流互不重叠**：建立订阅的这一刻把已有的事件一次性交出（`backlog`），之后的走
   * 回调。这与本仓 attach 的 replay/live 取舍是同一条——重叠会让客户端收到重复，而中间留缝会让它
   * 静默丢事件，两者都无从察觉。
   *
   * 缺口的判法是**数出来的，不是猜的**：`sequenced` 记着一共发过多少号，当下还留着多少条事件是
   * 数组长度。一条在跑的操作若它最早那条事件已经被砍掉，那么"还留着的最早那条的号"必然大于
   * `afterSequence + 1`，差额就是缺口。
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
    this.subscribers.set(id, { operationId, deliver })
    // 这条操作已经有过的事件，按它们当时拿到的号算：`document.events` 里属于它的那些，是本进程内
    // 最后 N 条里的一部分。号从「总共发过 sequenced 个，现存 events.length 条」反推——现存的第 i 条
    // （从 0 数）拿到的号是 `sequenced - events.length + i + 1`。
    const total = this.document.events.length
    const base = this.sequenced - total
    const mine = this.document.events
      .map((event, index) => ({ sequence: base + index + 1, event }))
      .filter(({ event }) => event.operationId === operationId)
    const cursor = afterSequence ?? 0
    const backlog = mine.filter(({ sequence }) => sequence > cursor).map(({ sequence, event }) => ({ sequence, event: cloneEvent(event) }))
    // 缺口：客户端要 cursor 之后的每一条，而我们手上最早的号是 base+1。base 比 cursor 还大，说明
    // 中间那段（cursor+1 .. base）已经被砍掉了。cursor 为 0（"从头要"）时同样成立——那正是砍过之后
    // 一个新客户端会遇到的情形。
    const gap = base > cursor ? { droppedThrough: base } : null
    return {
      operation: this.find(operationId) ? cloneOperation(this.find(operationId) as BrowserOperation) : null,
      gap,
      backlog,
      dispose: () => { this.subscribers.delete(id) }
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
    // 给从盘上读回来的那些事件补号。**这一步不能漏**：它们没走 `publish()`，所以一个号都没发过，
    // 而 `subscribe()` 是按「总共发过 sequenced 个、现存 length 条」反推每条的号的——不补的话
    // `sequenced` 是 0 而 length 是 N，反推出来的起始号是 -N+1，客户端收到一串负号，
    // 而缺口判据（`base > cursor`）在负数上恒不成立，于是"缺了一段"这件事永远不会被说出来。
    //
    // 从 length 起算而不是试图续上上一个进程的号：号是进程内的概念。上一个进程砍掉过多少条，
    // 这一个进程没有依据知道，所以不假装知道——它只说"我手上这 N 条是 1..N"。
    this.sequenced = this.document.events.length
  }

  private find(operationId: string): BrowserOperation | undefined {
    return this.document.operations.find((operation) => operation.id === operationId)
  }

  private publish(event: BrowserOperationEvent): void {
    this.document.events.push(cloneEvent(event))
    // 号从**单调计数器**取，不从 `document.events` 的长度取：号是"这条事件发生了"的标记，不是
    // "它还留着"的标记。按存活数组算的话，一条刚发出就被 trim 砍掉的事件不占号，于是客户端按号
    // 算出的缺口会少一条——而它正好是缺了的那条。（这两句与 `++` 和 `trim()` 的先后无关：计数器
    // 不看数组，两种顺序行为相同。承重的是取号的来源。）
    const sequence = ++this.sequenced
    this.trim()
    for (const subscriber of [...this.subscribers.values()]) {
      if (subscriber.operationId !== event.operationId) continue
      // 每个订阅一份自己的拷贝，且各自 try：一个订阅者抛出来不许挡住别的订阅者，也不许挡住控制
      // 路径——进度是 Browser 的一个视图，不是它的闸。
      try { subscriber.deliver({ sequence, event: cloneEvent(event) }) } catch { /* 同上 */ }
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
  return {
    ...operation,
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
    ...(operation.warning ? { warning: clampProse(operation.warning) } : {})
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
