import { dirname, join } from 'node:path'
import { AgentMuxError, spatialCatalog, type AgentMuxSpatialStateStore, type AgentMuxRpcServiceOptions, type AgentMuxRpcFilesOwner, type NotebookObservationPort } from '@agentmux/core'
import { AgentMuxNotebookStore, AgentMuxNotesStorage } from '@agentmux/core/notebook-store'
import type { NoteResource } from '@agentmux/core/notebook-catalog'
import { OrdinaryWorkspaceFiles } from './ordinary-files.js'
import type { WorkspaceRecord, WorkspaceFiles } from './content-types.js'
import { FileReadOwner } from './file-read-owner.js'
import { NoteFileWriter } from './note-file-writer.js'
import { NoteTitleFileWriter } from './note-title-file-writer.js'
import { NotebookObservationOwner } from './notebook-observation-owner.js'
import { NoteSharedBlockOwner } from './note-shared-block-owner.js'
import { NoteSharedUndoOwner } from './note-shared-undo-owner.js'
import { NoteSharedFileDeleteOwner } from './note-shared-file-delete-owner.js'
import { writeOriginalNoteResource } from './note-resource-write.js'
import { readOriginalMoteConfiguration } from './mote-resources.js'
import { ScratchTopics } from './mote-resources.js'
import { SCRATCH_WORKSPACE_ID } from './mote-topic-model.js'
import { TopicKnowledgeOwner } from './topic-knowledge.js'
import { TopicSpatialOwner } from './topic-spatial-owner.js'
import { TopicSearchHistoryOwner } from './topic-search-history.js'

