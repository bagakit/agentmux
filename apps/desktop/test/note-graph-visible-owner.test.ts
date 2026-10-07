import { serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc, parseNotebookGraph, type NotebookGraph } from '@agentmux/core'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { newNoteDocument, readNoteDocument, type NoteDocument } from '@agentmux/client-ui/note/note-document'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { createNotebookObservationServices } from '../src/main/notebook-observation-requests'
import { createPreloadNotebookObservation } from '../src/preload/notebook-observation'
import { createRendererNotebookObservation } from '../src/renderer/src/lib/notebook-observation-api'
import { projectNoteLinks } from '../src/renderer/src/lib/note-graph-references'
import { ObjectCliProbe, objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import type { WorkspaceRecord } from '../src/shared/contracts'

const cleanups: (() => Promise<void>)[] = [], actor = { kind: 'agent' as const, id: 'original-note-reader' }
afterEach(async () => { vi.restoreAllMocks(); for (const clean of cleanups.splice(0).reverse()) await clean() })
const parsed = (raw: string): NoteDocument => { const read = readNoteDocument(raw); if (read.status !== 'valid') throw Error(read.message); return read.note }
const raw = (note: NoteDocument) => serializeNoteDocument(note)
async function fixture() {
  const root = await realpath(await mkdtemp('/private/tmp/amx-visible-')); cleanups.push(() => rm(root, { recursive: true, force: true }))
  const workspace: WorkspaceRecord = { id: 'notes', hostId: 'local', path: root, name: 'Original Notes', kind: 'folder' }
  const files = new WorkspaceFiles(() => ({ kind: 'local', id: 'local' }) as never); cleanups.push(() => files.dispose())
  const store = new AgentMuxNotebookStore(join(root, 'original-catalog.json')), services = createNotebookObservationServices(store, { files, workspace: () => workspace })
  cleanups.push(async () => services.requests.dispose())
  const resource = (path: string) => ({ hostId: 'local', workspaceId: workspace.id, workspacePath: root, path })
  async function change(change: Parameters<typeof store.apply>[0]['change'], operationId = crypto.randomUUID()) {
    return store.apply({ operationId, expectedRevision: (await store.read()).revision, change }, actor)
  }
  async function add(noteId: string, title: string, note = newNoteDocument(title, noteId, noteId + '-block')) {
    await writeFile(join(root, noteId + '.note.md'), raw(note))
    await change({ kind: 'register', noteId, title, resource: resource(noteId + '.note.md') })
  }
  const target = newNoteDocument('Original target', 'target', 'target-block')
  target.content.content!.push({ type: 'heading', attrs: { blockId: 'decision', level: 2 }, content: [{ type: 'text', text: 'Decision' }] })
  const source = newNoteDocument('[[Research]] [[Research #Decision]] [[Research #^target-block]] [[Source #^source-block]]', 'source', 'source-block')
  source.content.content![0]!.content!.push({ type: 'text', text: ' ' }, { type: 'noteLink', attrs: { referenceId: 'original-null-id', text: 'Research #Decision', target: null } }, { type: 'text', text: ' ' },
    { type: 'noteLink', attrs: { referenceId: 'original-bound-id', text: 'Old label', target: { noteId: 'target' } } })
  for (const mode of ['reference', 'embed']) source.content.content!.push({ type: 'blockReference', attrs: { blockId: mode + '-block', referenceId: mode + '-occurrence', mode, target: { noteId: 'target', blockId: 'target-block' } } })
  await add('target', 'Research', target); await add('source', 'Source', source)
  await change({ kind: 'create', notebookId: 'closed-notebook', name: 'Closed sources' }); await change({ kind: 'move', noteId: 'source', notebookId: 'closed-notebook', parentNoteId: null })
  const coreClients = () => [{ hostId: 'local', client: { authorizeRetainedAgentCaller: async () => ({ agentSessionId: actor.id, hostId: 'local', run: { runId: 'retained-original-run' } }) } } as never]
  const desktop = new AgentMuxControlServer({ socketPath: join(root, 'control.sock.desktop'), notebookStore: store, notebookObservation: services.owner, coreClients })
  await desktop.start(); cleanups.push(() => desktop.stop())
  const forwarded: { method: string; caller: unknown }[] = [], publicStore = new AgentMuxNotebookStore(join(root, 'original-catalog.json'))
  const front = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), notebookStore: publicStore, coreClients, forwardControl: async (method, params, context) => {
    forwarded.push({ method, caller: context.caller })
    const original = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktop.path }, ...(context.caller ? { credentials: context.caller } : {}) })
    try { return await original.call(method, params, context.signal ? { signal: context.signal } : {}) } finally { await original.dispose() }
  } })
  await front.start(); cleanups.push(() => front.stop())
  // A broken forwarding mutation must never read or write the user's default Notes.
  const originalRead = AgentMuxNotebookStore.prototype.read, originalApply = AgentMuxNotebookStore.prototype.apply
  vi.spyOn(AgentMuxNotebookStore.prototype, 'read').mockImplementation(function (this: AgentMuxNotebookStore) { if (this !== store && this !== publicStore) throw Error('Unexpected alternate Note catalog'); return originalRead.call(this) })
  vi.spyOn(AgentMuxNotebookStore.prototype, 'apply').mockImplementation(function (this: AgentMuxNotebookStore, ...args) { if (this !== store && this !== publicStore) throw Error('Unexpected alternate Note catalog write'); return originalApply.apply(this, args) })
  const env = objectCliEnvironment(root, { AGENTMUX_AGENT_SESSION_ID: actor.id, AGENTMUX_AGENT_CAPABILITY: 'original-capability' })
  const cli = async (args: string[]) => { const result = await runCompiledObjectCli(args, env); expect(result.code, result.stderr + result.stdout).toBe(0); return JSON.parse(result.stdout).result }
  return { root, workspace, files, store, services, source, target, resource, add, change, desktop, front, env, cli, forwarded }
}

