import type { SessionSnapshot } from '../../../shared/contracts'
import { isAgentActivityStatusSource, semanticStatusStale } from '@agentmux/core/agent-status'

/** Only the current Core semantic fact can prove when the displayed state began. */
export function agentStateEnteredAt(session: SessionSnapshot, now: number): number | undefined {
  if (session.kind !== 'agent' || session.processState !== 'running' || !Number.isFinite(now)) return undefined
  const { control, semanticStatus: semantic, status } = session
  // The accepted Session snapshot owns this raw fact's Run binding. Never borrow it
  // across a mismatched control identity or attribute it to a process-only display.
  if (control.kind !== 'agent' || control.hostId !== session.hostId ||
      control.agentSessionId !== session.id || !control.run.runId ||
      status.state === 'starting' || status.state === 'running' ||
      status.state === 'disconnected' || status.state === 'exited') return undefined
  if (!semantic || !isAgentActivityStatusSource(semantic.source) ||
      semantic.state !== status.state || semantic.source !== status.source ||
      semantic.observedAt !== status.observedAt || semanticStatusStale(semantic, now)) return undefined
  const enteredAt = semantic.stateEnteredAt
  if (enteredAt === undefined || !Number.isSafeInteger(enteredAt) || enteredAt < 0 ||
      !Number.isSafeInteger(semantic.observedAt) || enteredAt > semantic.observedAt ||
      semantic.observedAt > now) return undefined
  return enteredAt
}
