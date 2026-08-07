import { createHash } from 'node:crypto'
import { AgentProviderRegistry } from './agent-provider.js'
import { cloneSession, sameRun } from './agent-session-identity.js'
import { AgentMuxAgentSessionRegistry } from './agent-session-registry.js'
import { AgentMuxClientEventPublisher } from './client-event-publisher.js'
import {
  CtxmuxRunAdapter,
  type CtxmuxAdapterRun
} from './ctxmux-run-adapter.js'
import { AgentMuxError } from './errors.js'
import { AgentScreenEvidenceStore } from './screen-evidence.js'
import type {
  AgentMuxAgentSession,
  AgentMuxRunRef,
  AgentMuxStoredAgentSession,
  AgentPromptInputPlan,
  AgentTerminalPromptDeliveryState,
  AgentTerminalPromptReadinessState
} from './types.js'

const TERMINAL_PROMPT_RENDER_TIMEOUT_MS = 10_000

/**
 * 等空 composer 的上界。比 {@link TERMINAL_PROMPT_RENDER_TIMEOUT_MS} 宽得多，因为这条等待横跨的是
 * **Agent 冷启动**：进程刚起、TUI 还在画首帧、模型还没连上，都算在里面。渲染那条等待是「字已经送进去了，
 * 屏幕该回显了」，量级完全不同，所以两个预算不共用一个常量（记忆 two-budgets-guard-one-thing：短的那个
 * 只会贡献假阴性）。
 *
 * 为什么必须有上界：这条等待此前**根本没有定时器**——`AgentTerminalScreenEvidence.wait()` 只在
 * `options.timeoutMs !== undefined` 时才 arm 一个 timer，而这里没传。于是任何「屏幕永不再变」的情形
 * （断线丢流、TUI 卡在别的界面、provider 的 composer 匹配器认不出这一版布局）都让 readiness 永久停在
 * pending，此后每条 prompt 被 `AGENT_PROMPT_NOT_READY` 拒掉且**没有任何出路**（#628/#238）。超时把
 * 「永久静默」换成一条响亮的 agent-error，用户至少知道该重开会话。
 */
const TERMINAL_COMPOSER_READY_TIMEOUT_MS = 120_000

/**
 * Details attached to readiness refusals are deliberately a small, machine-readable set of
 * lifecycle facts.  Keep this formatter local to the Core owner: prompt text, digests and PTY
 * bytes must never be copied into an error that may cross a client boundary.
 */
function promptReadinessDetail(
  fields: Readonly<Record<string, string | number | boolean | undefined>>
): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ')
}

function terminalPromptPhaseOperationIdentity(
  session: AgentMuxAgentSession,
  submissionId: string,
  phase: 'payload' | 'submit',
  data: string
): string {
  return createHash('sha256')
    .update(JSON.stringify([
      'agentmux-terminal-prompt-v1',
      session.agentSessionId,
      session.run.runId,
      submissionId,
      phase,
      data
    ]))
    .digest('base64url')
}

type PromptSubmissionDeps = {
  kernel: CtxmuxRunAdapter
  providers: AgentProviderRegistry
  registry: AgentMuxAgentSessionRegistry
  publisher: AgentMuxClientEventPublisher
  agentInputCursors: Map<string, number>
  screenEvidence: AgentScreenEvidenceStore
  requireAgentSession: (agentSessionId: string) => AgentMuxStoredAgentSession
  assertAgentRun: (session: AgentMuxAgentSession, run: CtxmuxAdapterRun) => void
  updateExactAgentSession: (
    agentSessionId: string,
    expectedRun: AgentMuxRunRef,
    update: (current: AgentMuxStoredAgentSession) => AgentMuxStoredAgentSession
  ) => Promise<AgentMuxStoredAgentSession>
}

/**
 * Prompt 两阶段提交 owner（f-23q8faabh / T-004）：把 payload → 渲染验证 → submit 的状态机、
 * 服务窗降级（原则 11 第 2 类）与 composer readiness 观察从 client 里抽出来。client 退化为
 * facade：`submitAgentPrompt` 仍在 client 上做序列化与 timeline 记录，实际的 CtxMux 输入编排
 * 与降级都委托到这里。对外错误码与事件形状不变。屏幕证据仍由 {@link AgentScreenEvidenceStore}
 * 拥有，本模块只消费它。
 */
