// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { NoteFileContext, NoteFileLinkContext } from '@agentmux/client-ui/components/NoteFileContext'
import { NoteReader } from '@agentmux/client-ui/components/NoteReader'
import { emptyNotebookState } from '@agentmux/core/notebook-catalog'
import { serializeNoteDocument, newNoteDocument } from '@agentmux/client-ui/note/note-document'
import { noteKnowledge } from '@agentmux/client-ui/note/note-knowledge'
import { NoteFileView } from '../src/renderer/src/components/NoteFileView'
import { api } from '../src/renderer/src/lib/api'
import { useDesktopNoteLinkOpener } from '../src/renderer/src/lib/note-file-link'
import { openNotebookAttachment, openNotebookFile } from '../src/renderer/src/lib/recall-notebooks'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { useNotebookLibrary } from '../src/renderer/src/lib/notebook-library'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { NoteSnapshotTestWorker } from './note-snapshot-test-worker'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'

const dom = composerDOM(), workspace = composerConfig.workspaces[0]!, initialLibrary = useNotebookLibrary.getState()
const spaceId = directoryIdentity(workspace.hostId, workspace.path), zoneId = homeZoneId(spaceId)
const resource = { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path: 'shared/source.note.md' }
const from = { displayWorkspaceId: workspace.id, groupId: 'attachment-group', tabId: 'source-tab', regionId: 'source-region' }
const to = { ...from, tabId: 'attachment-tab', regionId: 'attachment-region' }
const note = newNoteDocument('', 'attachment-navigation', 'link-block', 'Source')
note.content.content![0]!.content = [{ type: 'text', text: 'Open original attachment', marks: [{ type: 'link', attrs: { href: './guide.txt' } }] }]
const original = { path: resource.path, content: serializeNoteDocument(note), revision: 'original-revision' }
const attachment = { path: 'shared/guide.txt', content: 'Plain original attachment without Note identity', revision: 'attachment-revision' }

beforeEach(() => {
  installNoteCanvasGeometry(); vi.stubGlobal('Worker', NoteSnapshotTestWorker)
  const tabs = Object.fromEntries([from, to].map(ref => [ref.tabId, { ...createWorkbenchTab(ref.tabId, { kind: 'file', regionId: ref.regionId,
    workspaceId: workspace.id, path: ref === from ? resource.path : attachment.path }), space: { spaceId, zoneId } }]))
  useAppStore.setState({ config: composerConfig, activeWorkspaceId: workspace.id, mainSurface: 'recall', tabs,
    layouts: { [workspace.id]: createWorkspaceLayout(from.groupId, [from.tabId, to.tabId]) },
    documents: { [documentKey(workspace.id, resource.path)]: original, [documentKey(workspace.id, attachment.path)]: attachment },
    dirtyDocuments: { [documentKey(workspace.id, resource.path)]: true }, documentIssues: {}, documentRevealTargets: {},
    spaceZoneBindings: {}, scratchTopicSnapshots: {}, spatialRequests: {}, recallNotebookId: 'quick-notes', recallNoteId: note.noteId,
    recallZoneSelection: { zoneId, selection: [from], active: from } })
  useNotebookLibrary.setState({ state: emptyNotebookState(), issue: null })
  vi.spyOn(api.notebooks, 'read').mockResolvedValue(emptyNotebookState())
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined); vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'read').mockResolvedValue({ status: 'read', document: attachment })
})
afterEach(() => { useNotebookLibrary.setState(initialLibrary, true) })

it('the real Note file link selects the original Recall occurrence and keeps the source draft', async () => {
  const projection = { entity: { kind: 'zone' as const, zoneId }, presentationId: 'recall-workbench', displayWorkspaceId: workspace.id,
    catalog: spatialCatalog(useAppStore.getState(), []), selection: [from], onSelect: vi.fn((reference: typeof from) => useAppStore.getState().setRecallZoneSelection({ zoneId, selection: [reference], active: reference })) }
  const write = vi.spyOn(api.files, 'write')
  await dom.render(<WorkbenchPresentationContext.Provider value={{ active: true, retainedRegionId: null, reference: from, projection }}>
    <NoteFileView document={original} resource={resource} knowledge={noteKnowledge([])} onChange={() => {}} onSave={() => {}} onOpen={() => {}} dirty />
  </WorkbenchPresentationContext.Provider>)
  const link = dom.container.querySelector<HTMLAnchorElement>('a[href="./guide.txt"]')!
  expect(link).not.toBeNull()
  const event = new MouseEvent('click', { metaKey: true, bubbles: true, cancelable: true })
  await act(async () => link.dispatchEvent(event))
  await vi.waitFor(() => expect(projection.onSelect).toHaveBeenCalledWith(expect.objectContaining(to)))
  expect(event.defaultPrevented).toBe(true)
  expect(useAppStore.getState().recallZoneSelection?.active).toMatchObject({tabId:to.tabId,regionId:to.regionId})
  expect(useAppStore.getState().documents[documentKey(workspace.id, resource.path)]).toBe(original)
  expect(useAppStore.getState().dirtyDocuments[documentKey(workspace.id, resource.path)]).toBe(true)
  expect(write).not.toHaveBeenCalled()
})

