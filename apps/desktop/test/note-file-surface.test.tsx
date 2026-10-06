import { fileUploadRevision } from '@agentmux/core/files'
import { serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { fixtureEpoch as _tailRefreshFixtureEpoch } from "../../../test/fixture-values.mjs"
import { fixtureEpoch as _liveTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import type { Editor } from '@tiptap/core'
import { beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout, type WorkspaceLayout } from '@agentmux/layout'
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('@monaco-editor/react', () => ({ default: ({ value }: { value: string }) => <textarea aria-label="Original file source" value={value} readOnly /> }))
import { NoteBlockEditor, type NoteEditorHandle } from '../src/renderer/src/components/NoteBlockEditor'
import { FileSurfaceView } from '../src/renderer/src/components/FileSurfaceView'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab, addWorkbenchRegion, documentKey, fileTabId, type FileWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { NOTE_SCHEMA, readNoteDocument, newNoteDocument } from '../src/shared/note-document'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import * as noteKnowledgeModule from '../src/renderer/src/lib/note-knowledge'
import * as noteDocumentModule from '@agentmux/client-ui/note/note-document'
import * as noteDirectoryModule from '../src/renderer/src/lib/note-directory-sources'
import { noteBlockSelectionKey } from '../src/renderer/src/lib/note-block-selection'
import { attributeNoteBlocks } from '@agentmux/client-ui/note/note-provenance'
import { useNotebookLibrary } from '../src/renderer/src/lib/notebook-library'
import { emptyNotebookState, type NotebookPage } from '@agentmux/core/notebook-catalog'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { NoteFileWriter } from '../src/main/note-file-writer'
import { NotebookObservationOwner } from '../src/main/notebook-observation-owner'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { AgentMuxControlServer, type ExecutionHost } from '@agentmux/core'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'
const dom = composerDOM(), birth = directoryIdentity('local', _hygiene_fixturePath("repo")), zoneId = homeZoneId(birth)
const original = { ...createWorkbenchTab('mixed-original', { kind: 'launcher', workspaceId: 'workspace', regionId: 'mixed-launcher' }), space: { spaceId: birth, zoneId } }
const sourceRegion: FileWorkbenchSurface = { kind: 'file', regionId: 'mixed-file', workspaceId: 'workspace', path: 'source.note.md' }
const mixed = addWorkbenchRegion(original, 'mixed-launcher', 'right', sourceRegion)
const referring: FileWorkbenchSurface = { kind: 'file', regionId: 'referring-file', workspaceId: 'workspace', path: 'referring.note.md' }
const referringTab = { ...createWorkbenchTab('referring-tab', referring), space: { spaceId: birth, zoneId } }
const source = newNoteDocument('Original finding', 'source-note', 'source-block')
const reference = { schema: NOTE_SCHEMA, noteId: 'referring-note', content: { type: 'doc', content: [{ type: 'blockReference', attrs: { blockId: 'referring-block', referenceId: 'referring-reference', target: { noteId: 'source-note', blockId: 'source-block' }, mode: 'reference' } }] } }
const sourceKey = documentKey('workspace', sourceRegion.path), referenceKey = documentKey('workspace', referring.path)
beforeEach(() => {
  useNotebookLibrary.setState({ state: null, issue: null })
  useAppStore.setState({ config: composerConfig, activeWorkspaceId: 'workspace', mainSurface: 'survey', sessions: [composerSession()], tabs: { [mixed.id]: mixed, [referringTab.id]: referringTab },
    layouts: { workspace: createWorkspaceLayout('original-group', [mixed.id, referringTab.id]) },
    documents: { [sourceKey]: { path: sourceRegion.path, content: serializeNoteDocument(source), revision: 'source-revision' }, [referenceKey]: { path: referring.path, content: serializeNoteDocument(reference as Parameters<typeof serializeNoteDocument>[0]), revision: 'referring-revision' } },
    dirtyDocuments: {}, savingDocuments: {}, documentIssues: {}, documentGenerations: {}, documentObservationGenerations: {}, documentRevealTargets: {}, noteBlockSelections: {}, noteDirectorySources: {}, workspaceFileRevisions: {}, spaceZoneBindings: {}, scratchTopicSnapshots: {}, spatialRequests: {},
    surveyZoneSelection: { zoneId, selection: [{ tabId: referringTab.id, regionId: referring.regionId }], active: { tabId: referringTab.id, regionId: referring.regionId } },
    regionCaretFocus: null, retainedSpatialFocus: null, error: null, lastError: null, lastActiveFileByWorkspace: {} })
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined); vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'read').mockRejectedValue(new Error('These canonical documents are already read'))
  vi.spyOn(api.files, 'write').mockResolvedValue({ status: 'written', revision: 'saved-revision' })
  vi.spyOn(api.files, 'readDirectory').mockRejectedValue(new Error('Render must not discover directories'))
})

it('uses the original File navigation for an inline exact block while preserving the dirty Survey source and existing mixed Tab', async () => {
  const inline = newNoteDocument('Keep my draft ', reference.noteId, 'referring-block')
  inline.content.content![0]!.content!.push({ type: 'noteLink', attrs: { referenceId: 'inline-original', text: 'An old page title', target: { noteId: source.noteId, blockId: 'source-block' } } })
  useAppStore.setState(state => ({ documents: { ...state.documents, [referenceKey]: { ...state.documents[referenceKey]!, content: serializeNoteDocument(inline) } } }))
  const book = emptyNotebookState(), resource = composerConfig.workspaces.find(workspace => workspace.id === 'workspace')!
  const page: NotebookPage = { noteId: source.noteId, title: 'Renamed original', notebookId: 'quick-notes', parentNoteId: null, resource: { hostId: resource.hostId, workspaceId: resource.id, workspacePath: resource.path, path: sourceRegion.path }, workface: { zoneId, workspaceId: 'workspace' }, sources: [], topics: [], createdAt: _tailRefreshFixtureEpoch(0, 0, 1), updatedAt: _tailRefreshFixtureEpoch(0, 0, 1) }
  book.pages[source.noteId] = page; useNotebookLibrary.setState({ state: book })
  vi.mocked(api.files.read).mockResolvedValue({ status: 'read', document: { path: sourceRegion.path, content: serializeNoteDocument(source), revision: 'source-revision' } })
  await mount(referring, referringTab.id)
  await act(async () => editor().commands.insertContentAt(1, 'Unsaved '))
  const before = useAppStore.getState(), document = before.documents[referenceKey], tabs = before.tabs
  const inlineButton = dom.container.querySelector<HTMLButtonElement>('[data-note-inline-link]')!
  await act(async () => inlineButton.dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true, cancelable: true })))
  await vi.waitFor(() => expect(useAppStore.getState().documentRevealTargets[sourceKey]?.noteBlock).toEqual({ noteId: source.noteId, blockId: 'source-block' }))
  const after = useAppStore.getState()
  expect(after.mainSurface).toBe('survey'); expect(after.surveyZoneSelection?.zoneId).toBe(zoneId)
  expect(after.documents[referenceKey]).toBe(document); expect(after.dirtyDocuments[referenceKey]).toBe(true)
  expect(Object.keys(after.tabs)).toEqual(Object.keys(tabs)); expect(after.tabs[mixed.id]).toBe(mixed)
  expect(api.files.write).not.toHaveBeenCalled()
})

