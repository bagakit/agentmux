import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxControlServer, connectAgentMuxRpc, parseFileShareParams, parseFileShareResult, parseFileShareInspectParams, parseFileShareInspectResult } from '@agentmux/core'
import { parseFileShareUndoParams, parseFileShareUndoResult } from '@agentmux/core/files'
import { AgentMuxNotebookStore, AgentMuxNotesStorage } from '@agentmux/core/notebook-store'
import { AgentMuxSpatialStateStore, spatialCatalog } from '@agentmux/core/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import { WorkspaceFiles } from '../../../src/main/workspace-files'
import { NoteFileWriter } from '@agentmux/host/note-file-writer'
import { NoteSharedBlockOwner } from '@agentmux/host/note-shared-block-owner'
import { NoteSharedUndoOwner } from '@agentmux/host/note-shared-undo-owner'
import { NoteSharedFileDeleteOwner } from '@agentmux/host/note-shared-file-delete-owner'
import { NoteTitleFileWriter } from '@agentmux/host/note-title-file-writer'
import { NotesStorageOwner } from '../../../src/main/notes-storage-owner'
import { ConfigOwner } from '../../../src/main/config-owner'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import { NotebookObservationOwner } from '@agentmux/host/notebook-observation-owner'
import { newNoteDocument, serializeNoteDocument } from '../../../src/shared/note-document'
import { createWorkbenchTab, addWorkbenchRegion } from '../../../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../../../src/renderer/src/lib/desktop-spatial-state'
import type { AppConfig } from '../../../src/shared/contracts'

