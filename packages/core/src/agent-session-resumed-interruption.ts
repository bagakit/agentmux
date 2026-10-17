import { isDeepStrictEqual } from 'node:util'
import { matchesProviderNativeSessionTarget } from './agent-native-locator.js'
import { createContinuityInputDelivery } from './agent-session-continuity-input.js'
import { DEFAULT_AGENT_CONTINUITY_CONTINUATION, type AgentMuxContinuityOperation } from './agent-session-continuity.js'
import type { AgentProvider } from './agent-provider.js'
import type { AgentMuxStoredAgentSession } from './types.js'
import type { CtxmuxAdapterRun } from './ctxmux-run-adapter.js'
import { observePromptInput } from './prompt-submission.js'

/** Only the original native resume can refine its frozen old turn. No scheduler or input writer. */
export async function observeResumedTurnInterruption(session: AgentMuxStoredAgentSession, deps: {
  provider: AgentProvider
  signal: AbortSignal
  status(): Promise<CtxmuxAdapterRun>
  save(change: (current: AgentMuxStoredAgentSession) => AgentMuxStoredAgentSession): Promise<AgentMuxStoredAgentSession>
}): Promise<AgentMuxStoredAgentSession> {
  const active = Object.values(session.continuityOperations ?? {}).find(op => op.kind === 'resumed' && op.newRun?.runId === session.run.runId)
  const rootId = active?.intentOperationId ?? active?.operationId
  const root = rootId ? session.continuityOperations?.[rootId] : undefined, old = root?.interruption
  if (!active || !root || root.action === 'restart' || root.trigger === 'input' || active.recoveryDelivery || active.resumedInterruption ||
      root.supervision?.phase === 'cancelled' || !old || !['unknown', 'interrupted'].includes(old.state) ||
      !active.resumedInputBoundary || active.resumedInputBoundary.superseded || session.promptCompletionAdmission ||
      !matchesProviderNativeSessionTarget(root.nativeTarget, session.nativeHandle) || session.nativeSourceObservation ||
      old.nativeTurnId && session.semanticStatus?.nativeTurnId && session.semanticStatus.nativeTurnId !== old.nativeTurnId) return session
  const needsRead = old.state === 'unknown'
  if (needsRead && (!session.nativeActor || !deps.provider.readResumedTurnInterruption || old.support !== 'provider' ||
      !old.nativeSourceId || !old.nativeTurnId || !old.evidenceId)) return session
  const related = (op: AgentMuxContinuityOperation) => (op.intentOperationId ?? op.operationId) === rootId
  const blocks = (op: AgentMuxContinuityOperation) => related(op) && (op.resumedInputBoundary?.superseded || op.recoveryDelivery &&
    (op.recoveryDelivery.dispatchOwner !== undefined || op.newRun?.runId === session.run.runId ||
      op.recoveryDelivery.phase !== 'waiting' && !(op.recoveryDelivery.phase === 'superseded' &&
        op.recoveryDelivery.reason === 'original-run-ended-before-input-claim')))
  if (Object.values(session.continuityOperations ?? {}).some(blocks)) return session
  const before = await deps.status()
  if (before.state.type !== 'running' || before.pid === null || before.runId !== session.run.runId) return session
  const evidence = needsRead ? await observePromptInput(deps.signal, () => deps.provider.readResumedTurnInterruption!({
    processId: before.pid!, nativeActor: session.nativeActor!, workspacePath: session.workspacePath, nativeHandle: old.nativeTarget,
    previousTurn: { sourceId: old.nativeSourceId!, id: old.evidenceId!, nativeTurnId: old.nativeTurnId!, state: 'working',
      ...(old.nativeObservedAt === undefined ? {} : { observedAt: old.nativeObservedAt }) }, signal: deps.signal
  })) : { state: 'ended', endReason: 'interrupted', sourceId: old.nativeSourceId, nativeTurnId: old.nativeTurnId, id: old.evidenceId }
  if (!evidence || evidence.state !== 'ended' || evidence.sourceId !== old.nativeSourceId || evidence.nativeTurnId !== old.nativeTurnId ||
      (needsRead && !evidence.id) || !['interrupted', 'completed', 'failed'].includes(evidence.endReason ?? '')) return session
  const after = await deps.status()
  if (after.state.type !== 'running' || after.pid !== before.pid || after.runId !== before.runId) return session
  const state = evidence.endReason === 'interrupted' ? 'interrupted' as const : 'not-interrupted' as const
  return await deps.save(current => {
    const operation = current.continuityOperations?.[active.operationId], originalRoot = current.continuityOperations?.[root.operationId]
    if (current.run.runId !== after.runId || !operation || operation.resumedInterruption || operation.recoveryDelivery ||
        !isDeepStrictEqual(originalRoot?.interruption, old) || originalRoot?.supervision?.phase === 'cancelled' ||
        !matchesProviderNativeSessionTarget(root.nativeTarget, current.nativeHandle) || !isDeepStrictEqual(current.nativeActor, session.nativeActor) || current.nativeSourceObservation ||
        current.promptCompletionAdmission || operation.resumedInputBoundary?.superseded ||
        old.nativeTurnId && current.semanticStatus?.nativeTurnId && current.semanticStatus.nativeTurnId !== old.nativeTurnId ||
        Object.values(current.continuityOperations ?? {}).some(blocks)) return current
    const boundary = operation.resumedInputBoundary
    if (!boundary) return current
    let knownByte = boundary.protocolInput?.endByte ?? boundary.initialInputByte
    const handshake = current.terminalHandshake
    if (handshake?.acknowledged && handshake.run.runId === current.run.runId && handshake.inputByteRange.startByte === knownByte) knownByte = handshake.inputByteRange.endByte
    // Never adopt the current cursor: it can contain an unrecorded human input.
    if (after.acceptedInputBytes !== knownByte) return current
    const observedAt = Date.now()
    const resolved: AgentMuxContinuityOperation = { ...operation, resumedInterruption: { ...old, state, run: { ...current.run },
      rootOperationId: root.operationId, observedAt, ...(evidence.id ? { evidenceId: evidence.id } : {}),
      reason: needsRead ? state === 'interrupted' ? 'resumed-original-turn-interrupted' : 'resumed-original-turn-not-interrupted' : old.reason } }
    const operations = { ...current.continuityOperations }
    if (state === 'interrupted' && root.policy.continuationEnabled) {
      // An older waiting plan has never claimed input. Its exact packet remains, superseded,
      // while this successful attempt alone acquires a fresh Run-bound delivery.
      for (const prior of Object.values(operations)) if (related(prior) && prior.recoveryDelivery?.phase === 'waiting') {
        operations[prior.operationId] = { ...prior, recoveryDelivery: { ...prior.recoveryDelivery, phase: 'superseded', reason: 'original-run-ended-before-input-claim', observedAt } }
      }
      resolved.interruptedWorking = true
      resolved.recoveryInputs = { reminder: '', continuation: DEFAULT_AGENT_CONTINUITY_CONTINUATION }
      const delivery = createContinuityInputDelivery(resolved, boundary.initialInputByte)
      if (delivery) resolved.recoveryDelivery = delivery
      if (resolved.recoveryDelivery && boundary.protocolInput) resolved.recoveryDelivery.protocolInput = structuredClone(boundary.protocolInput)
    }
    operations[resolved.operationId] = resolved
    return { ...current, updatedAt: Math.max(current.updatedAt + 1, observedAt), continuityOperations: operations,
      ...(current.continuity?.operationId === resolved.operationId ? { continuity: resolved } : {}) }
  })
}