it('ordinary attachment navigation consumes the Notebook workface without validating the text as a Note', async () => {
  const selected = vi.fn(), write = vi.spyOn(api.files, 'write')
  expect(await openNotebookAttachment({ ...resource, path: attachment.path }, { zoneId, workspaceId: workspace.id }, selected, from)).toBe(true)
  expect(selected).toHaveBeenCalledWith(expect.objectContaining(to))
  expect(useAppStore.getState().recallZoneSelection?.active).toMatchObject({tabId:to.tabId,regionId:to.regionId})
  expect(useAppStore.getState().documents[documentKey(workspace.id, attachment.path)]?.content).toBe(attachment.content)
  expect(write).not.toHaveBeenCalled()
})

it('a cancelled Note request remains cancelled before validating a superseded block target', async () => {
  const controller = new AbortController(); controller.abort()
  expect(await openNotebookFile({ noteId: note.noteId, resource }, undefined, undefined,
    { noteId: 'superseded-note', blockId: 'old-block' }, undefined, controller.signal)).toBe(false)
  expect(api.files.read).not.toHaveBeenCalled()
})

it.each(['invalid', 'unavailable'] as const)('a cancelled Note read ignores its late %s result', async result => {
  let release!: (value: Awaited<ReturnType<typeof api.files.read>>) => void
  vi.mocked(api.files.read).mockImplementation(() => new Promise(resolve => { release = resolve }))
  const controller = new AbortController(), selected = vi.fn()
  const opening = openNotebookFile({ noteId: note.noteId, resource, workface: { zoneId, workspaceId: workspace.id } }, selected, from,
    undefined, undefined, controller.signal)
  await vi.waitFor(() => expect(api.files.read).toHaveBeenCalled())
  controller.abort()
  release(result === 'invalid' ? { status: 'read', document: { ...original, content: 'Invalid Note body' } }
    : { status: 'error', code: 'READ_UNAVAILABLE', message: 'Original read unavailable' })
  expect(await opening).toBe(false); expect(selected).not.toHaveBeenCalled()
})

it('a delayed attachment read keeps a later Recall selection instead of selecting its old target', async () => {
  let release!: (value: Awaited<ReturnType<typeof api.files.read>>) => void
  vi.mocked(api.files.read).mockImplementation(() => new Promise(resolve => { release = resolve }))
  useAppStore.setState({ documents: { [documentKey(workspace.id, resource.path)]: original } })
  const selected = vi.fn()
  const opening = openNotebookAttachment({ ...resource, path: attachment.path }, { zoneId, workspaceId: workspace.id }, selected, from)
  await vi.waitFor(() => expect(api.files.read).toHaveBeenCalled())
  useAppStore.setState({ recallNoteId: 'later-note' })
  release({ status: 'read', document: attachment }); await opening
  expect(selected).not.toHaveBeenCalled()
  expect(useAppStore.getState().recallNoteId).toBe('later-note')
})

function DirectoryReader() {
  const open = useDesktopNoteLinkOpener()
  return <NoteFileLinkContext.Provider value={open}><NoteReader resource={resource} content={original.content} revision={original.revision} path={resource.path} workspaceId={workspace.id} /></NoteFileLinkContext.Provider>
}
it('a reader without a Workbench occurrence preserves its containing Notebook navigation port', async () => {
  const local = vi.fn(async () => true)
  await dom.render(<NoteFileLinkContext.Provider value={local}><NoteFileContext.Provider value={resource}><DirectoryReader /></NoteFileContext.Provider></NoteFileLinkContext.Provider>)
  const link = dom.container.querySelector<HTMLAnchorElement>('a[href="./guide.txt"]')!
  expect(link).not.toBeNull()
  await act(async () => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
  expect(local).toHaveBeenCalledExactlyOnceWith(resource, './guide.txt')
})
