import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('@monaco-editor/react', () => ({ default: ({ value }: { value: string }) => <textarea value={value} readOnly /> }))
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { FileSurfaceView } from '../src/renderer/src/components/FileSurfaceView'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { addWorkbenchRegion, createWorkbenchTab, documentKey, fileTabId, initialWorkbenchRegionId, type FileWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { projectPersistedWorkbench, restorePersistedWorkbench } from '../src/renderer/src/lib/workbench-persistence'

const initial = useAppStore.getState()
let root: Root, container: HTMLDivElement
const config = { ...composerConfig, workspaces: [composerConfig.workspaces[0]!, { ...composerConfig.workspaces[0]!, id: 'other', name: 'Other', path: _hygiene_fixturePath("other") }] }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  useAppStore.setState({ config, activeWorkspaceId: 'workspace', mainSurface: 'workbench', tabs: {},
    layouts: { workspace: createWorkspaceLayout('group'), other: createWorkspaceLayout('other-group') },
    documents: {}, dirtyDocuments: {}, documentIssues: {}, documentGenerations: {}, documentObservationGenerations: {}, savingDocuments: {}, timelines: {}, recoveryCandidates: [], pendingAgentLaunches: {} })
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'read').mockImplementation(async (_workspaceId, path) => ({ status: 'read', document: { path, content: '# Source', revision: 'original' } }))
  vi.spyOn(api.files, 'readPreview').mockResolvedValue({ status: 'unavailable', code: 'TEST_NO_READ', message: 'Native bytes are tested in the pane suite.' })
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue({ agentSessionId: 'agent-1', source: { providerId: 'codex', nativeSessionId: 'native' }, items: [], nextCursor: null })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function mountFile(path: string, dirty = false) {
  await useAppStore.getState().openFile(path, 'group', undefined, 'workspace')
  const id = fileTabId('workspace', path), file = Object.values(useAppStore.getState().tabs[id]!.regions)[0] as FileWorkbenchSurface
  if (dirty) useAppStore.getState().updateDocument(id, '<html>UNSAVED</html>', file.regionId)
  await act(async () => root.render(<FileSurfaceView tabId={id} surface={file} />)); await act(async () => { await vi.dynamicImportSettled(); await new Promise(resolve => setTimeout(resolve, 0)) })
  return { id, file, key: documentKey('workspace', path) }
}
async function click(text: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text)
  expect(button, container.textContent ?? '').toBeDefined(); await act(async () => button!.click())
}
async function clickFileAction(text: string) {
  // Radix restores trigger focus in a macrotask after the prior selection; finish that owner before
  // starting the next real keyboard gesture rather than racing two menu focus scopes.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="File options"]')
  expect(trigger).not.toBeNull()
  await act(async () => { trigger!.focus(); trigger!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown', code: 'ArrowDown' })) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.trim() === text)
  expect(item, document.body.textContent ?? '').toBeDefined()
  await act(async () => item!.click())
}

describe('the common file-open owner', () => {
  it('known media bypasses UTF-8 without sacrificing the same File/Tab/Region identity or persisted projection', async () => {
    const paths = ['photo.png', 'music.mp3', 'film.mp4', 'document.pdf']
    for (const path of paths) expect(await useAppStore.getState().openFile(path, 'group', { line: 3 }, 'workspace')).toBe(true)
    expect(api.files.read).not.toHaveBeenCalled(); expect(api.files.readPreview).not.toHaveBeenCalled(); expect(useAppStore.getState().documents).toEqual({}); expect(useAppStore.getState().documentRevealTargets).toEqual({})
    const state = useAppStore.getState()
    expect(Object.keys(state.tabs)).toHaveLength(paths.length)
    for (const path of paths) expect(state.tabs[fileTabId('workspace', path)]?.regions[initialWorkbenchRegionId(fileTabId('workspace', path))]).toEqual({ regionId: initialWorkbenchRegionId(fileTabId('workspace', path)), kind: 'file', workspaceId: 'workspace', path })
    expect(await state.openFile('photo.png', 'group', undefined, 'workspace')).toBe(true); expect(Object.keys(useAppStore.getState().tabs)).toHaveLength(paths.length)
    const projected = projectPersistedWorkbench(useAppStore.getState())
    const restored = restorePersistedWorkbench({ config, sessions: [], persisted: projected, createTabGroupId: () => 'restored-group' })
    expect(restored.tabs).toEqual(useAppStore.getState().tabs); expect(restored.layouts).toEqual(useAppStore.getState().layouts)
  })
  it('an existing PNG text draft stays preserved while the original File identity uses a read-only image preview', async () => {
    const id = fileTabId('workspace', 'original.png'), key = documentKey('workspace', 'original.png')
    const oldDoc = { path: 'original.png', content: 'Old mis-decoded unsaved buffer', revision: 'original-bytes' }
    useAppStore.setState({ documents: { [key]: oldDoc }, dirtyDocuments: { [key]: true } })
    const { file } = await mountFile('original.png')
    expect(container.querySelector('.file-preview-pane')).not.toBeNull(); expect(container.querySelector('textarea')).toBeNull()
    expect([...container.querySelectorAll('button')].map(button => button.textContent?.trim())).not.toContain('Save')
    expect(useAppStore.getState().documents[key]).toBe(oldDoc); expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
    const write = vi.spyOn(api.files, 'write'); await useAppStore.getState().saveDocument(id, file.regionId); expect(write).not.toHaveBeenCalled()
    expect(Object.keys(useAppStore.getState().tabs)).toEqual([id]); expect(api.files.read).not.toHaveBeenCalled()
  })
  it('nested Markdown hrefs resolve from the document directory with parent references confined to the workspace', async () => {
    const { id, file, key } = await mountFile('docs/readme.md')
    const text = '# Nested document\n\n[Same directory](./diagram.png)\n\n[Parent](../overview.md)\n\n[Escapes](../../escape.png)\n\nPlain root path: `src/root.png`'
    await act(async () => useAppStore.getState().updateDocument(id, text, file.regionId)); await click('Preview')
    const links = [...container.querySelectorAll<HTMLButtonElement>('button.md-link--file')]
    expect(links.map(button => button.title)).toEqual(['docs/diagram.png', 'overview.md', 'src/root.png'])
    await act(async () => links[0]!.click()); expect(useAppStore.getState().tabs[fileTabId('workspace', 'docs/diagram.png')]).toBeDefined()
    await act(async () => links[1]!.click()); expect(api.files.read).toHaveBeenCalledWith('workspace', 'overview.md')
    expect(useAppStore.getState().documents[key]?.content).toBe(text); expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
  })
  it('encoded Markdown image and bookmark clicks use the original file owner, preserving the dirty source and split neighbor', async () => {
    const { id, file, key } = await mountFile('docs/readme.md')
    const state = useAppStore.getState(), originalTab = addWorkbenchRegion(state.tabs[id]!, file.regionId, 'right',
      { kind: 'file', regionId: 'neighbor', workspaceId: 'workspace', path: 'neighbor.txt' })
    const neighborKey = documentKey('workspace', 'neighbor.txt'), neighbor = { path: 'neighbor.txt', content: 'Original unsaved neighbor', revision: 'neighbor-disk' }
    const text = '# Draft preview\n\n![Photo](images/photo%20one.png)\n\n![图片](./图片.png)\n\n[Saved link](./Research%20%26%20Notes.webloc)'
    await act(async () => {
      useAppStore.setState({ tabs: { ...state.tabs, [id]: originalTab }, documents: { ...state.documents, [neighborKey]: neighbor }, dirtyDocuments: { ...state.dirtyDocuments, [neighborKey]: true } })
      useAppStore.getState().updateDocument(id, text, file.regionId)
    })
    const bookmark = vi.spyOn(api.files, 'readBookmark').mockResolvedValue({ url: 'https://example.test/saved', binary: false })
    const browser = vi.spyOn(api.browser, 'create').mockImplementation(async (browserId, url) => ({ id: browserId, url: url!, title: 'Saved link', loading: false, canGoBack: false, canGoForward: false }))
    await click('Preview')
    const links = [...container.querySelectorAll<HTMLButtonElement>('.md-image-attachment, button.md-link--file')]
    expect(links.map(button => button.title)).toEqual(['docs/images/photo one.png', 'docs/图片.png', 'docs/Research & Notes.webloc'])
    await act(async () => links[0]!.click())
    await act(async () => links[1]!.click())
    expect(useAppStore.getState().tabs[fileTabId('workspace', 'docs/images/photo one.png')]).toBeDefined()
    expect(useAppStore.getState().tabs[fileTabId('workspace', 'docs/图片.png')]).toBeDefined()
    expect(api.files.read).toHaveBeenCalledTimes(1)
    await act(async () => links[2]!.click())
    expect(bookmark).toHaveBeenCalledWith('workspace', 'docs/Research & Notes.webloc')
    expect(browser).toHaveBeenCalledWith(expect.any(String), 'https://example.test/saved', 'workspace')
    const surfaces = Object.values(useAppStore.getState().tabs).flatMap(tab => Object.values(tab.regions))
    expect(surfaces.filter(surface => surface.kind === 'browser')).toEqual([expect.objectContaining({ kind: 'browser', workspaceId: 'workspace', bookmarkOrigin: { path: 'docs/Research & Notes.webloc', binary: false } })])
    expect(useAppStore.getState().tabs[id]).toEqual(originalTab)
    expect(useAppStore.getState().tabs[id]?.layout.root.type).toBe('split')
    expect(useAppStore.getState().documents[key]?.content).toBe(text); expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
    expect(useAppStore.getState().documents[neighborKey]).toBe(neighbor); expect(useAppStore.getState().dirtyDocuments[neighborKey]).toBe(true)
  })
  it('unknown binary returns a real read verdict, never an empty text document; repeated open reuses its surface', async () => {
    vi.mocked(api.files.read).mockResolvedValue({ status: 'binary', path: 'blob.unknown', revision: 'binary-revision', byteLength: 150 })
    expect(await useAppStore.getState().openFile('blob.unknown', 'group', undefined, 'workspace')).toBe(true)
    const key = documentKey('workspace', 'blob.unknown')
    expect(useAppStore.getState().documents[key]).toBeUndefined(); expect(useAppStore.getState().documentIssues[key]).toEqual({ kind: 'binary', revision: 'binary-revision', byteLength: 150 })
    expect(await useAppStore.getState().openFile('blob.unknown', 'group', undefined, 'workspace')).toBe(true)
    expect(api.files.read).toHaveBeenCalledTimes(1); expect(Object.keys(useAppStore.getState().tabs)).toEqual([fileTabId('workspace', 'blob.unknown')]); expect(api.files.unobserve).toHaveBeenCalledWith('workspace', 'blob.unknown')
  })
  it('disk replacement with binary preserves an existing unsaved text buffer and disables unsafe normal save', async () => {
    const { id, file, key } = await mountFile('draft.txt', true)
    vi.mocked(api.files.read).mockResolvedValue({ status: 'binary', path: 'draft.txt', revision: 'binary-new', byteLength: 100 })
    const write = vi.spyOn(api.files, 'write')
    await act(async () => useAppStore.getState().refreshDocument('workspace', 'draft.txt'))
    expect(useAppStore.getState().documents[key]).toEqual({ path: 'draft.txt', content: '<html>UNSAVED</html>', revision: 'original' }); expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
    expect(useAppStore.getState().documentIssues[key]).toMatchObject({ kind: 'read-error', code: 'WORKSPACE_FILE_BECAME_BINARY' })
    await useAppStore.getState().saveDocument(id, file.regionId); expect(write).not.toHaveBeenCalled()
  })
  it('late unknown read can preserve a reachable File but does not take back newer navigation', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof api.files.read>>) => void
    vi.mocked(api.files.read).mockImplementation(() => new Promise(done => { resolve = done }))
    const opening = useAppStore.getState().openFile('late.bin', 'group', undefined, 'workspace')
    await new Promise(done => setTimeout(done, 0)); useAppStore.setState({ activeWorkspaceId: 'other' })
    resolve({ status: 'binary', path: 'late.bin', revision: 'late-original', byteLength: 4 })
    expect(await opening).toBe(false); expect(useAppStore.getState().activeWorkspaceId).toBe('other'); expect(useAppStore.getState().layouts.workspace?.groups[0]?.activeTabId).toBeNull()
    expect(useAppStore.getState().tabs[fileTabId('workspace', 'late.bin')]).toBeDefined(); expect(useAppStore.getState().documents).toEqual({})
  })
  it('HTML saved-file preview leaves dirty source intact; explicit Save & Preview uses the original revision and exact workspace Browser', async () => {
    const { key } = await mountFile('index.html', true)
    let sequence = 0
    const create = vi.spyOn(api.browser, 'create').mockImplementation(async (id, url) => ({ id, url: url!, title: 'Saved HTML', loading: false, canGoBack: false, canGoForward: false }))
    await clickFileAction('Preview saved file')
    expect(create).toHaveBeenCalledWith(expect.any(String), _hygiene_fixturePath("repo/index.html"), 'workspace'); expect(useAppStore.getState().dirtyDocuments[key]).toBe(true); expect(useAppStore.getState().documents[key]?.content).toBe('<html>UNSAVED</html>')
    const write = vi.spyOn(api.files, 'write').mockImplementation(async () => ({ status: 'written', revision: `saved-${++sequence}` }))
    await clickFileAction('Save & Preview')
    expect(write).toHaveBeenCalledWith('workspace', { path: 'index.html', content: '<html>UNSAVED</html>', expectedRevision: 'original' }); expect(create).toHaveBeenCalledTimes(2); expect(useAppStore.getState().dirtyDocuments[key]).toBe(false)
  })
  it('HTML failed or stale Save & Preview cannot claim a Browser preview and preserves the current draft', async () => {
    const { key } = await mountFile('index.html', true)
    const create = vi.spyOn(api.browser, 'create')
    vi.spyOn(api.files, 'write').mockResolvedValue({ status: 'error', code: 'EACCES', message: 'Write denied' })
    await clickFileAction('Save & Preview'); expect(create).not.toHaveBeenCalled(); expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
    let release!: (value: Awaited<ReturnType<typeof api.files.write>>) => void
    vi.mocked(api.files.write).mockImplementation(() => new Promise(done => { release = done }))
    await clickFileAction('Save & Preview'); await act(async () => useAppStore.setState({ activeWorkspaceId: 'other' }))
    await act(async () => release({ status: 'written', revision: 'late-saved' })); expect(create).not.toHaveBeenCalled(); expect(useAppStore.getState().activeWorkspaceId).toBe('other'); expect(useAppStore.getState().documents[key]?.content).toBe('<html>UNSAVED</html>')
  })
  it('actual SessionPane conversation PNG click carries its source workspace even while another project is active', async () => {
    const session = composerSession()
    const tab = createWorkbenchTab('agent-tab', { regionId: 'agent-region', kind: 'agent', sessionId: session.id, workspaceId: 'workspace' })
    const open = vi.fn().mockResolvedValue(true)
    useAppStore.setState({ sessions: [session], tabs: { 'agent-tab': tab }, layouts: { workspace: createWorkspaceLayout('group', ['agent-tab']), other: createWorkspaceLayout('other-group') }, openFile: open, activeWorkspaceId: 'other', viewModes: { [session.id]: 'activity' },
      timelines: { [session.id]: { agentSessionId: session.id, revision: 1, items: [{ id: 'answer', agentSessionId: session.id, kind: 'assistant_message', status: 'complete', source: 'native-hook', createdAt: 1, updatedAt: 1, title: 'Image result', content: 'See [the image](diagram.png)' }] } } })
    await act(async () => { root.render(<SessionPane sessionId={session.id} surfaceKind="agent" visible readOnly interactiveResize={false} linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'group', tabId: 'agent-tab', regionId: 'agent-region', sessionId: session.id }} />); await new Promise(done => setTimeout(done, 0)) })
    await act(async () => vi.dynamicImportSettled())
    const link = container.querySelector<HTMLButtonElement>('button[title="diagram.png"]'); expect(link, container.textContent ?? '').not.toBeNull()
    await act(async () => link!.click()); expect(open.mock.calls).toEqual([['diagram.png', 'group', undefined, 'workspace', undefined, expect.objectContaining({ displayWorkspaceId: 'workspace', resource: { hostId: 'local', path: _hygiene_fixturePath("repo") } })]])
  })
  it('actual SessionPane encoded image href retains the message workspace and never chooses the active other project', async () => {
    const session = composerSession(), tab = createWorkbenchTab('agent-tab', { regionId: 'agent-region', kind: 'agent', sessionId: session.id, workspaceId: 'workspace' })
    const open = vi.fn().mockResolvedValue(true)
    useAppStore.setState({ sessions: [session], tabs: { 'agent-tab': tab }, layouts: { workspace: createWorkspaceLayout('group', ['agent-tab']), other: createWorkspaceLayout('other-group') }, openFile: open, activeWorkspaceId: 'other', viewModes: { [session.id]: 'activity' },
      timelines: { [session.id]: { agentSessionId: session.id, revision: 1, items: [{ id: 'answer', agentSessionId: session.id, kind: 'assistant_message', status: 'complete', source: 'native-hook', createdAt: 1, updatedAt: 1, title: 'Image result', content: '![图片](images/photo%20one.png)' }] } } })
    await act(async () => { root.render(<SessionPane sessionId={session.id} surfaceKind="agent" visible readOnly interactiveResize={false} linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'group', tabId: 'agent-tab', regionId: 'agent-region', sessionId: session.id }} />); await new Promise(done => setTimeout(done, 0)) })
    await act(async () => vi.dynamicImportSettled())
    const links = [...container.querySelectorAll<HTMLButtonElement>('button.md-image-attachment')]
    expect(links.map(link => link.title)).toEqual(['images/photo one.png'])
    await act(async () => links[0]!.click())
    expect(open.mock.calls).toEqual([['images/photo one.png', 'group', undefined, 'workspace', undefined, expect.objectContaining({ displayWorkspaceId: 'workspace', resource: { hostId: 'local', path: _hygiene_fixturePath("repo") } })]])
    expect(useAppStore.getState().activeWorkspaceId).toBe('other'); expect(useAppStore.getState().tabs['agent-tab']).toBe(tab)
  })
})
