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
    const evidence = await this.ensure(session)
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
    session: AgentMuxAgentSession
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
    const build = this.build(session)
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
    session: AgentMuxAgentSession
  ): Promise<AgentTerminalScreenEvidence> {
    this.discard(session.agentSessionId)
    const matcher = this.deps.providers.get(session.providerId).terminalPromptRender
    let evidence: AgentTerminalScreenEvidence | null = null
    const pending: AgentTerminalScreenEvidenceEvent[] = []
    const forward = (event: AgentTerminalScreenEvidenceEvent): void => {
      if (evidence) evidence.accept(event)
      else pending.push(event)
    }
    const observation = await this.deps.kernel.observeOutput(session.run.runId, 0, (event) => {
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
      matcher ? { start: matcher.frameStart, end: matcher.frameEnd } : null
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
    const entry = this.evidence.get(agentSessionId)
    if (!entry) return
    this.evidence.delete(agentSessionId)
    entry.close()
    entry.evidence.dispose()
  }

  discardAll(): void {
    for (const agentSessionId of [...this.evidence.keys()]) {
      this.discard(agentSessionId)
    }
    this.builds.clear()
  }
}
