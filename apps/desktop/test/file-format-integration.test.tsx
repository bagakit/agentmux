// @vitest-environment happy-dom
import { act } from 'react'
import { type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createClientUiRoot } from './helpers/client-ui-render'
import { composerConfig } from './helpers/composer-dom-fixture'
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('monaco-editor', () => ({}))
vi.mock('@monaco-editor/react', () => ({ default: ({ value, path }: { value: string; path: string }) => <textarea data-monaco-path={path} value={value} readOnly /> }))
import { FileSurfaceView } from '../src/renderer/src/components/FileSurfaceView'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab, documentKey, fileTabId, initialWorkbenchRegionId, type FileWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { readStructuredPreview } from '../src/renderer/src/lib/file-formats/data-parse'
import { createNotebookReader } from '../src/renderer/src/lib/file-formats/data-notebook'

const initial = useAppStore.getState(), workers: TestWorker[] = []
class TestWorker {
  onmessage: ((event: MessageEvent) => void) | null = null; onerror = null; onmessageerror = null
  terminate = vi.fn()
  constructor(readonly url: URL) { workers.push(this) }
  postMessage(request: any) {
    if (request.type === 'open') queueMicrotask(() => this.onmessage?.({ data: { job: request.job, page: 0, result: createNotebookReader(request.content).page(0) } } as MessageEvent))
    else void readStructuredPreview(request.kind, request.content).then(parsed => this.onmessage?.({ data: { id: request.id, parsed } } as MessageEvent))
  }
}
let root: Root, container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('Worker', TestWorker); workers.length = 0
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
  vi.spyOn(api.files, 'write'); vi.spyOn(api.files, 'readPreview'); vi.spyOn(api.files, 'observe').mockResolvedValue(undefined); vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function settle() { await act(async () => { await vi.dynamicImportSettled(); await new Promise(resolve => setTimeout(resolve, 10)) }) }
async function check(assertion: () => void) { for (let attempt = 0; attempt < 100; attempt++) { try { assertion(); return } catch { await settle() } }; assertion() }
async function click(text: string) { const button = [...container.querySelectorAll('button')].find(item => item.textContent === text)!; expect(button).toBeDefined(); await act(async () => button.click()); await settle() }
describe('File format integration keeps original current draft', () => {
  it.each([
    ['records.jsonl', '{"name":"current-draft"}\n{bad}\nfalse', 'current-draft', 'Line 2, column'],
    ['settings.yaml', 'name: current-draft\n---\nname: second', 'current-draft', '2 documents'],
    ['settings.toml', 'name = "current-draft"\ncount = 9223372036854775807', 'current-draft', '9223372036854775807'],
    ['analysis.ipynb', JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: 'raw', metadata: {}, source: 'current-draft' }] }), 'current-draft', 'raw']
  ])('routes %s through actual source/preview consumers and releases hidden work without saving', async (path, draft, expected, detail) => {
    const id = fileTabId('workspace', path), file: FileWorkbenchSurface = { regionId: initialWorkbenchRegionId(id), workspaceId: 'workspace', path, kind: 'file' }, tab = createWorkbenchTab(id, file), key = documentKey('workspace', path)
    useAppStore.setState({ config: composerConfig, tabs: { [id]: tab }, layouts: { workspace: createWorkspaceLayout('group', [id]) }, activeWorkspaceId: 'workspace', mainSurface: 'workbench', documents: { [key]: { path, content: 'original source', revision: 'native-original' } }, dirtyDocuments: {}, documentIssues: {}, editorRegionModes: {}, documentGenerations: {}, savingDocuments: {} })
    await act(async () => root.render(<FileSurfaceView tabId={id} surface={file} />)); await settle()
    await check(() => expect(container.querySelector('textarea')).not.toBeNull())
    const modelPath = container.querySelector('textarea')?.dataset.monacoPath; expect(modelPath).toBeTruthy(); expect(workers).toHaveLength(0)
    await act(async () => useAppStore.getState().updateDocument(id, draft, file.regionId)); await click('Preview')
    await check(() => { expect(container.textContent).toContain(expected); expect(container.textContent).toContain(detail) })
    expect(workers).toHaveLength(1); expect(workers[0]?.url.pathname).toContain(path.endsWith('.ipynb') ? 'data-notebook.worker.ts' : 'data-structured.worker.ts')
    expect(useAppStore.getState().tabs[id]?.regions[file.regionId]).toBe(file); expect(useAppStore.getState().documents[key]).toMatchObject({ content: draft, revision: 'native-original' }); expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
    await click('Source'); expect(container.querySelector('textarea')?.value).toBe(draft); expect(container.querySelector('textarea')?.dataset.monacoPath).toBe(modelPath); expect(workers[0]?.terminate).toHaveBeenCalled()
    await click('Preview'); await check(() => expect(workers).toHaveLength(2)); await act(async () => root.render(<FileSurfaceView tabId={id} surface={file} visible={false} />)); await settle()
    expect(workers[1]?.terminate).toHaveBeenCalled(); expect(container.querySelector('.notebook-preview,.file-data-preview')).toBeNull(); expect(api.files.write).not.toHaveBeenCalled(); expect(api.files.readPreview).not.toHaveBeenCalled()
  })
})
