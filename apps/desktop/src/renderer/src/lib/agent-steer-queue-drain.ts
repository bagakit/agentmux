import type { AgentMuxRunState } from '@agentmux/core'

// Store delivery and Composer affordances share the same Run viability fact.
// Provider readiness is owned by Core; a pending interaction only pauses local attempts.
const QUEUE_DRAINABLE_BY_RUN_STATE: Record<AgentMuxRunState, boolean> = {
  running: true,
  exited: false,
  interrupted: false
}

export function steerQueueCanEverDrain(processState: AgentMuxRunState): boolean {
  return QUEUE_DRAINABLE_BY_RUN_STATE[processState]
}

export function steerQueueCanDrainNow(
  session: { processState: AgentMuxRunState; pendingInteraction?: unknown }
): boolean {
  return steerQueueCanEverDrain(session.processState) && !session.pendingInteraction
}

// Semantic resume preserves Session identity but replaces the Run. Retain old messages for
// copying/removal; never silently replay their intent into the new Run.
export function steerEntryTargetsRun(entry: { runId: string }, runId: string): boolean {
  return entry.runId === runId
}
