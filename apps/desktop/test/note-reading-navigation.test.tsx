// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceLayout } from '@agentmux/layout'
import { emptyNotebookState, type NotebookState } from '@agentmux/core/notebook-catalog'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { NotebookObservationOwner } from '@agentmux/host/notebook-observation-owner'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { NoteReadingReturn } from '../src/renderer/src/components/NoteReadingReturn'
import { NoteFileSurfaceView } from '../src/renderer/src/components/NoteFileSurfaceView'
import { api } from '../src/renderer/src/lib/api'
import { rememberNoteReadingReturn, clearNoteReadingReturn, useNoteReadingReturn, type NoteReadingReturn as Journey } from '../src/renderer/src/lib/note-reading-return'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { useNoteLinkNavigation } from '../src/renderer/src/lib/use-note-link-navigation'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { useNotebookLibrary } from '../src/renderer/src/lib/notebook-library'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { newNoteDocument } from '../src/shared/note-document'
import type { WorkbenchProjectionSelection as Reference } from '../src/renderer/src/lib/workbench-projection'
import type { NoteFileTarget } from '../src/renderer/src/lib/file-document-consumers'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { NoteSnapshotTestWorker } from './note-snapshot-test-worker'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'
import { NoteViewToolbarContext } from '../src/renderer/src/lib/note-view-toolbar'

const dom = composerDOM(), initialLibrary = useNotebookLibrary.getState()
const workspace = composerConfig.workspaces[0]!
const original: NoteFileTarget = { workspaceId: workspace.id, hostId: workspace.hostId, workspacePath: workspace.path, path: 'original.note.md', noteId: 'reading-original' }
const from: Reference = { displayWorkspaceId: workspace.id, groupId: 'reading-group', tabId: 'reading-original-tab', regionId: 'reading-original-region' }
const to: Reference = { ...from, tabId: 'reading-target-tab', regionId: 'reading-target-region' }
const onward: Reference = { ...from, tabId: 'reading-onward-tab', regionId: 'reading-onward-region' }
const saved = newNoteDocument('Original saved body', original.noteId, 'reading-block', 'Original reading')
const draft = { path: original.path, content: serializeNoteDocument(saved).replace('Original saved body', 'My unsaved reading draft'), revision: 'original-revision' }
const cleanups: (() => Promise<void>)[] = []
let latest: Journey | null = null

function resetJourney() {
  const reset = { from: { ...from, tabId: 'reset-' + crypto.randomUUID() }, to: { ...to, tabId: 'reset-' + crypto.randomUUID() }, original, title: 'reset', surface: 'recall' as const }
  rememberNoteReadingReturn(reset); clearNoteReadingReturn(reset); latest = null
}
function ReturnSurface({ reference = to, onSelect = (selected: Reference) => useAppStore.getState().setRecallZoneSelection({ zoneId: 'reading-zone', selection: [selected], active: selected }) }: { reference?: Reference; onSelect?: (selected: Reference) => void }) {
  latest = useNoteReadingReturn(reference, useAppStore(state => state.mainSurface))
  const projection = { entity: { kind: 'zone' as const, zoneId: 'reading-zone' }, presentationId: 'recall-workbench', displayWorkspaceId: workspace.id,
    catalog: spatialCatalog(useAppStore.getState(), []), selection: [reference], onSelect }
  return <WorkbenchPresentationContext.Provider value={{ active: true, retainedRegionId: null, reference, projection }}><NoteReadingReturn /></WorkbenchPresentationContext.Provider>
}
function LinkSurface({ active = true, sourceIdentity = 'original', target = 'independent-shared', onOpenFile }: {
  active?: boolean; sourceIdentity?: string; target?: string; onOpenFile(file: NoteFileTarget, blockId?: string): Promise<void>
}) {
  const navigation = useNoteLinkNavigation(() => { throw Error('No synthetic catalog page is allowed') }, emptyNotebookState(), active,
    undefined, sourceIdentity, onOpenFile)
  return <><button aria-label="Open exact shared link" onClick={() => void navigation.openLink({ text: 'Shared readable label', target: { noteId: target } })}>Open link</button>{navigation.dialog}</>
}

