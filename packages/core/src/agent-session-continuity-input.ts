import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError } from './errors.js'
import { agentPromptNotApplied } from './agent-prompt-condition.js'
import type { AgentPromptInputKey } from './agent-prompt-condition.js'
import type { AgentInputCallContext } from './agent-input-wait.js'
import type { AgentMuxContinuityInputDelivery, AgentMuxContinuityOperation } from './agent-session-continuity.js'
import type { AgentMuxAgentPromptInput } from './client.js'
import type { AgentMuxStoredAgentSession, AgentPromptSubmissionRecord } from './types.js'
import type { AgentProviderRegistry } from './agent-provider.js'
import type { CtxmuxAdapterRun } from './ctxmux-run-adapter.js'
import { composeAgentPrompt } from './agent-outbound-message.js'
import { observePromptInput } from './prompt-submission.js'

const digest = (text: string) => createHash('sha256').update(text).digest('base64url')
const terminal = (phase: AgentMuxContinuityInputDelivery['phase']) => ['accepted', 'not-applied', 'superseded'].includes(phase)

/** Called by the Run lifecycle commit, before another input can claim this Run. */
export function createContinuityInputDelivery(operation: AgentMuxContinuityOperation, initialInputByte?: number): AgentMuxContinuityInputDelivery | undefined {
  if (operation.trigger === 'input' || !operation.interruptedWorking || !operation.newRun || !operation.nativeTarget) return
  const inputs = operation.recoveryInputs
  if (!inputs?.reminder.trim() && !inputs?.continuation.trim()) return
  const previousInput = operation.previousInput ?? { scope: 'typed-prompt' as const, outcome: 'unknown' as const }
  const reminder = inputs.reminder.trim() ? `Session recovery context:\nAgent Session: ${operation.agentSessionId}\nPrevious Run: ${operation.previousRun.runId}\nRecovered Run: ${operation.newRun.runId}\nProvider native Session: ${operation.nativeTarget.providerId}/${operation.nativeTarget.sessionId}\nInterrupted activity: working.\nRecovery evidence: ${operation.evidence.kind}\nPrevious typed input: ${previousInput.outcome}${previousInput.key ? ' (' + JSON.stringify(previousInput.key) + ')' : ''}. Unknown earlier input is not replayed.\n\n${inputs.reminder}` : ''
  const part = (text: string) => ({ selected: Boolean(text.trim()), status: text.trim() ? 'waiting' as const : 'not-selected' as const, text, digest: digest(text) })
  return {
    context: { agentSessionId: operation.agentSessionId, previousRun: { ...operation.previousRun }, newRun: { ...operation.newRun },
      nativeTarget: structuredClone(operation.nativeTarget), interruptedWorking: true, runEvidence: structuredClone(operation.evidence), previousInput: structuredClone(previousInput) },
    key: { kind: 'prompt', agentSessionId: operation.agentSessionId, expectedRun: { ...operation.newRun },
      submissionId: 'continuity-' + digest(JSON.stringify([operation.agentSessionId, operation.operationId, operation.newRun])) },
    ...(initialInputByte === undefined ? {} : { initialInputByte }),
    phase: 'waiting', reason: 'native-input-observation-pending', observedAt: Date.now(),
    reminder: part(reminder), continuation: part(inputs.continuation)
  }
}

type Dependencies = {
  providers: AgentProviderRegistry
  read(id: string): AgentMuxStoredAgentSession
  status(session: AgentMuxStoredAgentSession): Promise<CtxmuxAdapterRun>
  update(id: string, operationId: string, update: (delivery: AgentMuxContinuityInputDelivery) => void): Promise<void>
  inspect(key: AgentPromptInputKey): Promise<AgentPromptSubmissionRecord | null>
  submit(input: AgentMuxAgentPromptInput, context: AgentInputCallContext): Promise<unknown>
  failed(id: string, error: unknown): void
}

/** The original Session owns both the plan and its receipt. This observer never retries Input. */
export class AgentSessionContinuityInputs {
  private readonly controller = new AbortController()
  private readonly owner = randomUUID()
  private readonly saves = new Set<Promise<void>>()
  private readonly operations = new Map<string, Set<string>>()
  private readonly tails = new Map<string, { pending: Promise<void>; again: boolean }>()
  private readonly facts = new Map<string, string>()
  constructor(private readonly deps: Dependencies) {}

