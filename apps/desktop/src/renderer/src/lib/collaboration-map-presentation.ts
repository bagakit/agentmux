import { useEffect, useState } from 'react'
import type { SessionSnapshot } from '../../../shared/contracts'
import { focusActivityEntryTime, focusBucketForSession } from './focus-context'
import { observeAgentSession } from './agent-observation'
import type { CollaborationAgent } from './agent-collaboration'

export const COLLABORATION_ACTIVITY_MS = 3200

/** Original activity facts choose visual weight; no activity is inferred from map use or output. */
export function collaborationAgentPresentation(session: Extract<SessionSnapshot, { kind: 'agent' }>, name?: string): Pick<CollaborationAgent, 'name' | 'tier' | 'lastActivityAt' | 'providerId' | 'executorId'> {
  const bucket = focusBucketForSession(session, false)
  const tier = session.processState === 'exited' && !session.runUnobserved ? 'closed'
    : bucket === 'working' || bucket === 'attention' ? 'active'
      : session.processState === 'running' && observeAgentSession(session, Date.now()).semantic === 'idle' ? 'idle' : 'unknown'
  return { name: name ?? session.label, tier, lastActivityAt: focusActivityEntryTime(session) ?? null, providerId: session.providerId, executorId: session.executorId }
}
export function collaborationNodeSize(tier: CollaborationAgent['tier']) {
  return tier === 'closed' ? { width: 24, height: 24 } : tier === 'idle' || tier === 'unknown' ? { width: 154, height: 38 } : { width: 250, height: 94 }
}

/** Three steps the eye can actually rank. A continuous curve flattens after a day. */
export type CollaborationRecencyStep = 'recent' | 'today' | 'older'
const HOUR = 3_600_000
/** One coarse clock per visible map. Steps are an hour apart, so a minute tick
 * keeps nodes and endpoints on the same step without per-frame time reads. */
export function useCollaborationRecencyClock(visible: boolean) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!visible) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [visible])
  return now
}
/** Observed activity first; a retired member has only its retirement record. */
const recencyAt = (agent: CollaborationAgent | undefined) => agent?.lastActivityAt ?? agent?.retiredAt ?? null
/** Recency weighs ink inside the stable slot; it never feeds layout geometry. */
export function collaborationRecencyStep(agent: CollaborationAgent | undefined, now: number): CollaborationRecencyStep {
  const at = recencyAt(agent), age = at != null && at > 0 && at <= now ? now - at : null
  if (agent?.tier === 'active' || age != null && age < HOUR) return 'recent'
  return age != null && age < 24 * HOUR ? 'today' : 'older'
}
/** On-disc icon diameter per step, in world px at full identity. Closed members cap one step lower. */
const ICON = { recent: 22, today: 17, older: 13 } as const
const DISC = 6

/** One visual glyph contract, shared by its body, endpoints, legend and settings preview. */
export function collaborationAgentGlyph(agent: CollaborationAgent | undefined, step: CollaborationRecencyStep) {
  const closed = agent?.tier === 'closed'
  const icon = ICON[closed && step === 'recent' ? 'today' : step]
  const radius = closed ? icon / 2 : icon / 2 + DISC / 2
  return { icon, closed, overviewRadius: radius, pointRadius: radius }
}

/** Retirement time is a lifecycle record, not observed activity; say which one is shown. */
export function collaborationRecencyLabel(agent: CollaborationAgent | undefined) {
  if (agent?.lastActivityAt) return `Last activity ${new Date(agent.lastActivityAt).toLocaleString()}`
  return agent?.retiredAt ? `Closed ${new Date(agent.retiredAt).toLocaleString()}` : 'Activity time unknown'
}

export const collaborationAgentName = (agent: CollaborationAgent | undefined) => agent?.name ?? agent?.context?.name ?? agent?.sessionId ?? ''