export class AgentPromptSubmissionCoordinator {
  private readonly readinessCancels = new Map<string, () => void>()

  constructor(private readonly deps: PromptSubmissionDeps) {}

  cancelAllReadiness(): void {
    for (const cancel of this.readinessCancels.values()) cancel()
    this.readinessCancels.clear()
  }

  async submitInputPlan(
    session: AgentMuxAgentSession,
    run: CtxmuxAdapterRun,
    submissionId: string,
    prompt: string,
    plan: AgentPromptInputPlan
  ): Promise<void> {
    if (plan.kind === 'single-phase') {
      const expectedByte = this.deps.agentInputCursors.get(session.agentSessionId) ?? run.acceptedInputBytes
      if (expectedByte === null) {
        throw new AgentMuxError('CtxMux omitted its accepted Input byte cursor.', 'CTXMUX_INPUT_CURSOR_MISSING')
      }
      const accepted = await this.deps.kernel.input(session.run.runId, {
        ownerInstanceId: this.deps.kernel.identity().daemonInstanceId,
        operationId: terminalPromptPhaseOperationIdentity(
          session,
          submissionId,
          'payload',
          plan.data
        ),
        expectedByte,
        data: plan.data
      })
      if (accepted.run.acceptedInputBytes === null) {
        throw new AgentMuxError('CtxMux omitted its accepted Input byte cursor.', 'CTXMUX_INPUT_CURSOR_MISSING')
      }
      this.deps.agentInputCursors.set(session.agentSessionId, accepted.run.acceptedInputBytes)
      return
    }
    if (!plan.payload || !plan.renderedText || !plan.submit) {
      throw new AgentMuxError(
        'Provider terminal prompt phases cannot be empty.',
        'INVALID_AGENT_PROVIDER'
      )
    }

    const promptDigest = createHash('sha256').update(prompt).digest('base64url')
    const payloadOperationId = terminalPromptPhaseOperationIdentity(
      session,
      submissionId,
      'payload',
      plan.payload
    )
    const submitOperationId = terminalPromptPhaseOperationIdentity(
      session,
      submissionId,
      'submit',
      plan.submit
    )
    const payloadBytes = Buffer.byteLength(plan.payload)
    const submitBytes = Buffer.byteLength(plan.submit)
    type Submission = NonNullable<AgentMuxAgentSession['terminalPromptSubmission']>
    const assertSubmission = (value: Submission): void => {
      if (
        value.run.runId !== session.run.runId ||
        value.submissionId !== submissionId ||
        value.promptDigest !== promptDigest ||
        value.readyThroughByte < value.readinessOutputCursorBytes ||
        value.outputCursorBytes < value.readyThroughByte ||
        value.payload.operationId !== payloadOperationId ||
        value.submit.operationId !== submitOperationId ||
        value.payload.inputByteRange.endByte - value.payload.inputByteRange.startByte !== payloadBytes ||
        value.submit.inputByteRange.endByte - value.submit.inputByteRange.startByte !== submitBytes ||
        value.payload.inputByteRange.endByte !== value.submit.inputByteRange.startByte
      ) {
        throw new AgentMuxError(
          'Agent prompt operation was reused with conflicting Session or content.',
          'AGENT_PROMPT_OPERATION_CONFLICT'
        )
      }
    }
    const expectedByte = this.deps.agentInputCursors.get(session.agentSessionId) ?? run.acceptedInputBytes
    if (expectedByte === null) {
      throw new AgentMuxError('CtxMux omitted its accepted Input byte cursor.', 'CTXMUX_INPUT_CURSOR_MISSING')
    }
    const claimPromptReadiness = (
      stored: AgentMuxStoredAgentSession
    ): AgentMuxStoredAgentSession => {
      const existing = stored.terminalPromptSubmission
      if (existing?.submissionId === submissionId) {
        assertSubmission(existing)
        return stored
      }
      if (existing && !existing.submit.acknowledged) {
        throw new AgentMuxError(
          'Another Agent prompt operation is incomplete for this Run.',
          'AGENT_PROMPT_SUBMISSION_BUSY',
          promptReadinessDetail({
            runId: session.run.runId,
            activeSubmissionId: existing.submissionId,
            payloadAcknowledged: existing.payload.acknowledged,
            submitAcknowledged: existing.submit.acknowledged,
            payloadStartByte: existing.payload.inputByteRange.startByte,
            payloadEndByte: existing.payload.inputByteRange.endByte,
            submitStartByte: existing.submit.inputByteRange.startByte,
            submitEndByte: existing.submit.inputByteRange.endByte
          })
        )
      }
      const readiness = stored.terminalPromptReadiness
      if (!readiness || readiness.readyThroughByte === undefined) {
        throw new AgentMuxError(
          'Agent prompt requires a ready composer epoch for this exact Run.',
          'AGENT_PROMPT_NOT_READY',
          promptReadinessDetail({
            runId: session.run.runId,
            readinessId: readiness?.id ?? 'none',
            readinessSource: readiness?.source ?? 'none',
            readinessOutputCursorBytes: readiness?.outputCursorBytes,
            readyThroughByte: readiness?.readyThroughByte ?? 'pending',
            latestOutputBytes: run.latestOutputBytes,
            reason: readiness ? 'observation-pending' : 'epoch-missing'
          })
        )
      }
      if (readiness.consumedBySubmissionId !== undefined) {
        throw new AgentMuxError(
          'The current composer readiness epoch was already consumed by another prompt.',
          'AGENT_PROMPT_READINESS_CONSUMED',
          promptReadinessDetail({
            runId: session.run.runId,
            readinessId: readiness.id,
            readinessSource: readiness.source,
            readinessOutputCursorBytes: readiness.outputCursorBytes,
            readyThroughByte: readiness.readyThroughByte,
            consumedBySubmissionId: readiness.consumedBySubmissionId
          })
        )
      }
      const outputCursorBytes = Math.max(run.latestOutputBytes, readiness.readyThroughByte)
      return {
        ...stored,
        terminalPromptReadiness: {
          ...readiness,
          consumedBySubmissionId: submissionId
        },
        terminalPromptSubmission: {
          run: { ...stored.run },
          submissionId,
          promptDigest,
          readinessSource: readiness.source,
          readinessId: readiness.id,
          readinessOutputCursorBytes: readiness.outputCursorBytes,
          readyThroughByte: readiness.readyThroughByte,
          outputCursorBytes,
          payload: {
            operationId: payloadOperationId,
            inputByteRange: {
              startByte: expectedByte,
              endByte: expectedByte + payloadBytes
            },
            acknowledged: false
          },
          submit: {
            operationId: submitOperationId,
            inputByteRange: {
              startByte: expectedByte + payloadBytes,
              endByte: expectedByte + payloadBytes + submitBytes
            },
            acknowledged: false
          }
        },
        updatedAt: Date.now()
      }
    }
    const claim = async (): Promise<AgentMuxStoredAgentSession> => (
      await this.deps.registry.update(
        session.agentSessionId,
        session.run,
        claimPromptReadiness
      )
    )
    const promptReadinessMayBeStale = (error: AgentMuxError): boolean => (
      error.code === 'AGENT_PROMPT_NOT_READY' ||
      error.code === 'AGENT_PROMPT_READINESS_CONSUMED' ||
      error.code === 'AGENT_PROMPT_SUBMISSION_BUSY'
    )
    let current: AgentMuxStoredAgentSession
    try {
      current = await claim()
    } catch (error) {
      if (error instanceof AgentMuxError && promptReadinessMayBeStale(error)) {
        await this.deps.registry.load(session.hostId)
        const canonical = this.deps.requireAgentSession(session.agentSessionId)
        if (!sameRun(canonical.run, session.run)) {
          throw new AgentMuxError(
            'Agent Session changed while refreshing prompt readiness.',
            'STALE_AGENT_SESSION',
            promptReadinessDetail({
              expectedRunId: session.run.runId,
              canonicalRunId: canonical.run.runId,
              reason: 'run-replaced-during-refresh'
            })
          )
        }
        try {
          current = await claim()
        } catch (refreshError) {
          if (refreshError instanceof AgentMuxError && refreshError.code === 'STALE_AGENT_SESSION') {
            throw new AgentMuxError(
              'Prompt readiness changed or was consumed by another Client.',
              'AGENT_PROMPT_READINESS_CONFLICT',
              promptReadinessDetail({
                expectedRunId: session.run.runId,
                canonicalRunId: canonical.run.runId,
                reason: 'session-cas-rejected-after-refresh'
              })
            )
          }
          throw refreshError
        }
      } else if (error instanceof AgentMuxError && error.code === 'STALE_AGENT_SESSION') {
        throw new AgentMuxError(
          'Prompt readiness changed or was consumed by another Client.',
          'AGENT_PROMPT_READINESS_CONFLICT',
          promptReadinessDetail({
            expectedRunId: session.run.runId,
            reason: 'session-cas-rejected'
          })
        )
      } else {
        throw error
      }
    }
    let submission = current.terminalPromptSubmission
    if (!submission) {
      throw new AgentMuxError(
        'Agent prompt submission claim was not persisted.',
        'AGENT_PROMPT_SUBMISSION_STATE_INVALID'
      )
    }
    assertSubmission(submission)
    let acceptedInputBytes = run.acceptedInputBytes

    const applyPhase = async (
      phaseName: 'payload' | 'submit',
      data: string
    ): Promise<void> => {
      submission = this.deps.requireAgentSession(session.agentSessionId).terminalPromptSubmission
      if (!submission) {
        throw new AgentMuxError(
          'Agent prompt submission claim disappeared.',
          'AGENT_PROMPT_SUBMISSION_STATE_INVALID'
        )
      }
      assertSubmission(submission)
      const phase = submission[phaseName]
      if (phase.acknowledged) {
        if (acceptedInputBytes === null || acceptedInputBytes < phase.inputByteRange.endByte) {
          throw new AgentMuxError(
            'CtxMux Input cursor precedes the persisted prompt phase receipt.',
            'AGENT_PROMPT_SUBMISSION_STATE_INVALID'
          )
        }
        this.deps.agentInputCursors.set(session.agentSessionId, acceptedInputBytes)
        return
      }
      const accepted = await this.deps.kernel.input(session.run.runId, {
        ownerInstanceId: this.deps.kernel.identity().daemonInstanceId,
        operationId: phase.operationId,
        expectedByte: phase.inputByteRange.startByte,
        data
      })
      if (
        accepted.appliedByteRange.startByte !== phase.inputByteRange.startByte ||
        accepted.appliedByteRange.endByte !== phase.inputByteRange.endByte ||
        accepted.run.acceptedInputBytes === null ||
        accepted.run.acceptedInputBytes < phase.inputByteRange.endByte
      ) {
        throw new AgentMuxError(
          'CtxMux prompt phase receipt does not match the persisted Input claim.',
          'AGENT_PROMPT_SUBMISSION_RECEIPT_MISMATCH'
        )
      }
      acceptedInputBytes = accepted.run.acceptedInputBytes
      if (phaseName === 'payload') {
        // 高频受据合并（f-23q8faabh / T-003）：payload 受据不单独整写一次 CAS JSON，随后续
        // submit 受据一次落盘。崩溃窗口内它可从 ctxmux 事实重推——同一 operationId 重放拿到
        // 幂等回执，上面的 appliedByteRange 校验就是恢复路径。
        this.deps.agentInputCursors.set(session.agentSessionId, acceptedInputBytes)
        return
      }
      const acknowledgePhase = (
        stored: AgentMuxStoredAgentSession
      ): AgentMuxStoredAgentSession => {
        const state = stored.terminalPromptSubmission
        if (!state) {
          throw new AgentMuxError(
            'Agent prompt submission claim disappeared.',
            'AGENT_PROMPT_SUBMISSION_STATE_INVALID'
          )
        }
        assertSubmission(state)
        if (state.submit.acknowledged) return stored
        return {
          ...stored,
          terminalPromptSubmission: {
            ...state,
            payload: { ...state.payload, acknowledged: true },
            submit: { ...state.submit, acknowledged: true }
          },
          updatedAt: Date.now()
        }
      }
      try {
        current = await this.deps.registry.update(
          session.agentSessionId,
          session.run,
          acknowledgePhase
        )
      } catch (error) {
        if (!(error instanceof AgentMuxError) || error.code !== 'STALE_AGENT_SESSION') throw error
        await this.deps.registry.load(session.hostId)
        const canonical = this.deps.requireAgentSession(session.agentSessionId)
        if (!sameRun(canonical.run, session.run)) {
          throw new AgentMuxError(
            'Agent Session changed while adopting its prompt phase receipt.',
            'STALE_AGENT_SESSION'
          )
        }
        const canonicalSubmission = canonical.terminalPromptSubmission
        if (!canonicalSubmission) {
          throw new AgentMuxError(
            'Agent prompt submission claim disappeared.',
            'AGENT_PROMPT_SUBMISSION_STATE_INVALID'
          )
        }
        assertSubmission(canonicalSubmission)
        current = canonicalSubmission[phaseName].acknowledged
          ? canonical
          : await this.deps.registry.update(
              session.agentSessionId,
              session.run,
              acknowledgePhase
            )
      }
      submission = current.terminalPromptSubmission
      this.deps.agentInputCursors.set(session.agentSessionId, acceptedInputBytes)
    }

    if (submission.submit.acknowledged) {
      await applyPhase('submit', plan.submit)
      return
    }
    await applyPhase('payload', plan.payload)
    submission = this.deps.requireAgentSession(session.agentSessionId).terminalPromptSubmission
    if (!submission) {
      throw new AgentMuxError(
        'Agent prompt submission claim disappeared.',
        'AGENT_PROMPT_SUBMISSION_STATE_INVALID'
      )
    }
    if (
      !submission.submit.acknowledged &&
      acceptedInputBytes !== null &&
      acceptedInputBytes >= submission.submit.inputByteRange.endByte
    ) {
      await applyPhase('submit', plan.submit)
      return
    }
    await this.confirmRenderOrDegrade(session, submissionId, submission, plan.renderedText)
    await applyPhase('submit', plan.submit)
  }