it('default shipping CLI and GUI observe raw/null query targets and closed incoming sources without changing original bytes or occurrences', async () => {
  const f = await fixture(), sourceBytes = await readFile(join(f.root, 'source.note.md'), 'utf8'), targetBytes = await readFile(join(f.root, 'target.note.md'), 'utf8'), read = vi.spyOn(f.files, 'read'), write = vi.spyOn(f.files, 'write')
  expect(f.env.AGENTMUX_RPC_ENDPOINT).toBeUndefined()
  const graph: NotebookGraph = await f.cli(['notebook', 'graph', '--all'])
  expect(graph.completeness).toBe('complete'); expect(graph.references).toHaveLength(8)
  expect(read).toHaveBeenCalledTimes(2); expect(write).not.toHaveBeenCalled()
  const text = graph.references.filter(reference => reference.occurrence.kind === 'text')
  expect(text.map(reference => reference.target)).toEqual([{ kind: 'page', noteId: 'target' }, { kind: 'block', noteId: 'target', blockId: 'decision' }, { kind: 'block', noteId: 'target', blockId: 'target-block' }, { kind: 'block', noteId: 'source', blockId: 'source-block' }])
  expect(text.every(reference => reference.resolution === 'resolved' && reference.query && !('referenceId' in reference.occurrence))).toBe(true)
  const unbound = graph.references.find(reference => reference.occurrence.kind === 'stored' && reference.occurrence.referenceId === 'original-null-id')!
  expect(unbound).toMatchObject({ target: { kind: 'block', noteId: 'target', blockId: 'decision' }, query: 'Research #Decision', resolution: 'resolved' })
  expect(graph.references.find(reference => reference.occurrence.kind === 'stored' && reference.occurrence.referenceId === 'original-bound-id')).not.toHaveProperty('query')
  class Sender extends EventEmitter { isDestroyed() { return false } }
  const sender = new Sender(), api = createRendererNotebookObservation(createPreloadNotebookObservation(async (channel, input) => { if (channel === 'notebook:graph') return f.services.requests.graph(sender, input); throw Error('Unexpected transport') }))
  const snapshot = await api.graph({})
  expect(snapshot.graph).toEqual(graph)
  expect(projectNoteLinks(snapshot, 'target').incoming).toHaveLength(7)
  const incoming = await f.cli(['notebook', 'graph', '--note', 'target']); expect(incoming.references).toHaveLength(7)
  expect(incoming.references.every((reference: NotebookGraph['references'][number]) => reference.source.noteId === 'source')).toBe(true)
  const inspected = await f.cli(['notebook', 'inspect', '--note', 'source', '--content']); expect(inspected.content.content).toBe(sourceBytes)
  expect((await f.cli(['notebook', 'resolve', '--link', '[[Research #Decision]]'])).result.target).toEqual({ noteId: 'target', blockId: 'decision' })
  expect((await f.cli(['notebook', 'ls'])).state.pages.source.resource).toEqual(f.resource('source.note.md'))
  expect(f.forwarded.map(call => call.method)).toEqual(['notebook.graph', 'notebook.graph', 'notebook.inspect', 'notebook.resolve'])
  expect(f.forwarded.every(call => (call.caller as { agentSessionId: string }).agentSessionId === actor.id)).toBe(true)
  expect(await readFile(join(f.root, 'source.note.md'), 'utf8')).toBe(sourceBytes); expect(await readFile(join(f.root, 'target.note.md'), 'utf8')).toBe(targetBytes)
  const skill = await runCompiledObjectCli(['notebook', '--skill'], f.env); expect(skill.code).toBe(0); for (const term of ['without being saved', 'one observation', 'retain query and their original occurrence']) expect(skill.stdout).toContain(term)
  const help = await runCompiledObjectCli(['notebook', 'graph', '--help'], f.env); expect(help.code).toBe(0); expect(help.stdout).toContain('never a file binding')
})

