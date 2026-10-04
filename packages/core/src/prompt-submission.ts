import { createHash } from 'node:crypto'
import { AgentProviderRegistry, type AgentProviderPromptExecutionContext, type AgentProviderPreparedPromptTransport } from './agent-provider.js'
import { agentTurnCompletionIdentity, agentTurnEndBoundary, cloneSession, sameRun } from './agent-session-identity.js'
import { invalidateAgentIdleEvidence } from './agent-semantic-state.js'
import { AgentMuxAgentSessionRegistry } from './agent-session-registry.js'
import type { AgentMuxAgentSessionStore } from './agent-session-store.js'
import { AgentMuxClientEventPublisher } from './client-event-publisher.js'
import {
  CtxmuxRunAdapter,
  type CtxmuxAdapterRun
} from './ctxmux-run-adapter.js'
import { AgentMuxError, agentMuxCancellationError } from './errors.js'
import type { AgentPromptCondition } from './agent-prompt-condition.js'
import { AgentScreenEvidenceStore } from './screen-evidence.js'
import type {
  AgentMuxAgentSession,
  AgentMuxRunRef,
  AgentMuxStoredAgentSession,
  AgentPromptInputPlan,
  AgentPromptExecution,
  AgentPromptMessageContent,
  AgentFuturePromptOccurrence,
  AgentTerminalPromptDeliveryState,
  AgentTerminalPromptReadinessState
} from './types.js'

const TERMINAL_PROMPT_RENDER_TIMEOUT_MS = 10_000

/** Bound the optional initial-composer observation; expiry never disables prompt input. */
const TERMINAL_COMPOSER_READY_TIMEOUT_MS = 120_000

function promptFailureCauseDetail(error: unknown): string {
  const cause = error instanceof AgentMuxError
    ? { code: error.code, name: error.name, message: error.message, ...(error.detail === undefined ? {} : { detail: error.detail }),
      ...(error.controlFailure === undefined ? {} : { controlFailure: error.controlFailure }) }
    : { code: error instanceof Error ? error.name : 'unknown', message: error instanceof Error ? error.message : String(error) }
  return JSON.stringify(cause)
}

/** Invocation-local pre-input failure; it says nothing about an older logical operation. */
export function promptPreparationFailure(error: unknown): AgentMuxError {
  if (error instanceof AgentMuxError && error.code === 'AGENT_PROMPT_PREPARATION_FAILED') return error
  return new AgentMuxError('This call ended during read-only preparation before attempting input. The original operation and healthy terminal are kept.',
    'AGENT_PROMPT_PREPARATION_FAILED', promptFailureCauseDetail(error), { disposition: 'not_applied', confirmedInputBytes: 0 })
}

/** One original pre-input observation, not durable authorization or another submission owner. */
export type AgentPromptProtocolInputBoundary = {
  acknowledged?: { startByte: number; endByte: number; processId: number | null }
  invalid: boolean
  cancelled?: Error
  /** Invocation-local lane release; closed before any claim may be persisted. */
  preclaim?: { interruption: Error; claimStarted: boolean }
}

export type AgentPromptTransportQualification = Readonly<{
  agentSessionId: string
  run: AgentMuxRunRef
  processId: number | null
  nativeHandleIdentity: string
  submissionId: string
  promptDigest: string
  inputByte: number
  deadline: number
  transport: AgentProviderPreparedPromptTransport
  protocolInput?: AgentPromptProtocolInputBoundary
}>

/** Credit only this observation's contiguous, confirmed protocol bytes before its first claim. */
function preparedInputByte(qualified: AgentPromptTransportQualification): number {
  const protocol = qualified.protocolInput
  if (protocol?.cancelled) throw protocol.cancelled
  const range = protocol?.acknowledged
  if (protocol?.invalid || range && (range.processId !== qualified.processId ||
      range.endByte > qualified.inputByte && range.startByte > qualified.inputByte)) {
    throw new AgentMuxError('The original preparation input boundary is unconfirmed.', 'AGENT_PROMPT_IMMEDIATE_TRANSPORT_UNCONFIRMED')
  }
  return range ? Math.max(qualified.inputByte, range.endByte) : qualified.inputByte
}

/** Abandon only a read-only observation when its original preparation expires or is cancelled. */
async function observePromptTransport<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  try { return await Promise.race([read(), cancelled]) }
  finally { signal.removeEventListener('abort', abort) }
}