  /**
   * 渲染验证的降级包装（原则 11 第 2 类）。走到这里时 payload 的 CtxMux 受据已经确认，Run 的
   * 输入通道是好的；replay 被截断（OUTPUT_GAP）或渲染确认超时只说明**我们的证据链**没走通。
   * 这两类绝不阻断 `\r`：先向 daemon 要权威 Run 状态确认 Agent 还活着，然后放行提交，同时把
   * 「本次交付未经完整屏幕确认」持久成服务窗事实并广播——绝不静默。
   *
   * 仍然 fail-closed 的两类：Run 已退出或消失（第 1 类，阻断是诚实的），以及 gap/超时之外的
   * 任何错误（状态冲突、受据不匹配——那是数据损坏，不是慢证据）。
   */
  private async confirmRenderOrDegrade(
    session: AgentMuxAgentSession,
    submissionId: string,
    submission: NonNullable<AgentMuxAgentSession['terminalPromptSubmission']>,
    renderedText: string
  ): Promise<void> {
    try {
      await this.waitForRender(session, submission, renderedText)
    } catch (error) {
      if (
        !(error instanceof AgentMuxError) ||
        (error.code !== 'OUTPUT_GAP' && error.code !== 'AGENT_PROMPT_RENDER_TIMEOUT')
      ) {
        throw error
      }
      // 判据是「Agent 还能干活吗」，不是「我们的检查过了吗」。观察开始时的 Run 状态可能已经
      // 过期，向 daemon 要权威状态；Run 真没了就让原始验证错误照常阻断。
      let run: CtxmuxAdapterRun
      try {
        run = await this.deps.kernel.status(session.run.runId)
      } catch (statusError) {
        if (statusError instanceof AgentMuxError && statusError.code === 'CTXMUX_run_not_found') throw error
        throw statusError
      }
      this.deps.assertAgentRun(session, run)
      if (run.state.type !== 'running') throw error
      await this.publishDeliveryDegrade(session, {
        state: 'unverified',
        mode: 'degraded',
        reason: error.code === 'OUTPUT_GAP' ? 'screen-evidence-gap' : 'prompt-render-timeout',
        submissionId,
        run: { ...session.run },
        observedAt: Date.now()
      })
      return
    }
    // 完整验证成功就是恢复路径：上一轮遗留的服务窗告示到此撤下。
    await this.clearDelivery(session)
  }