beforeEach(() => {
  resetJourney(); vi.stubGlobal('Worker', NoteSnapshotTestWorker)
  const tabs = Object.fromEntries([from, to, onward].map(reference => [reference.tabId, createWorkbenchTab(reference.tabId, {
    kind: 'file', regionId: reference.regionId, workspaceId: workspace.id, path: reference === from ? original.path : reference === to ? 'target.note.md' : 'onward.note.md'
  })]))
  useAppStore.setState({ config: composerConfig, activeWorkspaceId: workspace.id, mainSurface: 'recall',
    tabs, layouts: { [workspace.id]: createWorkspaceLayout(from.groupId, [from.tabId, to.tabId, onward.tabId]) },
    documents: { [documentKey(workspace.id, original.path)]: draft }, dirtyDocuments: { [documentKey(workspace.id, original.path)]: true },
    documentRevealTargets: {}, noteDirectorySources: {}, documentIssues: {}, workspaceFileRevisions: {},
    recallNotebookId: 'quick-notes', recallNoteId: null, recallZoneSelection: { zoneId: 'reading-zone', selection: [to], active: to }, regionCaretFocus: null })
  useNotebookLibrary.setState({ state: emptyNotebookState(), issue: null })
  vi.spyOn(api.notebooks, 'read').mockResolvedValue(emptyNotebookState())
})
afterEach(async () => {
  resetJourney(); useNotebookLibrary.setState(initialLibrary, true)
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function originalSharedOwner() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-reading-navigation-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ownerWorkspace = { ...workspace, path: root }
  const files = new WorkspaceFiles(() => ({ kind: 'local', id: 'local' }) as never)
  cleanups.push(async () => files.dispose())
  const metadata = new AgentMuxNotebookStore(join(root, 'catalog.json'))
  const shared = { ...newNoteDocument('Independent saved content', 'independent-shared', 'inside-shared', 'Shared readable label'), kind: 'shared-block' as const }
  const host = newNoteDocument('', 'registered-host', 'host-block')
  host.content.content = [{ type: 'noteInclude', attrs: { blockId: 'host-block', referenceId: 'saved-use', noteId: shared.noteId, path: 'shared.note.md' } }]
  await writeFile(join(root, 'host.note.md'), serializeNoteDocument(host)); await writeFile(join(root, 'shared.note.md'), serializeNoteDocument(shared))
  await metadata.apply({ operationId: 'register-host', expectedRevision: (await metadata.read()).revision,
    change: { kind: 'register', noteId: host.noteId, title: 'Host', resource: { hostId: 'local', workspaceId: workspace.id, workspacePath: root, path: 'host.note.md' } } }, { kind: 'user', id: 'reader' })
  const state = await metadata.read(), owner = new NotebookObservationOwner({ workspace: () => ownerWorkspace, files, metadata })
  const graph = await owner.graph(state, {})
  expect(graph.observations.find(item => item.noteId === shared.noteId)).toMatchObject({ kind: 'shared-block', fileIdentity: 'confirmed' })
  expect(state.pages[shared.noteId]).toBeUndefined()
  return { state, owner, shared, resource: { hostId: 'local', workspaceId: workspace.id, workspacePath: root, path: 'shared.note.md' } }
}

it('opens an uncatalogued shared content link from the actual observation owner without synthesizing a page', async () => {
  const f = await originalSharedOwner(), opened = vi.fn(async () => {})
  vi.mocked(api.notebooks.read).mockResolvedValue(f.state)
  vi.spyOn(api.notebooks, 'graph').mockImplementation(async (params, options) => ({ catalog: f.state, graph: await f.owner.graph(f.state, params, options) }))
  const write = vi.spyOn(api.files, 'write'), before = useAppStore.getState().documents
  await dom.render(<LinkSurface onOpenFile={opened} />); await dom.click('[aria-label="Open exact shared link"]')
  await vi.waitFor(() => expect(opened).toHaveBeenCalledWith({ ...f.resource, noteId: f.shared.noteId }, undefined, expect.any(AbortSignal)))
  expect(dom.container.querySelector('.note-link-lookup')).toBeNull()
  expect(f.state.pages[f.shared.noteId]).toBeUndefined(); expect(useAppStore.getState().documents).toBe(before)
  expect(write).not.toHaveBeenCalled()
})

it('keeps an unknown shared target and its original link available for retry without writing or opening a substitute', async () => {
  const f = await originalSharedOwner(), opened = vi.fn(async () => {}), write = vi.spyOn(api.files, 'write')
  const graph = await f.owner.graph(f.state, {})
  const shared = graph.observations.find(item => item.noteId === f.shared.noteId)!
  if (shared.status !== 'read') throw Error('The original fixture must have a readable shared file')
  shared.fileIdentity = 'unknown'; graph.completeness = 'partial'
  vi.spyOn(api.notebooks, 'graph').mockResolvedValue({ catalog: f.state, graph })
  await dom.render(<LinkSurface onOpenFile={opened} />); await dom.click('[aria-label="Open exact shared link"]')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('original shared content is unconfirmed'))
  expect(dom.container.textContent).toContain('[[Shared readable label]]')
  expect(dom.container.querySelector('.note-link-lookup button')?.textContent).toBe('Close')
  expect(opened).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
  expect(useAppStore.getState().documents[documentKey(workspace.id, original.path)]).toBe(draft)
})

