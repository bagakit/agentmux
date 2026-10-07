// @vitest-environment happy-dom
import { act, useRef, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Root } from 'react-dom/client'
import { Panel, PanelGroup, type ImperativePanelGroupHandle } from 'react-resizable-panels'
import { createClientUiRoot } from './helpers/client-ui-render'
import { WorkbenchSplitHandle } from '../src/renderer/src/components/WorkbenchSplitHandle'
import { SplitRatioCommitter } from '../src/renderer/src/lib/split-ratio-commit'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let host: HTMLDivElement, root: Root
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const render = async (node: ReactNode) => { await act(async () => root.render(node)); await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }

it('discards a cancelled intermediate ratio, including the library cleanup and late physical release', () => {
  const commit = vi.fn(), owner = new SplitRatioCommitter(0.65, commit)
  owner.setDragging(true); owner.observeLayout([42, 58]); owner.cancelDragging()
  owner.setDragging(false); owner.observeLayout([65, 35])
  expect(commit).not.toHaveBeenCalled()
  owner.setDragging(true); owner.observeLayout([72, 28]); owner.setDragging(false)
  expect(commit).toHaveBeenCalledExactlyOnceWith(0.72)
})
it('keeps a later accepted owner ratio when the old local gesture is cancelled', () => {
  const commit = vi.fn(), owner = new SplitRatioCommitter(0.65, commit)
  owner.setDragging(true); owner.observeLayout([42, 58])
  owner.synchronizePersistedRatio(0.58); owner.cancelDragging(); owner.observeLayout([58, 42]); owner.setDragging(false)
  expect(commit).not.toHaveBeenCalled()
  owner.observeLayout([61, 39])
  expect(commit).toHaveBeenCalledExactlyOnceWith(0.61)
})
it('continues to commit an actual released drag once and preserves non-drag keyboard layout updates', () => {
  const commit = vi.fn(), owner = new SplitRatioCommitter(0.65, commit)
  owner.setDragging(true); owner.observeLayout([42, 58]); owner.setDragging(false); owner.setDragging(false)
  expect(commit).toHaveBeenCalledExactlyOnceWith(0.42)
  owner.observeLayout([50, 50]); expect(commit).toHaveBeenLastCalledWith(0.5)
})
function OriginalPanels({ changed, disabled = false }: { changed(ratio: number): void; disabled?: boolean }) {
  const group = useRef<ImperativePanelGroupHandle>(null), committer = useRef<SplitRatioCommitter | null>(null)
  if (!committer.current) committer.current = new SplitRatioCommitter(0.65, changed)
  return <PanelGroup ref={group} direction="horizontal" onLayout={sizes => committer.current!.observeLayout(sizes)}>
    <Panel defaultSize={65} minSize={15}><textarea aria-label="Original editor" defaultValue="Retained draft" /></Panel>
    <WorkbenchSplitHandle group={group} committer={committer.current} ratio={0.65} sourceKey="original-split" disabled={disabled} className="original-handle" onDragging={() => {}} />
    <Panel defaultSize={35} minSize={15}><p>Original right content</p></Panel>
  </PanelGroup>
}
it('equalizes the actual original library group by double-click while retaining its content and editor selection', async () => {
  const changed = vi.fn(); await render(<OriginalPanels changed={changed} />)
  const editor = host.querySelector('textarea')!; editor.focus(); editor.setSelectionRange(2, 7)
  const right = host.querySelector('p'), handle = host.querySelector<HTMLElement>('[role="separator"]')!
  await act(async () => { handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })) })
  expect(changed).toHaveBeenLastCalledWith(0.5)
  expect(host.querySelector('textarea')).toBe(editor); expect(host.querySelector('p')).toBe(right)
  expect(editor.value).toBe('Retained draft'); expect([editor.selectionStart, editor.selectionEnd]).toEqual([2, 7])
  expect(document.activeElement).toBe(editor)
})
it('gives the actual focused divider explicit Enter equalization without taking an IME-owned key', async () => {
  const changed = vi.fn(); await render(<OriginalPanels changed={changed} />)
  const handle = host.querySelector<HTMLElement>('[role="separator"]')!; handle.focus(); changed.mockClear()
  await act(async () => { handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true })) })
  expect(changed).not.toHaveBeenCalled()
  await act(async () => { handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
  expect(changed).toHaveBeenLastCalledWith(0.5); expect(document.activeElement).toBe(handle)
})
it('keeps an unavailable placement divider from applying equalization to another target', async () => {
  const changed = vi.fn(); await render(<OriginalPanels changed={changed} disabled />); changed.mockClear()
  const handle = host.querySelector<HTMLElement>('[role="separator"]')!
  await act(async () => { handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
  expect(changed).not.toHaveBeenCalled(); expect(host.querySelector('textarea')!.value).toBe('Retained draft')
})
