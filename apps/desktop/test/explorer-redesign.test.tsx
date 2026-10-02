const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
const fixture = vi.hoisted(() => ({ refresh: vi.fn(async () => true), refreshDir: vi.fn(async () => true), load: vi.fn(async () => true) }))
vi.mock('../src/renderer/src/hooks/useGitStatus', () => ({ useGitStatus: () => ({
  status: { kind: 'git-repository', hostId: 'local', repoPath: _hygiene_fixturePath("Users/reader/project"), repoRelativePrefix: '', branch: 'main',
    changes: [{ path: 'one.ts', indexStatus: ' ', worktreeStatus: 'M', staged: false, untracked: false }] },
  loading: false, error: null, refresh: fixture.refresh
}) }))
vi.mock('../src/renderer/src/hooks/useWorkspaceBranches', () => ({ useWorkspaceBranches: () => ({
  snapshot: { kind: 'git-repository', hostId: 'local', repoPath: _hygiene_fixturePath("Users/reader/project"), branches: [
    { name: 'main', worktreePath: _hygiene_fixturePath("Users/reader/project"), workspaceId: 'one', isCurrent: true },
    { name: 'other', worktreePath: _hygiene_fixturePath("Users/reader/worktrees/other"), workspaceId: 'other', isCurrent: false }
  ] }, loading: false, error: null, refresh: fixture.refresh
}) }))
vi.mock('../src/renderer/src/hooks/useGitAheadBehind', () => ({ useGitAheadBehind: () => ({ facts: null }) }))
vi.mock('../src/renderer/src/components/file-tree/useWorkspaceFileTree', async importOriginal => ({
  ...await importOriginal<typeof import('../src/renderer/src/components/file-tree/useWorkspaceFileTree')>(),
  useWorkspaceFileTree: () => ({
    dirCache: {}, rootCache: { children: [
      { path: 'src', name: 'src', isDirectory: true, isSymlink: false, depth: 0 },
      { path: 'one.ts', name: 'one.ts', isDirectory: false, isSymlink: false, depth: 0 },
      { path: 'alias.ts', name: 'alias.ts', isDirectory: false, isSymlink: true, linkTarget: _hygiene_fixturePath("Users/reader/project/one.ts"), depth: 0 }
    ] }, rootError: null, refreshTree: fixture.refresh, refreshDir: fixture.refreshDir,
    loadDir: fixture.load, isDirStale: () => false
  })
}))

