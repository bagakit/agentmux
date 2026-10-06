// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { AgentMuxControlServer, type AgentMuxRpcMethod, type AgentMuxRpcResult } from '@agentmux/core'
import { AgentMuxNotesStorage, AgentMuxNotebookStore, applyNotebookChange, emptyNotebookState } from '@agentmux/core/notebook-store'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { attributeNoteBlocks } from '@agentmux/client-ui/note/note-provenance'
import { newNoteDocument, readNoteDocument, serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { objectCliEnvironment, runCompiledObjectCli, type CliResult } from '../../../packages/core/test/helpers/object-cli-rpc'
import { fixtureTime } from '../scripts/lib/fixture-values.mjs'
import { ConfigOwner } from '../src/main/config-owner'
import { FileReadOwner } from '../src/main/file-read-owner'
import { NotebookObservationOwner } from '../src/main/notebook-observation-owner'
import { NoteFileWriter } from '../src/main/note-file-writer'
import { NotesStorageOwner } from '../src/main/notes-storage-owner'
import { WorkspaceFiles } from '../src/main/workspace-files'
import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const creator = { kind: 'agent' as const, id: 'original-creator-session' }
const follower = { kind: 'agent' as const, id: 'original-follower-session' }
const cliActor = { kind: 'agent' as const, id: 'confirmed-cli-session' }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const revision = (value: string) => 'sha256:' + hash(value)

it('converts two original JSON Notes before the executable CLI reads, edits and resolves their original identities', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'note-md-old-cli-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'notes'); await mkdir(directory)
  const workspace: WorkspaceRecord = { id: '__notes__', name: 'Original notes', hostId: 'local', kind: 'folder', path: directory }
  const sourceResource = { hostId: 'local', workspaceId: workspace.id, workspacePath: directory, path: 'source.note.json' }
  const targetResource = { ...sourceResource, path: 'target.note.json' }
  const boundTarget = { noteId: 'target-note', blockId: 'target-block' }
  const draft = newNoteDocument('Original source finding', 'source-note', 'source-block')
  draft.content.content!.push(
    { type: 'paragraph', attrs: { blockId: 'pinned-block' }, content: [
      { type: 'text', text: 'Keep the exact binding: ' },
      { type: 'noteLink', attrs: { referenceId: 'original-inline-ref', text: 'Target finding', target: boundTarget } }
    ] },
    { type: 'blockReference', attrs: { blockId: 'original-embed-block', referenceId: 'original-embed-ref', mode: 'embed', target: boundTarget } }
  )
  const source = attributeNoteBlocks(null, draft, creator, fixtureTime(10))
  const target = attributeNoteBlocks(null, newNoteDocument('Original target finding', boundTarget.noteId, boundTarget.blockId), creator, fixtureTime(10))
  // These are explicit legacy inputs. Every subsequent normal read/write uses the Markdown codec.
  const sourceBytes = JSON.stringify(source, null, 2), targetBytes = JSON.stringify(target, null, 2)
  await writeFile(join(directory, sourceResource.path), sourceBytes)
  await writeFile(join(directory, targetResource.path), targetBytes)
  let originalCatalog = emptyNotebookState()
  for (const [noteId, title, resource] of [[source.noteId, 'Original', sourceResource], [target.noteId, 'Target', targetResource]] as const) {
    originalCatalog = applyNotebookChange(originalCatalog, { operationId: 'original-register-' + noteId, expectedRevision: originalCatalog.revision,
      change: { kind: 'register', noteId, title, resource } }, creator, fixtureTime(10))
  }
  const followOperation = 'original-follow-source'
  originalCatalog = applyNotebookChange(originalCatalog, { operationId: followOperation, expectedRevision: originalCatalog.revision,
    change: { kind: 'follow', noteId: source.noteId } }, follower, fixtureTime(20))
  await writeFile(join(directory, 'notebooks.json'), JSON.stringify(originalCatalog) + '\n')
  let config = { hosts: [], executors: {}, appearance: {}, workspaces: [workspace] } as unknown as AppConfig
  const configOwner = new ConfigOwner({ read: () => config, save: async value => {
    await writeFile(join(root, 'config.json'), JSON.stringify(value)); return value
  }, publish: value => { config = value } })
  const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  let notesOwner!: NotesStorageOwner
  const storage = new AgentMuxNotesStorage(join(root, 'state', 'notes-location.json'), directory, {
    beforeSourceCleanup: async () => { await notesOwner.confirmResources(await storage.inspect()) }
  })
  const published = vi.fn()
  notesOwner = new NotesStorageOwner(configOwner, spatial, published, storage)
  const converted = await notesOwner.initialize()
  expect(published).toHaveBeenCalledWith(converted)
  expect(converted.operation).toBeNull()
  expect(converted.conversionIssues ?? []).toEqual([])
  expect(converted.resourceChanges).toHaveLength(2)
  const sourceMd = await readFile(join(directory, 'source.note.md'), 'utf8')
  const targetMd = await readFile(join(directory, 'target.note.md'), 'utf8')
  for (const [note, resource, bytes, markdown] of [[source, sourceResource, sourceBytes, sourceMd], [target, targetResource, targetBytes, targetMd]] as const) {
    expect(readNoteDocument(bytes).status).toBe('invalid')
    expect(converted.resourceChanges).toContainEqual({ noteId: note.noteId, from: resource, to: { ...resource, path: resource.path.replace(/\.json$/u, '.md') },
      conversion: { sourceRevision: revision(bytes), targetRevision: revision(markdown) } })
  }
  const store = new AgentMuxNotebookStore(undefined, storage)
  expect(store.storage).toBe(notesOwner.storage)
  const files = new WorkspaceFiles(() => ({ kind: 'local', id: 'local' }) as never)
  cleanups.push(() => files.dispose())
  const resolveWorkspace = (id: string) => configOwner.current.workspaces.find(candidate => candidate.id === id)
  const observation = new NotebookObservationOwner({ files, workspace: resolveWorkspace, metadata: store })
  const writer = new NoteFileWriter(files, { state: () => store.read(), owner: observation }, store)
  const port = new FileReadOwner({ files: {
    read: writer.read.bind(writer), listFiles: files.listFiles.bind(files),
    write: (owner, input, context) => notesOwner.write(owner, input, actual => writer.write(actual, input, context))
  }, workspace: resolveWorkspace,
  catalog: async () => ({ zones: [{ zoneId: 'original-zone', workspaceId: workspace.id, kind: 'directory', hostId: 'local', directoryPath: directory }], bindings: [] }) as never })
  const authorize = vi.fn(async (capability: string, agentSessionId: string) => {
    expect(capability).toBe('fixture-original-authority'); expect(agentSessionId).toBe(cliActor.id)
    return { agentSessionId, hostId: 'local', run: { runId: 'fixture-authenticated-run' } }
  })
  const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), files: port, notebookStore: store,
    notebookObservation: observation, spatialState: spatial,
    coreClients: () => [{ hostId: 'local', client: { authorizeRetainedAgentCaller: authorize } }] as never })
  await server.start(); cleanups.push(() => server.stop())
  const commands: (CliResult & { args: string[] })[] = []
  const evidence = process.env.AGENTMUX_TEST_LEGACY_CLI_EVIDENCE
  const persistEvidence = async (final?: object) => {
    if (!evidence) return
    await mkdir(dirname(evidence), { recursive: true })
    await writeFile(evidence, JSON.stringify({ root, commands, converted, ...final }, null, 2) + '\n')
  }
  const cli = async <M extends AgentMuxRpcMethod>(method: M, args: string[], input = ''): Promise<AgentMuxRpcResult<M>> => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, ...args], objectCliEnvironment(root, {
      AGENTMUX_AGENT_SESSION_ID: cliActor.id, AGENTMUX_AGENT_CAPABILITY: 'fixture-original-authority'
    }), input)
    commands.push({ args, ...result }); await persistEvidence()
    expect(result.code, method + '\n' + result.stderr + '\n' + result.stdout).toBe(0)
    return JSON.parse(result.stdout).result as AgentMuxRpcResult<M>
  }
  const before = await cli('notebook.inspect', ['notebook', 'inspect', '--note', source.noteId, '--content'])
  expect(before.resourceChanges).toEqual(converted.resourceChanges)
  expect(before.conversionIssues ?? []).toEqual([])
  expect(before.pages[0]?.resource).toEqual({ ...sourceResource, path: 'source.note.md' })
  expect(before.content).toMatchObject({ status: 'read', revision: revision(sourceMd), actualNoteId: source.noteId,
    blockIds: ['source-block', 'pinned-block', 'original-embed-block'], noteProvenance: { status: 'recorded' } })
  if (before.content?.status !== 'read') throw new Error('Converted original content was not readable')
  const beforeProvenance = before.content.noteProvenance!
  for (const block of source.content.content!) expect(beforeProvenance.blocks[block.attrs!.blockId]).toEqual(block.attrs!.provenance)
  const checkCatalog = (catalog: typeof originalCatalog) => {
    expect(catalog.pages[source.noteId]!.followers).toEqual(originalCatalog.pages[source.noteId]!.followers)
    for (const [id, operation] of Object.entries(originalCatalog.operations)) expect(catalog.operations[id]).toEqual(operation)
    for (const originalEvent of originalCatalog.trail) expect(catalog.trail).toContainEqual(originalEvent)
  }
  checkCatalog(before.state)
  const originalOperation = await cli('notebook.inspect', ['notebook', 'inspect', '--operation-id', followOperation])
  expect(originalOperation.recordedOperation).toEqual(originalCatalog.operations[followOperation])
  const targetContent = await cli('notebook.inspect', ['notebook', 'inspect', '--note', target.noteId, '--content'])
  expect(targetContent.content).toMatchObject({ status: 'read', actualNoteId: target.noteId, revision: revision(targetMd),
    blockIds: [boundTarget.blockId], noteProvenance: { status: 'recorded', blocks: {
      [boundTarget.blockId]: target.content.content![0]!.attrs!.provenance
    } } })
  const read = await cli('file.read', ['file', 'read', '--zone', 'original-zone', '--path', 'source.note.md', '--host', 'local', '--workspace', workspace.id, '--workspace-path', directory])
  expect(read.result.status).toBe('read')
  if (read.result.status !== 'read' || !read.resource) throw new Error('Converted original File read was not confirmed')
  expect(read.result.document.content).toBe(sourceMd)
  expect(read.result.document.noteProvenance).toEqual(beforeProvenance)
  const candidate = readNoteDocument(read.result.document.content)
  if (candidate.status !== 'valid') throw new Error(candidate.message)
  candidate.note.content.content![0]!.content = [{ type: 'text', text: 'CLI corrected original source finding' }]
  const saved = await cli('file.write', ['file', 'write', '--zone', 'original-zone', '--path', 'source.note.md',
    '--resource', JSON.stringify(read.resource), '--expected-revision', read.result.document.revision], serializeNoteDocument(candidate.note))
  expect(saved.result).toMatchObject({ status: 'written', noteAttribution: { status: 'recorded' }, noteProvenance: { status: 'recorded' } })
  if (saved.result.status !== 'written') throw new Error('CLI CAS write was not confirmed')
  expect(authorize).toHaveBeenCalled()
  const after = await cli('notebook.inspect', ['notebook', 'inspect', '--note', source.noteId, '--content'])
  checkCatalog(after.state)
  expect(after.resourceChanges).toEqual(converted.resourceChanges)
  expect(after.content).toMatchObject({ status: 'read', revision: saved.result.revision, noteProvenance: { status: 'recorded' } })
  if (after.content?.status !== 'read') throw new Error('Saved original content was not readable')
  const changed = after.content.noteProvenance!.blocks['source-block']!
  expect(changed.created).toEqual(beforeProvenance.blocks['source-block']!.created)
  expect(changed.lastEdited?.actor).toEqual(cliActor)
  expect(changed.lastEdited!.at).toBeGreaterThan(fixtureTime(10))
  for (const id of ['pinned-block', 'original-embed-block']) expect(after.content.noteProvenance!.blocks[id]).toEqual(beforeProvenance.blocks[id])
  const finalMd = await readFile(join(directory, 'source.note.md'), 'utf8')
  expect(finalMd).toBe(after.content.content)
  expect(revision(finalMd)).toBe(saved.result.revision)
  expect(finalMd).not.toBe(sourceMd)
  for (const markdown of [finalMd, targetMd]) {
    for (const forbidden of [creator.id, cliActor.id, follower.id, '"provenance"', '"content":']) expect(markdown).not.toContain(forbidden)
  }
  const finalNote = readNoteDocument(finalMd)
  if (finalNote.status !== 'valid') throw new Error(finalNote.message)
  expect(finalNote.note.noteId).toBe(source.noteId)
  expect(finalNote.note.content.content!.map(block => block.attrs!.blockId)).toEqual(['source-block', 'pinned-block', 'original-embed-block'])
  expect(finalNote.note.content.content![1]!.content![1]!.attrs).toEqual({ referenceId: 'original-inline-ref', text: 'Target finding', target: boundTarget })
  expect(finalNote.note.content.content![2]!.attrs).toMatchObject({ blockId: 'original-embed-block', referenceId: 'original-embed-ref', mode: 'embed', target: boundTarget })
  const graph = await cli('notebook.graph', ['notebook', 'graph', '--note', source.noteId])
  expect(graph.completeness).toBe('complete'); expect(graph.references).toHaveLength(2)
  for (const [blockId, referenceId, mode] of [['pinned-block', 'original-inline-ref', 'link'], ['original-embed-block', 'original-embed-ref', 'embed']] as const) {
    expect(graph.references).toContainEqual(expect.objectContaining({ source: { noteId: source.noteId, blockId },
      sourceResource: { ...sourceResource, path: 'source.note.md' }, target: { kind: 'block', ...boundTarget }, occurrence: { kind: 'stored', referenceId }, mode, resolution: 'resolved' }))
  }
  const resolved = await cli('notebook.resolve', ['notebook', 'resolve', '--link', '[[Target #^target-block]]'])
  if (resolved.mode !== 'resolve') throw new Error('The exact original target was not resolved')
  expect(resolved.result).toEqual({ status: 'resolved', target: boundTarget })
  const backups: { path: string; revision: string }[] = []
  for (const [resource, bytes] of [[sourceResource, sourceBytes], [targetResource, targetBytes]] as const) {
    await expect(readFile(join(directory, resource.path))).rejects.toMatchObject({ code: 'ENOENT' })
    const backup = join(directory, '.agentmux-note-backups', resource.path + '.' + hash(bytes) + '.bak')
    expect(await readFile(backup, 'utf8')).toBe(bytes)
    backups.push({ path: backup, revision: revision(bytes) })
  }
  expect(await readFile(join(directory, 'target.note.md'), 'utf8')).toBe(targetMd)
  await persistEvidence({ accepted: true, sourceRevision: revision(sourceMd), savedRevision: saved.result.revision,
    targetRevision: revision(targetMd), backups, beforeProvenance, afterProvenance: after.content.noteProvenance,
    originalOperations: originalCatalog.operations, originalFollowers: originalCatalog.pages[source.noteId]!.followers,
    graph, resolved, authenticatedCalls: authorize.mock.calls })
}, 30_000)