type ContentPorts = Pick<AgentMuxRpcServiceOptions, 'files' | 'topics' | 'notebookStore' | 'notebookObservation'>
/** Borrows the original configuration, spatial graph and Notes storage. No Desktop connection. */
export function createHostContent(options: {
  configurationPath: string
  spatial: AgentMuxSpatialStateStore
  storage?: AgentMuxNotesStorage
  files?: OrdinaryWorkspaceFiles
}): ContentPorts {
  const storage = options.storage ?? new AgentMuxNotesStorage()
  const ordinary = options.files ?? new OrdinaryWorkspaceFiles()
  const scratch = new ScratchTopics()
  const history = new TopicSearchHistoryOwner(join(dirname(options.configurationPath), 'topic-search-history.json'))
  const configuration = async (): Promise<{ workspaces: WorkspaceRecord[]; complete: boolean }> => {
    const raw = await readOriginalMoteConfiguration(options.configurationPath)
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as Record<string, unknown>).workspaces)) throw new AgentMuxError('The original Workspace resources are unconfirmed. Original files, references and Agents are retained.', 'FILE_WORKSPACE_UNAVAILABLE')
    const workspaces = ((raw as { workspaces: unknown[] }).workspaces).flatMap(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return []
      const record = value as Record<string, unknown>
      if (typeof record.id !== 'string' || typeof record.hostId !== 'string' || typeof record.path !== 'string') return []
      const closeout = record.closeout as { targetWorkspaceId?: unknown } | undefined
      return [{ id: record.id, hostId: record.hostId, path: record.path,
        ...(typeof record.name === 'string' ? { name: record.name } : {}),
        ...(typeof record.kind === 'string' ? { kind: record.kind } : {}),
        ...(typeof record.repoPath === 'string' ? { repoPath: record.repoPath } : {}),
        ...(closeout && typeof closeout.targetWorkspaceId === 'string' ? { closeout: { targetWorkspaceId: closeout.targetWorkspaceId } } : {}) }]
    })
    return { workspaces, complete: workspaces.length === (raw as { workspaces: unknown[] }).workspaces.length }
  }
  const titleWorkspace = async (resource: NoteResource): Promise<WorkspaceRecord | undefined> => {
    const matches = (await configuration()).workspaces.filter(workspace => workspace.id === resource.workspaceId)
    const current = matches.length === 1 ? matches[0] : undefined
    return current?.hostId === resource.hostId && current.path === resource.workspacePath && current.hostId === 'local' ? current : undefined
  }
  const local = (workspace: WorkspaceRecord): WorkspaceRecord => {
    if (workspace.hostId !== 'local') throw new AgentMuxError('Use the original remote Host for this file. Its reference, files and Agents are retained.', 'FILE_HOST_UNAVAILABLE')
    return workspace
  }
  const files: WorkspaceFiles = {
    read: (workspace, path, budget) => ordinary.read(local(workspace), path, budget),
    readDirectory: (workspace, path) => ordinary.readDirectory(local(workspace), path),
    listFiles: (workspace, path, limit, context) => ordinary.listFiles(local(workspace), path, limit, context),
    write: (workspace, input) => ordinary.write(local(workspace), input),
    writeBytes: (workspace, input) => ordinary.writeBytes(local(workspace), input),
    deleteExact: (workspace, input) => ordinary.deleteExact(local(workspace), input)
  }
  const notebookStore: AgentMuxNotebookStore = new AgentMuxNotebookStore(undefined, storage, { title: {
    inspect: operationId => titleWriter.inspect(operationId),
    write: async intent => {
      const owner = await titleWorkspace(intent.resource)
      return owner ? titleWriter.write(owner, intent) : { status: 'unavailable', operationId: intent.operationId, reason: 'The exact original Host/Workspace is unavailable; no title write was issued.' }
    },
    current: async (noteId, resource) => {
      const owner = await titleWorkspace(resource)
      if (!owner) return { status: 'unknown', noteId, resource, reason: 'The exact original Host/Workspace mapping is unavailable.' }
      const observed = await titleWriter.current(owner, noteId, resource)
      return await titleWorkspace(resource) ? observed : { status: 'unknown', noteId, resource, reason: 'The original Host/Workspace mapping changed during this title read.' }
    }
  } })
  const titleWriter: NoteTitleFileWriter = new NoteTitleFileWriter(files, notebookStore)
  const owners = async () => {
    // One original metadata observation per operation, never a competing configuration owner.
    const current = await configuration()
    const workspace = (id: string) => { const matches = current.workspaces.filter(item => item.id === id); return matches.length === 1 ? matches[0] : undefined }
    const observation = new NotebookObservationOwner({ files, workspace, metadata: notebookStore })
    const writer = new NoteFileWriter(files, { state: () => notebookStore.read(), owner: observation }, notebookStore)
    const guarded = <T>(owner: WorkspaceRecord, input: { path: string }, save: (workspace: WorkspaceRecord) => Promise<T>) => writeOriginalNoteResource(storage, owner, input, save)
    let shared: NoteSharedBlockOwner
    const publicFiles = new FileReadOwner({
      catalog: async () => { const state = await options.spatial.read(); return state ? spatialCatalog(state.graph) : null },
      retiredZone: async id => (await options.spatial.read())?.graph.resources['zone:' + id],
      workspace,
      topicForDirectory: (owner, directory) => scratch.readForDirectory(owner, directory),
      share: { share: (input, context) => shared.share(input, context), undoShare: (input, context) => shared.undoShare(input, context), inspectShare: (input, context) => shared.inspectShare(input, context) },
      files: {
        read: writer.read.bind(writer), listFiles: files.listFiles.bind(files), history: writer.history.bind(writer),
        write: (owner, input, context) => guarded(owner, input, actual => writer.write(actual, input, context)),
        writeBytes: (owner, input) => guarded(owner, input, actual => files.writeBytes(actual, input)),
        restore: (owner, input, context) => guarded(owner, input, actual => writer.restore(actual, input, context)),
        undo: (owner, input, context) => guarded(owner, input, actual => writer.undo(actual, input, context)),
        writeSharedUndo: (owner, input, context, action, transferred) => guarded(owner, input, actual => writer.writeSharedUndo(actual, input, context, action, transferred)),
        createShared: (owner, input, context, source) => guarded(owner, input, actual => writer.createShared(actual, input, context, source))
      }
    })
    const deletion = new NoteSharedFileDeleteOwner(files, notebookStore)
    const undo = new NoteSharedUndoOwner({
      files, workspaces: configuration, target: publicFiles.targetForNote.bind(publicFiles),
      read: publicFiles.read.bind(publicFiles), write: publicFiles.write.bind(publicFiles), writeInverse: publicFiles.writeSharedInverse.bind(publicFiles),
      history: notebookStore.readHistory.bind(notebookStore), operation: notebookStore.readHistoryOperation.bind(notebookStore), lease: notebookStore.runWithWriteLease.bind(notebookStore),
      delete: async (resource, input, context) => {
        const owner = await titleWorkspace(resource)
        return owner ? guarded(owner, input, actual => deletion.delete(actual, input, context)) : { status: 'unknown', code: 'NOTE_RESOURCE_CHANGED', message: 'The exact original shared deletion resource changed.' }
      }
    })
    shared = new NoteSharedBlockOwner({ undo, files: { read: publicFiles.read.bind(publicFiles), write: publicFiles.write.bind(publicFiles), createShared: publicFiles.createShared.bind(publicFiles), writeInverse: publicFiles.writeSharedInverse.bind(publicFiles) }, historyOperation: notebookStore.readHistoryOperation.bind(notebookStore), withWriteLease: notebookStore.runWithWriteLease.bind(notebookStore) })
    return { files: publicFiles, observation, workspace }
  }
  const publicFiles: AgentMuxRpcFilesOwner = {
    read: async (...args) => (await owners()).files.read(...args),
    list: async (...args) => (await owners()).files.list(...args),
    write: async (...args) => (await owners()).files.write(...args),
    create: async (...args) => (await owners()).files.create(...args),
    import: async (...args) => (await owners()).files.import(...args),
    history: async (...args) => (await owners()).files.history(...args),
    restore: async (...args) => (await owners()).files.restore(...args),
    undo: async (...args) => (await owners()).files.undo(...args),
    share: async (...args) => (await owners()).files.share(...args),
    inspectShare: async (...args) => (await owners()).files.inspectShare(...args),
    undoShare: async (...args) => (await owners()).files.undoShare(...args)
  }
  const notebookObservation: NotebookObservationPort = {
    content: async (...args) => (await owners()).observation.content(...args),
    graph: async (...args) => (await owners()).observation.graph(...args),
    resolve: async (...args) => (await owners()).observation.resolve(...args),
    scan: async (...args) => (await owners()).observation.scan(...args)
  }
  return { files: publicFiles, notebookStore, notebookObservation, topics: {
    call: async (method, params, context) => {
      const content = await owners()
      const workspace = () => {
        const original = content.workspace(SCRATCH_WORKSPACE_ID)
        if (!original) throw new AgentMuxError('The original Topics Workspace is unconfirmed. Content, spatial references and Agents are retained.', 'TOPIC_WORKSPACE_UNAVAILABLE')
        return original
      }
      const topics = new TopicKnowledgeOwner(scratch, files, workspace, history)
      topics.setFileReadPort(content.files)
      topics.setSpatialPort(new TopicSpatialOwner({ state: options.spatial, workspace, topics: () => topics.listTopicSnapshots(), categories: () => topics.listCategories(), ensureDefaultCategory: () => topics.ensureDefaultCategoryContent() }))
      return topics.call(method, params, context)
    }
  } }
}
