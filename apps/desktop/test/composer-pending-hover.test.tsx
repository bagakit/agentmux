// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Root } from 'react-dom/client'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ComposerPendingDelivery } from '../src/renderer/src/components/ComposerPendingDelivery'
import type { ComposerQueuedMessage } from '../src/renderer/src/components/ComposerOutbox'

let container: HTMLDivElement, outside: HTMLInputElement, root: Root
let scroll: ReturnType<typeof vi.fn>
const original = (id: string): ComposerQueuedMessage => ({ id, text: 'Original ' + id, status: 'queued', deliverable: true, editable: true })
const entries = [original('first'), original('second'), original('third')]
const send = vi.fn(), copy = vi.fn(async () => true), edit = vi.fn(async () => {}), archive = vi.fn(async () => {}), more = vi.fn()
const surface = () => document.querySelector<HTMLElement>('.composer-pending')!
const card = (id: string) => surface().querySelector<HTMLElement>(`[data-operation-id="${id}"].composer-pending__card`)!
const selected = () => surface().dataset.operationId
async function render(queued = entries, suppressed = false) {
  await act(async () => root.render(<ComposerPendingDelivery queued={queued} suppressed={suppressed} pendingInteraction={false} anchorRef={{ current: null }}
    onSend={send} onCopy={copy} onEdit={edit} onArchive={archive} onMore={more} />))
}
async function hover(id: string, pointerType = 'mouse') {
  await act(async () => card(id).dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType })))
}
async function leave(id: string, target: Element = outside) {
  await act(async () => card(id).dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: target })))
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); outside = document.createElement('input')
  document.body.append(container, outside); root = createClientUiRoot(container)
  scroll = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll })
  for (const action of [send, copy, edit, archive, more]) action.mockClear()
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove(); outside.remove(); vi.restoreAllMocks()
})

it('drops only transient hover when leaving the original card into the scrollport gutter or outside', async () => {
  await render(); expect(selected()).toBe('first')
  const unchanged = structuredClone(entries), active = document.activeElement
  await hover('second'); expect(selected()).toBe('second')
  await leave('second', surface().querySelector('ol')!); expect(selected()).toBe('first')
  await hover('third'); await leave('third'); expect(selected()).toBe('first')
  expect(entries).toEqual(unchanged); expect(document.activeElement).toBe(active)
  expect(scroll).not.toHaveBeenCalled()
  for (const action of [send, copy, edit, archive, more]) expect(action).not.toHaveBeenCalled()
})

it('retains the true keyboard target and descendant focus after pointer leave, then releases it when focus leaves the stack', async () => {
  await render()
  await act(async () => { card('first').focus(); card('first').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })
  expect(selected()).toBe('third'); expect(document.activeElement).toBe(card('third'))
  await hover('second'); expect(selected()).toBe('second')
  await leave('second'); expect(selected()).toBe('third'); expect(document.activeElement).toBe(card('third'))
  const action = card('third').querySelector<HTMLButtonElement>('.composer-pending__copy')!
  await act(async () => action.focus()); expect(selected()).toBe('third')
  await leave('third'); expect(selected()).toBe('third'); expect(document.activeElement).toBe(action)
  await act(async () => outside.focus()); expect(selected()).toBe('first'); expect(document.activeElement).toBe(outside)
  expect(send).not.toHaveBeenCalled()
})

it('keeps the same nonfirst inline edit draft and its focus after pointer leave', async () => {
  await render(); await hover('second')
  await act(async () => card('second').querySelector<HTMLButtonElement>('.composer-pending__preview')!.click())
  const editor = card('second').querySelector<HTMLTextAreaElement>('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, 'Unsaved original edit')
    editor.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await leave('second'); await hover('third')
  expect(selected()).toBe('second'); expect(card('second').querySelector('textarea')).toBe(editor)
  expect(editor.value).toBe('Unsaved original edit'); expect(document.activeElement).toBe(editor)
  expect(edit).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
})

it('returns to the original in-flight operation after transient hover without changing its input locks', async () => {
  const queued = [entries[0]!, entries[1]!, { ...entries[2]!, preparing: true }]
  await render(queued); expect(selected()).toBe('third')
  await hover('second'); await leave('second'); expect(selected()).toBe('third')
  expect(card('third').dataset.busy).toBe('true')
  for (const button of surface().querySelectorAll<HTMLButtonElement>('.composer-pending__send')) expect(button.disabled).toBe(true)
  expect(queued[2]!.preparing).toBe(true); expect(send).not.toHaveBeenCalled()
})

it('does not convert a touch pointer into persistent hover selection', async () => {
  await render(); await hover('second', 'touch'); expect(selected()).toBe('first')
  await act(async () => card('second').focus()); expect(selected()).toBe('second')
  await leave('second'); expect(selected()).toBe('second')
})

it('clears transient hover when the native window loses its pointer or focus', async () => {
  await render(); await hover('second')
  await act(async () => window.dispatchEvent(new PointerEvent('pointerout', { relatedTarget: null })))
  expect(selected()).toBe('first')
  await hover('third'); await act(async () => window.dispatchEvent(new Event('blur')))
  expect(selected()).toBe('first'); expect(scroll).not.toHaveBeenCalled()
})

it('does not retain a hover target across suppression of the original floating projection', async () => {
  await render(); await hover('third'); expect(selected()).toBe('third')
  await render(entries, true); expect(surface().hidden).toBe(true)
  await render(); expect(selected()).toBe('first'); expect(surface().hidden).toBe(false)
  expect(surface().querySelectorAll('li')).toHaveLength(3)
  expect(send).not.toHaveBeenCalled()
})

it('keeps the original long-queue scroll position on tail hover and leave', async () => {
  const queued = Array.from({ length: 100 }, (_, i) => original('row-' + i))
  await render(queued)
  const list = surface().querySelector('ol')!; list.scrollTop = 2460; scroll.mockClear()
  await hover('row-99'); expect(selected()).toBe('row-99')
  await leave('row-99'); expect(selected()).toBe('row-0')
  expect(list.scrollTop).toBe(2460); expect(scroll).not.toHaveBeenCalled()
  expect(surface().querySelectorAll('li')).toHaveLength(100)
  expect(card('row-99').querySelector('.composer-pending__more')!.textContent).toBe('100/100')
  expect(queued).toHaveLength(100); expect(send).not.toHaveBeenCalled()
})