it('saves real mounted wiki input through the original File store/writer and reads the canonical same file through actual CLI', async () => {
  const rootPath = await realpath(await mkdtemp(join(tmpdir(), 'amx-wiki-editor-')))
  const workspace = { id: 'workspace', hostId: 'local', path: rootPath, name: 'Notes', kind: 'folder' as const }
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' } as ExecutionHost)), store = new AgentMuxNotebookStore(join(rootPath, 'catalog.json'))
  const owner = new NotebookObservationOwner({ workspace: () => workspace, files, metadata: store }), writer = new NoteFileWriter(files, { state: () => store.read(), owner }, store)
  const server = new AgentMuxControlServer({ socketPath: join(rootPath, 'control.sock'), coreClients: () => [], notebookStore: store, notebookObservation: owner })
  try {
    const target = newNoteDocument('Target original', 'target-id', 'target-block')
    for (const [note, title, path] of [[source, 'Source', sourceRegion.path], [target, 'Shared knowledge', 'target.note.md'], [newNoteDocument('Another same-title page', 'other-id', 'other-block'), 'Shared knowledge', 'other.note.md']] as const) {
      await writeFile(join(rootPath, path), serializeNoteDocument(note))
      await store.apply({ operationId: 'register:' + note.noteId, expectedRevision: (await store.read()).revision, change: { kind: 'register', noteId: note.noteId, title, resource: { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: rootPath, path } } }, { kind: 'user', id: 'test-human' })
    }
    const originalRead = await files.read(workspace, sourceRegion.path); if (originalRead.status !== 'read') throw Error('Original source must read')
    useAppStore.setState(state => ({ config: { ...composerConfig, workspaces: composerConfig.workspaces.map(item => item.id === workspace.id ? workspace : item) }, documents: { ...state.documents, [sourceKey]: originalRead.document } }))
    vi.spyOn(api.notebooks, 'resolve').mockImplementation(async (params, options) => owner.resolve(await store.read(), params, options))
    vi.spyOn(api.notebooks, 'read').mockImplementation(() => store.read())
    vi.mocked(api.files.write).mockImplementation(async (_workspaceId, input) => writer.write(workspace, input, { actor: { kind: 'user', id: 'test-human' } }))
    await mount(); const originalEditor = editor()
    const transfer = new DataTransfer(); transfer.setData('text/plain', ' [[Shared knowledge]]')
    await act(async () => { originalEditor.view.focus(); originalEditor.commands.setTextSelection(originalEditor.state.doc.content.size - 1); originalEditor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })) })
    await vi.waitFor(() => expect(dom.container.querySelector('[data-note-inline-link]')).not.toBeNull())
    await act(async () => dom.container.querySelector('[data-note-inline-link]')!.dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true, cancelable: true })))
    await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-link-lookup .note-link-option')).toHaveLength(2))
    await act(async () => (dom.container.querySelector('.note-link-lookup .note-link-option') as HTMLButtonElement).click())
    await vi.waitFor(() => { const content = useAppStore.getState().documents[sourceKey]!.content; expect(readNoteDocument(content)).toMatchObject({status:'valid',note:{content:{content:expect.arrayContaining([expect.objectContaining({content:expect.arrayContaining([expect.objectContaining({type:'noteLink',attrs:expect.objectContaining({target:{noteId:'target-id'}})})])})])}}}) })
    await click('Save')
    await vi.waitFor(() => expect(useAppStore.getState().dirtyDocuments[sourceKey]).toBe(false))
    const canonical = await readFile(join(rootPath, sourceRegion.path), 'utf8'), stored = useAppStore.getState().documents[sourceKey]!
    expect(stored.content).toBe(canonical); expect(editor()).toBe(originalEditor)
    await server.start()
    vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', join(process.cwd(), 'packages/core/bin/amux'))
    const result = await runCompiledObjectCli(['notebook', 'inspect', '--note', source.noteId, '--content'], objectCliEnvironment(rootPath, { AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path }))
    expect(result.code, result.stderr).toBe(0)
    const inspected = JSON.parse(result.stdout).result.content
    expect(inspected.content).toBe(canonical); expect(inspected.revision).toBe(stored.revision)
    expect(readNoteDocument(inspected.content).status).toBe('valid')
    expect(readNoteDocument(canonical)).toMatchObject({status:'valid',note:{content:{content:expect.arrayContaining([expect.objectContaining({content:expect.arrayContaining([expect.objectContaining({type:'noteLink',attrs:expect.objectContaining({target:{noteId:'target-id'}})})])})])}}})
    expect(inspected.noteProvenance.blocks['source-block'].lastEdited.actor).toEqual({kind:'user',id:'test-human'})
    const graph = await owner.graph(await store.read(), { noteId: 'target-id' })
    expect(graph.references).toEqual([expect.objectContaining({ mode: 'link', target: { kind: 'page', noteId: 'target-id' }, resolution: 'resolved' })])
  } finally { vi.unstubAllEnvs(); await server.stop(); await files.dispose(); await rm(rootPath, { recursive: true, force: true }) }
}, 45_000)
function display(surface = sourceRegion, tabId = mixed.id) {
  return { tabHostId: 'survey-note-test', reference: { displayWorkspaceId: 'workspace', groupId: 'original-group', tabId, regionId: surface.regionId } }
}
async function mount(surface = sourceRegion, tabId = mixed.id, confirmed = true) {
  const state = useAppStore.getState(), projection = { entity: { kind: 'zone' as const, zoneId }, presentationId: 'survey-workbench', displayWorkspaceId: 'workspace',
    catalog: spatialCatalog(state, []), selection: state.surveyZoneSelection!.selection.map(item => ({ ...item, displayWorkspaceId: 'workspace', groupId: 'original-group' })), onSelect: () => {} }
  await dom.render(<WorkbenchPresentationContext.Provider value={{ active: true, retainedRegionId: null, survey: true, projection, ...(confirmed ? display(surface, tabId) : {}) }}>
    <FileSurfaceView tabId={tabId} surface={surface} />
  </WorkbenchPresentationContext.Provider>)
  // Wait outside act for both real lazy layers; the first cold Source graph can exceed one second.
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('.note-block-content')).not.toBeNull() }, { timeout: 30_000 })
}
function editor(): Editor {
  const node = dom.container.querySelector<HTMLElement & { editor: Editor }>('.note-block-content')
  expect(node).not.toBeNull(); return node!.editor
}
function twoPositions(): WorkspaceLayout {
  return { root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: { type: 'leaf', groupId: 'original-group' }, second: { type: 'leaf', groupId: 'second-group' } },
    groups: [...createWorkspaceLayout('original-group', [mixed.id, referringTab.id]).groups, ...createWorkspaceLayout('second-group', [mixed.id]).groups], activeGroupId: 'original-group' }
}
async function click(label: string) {
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === label)
  expect(button, dom.container.textContent ?? '').toBeDefined(); await act(async () => button!.click())
}
it('connects the real FileSurfaceView to canonical update/save and the original Source toggle', async () => {
  await mount(); expect(dom.container.querySelector('textarea')).toBeNull()
  await act(async () => editor().commands.insertContentAt(1, 'Edited '))
  const state = useAppStore.getState(), raw = state.documents[sourceKey]!.content
  expect(state.dirtyDocuments[sourceKey]).toBe(true)
  const read = readNoteDocument(raw); expect(read.status).toBe('valid')
  if (read.status === 'valid') { expect(read.note.noteId).toBe('source-note'); expect(read.note.content.content![0]!.attrs!.blockId).toBe('source-block') }
  await click('Source'); await vi.waitFor(() => expect(dom.container.querySelector('textarea')?.value).toBe(raw))
  await click('Preview'); expect(editor().state.doc.textContent).toBe('Edited Original finding')
  await click('Save'); expect(api.files.write).toHaveBeenCalledTimes(1)
  expect(vi.mocked(api.files.write).mock.lastCall).toEqual(['workspace', { path: sourceRegion.path, content: raw, expectedRevision: 'source-revision' }])
  expect(useAppStore.getState().dirtyDocuments[sourceKey]).toBe(false)
}, 45_000)
it('uses the original conflict actions and preserves the rich draft rather than saving on a conflicting shortcut', async () => {
  await mount(); await act(async () => editor().commands.insertContentAt(1, 'Unsaved '))
  const raw = useAppStore.getState().documents[sourceKey]!.content
  await act(async () => useAppStore.setState({ documentIssues: { [sourceKey]: { kind: 'changed', observed: { path: sourceRegion.path, content: serializeNoteDocument(source), revision: 'external' } } } }))
  expect(dom.container.textContent).toContain('Your draft is preserved')
  expect([...dom.container.querySelectorAll('button')].map(button => button.textContent?.trim())).toContain('Overwrite')
  await act(async () => editor().view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })))
  expect(api.files.write).not.toHaveBeenCalled(); expect(useAppStore.getState().documents[sourceKey]!.content).toBe(raw)
})
it('renders per-block Agent authors and a non-blocking unconfirmed save notice while retaining canonical content', async () => {
  const authored = attributeNoteBlocks(null, source, { kind: 'agent', id: 'verified-author' }, _liveTailFixtureEpoch(0, 0, 100))
  const content = serializeNoteDocument(authored), revision = fileUploadRevision(new TextEncoder().encode(content)), workspace = composerConfig.workspaces.find(workspace => workspace.id === 'workspace')!
  useAppStore.setState({ documents: { ...useAppStore.getState().documents, [sourceKey]: { path: sourceRegion.path, content, revision, noteProvenance: { status: 'recorded', noteId: source.noteId, resource: { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path: sourceRegion.path }, revision, blocks: { 'source-block': authored.content.content![0]!.attrs!.provenance } } } } })
  await mount()
  const originalEditor = editor()
  expect(dom.container.querySelector('[data-note-agent-author]')?.getAttribute('data-note-agent-author')).toContain('verified-author')
  expect(dom.container.querySelector('[data-note-agent-author]')?.getAttribute('title')).toContain('Created: Agent verified-author')
  await act(async () => originalEditor.commands.insertContentAt(1, 'Edited '))
  const current = readNoteDocument(useAppStore.getState().documents[sourceKey]!.content)
  if (current.status !== 'valid') throw Error('Draft must remain valid')
  const canonical = serializeNoteDocument(attributeNoteBlocks(authored, current.note, undefined, _liveTailFixtureEpoch(0, 0, 200)))
  vi.mocked(api.files.write).mockResolvedValueOnce({ status: 'written', revision: 'canonical-revision', content: canonical, noteAttribution: { status: 'unconfirmed', reason: 'Original actor is unknown' } })
  await click('Save')
  expect(useAppStore.getState().documents[sourceKey]?.content).toBe(canonical)
  expect(dom.container.textContent).toContain('Block authorship is unconfirmed')
  expect(editor()).toBe(originalEditor)
  await act(async () => originalEditor.commands.insertContentAt(1, 'Another '))
  vi.mocked(api.files.write).mockResolvedValueOnce({ status: 'written', revision: 'next-revision', noteAttribution: { status: 'recorded' } })
  await click('Save')
  expect(api.files.write).toHaveBeenCalledTimes(2)
  expect(dom.container.textContent).not.toContain('Block authorship is unconfirmed')
}, 45_000)
it('returns to an existing mixed Tab second File Region without creating a canonical replacement or changing Space focus', async () => {
  await mount(referring, referringTab.id)
  const before = useAppStore.getState(), tabs = before.tabs, layout = before.layouts.workspace!, active = layout.groups[0]!.activeTabId, region = mixed.layout.activeRegionId
  const link = dom.container.querySelector<HTMLButtonElement>('.note-reference__source button')
  expect(link).not.toBeNull(); await act(async () => link!.click())
  expect(dom.container.querySelector('.note-surface > .note-knowledge-notice'), dom.container.textContent ?? '').toBeNull()
  const after = useAppStore.getState()
  expect(Object.keys(after.tabs)).toEqual(Object.keys(tabs))
  expect(after.tabs[fileTabId('workspace', sourceRegion.path)]).toBeUndefined()
  expect(after.tabs[mixed.id]).toBe(mixed)
  expect(after.tabs[mixed.id]!.layout.activeRegionId).toBe(region)
  expect(after.layouts.workspace!.groups[0]!.activeTabId).toBe(active)
  expect(after.mainSurface).toBe('survey')
  // Survey retains entity IDs; current display coordinates remain in the original projection/layout.
  expect(after.surveyZoneSelection?.active).toEqual({ tabId: mixed.id, regionId: sourceRegion.regionId })
  expect(after.documentRevealTargets[sourceKey]?.noteBlock).toEqual({ noteId: 'source-note', blockId: 'source-block' })
  expect(api.files.read).not.toHaveBeenCalled()
})
it('does not discover on render or rebuild the rich editor for unrelated Session status', async () => {
  const documents = useAppStore.getState().documents, entries = Object.entries
  let scans = 0
  vi.spyOn(Object, 'entries').mockImplementation(value => { if (value === documents) scans++; return entries(value) })
  const index = vi.spyOn(noteKnowledgeModule, 'noteKnowledge'), parse = vi.spyOn(noteDocumentModule, 'readNoteDocument')
  await mount(); const originalEditor = editor(), doc = originalEditor.state.doc, selection = originalEditor.state.selection.toJSON()
  expect(scans).toBeGreaterThan(0); expect(index).toHaveBeenCalled(); expect(parse).toHaveBeenCalled()
  const before = { scans, indexed: index.mock.calls.length, parsed: parse.mock.calls.length }
  await act(async () => useAppStore.setState({ sessions: [{ ...composerSession('unrelated'), latestOutputBytes: 512, status: { state: 'running', source: 'run-process', observedAt: 2 } }] }))
  expect({ scans, indexed: index.mock.calls.length, parsed: parse.mock.calls.length }).toEqual(before)
  expect(editor()).toBe(originalEditor); expect(editor().state.doc).toBe(doc); expect(editor().state.selection.toJSON()).toEqual(selection)
  expect(api.files.readDirectory).not.toHaveBeenCalled(); expect(api.files.read).not.toHaveBeenCalled()
  expect(dom.container.textContent).toContain('Partial scope')
})
it('does not rederive this directory for another project revision or an unrelated file issue', async () => {
  vi.mocked(api.files.readDirectory).mockResolvedValue([{ name: sourceRegion.path, path: sourceRegion.path, isDirectory: false, isSymlink: false }, { name: referring.path, path: referring.path, isDirectory: false, isSymlink: false }])
  const facts = vi.spyOn(noteDirectoryModule, 'noteDirectorySourceFacts')
  await mount(); await click('Refresh directory'); expect(facts).toHaveBeenCalled()
  const before = facts.mock.calls.length
  await act(async () => useAppStore.setState({ workspaceFileRevisions: { 'other-project': 10 }, documentIssues: { [documentKey('other-project', 'ordinary.txt')]: { kind: 'read-error', code: 'EIO', message: 'Unrelated error' } } }))
  expect(facts).toHaveBeenCalledTimes(before)
})
it('reads a valid reference-only Note without inserting content, assigning new IDs, or making it dirty', async () => {
  const before = useAppStore.getState().documents[referenceKey]!, generation = useAppStore.getState().documentGenerations[referenceKey]
  await mount(referring, referringTab.id)
  expect(editor().getJSON()).toEqual({ ...reference.content, content: reference.content.content.map(block => ({ ...block, attrs: { ...block.attrs, provenance: null } })) })
  expect(useAppStore.getState().documents[referenceKey]).toBe(before)
  expect(useAppStore.getState().dirtyDocuments[referenceKey]).toBeUndefined()
  expect(useAppStore.getState().documentGenerations[referenceKey]).toBe(generation)
  expect(api.files.write).not.toHaveBeenCalled()
})
it('returns to a different original Zone in Survey with its precise Region and preserves the Space layout', async () => {
  const targetZone = 'other-original-zone', targetTab = { ...mixed, space: { spaceId: birth, zoneId: targetZone } }
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [mixed.id]: targetTab } }))
  await mount(referring, referringTab.id)
  const before = useAppStore.getState(), tabs = before.tabs, layouts = before.layouts
  const link = dom.container.querySelector<HTMLButtonElement>('.note-reference__source button')
  expect(link).not.toBeNull(); await act(async () => link!.click())
  const after = useAppStore.getState()
  expect(after.mainSurface).toBe('survey'); expect(after.activeWorkspaceId).toBe('workspace')
  expect(after.surveyZoneSelection?.zoneId).toBe(targetZone)
  expect(after.surveyZoneSelection?.active).toEqual({ tabId: mixed.id, regionId: sourceRegion.regionId })
  expect(after.tabs).toBe(tabs); expect(after.layouts).toBe(layouts)
  expect(after.documentRevealTargets[sourceKey]?.noteBlock).toEqual({ noteId: 'source-note', blockId: 'source-block' })
  expect(api.files.read).not.toHaveBeenCalled(); expect(api.files.write).not.toHaveBeenCalled()
})
it('explicitly chooses among multiple original positions instead of silently taking the first Group', async () => {
  useAppStore.setState({ layouts: { workspace: twoPositions() } })
  await mount(referring, referringTab.id)
  const before = useAppStore.getState(), selection = before.surveyZoneSelection, tabs = before.tabs, layouts = before.layouts
  const link = dom.container.querySelector<HTMLButtonElement>('.note-reference__source button')
  expect(link).not.toBeNull(); await act(async () => link!.click())
  const choices = [...dom.container.querySelectorAll<HTMLButtonElement>('.note-source-choices button')]
  expect(choices).toHaveLength(2)
  expect(useAppStore.getState().surveyZoneSelection).toBe(selection)
  expect(useAppStore.getState().documentRevealTargets[sourceKey]).toBeUndefined()
  const second = choices.find(choice => choice.getAttribute('aria-label')?.includes('second-group'))
  expect(second).toBeDefined(); await act(async () => second!.click())
  expect(useAppStore.getState().surveyZoneSelection?.active).toEqual({ tabId: mixed.id, regionId: sourceRegion.regionId })
  expect(useAppStore.getState().tabs).toBe(tabs); expect(useAppStore.getState().layouts).toBe(layouts)
  expect(dom.container.querySelector('.note-source-choices')).toBeNull()
})
it('keeps the exact target when a block disappears while its original position chooser is open', async () => {
  useAppStore.setState({ layouts: { workspace: twoPositions() } }); await mount(referring, referringTab.id)
  const link = dom.container.querySelector<HTMLButtonElement>('.note-reference__source button')
  expect(link).not.toBeNull(); await act(async () => link!.click())
  await act(async () => useAppStore.getState().updateDocument(mixed.id, serializeNoteDocument(newNoteDocument('Replacement block', 'source-note', 'replacement-block')), sourceRegion.regionId))
  const selection = useAppStore.getState().surveyZoneSelection, tabs = useAppStore.getState().tabs
  const choices = [...dom.container.querySelectorAll<HTMLButtonElement>('.note-source-choices button')]
  expect(choices).toHaveLength(2); await act(async () => choices[1]!.click())
  expect(dom.container.querySelector('.note-surface > .note-knowledge-notice')?.textContent).toContain('no longer confirmed')
  expect(useAppStore.getState().surveyZoneSelection).toBe(selection); expect(useAppStore.getState().tabs).toBe(tabs)
  expect(useAppStore.getState().documentRevealTargets[sourceKey]).toBeUndefined()
  expect(readNoteDocument(useAppStore.getState().documents[referenceKey]!.content)).toEqual({ status: 'valid', note: reference, unanchoredBlockCount: 0 })
  expect(api.files.read).not.toHaveBeenCalled(); expect(api.files.write).not.toHaveBeenCalled()
})
it('checks its real directory only on explicit refresh and leaves closed Note sources unread without adding Tabs', async () => {
  vi.mocked(api.files.readDirectory).mockResolvedValue([
    { name: sourceRegion.path, path: sourceRegion.path, isDirectory: false, isSymlink: false },
    { name: referring.path, path: referring.path, isDirectory: false, isSymlink: false },
    { name: 'closed-source.note.md', path: 'closed-source.note.md', isDirectory: false, isSymlink: false }
  ])
  await mount(); expect(api.files.readDirectory).not.toHaveBeenCalled()
  const before = useAppStore.getState(), tabs = before.tabs, layouts = before.layouts, document = before.documents[sourceKey]
  await click('Refresh directory')
  expect(api.files.readDirectory).toHaveBeenCalledExactlyOnceWith('workspace', '')
  expect(dom.container.querySelector('.note-directory-sources')?.textContent).toContain('2 confirmed in this directory · partial')
  expect(dom.container.querySelector('.note-directory-sources')?.textContent).toContain('Not yet readclosed-source.note.md')
  expect(dom.container.querySelector('.note-backlinks')?.textContent).toContain('Partial scope')
  expect(useAppStore.getState().tabs).toBe(tabs); expect(useAppStore.getState().layouts).toBe(layouts)
  expect(useAppStore.getState().documents[sourceKey]).toBe(document)
  expect(useAppStore.getState().documents[documentKey('workspace', 'closed-source.note.md')]).toBeUndefined()
  expect(api.files.read).not.toHaveBeenCalled(); expect(api.files.write).not.toHaveBeenCalled()
})
it('retains a directory failure beside the original dirty Note without retrying, clearing it, or claiming complete knowledge', async () => {
  await mount(); await act(async () => editor().commands.insertContentAt(1, 'My draft '))
  const document = useAppStore.getState().documents[sourceKey]!, selection = useAppStore.getState().surveyZoneSelection
  await click('Refresh directory')
  expect(dom.container.querySelector('.note-directory-sources')?.textContent).toContain('Directory unconfirmed')
  expect(dom.container.querySelector('.note-surface > [role="status"]')?.textContent).toContain('Render must not discover directories')
  expect(useAppStore.getState().documents[sourceKey]).toBe(document); expect(useAppStore.getState().dirtyDocuments[sourceKey]).toBe(true)
  expect(useAppStore.getState().surveyZoneSelection).toBe(selection)
  expect(api.files.readDirectory).toHaveBeenCalledTimes(1); expect(api.files.write).not.toHaveBeenCalled()
})
it('persists an actual newly split block after the original canonical update without resetting the typing caret', async () => {
  await mount()
  await act(async () => { editor().view.focus(); editor().commands.setTextSelection(editor().state.doc.content.size - 1) })
  await act(async () => editor().view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  await act(async () => editor().commands.insertContent('Second finding'))
  const state = useAppStore.getState(), read = readNoteDocument(state.documents[sourceKey]!.content)
  expect(read.status).toBe('valid')
  if (read.status !== 'valid') throw new Error(read.message)
  expect(read.note.content.content).toHaveLength(2)
  const second = read.note.content.content![1]!, secondId = second.attrs!.blockId
  expect(secondId).toBeNull(); expect(read.unanchoredBlockCount).toBe(1); expect(second.content).toEqual([{ type: 'text', text: 'Second finding' }])
  expect(state.noteBlockSelections[noteBlockSelectionKey(display())]).toEqual({ noteId: 'source-note', blockId: 'source-block' })
  expect(editor().state.selection.$from.parent.attrs.blockId).toBe(secondId)
  expect(editor().state.selection.$from.parentOffset).toBe('Second finding'.length)
  expect(state.dirtyDocuments[sourceKey]).toBe(true); expect(api.files.write).not.toHaveBeenCalled()
})
it('restores a nonfirst semantic block without taking DOM focus or changing the original draft', async () => {
  const note = { ...source, content: { type: 'doc', content: [...source.content.content!, { type: 'paragraph', attrs: { blockId: 'second-block' }, content: [{ type: 'text', text: 'Unsaved second finding' }] }] } }
  const target = { noteId: source.noteId, blockId: 'second-block' }, key = noteBlockSelectionKey(display())
  useAppStore.setState(state => ({ documents: { ...state.documents, [sourceKey]: { ...state.documents[sourceKey]!, content: serializeNoteDocument(note) } }, dirtyDocuments: { [sourceKey]: true }, noteBlockSelections: { [key]: target } }))
  const originalDocument = useAppStore.getState().documents[sourceKey], otherInput = document.createElement('input')
  document.body.append(otherInput); otherInput.focus()
  await mount()
  expect(editor().state.selection.$from.parent.attrs.blockId).toBe('second-block')
  expect(document.activeElement).toBe(otherInput)
  expect(useAppStore.getState().noteBlockSelections[key]).toBe(target)
  expect(useAppStore.getState().documents[sourceKey]).toBe(originalDocument)
  expect(useAppStore.getState().dirtyDocuments[sourceKey]).toBe(true); expect(api.files.write).not.toHaveBeenCalled()
  otherInput.remove()
})
it('preserves an unknown restored block beside editing and never replaces it with the first block', async () => {
  const key = noteBlockSelectionKey(display()), target = { noteId: source.noteId, blockId: 'unconfirmed-block' }
  useAppStore.setState({ noteBlockSelections: { [key]: target } })
  await mount()
  expect(dom.container.textContent).toContain('saved block selection is not confirmed')
  expect(useAppStore.getState().noteBlockSelections[key]).toBe(target)
  expect(editor().view.hasFocus()).toBe(false)
  await act(async () => { editor().view.focus(); editor().commands.setTextSelection(2) })
  expect(useAppStore.getState().noteBlockSelections[key]).toEqual({ noteId: source.noteId, blockId: 'source-block' })
  expect(dom.container.textContent).not.toContain('saved block selection is not confirmed')
})
it('restores an atomic reference as a real NodeSelection without taking DOM focus or changing its canonical Note', async () => {
  const target = { noteId: reference.noteId, blockId: 'referring-block' }, key = noteBlockSelectionKey(display(referring, referringTab.id))
  useAppStore.setState({ noteBlockSelections: { [key]: target } })
  const originalDocument = useAppStore.getState().documents[referenceKey], otherInput = document.createElement('input')
  document.body.append(otherInput); otherInput.focus()
  await mount(referring, referringTab.id)
  expect(editor().state.selection.toJSON()).toEqual({ type: 'node', anchor: 0 })
  expect(document.activeElement).toBe(otherInput)
  expect(useAppStore.getState().documents[referenceKey]).toBe(originalDocument)
  expect(useAppStore.getState().noteBlockSelections[key]).toBe(target)
  expect(useAppStore.getState().dirtyDocuments[referenceKey]).toBeUndefined(); expect(api.files.write).not.toHaveBeenCalled()
  otherInput.remove()
})
it('continues editing with a persistent selection-recovery notice when the exact display is unconfirmed', async () => {
  await mount(sourceRegion, mixed.id, false)
  expect(dom.container.textContent).toContain('Block selection recovery is unconfirmed')
  await act(async () => { editor().view.focus(); editor().commands.insertContentAt(1, 'Preserved ') })
  expect(useAppStore.getState().dirtyDocuments[sourceKey]).toBe(true)
  expect(useAppStore.getState().noteBlockSelections).toEqual({})
  expect(dom.container.textContent).toContain('Block selection recovery is unconfirmed')
})
it('honors a current explicit Region caret request while retaining an unknown saved block and its notice', async () => {
  const key = noteBlockSelectionKey(display()), target = { noteId: source.noteId, blockId: 'unconfirmed-block' }
  const originalBounds = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('note-block-content') ? new DOMRect(0, 0, 400, 300) : originalBounds.call(this)
  })
  useAppStore.setState({ noteBlockSelections: { [key]: target }, regionCaretFocus: { regionId: sourceRegion.regionId, nonce: 99 } })
  const originalDocument = useAppStore.getState().documents[sourceKey]
  await mount()
  expect(document.activeElement).toBe(editor().view.dom)
  expect(useAppStore.getState().regionCaretFocus).toBeNull()
  expect(useAppStore.getState().noteBlockSelections[key]).toBe(target)
  expect(dom.container.textContent).toContain('saved block selection is not confirmed')
  expect(useAppStore.getState().documents[sourceKey]).toBe(originalDocument)
  expect(api.files.write).not.toHaveBeenCalled()
})
it('opens an explicitly chosen unread directory source through the original File owner in the current Zone', async () => {
  const path = 'closed-source.note.md', note = newNoteDocument('Previously unread source', 'closed-note', 'closed-block')
  vi.mocked(api.files.readDirectory).mockResolvedValue([{ name: sourceRegion.path, path: sourceRegion.path, isDirectory: false, isSymlink: false }, { name: path, path, isDirectory: false, isSymlink: false }])
  vi.mocked(api.files.read).mockResolvedValue({ status: 'read', document: { path, content: serializeNoteDocument(note), revision: 'closed-revision' } })
  await mount(); await click('Refresh directory')
  expect(api.files.read).not.toHaveBeenCalled(); expect(useAppStore.getState().tabs[fileTabId('workspace', path)]).toBeUndefined()
  const open = dom.container.querySelector<HTMLButtonElement>(`button[aria-label="Open Note source workspace · ${path}"]`)
  expect(open).not.toBeNull(); await act(async () => open!.click())
  expect(api.files.read).toHaveBeenCalledExactlyOnceWith('workspace', path)
  expect(useAppStore.getState().tabs[fileTabId('workspace', path)]?.space).toEqual(mixed.space)
  expect(useAppStore.getState().documents[documentKey('workspace', path)]?.content).toBe(serializeNoteDocument(note))
  expect(useAppStore.getState().mainSurface).toBe('survey')
  expect(api.files.write).not.toHaveBeenCalled()
})