import { FileExplorer } from '../src/renderer/src/components/FileExplorer'
import { SurfaceToolDock } from '../src/renderer/src/components/SurfaceToolDock'
import { ChangesPanel } from '../src/renderer/src/components/ChangesPanel'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const workspace = { id: 'one', name: 'Project one', hostId: 'local', path: _hygiene_fixturePath("Users/reader/project"), branch: 'main', kind: 'folder' as const }
const second = { ...workspace, id: 'two', name: 'Project two', path: _hygiene_fixturePath("Users/reader/second") }
const open = vi.fn(async () => undefined)
const rename = vi.fn<(source: string, destination: string, workspaceId?: string) => Promise<void>>()
beforeEach(() => {
  vi.clearAllMocks(); rename.mockResolvedValue(undefined)
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace, second] }, localHome: _hygiene_fixturePath("Users/reader"),
    activeWorkspaceId: 'one', workspaceTool: 'files-branches', projectRailOpen: true, sessions: [],
    fileExplorerStates: {}, explorerCollapsed: {}, workspaceFileRevisions: {}, dirtyDocuments: {},
    lastActiveFileByWorkspace: {}, layouts: {}, tabs: {}, pinnedItems: {}, openFile: open, renamePath: rename })
})
function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = dom.container.querySelector<T>(selector)
  expect(found, `Actual mounted element: ${selector}`).not.toBeNull()
  return found!
}
async function event(target: HTMLElement, kind: string, init: MouseEventInit = {}) {
  await act(async () => target.dispatchEvent(new MouseEvent(kind, { bubbles: true, ...init })))
}
async function key(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key, ...init })))
}
async function value(target: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(target, text)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function begin(path = 'one.ts') {
  const label = element<HTMLButtonElement>(`[data-tree-path="${path}"] .tree-row__label`)
  await event(label, 'click'); await event(label, 'click', { detail: 2 }); await event(label, 'dblclick')
  return element<HTMLInputElement>(`[data-tree-path="${path}"] .tree-inline-input`)
}

describe('actual Explorer shared header and interactions', () => {
  it('puts original FileExplorer actions into one project header and keeps collapsed recovery reachable', async () => {
    await dom.render(<SurfaceToolDock workspace={workspace} />)
    const header = element('.workspace-tool-context--explorer')
    expect(header.querySelector('strong')!.textContent).toBe('Project one')
    expect(header.querySelector('[title="New file"]')).not.toBeNull()
    expect(dom.container.querySelectorAll('.explorer-header')).toHaveLength(0)
    expect(dom.container.querySelectorAll('.branches-repo')).toHaveLength(0)
    expect(element('[aria-label="Branch actions"]').textContent!.trim()).toBe('2')
    await event(element('[title="New file"]'), 'click')
    expect(element<HTMLInputElement>('[placeholder="file name"]').value).toBe('')
    await key(element('[placeholder="file name"]'), 'Escape')
    await event(element('[aria-label="Hide file tree"]'), 'click')
    expect(dom.container.querySelector('.file-explorer')).toBeNull()
    expect(element('[aria-label="Show file tree"]').getAttribute('aria-expanded')).toBe('false')
    expect(dom.container.querySelector('[title="New file"]')).toBeNull()
    await event(element('[aria-label="Show file tree"]'), 'click')
    expect(element('.workspace-tool-context--explorer [title="New file"]')).not.toBeNull()
    expect(useAppStore.getState().activeWorkspaceId).toBe('one')
    expect(rename).not.toHaveBeenCalled()
  })

  it('selects names without activation, double-clicks inline rename, and opens through icon/Enter/disclosure', async () => {
    await dom.render(<FileExplorer />)
    await event(element('[data-tree-path="one.ts"] .tree-row__label'), 'click')
    expect(useAppStore.getState().fileExplorerStates.one!.selection.activePath).toBe('one.ts')
    expect(open).not.toHaveBeenCalled()
    await begin()
    expect(open).not.toHaveBeenCalled()
    expect(dom.container.querySelector('.tree-row__actions')).toBeNull()
    await key(element('.tree-inline-input'), 'Escape')
    expect(dom.container.querySelector('.tree-inline-input')).toBeNull()
    expect(element('[data-tree-path="one.ts"] .tree-row__label').title).toBe('~/project/one.ts\nDouble-click to rename (F2)')
    // With the name anchored to its text width, the remaining grid area targets the row itself.
    await event(element('[data-tree-path="one.ts"]'), 'click')
    expect(open).toHaveBeenCalledWith('one.ts', undefined, undefined, workspace.id)
    open.mockClear()
    await event(element('[data-tree-path="one.ts"] .tree-row__icon'), 'click')
    expect(open).toHaveBeenCalledWith('one.ts', undefined, undefined, workspace.id)
    open.mockClear()
    await key(element('[data-tree-path="one.ts"]'), 'Enter')
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith('one.ts', undefined, undefined, workspace.id)
    await event(element('[data-tree-path="src"] .tree-row__label'), 'click')
    expect(element('[data-tree-path="src"]').getAttribute('aria-expanded')).toBe('false')
    await event(element('[data-tree-path="src"] .tree-row__disclosure'), 'click')
    expect(element('[data-tree-path="src"]').getAttribute('aria-expanded')).toBe('true')
    await act(async () => element('[data-tree-path="one.ts"]').focus())
    await key(element('[data-tree-path="one.ts"]'), 'F2')
    expect(element<HTMLInputElement>('.tree-inline-input').value).toBe('one.ts')
  })

  it('keeps modifier selection separate from rename and opens the real keyboard menu/delete confirmation', async () => {
    await dom.render(<FileExplorer />)
    await event(element('[data-tree-path="one.ts"] .tree-row__label'), 'click')
    await event(element('[data-tree-path="alias.ts"] .tree-row__label'), 'click', { shiftKey: true })
    await event(element('[data-tree-path="alias.ts"] .tree-row__label'), 'dblclick', { shiftKey: true })
    expect([...useAppStore.getState().fileExplorerStates.one!.selection.selectedPaths]).toEqual(['one.ts', 'alias.ts'])
    expect(dom.container.querySelector('.tree-inline-input')).toBeNull()
    expect(open).not.toHaveBeenCalled()
    await act(async () => element('[data-tree-path="one.ts"]').focus())
    await key(element('[data-tree-path="one.ts"]'), 'F10', { shiftKey: true })
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(items.length).toBeGreaterThan(0)
    expect(items.some(item => item.textContent?.startsWith('Rename'))).toBe(true)
    const remove = items.find(item => item.textContent?.startsWith('Delete'))!
    expect(remove).toBeDefined(); await event(remove, 'click')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Delete file?')
    expect(rename).not.toHaveBeenCalled()
  })

  it('keeps IME Enter uncommitted and admits Enter followed by blur exactly once', async () => {
    let finish!: () => void
    rename.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await dom.render(<FileExplorer />)
    const input = await begin()
    await value(input, 'renamed.ts')
    await key(input, 'Enter', { isComposing: true })
    expect(rename).not.toHaveBeenCalled()
    await key(input, 'Enter')
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(rename).toHaveBeenCalledTimes(1)
    expect(rename).toHaveBeenCalledWith('one.ts', 'renamed.ts', 'one')
    expect(input.readOnly).toBe(true)
    await act(async () => finish())
    expect(dom.container.querySelector('.tree-inline-input')).toBeNull()
    expect(fixture.refreshDir.mock.calls.map(call => call[0])).toEqual([''])
  })

  it('preserves the failed name for retry and never retargets an outstanding transaction to another workspace', async () => {
    rename.mockRejectedValueOnce(new Error("Error invoking remote method 'files:move': Error: Destination already exists"))
    await dom.render(<FileExplorer />)
    let input = await begin(); await value(input, 'retry.ts'); await key(input, 'Enter')
    expect(element<HTMLInputElement>('.tree-inline-input').value).toBe('retry.ts')
    expect(element('[role="alert"]').textContent).toBe('Destination already exists')
    await key(input, 'Enter')
    expect(rename).toHaveBeenCalledTimes(2)
    expect(dom.container.querySelector('.tree-inline-input')).toBeNull()
    let finish!: () => void
    rename.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    input = await begin(); await value(input, 'captured.ts'); await key(input, 'Enter')
    await act(async () => useAppStore.setState({ activeWorkspaceId: 'two' }))
    expect(rename.mock.calls.at(-1)).toEqual(['one.ts', 'captured.ts', 'one'])
    await act(async () => finish())
    expect(useAppStore.getState().activeWorkspaceId).toBe('two')
    expect(dom.container.querySelector('.tree-inline-input')).toBeNull()
  })

  it('consumes project path settings in the shared header, file/link hover and distinct worktrees', async () => {
    await dom.render(<SurfaceToolDock workspace={workspace} />)
    expect(element('.workspace-tool-context--explorer > span').title).toBe('~/project')
    expect(element('[data-tree-path="alias.ts"]').title).toBe('~/project/alias.ts → ~/project/one.ts · File link')
    const worktree = element('.branch-row .selector-row__identity small')
    expect([worktree.textContent, worktree.title]).toEqual(['~/worktrees/other', '~/worktrees/other'])
    const config = useAppStore.getState().config!
    await act(async () => useAppStore.setState({ config: { ...config, copyPathsAsAbsolute: true } }))
    expect(element('.workspace-tool-context--explorer > span').title).toBe(workspace.path)
    expect(element('[data-tree-path="one.ts"]').title).toBe(`${workspace.path}/one.ts`)
    expect(element('.branch-row .selector-row__identity small').title).toBe(_hygiene_fixturePath("Users/reader/worktrees/other"))
    expect(useAppStore.getState().config!.workspaces[0]).toBe(workspace)
  })

  it('discards an old edit failure after the same workspace rebinds its physical path', async () => {
    let fail!: (error: Error) => void
    rename.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject }))
    await dom.render(<FileExplorer />)
    await value(await begin(), 'old-directory.ts')
    await key(element('.tree-inline-input'), 'Enter')
    expect(rename.mock.calls).toEqual([['one.ts', 'old-directory.ts', 'one']])
    const current = useAppStore.getState().config!
    await act(async () => useAppStore.setState({ config: { ...current, workspaces: [{ ...workspace, path: _hygiene_fixturePath("Users/reader/rebound") }, second] } }))
    await act(async () => fail(new Error('Old directory failure')))
    expect(element('[data-tree-path="one.ts"]').title).toBe('~/rebound/one.ts')
    expect(dom.container.querySelector('.tree-inline-input')).toBeNull()
    expect(dom.container.querySelector('[role="alert"]')).toBeNull()
  })

  it('uses one keyboard-accessible Git navigation plane without duplicate panel titles', async () => {
    await dom.render(<SurfaceToolDock workspace={workspace} />)
    expect(element('[role="tablist"]').className).toBe('source-control-switch')
    const branches = element<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
    await key(branches, 'ArrowRight')
    const changes = element<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
    expect(changes.textContent).toBe('Changes')
    expect(document.activeElement).toBe(changes)
    expect(element('[aria-label="Change actions"]').textContent!.trim()).toBe('1')
    expect(element('.changes-repository-context').textContent).toContain('main')
    expect(element('.changes-repository-context [title="Fetch from remote"]')).toBeDefined()
    expect(element('.changes-repository-context [aria-label="Open a pull request"]')).toBeDefined()
    await key(changes, 'Home')
    expect(element('[role="tab"][aria-selected="true"]').textContent).toBe('Branches')
  })

  it('loads actual control styles with nonempty surfaces and keeps static material/focus signals', () => {
    const dock = readFileSync(resolve('apps/desktop/src/renderer/src/styles/dock.css'), 'utf8')
    const control = readFileSync(resolve('apps/desktop/src/renderer/src/styles/source-control.css'), 'utf8')
    const file = readFileSync(resolve('apps/desktop/src/renderer/src/styles/file-explorer.css'), 'utf8')
    const selectors = [...control.matchAll(/([^{}]+)\{/g)].map(match => match[1]!.trim())
    expect(selectors.length).toBeGreaterThan(0)
    expect(dock).toContain('var(--material-control-surface)')
    expect(control).toContain('var(--material-control-surface)')
    expect(control).toContain('.source-control-switch button:focus-visible')
    expect(control).toContain('prefers-reduced-motion: reduce')
    const context = control.match(/\.changes-repository-context \{([^}]+)\}/)
    expect(context).not.toBeNull()
    expect(context![1]).toContain('display: flex')
    const label = file.match(/^\.tree-row__label \{([^}]+)\}/m)
    expect(label).not.toBeNull()
    expect(label![1]).toContain('justify-self: start')
    expect(label![1]).toContain('max-width: 100%')
    const icon = file.match(/\.tree-row__icon \{([^}]+)\}/)
    expect(icon).not.toBeNull()
    expect(icon![1]).toContain('width: 24px')
    expect(icon![1]).toContain('height: 24px')
  })

  it('keeps compact Changes status and focused stage/discard wired to original Git coordinates', async () => {
    const stage = vi.fn(async () => undefined), discard = vi.fn(async () => undefined)
    const original = window.agentmux
    Object.defineProperty(window, 'agentmux', { configurable: true, value: { git: { stage, discard } } })
    try {
      await dom.render(<ChangesPanel workspace={workspace} />)
      const mark = element('.change-row__state')
      expect([mark.textContent, mark.title, mark.getAttribute('aria-label')]).toEqual(['M', 'Modified', 'Modified'])
      const stageButton = element<HTMLButtonElement>('[aria-label="Stage one.ts"]')
      await act(async () => stageButton.focus())
      expect(document.activeElement).toBe(stageButton)
      await event(stageButton, 'click')
      expect(stage.mock.calls).toEqual([['one', 'one.ts']])
      const discardButton = element<HTMLButtonElement>('[aria-label="Discard one.ts"]')
      await event(discardButton, 'click')
      expect(discard).not.toHaveBeenCalled()
      expect(element('[aria-label="Confirm discard one.ts"]').classList.contains('change-row__discard--armed')).toBe(true)
      await event(element('[aria-label="Confirm discard one.ts"]'), 'click')
      expect(discard.mock.calls).toEqual([['one', 'one.ts', false]])
      expect(fixture.refresh).toHaveBeenCalledTimes(2)
    } finally { Object.defineProperty(window, 'agentmux', { configurable: true, value: original }) }
  })
})