/** Private fixture transport only. These are the original product owners, not a second save model. */
export async function start(root: string, notify: (event: unknown) => void, options: { notebook?: boolean } = {}) {
  if (!root.startsWith('/private/tmp/amux-note-t5-') && !root.startsWith('/tmp/amux-note-t5-')) throw Error('An explicit private fixture root is required')
  const workspace = { id: 'fixture-workspace', hostId: 'local', path: join(root, 'workspace'), name: 'Private knowledge', kind: 'folder' as const }
  const path = 'collaboration.note.md', noteId = 'fixture-note', tabId = 'fixture-tab', regionId = 'fixture-file', groupId = 'fixture-group', zoneId = 'fixture-zone', spaceId = 'fixture-space'
  await mkdir(workspace.path, { recursive: true }); await mkdir(join(root, 'state'), { recursive: true }); await mkdir(join(root, 'notes'), { recursive: true })
  let config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private fixture' }], executors: {}, workspaces: [workspace],
    appearance: { terminalTheme: 'graphite', appAppearance: 'dark', spaceObjectIcons: {} }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  const spatial = new AgentMuxSpatialStateStore(join(root, 'state/spatial.json'))
  if (!options.notebook && !await spatial.read()) {
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
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never)
  const titleWorkspace = (resource: import('@agentmux/core').NoteResource) => config.workspaces.find(value => value.id === resource.workspaceId && value.hostId === resource.hostId && value.path === resource.workspacePath)
  const metadata: AgentMuxNotebookStore = new AgentMuxNotebookStore(undefined, storage, { title: {
    inspect: operationId => titleWriter.inspect(operationId),
    write: intent => {
      const original = titleWorkspace(intent.resource)
      return original ? titleWriter.write(original, intent) : Promise.resolve({ status: 'unavailable' as const, operationId: intent.operationId, reason: 'The exact private original Workspace is unavailable.' })
    },
    current: async (noteId, resource) => {
      const original = titleWorkspace(resource)
      if (!original) return { status: 'unknown' as const, noteId, resource, reason: 'The exact private original Workspace is unavailable.' }
      const observed = await titleWriter.current(original, noteId, resource)
      return titleWorkspace(resource) ? observed : { status: 'unknown' as const, noteId, resource, reason: 'The original private Workspace changed during this title read.' }
    }
  } })
  const titleWriter: NoteTitleFileWriter = new NoteTitleFileWriter(files, metadata)
  const writer = new NoteFileWriter(files, undefined, metadata), actor = { kind: 'user' as const, id: 'local-user:' + (process.getuid?.() ?? 'local') }
  const write = (input: Parameters<NoteFileWriter['write']>[1]) => notes.write(workspace, input, owner => writer.write(owner, input, { actor }))
  const initial = options.notebook ? null : await writer.read(workspace, path)
  if (initial?.status === 'deleted' && !(await metadata.read()).pages[noteId]) {
    const document = newNoteDocument('Original shared paragraph', noteId, 'original-block', 'Shared knowledge')
    document.content.content!.push({ type: 'paragraph', attrs: { blockId: 'independent-block' }, content: [{ type: 'text', text: 'Independent original paragraph' }] })
    const created = await write({ path, expectedRevision: null, content: serializeNoteDocument(document) })
    if (created.status !== 'written') throw Error('The original private fixture Note could not be created')
    const state = await metadata.read()
    await metadata.apply({ expectedRevision: state.revision, operationId: 'register-fixture-note', change: { kind: 'register', noteId, title: 'Shared knowledge', resource: { hostId: 'local', workspaceId: workspace.id, workspacePath: workspace.path, path } } }, actor)
  } else if (initial && initial.status !== 'read') throw Error('The existing fixture Note is unreadable; it was not reseeded: ' + JSON.stringify(initial))
  let sharedBlocks: NoteSharedBlockOwner
  const owner = new FileReadOwner({ share: { share: (input, context) => sharedBlocks.share(input, context), undoShare: (input, context) => sharedBlocks.undoShare(input, context), inspectShare: (input, context) => sharedBlocks.inspectShare(input, context) }, workspace: id => config.workspaces.find(value => value.id === id), catalog: async () => spatialCatalog((await spatial.read())!.graph),
    files: { read: writer.read.bind(writer), listFiles: files.listFiles.bind(files), history: writer.history.bind(writer),
      writeSharedUndo: (target, input, context, action, transferred) => notes.write(target, input, actual => writer.writeSharedUndo(actual, input, context, action, transferred)),
      createShared: (target, input, context, source) => notes.write(target, input, actual => writer.createShared(actual, input, context, source)),
      write: (target, input, context) => notes.write(target, input, actual => writer.write(actual, input, context)),
      restore: (target, input, context) => notes.write(target, input, actual => writer.restore(actual, input, context)),
      undo: (target, input, context) => notes.write(target, input, actual => writer.undo(actual, input, context)) } })
  const deletion = new NoteSharedFileDeleteOwner(files, metadata)
  const sharedUndo = new NoteSharedUndoOwner({ files, workspaces: () => config.workspaces, target: owner.targetForNote.bind(owner),
    read: owner.read.bind(owner), write: owner.write.bind(owner), writeInverse: owner.writeSharedInverse.bind(owner),
    history: metadata.readHistory.bind(metadata), operation: metadata.readHistoryOperation.bind(metadata), lease: metadata.runWithWriteLease.bind(metadata),
    delete: async (resource, input, context) => { const target = titleWorkspace(resource); return target ? notes.write(target, input, actual => deletion.delete(actual, input, context)) : { status: 'unknown', code: 'NOTE_RESOURCE_CHANGED', message: 'The exact original private shared deletion resource changed.' } } })
  sharedBlocks = new NoteSharedBlockOwner({ undo: sharedUndo, files: { read: owner.read.bind(owner), write: owner.write.bind(owner), writeInverse: owner.writeSharedInverse.bind(owner), createShared: owner.createShared.bind(owner) }, historyOperation: metadata.readHistoryOperation.bind(metadata), withWriteLease: metadata.runWithWriteLease.bind(metadata) })
  const observation = new NotebookObservationOwner({ workspace: id => config.workspaces.find(value => value.id === id), files, metadata })
  const socketPath = join(root, 'control.sock'), server = new AgentMuxControlServer({ socketPath, files: owner, notebookStore: metadata, notebookObservation: observation, coreClients: () => [] })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }), watches = new Map<string, () => Promise<void>>()
  let invalidations = 0, lost = false, unavailable = false
  const pausePath = join(root, 'state/observation-paused')
  let observationPaused = await readFile(pausePath, 'utf8').then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
  const calls: string[] = [], requests: { method: string; args: unknown[] }[] = []
  const originalWorkspace = (id: string) => {
    const target = config.workspaces.find(value => value.id === id)
    if (!target) throw Error('The exact private Workspace is unavailable: ' + id)
    return target
  }
  async function invoke(method: string, args: any[]) {
    calls.push(method)
    if (options.notebook) requests.push({ method, args: structuredClone(args) })
    switch (method) {
      case 'bootstrap': return { config, workspace, path, noteId, tabId, regionId, groupId, zoneId, spaceId, socketPath, actor, pid: process.pid, ...(options.notebook ? { mode: 'notebook' } : {}) }
      case 'config.get': return config
      case 'spatial.read': return spatial.read()
      case 'spatial.commit': return spatial.commit(args[0])
      case 'spatial.retainLabels': return spatial.retainDisplayLabels(args[0])
      case 'notes.inspect': return notes.inspect()
      case 'notebooks.read': return metadata.read()
      case 'notebooks.apply': {
        const state = await metadata.apply(args[0], actor)
        notify({ channel: 'notebook', value: { state } }); return state
      }
      case 'notebooks.graph': { const catalog = await metadata.read(); return { catalog, graph: await observation.graph(catalog, args[0]) } }
      case 'notebooks.content': return observation.content(await metadata.read(), args[0])
      case 'notebooks.resolve': return observation.resolve(await metadata.read(), args[0])
      case 'sharePublic': {
        const input = parseFileShareParams(args[0]), result = parseFileShareResult(await owner.share(input, { actor }), input)
        if (lost && result.status === 'committed') {
          lost = false
          return parseFileShareResult({ operationId: input.operationId, status: 'unknown', promotions: input.promotions.map(promotion => ({ operationId: promotion.operationId, shared: null, source: null })), destination: null,
            code: 'PRIVATE_LOST_REPLY', message: 'This private transport dropped the original shared-save reply after the real owner returned. Inspect the same retained request.' }, input)
        }
        return result
      }
      case 'inspectSharePublic': { const input = parseFileShareInspectParams(args[0]); return parseFileShareInspectResult(await owner.inspectShare(input, { actor }), input) }
      case 'shareUndoPublic': {
        const input = parseFileShareUndoParams(args[0]), result = parseFileShareUndoResult(await owner.undoShare(input, { actor }), input)
        if (lost && result.status === 'committed') {
          lost = false
          return parseFileShareUndoResult({ ...result, status: 'unknown', destination: null,
            collections: result.collections.map(item => ({ ...item, source: null, deletion: null })),
            code: 'PRIVATE_LOST_REPLY', message: 'The private transport dropped the original shared-undo reply after the real owner returned. Inspect the same request.' }, input)
        }
        return result
      }
      case 'read': return observationPaused ? { status: 'error', code: 'PRIVATE_OBSERVATION_PAUSED', message: 'The private fixture retained the original operation while its read transport is unavailable.' } : writer.read(options.notebook ? originalWorkspace(args[0]) : workspace, args[1])
      case 'readDirectory': return files.readDirectory(originalWorkspace(args[0]), args[1])
      case 'list': return files.listFiles(options.notebook ? originalWorkspace(args[0]) : workspace, args[1], args[2])
      case 'write': {
        const result = options.notebook ? await notes.write(originalWorkspace(args[0]), args[1], target => writer.write(target, args[1], { actor })) : await write(args[1])
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
      case 'observe': { const source = args[1], target = options.notebook ? originalWorkspace(args[0]) : workspace, watchKey = options.notebook ? JSON.stringify([target.id, source]) : source; if (!watches.has(watchKey)) watches.set(watchKey, await files.observe(target, source, () => { invalidations++; notify({ channel: 'file', value: { workspaceId: target.id, path: source } }) })); return null }
      case 'unobserve': { const key = options.notebook ? JSON.stringify([args[0], args[1]]) : args[1]; await watches.get(key)?.(); watches.delete(key); return null }
      case 'storage.flush': await writeFile(join(root, 'state/workbench-observed.json'), args[0] ?? 'null'); return null
      case 'loseNextReply': lost = true; return null
      case 'omitNextCanonical': unavailable = true; return null
      case 'resumeObservation': observationPaused = false; await rm(pausePath, { force: true }); return null
      case 'facts': {
        const catalog = await metadata.read(), page = options.notebook ? catalog.pages[args[0]] : undefined
        return { pid: process.pid, invalidations, observationPaused, calls, ...(options.notebook ? { requests } : {}), catalog,
          disk: page ? await writer.read(originalWorkspace(page.resource.workspaceId), page.resource.path) : options.notebook ? null : await writer.read(workspace, path),
          history: page ? await metadata.readHistory({ noteId: page.noteId, resource: page.resource }) : options.notebook ? null : await metadata.readHistory({ noteId, resource: { hostId: 'local', workspaceId: workspace.id, workspacePath: workspace.path, path } }), spatial: await spatial.read(), workbench: await readFile(join(root, 'state/workbench-observed.json'), 'utf8').catch(() => null) }
      }
      default: throw Error('Unimplemented private fixture transport: ' + method)
    }
  }
  return { invoke, async close() { for (const release of watches.values()) await release(); await rpc.dispose(); await server.stop(); await files.dispose() } }
}