  restore(sessions: readonly AgentMuxStoredAgentSession[]): void {
    for (const session of sessions) this.track(session)
  }

  track(session: AgentMuxStoredAgentSession): void {
    for (const operation of Object.values(session.continuityOperations ?? {})) {
      if (!operation.recoveryDelivery || terminal(operation.recoveryDelivery.phase)) continue
      const operations = this.operations.get(session.agentSessionId) ?? new Set<string>()
      operations.add(operation.operationId); this.operations.set(session.agentSessionId, operations)
    }
    this.wake(session.agentSessionId)
  }

  /** Low-frequency, related Session facts only. Ordinary output and our own receipt saves do not wake it. */
  observe(session: AgentMuxStoredAgentSession): void {
    if (!this.operations.has(session.agentSessionId)) return
    const facts = JSON.stringify([session.run, session.nativeHandle, session.semanticStatus, session.nativeSourceObservation,
      session.promptCompletionAdmission, session.terminalPromptSubmission, session.terminalHandshake, session.pendingInteraction])
    if (facts === this.facts.get(session.agentSessionId)) return
    this.facts.set(session.agentSessionId, facts); this.wake(session.agentSessionId)
  }

  /** Explicit new terminal input supersedes only not-yet-dispatched automatic work. */
  async userInput(id: string, runId: string): Promise<void> {
    if (this.controller.signal.aborted) return
    for (const operationId of this.operations.get(id) ?? []) {
      const operation = this.deps.read(id).continuityOperations?.[operationId]
      const delivery = operation?.recoveryDelivery
      if (delivery?.phase === 'waiting' && delivery.key.expectedRun.runId === runId) {
        await this.phase(id, operationId, 'superseded', 'new-user-input-has-priority')
      }
    }
  }

  /** Credit only a real protocol ACK which immediately follows this plan's known boundary. */
  async protocolAccepted(id: string, runId: string, protocolOperationId: string, range: { startByte: number; endByte: number }): Promise<void> {
    if (this.controller.signal.aborted) return
    for (const operationId of this.operations.get(id) ?? []) {
      const operation = this.deps.read(id).continuityOperations?.[operationId]
      const delivery = operation?.recoveryDelivery
      if (!delivery || delivery.phase !== 'waiting' || delivery.key.expectedRun.runId !== runId ||
        range.startByte !== this.inputByte(this.deps.read(id), delivery)) continue
      await this.save(id, operationId, value => {
        if (value.phase === 'waiting' && range.startByte === this.inputByte(this.deps.read(id), value)) value.protocolInput = { operationId: protocolOperationId, ...range }
      })
    }
    this.wake(id)
  }

  private inputByte(session: AgentMuxStoredAgentSession, delivery: AgentMuxContinuityInputDelivery): number | undefined {
    const start = delivery.protocolInput?.endByte ?? delivery.initialInputByte, handshake = session.terminalHandshake
    return handshake?.acknowledged && handshake.run.runId === delivery.key.expectedRun.runId && handshake.inputByteRange.startByte === start
      ? handshake.inputByteRange.endByte : start
  }

  async dispose(): Promise<void> {
    this.controller.abort(); this.operations.clear(); this.facts.clear()
    // Only already-issued local persistence is joined. Native observations and turns are cancelled, never awaited.
    await Promise.allSettled([...this.saves])
  }

  private async save(id: string, operationId: string, update: (value: AgentMuxContinuityInputDelivery) => void): Promise<void> {
    if (this.controller.signal.aborted) return
    const saving = this.deps.update(id, operationId, update)
    this.saves.add(saving)
    try { await saving } finally { this.saves.delete(saving) }
  }

  private wake(id: string): void {
    if (this.controller.signal.aborted || !this.operations.has(id)) return
    const active = this.tails.get(id)
    if (active) { active.again = true; return }
    const work = { pending: Promise.resolve(), again: false }
    work.pending = Promise.resolve().then(async () => {
      do {
        work.again = false
        for (const operationId of this.operations.get(id) ?? []) {
          if (this.controller.signal.aborted) return
          try { await this.advance(id, operationId) }
          catch (error) { if (!this.controller.signal.aborted) this.deps.failed(id, error) }
        }
      } while (work.again && !this.controller.signal.aborted)
    }).finally(() => { if (this.tails.get(id) === work) this.tails.delete(id) })
    this.tails.set(id, work)
  }

