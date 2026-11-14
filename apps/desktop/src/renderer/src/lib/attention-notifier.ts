import type { AgentDisplayState, AgentTimelineSnapshot } from '@agentmux/core'
import type { AgentAttentionNotifyInput, NotificationModeId, SessionSnapshot } from '../../../shared/contracts'
import { composeAttentionBody } from '../../../shared/notification-presentation'
import { attentionEventFor, type AttentionEvent } from './attention-event'
import { agentSessionPresentationIndex } from './session-presentation'

export type AttentionReconcileInput = {
  sessions: readonly SessionSnapshot[]
  windowFocused: boolean
  visibleSessionIds: ReadonlySet<string>
  mode: NotificationModeId
  sound: boolean
  timelines: Readonly<Record<string, AgentTimelineSnapshot>>
}
export type AttentionNotifierPorts = {
  snapshot(): AttentionReconcileInput
  notify(input: AgentAttentionNotifyInput): Promise<unknown>
}
export type AttentionNotifier = {
  /** Advance the baseline immediately; return only actual delivery attempts, never native success. */
  reconcile(): Promise<AttentionEvent[]>
  seed(sessions: readonly SessionSnapshot[]): void
  dispose(): void
}
type Agent = Extract<SessionSnapshot, { kind: 'agent' }>
type Baseline = { state: AgentDisplayState; hostId: string; agentSessionId: string }
const TITLES: Record<AttentionEvent['category'], string> = {
  done: 'Agent finished', 'needs-you': 'Agent needs you', error: 'Agent failed'
}
const sameIdentity = (baseline: Baseline, session: Agent) => baseline.hostId === session.hostId && baseline.agentSessionId === session.control.agentSessionId
const identity = (value: Pick<Baseline, 'hostId' | 'agentSessionId'>) => JSON.stringify([value.hostId, value.agentSessionId])
function originalAgents(sessions: readonly SessionSnapshot[]): Map<string, Agent> {
  const originals = new Map<string, Agent>()
  for (const session of sessions) if (session.kind === 'agent') {
    const key = identity({ hostId: session.hostId, agentSessionId: session.control.agentSessionId })
    if (!originals.has(key)) originals.set(key, session)
  }
  return originals
}
function isVisible(input: AttentionReconcileInput, session: Agent): boolean {
  return input.windowFocused && (agentSessionPresentationIndex(input.sessions).get(session.control.agentSessionId) ?? [])
    .some(candidate => candidate.hostId === session.hostId && candidate.control.agentSessionId === session.control.agentSessionId && input.visibleSessionIds.has(candidate.id))
}

/** Status decisions stay in attention-event; this owns only transition and delivery sequencing. */
export function createAttentionNotifier(ports: AttentionNotifierPorts): AttentionNotifier {
  let baseline = new Map<string, Baseline>()
  let disposed = false
  const advance = (originals: ReadonlyMap<string, Agent>) => {
    const next = new Map<string, Baseline>()
    for (const [key, session] of originals) {
      const before = baseline.get(key)
      // The baseline entry itself is the transition token. Same-state observations keep it;
      // A -> B -> A replaces it, so a slow old batch cannot announce the later transition.
      next.set(key, before && before.state === session.status.state ? before
        : { state: session.status.state, hostId: session.hostId, agentSessionId: session.control.agentSessionId })
    }
    baseline = next
  }
  return {
    dispose() { disposed = true; baseline.clear() },
    seed(sessions) { if (!disposed) advance(originalAgents(sessions)) },
    async reconcile() {
      if (disposed) return []
      const input = ports.snapshot(), originals = originalAgents(input.sessions)
      const events: { event: AttentionEvent; key: string }[] = []
      for (const [key, session] of originals) {
        const event = attentionEventFor({ session, previousState: baseline.get(key)?.state ?? null,
          visibility: { windowFocused: input.windowFocused, sessionVisible: isVisible(input, session) } })
        if (event) events.push({ event, key })
      }
      // Off, visible and first-sight transitions still advance; reopening never replays them.
      advance(originals)
      const candidates = events.map(candidate => ({ ...candidate, transition: baseline.get(candidate.key)! }))
      const attempted: AttentionEvent[] = []
      for (const { event, key, transition } of candidates) {
        if (disposed) break
        const current = ports.snapshot(), session = agentSessionPresentationIndex(current.sessions).get(transition.agentSessionId)?.find(candidate => sameIdentity(transition, candidate))
        if (current.mode === 'off' || !session || session.status.state !== transition.state || baseline.get(key) !== transition || isVisible(current, session)) continue
        attempted.push({ ...event, sessionId: session.id, label: session.label })
        await ports.notify({ sessionId: session.id, title: TITLES[event.category],
          body: composeAttentionBody({ label: session.label, state: session.status.state, items: current.timelines[session.id]?.items }),
          mode: current.mode, sound: current.sound })
      }
      return attempted
    }
  }
}