it('uses exactly the graph original observations even if the target file changes after its first read', async () => {
  const f = await fixture(), readOriginal = f.files.read.bind(f.files), sourceBytes = await readFile(join(f.root, 'source.note.md'), 'utf8')
  const read = vi.spyOn(f.files, 'read').mockImplementation(async (...args) => { const observed = await readOriginal(...args); if (args[1] === 'target.note.md') { const changed = structuredClone(f.target); changed.content.content![1]!.content![0]!.text = 'Later heading'; await writeFile(join(f.root, 'target.note.md'), raw(changed)) } return observed })
  const graph: NotebookGraph = await f.cli(['notebook', 'graph', '--all'])
  expect(read).toHaveBeenCalledTimes(2)
  expect(graph.references.filter(reference => reference.query === 'Research #Decision').every(reference => reference.resolution === 'resolved' && reference.target.kind === 'block' && reference.target.blockId === 'decision')).toBe(true)
  expect(graph.references.filter(reference => reference.query === 'Research #Decision')).toHaveLength(2)
  expect(await readFile(join(f.root, 'source.note.md'), 'utf8')).toBe(sourceBytes)
})

it('never guesses duplicate titles/headings/identities, missing originals or unknown mappings', async () => {
  const f = await fixture()
  await f.add('same-title', 'Research')
  let graph: NotebookGraph = await f.cli(['notebook', 'graph', '--all'])
  expect(graph.references.filter(reference => reference.query?.startsWith('Research')).every(reference => reference.resolution === 'ambiguous' && reference.target.kind === 'unbound')).toBe(true)
  await f.change({ kind: 'rename-page', noteId: 'same-title', title: 'Another page' })
  f.target.content.content!.push({ type: 'heading', attrs: { blockId: 'another-decision', level: 2 }, content: [{ type: 'text', text: 'Decision' }] })
  await writeFile(join(f.root, 'target.note.md'), raw(f.target))
  graph = await f.cli(['notebook', 'graph', '--all'])
  expect(graph.references.filter(reference => reference.query === 'Research #Decision').every(reference => reference.resolution === 'ambiguous' && reference.target.kind === 'unbound')).toBe(true)
  f.target.content.content!.pop(); f.target.content.content![0]!.attrs!.blockId = 'Decision'; await writeFile(join(f.root, 'target.note.md'), raw(f.target))
  graph = await f.cli(['notebook', 'graph', '--all'])
  expect(graph.references.filter(reference => reference.query === 'Research #Decision').every(reference => reference.resolution === 'ambiguous' && reference.target.kind === 'unbound')).toBe(true)
  await f.add('duplicate', 'Other identity', newNoteDocument('Duplicate body', 'target', 'duplicate-block'))
  graph = await f.cli(['notebook', 'graph', '--all']); expect(graph.duplicateNoteIds).toEqual(['target'])
  expect(graph.references.find(reference => reference.query === 'Research')!.resolution).toBe('ambiguous')
  await rm(join(f.root, 'duplicate.note.md')); await rm(join(f.root, 'target.note.md'))
  graph = await f.cli(['notebook', 'graph', '--all']); expect(graph.references.find(reference => reference.query === 'Research')!).toMatchObject({ resolution: 'missing', target: { kind: 'unbound', text: 'Research' } })
  await writeFile(join(f.root, 'target.note.md'), raw(newNoteDocument('Wrong identity', 'someone-else', 'not-target')))
  graph = await f.cli(['notebook', 'graph', '--all']); expect(graph.references.find(reference => reference.query === 'Research')!.resolution).toBe('unknown')
  await f.change({ kind: 'relocate', noteId: 'target', resource: { ...f.resource('target.note.md'), hostId: 'unavailable-host' } })
  graph = await f.cli(['notebook', 'graph', '--all']); expect(graph.references.find(reference => reference.query === 'Research')!.resolution).toBe('unknown')
  expect(graph.completeness).toBe('partial'); expect(parsed(await readFile(join(f.root, 'source.note.md'), 'utf8')).content.content![0]!.content!.find(node => node.attrs?.referenceId === 'original-null-id')!.attrs!.target).toBeNull()
})

