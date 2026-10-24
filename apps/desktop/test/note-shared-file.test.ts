import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentMuxControlServer, AgentMuxRpcService, parseNotebookGraph, parseNoteCorpusResult, type ExecutionHost } from '@agentmux/core'
import { readNoteMarkdownHeader, rewriteNoteMarkdownTitle } from '@agentmux/core/note-format'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { readNoteDocument, serializeNoteDocument, newNoteDocument, type NoteDocument } from '@agentmux/client-ui/note/note-document'
import { noteKnowledge, resolveNoteBlock, resolveNoteInclude } from '@agentmux/client-ui/note/note-knowledge'
import { NotebookObservationRequests } from '../src/main/notebook-observation-requests.js'
import { NoteFileWriter } from '@agentmux/host/note-file-writer'
import { NotebookObservationOwner } from '@agentmux/host/notebook-observation-owner'
import { WorkspaceFiles } from '../src/main/workspace-files.js'
import { parseNotebookGraphSnapshot, noteContentMatchesGraph } from '../src/shared/notebook-observation.js'
import type { WorkspaceRecord } from '../src/shared/contracts.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'

const roots: string[] = [], servers: AgentMuxControlServer[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const digest = 'sha256:' + 'a'.repeat(64)
const origin = { operationId: 'share-operation', sourceOperationId: 'source-save-operation', sourceNoteId: 'source', sourcePath: 'source.note.md', sourceRevision: digest, sourceBlockId: 'original-block', requestFingerprint: digest,
  destination: { noteId: 'destination', path: 'destination.note.md', operationId: 'paste-operation', expectedRevision: digest } }
const shared = (): NoteDocument => ({ ...newNoteDocument('One shared original.', 'shared-file', 'inside', 'Shared content'), kind: 'shared-block', origin })
const included = (): NoteDocument => ({ schema: 'agentmux.note.v1', noteId: 'source', title: 'Original source', content: { type: 'doc', content: [
  { type: 'noteInclude', attrs: { blockId: 'original-block', referenceId: 'first-use', noteId: 'shared-file', path: '.blocks/one.note.md' } }
] } })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-shared-file-'))); roots.push(root)
  const workspace: WorkspaceRecord = { id: 'notes', hostId: 'local', path: root, name: 'Notes', kind: 'folder' }
  const files = new WorkspaceFiles(() => ({ kind: 'local' } as ExecutionHost)), store = new AgentMuxNotebookStore(join(root, 'catalog.json'))
  const owner = new NotebookObservationOwner({ workspace: id => id === workspace.id ? workspace : undefined, files })
  const writer = new NoteFileWriter(files, { state: () => store.read(), owner }, store)
  const resource = (path: string) => ({ hostId: 'local', workspaceId: workspace.id, workspacePath: root, path })
  await mkdir(join(root, '.blocks'))
  for (const [path, note] of [['source.note.md', included()], ['.blocks/one.note.md', shared()]] as const) {
    expect(await writer.write(workspace, { path, content: serializeNoteDocument(note), expectedRevision: null })).toMatchObject({ status: 'written' })
  }
  const state = await store.read()
  await store.apply({ expectedRevision: state.revision, operationId: 'register-source', change: { kind: 'register', noteId: 'source', title: 'Original source', resource: resource('source.note.md') } }, { kind: 'user', id: 'test' })
  return { root, workspace, files, store, owner, resource }
}

