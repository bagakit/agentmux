import type { AgentDisplayState } from '@agentmux/core'
import type { SessionSnapshot } from '../../../shared/contracts'

// Which state change is worth interrupting a person over.
//
// This is the one place that answers it. Notification, row rollup, and the roster all read this
// decision instead of each re-deriving "what counts as finished" from a status field — three surfaces
// guessing separately is how they end up disagreeing about the same Agent.
//
// It is deliberately pure: statuses in, verdict out. No Store, no Electron, no provider branching, and
// nothing inferred from terminal bytes. That keeps the hard part — which is the policy, not the
// plumbing — testable without a window.

export type AttentionCategory = 'done' | 'needs-you' | 'error'

export type AttentionEvent = {
  category: AttentionCategory
  sessionId: string
  // Carried through so a notification can name the Agent without a second lookup, and so the caller
  // never has to re-resolve which Session this was about.
  label: string
  observedAt: number
}

// What the caller must tell us about what the user can currently see. A notification for something
// happening in front of the user is noise, so visibility is part of the decision, not an afterthought
// bolted on at the call site.
export type AttentionVisibility = {
  // Whether the AgentMux window itself has OS focus.
  windowFocused: boolean
  // Whether this Session's Region is currently on screen in that window. A Session in a collapsed
  // pane or a background tab group is NOT visible even when the window is focused.
  sessionVisible: boolean
}

// The states that mean "an Agent needs you". Kept identical to the shared rollup vocabulary
// (agent-attention.ts) so a dot and a notification can never disagree about the same Session.
function isNeedsYou(state: AgentDisplayState): boolean {
  return state === 'waiting' || state === 'blocked'
}

// `done` is the only state that means the Agent finished its turn. `exited` is the process leaving,
// which is a lifecycle fact rather than a result, and it already shows up in the tab and Board.
function isFinished(state: AgentDisplayState): boolean {
  return state === 'done'
}

/**
 * Decide whether a single Agent's state change should interrupt the user.
 *
 * Returns the event to raise, or null to stay quiet. Quiet is the default: this only speaks up for a
 * genuine transition into a category worth a person's attention, and only when they are not already
 * looking at it.
 */
export function attentionEventFor(input: {
  session: Extract<SessionSnapshot, { kind: 'agent' }>
  // The state this Session was last known to be in, or null when it is being seen for the first time.
  previousState: AgentDisplayState | null
  visibility: AttentionVisibility
}): AttentionEvent | null {
  const { session, previousState, visibility } = input
  const next = session.status.state

  // A repeat report of the same state is not a transition. Providers re-announce status, and a hook
  // can deliver the same fact twice, so without this the user gets notified again for nothing.
  if (previousState === next) return null

  // First sight is not a transition either. Attaching to a window that already holds finished Agents
  // must not fire a burst of notifications for work that completed before the app was even open —
  // that is startup noise, and it trains people to ignore the channel.
  if (previousState === null) return null

  const category = categoryFor(next)
  if (!category) return null

  // Do not interrupt someone with something they are already watching. The status dot and the Activity
  // view are already telling them; a system notification on top of that is pure duplication.
  if (visibility.windowFocused && visibility.sessionVisible) return null

  return {
    category,
    sessionId: session.id,
    label: session.label,
    observedAt: session.status.observedAt
  }
}

/**
 * The attention category a state belongs to, or null when the state is not worth interrupting over.
 *
 * `disconnected` is absent on purpose: a dropped link is not a request for attention. It has its own
 * neutral treatment in the shared status vocabulary precisely so amber can mean "needs you" and
 * nothing else — raising a notification for it would undo that distinction.
 */
export function categoryFor(state: AgentDisplayState): AttentionCategory | null {
  if (isNeedsYou(state)) return 'needs-you'
  if (isFinished(state)) return 'done'
  if (state === 'error') return 'error'
  return null
}

/**
 * Fold a batch of Sessions against the previously known states, returning every event worth raising.
 *
 * Callers own the previous-state map because they own the lifetime of the projection; keeping it out
 * of here is what lets this stay pure and lets the same decision serve a notification, a row rollup,
 * and the roster without three copies of the bookkeeping.
 */
export function attentionEvents(input: {
  sessions: readonly SessionSnapshot[]
  previousStates: ReadonlyMap<string, AgentDisplayState>
  // Answers "can the user see this Session right now" per Session id.
  visibilityFor: (sessionId: string) => AttentionVisibility
}): AttentionEvent[] {
  const events: AttentionEvent[] = []
  for (const session of input.sessions) {
    if (session.kind !== 'agent') continue
    const event = attentionEventFor({
      session,
      previousState: input.previousStates.get(session.id) ?? null,
      visibility: input.visibilityFor(session.id)
    })
    if (event) events.push(event)
  }
  return events
}

/**
 * The next previous-state map, given the Sessions just projected.
 *
 * Sessions that disappeared are dropped rather than remembered: if one comes back it is a first
 * sight again, which correctly stays quiet instead of firing for a transition nobody witnessed.
 */
export function nextAttentionStates(
  sessions: readonly SessionSnapshot[]
): Map<string, AgentDisplayState> {
  const states = new Map<string, AgentDisplayState>()
  for (const session of sessions) {
    if (session.kind !== 'agent') continue
    states.set(session.id, session.status.state)
  }
  return states
}
