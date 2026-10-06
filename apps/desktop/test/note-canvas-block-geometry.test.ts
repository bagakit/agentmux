// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { findNoteCanvasBlockRows, measureNoteCanvasBlockPorts } from '../src/renderer/src/lib/note-canvas-block-geometry'

const box = (left: number, top: number, width: number, height: number) => new DOMRect(left, top, width, height)
function fixture() {
  const card = document.createElement('article'), body = document.createElement('div')
  card.append(body); body.innerHTML = '<div class="mobile-note-body"><p data-block-id="visible">Original</p><div data-block-id="embed"><div class="mobile-note-body"><p data-block-id="visible">Embedded projection</p><p data-block-id="embedded-only">Other original</p></div></div><p data-block-id="below">Offscreen original</p></div>'
  card.getBoundingClientRect = () => box(10, 100, 576, 900)
  Object.defineProperty(card, 'offsetWidth', { value: 288 })
  Object.defineProperty(card, 'clientTop', { value: 1 })
  body.getBoundingClientRect = () => box(12, 180, 572, 200)
  for (const row of body.querySelectorAll<HTMLElement>('[data-block-id]')) row.getBoundingClientRect = () => box(40, row.dataset.blockId === 'below' ? 500 : 220, 400, 40)
  return { card, body }
}
it('measures only the unique original block in the visible viewport, with zoom removed from card-local geometry', () => {
  const { card, body } = fixture()
  expect(measureNoteCanvasBlockPorts(card, body, findNoteCanvasBlockRows(body, ['visible', 'embedded-only', 'below', 'missing']))).toEqual([{ blockId: 'visible', top: 69 }])
})
it('keeps duplicated original DOM identities at the summary rather than choosing the first row', () => {
  const { card, body } = fixture(), duplicate = document.createElement('p')
  duplicate.dataset.blockId = 'visible'; duplicate.getBoundingClientRect = () => box(40, 300, 400, 40)
  body.querySelector('.mobile-note-body')!.append(duplicate)
  expect(measureNoteCanvasBlockPorts(card, body, findNoteCanvasBlockRows(body, ['visible']))).toEqual([])
})
it('uses the visible portion of a tall block and drops it when scrolled completely out', () => {
  const { card, body } = fixture(), row = body.querySelector<HTMLElement>('[data-block-id="visible"]')!
  row.getBoundingClientRect = () => box(40, 150, 400, 100)
  expect(measureNoteCanvasBlockPorts(card, body, findNoteCanvasBlockRows(body, ['visible']))).toEqual([{ blockId: 'visible', top: 56.5 }])
  row.getBoundingClientRect = () => box(40, 80, 400, 100)
  expect(measureNoteCanvasBlockPorts(card, body, findNoteCanvasBlockRows(body, ['visible']))).toEqual([])
})
it('compares exact block identities without interpolating them into selectors or guessing from visible text', () => {
  const { card, body } = fixture(), row = body.querySelector<HTMLElement>('[data-block-id="visible"]')!
  row.dataset.blockId = 'same ["title"] #精确'; row.textContent = 'A different displayed title'
  expect(measureNoteCanvasBlockPorts(card, body, findNoteCanvasBlockRows(body, ['same ["title"] #精确']))).toEqual([{ blockId: 'same ["title"] #精确', top: 69 }])
})
