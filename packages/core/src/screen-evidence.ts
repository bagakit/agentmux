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

type ScreenEvidenceDeps = {
  kernel: CtxmuxRunAdapter
  providers: AgentProviderRegistry
}

/**
 * 有界屏幕证据 owner（f-23q8faabh / T-002）：每个活跃 Session 只保留一份长命增量 xterm 屏幕
 * 和一条持久 Attachment。提交与 readiness 观察共享它——只有首次（或失效重建时）从 byte 0
 * 重放一次以恢复完整屏幕，此后所有观察都在已消费游标之后增量续读，验证路径的重放字节量
 * 相对会话历史长度有界。ctxmux 仍是唯一字节权威：这里只有屏幕状态与帧游标，没有第二份
 * Run 字节史。失效（gap / Run 退出 / 观察错误 / resize / Run 更换）是粘性的，下一次观察
 * 丢弃重建。
 */
export class AgentScreenEvidenceStore {
  private readonly evidence = new Map<string, {
    runId: string
    evidence: AgentTerminalScreenEvidence
    close: () => void
  }>()

  private readonly builds = new Map<string, Promise<AgentTerminalScreenEvidence>>()

  /**
   * 每个 Session 的作废世代。单调递增，只比相等：`build()` 在握手前记下世代，登记前再比一次。
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
    }
  ): Promise<number> {
    if (options.signal?.aborted) {
      throw new AgentMuxError(
        'Terminal screen observation was cancelled.',
        'AGENT_PROMPT_READINESS_CANCELLED'
      )
    }
    const evidence = await this.ensure(
      session,
      requireOutputAfterBoundary ? 0 : Math.max(0, outputBoundaryByte - 64 * 1024)
    )
    return await evidence.wait({
      boundaryByte: outputBoundaryByte,
      requireOutputAfterBoundary,
      predicate,
      timeoutMessage: options.timeoutMessage,
      terminalMessage: options.terminalMessage,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.requireFrameAfterBoundary === undefined
        ? {}
        : { requireFrameAfterBoundary: options.requireFrameAfterBoundary })
    })
  }

  private async ensure(
    session: AgentMuxAgentSession,
    startByte: number
  ): Promise<AgentTerminalScreenEvidence> {
    for (;;) {
      const existing = this.evidence.get(session.agentSessionId)
      if (existing && existing.runId === session.run.runId && !existing.evidence.failed) {
        return existing.evidence
      }
      const building = this.builds.get(session.agentSessionId)
      if (!building) break
      await building.catch(() => {})
    }
    const build = this.build(session, startByte)
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
    startByte: number
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
      } else if (event.type === 'error') {
        forward({ type: 'error', error: event.error })
      } else if (event.type === 'exit') {
        forward({ type: 'exit' })
      }
    })
    // 握手期间被作废了（掉线 / Run 更换）：这条 Attachment 挂在已经死掉的连线上，登记它就是留一具
    // `failed === false` 的尸体给 `ensure()` 复用。关掉它并抛，让调用方走与「观察被取消」相同的出口。
    if ((this.generations.get(session.agentSessionId) ?? 0) !== generation) {
      await observation.close().catch(() => {})
      throw new AgentMuxError(
        'Terminal screen observation was cancelled.',
        'AGENT_PROMPT_READINESS_CANCELLED'
      )
    }
    if (observation.gap) {
      await observation.close().catch(() => {})
      throw new AgentMuxError(
        'Terminal screen evidence was evicted from CtxMux replay.',
        'OUTPUT_GAP'
      )
    }
    const built = new AgentTerminalScreenEvidence(
      observation.run.cols,
      observation.run.rows,
      matcher ? { start: matcher.frameStart, end: matcher.frameEnd } : null,
      startByte
    )
    for (const event of observation.replay) built.accept(event)
    pending.sort((left, right) => (
      (left.type === 'data' ? left.startByte : Number.MAX_SAFE_INTEGER) -
      (right.type === 'data' ? right.startByte : Number.MAX_SAFE_INTEGER)
    ))
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
      evidence: built,
      close: () => {
        unsubscribe()
        void observation.close().catch(() => {})
      }
    })
    return built
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
