import { parseMoteMainRolloverDecision, type MoteMainRolloverDecision } from '@agentmux/core/mote-dialogue'
import { sameMotePreferencesTarget } from '@agentmux/core/mote-preferences'
import type { AgentSteerQueueEntry } from '../store'

/** Only the original typed Core reply crosses this IPC boundary. Display text is irrelevant. */
export function originalMoteRollover(error: unknown, entry: AgentSteerQueueEntry, control: { hostId: string | null; agentSessionId: string }): MoteMainRolloverDecision | null {
  if (!control.hostId || !entry.moteMain || !error || typeof error !== 'object' || !('moteMainRollover' in error)) return null
  let decision: MoteMainRolloverDecision
  try { decision = parseMoteMainRolloverDecision(error.moteMainRollover) } catch { return null }
  if (decision.queryOperationId !== entry.operationId || decision.expectedRoleRevision !== entry.moteMain.expectedRoleRevision ||
    !sameMotePreferencesTarget(decision.target, entry.moteMain.target) || decision.reference.sessionId !== control.agentSessionId ||
    decision.reference.hostId !== control.hostId) return null
  return decision
}