  private async phase(id: string, operationId: string, phase: AgentMuxContinuityInputDelivery['phase'], reason: string,
    receipt?: AgentMuxContinuityInputDelivery['receipt']): Promise<void> {
    const existing = this.deps.read(id).continuityOperations?.[operationId]?.recoveryDelivery
    if (phase !== 'dispatching' && existing?.phase === phase && existing.reason === reason && (!receipt || existing.receipt?.status === receipt.status)) return
    let changed = false
    await this.save(id, operationId, value => {
      if (phase === 'dispatching') {
        if (value.phase !== 'waiting') throw new AgentMuxError('The original recovery input was already claimed. Inspect its exact key.', 'CONTINUITY_INPUT_ALREADY_DISPATCHED')
        value.dispatchOwner = this.owner
      }
      if (terminal(value.phase) && value.phase !== phase) return
      changed = value.phase !== phase || value.reason !== reason
      value.phase = phase; value.reason = reason; value.observedAt = Date.now()
      if (receipt) value.receipt = receipt
      for (const part of [value.reminder, value.continuation]) if (part.selected) {
        part.status = phase
        if (receipt) part.receiptRef = structuredClone(receipt.key)
      }
    })
    if (changed && ['waiting', 'unknown', 'not-applied'].includes(phase)) this.deps.failed(id, new AgentMuxError(reason, 'CONTINUITY_INPUT_UNCONFIRMED'))
    if (terminal(phase)) {
      this.operations.get(id)?.delete(operationId)
      if (!this.operations.get(id)?.size) this.operations.delete(id)
    }
  }

  private async receipt(id: string, operationId: string, delivery: AgentMuxContinuityInputDelivery): Promise<boolean> {
    const record = await this.deps.inspect(delivery.key)
    if (this.controller.signal.aborted) return true
    if (!record) return false
    const claim = record.admission
    const composed = composeAgentPrompt(delivery.continuation.text, delivery.reminder.selected ? delivery.reminder.text : undefined)
    if (!claim?.intent || !isDeepStrictEqual(claim.inputKey, delivery.key) || record.run.runId !== delivery.key.expectedRun.runId ||
      claim.intent.prompt !== composed.text || claim.intent.message?.userContent !== (delivery.continuation.text.trim() ? delivery.continuation.text : undefined) ||
      claim.intent.message?.systemContext !== composed.systemContext) {
      await this.phase(id, operationId, 'unknown', 'The original input key has conflicting content. Keep this plan and inspect the original receipt.')
      return true
    }
    const accepted = claim?.acknowledged && (claim.transport !== 'native' || claim.native.outcome === 'admitted')
    const notApplied = claim && agentPromptNotApplied({ run: record.run, promptCompletionAdmission: claim,
      ...(record.terminalPromptSubmission ? { terminalPromptSubmission: record.terminalPromptSubmission } : {}) })
    const phase = accepted ? 'accepted' : notApplied ? 'not-applied' : 'unknown'
    await this.phase(id, operationId, phase, accepted ? 'original-input-delivery-confirmed' : notApplied ? 'original-input-not-applied' : 'original-input-delivery-unconfirmed', {
      key: structuredClone(delivery.key), status: accepted ? claim.transport === 'native' ? 'native-admitted' : 'terminal-confirmed' : notApplied ? 'not-applied' : 'unknown', observedAt: Date.now()
    })
    return true
  }

