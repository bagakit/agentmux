import { describe, expect, it } from 'vitest'
import {
  FOLLOW_THRESHOLD_PX,
  initFollowState,
  isNearBottom,
  onContentChange,
  onScroll,
  shouldShowJumpToLatest,
  type ContentSignature,
  type FollowState,
  type ScrollGeometry
} from '../src/renderer/src/lib/activity-autoscroll.js'

// The whole point of this module is that "the distance to the bottom grew" is NOT enough to know the
// user scrolled away. While an agent streams, content grows below the fold and the distance grows with
// it — a handler that detaches on distance alone abandons the reader exactly when they most want to
// watch. These tests pin the separating evidence (scrollTop drops on a real gesture, stays put on
// growth) and the two content-change kinds (append AND in-place growth) that a naive version forgets.

/** Geometry sitting exactly at the bottom for a given content height. */
function atBottom(scrollHeight: number, clientHeight = 400): ScrollGeometry {
  return { scrollTop: scrollHeight - clientHeight, scrollHeight, clientHeight }
}

function sig(itemCount: number, lastItemId: string | null, lastItemLength: number): ContentSignature {
  return { itemCount, lastItemId, lastItemLength }
}

describe('isNearBottom', () => {
  it('counts the exact bottom as near', () => {
    expect(isNearBottom(atBottom(1000))).toBe(true)
  })

  it('counts a small residual gap as near — a programmatic pin rarely lands on the exact max', () => {
    expect(isNearBottom({ scrollTop: 600 - FOLLOW_THRESHOLD_PX, scrollHeight: 1000, clientHeight: 400 })).toBe(true)
  })

  it('counts a gap past the threshold as not near', () => {
    // One pixel beyond the band is off the bottom. This is the assertion that dies if the comparison
    // is inverted.
    expect(isNearBottom({ scrollTop: 600 - FOLLOW_THRESHOLD_PX - 1, scrollHeight: 1000, clientHeight: 400 })).toBe(false)
  })
})

describe('onScroll — separating a user gesture from content growth', () => {
  it('detaches when the user scrolls up and off the bottom', () => {
    const state: FollowState = { following: true, lastScrollTop: 600, lastSignature: sig(0, null, 0) }
    // scrollTop dropped from 600 to 100: an unmistakable upward drag, now far from the bottom.
    const next = onScroll(state, { scrollTop: 100, scrollHeight: 1000, clientHeight: 400 })
    expect(next.following).toBe(false)
  })

  it('does NOT detach when content grows below a pinned viewport', () => {
    // The classic bug: scrollHeight jumped 1000 -> 2000 but scrollTop never moved, so the viewport is
    // now 1000px from the bottom. That is growth, not a gesture, and following must survive it.
    const state: FollowState = { following: true, lastScrollTop: 600, lastSignature: sig(0, null, 0) }
    const next = onScroll(state, { scrollTop: 600, scrollHeight: 2000, clientHeight: 400 })
    expect(next.following).toBe(true)
  })

  it('stays following when the user scrolls up but is still within the bottom band', () => {
    // A tiny nudge that stays inside the follow zone is not a decision to leave the latest.
    const state: FollowState = { following: true, lastScrollTop: 600, lastSignature: sig(0, null, 0) }
    const next = onScroll(state, { scrollTop: 580, scrollHeight: 1000, clientHeight: 400 })
    expect(next.following).toBe(true)
  })

  it('re-attaches when the user scrolls back down to the bottom', () => {
    const state: FollowState = { following: false, lastScrollTop: 100, lastSignature: sig(0, null, 0) }
    const next = onScroll(state, atBottom(1000))
    expect(next.following).toBe(true)
  })

  it('stays detached while the user reads history away from the bottom', () => {
    const state: FollowState = { following: false, lastScrollTop: 100, lastSignature: sig(0, null, 0) }
    const next = onScroll(state, { scrollTop: 90, scrollHeight: 1000, clientHeight: 400 })
    expect(next.following).toBe(false)
  })

  it('ignores sub-pixel jitter as a downward reading of a still viewport', () => {
    // A browser reporting 599.6 after 600 is not the user dragging up; the epsilon guard keeps follow.
    const state: FollowState = { following: true, lastScrollTop: 600, lastSignature: sig(0, null, 0) }
    const next = onScroll(state, { scrollTop: 599.6, scrollHeight: 2000, clientHeight: 400 })
    expect(next.following).toBe(true)
  })

  it('always records the observed scrollTop as the next baseline', () => {
    const state: FollowState = { following: true, lastScrollTop: 600, lastSignature: sig(0, null, 0) }
    const next = onScroll(state, { scrollTop: 123, scrollHeight: 1000, clientHeight: 400 })
    expect(next.lastScrollTop).toBe(123)
  })
})