  private async publishDeliveryDegrade(
    session: AgentMuxAgentSession,
    degraded: AgentTerminalPromptDeliveryState
  ): Promise<void> {
    let next: AgentMuxStoredAgentSession
    try {
      next = await this.deps.updateExactAgentSession(
        session.agentSessionId,
        session.run,
        (current) => ({
          ...current,
          terminalPromptDelivery: structuredClone(degraded),
          updatedAt: Math.max(current.updatedAt, degraded.observedAt)
        })
      )
    } catch (persistError) {
      // Store 是观测面，不是输入通道：告示写不进去不许反过来挡住已受据的提交，否则第 2 类
      // 降级又被我们自己的持久化流程变回了阻断。诊断事件刻意不带 agentSessionId——Agent 是
      // 健康的，不能被渲染层涂成失败；相邻的 agent-session 事件才是有作用域的服务窗告示。
      const canonical = this.deps.requireAgentSession(session.agentSessionId)
      if (!sameRun(canonical.run, session.run)) throw persistError
      this.deps.publisher.publish({
        type: 'agent-error',
        code: 'AGENT_PROMPT_DELIVERY_PERSIST_FAILED',
        message: `Prompt delivery degradation could not be persisted; continuing with an in-memory notice. ${
          persistError instanceof Error ? persistError.message : String(persistError)
        }`,
        evidence: {
          source: 'user',
          observedAt: degraded.observedAt,
          run: { ...session.run }
        }
      })
      next = {
        ...structuredClone(canonical),
        terminalPromptDelivery: structuredClone(degraded)
      }
    }
    this.deps.publisher.publish({ type: 'agent-session', session: cloneSession(next) })
  }