it('retains the original selected block through real editor unmount and framework remount', async () => {
  const note = { ...source, content: { type: 'doc', content: [...source.content.content!, { type: 'paragraph', attrs: { blockId: 'remount-block' }, content: [{ type: 'text', text: 'Remount target' }] }] } }
  useAppStore.setState(state => ({ documents: { ...state.documents, [sourceKey]: { ...state.documents[sourceKey]!, content: serializeNoteDocument(note) } } }))
  await mount()
  const originalEditor = editor()
  const originalDocument = useAppStore.getState().documents[sourceKey], target = { noteId: source.noteId, blockId: 'remount-block' }
  const key = noteBlockSelectionKey(display())
  await act(async () => originalEditor.unmount())
  await act(async () => useAppStore.setState({ noteBlockSelections: { [key]: target } }))
  expect(dom.container.querySelector('.note-file-view')).not.toBeNull()
  expect(useAppStore.getState().noteBlockSelections[key]).toBe(target)
  expect(useAppStore.getState().documents[sourceKey]).toBe(originalDocument)
  await vi.waitFor(() => expect(editor().isDestroyed).toBe(false))
  expect(editor().state.selection.$from.parent.attrs.blockId).toBe(target.blockId)
  expect(editor().view.hasFocus()).toBe(false)
  await act(async () => { editor().view.focus(); editor().commands.insertContentAt(1, 'Recovered ') })
  expect(useAppStore.getState().documents[sourceKey]!.content).toContain('Recovered Original finding')
  await click('Save')
  expect(useAppStore.getState().dirtyDocuments[sourceKey]).toBe(false)
})

