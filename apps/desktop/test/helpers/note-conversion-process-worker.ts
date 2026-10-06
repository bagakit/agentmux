import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { WorkspaceFiles } from '../../src/main/workspace-files'
import { NotesStorageOwner } from '../../src/main/notes-storage-owner'
import { ConfigOwner } from '../../src/main/config-owner'
import { AgentMuxNotesStorage, AgentMuxNotebookStore, emptyNotebookState, applyNotebookChange } from '@agentmux/core/notebook-store'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { newNoteDocument, readNoteDocument } from '@agentmux/client-ui/note/note-document'
import { attributeNoteBlocks } from '@agentmux/client-ui/note/note-provenance'
import { fixtureTime } from '../../scripts/lib/fixture-values.mjs'

const [mode, directory, moveHelper] = process.argv.slice(2) as [string, string, string]
const uiPath = join(directory, 'ui.json'), notesRoot = join(directory, 'notes'), configPath = join(directory, 'config.json')
const revision = (value: string) => 'sha256:' + createHash('sha256').update(value).digest('hex')
const events = new EventTarget()
;(globalThis as any).window = { localStorage: {
  getItem: (key: string) => existsSync(key === 'agentmux-workbench-v1' ? uiPath : join(directory, key + '.json')) ? readFileSync(key === 'agentmux-workbench-v1' ? uiPath : join(directory, key + '.json'), 'utf8') : null,
  setItem: (key: string, value: string) => writeFileSync(key === 'agentmux-workbench-v1' ? uiPath : join(directory, key + '.json'), value), removeItem: () => {}
}, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) }
const { api } = await import('../../src/renderer/src/lib/api')
const { useAppStore, prepareRendererUpdate, applyNotesStorageSnapshot } = await import('../../src/renderer/src/store')
const { createWorkbenchTab, documentKey } = await import('../../src/renderer/src/lib/workbench-tabs')
const { desktopSpatialGraph } = await import('../../src/renderer/src/lib/desktop-spatial-state')
const { createWorkspaceLayout } = await import('../../../../packages/layout/src/index')
const resource = { hostId: 'local', workspaceId: '__notes__', workspacePath: notesRoot, path: 'original.note.json' }
let config = mode === 'write' ? { ...await api.config.get(), workspaces: [{ id: resource.workspaceId, hostId: resource.hostId, path: resource.workspacePath, name: 'Notes', kind: 'folder' as const }] }
  : JSON.parse(readFileSync(configPath, 'utf8'))