  private async clearDelivery(session: AgentMuxAgentSession): Promise<void> {
    if (!this.deps.requireAgentSession(session.agentSessionId).terminalPromptDelivery) return
    const next = await this.deps.updateExactAgentSession(
      session.agentSessionId,
      session.run,
      (current) => {
        if (!current.terminalPromptDelivery) return current
        const cleared = { ...current }
        delete cleared.terminalPromptDelivery
        return { ...cleared, updatedAt: Math.max(cleared.updatedAt, Date.now()) }
      }
    )
    this.deps.publisher.publish({ type: 'agent-session', session: cloneSession(next) })
  }

  private async waitForRender(
    session: AgentMuxAgentSession,
    submission: NonNullable<AgentMuxAgentSession['terminalPromptSubmission']>,
    content: string
  ): Promise<void> {
    const matcher = this.deps.providers.get(session.providerId).terminalPromptRender
    if (!matcher) {
      throw new AgentMuxError(
        'Provider omitted its terminal prompt render matcher.',
        'INVALID_AGENT_PROVIDER'
      )
    }
    await this.deps.screenEvidence.wait(
      session,
      submission.outputCursorBytes,
      true,
      (screen) => screen.composerText(matcher.activeComposer, content.includes('\n')) === content,
      {
        timeoutMs: TERMINAL_PROMPT_RENDER_TIMEOUT_MS,
        timeoutMessage: 'Timed out waiting for the Agent prompt to render.',
        terminalMessage: 'Agent Run exited before the prompt was rendered.'
      }
    )
  }

