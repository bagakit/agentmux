import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AgentMuxControlServer, AgentMuxRpcService, parseNotebookGraph, type ExecutionHost } from '@agentmux/core'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { newNoteDocument, serializeNoteDocument, type NoteDocument } from '@agentmux/client-ui/note/note-document'
import { NotebookObservationOwner } from '@agentmux/host/notebook-observation-owner'
import { NoteFileWriter } from '@agentmux/host/note-file-writer'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { parseNotebookGraphSnapshot, noteContentMatchesGraph } from '../src/shared/notebook-observation'
import type { WorkspaceRecord } from '../src/shared/contracts'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const include = (noteId: string, workspaceId: string, occurrence: string) => ({ type: 'noteInclude', attrs: { noteId, workspaceId, path: noteId + '.note.md', referenceId: occurrence, blockId: occurrence + '-block' } })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-nested-scope-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const workspaces = new Map<string, WorkspaceRecord>()
  for (const id of ['notes', 'project', 'unused']) {
    const workspace: WorkspaceRecord = { id, name: id, path: join(root, id), hostId: 'local', kind: 'folder' }
    await mkdir(workspace.path); workspaces.set(id, workspace)
  }
  const files = new WorkspaceFiles(() => ({ kind: 'local' } as ExecutionHost))
  cleanups.push(() => files.dispose())
  const store = new AgentMuxNotebookStore(join(root, 'notebooks.sqlite'))
  const reads: Array<{ workspaceId: string; path: string; maxBytes?: number }> = [], directories: Array<{ workspaceId: string; path: string }> = []
  const ports = {
    read: async (...args: Parameters<WorkspaceFiles['read']>) => { reads.push({ workspaceId: args[0].id, path: args[1], ...(args[2] ? { maxBytes: args[2].maxFileBytes } : {}) }); return files.read(...args) },
    readDirectory: async (...args: Parameters<WorkspaceFiles['readDirectory']>) => { directories.push({ workspaceId: args[0].id, path: args[1] }); return files.readDirectory(...args) }
  }
  const owner = new NotebookObservationOwner({ workspace: id => workspaces.get(id), files: ports, metadata: store })
  const writer = new NoteFileWriter(files, { state: () => store.read(), owner }, store)
  const a = newNoteDocument('Root original.', 'a', 'a-body', 'Root')
  a.content.content!.push(include('b', 'notes', 'a-to-b'))
  const b: NoteDocument = { ...newNoteDocument('First shared original.', 'b', 'b-body', 'First shared'), kind: 'shared-block' }
  b.content.content!.push(include('c', 'project', 'b-to-c'))
  const c: NoteDocument = { ...newNoteDocument('Nested project original.', 'c', 'c-body', 'Nested shared'), kind: 'shared-block' }
  for (const [workspaceId, note] of [['notes', a], ['notes', b], ['project', c]] as const) {
    expect(await writer.write(workspaces.get(workspaceId)!, { path: note.noteId + '.note.md', expectedRevision: null, content: serializeNoteDocument(note) })).toMatchObject({ status: 'written' })
  }
  const resource = (workspaceId: string, path: string) => ({ hostId: 'local', workspaceId, workspacePath: workspaces.get(workspaceId)!.path, path })
  await store.apply({ operationId: 'register-a', expectedRevision: (await store.read()).revision, change: { kind: 'register', noteId: 'a', title: 'Root', resource: resource('notes', 'a.note.md') } }, { kind: 'user', id: 'fixture' })
  const state = await store.read(), service = new AgentMuxRpcService({ coreClients: () => [], notebookStore: store, notebookObservation: owner })
  return { root, workspaces, files, store, ports, owner, writer, reads, directories, resource, state, service, a, b, c,
    async source(workspaceId: string, note: NoteDocument, path = note.noteId + '.note.md') { await writeFile(join(workspaces.get(workspaceId)!.path, path), serializeNoteDocument(note)) } }
}