if (mode === 'write') writeFileSync(configPath, JSON.stringify(config))
const configOwner = new ConfigOwner({ read: () => config, save: async value => { writeFileSync(configPath, JSON.stringify(value)); return value }, publish: value => { config = value } })
const spatial = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
let notesOwner!: NotesStorageOwner
const storage = new AgentMuxNotesStorage(join(directory, 'state', 'notes-location.json'), notesRoot, { beforeSourceCleanup: async () => { await notesOwner.confirmResources(await storage.inspect()) } })
notesOwner = new NotesStorageOwner(configOwner, spatial, () => {}, storage)
const notebooks = new AgentMuxNotebookStore(undefined, storage), files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local', label: 'Private conversion fixture', run: async () => { throw new Error('Unexpected remote command') }, dispose: async () => {} }), { localMoveHelperPath: moveHelper })
api.config.get = async () => config
api.spatial.read = () => spatial.readForLayout(); api.spatial.commit = input => spatial.commit(input); api.spatial.retainLabels = values => spatial.retainDisplayLabels(values); api.spatial.onChange = () => () => {}
api.notesStorage.inspect = id => notesOwner.inspect(id); api.notesStorage.change = input => notesOwner.change(input); api.notesStorage.onChange = () => () => {}
api.notebooks.read = () => notebooks.read(); api.notebooks.apply = input => notebooks.apply(input, { kind: 'user', id: 'process-original-person' }); api.notebooks.onChange = listener => notebooks.subscribe(listener)
const previewSnapshot = await api.sessions.snapshot()
api.sessions.snapshot = async () => ({ ...previewSnapshot, sessions: [], recoveryCandidates: [] })
api.ui.requestStorageFlush = async () => {}
api.files.observe = async () => undefined as never; api.files.unobserve = async () => {}
api.files.read = async (_workspace, path) => files.read(config.workspaces.find((workspace: any) => workspace.id === '__notes__'), path)
let writes = 0
api.files.write = async (_workspace, input) => {
  writes++
  const result = await notesOwner.write(config.workspaces[0], input, workspace => files.write(workspace, input))
  return mode === 'write' && result.status === 'written' ? { status: 'unknown', code: 'RECEIPT_LOST_AFTER_ACTUAL_WRITE', message: 'Original write receipt transport failed' } : result
}
if (mode === 'write') {
  mkdirSync(notesRoot, { recursive: true })
  const original = attributeNoteBlocks(null, newNoteDocument('Original saved 中文', 'same-note', 'same-block'), { kind: 'agent', id: 'original-agent-session' }, fixtureTime(10))
  const raw = JSON.stringify(original, null, 2); writeFileSync(join(notesRoot, resource.path), raw)
  let catalog = applyNotebookChange(emptyNotebookState(), { operationId: 'original-register', expectedRevision: 0, change: { kind: 'register', noteId: original.noteId, title: 'Original', resource } }, { kind: 'user', id: 'original-person' }, fixtureTime(10))
  catalog = applyNotebookChange(catalog, { operationId: 'original-follow', expectedRevision: catalog.revision, change: { kind: 'follow', noteId: original.noteId } }, { kind: 'agent', id: 'original-agent-session' }, fixtureTime(20))
  writeFileSync(join(notesRoot, 'notebooks.json'), JSON.stringify(catalog) + '\n')
  const tab = createWorkbenchTab('original-tab', { kind: 'file', regionId: 'original-region', workspaceId: resource.workspaceId, path: resource.path })
  tab.space = { spaceId: JSON.stringify(['local', notesRoot]), zoneId: 'original-zone' }
  await spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph({ config, sessions: [], tabs: { [tab.id]: tab }, layouts: { __notes__: createWorkspaceLayout('original-group', [tab.id]) }, spaceZoneBindings: {}, spatialRequests: {} }, []) })
  await useAppStore.getState().initialize()
  await useAppStore.getState().openFile(resource.path, 'original-group', undefined, resource.workspaceId, true)
  await useAppStore.getState().attachPersistedFileDocument(resource.workspaceId, resource.path)
  const sent = structuredClone(original); sent.content.content![0]!.content!.push({ type: 'text', text: ' ORIGINAL UNKNOWN SENT' })
  const sentBody = attributeNoteBlocks(original, sent, { kind: 'agent', id: 'original-agent-session' }, fixtureTime(30))
  useAppStore.getState().updateDocument(tab.id, JSON.stringify(sentBody, null, 2), 'original-region')
  await useAppStore.getState().saveDocument(tab.id, 'original-region')
  const later = structuredClone(sentBody); later.content.content![0]!.content!.push({ type: 'text', text: ' LATER UNSAVED INPUT' })
  useAppStore.getState().updateDocument(tab.id, JSON.stringify(later, null, 2), 'original-region')
  useAppStore.getState().setNoteBlockSelection({ tabHostId: 'local', reference: { displayWorkspaceId: '__notes__', groupId: 'original-group', tabId: tab.id, regionId: 'original-region' } }, { noteId: original.noteId, blockId: 'same-block' })
  useAppStore.setState({ noteCanvasLayouts: { '["note","same-note"]': { positions: { 'same-note': { x: 125, y: 80 } }, viewport: { x: 10, y: 20, zoom: 1 }, expandedNoteIds: ['same-note'], previewNoteIds: ['same-note'] } } })
  const converted = await notesOwner.initialize()
  await applyNotesStorageSnapshot(converted)
  await prepareRendererUpdate('reload')
} else {
  await notesOwner.initialize()
  await useAppStore.getState().initialize()
  await applyNotesStorageSnapshot(await storage.inspect())
}
const state = useAppStore.getState(), document = state.documents[documentKey('__notes__', 'original.note.md')]
const body = readFileSync(join(notesRoot, 'original.note.md'), 'utf8'), parsed = readNoteDocument(body)
if (!document || parsed.status !== 'valid') throw new Error('The original converted document did not restore: ' + JSON.stringify({ mode, documents: state.documents, tabs: state.tabs, issues: state.documentIssues, parsed }))
const attribution = await notebooks.readProvenance({ noteId: 'same-note', resource: { ...resource, path: 'original.note.md' }, revision: revision(body), blockIds: ['same-block'] })
console.log(JSON.stringify({ pid: process.pid, writes, tab: state.tabs['original-tab'], graph: (await spatial.read())!.graph,
  documents: { content: document.content, revision: document.revision, noteConversion: document.noteConversion }, dirty: state.dirtyDocuments[documentKey('__notes__', 'original.note.md')],
  selected: state.noteBlockSelections, canvas: state.noteCanvasLayouts, catalog: await notebooks.read(), body, attribution }))
process.exit(0)
