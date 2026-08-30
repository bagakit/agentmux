import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  FOLLOW_THRESHOLD_PX,
  initFollowState,
  onScroll,
  shouldShowJumpToLatest
} from '../src/renderer/src/lib/activity-autoscroll.js'

describe('Message Tools bottom reveal', () => {
  it('hides the control at the bottom and shows it only after an upward scroll leaves the bottom band', () => {
    const initial = initFollowState()
    const atBottom = onScroll(initial, { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })
    expect(shouldShowJumpToLatest(atBottom)).toBe(false)

    const away = onScroll(atBottom, {
      scrollTop: 600 - FOLLOW_THRESHOLD_PX - 1,
      scrollHeight: 1000,
      clientHeight: 400
    })
    // A scrollTop decrease alone is not enough: this is the explicit one-pixel boundary beyond the
    // follow band that makes the button meaningful rather than a no-op at the bottom.
    expect(shouldShowJumpToLatest(away)).toBe(true)

    const returned = onScroll(away, { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })
    expect(shouldShowJumpToLatest(returned)).toBe(false)
  })

  it('keeps one existing Activity feed scroller and places an accessible control in that Message Tool surface', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/renderer/src/components/ActivityView.tsx'), 'utf8')
    const guard = source.indexOf('{showJump ? (')
    const button = source.indexOf('className="activity-feed__jump"', guard)
    expect(guard).toBeGreaterThan(-1)
    expect(button).toBeGreaterThan(guard)
    const block = source.slice(button, button + 360)
    expect(block).toContain('data-message-tool-control="jump-to-latest"')
    expect(block).toContain('aria-label="Jump to latest message"')
    expect(block).toContain('onClick={jumpToLatest}')
    expect(source).toContain("const el = logRef.current?.closest('.activity-feed')")
    expect(source.match(/className="activity-feed"/g)?.length ?? 0).toBeGreaterThan(0)
  })
})