it('cancels a delayed shared lookup after a later source navigation without opening the old target', async () => {
  const f = await originalSharedOwner(), opened = vi.fn(async () => {})
  let release!: (value: Awaited<ReturnType<typeof api.notebooks.graph>>) => void
  const content = vi.spyOn(api.notebooks, 'graph').mockImplementation(() => new Promise(resolve => { release = resolve }))
  await dom.render(<LinkSurface onOpenFile={opened} />); await dom.click('[aria-label="Open exact shared link"]')
  await vi.waitFor(() => expect(content).toHaveBeenCalledTimes(1))
  const signal = content.mock.calls[0]![1]?.signal
  await dom.render(<LinkSurface sourceIdentity="later-note" onOpenFile={opened} />)
  expect(signal?.aborted).toBe(true)
  await act(async () => release({ catalog: f.state, graph: await f.owner.graph(f.state, {}) }))
  expect(opened).not.toHaveBeenCalled(); expect(dom.container.querySelector('.note-link-lookup')).toBeNull()
})

it('returns by selecting the retained exact occurrence without opening, revealing or writing its draft', async () => {
  const selected = vi.fn((reference: Reference) => useAppStore.getState().setRecallZoneSelection({ zoneId: 'reading-zone', selection: [reference], active: reference })), open = vi.spyOn(useAppStore.getState(), 'openFile'), read = vi.spyOn(api.files, 'read'), write = vi.spyOn(api.files, 'write')
  rememberNoteReadingReturn({ from, to, original, title: 'Original reading', surface: 'recall' })
  const before = useAppStore.getState(), reveals = before.documentRevealTargets
  await dom.render(<ReturnSurface onSelect={selected} />); expect(latest?.from).toEqual(from)
  await dom.click('.note-reading-return button')
  expect(selected).toHaveBeenCalledExactlyOnceWith(from); expect(dom.container.querySelector('.note-reading-return')).toBeNull()
  expect(useAppStore.getState().documents).toBe(before.documents); expect(useAppStore.getState().documentRevealTargets).toBe(reveals)
  expect(useAppStore.getState().dirtyDocuments[documentKey(workspace.id, original.path)]).toBe(true)
  expect(open).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
})

it.each(['host', 'workspace', 'note', 'selection'] as const)('retains the return target when the original %s is unconfirmed and can retry the same origin', async fault => {
  const applySelection = (reference: Reference) => useAppStore.getState().setRecallZoneSelection({ zoneId: 'reading-zone', selection: [reference], active: reference })
  const selected = vi.fn(fault === 'selection' ? (_reference: Reference) => {} : applySelection), write = vi.spyOn(api.files, 'write')
  rememberNoteReadingReturn({ from, to, original, title: 'Original reading', surface: 'recall' })
  if (fault === 'host' || fault === 'workspace') useAppStore.setState({ config: { ...composerConfig, workspaces: [{ ...workspace,
    ...(fault === 'host' ? { hostId: 'another-host' } : { path: workspace.path + '/rebound' }) }] } })
  if (fault === 'note') useAppStore.setState({ documents: { [documentKey(workspace.id, original.path)]: { ...draft, content: draft.content.replace(original.noteId, 'another-note') } } })
  await dom.render(<ReturnSurface onSelect={selected} />); const held = latest
  await dom.click('.note-reading-return button')
  expect(dom.container.textContent).toContain(fault === 'selection' ? 'Returning to the original reading position was not confirmed' : 'original reading position is unavailable')
  expect(latest).toBe(held); expect(dom.container.querySelector('.note-reading-return button')).not.toBeNull()
  expect(write).not.toHaveBeenCalled()
  if (fault !== 'selection') expect(selected).not.toHaveBeenCalled()
  await act(async () => { useAppStore.setState({ config: composerConfig, documents: { [documentKey(workspace.id, original.path)]: draft } }); selected.mockImplementation(applySelection) })
  await dom.click('.note-reading-return button'); expect(dom.container.querySelector('.note-reading-return')).toBeNull()
})

