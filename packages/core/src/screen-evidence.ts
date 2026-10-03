import {
  AgentProviderRegistry
} from './agent-provider.js'
import {
  AgentTerminalScreen,
  AgentTerminalScreenEvidence,
  type AgentTerminalScreenEvidenceEvent
} from './agent-terminal-screen.js'
import { CtxmuxRunAdapter } from './ctxmux-run-adapter.js'
import { AgentMuxError } from './errors.js'
import type { AgentMuxAgentSession } from './types.js'
import { terminalContinuationSteps } from './terminal-continuation.js'

// One-time frame metadata lookback, in bytes, independent of retained history.
// It reuses the existing 64 KiB initial observation budget; a missing complete
// pair stays unknown until a real later frame, never a guessed frame or a Run cap.
const FRAME_OBSERVATION_LOOKBACK_BYTES = 64 * 1024

type ScreenEvidenceDeps = {
  kernel: CtxmuxRunAdapter
  providers: AgentProviderRegistry
}

/**
 * 有界屏幕证据 owner（f-23q8faabh / T-002）：每个活跃 Session 只保留一份长命增量 xterm 屏幕
 * 和一条持久 Attachment。提交与 readiness 观察共享 Runtime 的保真 checkpoint 与有序续读，
 * 首次与失效重建都消费公开 terminal continuation，此后只在已消费游标之后增量续读；
 * 不为屏幕授权重放整段会话历史。ctxmux 仍是唯一字节权威：这里只有屏幕状态与帧游标，没有第二份
 * Run 字节史。失效（gap / Run 退出 / 观察错误 / resize / Run 更换）是粘性的，下一次观察
 * 丢弃重建。
 */
export class AgentScreenEvidenceStore {
  private readonly evidence = new Map<string, {
    runId: string
    frameFence?: { outputByte: number; resizeRevision: number }
    evidence: AgentTerminalScreenEvidence
    close: () => void
  }>()

  private readonly builds = new Map<string, Promise<AgentTerminalScreenEvidence>>()

  /**
   * 每个 Session 的屏幕授权世代（作废或已观测 resize）。单调递增，只比相等：`build()` 在握手前记下世代，登记前再比一次。
   *
   * 为什么不能只靠 `evidence` / `builds` 两张表：作废（`discard` / `discardAll`）只能撤回**已登记**
   * 的证据，而一次 `build()` 从 `observeOutput` 发出到拿到 Attachment 之间是异步的。掉线正好落在
   * 这段窗口里时，作废看到的两张表里还没有这个 entry，随后握手返回、`build()` 把一具挂在**已死连线**
   * 上的证据登记进去——`failed` 是 false（掉线只会走 adapter 那个全局 errorListener，不会经由本次
   * 观察的 listener 置位它），于是 `ensure()` 的复用闸认为它可用，此后每一次观察都复用这具尸体、
   * 永远等不到字节。而「半死 daemon」恰恰就是让握手悬在途中的那种故障，所以这不是理论缝隙。
   *
   * 不随 `discard` 删除表项：删掉等于把世代重置回 0，会让一次**合法**的在途 build 误判成已作废。
   * 计数器按 Session 各一个整数，生命周期与会话相同。
   */
  private readonly generations = new Map<string, number>()

  constructor(private readonly deps: ScreenEvidenceDeps) {}