it('discovers nested cross-Workspace originals through the public graph and exact original content without a direct root-to-child link', async () => {
  const f = await fixture(), before = await readFile(join(f.workspaces.get('project')!.path, 'c.note.md'), 'utf8')
  const graph = await f.service.call('notebook.graph', {})
  expect(graph.completeness).toBe('complete')
  expect(graph.references.map(item => [item.source.noteId, item.target.kind !== 'unbound' && item.target.noteId, item.resolution])).toEqual([['a', 'b', 'resolved'], ['b', 'c', 'resolved']])
  expect(graph.observations.find(item => item.noteId === 'c')).toMatchObject({ kind: 'shared-block', fileIdentity: 'confirmed', resource: f.resource('project', 'c.note.md') })
  expect(parseNotebookGraphSnapshot({ catalog: f.state, graph }, {}).graph).toEqual(graph)
  const content = (await f.service.call('notebook.inspect', { noteId: 'c', content: true })).content!
  expect(content).toMatchObject({ status: 'read', actualNoteId: 'c', resource: f.resource('project', 'c.note.md'), content: before })
  expect(noteContentMatchesGraph({ catalog: f.state, graph }, content)).toBe(true)
  expect(f.directories).toEqual([{ workspaceId: 'notes', path: '.' }, { workspaceId: 'project', path: '.' }])
  expect(f.reads.filter(item => item.path === 'a.note.md')).toHaveLength(1)
  expect(f.reads.filter(item => item.workspaceId === 'unused')).toEqual([])
  expect(await f.store.read()).toEqual(f.state)
  expect(await readFile(join(f.workspaces.get('project')!.path, 'c.note.md'), 'utf8')).toBe(before)
})

it('deduplicates the same physical Workspace scope and a nested cycle without inventing duplicate file identities', async () => {
  const f = await fixture(), project = f.workspaces.get('project')!
  f.workspaces.set('project-alias', { ...project, id: 'project-alias' })
  f.c.content.content!.push(include('d', 'project-alias', 'c-to-d'))
  const d: NoteDocument = { ...newNoteDocument('A fourth shared original.', 'd', 'd-body', 'Fourth'), kind: 'shared-block' }
  d.content.content!.push(include('b', 'notes', 'd-to-b'))
  await f.source('project', f.c); await f.source('project', d)
  const graph = await f.owner.graph(f.state, {})
  expect(graph.completeness).toBe('complete'); expect(graph.duplicateNoteIds).toEqual([])
  expect(graph.observations).toHaveLength(4)
  expect(graph.references).toHaveLength(4); expect(graph.references.every(item => item.resolution === 'resolved')).toBe(true)
  expect(f.directories).toEqual([{ workspaceId: 'notes', path: '.' }, { workspaceId: 'project', path: '.' }])
  expect(f.reads.filter(item => item.path === 'c.note.md')).toHaveLength(1)
  expect(parseNotebookGraph(graph, {})).toEqual(graph)
})

it('retains a nested duplicated identity as ambiguous and never chooses a path hint or last file', async () => {
  const f = await fixture(); await f.source('project', f.c, 'duplicate.note.md')
  const graph = await f.owner.graph(f.state, {})
  expect(graph.completeness).toBe('partial'); expect(graph.duplicateNoteIds).toEqual(['c'])
  expect(graph.references.find(item => item.source.noteId === 'b')).toMatchObject({ resolution: 'ambiguous' })
  expect(await f.owner.content(f.state, 'c')).toMatchObject({ status: 'unknown' })
  expect(await f.owner.content(f.state, 'b')).toMatchObject({ status: 'read', resource: f.resource('notes', 'b.note.md') })
})

