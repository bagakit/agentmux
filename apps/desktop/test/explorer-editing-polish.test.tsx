const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { FileExplorer } from '../src/renderer/src/components/FileExplorer'
import { WorkflowComponentGallery } from '../src/renderer/src/components/WorkflowComponentGallery'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { installFileTreeGeometry } from './helpers/file-tree-geometry'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const first = { id: 'polish-one', hostId: 'local', name: 'First', path: _hygiene_fixturePath("Users/reader/first"), kind: 'folder' as const }
const second = { ...first, id: 'polish-two', name: 'Second', path: _hygiene_fixturePath("Users/reader/second") }
const originalActions = { renamePath: useAppStore.getState().renamePath, createPath: useAppStore.getState().createPath }
const originalBridge = Object.getOwnPropertyDescriptor(window, 'agentmux')
type WorkspaceMoveResult = Awaited<ReturnType<typeof api.files.move>>
let paths: Record<string, string[]>
let read: ReturnType<typeof vi.spyOn<typeof api.files, 'readDirectory'>>
let move: ReturnType<typeof vi.spyOn<typeof api.files, 'move'>>
let create: ReturnType<typeof vi.spyOn<typeof api.files, 'create'>>
let open: ReturnType<typeof vi.fn>, report: ReturnType<typeof vi.fn>
beforeEach(() => {
  installFileTreeGeometry()
  paths = { [first.id]: ['a.test.ts', '.env', 'folder'], [second.id]: ['a.test.ts', '.env', 'folder'] }
  read = vi.spyOn(api.files, 'readDirectory').mockImplementation(async (id, parent) => {
    expect(paths[id], 'Directory API called with an original Workspace identity').toBeDefined()
    return paths[id]!.filter(path => parent === '' && !path.includes('/')).map(path => ({
      path, name: path, isDirectory: path === 'folder', isSymlink: false
    }))
  })
  move = vi.spyOn(api.files, 'move').mockImplementation(async input => {
    const { workspaceId: id, path } = input.source
    paths[id] = paths[id]!.map(current => current === path ? input.destination.path : current)
    return { status: 'moved' }
  })
  create = vi.spyOn(api.files, 'create').mockImplementation(async (id, input) => { paths[id]!.push(input.path) })
  open = vi.fn(async () => undefined); report = vi.fn()
  Object.defineProperty(window, 'agentmux', { configurable: true, value: { git: {
    status: vi.fn(async () => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: first.path }))
  } } })
  useAppStore.setState({ config: { ...composerConfig, workspaces: [first, second], copyPathsAsAbsolute: false }, localHome: _hygiene_fixturePath("Users/reader"),
    activeWorkspaceId: first.id, sessions: [], tabs: {}, layouts: {}, documents: {}, dirtyDocuments: {}, pinnedItems: {},
    fileExplorerStates: {}, workspaceFileRevisions: {}, lastActiveFileByWorkspace: {}, scratchTopicSnapshots: {},
    agentComposerDrafts: { preserved: 'Original unsent draft' }, error: null, reportError: report, openFile: open, openFileAndReveal: open, ...originalActions })
})
afterEach(() => {
  if (originalBridge) Object.defineProperty(window, 'agentmux', originalBridge)
  else Reflect.deleteProperty(window, 'agentmux')
})
function element<T extends HTMLElement = HTMLElement>(selector: string) {
  const result = dom.container.querySelector<T>(selector)
  expect(result, `Production mounted consumer: ${selector}`).not.toBeNull()
  return result!
}
function input() { return element<HTMLInputElement>('.tree-inline-input') }
async function key(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })))
}
async function value(text: string, target = input()) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(target, text)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function begin(path = 'a.test.ts') {
  const label = element(`[data-tree-path="${path}"] .tree-row__label`)
  await act(async () => label.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
  expect(element('[data-tree-path="' + path + '"] .inline-rename-field')).not.toBeNull()
  return input()
}
async function mount() {
  await dom.render(<FileExplorer />)
  expect([...dom.container.querySelectorAll<HTMLElement>('[data-tree-path]')].map(row => row.dataset.treePath).sort())
    .toEqual(['.env', 'a.test.ts', 'folder'])
  expect(read).toHaveBeenCalledWith(first.id, '')
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('Explorer editing through the actual tree hook and file transaction owner', () => {
  it('uses the same reusable field for double-click, F2 and create, selecting the established file stem', async () => {
    await mount()
    await act(async () => element('[data-tree-path="a.test.ts"] .tree-row__label').click())
    expect(open).toHaveBeenCalledExactlyOnceWith('a.test.ts', undefined, undefined, first.id, expect.any(AbortSignal))
    expect(useAppStore.getState().fileExplorerStates[first.id]!.selection.activePath).toBe('a.test.ts')
    await begin()
    expect([input().selectionStart, input().selectionEnd]).toEqual([0, 6])
    await key(input(), 'Escape')
    for (const path of ['.env', 'folder']) {
      const row = element(`[data-tree-path="${path}"]`)
      await act(async () => row.focus())
      await key(row, 'F2')
      expect([input().selectionStart, input().selectionEnd]).toEqual([0, path.length])
      await key(input(), 'Escape')
    }
    // The toolbar creates in the selected directory; select a root file to request a root sibling.
    await act(async () => element('[data-tree-path="a.test.ts"] .tree-row__label').click())
    open.mockClear()
    await act(async () => element('[title="New file"]').click())
    const created = element<HTMLInputElement>('input[aria-label="New file name"]')
    expect(created.closest('.inline-rename-field')).not.toBeNull()
    await value('created.ts', created)
    await key(created, 'Enter')
    expect(create).toHaveBeenCalledExactlyOnceWith(first.id, { kind: 'file', path: 'created.ts' })
    expect(open).toHaveBeenCalledExactlyOnceWith('created.ts', undefined, undefined, first.id, expect.any(AbortSignal))
    expect(element('[data-tree-path="created.ts"]')).not.toBeNull()
    expect(move).not.toHaveBeenCalled()
    expect(dom.container.querySelectorAll('.tree-row__actions')).toHaveLength(0)
  })

  it('keeps pending read only and writes Enter then blur once through the original Workspace file owner', async () => {
    const write = deferred<WorkspaceMoveResult>()
    move.mockImplementationOnce(() => write.promise)
    await mount(); await begin(); await value('renamed.ts')
    await act(async () => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      element<HTMLInputElement>('.file-search input').focus()
    })
    expect(move).toHaveBeenCalledExactlyOnceWith({ source: { workspaceId: first.id, path: 'a.test.ts' },
      destination: { workspaceId: first.id, path: 'renamed.ts' } })
    const pendingFacts = { readOnly: input().readOnly, busy: input().getAttribute('aria-busy') }
    await key(input(), 'Enter'); await key(input(), 'Escape')
    expect(move).toHaveBeenCalledTimes(1)
    expect(input().value).toBe('renamed.ts')
    paths[first.id] = paths[first.id]!.map(path => path === 'a.test.ts' ? 'renamed.ts' : path)
    await act(async () => write.resolve({ status: 'moved' }))
    // Resolve the admitted transaction before assertions that intentionally fail under a mutant.
    expect(pendingFacts).toEqual({ readOnly: true, busy: 'true' })
    expect(dom.container.querySelector('.tree-inline-input')).toBeNull()
    expect(element('[data-tree-path="renamed.ts"]')).not.toBeNull()
    expect(useAppStore.getState().agentComposerDrafts.preserved).toBe('Original unsent draft')
    expect(useAppStore.getState().activeWorkspaceId).toBe(first.id)
    expect(report).not.toHaveBeenCalled()
  })

  it('keeps a failed draft and caller error retryable without stealing focus or reselecting the stem', async () => {
    const write = deferred<WorkspaceMoveResult>()
    move.mockImplementationOnce(() => write.promise)
    await mount(); await begin(); await value('taken.ts')
    const search = element<HTMLInputElement>('.file-search input')
    await act(async () => { input().setSelectionRange(2, 4); search.focus() })
    await act(async () => write.reject(new Error('Destination already exists')))
    const failed = input(), error = element('[role="alert"]')
    expect(failed.value).toBe('taken.ts')
    expect(failed.readOnly).toBe(false)
    expect(failed.getAttribute('aria-describedby')).toBe(error.id)
    expect(error.textContent).toContain('Destination already exists')
    expect(document.activeElement).toBe(search)
    await act(async () => failed.focus())
    expect([failed.selectionStart, failed.selectionEnd]).toEqual([2, 4])
    await value('available.ts')
    expect(dom.container.querySelector('[role="alert"]')).toBeNull()
    await key(input(), 'Enter')
    expect(move).toHaveBeenCalledTimes(2)
    expect(move).toHaveBeenLastCalledWith({ source: { workspaceId: first.id, path: 'a.test.ts' },
      destination: { workspaceId: first.id, path: 'available.ts' } })
    expect(element('[data-tree-path="available.ts"]')).not.toBeNull()
    expect(dom.container.querySelector('.tree-inline-input')).toBeNull()
    expect(report).toHaveBeenCalledTimes(1)
  })

  it('waits for final IME composition after blur, retaining final characters in the actual rename transaction', async () => {
    await mount(); await begin()
    await act(async () => input().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    await value('候选.ts'); await key(input(), 'Enter', { isComposing: true, keyCode: 229 })
    await act(async () => element<HTMLInputElement>('.file-search input').focus())
    expect(move).not.toHaveBeenCalled()
    // Keep the React draft at the candidate value: compositionend owns the final DOM characters.
    await act(async () => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), '最终.ts'))
    await act(async () => {
      input().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 5))
    })
    expect(move).toHaveBeenCalledExactlyOnceWith({ source: { workspaceId: first.id, path: 'a.test.ts' },
      destination: { workspaceId: first.id, path: '最终.ts' } })
    expect(element('[data-tree-path="最终.ts"]')).not.toBeNull()
    expect(dom.container.querySelector('.tree-inline-input')).toBeNull()
  })

  it('keeps final IME characters after a real move failure and retries the same final name', async () => {
    const write = deferred<WorkspaceMoveResult>()
    move.mockImplementationOnce(() => write.promise)
    await mount(); await begin()
    await act(async () => input().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    await value('候选.ts')
    const search = element<HTMLInputElement>('.file-search input')
    await act(async () => search.focus())
    await act(async () => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), '最终.ts'))
    await act(async () => {
      input().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 5))
    })
    expect(move).toHaveBeenCalledExactlyOnceWith({ source: { workspaceId: first.id, path: 'a.test.ts' },
      destination: { workspaceId: first.id, path: '最终.ts' } })
    await act(async () => write.reject(new Error('Destination already exists')))
    expect(input().value).toBe('最终.ts')
    expect(element('[role="alert"]').textContent).toContain('Destination already exists')
    expect(document.activeElement).toBe(search)
    await act(async () => input().focus())
    await key(input(), 'Enter')
    expect(move).toHaveBeenCalledTimes(2)
    expect(move).toHaveBeenLastCalledWith({ source: { workspaceId: first.id, path: 'a.test.ts' },
      destination: { workspaceId: first.id, path: '最终.ts' } })
    expect(element('[data-tree-path="最终.ts"]')).not.toBeNull()
    expect(dom.container.querySelector('.tree-inline-input')).toBeNull()
  })

  it('gives a replacement create intent fresh focus and ignores the previous composing field', async () => {
    await mount()
    open.mockClear()
    await act(async () => element('[title="New file"]').click())
    const previous = input()
    await act(async () => previous.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    await value('候选.ts', previous)
    const nextAction = element<HTMLButtonElement>('[title="New folder"]')
    await act(async () => { nextAction.focus(); nextAction.click() })
    const current = element<HTMLInputElement>('input[aria-label="New folder name"]')
    const focusOnNewIntent = document.activeElement === current
    const initialSelection = [current.selectionStart, current.selectionEnd]
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(previous, '旧意图.ts')
      previous.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 5))
    })
    expect(create).not.toHaveBeenCalled()
    expect(current).not.toBe(previous)
    expect(focusOnNewIntent).toBe(true)
    expect(initialSelection).toEqual([0, 0])
    expect(current.value).toBe('')
    await value('new-folder', current); await key(current, 'Enter')
    expect(create).toHaveBeenCalledExactlyOnceWith(first.id, { kind: 'directory', path: 'new-folder' })
    expect(open).not.toHaveBeenCalled()
    expect(element('[data-tree-path="new-folder"]')).not.toBeNull()
  })

  it.each(['workspace', 'same-id-root'] as const)('does not project a late failed rename into a new %s edit', async change => {
    const write = deferred<WorkspaceMoveResult>()
    move.mockImplementationOnce(() => write.promise)
    await mount(); await begin(); await value('old-intent.ts'); await key(input(), 'Enter')
    expect(move).toHaveBeenCalledTimes(1)
    const current = change === 'workspace' ? second : { ...first, path: _hygiene_fixturePath("Users/reader/rebound") }
    await act(async () => useAppStore.setState({ activeWorkspaceId: current.id,
      config: { ...useAppStore.getState().config!, workspaces: change === 'workspace' ? [first, second] : [current, second] } }))
    expect(dom.container.querySelector('.tree-inline-input')).toBeNull()
    await begin(); await value('new-intent.ts')
    await act(async () => write.reject(new Error('Old scope move failed')))
    expect(input().value).toBe('new-intent.ts')
    expect(input().getAttribute('aria-invalid')).toBe('false')
    expect(input().readOnly).toBe(false)
    expect(document.activeElement).toBe(input())
    expect(dom.container.querySelector('[role="alert"]')).toBeNull()
    expect(move.mock.calls[0]![0].source.workspaceId).toBe(first.id)
    await key(input(), 'Escape')
    expect(move).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().agentComposerDrafts.preserved).toBe('Original unsent draft')
  })

  it('provides an operable reusable gallery example with a readable collision and successful retry', async () => {
    await dom.render(<WorkflowComponentGallery />)
    await act(async () => element('#inline-rename .wf-gallery__rename-name').click())
    const example = element<HTMLInputElement>('input[aria-label="Rename example file"]')
    expect(example.closest('.inline-rename-field')).not.toBeNull()
    expect([example.selectionStart, example.selectionEnd]).toEqual([0, 6])
    await value('package.json', example)
    await key(example, 'Enter')
    expect(example.readOnly).toBe(true)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 190)) })
    expect(example.value).toBe('package.json')
    expect(element('#inline-rename [role="alert"]').textContent).toContain('already exists')
    await value('guide.md', example); await key(example, 'Enter')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 190)) })
    expect(element('#inline-rename .wf-gallery__rename-name').textContent).toBe('guide.md')
    expect(dom.container.querySelector('#inline-rename .inline-rename-field')).toBeNull()
    expect(move).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled()
  })
})
