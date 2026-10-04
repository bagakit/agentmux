import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, useRef, useState } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { QuickOpenFiles } from '../src/renderer/src/components/QuickOpenFiles'
import { QuickSwitcher } from '../src/renderer/src/components/QuickSwitcher'
import { api } from '../src/renderer/src/lib/api'
import { quickFileQuery, rankQuickFiles } from '../src/renderer/src/lib/quick-open-files'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM(), workspace = composerConfig.workspaces[0]!
const listing = { status: 'listed' as const, files: ['nested/中文 notes.md', 'src/main.ts', 'literal:12'], complete: true, omitted: 'git-ignored' as const, partialReason: null }
let frames: FrameRequestCallback[]
beforeEach(() => {
  frames = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length })
  useAppStore.setState({ activeWorkspaceId: workspace.id, mainSurface: 'agents', layouts: {}, tabs: {},
    openFileAndReveal: vi.fn(async () => true) })
  vi.spyOn(api.files, 'list').mockResolvedValue(listing)
})
async function input(value: string) {
  const field = document.querySelector<HTMLInputElement>('[aria-label="Find project files"]')!
  expect(field).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return field
}
async function key(field: HTMLElement, value: string, isComposing = false) {
  await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: value, isComposing, bubbles: true })))
}
async function flush() { await act(async () => { frames.splice(0).forEach(callback => callback(0)) }) }
it('uses shared ranking and location parsing while literal colon filenames and Unicode spaces remain exact paths', () => {
  expect(quickFileQuery('nested/中文 notes.md:12:3', listing.files)).toEqual({ query: 'nested/中文 notes.md', location: { line: 12, column: 3 } })
  expect(quickFileQuery('literal:12', listing.files)).toEqual({ query: 'literal:12', location: undefined })
  expect(quickFileQuery('src/main.ts:0', listing.files).location).toBeUndefined()
  expect(rankQuickFiles(listing.files, ['src/main.ts'], '')).toEqual(['src/main.ts', 'literal:12', 'nested/中文 notes.md'])
})
it('discovers once, ranks input locally, respects IME and closes the original overlay before opening and revealing', async () => {
  const close = vi.fn()
  await dom.render(<QuickOpenFiles onClose={close} />)
  expect(api.files.list).toHaveBeenCalledExactlyOnceWith(workspace.id)
  await input('main'); const field = await input('nested/中文 notes.md:12:3')
  expect(api.files.list).toHaveBeenCalledTimes(1)
  await key(field, 'Enter', true); await flush()
  expect(close).not.toHaveBeenCalled(); expect(useAppStore.getState().openFileAndReveal).not.toHaveBeenCalled()
  await key(field, 'Enter')
  expect(close).toHaveBeenCalledOnce(); expect(useAppStore.getState().openFileAndReveal).not.toHaveBeenCalled()
  await flush()
  expect(useAppStore.getState().openFileAndReveal).toHaveBeenCalledExactlyOnceWith('nested/中文 notes.md', undefined, { line: 12, column: 3 }, workspace.id)
})
it('discarded discovery cannot replace a newer Workspace, and closing cancels its reader without opening anything', async () => {
  let late!: (value: typeof listing) => void
  vi.mocked(api.files.list).mockImplementationOnce(() => new Promise(resolve => { late = resolve }))
  await dom.render(<QuickOpenFiles onClose={() => {}} />)
  await act(async () => useAppStore.setState({ config: { ...composerConfig, workspaces: [...composerConfig.workspaces,
    { ...workspace, id: 'other', path: _hygiene_fixturePath("other"), name: 'Other' }] }, activeWorkspaceId: 'other' }))
  await act(async () => late({ ...listing, files: ['foreign-late.txt'] }))
  expect(dom.container.textContent).not.toContain('foreign-late.txt')
  expect(useAppStore.getState().openFileAndReveal).not.toHaveBeenCalled()
  await dom.render(<div />)
  expect(useAppStore.getState().openFileAndReveal).not.toHaveBeenCalled()
})
it('retains open files during discovery failure, retries visibly, and never intercepts Enter on a Retry or result button', async () => {
  const tab = createWorkbenchTab('original', { kind: 'file', workspaceId: workspace.id, path: 'recent.ts', regionId: 'original-region' })
  useAppStore.setState({ tabs: { original: tab } })
  vi.mocked(api.files.list).mockRejectedValueOnce(new Error('Original Host unavailable'))
  const close = vi.fn(); await dom.render(<QuickOpenFiles onClose={close} />)
  expect(dom.container.textContent).toContain('recent.ts'); expect(dom.container.textContent).toContain('Original Host unavailable')
  const retry = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry')!
  await key(retry, 'Enter'); await flush(); expect(close).not.toHaveBeenCalled()
  await act(async () => retry.click()); expect(api.files.list).toHaveBeenCalledTimes(2)
  const target = [...dom.container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(button => button.textContent?.includes('literal:12'))!
  await key(target, 'Enter'); await flush(); expect(close).not.toHaveBeenCalled()
  await act(async () => target.click()); await flush()
  expect(useAppStore.getState().openFileAndReveal).toHaveBeenCalledExactlyOnceWith('literal:12', undefined, undefined, workspace.id)
})
it('keeps literal colon names exact for open files omitted from the project listing', async () => {
  const tab = createWorkbenchTab('original', { kind: 'file', workspaceId: workspace.id, path: 'ignored/note:12', regionId: 'original-region' })
  useAppStore.setState({ tabs: { original: tab } })
  await dom.render(<QuickOpenFiles onClose={() => {}} />)
  await key(await input('ignored/note:12'), 'Enter'); await flush()
  expect(useAppStore.getState().openFileAndReveal).toHaveBeenCalledExactlyOnceWith('ignored/note:12', undefined, undefined, workspace.id)
})
it('cancels a delayed activation after newer human navigation, but allows an unrelated layout refresh', async () => {
  await dom.render(<QuickOpenFiles onClose={() => {}} />)
  const field = await input('main.ts')
  await key(field, 'Enter')
  await act(async () => useAppStore.setState({ mainSurface: 'survey' }))
  await flush(); expect(useAppStore.getState().openFileAndReveal).not.toHaveBeenCalled()
  await act(async () => useAppStore.setState({ mainSurface: 'agents' }))
  await key(field, 'Enter')
  await act(async () => useAppStore.setState(state => ({ layouts: { ...state.layouts } })))
  await flush(); expect(useAppStore.getState().openFileAndReveal).toHaveBeenCalledOnce()
})
it('adds project files to the existing QuickSwitcher Dialog, returns to the same original input on cancel and performs no discovery while closed', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 600, 400))
  function Shell() {
    const [open, setOpen] = useState(false)
    const source = useRef<HTMLTextAreaElement>(null)
    return <><textarea ref={source} defaultValue="Original unsaved input" /><button onClick={() => setOpen(true)}>Open switcher</button>
      <QuickSwitcher open={open} onClose={() => setOpen(false)} returnFocus={() => source.current} /></>
  }
  await dom.render(<Shell />); expect(api.files.list).not.toHaveBeenCalled()
  const source = dom.container.querySelector('textarea')!
  await act(async () => source.focus()); source.setSelectionRange(2, 7)
  await dom.click('button')
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
  const mode = [...document.querySelectorAll<HTMLButtonElement>('.quick-switch__modes button')].find(button => button.textContent === 'Project files')!
  await act(async () => mode.click())
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
  expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Open a project file')
  expect(api.files.list).toHaveBeenCalledTimes(1)
  const field = await input('nested'); await key(field, 'Escape')
  await act(async () => new Promise(resolve => setTimeout(resolve, 5)))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(useAppStore.getState().openFileAndReveal).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(source)
  expect([source.value, source.selectionStart, source.selectionEnd]).toEqual(['Original unsaved input', 2, 7])
})
