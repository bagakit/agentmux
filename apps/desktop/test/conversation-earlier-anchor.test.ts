// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { conversationReadingAnchor, restoreConversationAnchor } from '../src/renderer/src/lib/session-conversation-window'

const surfaces: HTMLElement[] = []
afterEach(() => { getSelection()?.removeAllRanges(); surfaces.splice(0).forEach(surface => surface.remove()); vi.restoreAllMocks() })

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

it('anchors the selected native original before a stale visible leading-group candidate', () => {
  const viewport = document.createElement('div'), group = document.createElement('div'), card = document.createElement('div'), head = document.createElement('button'), row = document.createElement('div')
  group.dataset.conversationProcessKey = 'leading'; card.className = 'wf-card--observation'; card.dataset.observationId = 'stable-leading'
  head.className = 'wf-head'; head.setAttribute('aria-expanded', 'false'); card.append(head); group.append(card)
  row.dataset.nativeRecordId = 'selected'; row.textContent = 'Original selected body'; viewport.append(group, row); document.body.append(viewport); surfaces.push(viewport)
  let added = 0
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 600, 400)
  group.getBoundingClientRect = head.getBoundingClientRect = () => new DOMRect(0, 30 - viewport.scrollTop, 600, 32)
  row.getBoundingClientRect = () => new DOMRect(0, 150 + added - viewport.scrollTop, 600, 80)
  const range = document.createRange(); range.selectNodeContents(row.firstChild!); getSelection()!.addRange(range)
  const anchor = conversationReadingAnchor(viewport, undefined, false, [head])
  expect(anchor).toEqual({ kind: 'record', id: 'selected', offset: 150 })
  added = 1040; restoreConversationAnchor(viewport, anchor!)
  expect(row.getBoundingClientRect().top).toBe(150); expect(viewport.scrollTop).toBe(1040)
  expect(getSelection()!.getRangeAt(0)).toBe(range)
})

it('uses only existing visible leaves when both selected Range endpoints are offscreen', () => {
  const viewport = document.createElement('div'), start = document.createElement('div'), group = document.createElement('div'), visible = document.createElement('div'), end = document.createElement('div')
  start.dataset.nativeRecordId = 'start'; visible.dataset.nativeRecordId = 'visible'; end.dataset.nativeRecordId = 'end'; group.dataset.conversationProcessKey = 'group'
  for (const row of [start, group, visible, end]) row.textContent = 'Original body'
  viewport.append(start, group, visible, end); document.body.append(viewport); surfaces.push(viewport)
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 600, 400)
  start.getBoundingClientRect = () => new DOMRect(0, -200, 600, 80); end.getBoundingClientRect = () => new DOMRect(0, 700, 600, 80)
  group.getBoundingClientRect = () => new DOMRect(0, 30, 600, 32); visible.getBoundingClientRect = () => new DOMRect(0, 150, 600, 80)
  const range = document.createRange(); range.setStart(start.firstChild!, 1); range.setEnd(end.firstChild!, 2); getSelection()!.addRange(range)
  const scan = vi.spyOn(viewport, 'querySelectorAll')
  expect(conversationReadingAnchor(viewport, undefined, false, [group, visible])).toEqual({ kind: 'record', id: 'visible', offset: 150 })
  expect(scan, 'A crossing selection reuses the observed candidates instead of scanning the window').not.toHaveBeenCalled()
})

it('uses a selected original leaf when Range boundaries are offsets on its process container', () => {
  const viewport = document.createElement('div'), group = document.createElement('div'), card = document.createElement('div'), head = document.createElement('button'), row = document.createElement('div')
  group.dataset.conversationProcessKey = 'selected'; card.className = 'wf-card--observation'; card.dataset.observationId = 'stable-parent'
  head.className = 'wf-head'; head.setAttribute('aria-expanded', 'false'); card.append(head, row); group.append(card)
  row.dataset.nativeRecordId = 'selected'; row.textContent = 'Original selected body'; viewport.append(group); document.body.append(viewport); surfaces.push(viewport)
  let added = 0
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 600, 400)
  group.getBoundingClientRect = () => new DOMRect(0, 30 - viewport.scrollTop, 600, 200 + added)
  head.getBoundingClientRect = () => new DOMRect(0, 30 - viewport.scrollTop, 600, 32)
  row.getBoundingClientRect = () => new DOMRect(0, 150 + added - viewport.scrollTop, 600, 80)
  const range = document.createRange(); range.selectNodeContents(group); getSelection()!.addRange(range)
  const anchor = conversationReadingAnchor(viewport, undefined, false, [head, row])
  expect(anchor, 'Element offsets describe selected descendants, not the stable process heading').toEqual({ kind: 'record', id: 'selected', offset: 150 })
  added = 1040; restoreConversationAnchor(viewport, anchor!)
  expect(row.getBoundingClientRect().top).toBe(150); expect(getSelection()!.getRangeAt(0)).toBe(range)
})
