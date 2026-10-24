import { matchesProviderNativeSessionTarget } from './agent-native-locator.js'
import type { AgentMuxAgentSession } from './types.js'

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
