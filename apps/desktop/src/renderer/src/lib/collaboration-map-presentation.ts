import type { SessionSnapshot } from '../../../shared/contracts'
import { focusActivityEntryTime, focusBucketForSession } from './focus-context'
import { observeAgentSession } from './agent-observation'
import type { CollaborationAgent } from './agent-collaboration'

/** Original activity facts choose visual weight; no activity is inferred from map use or output. */
export function collaborationAgentPresentation(session: Extract<SessionSnapshot, { kind: 'agent' }>, name?: string): Pick<CollaborationAgent, 'name' | 'tier' | 'lastActivityAt'> {
  const bucket = focusBucketForSession(session, false)
  const tier = session.processState === 'exited' && !session.runUnobserved ? 'closed'
    : bucket === 'working' || bucket === 'attention' ? 'active'
      : session.processState === 'running' && observeAgentSession(session, Date.now()).semantic === 'idle' ? 'idle' : 'unknown'
  return { name: name ?? session.label, tier, lastActivityAt: focusActivityEntryTime(session) ?? null }
}
export function collaborationNodeSize(tier: CollaborationAgent['tier']) {
  return tier === 'closed' ? { width: 24, height: 24 } : tier === 'idle' || tier === 'unknown' ? { width: 154, height: 38 } : { width: 250, height: 94 }
}
/** Recency changes ink and the point inside its stable hit box, never layout geometry. */
export function collaborationRecency(at: number | null | undefined, now = Date.now()) {
  if (at == null || !Number.isFinite(at) || at <= 0 || at > now) return { radius: 5, depth: .45, label: 'Activity time unknown' }
  const days = (now - at) / 86_400_000, weight = 1 / (1 + Math.log2(1 + days))
  return { radius: 4 + 7 * weight, depth: .35 + .65 * weight, label: `Last activity ${new Date(at).toLocaleString()}` }
}

export const collaborationAgentName = (agent: CollaborationAgent | undefined) => agent?.name ?? agent?.context?.name ?? agent?.sessionId ?? ''