  private async qualify(id: string, operationId: string, delivery: AgentMuxContinuityInputDelivery, claimed = false): Promise<void> {
    this.controller.signal.throwIfAborted()
    const session = this.deps.read(id), operation = session.continuityOperations?.[operationId]
    if (!operation?.newRun || !operation.nativeTarget || operation.kind !== 'resumed' || !operation.interruptedWorking || operation.trigger === 'input' ||
      !isDeepStrictEqual(operation.recoveryDelivery?.key, delivery.key) || operation.recoveryDelivery?.phase === 'superseded' || session.run.runId !== delivery.key.expectedRun.runId ||
      !isDeepStrictEqual(session.nativeHandle, operation.nativeTarget)) throw new AgentMuxError('The original recovery input target changed. Its text and key are kept.', 'CONTINUITY_INPUT_SUPERSEDED')
    const phase = operation.recoveryDelivery?.phase
    if (claimed ? !['dispatching', 'unknown'].includes(phase ?? '') || operation.recoveryDelivery?.dispatchOwner !== this.owner : phase !== 'waiting') {
      throw new AgentMuxError('The original recovery input is already owned. Only its exact receipt may be observed.', 'CONTINUITY_INPUT_ALREADY_DISPATCHED')
    }
    const run = await this.deps.status(session)
    if (run.state.type !== 'running') throw new AgentMuxError('The recovered Run is not confirmed running. Keep the original recovery input.', 'CONTINUITY_INPUT_UNCONFIRMED')
    const ownClaim = claimed && session.promptCompletionAdmission?.submissionId === delivery.key.submissionId
    if (!ownClaim) {
      if (session.promptCompletionAdmission !== undefined) throw new AgentMuxError('A newer input has priority over automatic recovery input.', 'CONTINUITY_INPUT_SUPERSEDED')
      const inputByte = this.inputByte(session, delivery)
      if (inputByte === undefined || run.acceptedInputBytes === null) throw new AgentMuxError('The original input boundary is unknown.', 'CONTINUITY_INPUT_UNCONFIRMED')
      if (run.acceptedInputBytes !== inputByte) throw new AgentMuxError('The original input boundary changed; its source is unconfirmed.', 'CONTINUITY_INPUT_UNCONFIRMED')
      const provider = this.deps.providers.get(session.providerId)
      if (!provider.readPromptExecutionEvidence || !provider.verifyPromptExecutionTransport) throw new AgentMuxError('Provider native input evidence is unavailable. Ordinary input remains available.', 'CONTINUITY_INPUT_UNCONFIRMED')
      const context = { args: run.args, workspacePath: session.workspacePath, signal: this.controller.signal,
        ...(run.pid === null ? {} : { processId: run.pid }), nativeHandle: operation.nativeTarget,
        ...(session.nativePromptPredecessor ? { nativePromptPredecessor: session.nativePromptPredecessor } : {}) }
      const evidence = await observePromptInput(this.controller.signal, () => provider.readPromptExecutionEvidence!(context))
      if (!evidence || evidence.state === 'working' || !await observePromptInput(this.controller.signal,
        () => provider.verifyPromptExecutionTransport!({ ...context, nativeSourceId: evidence.sourceId }))) throw new AgentMuxError('Native idle input transport is unconfirmed. The original input is retained.', 'CONTINUITY_INPUT_UNCONFIRMED')
      const current = await this.deps.status(this.deps.read(id))
      if (current.pid !== run.pid || current.acceptedInputBytes !== inputByte || current.state.type !== 'running') throw new AgentMuxError('Native input changed during recovery observation.', 'CONTINUITY_INPUT_UNCONFIRMED')
    }
  }

  private async advance(id: string, operationId: string): Promise<void> {
    const operation = this.deps.read(id).continuityOperations?.[operationId], delivery = operation?.recoveryDelivery
    if (!delivery || terminal(delivery.phase)) { this.operations.get(id)?.delete(operationId); return }
    if (await this.receipt(id, operationId, delivery)) return
    // No receipt is not proof of non-application after a possibly executing call.
    if (delivery.phase !== 'waiting') {
      await this.phase(id, operationId, 'unknown', 'original-input-delivery-unconfirmed'); return
    }
    try {
      await this.qualify(id, operationId, delivery)
      await this.phase(id, operationId, 'dispatching', 'original-input-dispatching')
      await this.deps.submit({ agentSessionId: id, expectedRun: delivery.key.expectedRun, afterSubmissionId: null,
        operationId: delivery.key.submissionId, prompt: delivery.continuation.text, signal: this.controller.signal,
        ...(delivery.reminder.selected ? { agentMuxNote: delivery.reminder.text } : {}) }, {
        requestSignal: this.controller.signal, assertCurrent: () => this.qualify(id, operationId, delivery, true)
      })
      if (!await this.receipt(id, operationId, delivery)) await this.phase(id, operationId, 'unknown', 'original-input-receipt-unconfirmed')
    } catch (error) {
      if (this.controller.signal.aborted) return
      if (await this.receipt(id, operationId, delivery)) return
      const phase = error instanceof AgentMuxError && error.code === 'CONTINUITY_INPUT_SUPERSEDED' ? 'superseded'
        : this.deps.read(id).continuityOperations?.[operationId]?.recoveryDelivery?.phase === 'waiting' ? 'waiting' : 'unknown'
      await this.phase(id, operationId, phase, error instanceof Error ? error.message : String(error))
    }
  }
}
