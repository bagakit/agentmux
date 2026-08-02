import type { AgentDisplayState } from '@agentmux/core'

/**
 * Which Agent states mean "a person needs to do something".
 *
 * This is the one definition. Five surfaces asked the question before this file existed — the
 * notification decision, the window rollup, the roster ranking, the quick switcher's ordering, and the
 * quick switcher's row colour — and each spelled the answer out itself as `state === 'waiting' ||
 * state === 'blocked'`. Two of them carried a comment promising they were "kept identical to" another
 * one, which is exactly the shape that drifts: a promise in prose that nothing checks.
 *
 * It is a total Record rather than a predicate with a switch or an `||` chain, and that is the
 * load-bearing part. A Record over the full union does not compile until every state has a verdict, so
 * adding a state to {@link AgentDisplayState} in Core fails the desktop build **here**, once, with the
 * new name pointed at — instead of silently defaulting to `false` at five call sites and quietly
 * dropping the new state out of every attention surface at the same time.
 *
 * The verdicts, and why:
 *
 *   - `waiting` / `blocked` — the Agent has surfaced a request, or cannot proceed. Nothing moves until
 *     a person acts. This is the whole class.
 *   - `starting` / `running` / `working` — it is doing the work. Interrupting is the opposite of help.
 *   - `done` / `exited` — finished, and finishing is its own category (see `categoryFor`): worth a
 *     notification, not worth the amber "you are the blocker" treatment.
 *   - `error` — also its own category, and deliberately NOT this one. Amber says "you are being waited
 *     on"; red says "this broke". Folding them loses the difference at a glance, which is the one
 *     thing a colour is for.
 *   - `disconnected` — a dropped link is not a request. It has its own neutral treatment precisely so
 *     amber can mean needs-you and nothing else.
 */
const NEEDS_YOU_BY_STATE: Record<AgentDisplayState, boolean> = {
  starting: false,
  running: false,
  disconnected: false,
  working: false,
  waiting: true,
  blocked: true,
  done: false,
  exited: false,
  error: false
}

/**
 * Does this state mean an Agent needs a person?
 *
 * Every attention surface routes through here. A surface that wants a coarser bucket — the Board's
 * four kanban columns, say — is answering a different question and must not be built by widening this
 * one; see `sessionBoardColumn`, which is deliberately its own mapping.
 */
export function isNeedsYouState(state: AgentDisplayState): boolean {
  return NEEDS_YOU_BY_STATE[state]
}

/**
 * Every Agent display state, as values.
 *
 * Derived from the verdict table rather than written out a second time, so the list and the verdicts
 * cannot disagree about which states exist. Tests use it to drive a case per state without hand-copying
 * nine names — a hand-copied list is how a new state ends up untested at exactly the moment it is new.
 *
 * Order is the union's declaration order, which is roughly lifecycle order. Nothing should depend on
 * it; sort if the order matters to you.
 */
export const AGENT_DISPLAY_STATES = Object.keys(NEEDS_YOU_BY_STATE) as readonly AgentDisplayState[]
