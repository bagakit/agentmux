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

it.each(['update', 'move'] as const)('keeps a scroll-only reader without restoring a global selection during %s', async change => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'); document.body.append(container)
  const root = createClientUiRoot(container)
  const tree = (targetId: string | null, revision: number) => createElement(Fragment, null,
    createElement('div', { id: 'scroll-home' }), createElement('div', { id: 'scroll-next' }),
    createElement(StableWorkbenchView, { homeId: 'scroll-home', targetId, active: true, visible: true, retainedRegionId: null },
      createElement('div', { 'data-workbench-reading-scroll': true }, createElement('p', null, `Reading revision ${revision}`))))
  let read: ReturnType<typeof vi.spyOn> | undefined
  try {
    document.getSelection()!.removeAllRanges()
    await act(async () => root.render(tree(null, 0)))
    const reader = container.querySelector<HTMLElement>('[data-workbench-reading-scroll]')!
    reader.scrollTop = 120
    read = vi.spyOn(document, 'getSelection')
    await act(async () => root.render(tree(change === 'move' ? 'scroll-next' : null, 1)))
    expect(container.querySelector('[data-workbench-reading-scroll]')).toBe(reader)
    expect(reader.scrollTop).toBe(120)
    expect(reader.textContent).toBe('Reading revision 1')
    // The outgoing snapshot still captures current reading. Moving also
    // captures at placement and at the resulting host-identity commit.
    // None of those snapshots needs to restore an absent range.
    expect(read).toHaveBeenCalledTimes(change === 'move' ? 3 : 1)
  } finally { read?.mockRestore(); await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() }
})

it.each([false, true])('repairs an original input with no local range while respecting a foreign selection: %s', async foreignSelection => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'); document.body.append(container)
  const root = createClientUiRoot(container)
  const tree = (targetId: string | null) => createElement(Fragment, null,
    createElement('p', { id: 'foreign-reading' }, 'Other reading remains selected'),
    createElement('div', { id: 'input-home' }), createElement('div', { id: 'input-next' }),
    createElement(StableWorkbenchView, { homeId: 'input-home', targetId, active: true, visible: true, retainedRegionId: null },
      createElement('div', { 'data-workbench-reading-scroll': true }, createElement('input', { defaultValue: 'Original unsent input' }))))
  let move: ReturnType<typeof vi.spyOn> | undefined
  try {
    await act(async () => root.render(tree(null)))
    const input = container.querySelector('input')!, reader = input.parentElement!
    const selection = document.getSelection()!
    selection.removeAllRanges(); input.focus(); reader.scrollTop = 120
    const next = container.querySelector<HTMLElement>('#input-next')!, originalMove = next.moveBefore.bind(next)
    move = vi.spyOn(next, 'moveBefore').mockImplementation((node, before) => {
      originalMove(node, before); input.blur()
      if (foreignSelection) {
        const range = document.createRange(), text = container.querySelector('#foreign-reading')!.firstChild!
        range.setStart(text, 0); range.setEnd(text, 5)
        selection.removeAllRanges(); selection.addRange(range)
      }
    })
    await act(async () => root.render(tree('input-next')))
    expect(next.querySelector('input')).toBe(input)
    expect(input.value).toBe('Original unsent input')
    expect(reader.scrollTop).toBe(120)
    expect(document.activeElement).toBe(foreignSelection ? document.body : input)
    expect(selection.toString()).toBe(foreignSelection ? 'Other' : '')
  } finally { move?.mockRestore(); await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() }
})
