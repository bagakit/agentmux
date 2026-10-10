import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { AgentMuxNotebookStore, AgentMuxNotesStorage } from '@agentmux/core/notebook-store'
import { AgentMuxSpatialStateStore, spatialCatalog } from '@agentmux/core/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import { WorkspaceFiles } from '../../../src/main/workspace-files'
import { NoteFileWriter } from '../../../src/main/note-file-writer'
import { NotesStorageOwner } from '../../../src/main/notes-storage-owner'
import { ConfigOwner } from '../../../src/main/config-owner'
import { FileReadOwner } from '../../../src/main/file-read-owner'
import { NotebookObservationOwner } from '../../../src/main/notebook-observation-owner'
import { newNoteDocument, serializeNoteDocument } from '../../../src/shared/note-document'
import { createWorkbenchTab, addWorkbenchRegion } from '../../../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../../../src/renderer/src/lib/desktop-spatial-state'
import type { AppConfig } from '../../../src/shared/contracts'

/** Private fixture transport only. These are the original product owners, not a second save model. */
export async function start(root: string, notify: (event: unknown) => void) {
  if (!root.startsWith('/private/tmp/amux-note-t5-') && !root.startsWith('/tmp/amux-note-t5-')) throw Error('An explicit private fixture root is required')
  const workspace = { id: 'fixture-workspace', hostId: 'local', path: join(root, 'workspace'), name: 'Private knowledge', kind: 'folder' as const }
  const path = 'collaboration.note.md', noteId = 'fixture-note', tabId = 'fixture-tab', regionId = 'fixture-file', groupId = 'fixture-group', zoneId = 'fixture-zone', spaceId = 'fixture-space'
  await mkdir(workspace.path, { recursive: true }); await mkdir(join(root, 'state'), { recursive: true }); await mkdir(join(root, 'notes'), { recursive: true })
  let config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private fixture' }], executors: {}, workspaces: [workspace],
    appearance: { terminalTheme: 'graphite', appAppearance: 'dark', spaceObjectIcons: {} }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  const spatial = new AgentMuxSpatialStateStore(join(root, 'state/spatial.json'))
  if (!await spatial.read()) {
    let tab = { ...createWorkbenchTab(tabId, { kind: 'file', workspaceId: workspace.id, path, regionId }), space: { spaceId, zoneId } }
    tab = { ...addWorkbenchRegion(tab, regionId, 'right', { kind: 'launcher', workspaceId: workspace.id, regionId: 'fixture-neighbor' }), space: tab.space }
    tab.layout.activeRegionId = regionId
    const graph = desktopSpatialGraph({ config, sessions: [], tabs: { [tabId]: tab }, layouts: { [workspace.id]: createWorkspaceLayout(groupId, [tabId]) },
      spaceZoneBindings: { [zoneId]: { spaceId, workspaceId: workspace.id, directoryPath: workspace.path } }, spatialRequests: {} }, [])
    await spatial.commit({ expectedRevision: 0, graph })
  }
  const storage = new AgentMuxNotesStorage(join(root, 'state/notes-location.json'), join(root, 'notes'))
  const configOwner = new ConfigOwner({ read: () => config, save: async next => next, publish: next => { config = next } })
  const notes = new NotesStorageOwner(configOwner, spatial, snapshot => notify({ channel: 'notesStorage', value: snapshot }), storage)
  await notes.initialize()
  const metadata = new AgentMuxNotebookStore(undefined, storage), files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never)
  const writer = new NoteFileWriter(files, undefined, metadata), actor = { kind: 'user' as const, id: 'local-user:' + (process.getuid?.() ?? 'local') }
  const write = (input: Parameters<NoteFileWriter['write']>[1]) => notes.write(workspace, input, owner => writer.write(owner, input, { actor }))
  const initial = await writer.read(workspace, path)
  if (initial.status === 'deleted' && !(await metadata.read()).pages[noteId]) {
    const document = newNoteDocument('Original shared paragraph', noteId, 'original-block', 'Shared knowledge')
    document.content.content!.push({ type: 'paragraph', attrs: { blockId: 'independent-block' }, content: [{ type: 'text', text: 'Independent original paragraph' }] })
    const created = await write({ path, expectedRevision: null, content: serializeNoteDocument(document) })
    if (created.status !== 'written') throw Error('The original private fixture Note could not be created')
    const state = await metadata.read()
    await metadata.apply({ expectedRevision: state.revision, operationId: 'register-fixture-note', change: { kind: 'register', noteId, title: 'Shared knowledge', resource: { hostId: 'local', workspaceId: workspace.id, workspacePath: workspace.path, path } } }, actor)
  } else if (initial.status !== 'read') throw Error('The existing fixture Note is unreadable; it was not reseeded: ' + JSON.stringify(initial))
  const owner = new FileReadOwner({ workspace: id => config.workspaces.find(value => value.id === id), catalog: async () => spatialCatalog((await spatial.read())!.graph),
    files: { read: writer.read.bind(writer), listFiles: files.listFiles.bind(files), history: writer.history.bind(writer),
      write: (target, input, context) => notes.write(target, input, actual => writer.write(actual, input, context)),
      restore: (target, input, context) => notes.write(target, input, actual => writer.restore(actual, input, context)),
      undo: (target, input, context) => notes.write(target, input, actual => writer.undo(actual, input, context)) } })
  const observation = new NotebookObservationOwner({ workspace: id => config.workspaces.find(value => value.id === id), files })
  const socketPath = join(root, 'control.sock'), server = new AgentMuxControlServer({ socketPath, files: owner, notebookStore: metadata, notebookObservation: observation, coreClients: () => [] })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }), watches = new Map<string, () => Promise<void>>()
  let invalidations = 0, lost = false, unavailable = false
  const pausePath = join(root, 'state/observation-paused')
  let observationPaused = await readFile(pausePath, 'utf8').then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
  const calls: string[] = []
  async function invoke(method: string, args: any[]) {
    calls.push(method)
    switch (method) {
      case 'bootstrap': return { config, workspace, path, noteId, tabId, regionId, groupId, zoneId, spaceId, socketPath, actor, pid: process.pid }
      case 'config.get': return config
      case 'spatial.read': return spatial.read()
      case 'spatial.commit': return spatial.commit(args[0])
      case 'spatial.retainLabels': return spatial.retainDisplayLabels(args[0])
      case 'notes.inspect': return notes.inspect()
      case 'notebooks.read': return metadata.read()
      case 'read': return observationPaused ? { status: 'error', code: 'PRIVATE_OBSERVATION_PAUSED', message: 'The private fixture retained the original operation while its read transport is unavailable.' } : writer.read(workspace, args[1])
      case 'list': return files.listFiles(workspace, args[1], args[2])
      case 'write': {
        const result = await write(args[1])
        if ((lost || unavailable) && result.status === 'written') {
          const dropOutcome = lost; lost = unavailable = false; observationPaused = true
          await writeFile(pausePath, 'Original operation observation unavailable')
          if (dropOutcome) return { status: 'unknown', code: 'PRIVATE_LOST_REPLY', message: 'The fixture dropped the original known outcome after publication.', ...(result.noteHistory ? { noteHistory: { status: 'unconfirmed', eventId: result.noteHistory.eventId, reason: 'The original outcome reply was dropped by this private fixture.' } } : {}) }
          const { content, noteProvenance, noteAttribution, noteTitleProjection, ...receipt } = result
          return { ...receipt, contentUnavailable: 'The original file was saved. This private transport omitted its canonical body and attached metadata; read the original event or exact file separately.' }
        }
        return result
      }
      case 'rpc': return observationPaused && args[0] === 'file.history' ? { resource: args[1].expectedResource, result: { status: 'unknown', code: 'FILE_HISTORY_UNCONFIRMED', message: 'The original private history transport is unavailable; its records remain in SQLite.' } } : rpc.call(args[0], args[1])
      case 'observe': { const source = args[1]; if (!watches.has(source)) watches.set(source, await files.observe(workspace, source, () => { invalidations++; notify({ channel: 'file', value: { workspaceId: workspace.id, path: source } }) })); return null }
      case 'unobserve': { await watches.get(args[1])?.(); watches.delete(args[1]); return null }
      case 'storage.flush': await writeFile(join(root, 'state/workbench-observed.json'), args[0] ?? 'null'); return null
      case 'loseNextReply': lost = true; return null
      case 'omitNextCanonical': unavailable = true; return null
      case 'resumeObservation': observationPaused = false; await rm(pausePath, { force: true }); return null
      case 'facts': return { pid: process.pid, invalidations, observationPaused, calls, catalog: await metadata.read(), disk: await writer.read(workspace, path), history: await metadata.readHistory({ noteId, resource: { hostId: 'local', workspaceId: workspace.id, workspacePath: workspace.path, path } }), spatial: await spatial.read(), workbench: await readFile(join(root, 'state/workbench-observed.json'), 'utf8').catch(() => null) }
      default: throw Error('Unimplemented private fixture transport: ' + method)
    }
  }
  return { invoke, async close() { for (const release of watches.values()) await release(); await rpc.dispose(); await server.stop(); await files.dispose() } }
}