describe('shared Markdown file identity and real public consumers', () => {
  it('roundtrips the shared header and whole-file include without a synthetic root block target', () => {
    const raw = serializeNoteDocument(shared()), read = readNoteDocument(raw)
    expect(read.status).toBe('valid')
    if (read.status === 'valid') { expect(read.note).toMatchObject({ kind: 'shared-block', origin }); expect(serializeNoteDocument(read.note)).toBe(raw) }
    const source = serializeNoteDocument(included())
    expect(source).toContain('::note-include{#original%2Dblock ref="first%2Duse" target="note:shared%2Dfile" path=".blocks/one.note.md"}')
    const parsed = readNoteDocument(source)
    expect(parsed.status).toBe('valid')
    if (parsed.status === 'valid') expect(parsed.note.content.content![0]).toMatchObject({ type: 'noteInclude', attrs: included().content.content![0]!.attrs })
    expect(readNoteMarkdownHeader(rewriteNoteMarkdownTitle(raw, 'Renamed'))).toMatchObject({ status: 'valid', kind: 'shared-block', origin, title: 'Renamed' })
    for (const invalid of [
      raw.replace('kind: shared-block\n', ''), raw.replace('kind: shared-block', 'kind: ordinary'),
      raw.replace('sourcePath: "source.note.md"', 'sourcePath: "../outside.note.md"'), raw.replace(`sourceRevision: "${digest}"`, 'sourceRevision: "wrong"'),
      raw.replace('origin:\n', 'origin:\n  forged: true\n'), raw.replace('expectedRevision', 'extraRevision')
    ]) expect(readNoteDocument(invalid).status).toBe('invalid')
    for (const invalid of [source.replace('path=".blocks/one.note.md"', 'path="../outside.note.md"'), source.replace('note:shared%2Dfile', 'note:shared%2Dfile#inside')]) expect(readNoteDocument(invalid).status).toBe('invalid')
  })

  it('reads unregistered shared files through real Files, public RPC graph/scan and the strict GUI snapshot', async () => {
    const f = await fixture(), state = await f.store.read(), service = new AgentMuxRpcService({ coreClients: () => [], notebookStore: f.store, notebookObservation: f.owner })
    const graph = await service.call('notebook.graph', { noteId: 'source' })
    expect(graph.observations).toHaveLength(2)
    expect(graph.observations.find(item => item.noteId === 'shared-file')).toMatchObject({ fileIdentity: 'confirmed' })
    expect(graph.references).toEqual([{ source: { noteId: 'source', blockId: 'original-block' }, sourceResource: f.resource('source.note.md'), target: { kind: 'page', noteId: 'shared-file' }, occurrence: { kind: 'stored', referenceId: 'first-use' }, mode: 'embed', resolution: 'resolved' }])
    expect(parseNotebookGraph(graph, { noteId: 'source' })).toEqual(graph)
    expect(parseNotebookGraphSnapshot({ catalog: state, graph }, { noteId: 'source' }).graph).toEqual(graph)
    const content = await f.owner.content(state, 'shared-file')
    expect(content).toMatchObject({ status: 'read', kind: 'shared-block', resource: f.resource('.blocks/one.note.md') })
    expect(noteContentMatchesGraph({ catalog: state, graph }, content)).toBe(true)
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false })
    const requests = new NotebookObservationRequests(f.store, f.owner)
    expect(await requests.content(sender as any, { requestId: 'read-shared', noteId: 'shared-file' })).toMatchObject({ status: 'read', kind: 'shared-block' })
    requests.dispose()
    const scan = await service.call('notebook.scan', { workspaceId: 'notes', path: '.', query: 'shared original' })
    expect(scan.pages.find(page => page.noteId === 'shared-file')).toMatchObject({ kind: 'shared-block' })
    expect(scan.references[0]).toMatchObject({ target: { kind: 'page', noteId: 'shared-file' }, mode: 'embed', resolution: 'resolved' })
    expect(scan.search.hits).toHaveLength(1)
    expect(parseNoteCorpusResult(scan, { workspaceId: 'notes', path: '.', query: 'shared original' })).toEqual(scan)
    expect(await f.store.read()).toEqual(state)
  })

  it('discovers an unregistered shared original in another configured Workspace and keeps the Markdown target independent of the hint', async () => {
    const f = await fixture(), projectPath = await realpath(await mkdtemp(join(tmpdir(), 'amx-shared-project-'))); roots.push(projectPath)
    const project: WorkspaceRecord = { id: 'project', hostId: 'local', path: projectPath, kind: 'folder', name: 'Project' }
    await mkdir(join(projectPath, '.blocks'))
    const owner = new NotebookObservationOwner({ workspace: id => id === 'project' ? project : id === 'notes' ? f.workspace : undefined, files: f.files })
    const writer = new NoteFileWriter(f.files, { state: () => f.store.read(), owner }, f.store)
    const shared = { ...newNoteDocument('One project original, reused by Recall.', 'cross-shared', 'project-body', 'Project finding'), kind: 'shared-block' as const }
    expect(await writer.write(project, { path: '.blocks/shared.note.md', expectedRevision: null, content: serializeNoteDocument(shared) })).toMatchObject({ status: 'written' })
    const source = included(); source.content.content![0]!.attrs = { blockId: 'original-block', referenceId: 'cross-use', noteId: 'cross-shared', path: '.blocks/shared.note.md', workspaceId: 'project' }
    await writeFile(join(f.root, 'source.note.md'), serializeNoteDocument(source))
    const parsed = readNoteDocument(serializeNoteDocument(source))
    expect(parsed.status).toBe('valid'); if (parsed.status === 'valid') expect(parsed.note.content.content![0]!.attrs?.workspaceId).toBe('project')
    const state = await f.store.read(), graph = await owner.graph(state, { noteId: 'source' })
    expect(graph.references[0]).toMatchObject({ target: { kind: 'page', noteId: 'cross-shared' }, mode: 'embed', resolution: 'resolved' })
    expect(graph.observations.find(item => item.noteId === 'cross-shared')).toMatchObject({ fileIdentity: 'confirmed', resource: { workspaceId: 'project', workspacePath: projectPath, path: '.blocks/shared.note.md' } })
    expect(parseNotebookGraphSnapshot({ catalog: state, graph }, { noteId: 'source' }).graph).toEqual(graph)
    expect(await owner.content(state, 'cross-shared')).toMatchObject({ status: 'read', kind: 'shared-block', resource: { workspaceId: 'project' } })
    const server = new AgentMuxControlServer({ socketPath: join(f.root, 'cross-rpc.sock'), coreClients: () => [], notebookStore: f.store, notebookObservation: owner }); servers.push(server); await server.start()
    const inspected = await runCompiledObjectCli(['notebook', 'inspect', '--note', 'cross-shared', '--content'], objectCliEnvironment(f.root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path }))
    expect(inspected.code, inspected.stderr).toBe(0); expect(JSON.parse(inspected.stdout).result.content.resource.workspaceId).toBe('project')
    // Copying the complete Markdown files elsewhere can leave a stale App hint: physical scan still rebuilds the same target by ID.
    expect(await f.files.write(f.workspace, { path: 'copied.note.md', expectedRevision: null, content: serializeNoteDocument(shared) })).toMatchObject({ status: 'written' })
    const localOnly = new NotebookObservationOwner({ workspace: id => id === 'notes' ? f.workspace : undefined, files: f.files })
    const rebuilt = await localOnly.scan({ workspaceId: 'notes', path: '.' })
    expect(rebuilt.references[0]).toMatchObject({ target: { kind: 'page', noteId: 'cross-shared' }, resolution: 'resolved' })
    expect((await localOnly.graph(state, { noteId: 'source' })).references[0]!.resolution).toBe('resolved')
    expect((await f.store.read()).pages['cross-shared']).toBeUndefined()
  })

  it('keeps a whole-file include resolved after move and normal unanchored paragraph edits', async () => {
    const f = await fixture(), state = await f.store.read()
    const raw = serializeNoteDocument(shared()), header = readNoteMarkdownHeader(raw)
    expect(header.status).toBe('valid')
    if (header.status !== 'valid') return
    const updated = raw.slice(0, header.bodyOffset) + '\nNew ordinary paragraph.\n\n## Reordered heading\n\n- New list item\n\nSecond paragraph.\n'
    await writeFile(join(f.root, '.blocks/one.note.md'), updated)
    await rename(join(f.root, '.blocks/one.note.md'), join(f.root, '.blocks/moved.note.md'))
    const graph = await f.owner.graph(state, { noteId: 'source' })
    expect(graph.completeness).toBe('partial')
    expect(graph.observations.find(item => item.noteId === 'shared-file')).toMatchObject({ fileIdentity: 'confirmed' })
    expect(graph.references[0]).toMatchObject({ target: { kind: 'page', noteId: 'shared-file' }, resolution: 'resolved' })
    expect(parseNotebookGraphSnapshot({ catalog: state, graph }, { noteId: 'source' }).graph).toEqual(graph)
    const content = await f.owner.content(state, 'shared-file')
    expect(content).toMatchObject({ status: 'read', resource: f.resource('.blocks/moved.note.md'), content: updated })
    const read = await f.files.read(f.workspace, '.blocks/moved.note.md')
    if (read.status !== 'read') throw Error('The real shared file was not read')
    const knowledge = noteKnowledge([{ location: { workspaceId: 'notes', path: '.blocks/moved.note.md' }, document: read.document }], 'complete')
    expect(knowledge.scope).toBe('partial'); expect(knowledge.fileScope).toBe('complete')
    expect(resolveNoteInclude(knowledge, { noteId: 'shared-file' }, 'notes')).toMatchObject({ status: 'resolved', source: { location: { path: '.blocks/moved.note.md' } } })
    expect((await f.owner.scan({ workspaceId: 'notes', path: '.' })).references[0]!.resolution).toBe('resolved')
  })

  it('reconstructs old child addresses from saved Markdown without inventing host blocks or choosing repeated forwarding declarations', async () => {
    const f = await fixture(), source = included()
    source.content.content![0]!.attrs!.forwardedBlockIds = ['inside']
    const raw = serializeNoteDocument(source), parsed = readNoteDocument(raw)
    expect(parsed.status).toBe('valid')
    if (parsed.status === 'valid') expect(parsed.note.content.content![0]!.attrs!.forwardedBlockIds).toEqual(['inside'])
    await writeFile(join(f.root, 'source.note.md'), raw)
    const reader: NoteDocument = { schema: 'agentmux.note.v1', noteId: 'reader', title: 'Reader', content: { type: 'doc', content: [{ type: 'blockReference', attrs: { blockId: 'old-child-use', referenceId: 'old-child-reference', mode: 'embed', target: { noteId: 'source', blockId: 'inside' } } }] } }
    expect(await f.files.write(f.workspace, { path: 'reader.note.md', expectedRevision: null, content: serializeNoteDocument(reader) })).toMatchObject({ status: 'written' })
    let state = await f.store.read()
    await f.store.apply({ expectedRevision: state.revision, operationId: 'register-reader', change: { kind: 'register', noteId: 'reader', title: 'Reader', resource: f.resource('reader.note.md') } }, { kind: 'user', id: 'test' })
    state = await f.store.read()
    const service = new AgentMuxRpcService({ coreClients: () => [], notebookStore: f.store, notebookObservation: f.owner })
    const graphRead = service.call('notebook.graph', { noteId: 'reader' })
    await expect(graphRead).resolves.toMatchObject({ references: [expect.objectContaining({ resolution: 'resolved' })] })
    const graph = await graphRead
    expect(graph.references).toEqual([expect.objectContaining({ target: { kind: 'block', noteId: 'source', blockId: 'inside' }, resolution: 'resolved' })])
    const host = graph.observations.find(item => item.noteId === 'source')!
    expect(host).toMatchObject({ blockIds: ['original-block'], blockForwardings: [{ blockId: 'inside', includeBlockId: 'original-block', noteId: 'shared-file' }] })
    expect(parseNotebookGraphSnapshot({ catalog: state, graph }, { noteId: 'reader' }).graph).toEqual(graph)
    const corpus = await service.call('notebook.scan', { workspaceId: 'notes', path: '.' })
    expect(corpus.references.find(item => item.source.noteId === 'reader')).toMatchObject({ target: { kind: 'block', noteId: 'source', blockId: 'inside' }, resolution: 'resolved' })
    expect(parseNoteCorpusResult(corpus, { workspaceId: 'notes', path: '.' })).toEqual(corpus)
    const documents = []
    for (const path of ['source.note.md', '.blocks/one.note.md']) {
      const read = await f.files.read(f.workspace, path); if (read.status !== 'read') throw Error('Original Markdown is unreadable')
      documents.push({ location: { workspaceId: 'notes', path }, document: read.document })
    }
    const knowledge = noteKnowledge(documents, 'complete')
    expect(knowledge.sources.find(item => item.note.noteId === 'source')!.blocks.has('inside')).toBe(false)
    expect(resolveNoteBlock(knowledge, { noteId: 'source', blockId: 'inside' })).toMatchObject({ status: 'resolved', source: { note: { noteId: 'shared-file' } }, block: { blockId: 'inside', text: 'One shared original.' } })
    // Missing target children remain unknown: the saved forwarding is a fact, not permission to fabricate a target.
    await writeFile(join(f.root, '.blocks/one.note.md'), serializeNoteDocument({ ...newNoteDocument('Changed shared body.', 'shared-file', 'different'), kind: 'shared-block' }))
    expect((await service.call('notebook.graph', { noteId: 'reader' })).references[0]!.resolution).toBe('unknown')
    source.content.content![0]!.attrs!.forwardedBlockIds = ['inside', 'inside']
    await writeFile(join(f.root, 'source.note.md'), serializeNoteDocument(source))
    const ambiguous = await service.call('notebook.graph', { noteId: 'reader' })
    expect(ambiguous.references[0]!.resolution).toBe('ambiguous')
    expect(parseNotebookGraph(ambiguous, { noteId: 'reader' })).toEqual(ambiguous)
  })

  it('preserves duplicate real file identities and refuses to choose the path hint or a last Map entry', async () => {
    const f = await fixture(), state = await f.store.read()
    await f.files.write(f.workspace, { path: 'duplicate.note.md', expectedRevision: null, content: serializeNoteDocument({ ...newNoteDocument('A separate ordinary copy.', 'shared-file', 'copy', 'Copied ID') }) })
    const graph = await f.owner.graph(state, { noteId: 'source' })
    expect(graph.observations).toHaveLength(3); expect(graph.observations.find(item => item.kind === 'shared-block')).toMatchObject({ fileIdentity: 'ambiguous' }); expect(graph.duplicateNoteIds).toEqual(['shared-file']); expect(graph.references[0]!.resolution).toBe('ambiguous')
    expect(graph.observations.find(item => item.resource.path === 'duplicate.note.md')).not.toHaveProperty('kind')
    expect(parseNotebookGraphSnapshot({ catalog: state, graph }, { noteId: 'source' }).graph).toEqual(graph)
    expect(await f.owner.content(state, 'shared-file')).toMatchObject({ status: 'unknown' })
    const forged = structuredClone(graph); forged.references[0]!.resolution = 'resolved'
    expect(() => parseNotebookGraph(forged, { noteId: 'source' })).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    const duplicateResource = structuredClone(graph); duplicateResource.observations.push(duplicateResource.observations[0]!)
    expect(() => parseNotebookGraph(duplicateResource, { noteId: 'source' })).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  })

  it('keeps includes unknown under incomplete identity discovery and rejects unrelated snapshot observations', async () => {
    const f = await fixture(), state = await f.store.read()
    await writeFile(join(f.root, 'damaged.note.md'), '---\nschema: broken\n---\nOriginal damaged bytes')
    const graph = await f.owner.graph(state, { noteId: 'source' })
    expect(graph.completeness).toBe('partial'); expect(graph.references[0]!.resolution).toBe('unknown')
    expect(graph.observations.find(item => item.kind === 'shared-block')).toMatchObject({ fileIdentity: 'unknown' })
    expect((await f.owner.scan({ workspaceId: 'notes', path: '.' })).references[0]!.resolution).toBe('unknown')
    const forged = structuredClone(graph), extra = forged.observations.find(item => item.kind === 'shared-block')!
    delete extra.kind
    expect(() => parseNotebookGraphSnapshot({ catalog: state, graph: forged }, { noteId: 'source' })).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    expect(await readFile(join(f.root, 'damaged.note.md'), 'utf8')).toContain('Original damaged bytes')
  })

  it('keeps exact original Files editable when a graph byte budget cannot confirm shared identity', async () => {
    const f = await fixture(), state = await f.store.read()
    const sourceBytes = new TextEncoder().encode(await readFile(join(f.root, 'source.note.md'), 'utf8')).byteLength
    const graph = await f.owner.graph(state, { maxBytes: sourceBytes })
    expect(graph.references[0]!.resolution).toBe('unknown')
    expect(parseNotebookGraph(graph, { maxBytes: sourceBytes })).toEqual(graph)
    const original = await f.files.read(f.workspace, '.blocks/one.note.md')
    expect(original.status).toBe('read')
    if (original.status !== 'read') throw Error('The same exact shared Markdown is still physically readable')
    expect(await f.files.write(f.workspace, { path: '.blocks/one.note.md', expectedRevision: original.document.revision, content: original.document.content + '\nLater authorized content.\n' })).toMatchObject({ status: 'written' })
  })

  it('does not discover unrelated files when the observed catalog has no includes', async () => {
    const f = await fixture(), state = await f.store.read()
    await writeFile(join(f.root, 'source.note.md'), serializeNoteDocument(newNoteDocument('Ordinary text.', 'source', 'original-block')))
    let listings = 0
    const owner = new NotebookObservationOwner({ workspace: () => f.workspace, files: { read: f.files.read.bind(f.files), readDirectory: async (...args) => { listings++; return f.files.readDirectory(...args) } } })
    const graph = await owner.graph(state, {})
    expect(graph.observations).toHaveLength(1); expect(graph.references).toEqual([]); expect(listings).toBe(0)
  })

  it('scans a 100-page Workspace once for multiple includes and reuses exact resources for content reads', async () => {
    const f = await fixture(), state = await f.store.read(), source = included()
    source.content.content!.push({ type: 'noteInclude', attrs: { blockId: 'second-position', referenceId: 'second-use', noteId: 'shared-file', path: '.blocks/one.note.md' } })
    await writeFile(join(f.root, 'source.note.md'), serializeNoteDocument(source))
    await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(join(f.root, `ordinary-${index}.note.md`), serializeNoteDocument(newNoteDocument('Ordinary knowledge ' + index, 'ordinary-' + index, 'paragraph-' + index, 'Page ' + index)))))
    const reads: string[] = [], listings: string[] = []
    const owner = new NotebookObservationOwner({ workspace: () => f.workspace, files: {
      read: async (...args) => { reads.push(args[1]); return f.files.read(...args) },
      readDirectory: async (...args) => { listings.push(args[1]); return f.files.readDirectory(...args) }
    } })
    const before = performance.now(), cpuBefore = process.cpuUsage()
    const graph = await owner.graph(state, {})
    const graphMs = performance.now() - before, cpu = process.cpuUsage(cpuBefore)
    expect(graph.references).toHaveLength(2); expect(graph.references.every(item => item.resolution === 'resolved')).toBe(true)
    expect(listings.filter(path => path === '.')).toHaveLength(1); expect(listings).toHaveLength(2)
    expect(reads.filter(path => path === 'source.note.md')).toHaveLength(1)
    const listingCount = listings.length
    expect(await owner.content(state, 'shared-file')).toMatchObject({ status: 'read', kind: 'shared-block' })
    expect(await owner.content(state, 'shared-file')).toMatchObject({ status: 'read', kind: 'shared-block' })
    expect(listings).toHaveLength(listingCount)
    await mkdir('.local/state/note-shared-block', { recursive: true })
    await writeFile(".local/state/note-shared-block/t001-cost.json", JSON.stringify({ ordinaryPages: 100, sharedFiles: 1, includes: 2, graphMs, cpuMicroseconds: cpu.user + cpu.system, graphSourceReads: reads.length - 2, directoryListings: listingCount, contentCalls: 2, contentExtraListings: listings.length - listingCount }, null, 2) + '\n')
  })

  it('serves file-level include graph and scan through the actual public CLI without a shared catalog row', async () => {
    const f = await fixture(), server = new AgentMuxControlServer({ socketPath: join(f.root, 'rpc.sock'), coreClients: () => [], notebookStore: f.store, notebookObservation: f.owner })
    servers.push(server); await server.start()
    const env = objectCliEnvironment(f.root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path })
    const graphed = await runCompiledObjectCli(['notebook', 'graph', '--note', 'shared-file'], env)
    expect(graphed.code, graphed.stderr).toBe(0)
    expect(JSON.parse(graphed.stdout).result.references).toEqual([expect.objectContaining({ mode: 'embed', target: { kind: 'page', noteId: 'shared-file' }, resolution: 'resolved' })])
    const inspected = await runCompiledObjectCli(['notebook', 'inspect', '--note', 'shared-file', '--content'], env)
    expect(inspected.code, inspected.stderr).toBe(0)
    expect(JSON.parse(inspected.stdout).result.content).toMatchObject({ noteId: 'shared-file', status: 'read', kind: 'shared-block' })
    const scanned = await runCompiledObjectCli(['notebook', 'scan', '--workspace', 'notes', '--path', '.'], env)
    expect(scanned.code, scanned.stderr).toBe(0)
    expect(JSON.parse(scanned.stdout).result.pages).toEqual(expect.arrayContaining([expect.objectContaining({ noteId: 'shared-file', kind: 'shared-block' })]))
    expect((await f.store.read()).pages['shared-file']).toBeUndefined()
  })
})
