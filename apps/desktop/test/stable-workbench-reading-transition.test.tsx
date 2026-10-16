// @vitest-environment happy-dom
import { act, createElement, Fragment, useContext } from 'react'
import { expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { StableWorkbenchView } from '../src/renderer/src/components/StableWorkbenchView'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { placeWorkbenchWindow, registerWorkbenchDocument } from '../src/renderer/src/lib/workbench-window-registry'

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
    <StableWorkbenchView homeId="pending-home" targetId={targetId} active visible retainedRegionId={null}>
      <OriginalInput />
    </StableWorkbenchView>)
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
    <StableWorkbenchView homeId="reading-home" targetId={targetId} active visible retainedRegionId={null}>
      <p contentEditable>Original unsent reading</p>
    </StableWorkbenchView>)
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
    <StableWorkbenchView homeId="scroll-home" targetId={targetId} active visible retainedRegionId={null}>
      <div data-workbench-reading-scroll><p>Reading revision {revision}</p></div>
    </StableWorkbenchView>)
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
    // The outgoing snapshot and resulting host-identity commit still protect
    // current reading; same-document attach adds no unused late snapshot.
    expect(read).toHaveBeenCalledTimes(change === 'move' ? 2 : 1)
  } finally { read?.mockRestore(); await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() }
})

it('attaches a late same-document destination without reading unused selection or scroll state', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'); document.body.append(container)
  const root = createClientUiRoot(container)
  const spies: Array<{ mockRestore(): void }> = []
  try {
    await act(async () => root.render(<StableWorkbenchView homeId="late-reading-home" targetId="late-reading-destination"
      active={false} visible={false} retainedRegionId={null}>
      <div data-workbench-reading-scroll><p contentEditable>Original unsent reading</p></div>
    </StableWorkbenchView>))
    const editor = container.querySelector('p')!, reader = editor.parentElement!, host = reader.parentElement!, text = editor.firstChild!
    reader.scrollTop = 120; reader.scrollLeft = 9
    const range = document.createRange(); range.setStart(text, 2); range.setEnd(text, 8)
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
    const selection = vi.spyOn(document, 'getSelection'), top = vi.spyOn(reader, 'scrollTop', 'get'), left = vi.spyOn(reader, 'scrollLeft', 'get')
    spies.push(selection, top, left)
    const destination = document.createElement('div'); destination.id = 'late-reading-destination'
    await act(async () => { container.append(destination); for (let i = 0; i < 6; i++) await Promise.resolve() })
    expect(destination.querySelector('.retained-workbench-view')).toBe(host)
    expect(destination.querySelector('p')).toBe(editor)
    expect(selection, 'actual same-document attach does not capture another Range').not.toHaveBeenCalled()
    expect(top, 'actual same-document attach does not read an unused scroll snapshot').not.toHaveBeenCalled()
    expect(left).not.toHaveBeenCalled()
    expect(reader.scrollTop).toBe(120); expect(reader.scrollLeft).toBe(9)
    expect(editor.textContent).toBe('Original unsent reading')
    const retained = document.getSelection()!.getRangeAt(0)
    expect(retained.startContainer).toBe(text); expect(retained.startOffset).toBe(2)
    expect(retained.endContainer).toBe(text); expect(retained.endOffset).toBe(8)
  } finally { for (const spy of spies) spy.mockRestore(); await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() }
})

it('still captures and restores parked original reading when adoption crosses documents', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'), frame = document.createElement('iframe'); document.body.append(container, frame)
  const child = frame.contentDocument!, destination = child.createElement('div'); child.body.append(destination)
  const reference = { displayWorkspaceId: 'adoption-workspace', groupId: 'adoption-group', tabId: 'adoption-tab', regionId: 'adoption-region' }
  const scope = { windowId: 'adoption-window', documentGeneration: 'adoption-document' }
  const releaseChild = registerWorkbenchDocument(child, scope), root = createClientUiRoot(container)
  const spies: Array<{ mockRestore(): void }> = []
  try {
    await act(async () => root.render(createElement(Fragment, null, createElement('div', { id: 'adoption-home' }),
      <StableWorkbenchView homeId="adoption-home" targetId={null} primaryTabId={reference.tabId}
        reference={reference} active visible={false} retainedRegionId={reference.regionId}>
        <div data-workbench-reading-scroll><p contentEditable>Original unsent adoption draft</p></div>
      </StableWorkbenchView>)))
    const editor = container.querySelector('p')!, reader = editor.parentElement!, host = reader.parentElement!, text = editor.firstChild!
    editor.focus(); reader.scrollTop = 120; reader.scrollLeft = 9
    const sourceSelection = document.getSelection()!, range = document.createRange()
    range.setStart(text, 2); range.setEnd(text, 8); sourceSelection.removeAllRanges(); sourceSelection.addRange(range)
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true), read = vi.spyOn(document, 'getSelection')
    const top = vi.spyOn(reader, 'scrollTop', 'get'), left = vi.spyOn(reader, 'scrollLeft', 'get')
    const adopt = child.adoptNode.bind(child)
    const adopting = vi.spyOn(child, 'adoptNode').mockImplementation(<T extends Node>(node: T): T => {
      const original = adopt(node)
      // Controlled native-adoption reset: the production owner must restore
      // both original endpoint nodes and these readers in the new document.
      reader.scrollTop = 0; reader.scrollLeft = 0; sourceSelection.removeAllRanges()
      return original
    })
    spies.push(focus, read, top, left, adopting)
    let moving!: Promise<void>
    await act(() => { moving = placeWorkbenchWindow({ kind: 'tab', displayWorkspaceId: reference.displayWorkspaceId,
      groupId: reference.groupId, tabId: reference.tabId }, { destination, window: scope }) })
    await act(async () => {}); await moving
    expect(adopting).toHaveBeenCalledWith(host)
    expect(read).toHaveBeenCalled(); expect(top).toHaveBeenCalled(); expect(left).toHaveBeenCalled()
    expect(destination.querySelector('.retained-workbench-view')).toBe(host)
    expect(destination.querySelector('p')).toBe(editor); expect(editor.ownerDocument).toBe(child)
    expect(editor.textContent).toBe('Original unsent adoption draft')
    expect(reader.scrollTop).toBe(120); expect(reader.scrollLeft).toBe(9)
    const restored = child.getSelection()!.getRangeAt(0)
    expect(restored.startContainer).toBe(text); expect(restored.startOffset).toBe(2)
    expect(restored.endContainer).toBe(text); expect(restored.endOffset).toBe(8)
    expect(child.activeElement).toBe(editor)
  } finally { for (const spy of spies) spy.mockRestore(); await act(async () => root.unmount()); releaseChild(); container.remove(); frame.remove(); vi.unstubAllGlobals() }
})

it.each([false, true])('repairs an original input with no local range while respecting a foreign selection: %s', async foreignSelection => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'); document.body.append(container)
  const root = createClientUiRoot(container)
  const tree = (targetId: string | null) => createElement(Fragment, null,
    createElement('p', { id: 'foreign-reading' }, 'Other reading remains selected'),
    createElement('div', { id: 'input-home' }), createElement('div', { id: 'input-next' }),
    <StableWorkbenchView homeId="input-home" targetId={targetId} active visible retainedRegionId={null}>
      <div data-workbench-reading-scroll><input defaultValue="Original unsent input" /></div>
    </StableWorkbenchView>)
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