  async wait(
    session: AgentMuxAgentSession,
    outputBoundaryByte: number,
    requireOutputAfterBoundary: boolean,
    predicate: (screen: AgentTerminalScreen) => boolean,
    options: {
      timeoutMs?: number
      timeoutMessage: string
      terminalMessage: string
      signal?: AbortSignal
      requireFrameAfterBoundary?: boolean
      requireCompleteFrame?: boolean
      checkpointFrameFence?: { outputByte: number; resizeRevision: number }
    }
  ): Promise<number> {
    const observation = new AbortController()
    const abort = (): void => observation.abort(new AgentMuxError(
      'Terminal screen observation was cancelled.', 'AGENT_PROMPT_READINESS_CANCELLED'
    ))
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    const timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      observation.abort(new AgentMuxError(options.timeoutMessage, 'AGENT_PROMPT_RENDER_TIMEOUT'))
    }, options.timeoutMs)
    let cancel!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(observation.signal.reason)
      observation.signal.addEventListener('abort', cancel, { once: true })
      if (observation.signal.aborted) cancel()
    })
    const read = async (): Promise<number> => {
      observation.signal.throwIfAborted()
      const evidence = await this.ensure(
        session,
        Math.max(0, outputBoundaryByte - FRAME_OBSERVATION_LOOKBACK_BYTES),
        options.checkpointFrameFence
      )
      // A cancelled handshake may finish later; it must not install an orphan waiter.
      observation.signal.throwIfAborted()
      return await evidence.wait({
        boundaryByte: outputBoundaryByte,
        requireOutputAfterBoundary,
        predicate,
        ...(options.requireCompleteFrame ? { requireCompleteFrame: true } : {}),
        timeoutMessage: options.timeoutMessage,
        terminalMessage: options.terminalMessage,
        signal: observation.signal,
        ...(options.requireFrameAfterBoundary === undefined
          ? {}
          : { requireFrameAfterBoundary: options.requireFrameAfterBoundary })
      })
    }
    try {
      // One budget includes attachment creation and the actual screen observation.
      return await Promise.race([read(), cancelled])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      observation.signal.removeEventListener('abort', cancel)
    }
  }

  private async ensure(
    session: AgentMuxAgentSession,
    startByte: number,
    frameFence?: { outputByte: number; resizeRevision: number }
  ): Promise<AgentTerminalScreenEvidence> {
    for (;;) {
      const existing = this.evidence.get(session.agentSessionId)
      if (existing && existing.runId === session.run.runId && !existing.evidence.failed &&
        (!frameFence || existing.frameFence?.outputByte === frameFence.outputByte && existing.frameFence.resizeRevision === frameFence.resizeRevision)) {
        return existing.evidence
      }
      const building = this.builds.get(session.agentSessionId)
      if (!building) break
      await building.catch(() => {})
    }
    const build = this.build(session, startByte, frameFence)
    this.builds.set(session.agentSessionId, build)
    try {
      return await build
    } finally {
      if (this.builds.get(session.agentSessionId) === build) {
        this.builds.delete(session.agentSessionId)
      }
    }
  }

  private async build(
    session: AgentMuxAgentSession,
    startByte: number,
    frameFence?: { outputByte: number; resizeRevision: number }
  ): Promise<AgentTerminalScreenEvidence> {
    this.discard(session.agentSessionId)
    const generation = this.generations.get(session.agentSessionId) ?? 0
    const matcher = this.deps.providers.get(session.providerId).terminalPromptRender
    let evidence: AgentTerminalScreenEvidence | null = null
    const pending: AgentTerminalScreenEvidenceEvent[] = []
    const forward = (event: AgentTerminalScreenEvidenceEvent): void => {
      if (evidence) evidence.accept(event)
      else pending.push(event)
    }
    const observation = await this.deps.kernel.observeOutput(session.run.runId, startByte, (event) => {
      if (event.type === 'data') {
        forward(event)
      } else if (event.type === 'gap') {
        forward({ type: 'gap' })
      } else if (event.type === 'resized') {
        // External Runtime clients can resize this Run without Core's discard.
        // Fence an already-read authorization synchronously; ordered resize
        // still updates this one incremental screen and clears its old frame.
        if (evidence && !evidence.failed) this.generations.set(session.agentSessionId,
          (this.generations.get(session.agentSessionId) ?? 0) + 1)
        forward({ type: 'resized', cols: event.cols, rows: event.rows,
          throughByte: event.throughByte, resizeRevision: event.resizeRevision })
      } else if (event.type === 'error') {
        forward({ type: 'error', error: event.error })
      } else if (event.type === 'exit') {
        forward({ type: 'exit' })
      }
    }, 'terminal')
    // 握手期间被作废了（掉线 / Run 更换）：这条 Attachment 挂在已经死掉的连线上，登记它就是留一具
    // `failed === false` 的尸体给 `ensure()` 复用。关掉它并抛，让调用方走与「观察被取消」相同的出口。
    if ((this.generations.get(session.agentSessionId) ?? 0) !== generation) {
      await observation.close().catch(() => {})
      throw new AgentMuxError(
        'Terminal screen observation was cancelled.',
        'AGENT_PROMPT_READINESS_CANCELLED'
      )
    }
    const continuation = observation.terminal
    const size = continuation.type === 'basic-vt' ? continuation.checkpoint.size
      : observation.run.cols === null || observation.run.rows === null ? null
        : { cols: observation.run.cols, rows: observation.run.rows }
    if (size === null) {
      await observation.close().catch(() => {})
      throw new AgentMuxError(
        'Terminal screen evidence has no owner-confirmed size.',
        'TERMINAL_SIZE_UNKNOWN'
      )
    }
    const built = new AgentTerminalScreenEvidence(
      size.cols,
      size.rows,
      matcher ? { start: matcher.frameStart, end: matcher.frameEnd } : null,
      continuation.type === 'basic-vt' ? continuation.checkpoint.throughByte
        : observation.gap?.firstAvailableByte ?? startByte,
      startByte === 0 && observation.gap === null && observation.resizeRevision === 0,
      continuation.type === 'basic-vt' ? continuation.checkpoint.resizeRevision : observation.resizeRevision
    )
    try {
      if (continuation.type === 'basic-vt' && matcher && (continuation.checkpoint.resizeRevision === 0 ||
        frameFence?.resizeRevision === continuation.checkpoint.resizeRevision)) {
        // The seed owns cells/geometry, while real ordered bytes own frame
        // completion. Bound this one-time scan independently of history length.
        const fence = continuation.checkpoint.throughByte
        const frames = await this.deps.kernel.replay(session.run.runId, Math.max(0, fence - FRAME_OBSERVATION_LOOKBACK_BYTES), 'raw')
        if (frames.gap === null && frames.run.latestOutputBytes >= fence) {
          const chunks = frames.replay.filter(chunk => chunk.startByte < fence).map(chunk => ({
            startByte: chunk.startByte, endByte: Math.min(chunk.endByte, fence),
            dataBytes: chunk.dataBytes.subarray(0, Math.min(chunk.endByte, fence) - chunk.startByte)
          }))
          built.seedFrameEvidence(chunks, fence)
        }
      }
      if ((this.generations.get(session.agentSessionId) ?? 0) !== generation) {
        throw new AgentMuxError('Terminal screen observation was cancelled.', 'AGENT_PROMPT_READINESS_CANCELLED')
      }
      for (const step of terminalContinuationSteps(observation)) {
        if (step.type === 'resized') built.accept({ ...step, cols: step.size.cols, rows: step.size.rows })
        else built.accept(step)
      }
    } catch (error) {
      built.dispose()
      await observation.close().catch(() => {})
      throw error
    }
    evidence = built
    for (const event of pending.splice(0)) built.accept(event)
    // 失效时立刻关掉 Attachment，别让一条死观察挂着资源等下一次 ensure 才回收。
    const unsubscribe = built.subscribe(() => {
      if (!built.failed) return
      unsubscribe()
      void observation.close().catch(() => {})
    })
    this.evidence.set(session.agentSessionId, {
      runId: session.run.runId,
      ...(frameFence ? { frameFence: { ...frameFence } } : {}),
      evidence: built,
      close: () => {
        unsubscribe()
        void observation.close().catch(() => {})
      }
    })
    return built
  }

  /**
   * 当前 session 的屏幕授权世代。每次 `discard(sessionId)` 或在线 resize +1（也包括 `build()` 首行的
   * 隐式 discard）。**这是 admission 用来判「本轮读屏期间是否发生过 discard / resize」的唯一稳定标识**：
   *
   *   const g = store.generation(sid)
   *   await store.wait(...)                     // predicate 或 timeout
   *   if (store.generation(sid) !== g) → **本次观察作废**（当 degraded 处理，别当 ready/busy）
   *
   * 这条 accessor 存在的唯一理由是解「顺序吞噬」（docs/reviews/prompt-admission-cutover-plan.md
   * §顺序吞噬 candidate d）：admission 先跑，若因 upstream discard 拿到 CANCELLED 就消化掉、
   * 后跑的 confirmRenderOrDegrade 就再也拿不到该信号，只能等 10s 完整 TERMINAL_PROMPT_RENDER_TIMEOUT
   * 完整超时。用 generation 让**两个消费者都能独立观测到 discard 发生过**、各自走自己的降级路径。
   *
   * Read-only：调用者不得写它。故意不返 `readonly`——number 是值类型，没有可变面。
   */
  generation(agentSessionId: string): number {
    return this.generations.get(agentSessionId) ?? 0
  }

  /** Observe the existing owner only; this accessor never builds, waits or writes bytes. */
  currentCompleteFrame(session: AgentMuxAgentSession): {
    snapshot: import('./types.js').AgentTerminalScreenSnapshot
    outputThroughByte: number
    geometryRevision: number
    evidenceGeneration: number
  } | null {
    const entry = this.evidence.get(session.agentSessionId)
    if (!entry || entry.runId !== session.run.runId) return null
    const current = entry.evidence.completeSnapshot
    return current ? { ...current, evidenceGeneration: this.generation(session.agentSessionId) } : null
  }

  discard(agentSessionId: string): void {
    // 世代**无条件**递增，且排在早退之前：在途的 build 此刻还没有 entry，只有让它的世代过期才拦得住
    // 它事后登记（见 `generations` 的说明）。写成「有 entry 才递增」会让那条路径原封不动地留着。
    this.generations.set(agentSessionId, (this.generations.get(agentSessionId) ?? 0) + 1)
    const entry = this.evidence.get(agentSessionId)
    if (!entry) return
    this.evidence.delete(agentSessionId)
    entry.close()
    entry.evidence.dispose()
  }

  discardAll(): void {
    // 两张表都要遍历：`evidence` 是已登记的（要关 Attachment、要 dispose），`builds` 是握手在途的
    // ——它一个 entry 都还没有，作废它的唯一手段就是让世代过期。只扫前者会漏掉整条在途路径。
    for (const agentSessionId of new Set([
      ...this.evidence.keys(),
      ...this.builds.keys()
    ])) {
      this.discard(agentSessionId)
    }
    this.builds.clear()
  }
}
