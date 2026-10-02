// @vitest-environment happy-dom
import { act, createElement, Fragment, useContext } from 'react'
import { expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { StableWorkbenchView } from '../src/renderer/src/components/StableWorkbenchView'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'

it('keeps the actual placed host while a later destination is unavailable', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'); document.body.append(container)
  const root = createClientUiRoot(container)
  function OriginalInput() {
    const presentation = useContext(WorkbenchPresentationContext)
    return createElement('input', { 'data-actual-host': presentation?.tabHostId, defaultValue: 'Original unsent input' })
  }
  const tree = (targetId: string | null, destinationReady = false) => createElement(Fragment, null,
    createElement('div', { id: 'pending-home' }), createElement('div', { id: 'pending-first' }),
    destinationReady ? createElement('div', { id: 'pending-later' }) : null,
    createElement(StableWorkbenchView, { homeId: 'pending-home', targetId, active: true, visible: true, retainedRegionId: null },
      createElement(OriginalInput)))
  try {
    await act(async () => root.render(tree('pending-first')))
    const input = container.querySelector<HTMLInputElement>('input')!
    expect(input).not.toBeNull()
    expect(input.closest('#pending-first')).not.toBeNull()
    expect(input.dataset.actualHost).toBe('pending-first')
    input.value = 'The later unsent draft'
    await act(async () => root.render(tree('pending-later')))
    expect(container.querySelector('input')).toBe(input)
    expect(input.closest('#pending-first')).not.toBeNull()
    expect(input.dataset.actualHost).toBe('pending-first')
    expect(input.value).toBe('The later unsent draft')
    await act(async () => root.render(tree('pending-later', true)))
    expect(container.querySelector('input')).toBe(input)
    expect(input.closest('#pending-later')).not.toBeNull()
    expect(input.dataset.actualHost).toBe('pending-later')
    expect(input.value).toBe('The later unsent draft')
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() }
})

it.each(['none', 'keydown', 'pointerdown', 'beforeinput', 'other-control', 'selection'] as const)('repairs a moved original editor collapse while preserving later %s intent', async intent => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'); document.body.append(container)
  const root = createClientUiRoot(container)
  const tree = (targetId: string | null) => createElement(Fragment, null,
    createElement('div', { id: 'reading-home' }), createElement('div', { id: 'reading-next' }),
    createElement('button', { id: 'later-control' }, 'Later control'),
    createElement(StableWorkbenchView, { homeId: 'reading-home', targetId, active: true, visible: true, retainedRegionId: null },
      createElement('p', { contentEditable: true }, 'Original unsent reading')))
  let move: ReturnType<typeof vi.spyOn> | undefined
  try {
    await act(async () => root.render(tree(null)))
    const input = container.querySelector<HTMLElement>('#reading-home p')!, text = input.firstChild!
    const selection = document.getSelection()!
    const select = (start: number, end = start) => {
      const range = document.createRange(); range.setStart(text, start); range.setEnd(text, end)
      selection.removeAllRanges(); selection.addRange(range)
    }
    input.focus(); select(4)
    const next = container.querySelector<HTMLElement>('#reading-next')!, originalMove = next.moveBefore.bind(next)
    move = vi.spyOn(next, 'moveBefore').mockImplementation((node, before) => {
      originalMove(node, before)
      // Reproduce the actual Chromium hidden/inert transition: same focused
      // original input and text node, but a collapsed native caret at zero.
      // happy-dom's insertion shim does not preserve native atomic-move focus.
      input.focus()
      select(0)
      if (intent === 'other-control') container.querySelector<HTMLElement>('#later-control')!.focus()
      else if (intent === 'selection') select(2, 6)
      else if (intent !== 'none') { input.dispatchEvent(new Event(intent, { bubbles: true })); select(2) }
    })
    await act(async () => root.render(tree('reading-next')))
    expect(next.querySelector('p')).toBe(input)
    expect(input.textContent).toBe('Original unsent reading')
    expect(document.activeElement).toBe(intent === 'other-control' ? container.querySelector('#later-control') : input)
    expect(selection.anchorNode).toBe(text)
    expect(selection.anchorOffset).toBe(intent === 'none' ? 4 : intent === 'other-control' ? 0 : 2)
    expect(selection.toString()).toBe(intent === 'selection' ? 'igin' : '')
  } finally { move?.mockRestore(); await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() }
})