function promptMessageIdentity(message: AgentPromptMessageContent | undefined): string {
  return JSON.stringify(message === undefined ? null : [message.userContent, message.systemContext,
    message.authorAgentSessionId, message.authorHuman === true, message.sourceDevice, message.sourceChannel])
}

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
  phase: 'refresh' | 'interrupt' | 'payload' | 'submit',
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

  /** Called outside the input lane. A claimed/unknown original operation is never prepared anew. */
  async qualifyInputTransport(session: AgentMuxAgentSession, run: CtxmuxAdapterRun, submissionId: string,
    prompt: string, signal: AbortSignal, onPreparationStarted?: () => void,
    protocolInput?: AgentPromptProtocolInputBoundary, deadline = Date.now() + 40_000): Promise<AgentPromptTransportQualification | undefined> {
    const provider = this.deps.providers.get(session.providerId)
    const direct = provider.catalog.capabilities.promptExecution?.immediate === 'native-steer'
    if (!direct && !provider.preparePromptExecutionTransport) return undefined
    const current = await this.deps.registry.refresh(session.agentSessionId, session.run)
    const previous = current.promptCompletionAdmission
    const unfinished = previous && !previous.acknowledged && !current.terminalPromptSubmission?.submit.acknowledged &&
      !(previous.frameRefresh?.acknowledged && current.terminalPromptSubmission === undefined)
    if (previous?.submissionId === submissionId || current.terminalPromptSubmission?.submissionId === submissionId || unfinished) return undefined
    onPreparationStarted?.()
    try {
      this.deps.assertAgentRun(current, run)
      if (run.state.type !== 'running' || run.acceptedInputBytes === null) {
        throw new AgentMuxError('The original Run input fence is unconfirmed.', 'AGENT_PROMPT_IMMEDIATE_TRANSPORT_UNCONFIRMED')
      }
      const context: AgentProviderPromptExecutionContext = { args: run.args, workspacePath: current.workspacePath, signal,
        ...(current.hostId === 'local' && run.pid !== null ? { processId: run.pid } : {}),
        ...(current.nativeHandle ? { nativeHandle: current.nativeHandle } : {}),
        ...(current.nativePromptPredecessor?.run.runId === current.run.runId &&
          current.retiredRuns.at(-1)?.runId === current.nativePromptPredecessor.previousRun.runId
          ? { nativePromptPredecessor: current.nativePromptPredecessor } : {}) }
      const evidence = await provider.readPromptExecutionEvidence?.(context)
      // Direct steering already requires read + verify. Freeze that source without
      // imposing the interrupt strategy's optional preparation factory.
      const nativeSourceId = evidence?.sourceId
      const transport = direct && nativeSourceId ? { nativeSourceId,
        verifyCurrentTransport: async (fresh: AgentProviderPromptExecutionContext) =>
          await provider.verifyPromptExecutionTransport!({ ...fresh, nativeSourceId }) }
        : !direct ? await provider.preparePromptExecutionTransport!({ ...context, signal,
          ...(evidence ? { nativeSourceId: evidence.sourceId } : {}) }) : undefined
      if (!evidence || !transport || transport.nativeSourceId !== evidence.sourceId) {
        throw new AgentMuxError('The original native input transport is unconfirmed.', 'AGENT_PROMPT_IMMEDIATE_TRANSPORT_UNCONFIRMED')
      }
      signal.throwIfAborted()
      return { agentSessionId: current.agentSessionId, run: current.run, processId: run.pid,
        nativeHandleIdentity: JSON.stringify(current.nativeHandle ?? null), submissionId,
        promptDigest: createHash('sha256').update(prompt).digest('base64url'), inputByte: run.acceptedInputBytes,
        deadline, transport, ...(protocolInput ? { protocolInput } : {}) }
    } catch (error) {
      await this.publishDeliveryDegrade(current, { state: 'unverified', mode: 'degraded',
        reason: 'immediate-context-unconfirmed', submissionId, run: current.run, observedAt: Date.now() })
      throw promptPreparationFailure(error)
    }
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
    expectedInputByte?: number,
    message?: AgentPromptMessageContent,
    execution: AgentPromptExecution = 'default',
    expectedFutureIntent?: AgentFuturePromptOccurrence,
    assertSession?: (session: AgentMuxAgentSession) => void,
    transportQualification?: AgentPromptTransportQualification
  ): Promise<AgentPromptMessageContent | undefined> {
    try {
      return await this.deps.store.withPromptSubmission(session.agentSessionId, async () => {
        let current = await this.deps.registry.refresh(session.agentSessionId, session.run)
        let currentRun = await this.deps.kernel.status(run.runId)
        this.deps.assertAgentRun(current, currentRun)
        if (currentRun.state.type !== 'running') {
          throw new AgentMuxError('Agent Run is not running.', 'AGENT_RUN_NOT_RUNNING')
        }
        const previous = current.promptCompletionAdmission
        const unfinished = previous && !previous.acknowledged && !current.terminalPromptSubmission?.submit.acknowledged &&
          !(previous.frameRefresh?.acknowledged && current.terminalPromptSubmission === undefined)
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
            if (previous.submissionId === submissionId && previous.intent.message === undefined && message !== undefined) {
              throw new AgentMuxError('Original message source facts are unconfirmed. The original Input and healthy Agent are kept; use the terminal while its source is reviewed.', 'AGENT_PROMPT_INPUT_UNCONFIRMED', 'unknown')
            }
            if (previous.submissionId === submissionId && (previous.intent.prompt !== prompt ||
                promptMessageIdentity(previous.intent.message) !== promptMessageIdentity(message) ||
                (previous.intent.execution ?? 'default') !== execution)) {
              throw new AgentMuxError('Agent prompt operation was reused with conflicting Session or content.', 'AGENT_PROMPT_OPERATION_CONFLICT')
            }
            if (unfinished) await this.publishDeliveryDegrade(current, {
              state: 'unverified', mode: 'degraded', reason: 'input-unconfirmed',
              submissionId: previous.submissionId, run: { ...current.run }, observedAt: Date.now()
            })
            // The old Core is excluded, but Native may still own its request. Join that exact
            // request; a fresh cursor or a changed Provider plan cannot replace it.
            try {
              if (transportQualification?.protocolInput?.preclaim) transportQualification.protocolInput.preclaim.claimStarted = true
              await this.submitOwnedInputPlan(current, currentRun, previous.submissionId,
                previous.intent.prompt, previous.intent.plan, undefined, signal, true, renderSignal, undefined, previous.intent.message, previous.intent.execution, undefined, assertSession)
            } catch (error) {
              const settled = await this.deps.registry.refresh(session.agentSessionId, session.run)
              const refreshOnlySettled = settled.promptCompletionAdmission?.submissionId === previous.submissionId &&
                settled.promptCompletionAdmission.frameRefresh?.acknowledged && settled.terminalPromptSubmission === undefined
              const submitRejected = settled.terminalPromptSubmission?.submissionId === previous.submissionId &&
                settled.terminalPromptSubmission.submit.notApplied
              if (previous.submissionId === submissionId ||
                settled.promptCompletionAdmission?.submissionId !== previous.submissionId ||
                (!refreshOnlySettled && !submitRejected)) throw error
              // Only a different intent proceeds after confirmed harmless refresh
              // or an actual rejected submit. The old prompt remains unsent.
            }
            if (previous.submissionId === submissionId) return structuredClone(previous.intent.message)
            current = await this.deps.registry.refresh(session.agentSessionId, session.run)
            currentRun = await this.deps.kernel.status(run.runId)
            this.deps.assertAgentRun(current, currentRun)
          }
          await this.submitOwnedInputPlan(current, currentRun, submissionId, prompt, plan,
            expectedCompletionId, signal, allowUncertainTurn, renderSignal, expectedInputByte, message, execution, expectedFutureIntent, assertSession, transportQualification)
          return structuredClone(message)
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
    expectedInputByte?: number,
    message?: AgentPromptMessageContent,
    execution: AgentPromptExecution = 'default',
    expectedFutureIntent?: AgentFuturePromptOccurrence,
    assertSession?: (session: AgentMuxAgentSession) => void,
    transportQualification?: AgentPromptTransportQualification
  ): Promise<void> {
    let confirmedFutureIdle = false
    if (expectedFutureIntent !== undefined && session.promptCompletionAdmission?.completionId === agentTurnCompletionIdentity(session)) {
      const provider = this.deps.providers.get(session.providerId)
      const context = { args: run.args, workspacePath: session.workspacePath,
        ...(session.hostId === 'local' && run.pid !== null ? { processId: run.pid } : {}),
        ...(session.nativeHandle ? { nativeHandle: session.nativeHandle } : {}) }
      const evidence = await provider.readPromptExecutionEvidence?.(context)
      const boundary = session.promptCompletionAdmission?.outputCursorBytes
      if (evidence && evidence.state !== 'working' && provider.inspectPromptExecution && boundary !== undefined) {
        let resizeRevision: number | undefined
        await this.deps.screenEvidence.wait(session, run.latestOutputBytes, false, screen => { resizeRevision = screen.geometryRevision; return true },
          { timeoutMs: 2_000, requireCompleteFrame: true, timeoutMessage: 'Native screen geometry is unconfirmed.', terminalMessage: 'The original Agent Run ended.', ...(renderSignal ? { signal: renderSignal } : {}) })
        await this.deps.screenEvidence.wait(session, run.latestOutputBytes, false, screen => provider.inspectPromptExecution!(screen.snapshot()) === 'idle',
          { timeoutMs: 2_000, requireCompleteFrame: true,
            requireFrameAfterBoundary: true, checkpointFrameFence: { outputByte: boundary, resizeRevision: resizeRevision! },
            timeoutMessage: 'The native idle frame is unconfirmed; the future message remains due.', terminalMessage: 'The original Agent Run ended before future-message admission.',
            ...(renderSignal ? { signal: renderSignal } : {}) })
        const latest = await provider.readPromptExecutionEvidence!(context)
        confirmedFutureIdle = latest?.sourceId === evidence.sourceId && latest.id === evidence.id && latest.state !== 'working'
      }
    }
    const assertInteraction = (current: AgentMuxAgentSession): void => {
      assertSession?.(current)
      if (transportQualification && (transportQualification.agentSessionId !== current.agentSessionId ||
          !sameRun(transportQualification.run, current.run) ||
          transportQualification.nativeHandleIdentity !== JSON.stringify(current.nativeHandle ?? null))) {
        throw new AgentMuxError('The original native Session changed during input preparation.', 'AGENT_PROMPT_IMMEDIATE_TRANSPORT_UNCONFIRMED')
      }
      if (current.pendingInteraction) throw new AgentMuxError(
        'Answer the pending Agent interaction before submitting another prompt.', 'AGENT_INTERACTION_PENDING')
    }
    const assertAdmission = (current: AgentMuxAgentSession): void => {
      if (signal?.aborted) throw agentMuxCancellationError('Prompt delivery was cancelled before admission.', 'AGENT_PROMPT_CANCELLED', signal.reason)
      const preclaim = transportQualification?.protocolInput?.preclaim
      if (preclaim && !preclaim.claimStarted && renderSignal?.aborted && renderSignal.reason === preclaim.interruption) {
        throw preclaim.interruption
      }
      if (transportQualification) {
        const firstInput = current.promptCompletionAdmission?.submissionId !== submissionId || !current.promptCompletionAdmission.frameRefresh
        if (renderSignal?.aborted || Date.now() >= transportQualification.deadline || run.pid !== transportQualification.processId ||
            firstInput && run.acceptedInputBytes !== preparedInputByte(transportQualification)) {
          throw new AgentMuxError('The original input boundary changed before admission.', 'AGENT_PROMPT_IMMEDIATE_TRANSPORT_UNCONFIRMED')
        }
      }
      assertInteraction(current)
      if (expectedCompletionId === undefined && expectedFutureIntent === undefined) return
      if (expectedInputByte === undefined) throw new AgentMuxError('Automatic prompt admission is missing its input fence.', 'INVALID_AGENT_PROMPT')
      if (run.acceptedInputBytes === null) throw new AgentMuxError('Automatic input fence is unconfirmed; the terminal remains available.', 'CTXMUX_INPUT_CURSOR_MISSING')
      if (run.acceptedInputBytes !== expectedInputByte) throw new AgentMuxError('Human input changed before automatic delivery.', 'AGENT_COMPLETION_CHANGED')
      if (expectedFutureIntent !== undefined) {
        const saved = current.futurePromptIntents?.[expectedFutureIntent.intentId]
        if (!saved?.active || saved.prompt !== prompt || promptMessageIdentity(saved.message) !== promptMessageIdentity(message) ||
            (saved.lastOccurrenceAt !== undefined && saved.lastOccurrenceAt >= expectedFutureIntent.occurrenceAt)) {
          throw new AgentMuxError('The saved future-message intent or occurrence no longer authorizes this Input.', 'AGENT_FUTURE_INTENT_CHANGED')
        }
        // A future message may use a consumed, still-idle native boundary; it cannot invent one.
        if (agentTurnCompletionIdentity(current) === undefined && agentTurnEndBoundary(current) === undefined || current.semanticStatus?.state === 'working') {
          throw new AgentMuxError('The Agent idle boundary is unconfirmed. The future message remains due.', 'AGENT_TURN_END_UNCONFIRMED')
        }
        if (current.promptCompletionAdmission?.completionId === agentTurnCompletionIdentity(current) && !confirmedFutureIdle) {
          throw new AgentMuxError('The previous admission consumed this idle boundary; a current native idle frame is unconfirmed. The future message remains due and manual input remains available.', 'AGENT_TURN_END_UNCONFIRMED')
        }
      } else if (agentTurnCompletionIdentity(current) !== expectedCompletionId || current.promptCompletionAdmission?.completionId === expectedCompletionId) {
        throw new AgentMuxError('The completed turn changed before automatic delivery.', 'AGENT_COMPLETION_CHANGED')
      }
    }
    const assertTurnBoundary = (current: AgentMuxAgentSession, hasPreviousPrompt: boolean): boolean => {
      // Native cancellation ends a turn without completing it successfully. Both input
      // plans consume that boundary in the same admission; composer observations do not prove it.
      const completionId = agentTurnCompletionIdentity(current)
      const completed = completionId !== undefined && (current.promptCompletionAdmission?.completionId !== completionId || expectedFutureIntent !== undefined)
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
      // The CAS callback may already be persisting this intent when protocol input arrives.
      // From this point it must rejoin its frozen operation, never prepare anew.
      if (transportQualification?.protocolInput?.preclaim) transportQualification.protocolInput.preclaim.claimStarted = true
      const completionId = agentTurnCompletionIdentity(current)
      const ended = agentTurnEndBoundary(current) !== undefined
      const observedAt = Date.now()
      const next: AgentMuxStoredAgentSession = { ...invalidateAgentIdleEvidence(current), updatedAt: Math.max(current.updatedAt, observedAt), promptCompletionAdmission: {
        submissionId, ...(completionId ? { completionId } : {}), ...(expectedFutureIntent ? { futureIntent: { ...expectedFutureIntent } } : {}), operationId, startByte, endByte, outputCursorBytes: run.latestOutputBytes,
        intent: { run: { ...current.run }, ownerInstanceId: this.deps.kernel.identity().daemonInstanceId, prompt, plan: structuredClone(plan), execution,
          ...(message === undefined ? {} : { message: structuredClone(message) }) },
        acknowledged: false,
        ...(current.promptCompletionAdmission?.submissionId === submissionId && current.promptCompletionAdmission.frameRefresh
          ? { frameRefresh: current.promptCompletionAdmission.frameRefresh } : {}),
        ...(uncertainTurn ? { uncertainTurn: true } : {})
      }, ...(ended ? { terminalPromptReadiness: { ...current.terminalPromptReadiness!, consumedBySubmissionId: submissionId } } : {}),
      ...(uncertainTurn ? { terminalPromptDelivery: {
        state: 'unverified' as const, mode: 'degraded' as const, reason: 'turn-end-unconfirmed' as const,
        submissionId, run: { ...current.run }, observedAt
      } } : {}) }
      delete next.terminalPromptSubmission
      if (expectedFutureIntent) {
        const saved = current.futurePromptIntents![expectedFutureIntent.intentId]!
        next.futurePromptIntents = { ...current.futurePromptIntents, [expectedFutureIntent.intentId]: { ...saved, lastOccurrenceAt: expectedFutureIntent.occurrenceAt, lastOperationId: submissionId } }
      }
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

    const provider = this.deps.providers.get(session.providerId)
    const immediateStrategy = provider.catalog.capabilities.promptExecution?.immediate
    const frozen = session.promptCompletionAdmission
    const rejoiningFrozenPlan = frozen?.submissionId === submissionId && frozen.intent !== undefined &&
      sameRun(frozen.intent.run, session.run) && frozen.intent.prompt === prompt &&
      (frozen.intent.execution ?? 'default') === execution &&
      promptMessageIdentity(frozen.intent.message) === promptMessageIdentity(message) &&
      JSON.stringify(frozen.intent.plan) === JSON.stringify(plan)
    const nativeSteer = execution === 'immediate' && !plan.prepare && (immediateStrategy === 'native-steer' || rejoiningFrozenPlan)
    if (execution === 'default' ? Boolean(plan.prepare) :
        !nativeSteer && !(plan.prepare && (immediateStrategy === 'interrupt-before-input' || rejoiningFrozenPlan))) {
      throw new AgentMuxError('Provider preparation does not match this single prompt execution authorization.', 'AGENT_PROMPT_OPERATION_CONFLICT')
    }
    const nativeContext: AgentProviderPromptExecutionContext = { args: run.args, workspacePath: session.workspacePath,
      ...(session.hostId === 'local' && run.pid !== null ? { processId: run.pid } : {}),
      ...(session.nativeHandle ? { nativeHandle: session.nativeHandle } : {}) }
    if (session.nativePromptPredecessor?.run.runId === session.run.runId &&
      session.retiredRuns.at(-1)?.runId === session.nativePromptPredecessor.previousRun.runId) {
      Object.assign(nativeContext, { nativePromptPredecessor: session.nativePromptPredecessor })
    }
    let preparation: NonNullable<AgentMuxAgentSession['terminalPromptSubmission']>['prepare']
    let preparationGeneration: number | undefined
    const verifyTransport = async (nativeSourceId: string | undefined, firstInputFence: boolean): Promise<void> => {
      const qualified = transportQualification
      if (qualified && (qualified.agentSessionId !== session.agentSessionId || !sameRun(qualified.run, session.run) ||
          qualified.processId !== run.pid || qualified.nativeHandleIdentity !== JSON.stringify(session.nativeHandle ?? null) ||
          qualified.submissionId !== submissionId || qualified.promptDigest !== createHash('sha256').update(prompt).digest('base64url') ||
          qualified.transport.nativeSourceId !== nativeSourceId || Date.now() >= qualified.deadline)) {
        throw new AgentMuxError('Original transport preparation no longer matches this message.', 'AGENT_PROMPT_IMMEDIATE_TRANSPORT_UNCONFIRMED')
      }
      const remaining = qualified ? qualified.deadline - Date.now() : 8_000
      const signals = [AbortSignal.timeout(Math.max(1, remaining)), ...(renderSignal ? [renderSignal] : []), ...(signal ? [signal] : [])]
      const context = { ...nativeContext, ...(nativeSourceId ? { nativeSourceId } : {}), signal: AbortSignal.any(signals) }
      const confirmed = await observePromptTransport(context.signal, async () => qualified
        ? await qualified.transport.verifyCurrentTransport(context)
        : !provider.verifyPromptExecutionTransport || await provider.verifyPromptExecutionTransport(context))
      if (!confirmed) throw new AgentMuxError('The native input transport is unconfirmed.', 'AGENT_PROMPT_IMMEDIATE_TRANSPORT_UNCONFIRMED')
      if (qualified) {
        const fresh = await observePromptTransport(context.signal, () => this.deps.kernel.status(run.runId))
        this.deps.assertAgentRun(session, fresh)
        context.signal.throwIfAborted()
        if (fresh.state.type !== 'running' || fresh.pid !== qualified.processId ||
            firstInputFence && fresh.acceptedInputBytes !== preparedInputByte(qualified)) {
          throw new AgentMuxError('Input or process identity changed during preparation.', 'AGENT_PROMPT_IMMEDIATE_TRANSPORT_UNCONFIRMED')
        }
        run = fresh
      }
    }
    if (nativeSteer && !rejoiningFrozenPlan) {
      // Observe the current pane, preserving one original preparation deadline and
      // the frozen source across acknowledged protocol replies before first claim.
      const remaining = transportQualification ? transportQualification.deadline - Date.now() : 8_000
      const preparationSignal = AbortSignal.any([AbortSignal.timeout(Math.max(1, remaining)), ...(signal ? [signal] : []), ...(renderSignal ? [renderSignal] : [])])
      const context = { ...nativeContext, signal: preparationSignal }
      try {
        const nativeSourceId = transportQualification?.transport.nativeSourceId ??
          (await observePromptTransport(preparationSignal, async () => await provider.readPromptExecutionEvidence?.(context)))?.sourceId
        if (!nativeSourceId) throw new AgentMuxError('The current native input source is unconfirmed.', 'AGENT_PROMPT_IMMEDIATE_TRANSPORT_UNCONFIRMED')
        await observePromptTransport(preparationSignal, () => this.deps.screenEvidence.wait(session, run.latestOutputBytes, false,
          screen => Boolean(provider.inspectPromptExecution) && provider.inspectPromptExecution!(screen.snapshot(), 'native-steer') !== 'unavailable',
          { timeoutMs: Math.max(1, remaining), requireCompleteFrame: true, signal: preparationSignal,
            timeoutMessage: 'The current native composer is unconfirmed; ordinary terminal input remains available.',
            terminalMessage: 'The original Agent Run ended before native steering.' }))
        await verifyTransport(nativeSourceId, true)
        preparationSignal.throwIfAborted()
      } catch (error) {
        const preclaim = transportQualification?.protocolInput?.preclaim
        if (preclaim && !preclaim.claimStarted && error === preclaim.interruption) throw error
        throw promptPreparationFailure(error)
      }
    }
    if (plan.prepare && session.terminalPromptSubmission?.submissionId !== submissionId) {
      const rejoiningOriginal = session.promptCompletionAdmission?.submissionId === submissionId
      let inputAttempted = false
      try {
        const transportEvidence = provider.readPromptExecutionEvidence ? await provider.readPromptExecutionEvidence(nativeContext) : undefined
        await verifyTransport(transportEvidence?.sourceId, session.promptCompletionAdmission?.submissionId !== submissionId || !session.promptCompletionAdmission.frameRefresh)
        const observation: { context: 'idle' | 'interruptible' | 'unavailable' } = { context: 'unavailable' }
        let frameRefresh = session.promptCompletionAdmission?.submissionId === submissionId
          ? session.promptCompletionAdmission.frameRefresh : undefined
        if (plan.prepare.refresh) {
          // Only this explicit intent authorizes native non-submitting refresh. The
          // restored grid remains owner-confirmed before any native redraw occurs.
          if (expectedCompletionId !== undefined) throw new AgentMuxError('Automatic admission cannot authorize native refresh.', 'INVALID_AGENT_PROMPT')
          let resizeRevision = -1
          await this.deps.screenEvidence.wait(session, run.latestOutputBytes, false, screen => {
            resizeRevision = screen.geometryRevision
            return true
          }, { timeoutMs: 2_000, timeoutMessage: 'Native screen attributes are unconfirmed.',
            terminalMessage: 'Agent Run exited before native refresh.',
            ...(frameRefresh ? { checkpointFrameFence: { outputByte: frameRefresh.outputCursorBytes, resizeRevision: frameRefresh.resizeRevision } } : {}),
            ...(renderSignal ? { signal: renderSignal } : {}) })
          if (!transportEvidence || frameRefresh && frameRefresh.nativeSourceId !== transportEvidence.sourceId) {
            throw new AgentMuxError('Native refresh source is unconfirmed.', 'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED')
          }
          if (frameRefresh && (frameRefresh.operationId !== terminalPromptPhaseOperationIdentity(session, submissionId, 'refresh',
              JSON.stringify([plan.prepare.refresh, frameRefresh.nativeSourceId, frameRefresh.resizeRevision])) ||
              frameRefresh.inputByteRange.endByte - frameRefresh.inputByteRange.startByte !== Buffer.byteLength(plan.prepare.refresh))) {
            throw new AgentMuxError('Native refresh intent was reused with conflicting content.', 'AGENT_PROMPT_OPERATION_CONFLICT')
          }
          // An acknowledged refresh at an older geometry can be renewed. An
          // uncertain request always rejoins its original Runtime receipt first.
          if (!frameRefresh || frameRefresh.acknowledged && frameRefresh.resizeRevision !== resizeRevision) {
            if (transportQualification) await verifyTransport(transportEvidence.sourceId, frameRefresh === undefined)
            const refreshedRun = await this.deps.kernel.status(run.runId)
            this.deps.assertAgentRun(session, refreshedRun)
            run = refreshedRun
            if (run.acceptedInputBytes === null) throw new AgentMuxError('CtxMux omitted its accepted Input byte cursor.', 'CTXMUX_INPUT_CURSOR_MISSING')
            const operationId = terminalPromptPhaseOperationIdentity(session, submissionId, 'refresh',
              JSON.stringify([plan.prepare.refresh, transportEvidence.sourceId, resizeRevision]))
            const startByte = transportQualification && frameRefresh === undefined ? preparedInputByte(transportQualification) : run.acceptedInputBytes
            const endByte = startByte + Buffer.byteLength(plan.prepare.refresh)
            const frozen = await this.deps.updateExactAgentSession(session.agentSessionId, session.run, stored => {
              assertAdmission(stored)
              const next = claimInput(stored, operationId, startByte, endByte, false)
              return { ...next, promptCompletionAdmission: { ...next.promptCompletionAdmission!, frameRefresh: {
                operationId, inputByteRange: { startByte, endByte }, acknowledged: false,
                outputCursorBytes: run.latestOutputBytes, resizeRevision, nativeSourceId: transportEvidence.sourceId
              } } }
            })
            frameRefresh = frozen.promptCompletionAdmission!.frameRefresh!
          }
          if (frameRefresh.notApplied) throw new AgentMuxError('The original refresh was not applied; its range cannot be reused.', 'AGENT_PROMPT_INPUT_NOT_APPLIED', 'not_applied')
          if (!frameRefresh.acknowledged) {
            const current = await this.deps.registry.refresh(session.agentSessionId, session.run)
            if (run.acceptedInputBytes === null || run.acceptedInputBytes < frameRefresh.inputByteRange.endByte) assertAdmission(current)
            inputAttempted = true
            const accepted = await this.applyInput(session, submissionId, {
              ownerInstanceId: current.promptCompletionAdmission!.intent!.ownerInstanceId,
              operationId: frameRefresh.operationId, expectedByte: frameRefresh.inputByteRange.startByte, data: plan.prepare.refresh
            }, 'refresh')
            if (accepted.appliedByteRange.startByte !== frameRefresh.inputByteRange.startByte ||
                accepted.appliedByteRange.endByte !== frameRefresh.inputByteRange.endByte ||
                accepted.run.acceptedInputBytes === null || accepted.run.acceptedInputBytes < frameRefresh.inputByteRange.endByte) {
              throw new AgentMuxError('Native refresh receipt does not match its frozen Input.', 'AGENT_PROMPT_SUBMISSION_RECEIPT_MISMATCH')
            }
            run = accepted.run
            const frozen = frameRefresh
            await this.deps.updateExactAgentSession(session.agentSessionId, session.run, stored => {
              if (stored.promptCompletionAdmission?.submissionId !== submissionId ||
                  stored.promptCompletionAdmission.frameRefresh?.operationId !== frozen.operationId) {
                throw new AgentMuxError('Native refresh admission changed before settlement.', 'STALE_AGENT_SESSION')
              }
              return { ...stored, promptCompletionAdmission: { ...stored.promptCompletionAdmission,
                frameRefresh: { ...frozen, acknowledged: true } }, updatedAt: Math.max(stored.updatedAt, Date.now()) }
            })
            frameRefresh = { ...frameRefresh, acknowledged: true }
            this.deps.agentInputCursors.set(session.agentSessionId, run.acceptedInputBytes!)
          } else if (run.acceptedInputBytes === null || run.acceptedInputBytes < frameRefresh.inputByteRange.endByte) {
            throw new AgentMuxError('CtxMux Input cursor precedes native refresh receipt.', 'AGENT_PROMPT_SUBMISSION_STATE_INVALID')
          }
        }
        const readyThroughByte = await this.deps.screenEvidence.wait(session, frameRefresh?.outputCursorBytes ?? run.latestOutputBytes, Boolean(frameRefresh), screen => {
          if (frameRefresh && screen.geometryRevision !== frameRefresh.resizeRevision) return false
          observation.context = provider.inspectPromptExecution?.(screen.snapshot()) ?? 'unavailable'
          preparationGeneration = this.deps.screenEvidence.generation(session.agentSessionId)
          return observation.context !== 'unavailable'
        }, { timeoutMs: 2_000, requireCompleteFrame: true,
          ...(frameRefresh ? { requireFrameAfterBoundary: true, checkpointFrameFence: {
            outputByte: frameRefresh.outputCursorBytes, resizeRevision: frameRefresh.resizeRevision } } : {}),
          timeoutMessage: 'Native immediate input context is unconfirmed.',
          terminalMessage: 'Agent Run exited before native immediate preparation.', ...(renderSignal ? { signal: renderSignal } : {}) })
        const context = observation.context
        const observed = await this.deps.registry.refresh(session.agentSessionId, session.run)
        // A busy native turn must be identified by the Provider's authenticated hook,
        // not by the visible timer or a previous turn's completion.
        const nativeEvidence = provider.readPromptExecutionEvidence ? await provider.readPromptExecutionEvidence(nativeContext) : undefined
        if (provider.verifyPromptExecutionTransport && transportEvidence?.sourceId !== nativeEvidence?.sourceId) {
          throw new AgentMuxError('Native execution source changed during transport authorization.', 'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED')
        }
        if (transportQualification) await verifyTransport(nativeEvidence?.sourceId, frameRefresh === undefined)
        const nativeTurnId = nativeEvidence?.nativeTurnId ?? observed.hookReceipt?.nativeTurnId
        if (context === 'interruptible' && (!nativeTurnId || (provider.readPromptExecutionEvidence
          ? nativeEvidence?.state !== 'working' : observed.hookReceipt?.lifecycleEvent === 'turn-end'))) {
          throw new AgentMuxError('The active native turn identity is unconfirmed.', 'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED')
        }
        if (context === 'idle' && (provider.readPromptExecutionEvidence
          ? !nativeEvidence || nativeEvidence.state === 'working'
          : !agentTurnEndBoundary(observed) && observed.terminalPromptReadiness?.source !== 'initial-composer')) {
          throw new AgentMuxError('The native idle boundary is unconfirmed.', 'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED')
        }
        preparation = { context: context as 'idle' | 'interruptible',
          ...(nativeTurnId ? { nativeTurnId } : {}),
          ...(nativeEvidence ? { nativeSourceId: nativeEvidence.sourceId, previousReceiptId: nativeEvidence.id } :
            observed.hookReceipt?.id ? { previousReceiptId: observed.hookReceipt.id } : {}),
          ...(context === 'idle' ? { readyThroughByte } : {}) }
      } catch (error) {
        const preclaim = transportQualification?.protocolInput?.preclaim
        if (!rejoiningOriginal && !inputAttempted && preclaim && !preclaim.claimStarted && error === preclaim.interruption) throw error
        await this.publishDeliveryDegrade(session, { state: 'unverified', mode: 'degraded',
          reason: 'immediate-context-unconfirmed', submissionId, run: { ...session.run }, observedAt: Date.now() })
        if (!rejoiningOriginal && !inputAttempted) throw promptPreparationFailure(error)
        throw new AgentMuxError('Immediate execution context is unconfirmed. This message is kept; ordinary input and the healthy Run remain available. Review native pending input or draft, then retry this exact message.',
          'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED', promptFailureCauseDetail(error), error instanceof AgentMuxError ? error.controlFailure : undefined)
      }
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
        Boolean(value.prepare) !== Boolean(plan.prepare) ||
        (value.prepare?.interrupt && (!plan.prepare ||
          value.prepare.interrupt.operationId !== terminalPromptPhaseOperationIdentity(session, submissionId, 'interrupt', plan.prepare.interrupt) ||
          value.prepare.interrupt.inputByteRange.endByte - value.prepare.interrupt.inputByteRange.startByte !== Buffer.byteLength(plan.prepare.interrupt) ||
          value.prepare.interrupt.inputByteRange.endByte !== value.payload.inputByteRange.startByte)) ||
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
      // A declared steer continues the active turn; it does not invent a turn-end fact.
      uncertainTurn = plan.prepare || nativeSteer ? false : assertTurnBoundary(stored, existing !== undefined || stored.promptCompletionAdmission !== undefined)
      if (plan.prepare && (preparationGeneration !== this.deps.screenEvidence.generation(session.agentSessionId) || !preparation || (!preparation.nativeSourceId && preparation.previousReceiptId !== stored.hookReceipt?.id))) {
        throw new AgentMuxError('Native context changed before immediate admission.', 'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED')
      }
      const interruptBytes = preparation?.context === 'interruptible' ? Buffer.byteLength(plan.prepare!.interrupt) : 0
      const interruptOperationId = interruptBytes ? terminalPromptPhaseOperationIdentity(session, submissionId, 'interrupt', plan.prepare!.interrupt) : undefined
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
        ...claimInput(stored, interruptOperationId ?? payloadOperationId, expectedByte, expectedByte + interruptBytes + payloadBytes + submitBytes, uncertainTurn),
        ...(readinessEvidence ? { terminalPromptReadiness: {
          ...readiness!, consumedBySubmissionId: submissionId
        } } : {}),
        terminalPromptSubmission: {
          run: { ...stored.run },
          submissionId,
          promptDigest,
          ...(readinessEvidence ? { readinessEvidence } : {}),
          outputCursorBytes,
          ...(preparation ? { prepare: { ...preparation,
            ...(interruptOperationId ? { interrupt: { operationId: interruptOperationId,
              inputByteRange: { startByte: expectedByte, endByte: expectedByte + interruptBytes }, acknowledged: false } } : {}) } } : {}),
          payload: {
            operationId: payloadOperationId,
            inputByteRange: {
              startByte: expectedByte + interruptBytes,
              endByte: expectedByte + interruptBytes + payloadBytes
            },
            acknowledged: false
          },
          submit: {
            operationId: submitOperationId,
            inputByteRange: {
              startByte: expectedByte + interruptBytes + payloadBytes,
              endByte: expectedByte + interruptBytes + payloadBytes + submitBytes
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
      phaseName: 'interrupt' | 'payload' | 'submit',
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
      const phase = phaseName === 'interrupt' ? submission.prepare?.interrupt : submission[phaseName]
      if (!phase) throw new AgentMuxError('The original preparation phase is missing.', 'AGENT_PROMPT_SUBMISSION_STATE_INVALID')
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
      if (phaseName === 'interrupt') {
        await this.deps.updateExactAgentSession(session.agentSessionId, session.run, stored => {
          const state = stored.terminalPromptSubmission
          if (!state?.prepare?.interrupt) throw new AgentMuxError('The original preparation phase disappeared.', 'AGENT_PROMPT_SUBMISSION_STATE_INVALID')
          assertSubmission(state)
          return { ...stored, terminalPromptSubmission: { ...state, prepare: { ...state.prepare,
            interrupt: { ...state.prepare.interrupt, acknowledged: true } } }, updatedAt: Math.max(stored.updatedAt, Date.now()) }
        })
        this.deps.agentInputCursors.set(session.agentSessionId, acceptedInputBytes)
        return
      }
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
    if (plan.prepare && submission.prepare &&
        (acceptedInputBytes === null || acceptedInputBytes < submission.payload.inputByteRange.endByte)) {
      const prepared = submission.prepare
      try {
        if (prepared.interrupt) await applyPhase('interrupt', plan.prepare.interrupt)
        let barrierReceiptId: string | undefined
        if (prepared.context === 'interruptible' && prepared.nativeSourceId && provider.readPromptExecutionEvidence) {
          const deadline = Date.now() + TERMINAL_PROMPT_RENDER_TIMEOUT_MS
          for (;;) {
            if (renderSignal?.aborted) throw agentMuxCancellationError('Immediate preparation observation was cancelled.', 'AGENT_PROMPT_READINESS_CANCELLED', renderSignal.reason)
            const observedSession = await this.deps.registry.refresh(session.agentSessionId, session.run)
            const evidence = await provider.readPromptExecutionEvidence({ ...nativeContext,
              ...(observedSession.nativeHandle ? { nativeHandle: observedSession.nativeHandle } : {}) })
            if (evidence && (evidence.sourceId !== prepared.nativeSourceId || evidence.nativeTurnId !== prepared.nativeTurnId)) {
              throw new AgentMuxError('The original native turn evidence changed.', 'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED')
            }
            if (evidence?.state === 'ended' && evidence.endReason === 'interrupted' && evidence.id !== prepared.previousReceiptId) {
              barrierReceiptId = evidence.id
              break
            }
            if (Date.now() >= deadline) throw new AgentMuxError('The exact native turn interruption is unconfirmed.', 'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED')
            await new Promise(resolve => setTimeout(resolve, 50))
          }
        }
        const readyThroughByte = await this.deps.screenEvidence.wait(session, submission.outputCursorBytes,
          prepared.context === 'interruptible', screen => {
            const observed = this.deps.requireAgentSession(session.agentSessionId)
            const refresh = observed.promptCompletionAdmission?.frameRefresh
            if (refresh && screen.geometryRevision !== refresh.resizeRevision) return false
            preparationGeneration = this.deps.screenEvidence.generation(session.agentSessionId)
            const receipt = observed.hookReceipt
            if (prepared.context === 'interruptible' && !prepared.nativeSourceId) {
              if (!receipt || receipt.id === prepared.previousReceiptId || receipt.eventName !== plan.prepare!.endEvent ||
                  receipt.nativeTurnId !== prepared.nativeTurnId || receipt.lifecycleEvent !== 'turn-end' ||
                  receipt.run.runId !== session.run.runId) return false
              barrierReceiptId = receipt.id
            }
            return provider.inspectPromptExecution?.(screen.snapshot()) === 'idle'
          }, { timeoutMs: TERMINAL_PROMPT_RENDER_TIMEOUT_MS, requireCompleteFrame: true,
            ...(current.promptCompletionAdmission?.frameRefresh ? { checkpointFrameFence: {
              outputByte: submission.outputCursorBytes,
              resizeRevision: current.promptCompletionAdmission.frameRefresh.resizeRevision } } : {}),
            ...(prepared.context === 'interruptible' ? { requireFrameAfterBoundary: true } : {}),
            timeoutMessage: 'Native interruption or empty composer is unconfirmed.',
            terminalMessage: 'Agent Run exited before immediate input was prepared.', ...(renderSignal ? { signal: renderSignal } : {}) })
        await this.deps.updateExactAgentSession(session.agentSessionId, session.run, stored => {
          const state = stored.terminalPromptSubmission
          if (!state?.prepare) throw new AgentMuxError('The original preparation phase disappeared.', 'AGENT_PROMPT_SUBMISSION_STATE_INVALID')
          assertSubmission(state)
          if (preparationGeneration !== this.deps.screenEvidence.generation(session.agentSessionId)) {
            throw new AgentMuxError('Native screen geometry changed after interruption.', 'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED')
          }
          return { ...stored, terminalPromptSubmission: { ...state, outputCursorBytes: readyThroughByte,
            prepare: { ...state.prepare, readyThroughByte, ...(barrierReceiptId ? { barrierReceiptId } : {}) } },
            updatedAt: Math.max(stored.updatedAt, Date.now()) }
        })
      } catch (error) {
        await this.publishDeliveryDegrade(session, { state: 'unverified', mode: 'degraded',
          reason: 'immediate-context-unconfirmed', submissionId, run: { ...session.run }, observedAt: Date.now() })
        throw new AgentMuxError('Native immediate preparation is unconfirmed. The original message and Run are kept; do not resend it as ordinary input. The terminal remains available.',
          'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED', promptFailureCauseDetail(error), error instanceof AgentMuxError ? error.controlFailure : undefined)
      }
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
    phaseName?: 'refresh' | 'interrupt' | 'payload' | 'submit'
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
            if (phaseName === 'refresh' && admission.frameRefresh?.operationId === operation.operationId) {
              return { ...current, promptCompletionAdmission: { ...admission, notApplied: true,
                frameRefresh: { ...admission.frameRefresh, notApplied: true } }, updatedAt: Math.max(current.updatedAt, Date.now()) }
            }
            if (phaseName === 'submit' && error instanceof AgentMuxError && error.code === 'CTXMUX_input_cursor_mismatch' &&
              submission?.submissionId === submissionId && submission.submit.operationId === operation.operationId &&
              submission.submit.inputByteRange.startByte === operation.expectedByte) {
              // Reaching submit requires the original payload's ACK. Persist its receipt
              // together with the terminal rejection, without calling the whole prompt unapplied.
              return { ...current, terminalPromptSubmission: { ...submission,
                payload: { ...submission.payload, acknowledged: true },
                submit: { ...submission.submit, notApplied: true } }, updatedAt: Math.max(current.updatedAt, Date.now()) }
            }
            if (phaseName === 'interrupt' && submission?.prepare?.interrupt?.operationId === operation.operationId) {
              return { ...current, promptCompletionAdmission: { ...admission, notApplied: true },
                terminalPromptSubmission: { ...submission, prepare: { ...submission.prepare,
                  interrupt: { ...submission.prepare.interrupt, notApplied: true } } }, updatedAt: Math.max(current.updatedAt, Date.now()) }
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
