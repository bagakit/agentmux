import { createHash } from 'node:crypto'
import { AgentProviderRegistry } from './agent-provider.js'
import { agentTurnCompletionIdentity, agentTurnEndBoundary, cloneSession, sameRun } from './agent-session-identity.js'
import { invalidateAgentIdleEvidence } from './agent-semantic-state.js'
import { AgentMuxAgentSessionRegistry } from './agent-session-registry.js'
import type { AgentMuxAgentSessionStore } from './agent-session-store.js'
import { AgentMuxClientEventPublisher } from './client-event-publisher.js'
import {
  CtxmuxRunAdapter,
  type CtxmuxAdapterRun
} from './ctxmux-run-adapter.js'
import { AgentMuxError } from './errors.js'
import type { AgentPromptCondition } from './agent-prompt-condition.js'
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

/** Bound the optional initial-composer observation; expiry never disables prompt input. */
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
  store: AgentMuxAgentSessionStore
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

  /** Cancel one Run's screen observation when its authoritative process lifecycle ends. */
  cancelReadiness(agentSessionId: string): void {
    this.readinessCancels.get(agentSessionId)?.()
  }

  async submitInputPlan(
    session: AgentMuxAgentSession,
    run: CtxmuxAdapterRun,
    submissionId: string,
    prompt: string,
    plan: AgentPromptInputPlan,
    condition: AgentPromptCondition,
    expectedCompletionId?: string,
    signal?: AbortSignal,
    allowUncertainTurn = false,
    renderSignal?: AbortSignal,
    expectedInputByte?: number
  ): Promise<void> {
    try {
      await this.deps.store.withPromptSubmission(session.agentSessionId, async () => {
        let current = await this.deps.registry.refresh(session.agentSessionId, session.run)
        let currentRun = await this.deps.kernel.status(run.runId)
        this.deps.assertAgentRun(current, currentRun)
        if (currentRun.state.type !== 'running') {
          throw new AgentMuxError('Agent Run is not running.', 'AGENT_RUN_NOT_RUNNING')
        }
        const previous = current.promptCompletionAdmission
        const unfinished = previous && !previous.acknowledged && !current.terminalPromptSubmission?.submit.acknowledged
        try {
          const predecessor = previous === undefined ? null : previous.submissionId
          if (predecessor !== submissionId &&
            (predecessor === undefined || predecessor !== condition.afterSubmissionId)) {
            throw new AgentMuxError('A later prompt admission has replaced this message\'s original condition. Its delivery is unknown; your message and the current Run are kept.',
              'AGENT_PROMPT_INPUT_UNCONFIRMED', 'unknown')
          }
          if (previous?.submissionId === submissionId || current.terminalPromptSubmission?.submissionId === submissionId ||
            (previous && unfinished && !previous.notApplied && !current.terminalPromptSubmission?.submit.notApplied)) {
            if (!previous?.intent || !previous.submissionId || !sameRun(previous.intent.run, current.run)) {
              throw new AgentMuxError('The original prompt Input request cannot be confirmed. Its message and Run are kept; use the terminal while delivery is reviewed.', 'AGENT_PROMPT_INPUT_UNCONFIRMED')
            }
            if (previous.submissionId === submissionId && previous.intent.prompt !== prompt) {
              throw new AgentMuxError('Agent prompt operation was reused with conflicting Session or content.', 'AGENT_PROMPT_OPERATION_CONFLICT')
            }
            if (unfinished) await this.publishDeliveryDegrade(current, {
              state: 'unverified', mode: 'degraded', reason: 'input-unconfirmed',
              submissionId: previous.submissionId, run: { ...current.run }, observedAt: Date.now()
            })
            // The old Core is excluded, but Native may still own its request. Join that exact
            // request; a fresh cursor or a changed Provider plan cannot replace it.
            try {
              await this.submitOwnedInputPlan(current, currentRun, previous.submissionId,
                previous.intent.prompt, previous.intent.plan, undefined, signal, true, renderSignal)
            } catch (error) {
              const settled = await this.deps.registry.refresh(session.agentSessionId, session.run)
              if (previous.submissionId === submissionId ||
                settled.promptCompletionAdmission?.submissionId !== previous.submissionId ||
                settled.terminalPromptSubmission?.submissionId !== previous.submissionId ||
                !settled.terminalPromptSubmission.submit.notApplied) throw error
              // Actual Native rejected the remaining phase of the old intent. Its
              // accepted payload is kept as accepted; only a different message may proceed.
            }
            if (previous.submissionId === submissionId) return
            current = await this.deps.registry.refresh(session.agentSessionId, session.run)
            currentRun = await this.deps.kernel.status(run.runId)
            this.deps.assertAgentRun(current, currentRun)
          }
          await this.submitOwnedInputPlan(current, currentRun, submissionId, prompt, plan,
            expectedCompletionId, signal, allowUncertainTurn, renderSignal, expectedInputByte)
        } catch (error) {
          if (error instanceof AgentMuxError && error.code === 'AGENT_PROMPT_INPUT_UNCONFIRMED' &&
            (previous?.submissionId === submissionId || previous &&
              (previous.submissionId === undefined || unfinished && previous.submissionId === condition.afterSubmissionId))) {
            await this.publishDeliveryDegrade(current, { state: 'unverified', mode: 'degraded',
              reason: 'input-unconfirmed', submissionId: previous?.submissionId ?? submissionId,
              run: { ...current.run }, observedAt: Date.now() })
          }
          throw error
        }
      })
    } catch (error) {
      if (error instanceof AgentMuxError && error.code === 'AGENT_PROMPT_SUBMISSION_BUSY') {
        const observed = this.deps.requireAgentSession(session.agentSessionId)
        throw new AgentMuxError(error.message, error.code, promptReadinessDetail({
          runId: observed.run.runId,
          activeSubmissionId: observed.promptCompletionAdmission?.submissionId,
          observedFrom: 'session-projection'
        }))
      }
      throw error
    }
  }

  private async submitOwnedInputPlan(
    session: AgentMuxAgentSession,
    run: CtxmuxAdapterRun,
    submissionId: string,
    prompt: string,
    plan: AgentPromptInputPlan,
    expectedCompletionId?: string,
    signal?: AbortSignal,
    allowUncertainTurn = false,
    renderSignal?: AbortSignal,
    expectedInputByte?: number
  ): Promise<void> {
    const assertInteraction = (current: AgentMuxAgentSession): void => {
      if (current.pendingInteraction) throw new AgentMuxError(
        'Answer the pending Agent interaction before submitting another prompt.', 'AGENT_INTERACTION_PENDING')
    }
    const assertAdmission = (current: AgentMuxAgentSession): void => {
      if (signal?.aborted) throw new AgentMuxError('Prompt delivery was cancelled before admission.', 'AGENT_PROMPT_CANCELLED')
      assertInteraction(current)
      if (expectedCompletionId === undefined) return
      if (expectedInputByte === undefined) throw new AgentMuxError('Automatic prompt admission is missing its input fence.', 'INVALID_AGENT_PROMPT')
      if (run.acceptedInputBytes === null) throw new AgentMuxError('Automatic input fence is unconfirmed; the terminal remains available.', 'CTXMUX_INPUT_CURSOR_MISSING')
      if (run.acceptedInputBytes !== expectedInputByte) throw new AgentMuxError('Human input changed before automatic delivery.', 'AGENT_COMPLETION_CHANGED')
      if (agentTurnCompletionIdentity(current) !== expectedCompletionId || current.promptCompletionAdmission?.completionId === expectedCompletionId) {
        throw new AgentMuxError('The completed turn changed before automatic delivery.', 'AGENT_COMPLETION_CHANGED')
      }
    }
    const assertTurnBoundary = (current: AgentMuxAgentSession, hasPreviousPrompt: boolean): boolean => {
      // Native cancellation ends a turn without completing it successfully. Both input
      // plans consume that boundary in the same admission; composer observations do not prove it.
      const completionId = agentTurnCompletionIdentity(current)
      const completed = completionId !== undefined && current.promptCompletionAdmission?.completionId !== completionId
      const ended = agentTurnEndBoundary(current) !== undefined
      const uncertain = !completed && !ended &&
        (hasPreviousPrompt || current.semanticStatus?.state === 'working')
      if (uncertain && (!allowUncertainTurn || expectedCompletionId !== undefined)) {
        throw new AgentMuxError(
          'The previous turn has not been confirmed complete. Your message is kept. Wait for its completion or explicitly continue; the Agent may still be working.',
          'AGENT_TURN_END_UNCONFIRMED'
        )
      }
      return uncertain
    }
    const settledDelivery = (
      stored: AgentMuxStoredAgentSession,
      uncertain: boolean
    ): AgentTerminalPromptDeliveryState | undefined => {
      if (uncertain) {
        return {
          state: 'unverified',
          mode: 'degraded',
          reason: 'turn-end-unconfirmed',
          submissionId,
          run: { ...stored.run },
          observedAt: Date.now()
        }
      }
      if (
        stored.terminalPromptDelivery?.submissionId === submissionId &&
        stored.terminalPromptDelivery?.reason === 'input-unconfirmed'
      ) {
        return undefined
      }
      return stored.terminalPromptDelivery
    }
    const publishSettledNotice = async (uncertain: boolean): Promise<void> => {
      if (uncertain) {
        await this.publishDeliveryDegrade(session, {
          state: 'unverified',
          mode: 'degraded',
          reason: 'turn-end-unconfirmed',
          submissionId,
          run: { ...session.run },
          observedAt: Date.now()
        })
      } else {
        await this.clearDelivery(session, submissionId)
      }
    }
    const claimInput = (current: AgentMuxStoredAgentSession, operationId: string, startByte: number, endByte: number, uncertainTurn: boolean): AgentMuxStoredAgentSession => {
      const completionId = agentTurnCompletionIdentity(current)
      const ended = agentTurnEndBoundary(current) !== undefined
      const observedAt = Date.now()
      const next: AgentMuxStoredAgentSession = { ...invalidateAgentIdleEvidence(current), updatedAt: Math.max(current.updatedAt, observedAt), promptCompletionAdmission: {
        submissionId, ...(completionId ? { completionId } : {}), operationId, startByte, endByte,
        intent: { run: { ...current.run }, ownerInstanceId: this.deps.kernel.identity().daemonInstanceId, prompt, plan: structuredClone(plan) },
        acknowledged: false,
        ...(uncertainTurn ? { uncertainTurn: true } : {})
      }, ...(ended ? { terminalPromptReadiness: { ...current.terminalPromptReadiness!, consumedBySubmissionId: submissionId } } : {}),
      ...(uncertainTurn ? { terminalPromptDelivery: {
        state: 'unverified' as const, mode: 'degraded' as const, reason: 'turn-end-unconfirmed' as const,
        submissionId, run: { ...current.run }, observedAt
      } } : {}) }
      delete next.terminalPromptSubmission
      if (!uncertainTurn) delete next.terminalPromptDelivery
      return next
    }
    const cancelConsumedNativeReadiness = (current: AgentMuxAgentSession): void => {
      if (current.terminalPromptReadiness?.source === 'native-stop' &&
        current.terminalPromptReadiness.consumedBySubmissionId === submissionId) this.cancelReadiness(current.agentSessionId)
    }
    if (plan.kind === 'single-phase') {
      const operationId = terminalPromptPhaseOperationIdentity(session, submissionId, 'payload', plan.data)
      const expectedByte = run.acceptedInputBytes
      if (expectedByte === null) {
        throw new AgentMuxError('CtxMux omitted its accepted Input byte cursor.', 'CTXMUX_INPUT_CURSOR_MISSING')
      }
      let uncertainTurn = false
      const current = await this.deps.updateExactAgentSession(session.agentSessionId, session.run, (stored) => {
        const admitted = stored.promptCompletionAdmission
        if (admitted && (admitted.operationId === operationId || admitted.submissionId === submissionId)) {
          if (admitted.operationId !== operationId ||
            admitted.endByte - admitted.startByte !== Buffer.byteLength(plan.data)) {
            throw new AgentMuxError('Agent prompt operation was reused with conflicting Session or content.', 'AGENT_PROMPT_OPERATION_CONFLICT')
          }
          if (run.acceptedInputBytes === null || run.acceptedInputBytes < admitted.endByte) assertInteraction(stored)
          uncertainTurn = admitted.uncertainTurn === true
          return stored
        }
        assertAdmission(stored)
        const incomplete = admitted !== undefined && (run.acceptedInputBytes === null || run.acceptedInputBytes < admitted.endByte)
        const replaceableClaim = admitted?.notApplied === true
        if (incomplete && !replaceableClaim) {
          throw new AgentMuxError('Another Agent prompt operation is incomplete for this Run.', 'AGENT_PROMPT_SUBMISSION_BUSY')
        }
        uncertainTurn = assertTurnBoundary(stored, admitted !== undefined)
        return claimInput(stored, operationId, expectedByte, expectedByte + Buffer.byteLength(plan.data), uncertainTurn)
      })
      const admitted = current.promptCompletionAdmission?.operationId === operationId ? current.promptCompletionAdmission : undefined
      cancelConsumedNativeReadiness(current)
      if (uncertainTurn) await this.publishDeliveryDegrade(session, {
        state: 'unverified', mode: 'degraded', reason: 'turn-end-unconfirmed',
        submissionId, run: { ...session.run }, observedAt: Date.now()
      })
      const accepted = await this.applyInput(session, submissionId, {
        ownerInstanceId: admitted!.intent!.ownerInstanceId,
        operationId,
        expectedByte: admitted?.startByte ?? expectedByte,
        data: plan.data
      })
      if (accepted.run.acceptedInputBytes === null) {
        throw new AgentMuxError('CtxMux omitted its accepted Input byte cursor.', 'CTXMUX_INPUT_CURSOR_MISSING')
      }
      if (accepted.appliedByteRange.startByte !== admitted!.startByte || accepted.appliedByteRange.endByte !== admitted!.endByte ||
        accepted.run.acceptedInputBytes < admitted!.endByte) {
        throw new AgentMuxError('CtxMux prompt receipt does not match its frozen Input.', 'AGENT_PROMPT_SUBMISSION_RECEIPT_MISMATCH')
      }
      await this.deps.registry.refresh(session.agentSessionId, session.run)
      await this.deps.updateExactAgentSession(session.agentSessionId, session.run, stored => {
        if (stored.promptCompletionAdmission?.operationId !== operationId) {
          throw new AgentMuxError('Prompt admission changed before receipt settlement.', 'STALE_AGENT_SESSION')
        }
        const delivery = settledDelivery(stored, uncertainTurn)
        const next: AgentMuxStoredAgentSession = {
          ...stored,
          promptCompletionAdmission: {
            ...stored.promptCompletionAdmission,
            acknowledged: true,
            notApplied: false,
            ...(uncertainTurn ? { uncertainTurn: true } : {})
          },
          ...(delivery ? { terminalPromptDelivery: delivery } : {}),
          updatedAt: Math.max(stored.updatedAt, Date.now())
        }
        if (!delivery && next.terminalPromptDelivery?.submissionId === submissionId) {
          delete next.terminalPromptDelivery
        }
        return next
      })
      this.deps.agentInputCursors.set(session.agentSessionId, accepted.run.acceptedInputBytes)
      await publishSettledNotice(uncertainTurn)
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
        (value.readinessEvidence !== undefined && value.readinessEvidence.readyThroughByte < value.readinessEvidence.outputCursorBytes) ||
        (value.readinessEvidence !== undefined && value.outputCursorBytes < value.readinessEvidence.readyThroughByte) ||
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
    const expectedByte = run.acceptedInputBytes
    if (expectedByte === null) {
      throw new AgentMuxError('CtxMux omitted its accepted Input byte cursor.', 'CTXMUX_INPUT_CURSOR_MISSING')
    }
    let uncertainTurn = false
    const claimPromptReadiness = (
      stored: AgentMuxStoredAgentSession
    ): AgentMuxStoredAgentSession => {
      const existing = stored.terminalPromptSubmission
      if (existing?.submissionId === submissionId) {
        assertSubmission(existing)
        // A pending interaction permits receipt recovery only, never additional input bytes.
        if (run.acceptedInputBytes === null || run.acceptedInputBytes < existing.submit.inputByteRange.endByte) assertInteraction(stored)
        uncertainTurn = stored.promptCompletionAdmission?.uncertainTurn === true
        return stored
      }
      assertAdmission(stored)
      const replaceableClaim = stored.promptCompletionAdmission?.notApplied === true || existing?.submit.notApplied === true
      if (existing && !existing.submit.acknowledged && !replaceableClaim) {
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
            submitEndByte: existing.submit.inputByteRange.endByte,
            acceptedInputBytes: run.acceptedInputBytes ?? 'unknown'
          })
        )
      }
      uncertainTurn = assertTurnBoundary(stored, existing !== undefined || stored.promptCompletionAdmission !== undefined)
      const readiness = stored.terminalPromptReadiness
      const readinessEvidence = readiness && readiness.run.runId === session.run.runId &&
        readiness.outputCursorBytes !== undefined &&
        readiness.readyThroughByte !== undefined &&
        (readiness.consumedBySubmissionId === undefined ||
          (replaceableClaim && readiness.consumedBySubmissionId === existing?.submissionId))
        ? { source: readiness.source, id: readiness.id, outputCursorBytes: readiness.outputCursorBytes,
            readyThroughByte: readiness.readyThroughByte }
        : undefined
      // Readiness is an observation, not a one-use permission to send. The acknowledged
      // transaction above and CtxMux's byte cursor serialize input; stale/missing observations
      // must not lock a healthy Agent out. Payload rendering below still verifies or degrades.
      const outputCursorBytes = Math.max(run.latestOutputBytes, readinessEvidence?.readyThroughByte ?? 0)
      return {
        ...claimInput(stored, payloadOperationId, expectedByte, expectedByte + payloadBytes + submitBytes, uncertainTurn),
        ...(readinessEvidence ? { terminalPromptReadiness: {
          ...readiness!, consumedBySubmissionId: submissionId
        } } : {}),
        terminalPromptSubmission: {
          run: { ...stored.run },
          submissionId,
          promptDigest,
          ...(readinessEvidence ? { readinessEvidence } : {}),
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
    let current = await this.deps.updateExactAgentSession(
      session.agentSessionId, session.run, claimPromptReadiness
    )
    let submission = current.terminalPromptSubmission
    cancelConsumedNativeReadiness(current)
    if (!submission) {
      throw new AgentMuxError(
        'Agent prompt submission claim was not persisted.',
        'AGENT_PROMPT_SUBMISSION_STATE_INVALID'
      )
    }
    assertSubmission(submission)
    if (uncertainTurn) await this.publishDeliveryDegrade(session, {
      state: 'unverified', mode: 'degraded', reason: 'turn-end-unconfirmed',
      submissionId, run: { ...session.run }, observedAt: Date.now()
    })
    let acceptedInputBytes = run.acceptedInputBytes

    const applyPhase = async (
      phaseName: 'payload' | 'submit',
      data: string
    ): Promise<void> => {
      const currentSession = await this.deps.registry.refresh(session.agentSessionId, session.run)
      submission = currentSession.terminalPromptSubmission
      if (!submission) {
        throw new AgentMuxError(
          'Agent prompt submission claim disappeared.',
          'AGENT_PROMPT_SUBMISSION_STATE_INVALID'
        )
      }
      assertSubmission(submission)
      const phase = submission[phaseName]
      if (phase.notApplied) {
        throw new AgentMuxError('The original prompt phase was not applied. Its accepted payload is kept; this input range cannot be reused.',
          'AGENT_PROMPT_INPUT_NOT_APPLIED', 'not_applied')
      }
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
      // Rendering/receipt waits can outlive the original admission. A new request owns
      // subsequent input; only an already-applied phase may recover its exact receipt.
      if (acceptedInputBytes === null || acceptedInputBytes < phase.inputByteRange.endByte) {
        assertInteraction(currentSession)
      }
      const accepted = await this.applyInput(session, submissionId, {
        ownerInstanceId: currentSession.promptCompletionAdmission!.intent!.ownerInstanceId,
        operationId: phase.operationId,
        expectedByte: phase.inputByteRange.startByte,
        data
      }, phaseName)
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
        const delivery = settledDelivery(stored, uncertainTurn)
        const next: AgentMuxStoredAgentSession = {
          ...stored,
          promptCompletionAdmission: {
            ...stored.promptCompletionAdmission!,
            acknowledged: true,
            notApplied: false,
            ...(uncertainTurn ? { uncertainTurn: true } : {})
          },
          terminalPromptSubmission: {
            ...state,
            payload: { ...state.payload, acknowledged: true },
            submit: { ...state.submit, acknowledged: true }
          },
          ...(delivery ? { terminalPromptDelivery: delivery } : {}),
          updatedAt: Date.now()
        }
        if (!delivery && next.terminalPromptDelivery?.submissionId === submissionId) {
          delete next.terminalPromptDelivery
        }
        return next
      }
      current = await this.deps.updateExactAgentSession(
        session.agentSessionId, session.run, acknowledgePhase
      )
      submission = current.terminalPromptSubmission
      this.deps.agentInputCursors.set(session.agentSessionId, acceptedInputBytes)
      if (uncertainTurn) {
        await this.publishDeliveryDegrade(session, {
          state: 'unverified',
          mode: 'degraded',
          reason: 'turn-end-unconfirmed',
          submissionId,
          run: { ...session.run },
          observedAt: Date.now()
        })
      }
    }

    if (submission.submit.acknowledged) {
      await applyPhase('submit', plan.submit)
      if (uncertainTurn) {
        await this.publishDeliveryDegrade(session, {
          state: 'unverified',
          mode: 'degraded',
          reason: 'turn-end-unconfirmed',
          submissionId,
          run: { ...session.run },
          observedAt: Date.now()
        })
      }
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
    await this.confirmRenderOrDegrade(session, submissionId, submission, plan.renderedText, renderSignal)
    if (uncertainTurn) await this.publishDeliveryDegrade(session, {
      state: 'unverified', mode: 'degraded', reason: 'turn-end-unconfirmed',
      submissionId, run: { ...session.run }, observedAt: Date.now()
    })
    await applyPhase('submit', plan.submit)
  }

  private async applyInput(
    session: AgentMuxAgentSession,
    submissionId: string,
    operation: Parameters<CtxmuxRunAdapter['input']>[1],
    phaseName?: 'payload' | 'submit'
  ): ReturnType<CtxmuxRunAdapter['input']> {
    const admission = this.deps.requireAgentSession(session.agentSessionId).promptCompletionAdmission
    if (admission?.submissionId === submissionId && admission.operationId === operation.operationId && admission.notApplied) {
      // A retry has future dispatch eligibility again. Clear the old negative disposition
      // durably BEFORE Native receives it, so a cold successor cannot take over this retry.
      await this.deps.updateExactAgentSession(session.agentSessionId, session.run, current => {
        if (current.promptCompletionAdmission?.submissionId !== submissionId) {
          throw new AgentMuxError('Prompt admission changed before retry.', 'STALE_AGENT_SESSION')
        }
        return { ...current, promptCompletionAdmission: { ...current.promptCompletionAdmission, notApplied: false },
          updatedAt: Math.max(current.updatedAt, Date.now()) }
      })
    }
    try {
      return await this.deps.kernel.input(session.run.runId, operation)
    } catch (error) {
      try {
        const notApplied = error instanceof AgentMuxError && error.detail === 'not_applied' &&
          operation.ownerInstanceId === this.deps.kernel.identity().daemonInstanceId
        if (notApplied) {
          await this.deps.updateExactAgentSession(session.agentSessionId, session.run, current => {
            const admission = current.promptCompletionAdmission
            if (admission?.submissionId !== submissionId) return current
            const submission = current.terminalPromptSubmission
            if (phaseName === 'submit' && error instanceof AgentMuxError && error.code === 'CTXMUX_input_cursor_mismatch' &&
              submission?.submissionId === submissionId && submission.submit.operationId === operation.operationId &&
              submission.submit.inputByteRange.startByte === operation.expectedByte) {
              // Reaching submit requires the original payload's ACK. Persist its receipt
              // together with the terminal rejection, without calling the whole prompt unapplied.
              return { ...current, terminalPromptSubmission: { ...submission,
                payload: { ...submission.payload, acknowledged: true },
                submit: { ...submission.submit, notApplied: true } }, updatedAt: Math.max(current.updatedAt, Date.now()) }
            }
            if (admission.operationId !== operation.operationId) return current
            return { ...current, promptCompletionAdmission: { ...admission, notApplied: true },
              updatedAt: Math.max(current.updatedAt, Date.now()) }
          })
        } else {
          await this.publishDeliveryDegrade(session, { state: 'unverified', mode: 'degraded',
            reason: 'input-unconfirmed', submissionId, run: { ...session.run }, observedAt: Date.now() })
        }
      } catch (noticeError) {
        this.deps.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
          code: 'AGENT_PROMPT_NOTICE_UNCONFIRMED', message: noticeError instanceof Error ? noticeError.message : String(noticeError),
          evidence: { source: 'user', run: { ...session.run }, observedAt: Date.now() } })
      }
      throw error
    }
  }

  /**
   * 渲染验证的降级包装（原则 11 第 2 类）。走到这里时 payload 的 CtxMux 受据已经确认，Run 的
   * 输入通道是好的；replay 被截断（OUTPUT_GAP）、渲染确认超时，或观察被**换掉**
   * （AGENT_PROMPT_READINESS_CANCELLED——resize / 掉线重挂会 discard 屏幕证据，把这条停着的
   * 等待就地取消）都只说明**我们的证据链**没走通。这三类绝不阻断 `\r`：先向 daemon 要权威 Run
   * 状态确认 Agent 还活着，然后放行提交，同时把「本次交付未经完整屏幕确认」持久成服务窗事实并
   * 广播——绝不静默。第三类此前会被原样抛给用户（#663），于是用户看到一条内部错误码，而 payload
   * 已经躺在 composer 里，占用没解除、重发又会撞 BUSY。
   *
   * 仍然 fail-closed 的两类：Run 已退出或消失（第 1 类，阻断是诚实的——那道
   * `run.state.type !== 'running'` 是承重的，删掉它 exited 与 unknown 两条用例当场红），以及
   * gap / 超时 / 观察替换之外的任何错误（状态冲突、受据不匹配——那是数据损坏，不是慢证据）。
   */
  private async confirmRenderOrDegrade(
    session: AgentMuxAgentSession,
    submissionId: string,
    submission: NonNullable<AgentMuxAgentSession['terminalPromptSubmission']>,
    renderedText: string,
    signal?: AbortSignal
  ): Promise<void> {
    try {
      await this.waitForRender(session, submission, renderedText, signal)
    } catch (error) {
      if (
        !(error instanceof AgentMuxError) ||
        (error.code !== 'OUTPUT_GAP' && error.code !== 'AGENT_PROMPT_RENDER_TIMEOUT' &&
          error.code !== 'AGENT_PROMPT_READINESS_CANCELLED' &&
          error.code !== 'TERMINAL_SIZE_UNKNOWN' &&
          error.code !== 'TERMINAL_GEOMETRY_CHANGED')
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
        reason: error.code === 'OUTPUT_GAP' ? 'screen-evidence-gap'
          : error.code === 'AGENT_PROMPT_READINESS_CANCELLED' ||
            error.code === 'TERMINAL_GEOMETRY_CHANGED' ||
            error.code === 'TERMINAL_SIZE_UNKNOWN'
            ? 'screen-evidence-replaced'
          : 'prompt-render-timeout',
        submissionId,
        run: { ...session.run },
        observedAt: Date.now()
      })
      return
    }
    // Render success restores screen evidence; it cannot confirm the previous native turn.
    const delivery = this.deps.requireAgentSession(session.agentSessionId).terminalPromptDelivery
    if (delivery?.reason === 'turn-end-unconfirmed' && delivery.submissionId === submissionId) return
    await this.clearDelivery(session, submissionId)
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

  private async clearDelivery(session: AgentMuxAgentSession, submissionId: string): Promise<void> {
    if (!this.deps.requireAgentSession(session.agentSessionId).terminalPromptDelivery) return
    const next = await this.deps.updateExactAgentSession(
      session.agentSessionId,
      session.run,
      (current) => {
        if (current.terminalPromptDelivery?.submissionId !== submissionId) return current
        if (current.terminalPromptDelivery?.reason === 'turn-end-unconfirmed') return current
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
    content: string,
    signal?: AbortSignal
  ): Promise<void> {
    const matcher = this.deps.providers.get(session.providerId).terminalPromptRender
    if (!matcher) {
      throw new AgentMuxError(
        'Provider omitted its terminal prompt render matcher.',
        'INVALID_AGENT_PROVIDER'
      )
    }
    const deadline = Date.now() + TERMINAL_PROMPT_RENDER_TIMEOUT_MS
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new AgentMuxError(
          'Timed out waiting for the Agent prompt to render.',
          'AGENT_PROMPT_RENDER_TIMEOUT'
        )
      }
      try {
        await this.deps.screenEvidence.wait(
          session,
          submission.outputCursorBytes,
          true,
          (screen) => screen.composerText(matcher.activeComposer, content.includes('\n')) === content,
          {
            timeoutMs: remaining,
            timeoutMessage: 'Timed out waiting for the Agent prompt to render.',
            terminalMessage: 'Agent Run exited before the prompt was rendered.',
            ...(signal ? { signal } : {})
          }
        )
        return
      } catch (error) {
        if (!(error instanceof AgentMuxError) || error.code !== 'TERMINAL_GEOMETRY_CHANGED') throw error
      }
    }
  }

  observeReadiness(
    session: AgentMuxAgentSession,
    readiness: AgentTerminalPromptReadinessState
  ): void {
    const matcher = this.deps.providers.get(session.providerId).terminalPromptRender
    if (!matcher || readiness.outputCursorBytes === undefined || readiness.consumedBySubmissionId !== undefined) return
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
          if (currentReadiness.consumedBySubmissionId !== undefined) return current
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
      if (error instanceof AgentMuxError && error.code === 'TERMINAL_GEOMETRY_CHANGED') {
        try {
          const current = this.deps.requireAgentSession(session.agentSessionId)
          const currentReadiness = current.terminalPromptReadiness
          if (
            sameRun(current.run, session.run) &&
            currentReadiness &&
            currentReadiness.readyThroughByte === undefined
          ) {
            this.observeReadiness(current, currentReadiness)
          }
        } catch {
          // Session left while geometry changed; there is nothing to re-arm.
        }
        return
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