it('keeps the original start through a multi-target journey and ignores another display occurrence', async () => {
  const selected = vi.fn((reference: Reference) => useAppStore.getState().setRecallZoneSelection({ zoneId: 'reading-zone', selection: [reference], active: reference }))
  rememberNoteReadingReturn({ from, to, original, title: 'Original reading', surface: 'recall' })
  rememberNoteReadingReturn({ from: to, to: onward, original: { ...original, noteId: 'intermediate' }, title: 'Intermediate', surface: 'recall' })
  await dom.render(<ReturnSurface reference={{ ...onward, groupId: 'another-group' }} />)
  expect(dom.container.querySelector('.note-reading-return')).toBeNull()
  await dom.render(<ReturnSurface reference={onward} onSelect={selected} />)
  expect(latest?.from).toEqual(from); expect(dom.container.textContent).toContain('Return to Original reading')
  await dom.click('.note-reading-return button'); expect(selected).toHaveBeenCalledExactlyOnceWith(from)
})

it.each(['applied', 'unconfirmed', 'later-navigation', 'cancelled-read'] as const)('retains the real destination receipt across Groups when navigation is %s', async outcome => {
  const otherGroup = 'actual-target-group', actual = { ...to, groupId: otherGroup }
  const spaceId = directoryIdentity(workspace.hostId, workspace.path), zoneId = homeZoneId(spaceId)
  const link = newNoteDocument('Unsaved origin ', original.noteId, 'reading-block', 'Original reading')
  link.content.content![0]!.content!.push({ type: 'noteLink', attrs: { referenceId: 'exact-target', text: 'Original target', target: { noteId: 'target-note' } }, content: [{ type: 'text', text: '[[Original target]]' }] })
  const target = newNoteDocument('Target saved content', 'target-note', 'target-block', 'Original target')
  const layout = createWorkspaceLayout(from.groupId, [from.tabId])
  layout.root = { type: 'split', direction: 'horizontal', ratio: 0.5, first: { type: 'leaf', groupId: from.groupId }, second: { type: 'leaf', groupId: otherGroup } }
  layout.groups.push({ ...layout.groups[0]!, id: otherGroup, tabOrder: [to.tabId], activeTabId: to.tabId, recentTabIds: [to.tabId] })
  const tabs = Object.fromEntries([from, to].map(reference => [reference.tabId, { ...createWorkbenchTab(reference.tabId, { kind: 'file', regionId: reference.regionId,
    workspaceId: workspace.id, path: reference === from ? original.path : 'target.note.md' }), space: { spaceId, zoneId } }]))
  const catalog: NotebookState = emptyNotebookState()
  catalog.pages['target-note'] = { noteId: 'target-note', notebookId: 'quick-notes', parentNoteId: null, title: 'Original target',
    resource: { ...original, path: 'target.note.md' }, workface: { zoneId, workspaceId: workspace.id }, sources: [], topics: [], createdAt: 1, updatedAt: 1 }
  useNotebookLibrary.setState({ state: catalog })
  useAppStore.setState({ mainSurface: 'recall', layouts: { [workspace.id]: layout }, tabs,
    documents: { [documentKey(workspace.id, original.path)]: { ...draft, content: serializeNoteDocument(link) },
      [documentKey(workspace.id, 'target.note.md')]: { path: 'target.note.md', content: serializeNoteDocument(target), revision: 'target-revision' } },
    spaceZoneBindings: {}, scratchTopicSnapshots: {}, spatialRequests: {}, recallZoneSelection: { zoneId, selection: [{ tabId: from.tabId, regionId: from.regionId }], active: { tabId: from.tabId, regionId: from.regionId } } })
  const projection = { entity: { kind: 'zone' as const, zoneId }, presentationId: 'recall-workbench', displayWorkspaceId: workspace.id,
    catalog: spatialCatalog(useAppStore.getState(), []), selection: [from], onSelect: vi.fn((reference: Reference) => {
      if (outcome === 'applied') useAppStore.getState().setRecallZoneSelection({ zoneId, selection: [reference], active: reference })
    }) }
  const readResult = { status: 'read' as const, document: { path: 'target.note.md', content: serializeNoteDocument(target), revision: 'target-revision' } }
  let release!: (result: typeof readResult) => void
  const read = vi.spyOn(api.files, 'read').mockResolvedValue(readResult)
  if (outcome === 'later-navigation' || outcome === 'cancelled-read') read.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined); vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  await dom.render(<WorkbenchPresentationContext.Provider value={{ active: true, retainedRegionId: null, tabHostId: 'local', reference: from, projection }}>
    <NoteFileSurfaceView tabId={from.tabId} surface={tabs[from.tabId]!.regions[from.regionId] as never} />
  </WorkbenchPresentationContext.Provider>)
  const button = dom.container.querySelector('[data-note-inline-link]')!
  expect(button).not.toBeNull()
  await act(async () => button.dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true, cancelable: true })))
  if (outcome === 'cancelled-read') {
    await vi.waitFor(() => expect(read).toHaveBeenCalled())
    await dom.click('.note-link-lookup button')
    expect(dom.container.querySelector('.note-link-lookup')).toBeNull()
    await act(async () => release(readResult))
    expect(projection.onSelect).not.toHaveBeenCalled()
    expect(useAppStore.getState().recallZoneSelection?.active).toEqual({ tabId: from.tabId, regionId: from.regionId })
  } else if (outcome === 'later-navigation') {
    await vi.waitFor(() => expect(read).toHaveBeenCalled())
    await act(async () => { useAppStore.setState({ recallNoteId: 'later-choice' }); release(readResult) })
    await vi.waitFor(() => expect(dom.container.textContent).toContain('Opening the original file was not confirmed'))
    expect(projection.onSelect).not.toHaveBeenCalled(); expect(useAppStore.getState().recallNoteId).toBe('later-choice')
  } else {
    await vi.waitFor(() => expect(projection.onSelect).toHaveBeenCalledWith(expect.objectContaining(actual)))
    if (outcome === 'unconfirmed') await vi.waitFor(() => expect(dom.container.textContent).toContain('display position was not confirmed'))
  }
  await dom.render(<ReturnSurface reference={actual} />)
  if (outcome === 'applied') {
    expect(dom.container.textContent).toContain('Return to Original reading')
    expect(latest?.to).toEqual(actual)
  } else expect(dom.container.querySelector('.note-reading-return')).toBeNull()
})