it('retains original ID bindings when a page is renamed while query observations change without editing the source', async () => {
  const f = await fixture(), before = await readFile(join(f.root, 'source.note.md'), 'utf8')
  await f.change({ kind: 'rename-page', noteId: 'target', title: 'Renamed page' })
  const graph: NotebookGraph = await f.cli(['notebook', 'graph', '--all'])
  expect(graph.references.find(reference => reference.occurrence.kind === 'stored' && reference.occurrence.referenceId === 'original-bound-id')).toMatchObject({ target: { kind: 'page', noteId: 'target' }, resolution: 'resolved' })
  expect(graph.references.find(reference => reference.query === 'Research')).toMatchObject({ target: { kind: 'unbound', text: 'Research' }, resolution: 'missing' })
  expect(await readFile(join(f.root, 'source.note.md'), 'utf8')).toBe(before)
})

it('rejects malformed query/occurrence replies through the actual public CLI codec', async () => {
  const f = await fixture(), graph: NotebookGraph = await f.cli(['notebook', 'graph', '--all']), index = graph.references.findIndex(reference => reference.occurrence.kind === 'text')
  const missingQuery = structuredClone(graph); delete missingQuery.references[index]!.query
  const wrongKind = structuredClone(graph); wrongKind.references[index]!.query = 'Research #Decision'
  const wrongRevision = structuredClone(graph); (wrongRevision.references[index]!.occurrence as { revision: string }).revision = 'other-revision'
  const wrongUnbound = structuredClone(graph); wrongUnbound.references[index]!.target = { kind: 'unbound', text: 'Another query' }; wrongUnbound.references[index]!.resolution = 'unknown'; wrongUnbound.completeness = 'partial'
  for (const bad of [missingQuery, wrongKind, wrongRevision, wrongUnbound]) expect(() => parseNotebookGraph(bad, {})).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  const probe = new ObjectCliProbe(() => missingQuery); await probe.start()
  try { const result = await runCompiledObjectCli(['notebook', 'graph', '--all'], probe.environment()); expect(result.code).not.toBe(0); expect(result.stderr + result.stdout).toContain('CONTROL_PROTOCOL_ERROR') } finally { await probe.stop() }
})

