// @vitest-environment happy-dom
import { act, useEffect, useRef } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { FileExplorer } from '../src/renderer/src/components/FileExplorer'
import { EditorPane } from '../src/renderer/src/components/EditorPane'
import { api } from '../src/renderer/src/lib/api'
import { createEmptyFileExplorerViewState } from '../src/renderer/src/lib/file-explorer-selection'
import { documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { restorePersistedUiState, useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { installFileTreeGeometry } from './helpers/file-tree-geometry'

const monaco = vi.hoisted(() => ({ mounts: 0, model: { identity: 'original-model' }, options: null as { minimap: { enabled: boolean } } | null }))
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('@monaco-editor/react', () => ({
  default: ({ path, value, options, onMount }: {
    path: string; value: string; options: typeof monaco.options
    onMount(editor: unknown, monaco: unknown): void
  }) => {
    monaco.options = options
    const host = useRef<HTMLTextAreaElement>(null)
    useEffect(() => {
      monaco.mounts++
      const callbacks: (() => void)[] = []
      const editor = {
        addCommand: vi.fn(), addAction: vi.fn(),
        createContextKey: () => ({ set: vi.fn() }),
        onDidChangeCursorSelection: () => ({ dispose: vi.fn() }),
        onDidDispose: (callback: () => void) => { callbacks.push(callback); return { dispose: vi.fn() } },
        getModel: () => monaco.model,
        saveViewState: () => ({ cursor: 7, scrollTop: 133 }),
        restoreViewState: vi.fn(), getContainerDomNode: () => host.current,
        focus: () => host.current?.focus(), revealLineInCenter: vi.fn(), setPosition: vi.fn()
      }
      onMount(editor, { KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 }, KeyCode: { KeyE: 35, KeyS: 49, KeyZ: 56, F1: 59 } })
      return () => callbacks.forEach(callback => callback())
    }, [])
    return <textarea ref={host} data-model-path={path} value={value} readOnly />
  },
  DiffEditor: () => null
}))

const dom = composerDOM(), workspace = composerConfig.workspaces[0]!
const key = documentKey(workspace.id, 'main.ts')
const draft = { path: 'main.ts', content: 'Original unsaved draft', revision: 'original-revision' }
const entries = {
  '': [
    { path: '.env', name: '.env', isDirectory: false },
    { path: '.config', name: '.config', isDirectory: true },
    { path: 'cache', name: 'cache', isDirectory: true, ignored: true },
    { path: 'source', name: 'source', isDirectory: true },
    { path: 'plain.ts', name: 'plain.ts', isDirectory: false }
  ],
  '.config': [{ path: '.config/settings.json', name: 'settings.json', isDirectory: false }],
  cache: [{ path: 'cache/result.json', name: 'result.json', isDirectory: false }],
  source: [{ path: 'source/main.ts', name: 'main.ts', isDirectory: false }]
}
beforeEach(() => {
  installFileTreeGeometry()
  monaco.mounts = 0; monaco.options = null
  useAppStore.setState({ activeWorkspaceId: workspace.id, fileExplorerStates: {},
    lastActiveFileByWorkspace: {}, workspaceFileRevisions: {}, documents: { [key]: draft },
    dirtyDocuments: { [key]: true }, documentIssues: {}, savingDocuments: {}, editorRegionModes: {},
    editorMinimap: false, explorerShowHidden: true, explorerShowIgnored: true, regionCaretFocus: null })
  vi.spyOn(api.files, 'readDirectory').mockImplementation(async (_id, path) =>
    (entries[path as keyof typeof entries] ?? []).map(entry => ({ ...entry, isSymlink: false })))
})
function row(path: string) { return dom.container.querySelector<HTMLElement>(`[data-tree-path="${path}"]`) }
async function menu(label: string) {
  const trigger = dom.container.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  expect(trigger).not.toBeNull()
  await act(async () => { trigger!.focus(); trigger!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
  expect(document.querySelector('[role="menu"]')).not.toBeNull()
}
async function choose(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(element => element.textContent?.includes(label))
  expect(item).toBeDefined()
  await act(async () => { item!.focus(); item!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
}
async function settleEditor() { await act(async () => { await vi.dynamicImportSettled(); await new Promise(resolve => setTimeout(resolve, 0)) }) }
async function expand(path: string) {
  expect(row(path)).not.toBeNull()
  await act(async () => row(path)!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })))
}
it('the real File options menu toggles Monaco minimap without remounting its model or replacing its draft', async () => {
  await dom.render(<EditorPane tabId="tab" surface={{ regionId: 'source-region', kind: 'file', workspaceId: workspace.id, path: 'main.ts' }} />)
  await settleEditor()
  const originalWidget = dom.container.querySelector('textarea')!
  expect(originalWidget).not.toBeNull(); expect(monaco.mounts).toBe(1)
  expect(monaco.options?.minimap.enabled).toBe(false)
  const modelPath = originalWidget.dataset.modelPath
  expect(modelPath).toContain('source-region')
  await menu('File options'); await choose('Minimap')
  expect(useAppStore.getState().editorMinimap).toBe(true)
  expect(monaco.options?.minimap.enabled).toBe(true)
  expect(dom.container.querySelector('textarea')).toBe(originalWidget)
  expect(originalWidget.dataset.modelPath).toBe(modelPath); expect(monaco.mounts).toBe(1)
  expect(monaco.model.identity).toBe('original-model')
  expect(useAppStore.getState().documents[key]).toBe(draft)
  expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
  await choose('Minimap')
  expect(monaco.options?.minimap.enabled).toBe(false); expect(monaco.mounts).toBe(1)
})
it('visibility menus use original hidden names and Git ignored entries, retaining cache and selection', async () => {
  await dom.render(<FileExplorer />)
  await expand('.config'); await expand('cache')
  expect(row('.env')).not.toBeNull(); expect(row('.config/settings.json')).not.toBeNull()
  expect(row('cache/result.json')).not.toBeNull()
  const selection = useAppStore.getState().fileExplorerStates[workspace.id]!.selection
  const reads = vi.mocked(api.files.readDirectory).mock.calls.length
  await menu('Explorer options'); await choose('Show hidden files')
  expect(row('.env')).toBeNull(); expect(row('.config')).toBeNull(); expect(row('.config/settings.json')).toBeNull()
  expect(row('cache/result.json')).not.toBeNull()
  await choose('Show Git ignored files')
  expect(row('cache')).toBeNull(); expect(row('cache/result.json')).toBeNull()
  expect(row('plain.ts')).not.toBeNull()
  expect(useAppStore.getState().fileExplorerStates[workspace.id]!.selection).toBe(selection)
  expect(vi.mocked(api.files.readDirectory).mock.calls.length).toBe(reads)
  await choose('Show hidden files'); await choose('Show Git ignored files')
  expect(row('.config/settings.json')).not.toBeNull(); expect(row('cache/result.json')).not.toBeNull()
  expect(vi.mocked(api.files.readDirectory).mock.calls.length).toBe(reads)
})
it('hiding rows and collapsing cannot remove an active Rename field or its ancestors', async () => {
  await dom.render(<FileExplorer />); await expand('.config')
  const target = row('.config/settings.json')!
  await act(async () => { target.focus(); target.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })) })
  const field = dom.container.querySelector<HTMLInputElement>('[aria-label="Rename settings.json"]')
    ?? dom.container.querySelector<HTMLInputElement>('.tree-inline-input')
  expect(field).not.toBeNull(); expect(field!.value).toBe('settings.json')
  await act(async () => useAppStore.getState().toggleExplorerShowHidden())
  expect(row('.env')).toBeNull(); expect(row('.config')).not.toBeNull()
  expect(dom.container.querySelector('.tree-inline-input')).toBe(field)
  await dom.click('[aria-label="Collapse all folders"]')
  expect(dom.container.querySelector('.tree-inline-input')).toBe(field)
  expect(row('.config')?.getAttribute('aria-expanded')).toBe('true')
})
it('visibility preserves the original keyboard-focused row until the user moves focus away', async () => {
  await dom.render(<FileExplorer />)
  const original = row('.env')!
  expect(original).not.toBeNull()
  await act(async () => original.focus())
  expect(document.activeElement).toBe(original)
  await act(async () => useAppStore.getState().toggleExplorerShowHidden())
  expect(row('.env')).toBe(original); expect(document.activeElement).toBe(original)
  await act(async () => dom.container.querySelector<HTMLElement>('[aria-label="Explorer options"]')!.focus())
  expect(row('.env')).toBeNull()
})
it('Collapse All visibly closes the active ancestor and unrelated updates do not reopen it', async () => {
  useAppStore.setState({ lastActiveFileByWorkspace: { [workspace.id]: 'source/main.ts' } })
  await dom.render(<FileExplorer />)
  await vi.waitFor(() => expect(row('source/main.ts')).not.toBeNull())
  expect(row('source')?.getAttribute('aria-expanded')).toBe('true')
  await dom.click('[aria-label="Collapse all folders"]')
  expect(row('source')?.getAttribute('aria-expanded')).toBe('false')
  expect(row('source/main.ts')).toBeNull()
  await act(async () => useAppStore.setState({ error: 'Unrelated update' }))
  expect(row('source')?.getAttribute('aria-expanded')).toBe('false')
  expect(useAppStore.getState().lastActiveFileByWorkspace[workspace.id]).toBe('source/main.ts')
})
it('Collapse All preserves another root and the original active file, and does not immediately auto-expand it again', async () => {
  const selection = createEmptyFileExplorerViewState().selection
  useAppStore.setState({ lastActiveFileByWorkspace: { [workspace.id]: 'source/main.ts' },
    fileExplorerStates: { [workspace.id]: { selection, expandedPaths: new Set(['source', '.config']) } } })
  await dom.render(<FileExplorer rootPath="source" />)
  await vi.waitFor(() => expect(row('source/main.ts')).not.toBeNull())
  const before = useAppStore.getState().fileExplorerStates[workspace.id]!.selection
  await dom.click('[aria-label="Collapse all folders"]')
  expect([...useAppStore.getState().fileExplorerStates[workspace.id]!.expandedPaths]).toEqual(['.config'])
  expect(useAppStore.getState().fileExplorerStates[workspace.id]!.selection).toBe(before)
  expect(useAppStore.getState().lastActiveFileByWorkspace[workspace.id]).toBe('source/main.ts')
  await act(async () => useAppStore.setState({ error: 'Unrelated update' }))
  expect([...useAppStore.getState().fileExplorerStates[workspace.id]!.expandedPaths]).toEqual(['.config'])
  expect(useAppStore.getState().documents[key]).toBe(draft)
})
it('presentation preferences round-trip through the existing writer with strict defaults', () => {
  expect(restorePersistedUiState(composerConfig, {})).toMatchObject({ editorMinimap: false, explorerShowHidden: true, explorerShowIgnored: true })
  useAppStore.getState().toggleEditorMinimap()
  useAppStore.getState().toggleExplorerShowHidden()
  useAppStore.getState().toggleExplorerShowIgnored()
  const partialize = useAppStore.persist.getOptions().partialize!
  const persisted = partialize(useAppStore.getState())
  expect(persisted).toMatchObject({ editorMinimap: true, explorerShowHidden: false, explorerShowIgnored: false })
  expect(restorePersistedUiState(composerConfig, JSON.parse(JSON.stringify(persisted)))).toMatchObject({ editorMinimap: true, explorerShowHidden: false, explorerShowIgnored: false })
  expect(restorePersistedUiState(composerConfig, { editorMinimap: 'on' as never, explorerShowHidden: 0 as never, explorerShowIgnored: null as never })).toMatchObject({ editorMinimap: false, explorerShowHidden: true, explorerShowIgnored: true })
})
it('a filtered tree never claims that the original nonempty directory is physically empty', async () => {
  vi.mocked(api.files.readDirectory).mockResolvedValue([{ path: '.env', name: '.env', isDirectory: false, isSymlink: false }])
  await dom.render(<FileExplorer />)
  expect(row('.env')).not.toBeNull()
  await menu('Explorer options'); await choose('Show hidden files')
  expect(row('.env')).toBeNull()
  expect(dom.container.querySelector('.tree-empty strong')?.textContent).toBe('No visible files')
  expect(dom.container.querySelector('.tree-empty span')?.textContent).toContain('Explorer options')
})