it.each(['zone', 'region', 'tab'] as const)('returns from a shared Graph original to the retained source Graph with its draft and viewport from a %s projection', async projectionKind => {
  installNoteCanvasGeometry()
  const f = await originalSharedOwner(), ownerWorkspace = { ...workspace, path: f.resource.workspacePath }
  const hostPage = f.state.pages['registered-host']!, hostContent = await f.owner.content(f.state, hostPage.noteId)
  if (hostContent.status !== 'read') throw Error('The real saved host must be available')
  const hostKey = documentKey(workspace.id, hostPage.resource.path), hostDraft = { path: hostPage.resource.path, revision: hostContent.revision, content: hostContent.content + '\nRetained unsaved host prose\n' }
  const spaceId = directoryIdentity('local', f.resource.workspacePath), zoneId = homeZoneId(spaceId)
  const tabs = Object.fromEntries([from, to].map(reference => [reference.tabId, { ...createWorkbenchTab(reference.tabId, {
    kind: 'file', regionId: reference.regionId, workspaceId: workspace.id, path: reference === from ? hostPage.resource.path : f.resource.path
  }), space: { spaceId, zoneId } }]))
  useNotebookLibrary.setState({ state: f.state })
  useAppStore.setState({ config: { ...composerConfig, workspaces: [ownerWorkspace] }, tabs,
    layouts: { [workspace.id]: createWorkspaceLayout(from.groupId, [from.tabId, to.tabId]) }, documents: { [hostKey]: hostDraft }, dirtyDocuments: { [hostKey]: true },
    noteCanvasLayouts: {}, noteCanvasSaveIssues: {}, spaceZoneBindings: {}, scratchTopicSnapshots: {}, spatialRequests: {},
    recallZoneSelection: { zoneId, selection: [from], active: from } })
  vi.mocked(api.notebooks.read).mockResolvedValue(f.state)
  vi.spyOn(api.notebooks, 'graph').mockImplementation(async (params, options) => ({ catalog: f.state, graph: await f.owner.graph(f.state, params, options) }))
  vi.spyOn(api.notebooks, 'content').mockImplementation((id, options) => f.owner.content(f.state, id, options))
  vi.spyOn(api.files, 'read').mockImplementation(async (_workspace, path) => {
    const read = await f.owner.content(f.state, path === f.resource.path ? f.shared.noteId : hostPage.noteId)
    if (read.status !== 'read') throw Error('The original file must remain readable')
    return { status: 'read', document: { path, content: read.content, revision: read.revision } }
  })
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined); vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  const write = vi.spyOn(api.files, 'write'), toolbar = document.createElement('div')
  toolbar.dataset.readingToolbar = ''; dom.container.append(toolbar)
  const projection = { entity: { kind: 'zone' as const, zoneId }, presentationId: 'recall-workbench', displayWorkspaceId: workspace.id,
    catalog: spatialCatalog(useAppStore.getState(), []), selection: [from], onSelect: (selected: Reference) => useAppStore.getState().setRecallZoneSelection({ zoneId, selection: [selected], active: selected }) }
  function RetainedGraph() {
    const active = useAppStore(state => state.recallZoneSelection?.active)
    return <>{[from, to].map(reference => <section key={reference.tabId} data-reading-tab={reference.tabId} hidden={active?.tabId !== reference.tabId}>
      <WorkbenchPresentationContext.Provider value={{ active: active?.tabId === reference.tabId, retainedRegionId: null, tabHostId: 'local', reference, projection: { ...projection, entity: projectionKind === 'zone' ? projection.entity : projectionKind === 'region' ? { kind: 'region', regionId: reference.regionId } : { kind: 'tab', tabId: reference.tabId } } }}>
        <NoteViewToolbarContext.Provider value={reference === from ? { element: toolbar, documentKey: hostKey } : null}>
          <NoteFileSurfaceView tabId={reference.tabId} surface={tabs[reference.tabId]!.regions[reference.regionId] as never} />
        </NoteViewToolbarContext.Provider>
      </WorkbenchPresentationContext.Provider>
    </section>)}</>
  }
  await dom.render(<RetainedGraph />)
  expect(toolbar.querySelector('[aria-label="Graph view"]')).toBeNull()
  const origin = dom.container.querySelector(`[data-reading-tab="${from.tabId}"]`)!
  await act(async () => origin.querySelector<HTMLButtonElement>('.note-links-toggle')!.click())
  await vi.waitFor(() => expect(origin.querySelector('.note-links-controls')).not.toBeNull())
  const sharedTab = [...origin.querySelectorAll<HTMLButtonElement>('.note-links-controls button')].find(button => button.textContent === 'Shared content')!
  await act(async () => sharedTab.click())
  await vi.waitFor(() => expect(origin.querySelector('.note-links-shared-original button.note-links-target')).not.toBeNull())
  for (let attempt = 0; attempt < 2; attempt++) {
  await act(async () => origin.querySelector<HTMLButtonElement>('.note-links-shared-original button.note-links-target')!.click())
  await vi.waitFor(() => expect(useAppStore.getState().recallZoneSelection?.active?.tabId).toBe(to.tabId))
  const destination = dom.container.querySelector(`[data-reading-tab="${to.tabId}"]`)!
  await vi.waitFor(() => expect(destination.querySelector('.note-reading-return button')).not.toBeNull())
  expect(destination.textContent).toContain('Independent saved content')
  expect(destination.querySelector('.note-links-toggle')?.textContent).toContain('Linked references')
  expect(destination.querySelector('.note-backlinks')).toBeNull()
  await act(async () => destination.querySelector<HTMLButtonElement>('.note-reading-return button')!.click())
  expect(useAppStore.getState().recallZoneSelection?.active?.tabId).toBe(from.tabId)
  expect(origin.querySelector('.note-links-shared-original button.note-links-target')).not.toBeNull()
  expect(useAppStore.getState().documents[hostKey]).toBe(hostDraft)
  expect(useAppStore.getState().dirtyDocuments[hostKey]).toBe(true)
  expect(write).not.toHaveBeenCalled()
  }
})