it('publishes a Note handle only while its actual view is mounted and republishes the same editor identity', async () => {
  const published: { handle: NoteEditorHandle | null } = { handle: null }
  await dom.render(<NoteBlockEditor note={source} knowledge={noteKnowledgeModule.noteKnowledge([])} onChange={() => {}} onOpen={() => {}} onSave={() => {}} onIssue={() => {}} handleRef={value => { published.handle = value }} />)
  const originalEditor = editor(), contentHost = originalEditor.view.dom.parentElement!
  expect(published.handle?.editor).toBe(originalEditor)
  await act(async () => originalEditor.unmount())
  expect(published.handle).toBeNull()
  await act(async () => originalEditor.mount(contentHost))
  expect(published.handle?.editor).toBe(originalEditor)
  expect(published.handle?.focusBlock('source-block', false)).toBe(true)
})

it('reveals an explicitly opened late original block inside the File viewport while passive restore preserves scroll and the unsaved editor', async () => {
  const note = { ...source, content: { type: 'doc', content: [
    ...Array.from({ length: 50 }, (_, i) => ({ type: 'paragraph', attrs: { blockId: 'context-' + i }, content: [{ type: 'text', text: 'Original context ' + i }] })),
    { type: 'blockquote', attrs: { blockId: 'folded-original' }, content: [
      { type: 'paragraph', attrs: { blockId: 'first-child' }, content: [{ type: 'text', text: 'Parent context remains' }] },
      { type: 'paragraph', attrs: { blockId: 'tail-block' }, content: [{ type: 'text', text: 'Exact late original with unsaved context' }] },
    ] },
  ] } }
  const target = { noteId: source.noteId, blockId: 'tail-block' }, key = noteBlockSelectionKey(display())
  useAppStore.setState(state => ({ documents: { ...state.documents, [sourceKey]: { ...state.documents[sourceKey]!, content: serializeNoteDocument(note) } }, dirtyDocuments: { [sourceKey]: true }, noteBlockSelections: { [key]: target } }))
  dom.container.classList.add('test-original-note-scroll')
  const viewport = dom.container
  // Browser geometry only: the real ProseMirror scrollIntoView walks this original File viewport.
  const rectangle = (element: Element) => element.closest('[hidden]') || element.getAttribute('data-block-id') === 'tail-block' && element.closest('.note-block--folded') ? new DOMRect(0, 0, 0, 0) : element === viewport ? new DOMRect(0, 0, 800, 400)
    : element.getAttribute('data-block-id') === 'tail-block' ? new DOMRect(10, 2400 - viewport.scrollTop, 780, 30) : new DOMRect(0, 0, 800, 6000)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) { return rectangle(this) })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function(this: HTMLElement) { return this === viewport ? 400 : this.dataset.blockId === 'tail-block' ? 30 : 6000 })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function(this: HTMLElement) { return this === viewport ? 400 : this.dataset.blockId === 'tail-block' ? 30 : 6000 })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800)
  // happy-dom has no layout scroll operation: implement only native geometric scrolling, not Note lookup.
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function(this: HTMLElement) {
    const box = this.getBoundingClientRect(), screen = viewport.getBoundingClientRect()
    viewport.scrollTop += box.top - screen.top - (screen.height - box.height) / 2
  })
  const rangeRect = (range: Range) => rectangle(range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement!)
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(function(this: Range) { return rangeRect(this) })
  vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function(this: Range) { const rect = rangeRect(this); return Object.assign([rect], { item: () => rect }) as unknown as DOMRectList })
  const originalDocument = useAppStore.getState().documents[sourceKey], other = document.createElement('input')
  document.body.append(other); other.focus()
  await mount()
  const originalEditor = editor()
  expect(originalEditor.state.selection.$from.parent.attrs.blockId).toBe('tail-block')
  expect(viewport.scrollTop).toBe(0)
  expect(document.activeElement).toBe(other)
  await dom.click('[aria-label="Fold or unfold nested blocks"]')
  expect(originalEditor.view.dom.querySelector('.note-block--folded')).not.toBeNull()
  viewport.hidden = true
  await act(async () => useAppStore.setState({ documentRevealTargets: { [sourceKey]: { line: 1, noteBlock: target } } }))
  expect(useAppStore.getState().documentRevealTargets[sourceKey]?.noteBlock).toEqual(target)
  expect(originalEditor.view.dom.querySelector('.note-block--folded')).not.toBeNull()
  expect(viewport.scrollTop).toBe(0)
  await act(async () => { viewport.hidden = false })
  await vi.waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(1900))
  expect(originalEditor.view.dom.querySelector('.note-block--folded')).toBeNull()
  expect(useAppStore.getState().documentRevealTargets[sourceKey]).toBeUndefined()
  const row = originalEditor.view.dom.querySelector<HTMLElement>('[data-block-id="tail-block"]')!
  expect(row.getBoundingClientRect().top).toBeGreaterThanOrEqual(0)
  expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual(400)
  expect(editor()).toBe(originalEditor)
  expect(editor().state.selection.$from.parent.attrs.blockId).toBe('tail-block')
  expect(useAppStore.getState().documents[sourceKey]).toBe(originalDocument)
  expect(useAppStore.getState().dirtyDocuments[sourceKey]).toBe(true)
  expect(api.files.write).not.toHaveBeenCalled()
  other.remove()
})

