import type { AgentDisplayState } from '@agentmux/core'
import type { SessionSnapshot } from '../../../shared/contracts'
import { isNeedsYouState } from './attention-vocabulary'

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
 * The needs-you half comes from {@link isNeedsYouState} — the one table every attention surface reads —
 * rather than being spelled out again here. `disconnected` is false there on purpose: a dropped link is
 * not a request for attention. It has its own neutral treatment in the shared status vocabulary
 * precisely so amber can mean "needs you" and nothing else — raising a notification for it would undo
 * that distinction.
 */
export function categoryFor(state: AgentDisplayState): AttentionCategory | null {
  if (isNeedsYouState(state)) return 'needs-you'
  if (isFinished(state)) return 'done'
  if (state === 'error') return 'error'
  return null
}

/**
 * The `data-attention` value a state earns, or null for no accent at all.
 *
 * Not every attention category gets colour. `done` is worth a notification but not an accent: amber and
 * red are for "you are the blocker" and "this broke", and a finished run competing for the same ink is
 * how a scan stops telling you anything (see the rule in overlays.css). So this is `categoryFor` minus
 * `done` — expressed by naming the two that DO earn ink, because the interesting question at every call
 * site is "is this urgent", and answering it by listing exclusions inverts on the next category added.
 *
 * The row accent reads this in production (via {@link attentionAccentFor}), so "which categories earn
 * ink" is decided in exactly one place. `rosterBadgeCount` also reads it, but that count feeds no
 * collapsed roster badge — no such badge is built, and nothing in production calls it (see its
 * docstring). So do not read this as "the badge and the ink are one number": today it is only the ink.
 * The accent was a hand-written `needs-you || error` copy before this.
 */
export const URGENT_ATTENTION_CATEGORIES = ['needs-you', 'error'] as const

export function isUrgentAttention(category: AttentionCategory | null): boolean {
  return category !== null && (URGENT_ATTENTION_CATEGORIES as readonly string[]).includes(category)
}

/** The accent for one state: its urgent category, or null when it should carry none. */
export function attentionAccentFor(state: AgentDisplayState): AttentionCategory | null {
  const category = categoryFor(state)
  return isUrgentAttention(category) ? category : null
}

/**
 * The one ORDERING the attention surfaces sort by, most urgent first.
 *
 * The roster and the quick switcher both rank rows, and both must agree about who sorts above whom.
 * They were two hand-written tables before this, and they had already drifted: the roster sorted a
 * finished Agent strictly above an idle one while the switcher tied them. This is the single decision
 * they now share, so that divergence cannot come back (guarded in attention-ordering.test.ts).
 *
 * It is keyed on a coarse sort CLASS rather than on AgentDisplayState on purpose. "Does this state need
 * a person" is decided once, in {@link isNeedsYouState} (see attention-vocabulary.ts), and each surface
 * routes through that table and arrives here already classified — so this file never re-spells the
 * needs-you states, and the ranking stays a separate, single concern from the needs-you predicate.
 *
 * `done` and `idle` share a rank deliberately. A finished-but-unlooked-at Agent is NOT more urgent than
 * an idle one until there is an unread/seen axis to say it has not yet been looked at — and there is
 * none. #199 is that axis (a separate feature, deliberately not built here); #246 records that ranking
 * `done` above idle is contrary to every reference product while no such axis exists. So this tie is a
 * compromise pending #199, not a settled claim that completion outranks idleness.
 */
export type AttentionSortClass = AttentionCategory | 'working' | 'idle'

const ATTENTION_SORT_RANK: Record<AttentionSortClass, number> = {
  'needs-you': 0,
  error: 1,
  working: 2,
  done: 3,
  idle: 3
}

/**
 * 每个排序类的名字，取自排序表本身。
 *
 * 导出它是因为这些名字已经被手抄了第五份：结构守卫（attention-ordering.test.ts）要认出「谁又自己
 * 写了一份序表」，就得知道这些名字，而它此前手抄了一行字面量。
 *
 * 手抄那份与表分岔时，最坏的后果不是漏判某个副本，而是守卫**掉头指向错误的结论**：新类进了表、
 * 没进清单，表就不再满足「所有键都是排序类」，于是连 SSOT 自己都不被认成序表——扫描报的是
 * 「共享的表整个不见了」，而表就在那儿一行没动。一个如实的守卫不该在被正确扩充时说出假话。
 *
 * `Record<AttentionSortClass, number>` 的键让 tsc 挡住漏项：加了联合成员却不填表就是编译错，
 * 所以这份清单不可能比联合少。运行期只用于成员判定（`includes`），与顺序无关。
 */
export const ATTENTION_SORT_CLASSES = Object.keys(
  ATTENTION_SORT_RANK
) as readonly AttentionSortClass[]

export function attentionSortRank(sortClass: AttentionSortClass): number {
  return ATTENTION_SORT_RANK[sortClass]
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