it('keeps durable self-follow on the original Core catalog with its exact caller and operation ID', async () => {
  const f = await fixture(), state = await f.store.read(), operationId = 'original-follow-operation'
  const followed = await f.cli(['notebook', 'apply', '--revision', String(state.revision), '--operation-id', operationId, '--change-json', JSON.stringify({ kind: 'follow', noteId: 'source' })])
  expect(followed.state.pages.source.followers).toEqual([{ actor, followedAt: expect.any(Number) }])
  const inspected = await f.cli(['notebook', 'inspect', '--operation-id', operationId])
  expect(inspected.recordedOperation).toEqual(followed.state.operations[operationId]); expect(inspected.recordedOperation.actor).toEqual(actor)
  expect((await f.store.read()).pages.source!.followers).toEqual(followed.state.pages.source.followers)
  expect(f.forwarded).toEqual([])
})

it('cancels the exact forwarded graph reader and leaves original files available', async () => {
  const f = await fixture(); let entering!: (signal: AbortSignal) => void; const entered = new Promise<AbortSignal>(resolve => { entering = resolve })
  const originalRead = f.files.read.bind(f.files)
  vi.spyOn(f.files, 'read').mockImplementation(async (...args) => { const signal = args[2]?.signal; if (signal) { entering(signal); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) } return originalRead(...args) })
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.front.path }, credentials: { agentSessionId: actor.id, capability: 'original-capability' } }), controller = new AbortController()
  try {
    const pending = client.call('notebook.graph', {}, { signal: controller.signal }); void pending.catch(() => {})
    const signal = await entered; controller.abort(); await expect(pending).rejects.toBeDefined(); await vi.waitFor(() => expect(signal.aborted).toBe(true))
    expect(await readFile(join(f.root, 'source.note.md'), 'utf8')).toBe(raw(f.source))
  } finally { await client.dispose() }
})

it('keeps the Core directory and self-follow available when the original Desktop reader is offline', async () => {
  const f = await fixture(); await f.desktop.stop()
  for (const command of [['notebook', 'graph', '--all'], ['notebook', 'resolve', '--link', '[[Research]]'], ['notebook', 'inspect', '--note', 'source', '--content']]) {
    const result = await runCompiledObjectCli(command, f.env); expect(result.code).not.toBe(0); expect(result.stderr + result.stdout).toContain('CONTROL_UNAVAILABLE'); expect(result.stderr + result.stdout).not.toContain('Unexpected alternate Note catalog')
  }
  const listed = await f.cli(['notebook', 'ls']); expect(listed.state.pages.source.resource).toEqual(f.resource('source.note.md'))
  expect((await f.cli(['notebook', 'inspect', '--note', 'source'])).pages[0].noteId).toBe('source')
  const followed = await f.cli(['notebook', 'apply', '--revision', String(listed.state.revision), '--operation-id', 'offline-follow', '--change-json', JSON.stringify({ kind: 'follow', noteId: 'source' })])
  expect(followed.state.pages.source.followers).toEqual([{ actor, followedAt: expect.any(Number) }])
  expect(await readFile(join(f.root, 'source.note.md'), 'utf8')).toBe(raw(f.source))
})