describe('onContentChange — both ways new content arrives', () => {
  const geometry = atBottom(1000)

  it('scrolls to bottom when a new item is appended while following', () => {
    const state: FollowState = { following: true, lastScrollTop: 600, lastSignature: sig(3, 'c', 10) }
    const decision = onContentChange(state, sig(4, 'd', 5), geometry)
    expect(decision.scrollToBottom).toBe(true)
  })

  it('scrolls to bottom when the last item grows in place while following', () => {
    // The most common case: one assistant turn lengthening token by token. Same id, same count, more
    // characters. A version that only checks itemCount misses this entirely.
    const state: FollowState = { following: true, lastScrollTop: 600, lastSignature: sig(3, 'c', 10) }
    const decision = onContentChange(state, sig(3, 'c', 42), geometry)
    expect(decision.scrollToBottom).toBe(true)
  })

  it('does NOT scroll when the tail is unchanged', () => {
    // An unrelated re-render with an identical tail must never yank the viewport.
    const state: FollowState = { following: true, lastScrollTop: 600, lastSignature: sig(3, 'c', 10) }
    const decision = onContentChange(state, sig(3, 'c', 10), geometry)
    expect(decision.scrollToBottom).toBe(false)
  })

  it('does NOT scroll when detached, even as content pours in', () => {
    // A reader who scrolled up keeps their place; growth must not drag them back down.
    const state: FollowState = { following: false, lastScrollTop: 100, lastSignature: sig(3, 'c', 10) }
    const decision = onContentChange(state, sig(3, 'c', 99), geometry)
    expect(decision.scrollToBottom).toBe(false)
  })

  it('carries the new signature forward so the next change is measured against it', () => {
    const state: FollowState = { following: true, lastScrollTop: 600, lastSignature: sig(3, 'c', 10) }
    const decision = onContentChange(state, sig(3, 'c', 42), geometry)
    expect(decision.state.lastSignature).toEqual(sig(3, 'c', 42))
    // And a second identical change against the advanced baseline is now a no-op.
    expect(onContentChange(decision.state, sig(3, 'c', 42), geometry).scrollToBottom).toBe(false)
  })
})

describe('shouldShowJumpToLatest', () => {
  it('is hidden while following — the viewport is already at the latest', () => {
    expect(shouldShowJumpToLatest({ following: true, lastScrollTop: 0, lastSignature: sig(0, null, 0) })).toBe(false)
  })

  it('is shown once detached — the affordance exists to undo the detach', () => {
    expect(shouldShowJumpToLatest({ following: false, lastScrollTop: 0, lastSignature: sig(0, null, 0) })).toBe(true)
  })
})

describe('initFollowState', () => {
  it('starts a fresh pane pinned, so the first content lands at the latest', () => {
    const state = initFollowState()
    expect(state.following).toBe(true)
    // First content of any kind against the empty baseline reads as new and pins.
    expect(onContentChange(state, sig(1, 'a', 4), atBottom(1000)).scrollToBottom).toBe(true)
  })
})
