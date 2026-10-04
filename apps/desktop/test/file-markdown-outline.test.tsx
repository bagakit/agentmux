// @vitest-environment happy-dom
import { act } from 'react'
import { type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('@monaco-editor/react', () => ({ default: ({ value }: { value: string }) => <textarea value={value} readOnly /> }))
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { FileSurfaceView } from '../src/renderer/src/components/FileSurfaceView'
import { addWorkbenchRegion, documentKey, fileTabId, type FileWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { composerConfig } from './helpers/composer-dom-fixture'

const initial = useAppStore.getState()
let root: Root, container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  useAppStore.setState({ config: composerConfig, activeWorkspaceId: 'workspace', mainSurface: 'workbench', tabs: {},
    layouts: { workspace: createWorkspaceLayout('group') }, documents: {}, dirtyDocuments: {}, documentIssues: {},
    documentGenerations: {}, documentObservationGenerations: {}, savingDocuments: {}, editorRegionModes: {} })
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'read').mockResolvedValue({ status: 'read', document: { path: 'readme.md', content: '# Saved', revision: 'original' } })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function click(selector: string, scope: ParentNode = container) {
  const node = scope.querySelector<HTMLElement>(selector)
  expect(node, selector).not.toBeNull()
  await act(async () => { node!.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
}

it('File Preview exposes the same dirty Markdown outline without reading, saving or changing its split identities', async () => {
  await useAppStore.getState().openFile('readme.md', 'group', undefined, 'workspace')
  const id = fileTabId('workspace', 'readme.md'), tab = useAppStore.getState().tabs[id]!
  const surface = Object.values(tab.regions)[0] as FileWorkbenchSurface
  const split = addWorkbenchRegion(tab, surface.regionId, 'right', { ...surface, regionId: 'markdown-neighbor' })
  await act(async () => {
    useAppStore.setState({ tabs: { [id]: split } })
    useAppStore.getState().updateDocument(id, '# Current draft\n\n## Destination', surface.regionId)
    await useAppStore.getState().setEditorRegionMode(surface.regionId, 'workspace', 'readme.md', 'preview')
    await useAppStore.getState().setEditorRegionMode('markdown-neighbor', 'workspace', 'readme.md', 'preview')
    root.render(<><FileSurfaceView tabId={id} surface={surface} />
      <FileSurfaceView tabId={id} surface={split.regions['markdown-neighbor'] as FileWorkbenchSurface} /></>)
    await vi.dynamicImportSettled()
  })
  await act(async () => { await vi.dynamicImportSettled() })
  const documents = [...container.querySelectorAll<HTMLElement>('.file-markdown-preview')]
  expect(documents).toHaveLength(2)
  const before = useAppStore.getState(), key = documentKey('workspace', 'readme.md')
  const write = vi.spyOn(api.files, 'write')
  await click('.md-outline__trigger', documents[1]!)
  expect(documents[1]!.querySelector('[data-md-outline-anchor="current-draft"]')?.textContent).toBe('Current draft')
  await click('[data-md-outline-anchor="destination"]', documents[1]!)
  expect(document.activeElement).toBe(documents[1]!.querySelector('[data-md-anchor="destination"]'))
  const after = useAppStore.getState()
  expect(after.tabs[id]).toBe(before.tabs[id])
  expect(after.documents[key]).toBe(before.documents[key])
  expect(after.documents[key]!.content).toBe('# Current draft\n\n## Destination')
  expect(after.dirtyDocuments[key]).toBe(true)
  expect(api.files.read).toHaveBeenCalledTimes(1)
  expect(write).not.toHaveBeenCalled()
})
