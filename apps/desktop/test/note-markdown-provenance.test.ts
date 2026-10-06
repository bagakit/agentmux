// @vitest-environment node
import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { NoteFileWriter } from '../src/main/note-file-writer'
import { FileReadOwner } from '../src/main/file-read-owner'
import { NotebookObservationOwner } from '../src/main/notebook-observation-owner'
import { AgentMuxNotebookStore } from '../../../packages/core/src/notebook-store'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import { parseFileReadResult, fileUploadRevision } from '../../../packages/core/src/public-rpc-files'
import { newNoteDocument, serializeNoteDocument, readNoteDocument } from '../src/shared/note-document'
import { parseNoteFile, noteKnowledge } from '@agentmux/client-ui/note/note-knowledge'
import { parseNoteContentObservation } from '../../../packages/core/src/notebook-observation'
import { reduceDocumentRead, type FileWorkbenchState } from '../src/renderer/src/lib/file-workbench-state'
import { documentKey } from '../src/renderer/src/lib/workbench-tabs'
import type { WorkspaceRecord } from '../src/shared/contracts'

const cleanups: (() => Promise<unknown>)[] = []
const actor = { kind: 'agent' as const, id: 'trusted-original-session' }, human = { kind: 'user' as const, id: 'original-person' }
afterEach(async () => { vi.restoreAllMocks(); for (const clean of cleanups.splice(0).reverse()) await clean() })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'note-md-metadata-'))); cleanups.push(() => rm(root, { recursive: true, force: true }))
  const workspace: WorkspaceRecord = { id: 'original-notes', hostId: 'local', kind: 'folder', name: 'Original notes', path: root }
  const files = new WorkspaceFiles(() => ({ kind: 'local', id: 'local' }) as never); cleanups.push(() => files.dispose())
  const store = new AgentMuxNotebookStore(join(root, 'notebooks.sqlite'))
  const observation = new NotebookObservationOwner({ files, workspace: () => workspace, metadata: store })
  const writer = new NoteFileWriter(files, { state: () => store.read(), owner: observation }, store)
  const path = 'original.note.md', resource = { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: root, path }
  const note = newNoteDocument('Original finding', 'original-note', 'first-block')
  note.content.content!.push({ type: 'paragraph', attrs: { blockId: 'untouched-block' }, content: [{ type: 'text', text: 'Keep this source' }] })
  return { root, workspace, files, store, observation, writer, path, resource, note }
}
it('persists trusted authors outside Markdown, preserves creation and untouched blocks after a real edit', async () => {
  const f = await fixture()
  const first = await f.writer.write(f.workspace, { path: f.path, content: serializeNoteDocument(f.note), expectedRevision: null }, { actor })
  expect(first).toMatchObject({ status: 'written', noteAttribution: { status: 'recorded' } }); if (first.status !== 'written') throw Error('Original create failed')
  const disk = await readFile(join(f.root, f.path), 'utf8')
  expect(disk).toContain('Original finding'); expect(disk).not.toContain(actor.id)
  const original = await f.writer.read(f.workspace, f.path); if (original.status !== 'read') throw Error('Original read failed')
  const parsed = parseNoteFile(original.document); if (parsed.status !== 'valid') throw Error(parsed.message)
  expect(parsed.note.content.content![0]!.attrs!.provenance).toMatchObject({ created: { actor }, lastEdited: { actor } })
  const candidate = structuredClone(parsed.note)
  candidate.content.content![0]!.content![0]!.text = 'Corrected original finding'
  candidate.content.content![1]!.attrs!.provenance = { created: { actor: { ...actor, id: 'forged' }, at: _newTailFixtureEpoch(0, 0, 1) }, lastEdited: null }
  const edit = await f.writer.write(f.workspace, { path: f.path, content: serializeNoteDocument(candidate), expectedRevision: first.revision }, { actor: human })
  expect(edit).toMatchObject({ status: 'written', noteAttribution: { status: 'recorded' } })
  const current = await f.writer.read(f.workspace, f.path); if (current.status !== 'read') throw Error('Original read failed')
  expect(current.document.noteProvenance?.blocks['first-block']).toMatchObject({ created: { actor }, lastEdited: { actor: human } })
  expect(current.document.noteProvenance?.blocks['untouched-block']).toEqual(original.document.noteProvenance?.blocks['untouched-block'])
  expect(current.document.content).not.toContain('forged')
  expect(await f.writer.write(f.workspace, { path: f.path, content: disk, expectedRevision: first.revision }, { actor })).toMatchObject({ status: 'conflict' })
})
it('external plain-text edits keep the known creator and do not claim an old Agent edited the new revision', async () => {
  const f = await fixture()
  await f.writer.write(f.workspace, { path: f.path, content: serializeNoteDocument(f.note), expectedRevision: null }, { actor })
  const changed = structuredClone(f.note); changed.content.content![0]!.content![0]!.text = 'External plain-text finding'
  await writeFile(join(f.root, f.path), serializeNoteDocument(changed))
  const read = await f.writer.read(f.workspace, f.path); if (read.status !== 'read') throw Error('Original read failed')
  expect(read.document.noteProvenance).toMatchObject({ status: 'unconfirmed', revision: read.document.revision, blocks: { 'first-block': { created: { actor }, lastEdited: null } } })
  const parsed = parseNoteFile(read.document); if (parsed.status !== 'valid') throw Error(parsed.message)
  expect(parsed.note.content.content![0]!.attrs!.provenance.lastEdited).toBeNull()
  const wrong = parseNoteFile({ ...read.document, noteProvenance: { ...read.document.noteProvenance!, resource: { ...f.resource, path: 'another.note.md' } } })
  expect(wrong.status === 'valid' && wrong.note.content.content![0]!.attrs?.provenance).toBeFalsy()
})
it('returns written body and an honest recoverable attribution after SQLite recording fails', async () => {
  const f = await fixture()
  vi.spyOn(f.store, 'recordProvenance').mockRejectedValueOnce(new Error('Metadata disk confirmation unavailable'))
  const result = await f.writer.write(f.workspace, { path: f.path, content: serializeNoteDocument(f.note), expectedRevision: null }, { actor })
  expect(result).toMatchObject({ status: 'written', noteAttribution: { status: 'unconfirmed' }, noteProvenance: { status: 'unconfirmed' } })
  if (result.status !== 'written') throw Error('The saved body must remain available')
  const bytes = await readFile(join(f.root, f.path), 'utf8')
  expect(fileUploadRevision(new TextEncoder().encode(bytes))).toBe(result.revision)
  expect(readNoteDocument(bytes).status).toBe('valid')
  const read = await f.writer.read(f.workspace, f.path)
  expect(read.status).toBe('read'); if (read.status !== 'read') throw Error('Readable saved body was taken away')
  expect(read.document.noteProvenance?.status).toBe('unconfirmed')
})
it('uses the original public File service and Notebook content for exact revision-bound metadata', async () => {
  const f = await fixture()
  const port = new FileReadOwner({ files: { read: f.writer.read.bind(f.writer), write: f.writer.write.bind(f.writer), listFiles: f.files.listFiles.bind(f.files) }, workspace: () => f.workspace,
    catalog: async () => ({ zones: [{ zoneId: 'original-zone', workspaceId: f.workspace.id, kind: 'directory', hostId: 'local', directoryPath: f.root }], bindings: [] }) as never })
  const service = new AgentMuxRpcService({ files: port, notebookStore: f.store, notebookObservation: f.observation,
    coreClients: () => [{ hostId: 'local', client: { authorizeRetainedAgentCaller: async () => ({ agentSessionId: actor.id, hostId: 'local', run: { runId: 'fixture-authenticated-run' } }) } } as never] })
  const params = { zoneId: 'original-zone', path: f.path, expectedResource: { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root } }
  const absent = await service.call('file.read', params)
  await service.call('file.create', { ...params, expectedResource: absent.resource!, expectedRevision: null, content: serializeNoteDocument(f.note) }, { caller: { agentSessionId: actor.id, capability: 'fixture-original-authority' } })
  const read = await service.call('file.read', params); if (read.result.status !== 'read') throw Error('Original public read failed')
  expect(read.result.document.noteProvenance).toMatchObject({ status: 'recorded', blocks: { 'first-block': { created: { actor } } } })
  const tampered = structuredClone(read); if (tampered.result.status !== 'read') throw Error('Original read missing')
  tampered.result.document.noteProvenance!.revision = 'sha256:' + 'a'.repeat(64)
  expect(() => parseFileReadResult(tampered, params)).toThrow(/another original body/)
  const changedBody = structuredClone(read); if (changedBody.result.status !== 'read') throw Error('Original read missing')
  changedBody.result.document.content = changedBody.result.document.content.replace('Original finding', 'Changed body bytes')
  expect(() => parseFileReadResult(changedBody, params)).toThrow(/another original body/)
  await f.store.apply({ operationId: 'register-original', expectedRevision: (await f.store.read()).revision, change: { kind: 'register', noteId: f.note.noteId, title: 'Original', resource: f.resource } }, actor)
  const inspected = await service.call('notebook.inspect', { noteId: f.note.noteId, content: true })
  expect(inspected.content).toMatchObject({ status: 'read', noteProvenance: { status: 'recorded', revision: read.result.document.revision } })
  if (inspected.content?.status !== 'read') throw Error('Original content missing')
  expect(() => parseNoteContentObservation({ ...inspected.content, content: inspected.content.content.replace('Original finding', 'Changed body bytes') })).toThrow(/another original body/)
  const d = read.result.document, location = { workspaceId: f.workspace.id, path: f.path }
  expect(noteKnowledge([{ location, document: d }]).sources[0]!.blocks.get('first-block')!.content.attrs!.provenance.created.actor).toEqual(actor)
  const wrongWorkspace = noteKnowledge([{ location: { ...location, workspaceId: 'different-original-workspace' }, document: d }])
  expect(wrongWorkspace.sources[0]!.blocks.get('first-block')!.content.attrs?.provenance).toBeNull()
  const key = documentKey(f.workspace.id, f.path)
  const prior = { documents: { [key]: { ...d, noteProvenance: { ...d.noteProvenance!, status: 'unconfirmed', reason: 'Metadata confirmation unavailable' }, noteWriteAttribution: { status: 'unconfirmed', reason: 'Metadata confirmation unavailable' } } },
    documentObservationGenerations: {}, documentGenerations: { [key]: 7 }, documentIssues: {}, dirtyDocuments: { [key]: false } } as unknown as FileWorkbenchState
  const refreshed = reduceDocumentRead(prior, f.workspace.id, f.path, read.result)
  expect(refreshed.documents[key]).toMatchObject({ content: d.content, noteProvenance: { status: 'recorded' }, noteWriteAttribution: { status: 'recorded' } })
  expect(refreshed.documentGenerations[key]).toBe(7)
  const dirty = { ...prior, documents: { [key]: { ...prior.documents[key]!, content: d.content + '\nLater unsaved input' } }, dirtyDocuments: { [key]: true } }
  const kept = reduceDocumentRead(dirty, f.workspace.id, f.path, read.result)
  expect(kept.documents[key]!.content).toBe(dirty.documents[key]!.content); expect(kept.dirtyDocuments[key]).toBe(true)
  const metadataReads = vi.spyOn(f.store, 'readProvenance')
  const graph = await service.call('notebook.graph', { noteId: f.note.noteId })
  expect(graph.observations).toHaveLength(1); expect(metadataReads).not.toHaveBeenCalled()
  expect(graph.observations[0]).not.toHaveProperty('noteProvenance')
})
it('the actual executable CLI edits Markdown and observes the same saved authors, graph and exact target', async () => {
  const f = await fixture()
  const target = newNoteDocument('Original target finding', 'target-note', 'target-block')
  const targetPath = 'target.note.md', targetResource = { ...f.resource, path: targetPath }
  await f.writer.write(f.workspace, { path: targetPath, content: serializeNoteDocument(target), expectedRevision: null }, { actor })
  await f.writer.write(f.workspace, { path: f.path, content: serializeNoteDocument(f.note), expectedRevision: null }, { actor })
  for (const [noteId, title, resource] of [[target.noteId, 'Target', targetResource], [f.note.noteId, 'Original', f.resource]] as const) {
    await f.store.apply({ operationId: 'register-' + noteId, expectedRevision: (await f.store.read()).revision, change: { kind: 'register', noteId, title, resource } }, actor)
  }
  const port = new FileReadOwner({ files: { read: f.writer.read.bind(f.writer), write: f.writer.write.bind(f.writer), listFiles: f.files.listFiles.bind(f.files) }, workspace: () => f.workspace,
    catalog: async () => ({ zones: [{ zoneId: 'original-zone', workspaceId: f.workspace.id, kind: 'directory', hostId: 'local', directoryPath: f.root }], bindings: [] }) as never })
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), files: port, notebookStore: f.store, notebookObservation: f.observation,
    coreClients: () => [{ hostId: 'local', client: { authorizeRetainedAgentCaller: async () => ({ agentSessionId: actor.id, hostId: 'local', run: { runId: 'fixture-authenticated-run' } }) } } as never] })
  await server.start(); cleanups.push(() => server.stop())
  const cli = (args: string[], input = '') => runCompiledObjectCli(['--endpoint', 'unix:' + server.path, ...args], objectCliEnvironment(f.root, { AGENTMUX_AGENT_SESSION_ID: actor.id, AGENTMUX_AGENT_CAPABILITY: 'fixture-original-authority' }), input)
  const read = await cli(['file', 'read', '--zone', 'original-zone', '--path', f.path, '--host', 'local', '--workspace', f.workspace.id, '--workspace-path', f.root])
  expect(read.code).toBe(0)
  const original = JSON.parse(read.stdout).result
  const parsed = readNoteDocument(original.result.document.content); if (parsed.status !== 'valid') throw Error(parsed.message)
  parsed.note.content.content![0]!.content!.push({ type: 'text', text: ' CLI edit [[Target #^target-block]]' })
  const saved = await cli(['file', 'write', '--zone', 'original-zone', '--path', f.path, '--resource', JSON.stringify(original.resource), '--expected-revision', original.result.document.revision], serializeNoteDocument(parsed.note))
  expect(saved.code).toBe(0)
  const receipt = JSON.parse(saved.stdout).result.result
  expect(receipt).toMatchObject({ status: 'written', noteAttribution: { status: 'recorded' }, noteProvenance: { status: 'recorded' } })
  const inspected = await cli(['notebook', 'inspect', '--note', f.note.noteId, '--content'])
  expect(inspected.code).toBe(0)
  const body = JSON.parse(inspected.stdout).result.content
  expect(body).toMatchObject({ status: 'read', revision: receipt.revision, noteProvenance: { blocks: { 'first-block': { created: { actor }, lastEdited: { actor } } } } })
  expect(body.content).toContain('CLI edit'); expect(body.content).not.toContain(actor.id)
  const graph = await cli(['notebook', 'graph', '--note', f.note.noteId])
  expect(graph.code).toBe(0)
  expect(JSON.parse(graph.stdout).result.references).toContainEqual(expect.objectContaining({ source: { noteId: f.note.noteId, blockId: 'first-block' }, target: { kind: 'block', noteId: target.noteId, blockId: 'target-block' }, resolution: 'resolved' }))
  const resolved = await cli(['notebook', 'resolve', '--link', '[[Target #^target-block]]'])
  expect(resolved.code).toBe(0)
  expect(JSON.parse(resolved.stdout).result.result).toEqual({ status: 'resolved', target: { noteId: target.noteId, blockId: 'target-block' } })
}, 30_000)