it('reuses a catalog original addressed through another exact Workspace mapping of the same physical file', async () => {
  const f = await fixture(), notes = f.workspaces.get('notes')!
  f.workspaces.set('notes-alias', { ...notes, id: 'notes-alias' })
  await f.store.apply({ operationId: 'register-aliased-b', expectedRevision: f.state.revision, change: { kind: 'register', noteId: 'b', title: 'First shared', resource: f.resource('notes-alias', 'b.note.md') } }, { kind: 'user', id: 'fixture' })
  const state = await f.store.read(), graph = await f.owner.graph(state, {})
  expect(graph.completeness).toBe('complete'); expect(graph.duplicateNoteIds).toEqual([])
  expect(graph.observations).toHaveLength(3)
  expect(graph.observations.find(item => item.noteId === 'b')).toMatchObject({ fileIdentity: 'confirmed', resource: f.resource('notes-alias', 'b.note.md') })
  expect(graph.references.every(item => item.resolution === 'resolved')).toBe(true)
  expect(f.reads.filter(item => item.path === 'b.note.md')).toEqual([expect.objectContaining({ workspaceId: 'notes-alias' })])
  expect(f.directories).toEqual([{ workspaceId: 'notes', path: '.' }, { workspaceId: 'project', path: '.' }])
  expect(await f.owner.content(state, 'b')).toMatchObject({ status: 'read', resource: f.resource('notes-alias', 'b.note.md') })
})

it('keeps a nested file unique when configured parent and child Workspaces overlap', async () => {
  const f = await fixture(), oldProject = f.workspaces.get('project')!, path = join(f.workspaces.get('notes')!.path, 'nested')
  await mkdir(path); f.workspaces.set('project', { ...oldProject, path })
  await f.source('project', f.c); await rm(join(oldProject.path, 'c.note.md'))
  const graph = await f.owner.graph(f.state, {})
  expect(graph.completeness).toBe('complete'); expect(graph.duplicateNoteIds).toEqual([])
  expect(graph.observations.filter(item => item.noteId === 'c')).toHaveLength(1)
  expect(graph.references.every(item => item.resolution === 'resolved')).toBe(true)
  expect(await f.owner.content(f.state, 'c')).toMatchObject({ status: 'read', resource: f.resource('notes', 'nested/c.note.md') })
})

it.each(['missing', 'inaccessible'] as const)('keeps the nested %s Workspace unknown while retaining readable originals', async failure => {
  const f = await fixture()
  if (failure === 'missing') f.workspaces.delete('project')
  else {
    const readDirectory = f.ports.readDirectory
    f.ports.readDirectory = async (...args) => { if (args[0].id === 'project') throw Error('Original project directory is inaccessible'); return readDirectory(...args) }
  }
  const graph = await f.owner.graph(f.state, {})
  expect(graph.completeness).toBe('partial')
  expect(graph.references.find(item => item.source.noteId === 'b')).toMatchObject({ resolution: 'unknown' })
  expect(graph.observations.find(item => item.noteId === 'b')).toMatchObject({ status: 'read' })
  expect(await f.owner.content(f.state, 'b')).toMatchObject({ status: 'read' })
  await expect(f.owner.content(f.state, 'c')).rejects.toMatchObject({ code: 'NOTEBOOK_INPUT_INVALID' })
})

it('carries the original per-file byte cap into newly discovered Workspaces without changing their source', async () => {
  const f = await fixture()
  f.c.content.content![0]!.content = [{ type: 'text', text: 'Original large nested content. '.repeat(400) }]
  await f.source('project', f.c)
  const before = await readFile(join(f.workspaces.get('project')!.path, 'c.note.md'), 'utf8'), graph = await f.owner.graph(f.state, { maxBytes: 1024 })
  expect(graph.completeness).toBe('partial')
  expect(graph.references.find(item => item.source.noteId === 'b')).toMatchObject({ resolution: 'unknown' })
  expect(f.reads.find(item => item.workspaceId === 'project' && item.path === 'c.note.md')).toMatchObject({ maxBytes: 1024 })
  expect((await f.files.read(f.workspaces.get('project')!, 'c.note.md')).status).toBe('read')
  expect(await readFile(join(f.workspaces.get('project')!.path, 'c.note.md'), 'utf8')).toBe(before)
})