  observeReadiness(
    session: AgentMuxAgentSession,
    readiness: AgentTerminalPromptReadinessState
  ): void {
    const matcher = this.deps.providers.get(session.providerId).terminalPromptRender
    if (!matcher) return
    this.readinessCancels.get(session.agentSessionId)?.()
    const controller = new AbortController()
    const cancel = (): void => {
      if (this.readinessCancels.get(session.agentSessionId) === cancel) {
        this.readinessCancels.delete(session.agentSessionId)
      }
      controller.abort()
    }
    this.readinessCancels.set(session.agentSessionId, cancel)
    const persistReady = async (readyThroughByte: number): Promise<void> => {
      try {
        const markReady = (current: AgentMuxStoredAgentSession): AgentMuxStoredAgentSession => {
          const currentReadiness = current.terminalPromptReadiness
          if (!currentReadiness || currentReadiness.id !== readiness.id) {
            throw new AgentMuxError(
              'Prompt readiness epoch changed before readiness was persisted.',
              'AGENT_PROMPT_READINESS_CONFLICT',
              promptReadinessDetail({
                expectedRunId: session.run.runId,
                expectedReadinessId: readiness.id,
                currentReadinessId: currentReadiness?.id ?? 'none',
                reason: 'readiness-epoch-replaced'
              })
            )
          }
          if (currentReadiness.readyThroughByte !== undefined) return current
          if (currentReadiness.consumedBySubmissionId !== undefined) {
            throw new AgentMuxError(
              'Prompt readiness epoch was consumed before readiness was persisted.',
              'AGENT_PROMPT_READINESS_CONFLICT',
              promptReadinessDetail({
                expectedRunId: session.run.runId,
                readinessId: readiness.id,
                consumedBySubmissionId: currentReadiness.consumedBySubmissionId,
                reason: 'readiness-consumed-before-persist'
              })
            )
          }
          return {
            ...current,
            terminalPromptReadiness: { ...currentReadiness, readyThroughByte },
            updatedAt: Date.now()
          }
        }
        let next: AgentMuxStoredAgentSession
        try {
          next = await this.deps.registry.update(session.agentSessionId, session.run, markReady)
        } catch (error) {
          if (!(error instanceof AgentMuxError) || error.code !== 'STALE_AGENT_SESSION') throw error
          await this.deps.registry.load(session.hostId)
          const canonical = this.deps.requireAgentSession(session.agentSessionId)
          if (!sameRun(canonical.run, session.run)) return
          const canonicalReadiness = canonical.terminalPromptReadiness
          if (!canonicalReadiness || canonicalReadiness.id !== readiness.id) return
          next = canonicalReadiness.readyThroughByte !== undefined
            ? canonical
            : await this.deps.registry.update(session.agentSessionId, session.run, markReady)
        }
        this.deps.publisher.publish({ type: 'agent-session', session: cloneSession(next) })
      } catch (error) {
        this.deps.publisher.publish({
          type: 'agent-error',
          agentSessionId: session.agentSessionId,
          code: error instanceof AgentMuxError ? error.code : 'AGENT_PROMPT_READINESS_FAILED',
          message: error instanceof Error ? error.message : String(error),
          evidence: {
            source: 'terminal-output',
            observedAt: Date.now(),
            run: { ...session.run }
          }
        })
      } finally {
        if (this.readinessCancels.get(session.agentSessionId) === cancel) {
          this.readinessCancels.delete(session.agentSessionId)
        }
      }
    }
    void this.deps.screenEvidence.wait(
      session,
      readiness.outputCursorBytes,
      readiness.source === 'initial-composer',
      (screen) => screen.composerText(matcher.activeComposer) === '',
      {
        // `timeoutMessage` 只有在**同时**传了 `timeoutMs` 时才会被用到：`wait()` 里那个定时器是
        // `if (options.timeoutMs !== undefined)` 才 arm 的。此前这里只给了措辞、没给预算，于是那句
        // 文案是死的、这条等待没有任何上界（#628）。两者必须成对出现。
        timeoutMs: TERMINAL_COMPOSER_READY_TIMEOUT_MS,
        timeoutMessage: 'Timed out waiting for an empty Agent composer.',
        terminalMessage: 'Agent Run exited before its composer became ready.',
        signal: controller.signal,
        ...(readiness.source === 'initial-composer'
          ? { requireFrameAfterBoundary: true }
          : {})
      }
    ).then(persistReady).catch((error) => {
      if (error instanceof AgentMuxError && error.code === 'AGENT_PROMPT_READINESS_CANCELLED') return
      if (this.readinessCancels.get(session.agentSessionId) === cancel) {
        this.readinessCancels.delete(session.agentSessionId)
      }
      this.deps.publisher.publish({
        type: 'agent-error',
        agentSessionId: session.agentSessionId,
        code: error instanceof AgentMuxError ? error.code : 'AGENT_PROMPT_READINESS_FAILED',
        message: error instanceof Error ? error.message : String(error),
        evidence: {
          source: 'terminal-output',
          observedAt: Date.now(),
          run: { ...session.run }
        }
      })
    })
  }
}
