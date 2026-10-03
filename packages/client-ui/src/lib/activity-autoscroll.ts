// Every decision about following the bottom of the Activity feed while an agent streams, kept pure so
// it is testable without a scroll container. This repo's tests render with `renderToStaticMarkup` —
// effects never run and scroll events cannot be fired — so any judgement worth trusting cannot live in
// the component. The component owns only the raw DOM reads (scrollTop/scrollHeight/clientHeight) and the
// one write (pin to bottom); which of those to do, and when, is decided here from plain numbers.
//
// The crux is telling "the user scrolled up to read history" apart from "content grew below the fold".
// Both increase the distance from the bottom, so a handler that keys off distance alone detaches the
// moment the answer streams in — the classic bug this module exists to avoid. The separating evidence:
// a user's upward gesture DECREASES scrollTop, while content growth leaves scrollTop untouched and only
// inflates scrollHeight. So detach is keyed off a scrollTop *decrease*, never off distance. That also
// keeps this from fighting the ruler's scrollIntoView (ActivityView.tsx ~L458): a ruler jump to an
// earlier event moves scrollTop up and rightly detaches; a jump to the last event lands at the bottom
// and re-attaches — the two compose instead of racing.
//
// State is threaded by the caller like a reducer, never held module-side: many panes are open at once
// and module-level mutable state would bleed one pane's follow position into another's.

/**
 * Distance from the bottom, in px, within which the viewport counts as "watching the latest". Roughly
 * two to three of the feed's 24px log rows: wide enough to absorb the fractional-pixel remainder a
 * programmatic pin leaves behind (scrollTop rarely reaches an exact max), and a line or two of
 * overscroll slack, yet narrow enough that a deliberate scroll up of a few rows clearly clears it.
 */
export const FOLLOW_THRESHOLD_PX = 64

/**
 * Movement smaller than this is sub-pixel jitter, not a gesture. It guards the detach test so a browser
 * reporting scrollTop as 499.6 after it was 500 is not read as the user dragging upward.
 */
const SCROLL_EPSILON_PX = 1

/** The three raw geometry numbers the component reads off the scroll container. */
export type ScrollGeometry = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/**
 * A fingerprint of the feed's tail. New content arrives two ways that both matter: a new item is
 * appended, or the last item grows in place as tokens stream into it. Handling only the first misses the
 * most common case — a single assistant turn lengthening while the user watches — so the fingerprint
 * carries enough to see both: the count (an append bumps it), the last item's identity (a new tail bumps
 * it even at a stable count), and the last item's length (in-place growth bumps only this).
 */
export type ContentSignature = {
  itemCount: number
  lastItemId: string | null
  lastItemLength: number
}

/** Reducer-style state the caller threads per pane. Never a module-level singleton. */
export type FollowState = {
  /** Whether the viewport is currently pinned to the newest content. */
  following: boolean
  /** scrollTop at the last observation — the baseline a later scroll is compared against to see if the user moved up. */
  lastScrollTop: number
  /** The tail fingerprint at the last observation, to classify the next content change as append vs in-place growth. */
  lastSignature: ContentSignature
}

const EMPTY_SIGNATURE: ContentSignature = { itemCount: 0, lastItemId: null, lastItemLength: 0 }

/** A fresh pane starts pinned to the bottom: the first content that arrives should land at the latest. */
export function initFollowState(): FollowState {
  return { following: true, lastScrollTop: 0, lastSignature: EMPTY_SIGNATURE }
}

/** Whether the viewport sits within {@link FOLLOW_THRESHOLD_PX} of the bottom right now. */
export function isNearBottom(geometry: ScrollGeometry): boolean {
  const distanceFromBottom = geometry.scrollHeight - geometry.clientHeight - geometry.scrollTop
  return distanceFromBottom <= FOLLOW_THRESHOLD_PX
}

/**
 * Fold a scroll event into the follow state.
 *
 * Detach requires two things together: evidence of an upward gesture (scrollTop actually dropped) AND
 * the viewport having left the bottom zone. The upward-gesture half is what refuses to mistake content
 * growth for a scroll — growth keeps scrollTop fixed, so it never satisfies the drop and never detaches,
 * however far the bottom recedes. Re-attach needs no gesture direction: returning to the bottom by any
 * means resumes following.
 */
export function onScroll(state: FollowState, geometry: ScrollGeometry): FollowState {
  const nearBottom = isNearBottom(geometry)
  const movedUp = geometry.scrollTop < state.lastScrollTop - SCROLL_EPSILON_PX
  const following = state.following ? !(movedUp && !nearBottom) : nearBottom
  return { ...state, following, lastScrollTop: geometry.scrollTop }
}

/** What a content change asks the caller to do, alongside the state to carry forward. */
export type ContentChangeDecision = {
  state: FollowState
  /** True only when following and the tail actually changed — the caller then pins to bottom. */
  scrollToBottom: boolean
}

/**
 * Fold a content change into the follow state and say whether to pin to the bottom.
 *
 * Both change kinds are recognised: an append (count up, or a different last id) and in-place growth
 * (same tail, more characters). Either counts as "new content"; a still tail is ignored so an unrelated
 * re-render never yanks a reader who has scrolled away. We pin only while following — dragging a
 * detached reader back down would be the mirror-image bug of never following at all.
 */
export function onContentChange(
  state: FollowState,
  signature: ContentSignature,
  _geometry: ScrollGeometry
): ContentChangeDecision {
  const previous = state.lastSignature
  const appended =
    signature.itemCount > previous.itemCount || signature.lastItemId !== previous.lastItemId
  const grewInPlace =
    signature.lastItemId === previous.lastItemId &&
    signature.itemCount === previous.itemCount &&
    signature.lastItemLength > previous.lastItemLength
  const changed = appended || grewInPlace
  return {
    state: { ...state, lastSignature: signature },
    scrollToBottom: changed && state.following
  }
}

/**
 * Whether the "jump to latest" affordance should be visible. It exists precisely to undo a detach, so it
 * shows exactly when detached — while following, the viewport is already at the latest and the button
 * would be a no-op inviting a pointless click.
 */
export function shouldShowJumpToLatest(state: FollowState): boolean {
  return !state.following
}