it('cancels a newly discovered original directory promptly and rejects its late result without replacing confirmed resources', async () => {
  const f = await fixture()
  expect((await f.owner.graph(f.state, {})).completeness).toBe('complete')
  f.c.content.content!.push(include('late-child', 'unused', 'c-to-late'))
  await f.source('project', f.c)
  const original = f.ports.readDirectory, controller = new AbortController()
  let release!: () => void, opened!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { opened = resolve })
  f.ports.readDirectory = async (...args) => { if (args[0].id === 'unused') { opened(); await gate }; return original(...args) }
  const pending = f.owner.graph(f.state, {}, { signal: controller.signal })
  await started; controller.abort(new DOMException('Cancel this nested original observation', 'AbortError'))
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  release(); await gate
  expect(await f.owner.content(f.state, 'c')).toMatchObject({ status: 'read', resource: f.resource('project', 'c.note.md') })
  expect(f.reads.filter(item => item.workspaceId === 'unused')).toEqual([])
  expect(await f.store.read()).toEqual(f.state)
})

it('rejects a newly discovered body if its configured Workspace mapping changes during that read', async () => {
  const f = await fixture(), original = f.ports.read
  f.ports.read = async (...args) => { const result = await original(...args); if (args[0].id === 'project') f.workspaces.set('project', { ...f.workspaces.get('project')!, hostId: 'another-host' }); return result }
  const graph = await f.owner.graph(f.state, {})
  expect(graph.completeness).toBe('partial')
  expect(graph.observations.some(item => item.noteId === 'c')).toBe(false)
  expect(graph.references.find(item => item.source.noteId === 'b')).toMatchObject({ resolution: 'unknown' })
  expect(graph.observations.find(item => item.noteId === 'b')).toMatchObject({ status: 'read' })
})

it('serves the nested original through executable graph, inspect/content and scan consumers without catalog registration', async () => {
  const f = await fixture(), server = new AgentMuxControlServer({ socketPath: join(f.root, 'rpc.sock'), coreClients: () => [], notebookStore: f.store, notebookObservation: f.owner })
  cleanups.push(() => server.stop()); await server.start()
  const environment = objectCliEnvironment(f.root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path })
  const run = (args: string[]) => runCompiledObjectCli(args, environment)
  const graph = await run(['notebook', 'graph', '--all'])
  expect(graph.code, graph.stderr).toBe(0)
  expect(JSON.parse(graph.stdout).result.observations.find((item: { noteId: string }) => item.noteId === 'c')).toMatchObject({ fileIdentity: 'confirmed', resource: f.resource('project', 'c.note.md') })
  const inspected = await run(['notebook', 'inspect', '--note', 'c', '--content'])
  expect(inspected.code, inspected.stderr).toBe(0)
  expect(JSON.parse(inspected.stdout).result.content).toMatchObject({ status: 'read', actualNoteId: 'c', resource: f.resource('project', 'c.note.md') })
  const selected = await run(['notebook', 'graph', '--note', 'c'])
  expect(selected.code, selected.stderr).toBe(0)
  expect(JSON.parse(selected.stdout).result.references).toEqual([expect.objectContaining({ source: { noteId: 'b', blockId: 'b-to-c-block' }, resolution: 'resolved' })])
  const scanned = await run(['notebook', 'scan', '--workspace', 'project', '--path', '.', '--query', 'Nested project original'])
  expect(scanned.code, scanned.stderr).toBe(0)
  expect(JSON.parse(scanned.stdout).result.search.hits).toHaveLength(1)
  const limited = await run(['notebook', 'inspect', '--note', 'c', '--content', '--max-bytes', '1'])
  expect(limited.code, limited.stderr).toBe(0)
  expect(JSON.parse(limited.stdout).result.content).toMatchObject({ status: 'unknown', resource: f.resource('project', 'c.note.md') })
  const missing = await run(['notebook', 'inspect', '--note', 'missing-nested-original', '--content'])
  expect(missing.code).not.toBe(0); expect(missing.stdout + missing.stderr).toContain('NOTEBOOK_INPUT_INVALID')
  expect(await f.store.read()).toEqual(f.state)
})
