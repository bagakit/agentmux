import { matchesProviderNativeSessionTarget } from './agent-native-locator.js'
import type { AgentMuxAgentSession } from './types.js'
import type { AgentMuxStoredAgentSession } from './types.js'
import type { AgentInputSavedEnvironment } from './agent-input-wait.js'
import { readContinuityExecutor } from './agent-session-recovery/executor.js'

/** Original Runs connected to this exact writer by unambiguous semantic resume receipts. */
export function sessionSemanticResumeSourceRuns(session: AgentMuxAgentSession): readonly string[] {
  const runs = [session.run.runId]
  const seen = new Set(runs)
  if ((session.nativeBinding?.source !== 'semantic-resume-target' && session.nativeBinding?.source !== 'user-selected') || session.nativeBinding.run.runId !== session.run.runId ||
      session.nativeHandle?.kind !== 'provider' || session.nativeHandle.providerId !== session.providerId) return runs
  const operations = new Map(Object.entries(session.continuityOperations ?? {}))
  if (session.continuity && !operations.has(session.continuity.operationId)) operations.set(session.continuity.operationId, session.continuity)
  const byRun = new Map<string, NonNullable<AgentMuxAgentSession['continuity']>[]>()
  for (const operation of operations.values()) {
    if (operation.kind !== 'resumed' || operation.agentSessionId !== session.agentSessionId || !operation.newRun) continue
    const incoming = byRun.get(operation.newRun.runId) ?? []
    incoming.push(operation); byRun.set(operation.newRun.runId, incoming)
  }
  for (let current = session.run.runId; ;) {
    const incoming = byRun.get(current)
    // Ambiguous or missing authoritative links never borrow a retiredRuns/display association.
    if (incoming?.length !== 1) break
    const operation = incoming[0]!
    if (!operation || !matchesProviderNativeSessionTarget(operation.nativeTarget, session.nativeHandle) ||
        seen.has(operation.previousRun.runId)) break
    runs.push(operation.previousRun.runId); seen.add(operation.previousRun.runId); current = operation.previousRun.runId
  }
  return runs
}

/** Reconstruct only the environment witnessed by successful original lifecycle
 * roots. Today's native handle or retiredRuns alone cannot supply old facts. */
export function originalInputResumeEnvironment(session: AgentMuxStoredAgentSession, originalRunId: string):
  { environment: AgentInputSavedEnvironment; runs: readonly string[] } | undefined {
  const runs = sessionSemanticResumeSourceRuns(session), end = runs.indexOf(originalRunId)
  if (end < 1) return undefined
  const operations = new Map(Object.entries(session.continuityOperations ?? {}))
  if (session.continuity && !operations.has(session.continuity.operationId)) operations.set(session.continuity.operationId, session.continuity)
  let environment: AgentInputSavedEnvironment | undefined
  for (let index = 0; index < end; index++) {
    const links = [...operations.values()].filter(operation => operation.kind === 'resumed' && operation.agentSessionId === session.agentSessionId &&
      operation.newRun?.runId === runs[index] && operation.previousRun.runId === runs[index + 1])
    if (links.length !== 1 || !links[0]!.nativeTarget) return undefined
    const link = links[0]!
    let executor
    try { executor = readContinuityExecutor(session.continuityExecutors, link.intentOperationId ?? link.operationId) }
    catch { return undefined }
    if (!executor || executor.providerId !== link.nativeTarget!.providerId || executor.providerId !== session.providerId || executor.executorId !== session.executorId) return undefined
    environment = { providerId: executor.providerId, executorId: executor.executorId, nativeHandle: structuredClone(link.nativeTarget!) }
  }
  return environment ? { environment, runs: runs.slice(0, end + 1) } : undefined
}
