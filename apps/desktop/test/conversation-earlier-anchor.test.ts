// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { restoreConversationAnchor } from '../src/renderer/src/lib/session-conversation-window'

const surfaces: HTMLElement[] = []
afterEach(() => surfaces.splice(0).forEach(surface => surface.remove()))

// Model the browser's real scroll clamp, with geometry depending on the actual applied scroll.
// The private full-App probe separately records native Chromium rectangles and frame positions.
function foldedPage() {
  const viewport = document.createElement('div'), row = document.createElement('div'), space = document.createElement('div')
  row.dataset.nativeRecordId = 'original'
  viewport.style.paddingBottom = '24px'; viewport.append(row, space); document.body.append(viewport); surfaces.push(viewport)
  let scroll = 0, rowTop = 258, end = 478
  const blank = () => Number.parseFloat(space.style.height) || 0
  Object.defineProperties(viewport, {
    clientHeight: { value: 600 },
    scrollHeight: { get: () => Math.max(600, end + blank() + 24) },
    scrollTop: { get: () => scroll, set: (target: number) => { scroll = Math.max(0, Math.min(target, end + blank() + 24 - 600)) } }
  })
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 300, 600)
  row.getBoundingClientRect = () => new DOMRect(0, rowTop - scroll, 300, 20)
  space.getBoundingClientRect = () => new DOMRect(0, end - scroll, 300, blank())
  return { viewport, row, space, growBelow(pixels: number) { end += pixels } }
}

it('adds only the bounded tail extent needed when a folded Earlier prepend is clamped, without accumulating on repeated restoration', () => {
  const { viewport, row, space } = foldedPage(), anchor = { kind: 'record' as const, id: 'original', offset: 180 }
  restoreConversationAnchor(viewport, anchor)
  expect(viewport.scrollTop).toBe(0); expect(row.getBoundingClientRect().top).toBe(258)
  restoreConversationAnchor(viewport, anchor, space)
  expect(viewport.scrollTop).toBe(78); expect(row.getBoundingClientRect().top).toBe(180)
  expect(space.style.height).toBe('176px'); expect(space.getBoundingClientRect().height).toBeLessThanOrEqual(viewport.clientHeight)
  restoreConversationAnchor(viewport, anchor, space)
  expect(space.style.height).toBe('176px'); expect(viewport.scrollTop).toBe(78)
})

it('shrinks and removes the same reading space when actual content makes the retained position reachable', () => {
  const { viewport, row, space, growBelow } = foldedPage(), anchor = { kind: 'record' as const, id: 'original', offset: 180 }
  restoreConversationAnchor(viewport, anchor, space)
  growBelow(150); restoreConversationAnchor(viewport, anchor, space)
  expect(space.style.height).toBe('26px'); expect(row.getBoundingClientRect().top).toBe(180)
  growBelow(200); restoreConversationAnchor(viewport, anchor, space)
  expect(space.style.height).toBe(''); expect(viewport.scrollTop).toBe(78); expect(row.getBoundingClientRect().top).toBe(180)
})

it('does not create space without the retained row or on a viewport that has no measured geometry', () => {
  const { viewport, row, space } = foldedPage()
  restoreConversationAnchor(viewport, { kind: 'record', id: 'missing', offset: 180 }, space)
  expect(space.style.height).toBe(''); expect(viewport.scrollTop).toBe(0)
  row.getBoundingClientRect = () => new DOMRect(0, 258, 300, 0)
  restoreConversationAnchor(viewport, { kind: 'record', id: 'original', offset: 180 }, space)
  expect(space.style.height).toBe(''); expect(viewport.scrollTop).toBe(0)
})
