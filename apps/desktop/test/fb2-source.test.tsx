// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createClientUiRoot } from './helpers/client-ui-render'
import { composerConfig } from './helpers/composer-dom-fixture'
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('monaco-editor', () => ({}))
const painter = vi.hoisted(() => ({ change: null as null | ((value: string) => void) }))
vi.mock('@monaco-editor/react', () => ({ default: ({ value, language, onChange }: { value: string; language: string; onChange(value: string): void }) => {
  painter.change = onChange
  return <textarea aria-label="Original XML source" data-language={language} value={value} readOnly />
} }))
import { FileSurfaceView } from '../src/renderer/src/components/FileSurfaceView'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab, documentKey, fileTabId, initialWorkbenchRegionId, type FileWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'

const initial = useAppStore.getState(), path = 'original.fb2', key = documentKey('workspace', path)
const id = fileTabId('workspace', path), surface: FileWorkbenchSurface = { kind: 'file', regionId: initialWorkbenchRegionId(id), workspaceId: 'workspace', path }
const tab = createWorkbenchTab(id, surface)
const xml = '<?xml version="1.0"?><FictionBook><body><section><p>Saved XML</p></section></body></FictionBook>'
let root: Root, container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); painter.change = null
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
  useAppStore.setState({ config: composerConfig, activeWorkspaceId: 'workspace', mainSurface: 'workbench', tabs: { [id]: tab },
    layouts: { workspace: createWorkspaceLayout('group', [id]) }, documents: {}, dirtyDocuments: {}, documentIssues: {},
    documentGenerations: {}, editorRegionModes: {}, editorRegionDiffs: {}, savingDocuments: {}, retainedDocumentDrafts: {} })
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined); vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'openSource').mockResolvedValue({ status: 'unavailable', code: 'PRIVATE_READER_NOT_STARTED', message: 'Only the Source mode and saved-reader route are under test.' })
  vi.spyOn(api.files, 'readPreview'); vi.spyOn(api.files, 'write')
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function settle() { await act(async () => { await vi.dynamicImportSettled(); await new Promise(resolve => setTimeout(resolve, 10)) }) }
async function mount() { await act(async () => root.render(<FileSurfaceView tabId={id} surface={surface} />)); await settle() }
async function check(assertion: () => void) { for (let attempt = 0; attempt < 100; attempt++) { try { assertion(); return } catch { await settle() } }; assertion() }
async function click(text: string) { const find = () => [...container.querySelectorAll('button')].find(node => node.textContent?.trim() === text); await check(() => expect(find()).toBeDefined()); await act(async () => find()!.click()); await settle() }
function source() { return container.querySelector<HTMLTextAreaElement>('[aria-label="Original XML source"]') }

it('restores the original dirty FB2 XML as Source and explicitly previews saved bytes without replacing or saving the draft', async () => {
  const draft = { path, content: xml.replace('Saved XML', 'Original unsaved XML'), revision: 'saved-original' }
  useAppStore.setState({ documents: { [key]: draft }, dirtyDocuments: { [key]: true } })
  const read = vi.spyOn(api.files, 'read')
  await mount(); await check(() => expect(source()?.value).toBe(draft.content)); expect(source()?.dataset.language).toBe('xml')
  expect(useAppStore.getState().documents[key]).toBe(draft); expect(api.files.openSource).not.toHaveBeenCalled()
  await act(async () => painter.change!(draft.content.replace('Original unsaved XML', 'New unsaved XML')))
  const edited = useAppStore.getState().documents[key]
  expect(edited?.content).toContain('New unsaved XML'); expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
  await click('Preview')
  expect(container.querySelector('.file-preview-pane')).not.toBeNull(); expect(source()).toBeNull()
  expect(container.textContent).toContain('Preview reads the saved file. Unsaved source changes are retained.')
  expect(api.files.openSource).toHaveBeenCalledWith('workspace', path)
  expect(useAppStore.getState().documents[key]).toBe(edited); expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
  await click('Source'); await check(() => expect(source()?.value).toBe(edited?.content))
  expect(useAppStore.getState().tabs[id]?.regions[surface.regionId]).toBe(surface)
  expect(read).not.toHaveBeenCalled(); expect(api.files.readPreview).not.toHaveBeenCalled(); expect(api.files.write).not.toHaveBeenCalled()
})

it('loads FB2 text through the existing document owner only on explicit Source, before any editor mounts', async () => {
  const saved = { path, content: xml, revision: 'original' }
  const read = vi.spyOn(api.files, 'read').mockResolvedValue({ status: 'read', document: saved })
  await useAppStore.getState().setEditorRegionMode(surface.regionId, 'workspace', path, 'edit')
  expect(read).toHaveBeenCalledExactlyOnceWith('workspace', path)
  expect(useAppStore.getState().documents[key]).toBe(saved)
  await mount(); await check(() => expect(source()?.value).toBe(xml))
  expect(useAppStore.getState().tabs[id]?.regions[surface.regionId]).toBe(surface)
  expect(api.files.openSource).not.toHaveBeenCalled(); expect(api.files.write).not.toHaveBeenCalled()
})

it('opens clean FB2 in saved Preview without the text budget, and preserves Preview and Retry when explicit Source cannot read', async () => {
  const read = vi.spyOn(api.files, 'read').mockResolvedValue({ status: 'error', code: 'WORKSPACE_FILE_BYTE_LIMIT', message: 'Source exceeds the text read budget; the original file is retained.' })
  await mount()
  expect(container.querySelector('.file-preview-pane')).not.toBeNull(); expect(read).not.toHaveBeenCalled()
  expect(api.files.readPreview).not.toHaveBeenCalled(); expect(useAppStore.getState().documents[key]).toBeUndefined()
  await click('Source')
  expect(container.textContent).toContain('Source exceeds the text read budget'); expect(source()).toBeNull()
  expect(useAppStore.getState().documentIssues[key]).toMatchObject({ kind: 'read-error', code: 'WORKSPACE_FILE_BYTE_LIMIT' })
  const reads = read.mock.calls.length
  await click('Preview saved file'); expect(container.querySelector('.file-preview-pane')).not.toBeNull()
  expect(read).toHaveBeenCalledTimes(reads)
  await click('Source'); expect(read).toHaveBeenCalledTimes(reads)
  read.mockResolvedValue({ status: 'read', document: { path, content: xml, revision: 'now-readable' } })
  await click('Retry'); await check(() => expect(source()?.value).toBe(xml)); expect(useAppStore.getState().documentIssues[key]).toBeUndefined()
  expect(useAppStore.getState().tabs[id]?.regions[surface.regionId]).toBe(surface)
  expect(api.files.write).not.toHaveBeenCalled()
})

it('retains a healthy dirty XML Source when the saved file is later reported binary', async () => {
  const draft = { path, content: xml, revision: 'retained-text' }
  useAppStore.setState({ documents: { [key]: draft }, dirtyDocuments: { [key]: true }, documentIssues: { [key]: { kind: 'binary', revision: 'replaced-binary', byteLength: 100 } } })
  const read = vi.spyOn(api.files, 'read')
  await mount(); await check(() => expect(source()?.value).toBe(xml))
  expect(container.textContent).toContain('The file is binary. The existing text buffer is preserved.')
  expect(useAppStore.getState().documents[key]).toBe(draft); expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
  expect(read).not.toHaveBeenCalled(); expect(api.files.write).not.toHaveBeenCalled()
})
