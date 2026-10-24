import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { AgentMuxSpatialStateStore, spatialCatalog, type AgentMuxSpatialGraph } from '@agentmux/core/spatial-state'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import { NoteFileWriter } from '@agentmux/host/note-file-writer'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { closeWorktreeGraph } from '../src/shared/worktree-closeout'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses'
import { newNoteDocument, serializeNoteDocument } from '../src/shared/note-document'
import type { WorkspaceRecord } from '../src/shared/contracts'

const disposals: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose() })

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-closed-files-')))
  disposals.push(() => rm(root, { recursive: true, force: true }))
  const target: WorkspaceRecord = { id: 'default', name: 'Project', kind: 'folder', hostId: 'local', path: join(root, 'project') }
  const source: WorkspaceRecord = { id: 'original', name: 'Feature', kind: 'worktree', hostId: 'local', path: join(root, 'checkout'), repoPath: target.path,
    closeout: { targetWorkspaceId: target.id, operationId: 'original-closeout', cleanup: 'pending', reason: 'Original file workfaces remain.' } }
  await mkdir(target.path); await mkdir(source.path)
  const spaceId = directoryIdentity(target.hostId, target.path), zoneId = workspaceZoneId(spaceId, source.id)
  const original: AgentMuxSpatialGraph = { spaces: [{ spaceId, kind: 'folder', name: target.name, hostId: target.hostId, directoryPath: target.path, projectId: spaceId }],
    zones: [{ zoneId, workspaceId: source.id, kind: 'worktree', hostId: source.hostId, directoryPath: source.path, branch: 'feature' }],
    bindings: [{ zoneId, spaceId }], tabs: [], regions: [], layouts: {}, tabLayouts: {}, resources: { ['zone:' + zoneId]: { spaceId, workspaceId: source.id } } }
  const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  const initial = await spatial.commit({ expectedRevision: 0, graph: original })
  await spatial.commit({ expectedRevision: initial.revision, graph: closeWorktreeGraph(initial.graph, source, target).graph, allowEntityRemoval: true })
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never)
  disposals.push(() => files.dispose())
  const metadata = new AgentMuxNotebookStore(join(root, 'notebooks.sqlite')), writer = new NoteFileWriter(files, undefined, metadata)
  const path = 'original.note.md', noteId = 'original-note'
  const body = (text: string) => serializeNoteDocument(newNoteDocument(text, noteId, 'original-block'))
  await writeFile(join(target.path, path), 'Default project body must remain unchanged')
  const created = await writer.write(source, { path, content: body('Original checkout body'), expectedRevision: null })
  expect(created, JSON.stringify(created)).toMatchObject({ status: 'written' })
  const workspaces = [target, source]
  const owner = new FileReadOwner({ workspace: id => workspaces.find(workspace => workspace.id === id),
    catalog: async () => spatialCatalog((await spatial.read())!.graph),
    retiredZone: async id => (await spatial.read())!.graph.resources['zone:' + id],
    files: { read: writer.read.bind(writer), write: writer.write.bind(writer), listFiles: files.listFiles.bind(files), history: writer.history.bind(writer) } })
  const server = new AgentMuxControlServer({ socketPath: join(root, 'files.sock'), files: owner, coreClients: () => [] })
  await server.start(); disposals.push(() => server.stop())
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  disposals.push(() => client.dispose())
  const params = { zoneId, spaceId, path, expectedResource: { hostId: source.hostId, workspaceId: source.id, workspacePath: source.path } }
  return { root, source, target, workspaces, spatial, zoneId, spaceId, path, noteId, body, params, client }
}

it('keeps public reads, edits and Note history on the original checkout after its display Zone is withdrawn', async () => {
  const f = await fixture()
  expect((await f.spatial.read())!.graph.zones.some(zone => zone.zoneId === f.zoneId)).toBe(false)
  const read = await f.client.call('file.read', f.params)
  expect(read).toMatchObject({ resource: { ...f.params.expectedResource, zoneId: f.zoneId, zonePath: f.source.path, path: f.path },
    result: { status: 'read', document: { content: expect.stringContaining('Original checkout body') } } })
  if (read.result.status !== 'read' || !read.resource) throw new Error('The original resource must remain readable.')
  const write = await f.client.call('file.write', { ...f.params, expectedResource: read.resource,
    expectedRevision: read.result.document.revision, content: f.body('Edited original checkout') })
  expect(write).toMatchObject({ resource: read.resource, result: { status: 'written' } })
  const history = await f.client.call('file.history', { ...f.params, expectedResource: read.resource, noteId: f.noteId })
  expect(history).toMatchObject({ resource: read.resource, result: { status: 'read', resource: { workspaceId: f.source.id, workspacePath: f.source.path, path: f.path } } })
  expect(history.result.status === 'read' && history.result.entries.length).toBe(2)
  expect(await readFile(join(f.source.path, f.path), 'utf8')).toContain('Edited original checkout')
  expect(await readFile(join(f.target.path, f.path), 'utf8')).toBe('Default project body must remain unchanged')
})

it('refuses a different Zone, changed original resource or foreign Space without aliasing into the default tree', async () => {
  const f = await fixture(), state = (await f.spatial.read())!, descriptor = state.graph.resources['zone:' + f.zoneId]!
  const graph = structuredClone(state.graph)
  graph.resources['zone:forged-zone'] = descriptor
  await f.spatial.commit({ expectedRevision: state.revision, graph })
  await expect(f.client.call('file.read', { ...f.params, zoneId: 'forged-zone' })).resolves.toMatchObject({ resource: null, result: { status: 'unknown' } })
  await expect(f.client.call('file.read', { ...f.params, spaceId: 'foreign-space' })).rejects.toMatchObject({ code: 'FILE_RESOURCE_MISMATCH' })
  const targetZone = workspaceZoneId(f.spaceId, f.target.id)
  await expect(f.client.call('file.read', { ...f.params, zoneId: targetZone })).rejects.toMatchObject({ code: 'FILE_RESOURCE_MISMATCH' })
  const originalPath = f.source.path
  f.source.path = f.target.path
  await expect(f.client.call('file.read', f.params)).resolves.toMatchObject({ resource: null, result: { status: 'unknown' } })
  f.source.path = originalPath
  delete f.source.closeout
  await expect(f.client.call('file.read', f.params)).resolves.toMatchObject({ resource: null, result: { status: 'unknown' } })
  expect(await readFile(join(f.target.path, f.path), 'utf8')).toBe('Default project body must remain unchanged')
})