it.each(['different-note', 'whole-page', 'external-block', 'graph-view'] as const)('keeps a hidden Graph block request from overriding the later %s navigation intent', async later => {
  installNoteCanvasGeometry()
  const note = newNoteDocument('Original first block ', source.noteId, 'source-block')
  note.content.content![0]!.content!.push(
    { type: 'noteLink', attrs: { referenceId: 'local-tail', text: 'Exact original tail', target: { noteId: note.noteId, blockId: 'tail-block' } } },
    { type: 'noteLink', attrs: { referenceId: 'local-page', text: 'Whole original page', target: { noteId: note.noteId } } },
  )
  note.content.content!.push({ type: 'paragraph', attrs: { blockId: 'tail-block' }, content: [{ type: 'text', text: 'Original late target' }] })
  const saved = { path: sourceRegion.path, revision: 'source-revision', content: serializeNoteDocument(note) }
  useAppStore.setState(state => ({ documents: { ...state.documents, [sourceKey]: saved }, dirtyDocuments: { [sourceKey]: true }, noteCanvasLayouts: {} }))
  const workspace = composerConfig.workspaces.find(workspace => workspace.id === 'workspace')!, catalog = emptyNotebookState()
  const page: NotebookPage = { noteId: note.noteId, title: 'Original Note', notebookId: 'quick-notes', parentNoteId: null,
    resource: { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path: saved.path }, workface: { zoneId, workspaceId: workspace.id }, sources: [], topics: [], createdAt: _tailRefreshFixtureEpoch(0, 0, 1), updatedAt: _tailRefreshFixtureEpoch(0, 0, 1) }
  catalog.pages[page.noteId] = page
  useNotebookLibrary.setState({ state: catalog })
  const observation = { status: 'read' as const, noteId: note.noteId, actualNoteId: note.noteId, revision: saved.revision, resource: page.resource, blockIds: ['source-block', 'tail-block'] }
  vi.spyOn(api.notebooks, 'graph').mockResolvedValue({ catalog, graph: { catalogRevision: catalog.revision, scope: { kind: 'catalog' }, scannedScope: 'catalog', completeness: 'complete', hierarchy: [], references: [], observations: [observation], duplicateNoteIds: [] } })
  vi.spyOn(api.notebooks, 'content').mockResolvedValue({ ...observation, content: saved.content })
  vi.spyOn(api.notebooks, 'onChange').mockImplementation(() => () => {})
  const viewport = dom.container
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    return this.closest('[hidden]') ? new DOMRect(0, 0, 0, 0) : new DOMRect(0, 0, 900, 600)
  })
  const scrolled: string[] = []
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function(this: HTMLElement) { scrolled.push(this.dataset.blockId ?? '') })
  await mount()
  async function graphLink(text: string) {
    await dom.click('[aria-label="Graph view"]')
    await vi.waitFor(() => expect(dom.container.querySelector('.note-canvas-title[data-note-id="source-note"]')).not.toBeNull())
    if (dom.container.querySelector('[aria-label="Full note: Original Note"]')) await dom.click('[aria-label="Full note: Original Note"]')
    else if (dom.container.querySelector('.note-canvas-body-state button')) await dom.click('.note-canvas-body-state button')
    await vi.waitFor(() => expect([...dom.container.querySelectorAll('.note-canvas-reader [data-note-inline-link]')].some(element => element.textContent?.includes(text)), dom.container.textContent ?? '').toBe(true))
    const link = [...dom.container.querySelectorAll<HTMLButtonElement>('.note-canvas-reader [data-note-inline-link]')].find(element => element.textContent?.includes(text))!
    await act(async () => { viewport.hidden = true; link.click() })
    await vi.waitFor(() => expect(dom.container.querySelector('.note-association-canvas')).toBeNull())
  }
  await graphLink('Exact original tail')
  expect(dom.container.textContent).toContain('selected original block has not been revealed yet')
  expect(scrolled).toEqual([])
  if (later === 'different-note') {
    const replacement = { ...note, noteId: 'replacement-note' }
    await act(async () => useAppStore.setState(state => ({ documents: { ...state.documents, [sourceKey]: { ...saved, content: serializeNoteDocument(replacement) } } })))
  } else if (later === 'whole-page') {
    await graphLink('Whole original page')
  } else {
    await act(async () => {
      useAppStore.setState({ documentRevealTargets: { [sourceKey]: { line: 1, noteBlock: { noteId: note.noteId, blockId: later === 'graph-view' ? 'not-yet-present' : 'source-block' } } } })
    })
    if (later === 'graph-view') {
      await act(async () => { viewport.hidden = false })
      await dom.click('[aria-label="Graph view"]')
      await vi.waitFor(() => expect(dom.container.querySelector('.note-association-canvas')).not.toBeNull())
    }
  }
  await act(async () => { viewport.hidden = false })
  if (later === 'external-block') await vi.waitFor(() => expect(useAppStore.getState().documentRevealTargets[sourceKey]).toBeUndefined())
  await act(async () => {})
  expect(scrolled).toEqual(later === 'external-block' ? ['source-block'] : [])
  if (later === 'graph-view') {
    expect(dom.container.querySelector('.note-association-canvas')).not.toBeNull()
    expect(useAppStore.getState().documentRevealTargets[sourceKey]?.noteBlock).toEqual({ noteId: note.noteId, blockId: 'not-yet-present' })
  }
  if (later === 'different-note') expect(dom.container.textContent).toContain('belongs to a different Note or file location')
  expect(editor().state.selection.$from.parent.attrs.blockId).toBe('source-block')
  expect(useAppStore.getState().dirtyDocuments[sourceKey]).toBe(true)
  expect(api.files.write).not.toHaveBeenCalled()
})
