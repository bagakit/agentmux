import { serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, parseNotebookGraph, type NotebookGraph } from '@agentmux/core'
import { parseNotebookResolveResult, scanNoteWikiLinks, type NotebookResolveParams } from '@agentmux/core/note-links'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { prepareNoteWikiLinks } from '@agentmux/client-ui/note/note-wikilinks'
import { noteKnowledge } from '@agentmux/client-ui/note/note-knowledge'
import { newNoteDocument, readNoteDocument, type NoteDocument } from '@agentmux/client-ui/note/note-document'
import { FileReadOwner } from '../src/main/file-read-owner'
import { NoteFileWriter } from '../src/main/note-file-writer'
import { createNotebookObservationServices } from '../src/main/notebook-observation-requests'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { createPreloadNotebookObservation } from '../src/preload/notebook-observation'
import { createRendererNotebookObservation } from '../src/renderer/src/lib/notebook-observation-api'
import { ObjectCliProbe, objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import type { WorkspaceRecord } from '../src/shared/contracts'

const roots: string[] = [], filesOwners: WorkspaceFiles[] = [], servers: AgentMuxControlServer[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const server of servers.splice(0)) await server.stop(); for (const files of filesOwners.splice(0)) await files.dispose(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const actor = { kind: 'agent' as const, id: 'original-writer' }, json = (note: NoteDocument) => serializeNoteDocument(note)
const parsed = (raw: string): NoteDocument => { const read = readNoteDocument(raw); if (read.status !== 'valid') throw Error(read.message); return read.note }
function nodes(note: NoteDocument, type: string) { const found: NonNullable<NoteDocument['content']['content']> = []; function visit(node: NoteDocument['content']) { if (node.type === type) found.push(node); node.content?.forEach(visit) } visit(note.content); return found }
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-wiki-'))); roots.push(root)
  const workspace: WorkspaceRecord = { id: 'notes', hostId: 'local', path: root, name: 'Notes', kind: 'folder' }
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never); filesOwners.push(files)
  const store = new AgentMuxNotebookStore(join(root, 'catalog.json')), services = createNotebookObservationServices(store, { files, workspace: () => workspace })
  const writer = new NoteFileWriter(files, { state: () => store.read(), owner: services.owner }, store)
  const resource = (path: string) => ({ hostId: 'local', workspaceId: workspace.id, workspacePath: root, path })
  async function add(noteId: string, title: string, note = newNoteDocument(title, noteId, noteId + '-block')) {
    const path = noteId + '.note.md'; await writeFile(join(root, path), json(note))
    await store.apply({ operationId: 'register-' + noteId, expectedRevision: (await store.read()).revision, change: { kind: 'register', noteId, title, resource: resource(path) } }, actor)
  }
  const target = newNoteDocument('Target body', 'target', 'target-block')
  target.content.content!.push({ type: 'heading', attrs: { blockId: 'heading-stable', level: 2 }, content: [{ type: 'text', text: 'Decision' }] })
  await add('target', 'Research', target); await add('source', 'Source', newNoteDocument('Original source', 'source', 'source-block'))
  const port = new FileReadOwner({ catalog: async () => ({ zones: [{ zoneId: 'original-zone', workspaceId: workspace.id, kind: 'directory', hostId: 'local', directoryPath: root }], bindings: [] }) as never,
    workspace: () => workspace, files: { read: writer.read.bind(writer), listFiles: files.listFiles.bind(files), write: writer.write.bind(writer) } })
  const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), files: port, notebookStore: store, notebookObservation: services.owner,
    coreClients: () => [{ hostId: 'local', client: { authorizeRetainedAgentCaller: async () => ({ agentSessionId: actor.id, hostId: 'local', run: { runId: 'original-run' } }) } } as never] })
  servers.push(server); await server.start()
  const env = objectCliEnvironment(root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path, AGENTMUX_AGENT_SESSION_ID: actor.id, AGENTMUX_AGENT_CAPABILITY: 'original-capability' })
  const cli = async (args: string[], stdin = '') => { const result = await runCompiledObjectCli(args, env, stdin); expect(result.code, result.stderr + result.stdout).toBe(0); return JSON.parse(result.stdout).result }
  const read = () => files.read(workspace, 'source.note.md')
  async function save(text: string) { const before = await read(); if (before.status !== 'read') throw Error('Original source must read'); return writer.write(workspace, { path: 'source.note.md', content: json(newNoteDocument(text, 'source', 'source-block')), expectedRevision: before.document.revision }, { actor }) }
  return { root, workspace, files, store, services, writer, port, cli, env, add, target, resource, save }
}

it('canonicalizes actual CLI Files saves, reads the same inline page/block targets through inspect/graph/resolve, and preserves authors', async () => {
  const f = await fixture()
  const before = await f.cli(['file', 'read', '--zone', 'original-zone', '--path', 'source.note.md', '--host', 'local', '--workspace', 'notes', '--workspace-path', f.root])
  const candidate = newNoteDocument('See [[Research]], [[Research #Decision]], [[Research #^target-block]] and [[Unknown page]].', 'source', 'source-block')
  const receipt = await f.cli(['file', 'write', '--zone', 'original-zone', '--path', 'source.note.md', '--resource', JSON.stringify(before.resource), '--expected-revision', before.result.document.revision], json(candidate))
  expect(receipt.result.status).toBe('written'); const saved = parsed(receipt.result.content), links = nodes(saved, 'noteLink')
  expect(links).toHaveLength(4); expect(new Set(links.map(link => link.attrs!.referenceId)).size).toBe(4)
  expect(links.map(link => link.attrs!.target)).toEqual([{ noteId: 'target' }, { noteId: 'target', blockId: 'heading-stable' }, { noteId: 'target', blockId: 'target-block' }, null])
  expect(receipt.result.noteProvenance.blocks['source-block'].lastEdited.actor).toEqual(actor)
  const inspected = await f.cli(['notebook', 'inspect', '--note', 'source', '--content'])
  expect(inspected.content.content).toBe(receipt.result.content); expect(inspected.content.revision).toBe(receipt.result.revision)
  const graph: NotebookGraph = await f.cli(['notebook', 'graph', '--note', 'target'])
  expect(graph.references).toHaveLength(4); expect(graph.completeness).toBe('partial')
  expect(graph.references[0]).toMatchObject({ source: { noteId: 'source', blockId: 'source-block' }, occurrence: { kind: 'stored', referenceId: links[0]!.attrs!.referenceId }, mode: 'link', target: { kind: 'page', noteId: 'target' }, resolution: 'resolved' })
  expect(graph.references[1]!.target).toEqual({ kind: 'block', noteId: 'target', blockId: 'heading-stable' }); expect(graph.references[3]!.target).toEqual({ kind: 'unbound', text: 'Unknown page' })
  expect(await f.cli(['notebook', 'resolve', '--link', '[[Research #Decision]]'])).toMatchObject({ result: { status: 'resolved', target: { noteId: 'target', blockId: 'heading-stable' } } })
  const skill = await runCompiledObjectCli(['--skill'], f.env); expect(skill.code).toBe(0); for (const word of ['note:targetNote#targetBlock', 'notebook resolve', 'saved unbound occurrence', 'occurrence', 'canonical content']) expect(skill.stdout).toContain(word)
})

it('uses no body IO for page search or ambiguous names, never equates a truncated result to uniqueness, and confirms one chosen original', async () => {
  const f = await fixture(); await f.add('other', 'Research'); const read = vi.spyOn(f.files, 'read')
  const search = await f.cli(['notebook', 'resolve', '--query', 'research', '--limit', '1'])
  expect(search).toMatchObject({ mode: 'search', total: 2, truncated: true }); expect(search.candidates).toHaveLength(1); expect(read).not.toHaveBeenCalled()
  const ambiguous = await f.cli(['notebook', 'resolve', '--link', '[[Research]]']); expect(ambiguous.result.status).toBe('ambiguous'); expect(read).not.toHaveBeenCalled()
  const selected = await f.cli(['notebook', 'resolve', '--link', '[[Research]]', '--note', 'target']); expect(selected.result.target).toEqual({ noteId: 'target' }); expect(read).toHaveBeenCalledTimes(1)
  expect((await f.save('[[Research]]')).status).toBe('written'); expect(nodes(parsed(await readFile(join(f.root, 'source.note.md'), 'utf8')), 'noteLink')[0]!.attrs!.target).toBeNull()
})

it('reuses each original candidate once per save batch, including page, heading and exact block links', async () => {
  const f = await fixture(), read = vi.spyOn(f.files, 'read')
  const receipt = await f.save('[[Research]] [[Research #Decision]] [[Research #target-block]] [[Research]]')
  expect(receipt.status).toBe('written'); expect(read.mock.calls.filter(([, path]) => path === 'target.note.md')).toHaveLength(1)
  const links = nodes(parsed(await readFile(join(f.root, 'source.note.md'), 'utf8')), 'noteLink'); expect(links).toHaveLength(4); expect(links.every(link => link.attrs!.target)).toBe(true)
})

it('keeps stable bound IDs through title and heading changes instead of retargeting an old label to a new page', async () => {
  const f = await fixture(); await f.save('[[Research #Decision]]')
  const source = await f.files.read(f.workspace, 'source.note.md'); if (source.status !== 'read') throw Error('Missing original source')
  const original = nodes(parsed(source.document.content), 'noteLink')[0]!
  await f.store.apply({ expectedRevision: (await f.store.read()).revision, operationId: 'rename', change: { kind: 'rename-page', noteId: 'target', title: 'Renamed research' } }, actor)
  f.target.content.content![1]!.content![0]!.text = 'Renamed decision'; await writeFile(join(f.root, 'target.note.md'), json(f.target)); await f.add('new-page', 'Research')
  const receipt = await f.writer.write(f.workspace, { path: 'source.note.md', content: source.document.content, expectedRevision: source.document.revision }, { actor })
  expect(receipt.status).toBe('written'); expect(nodes(parsed(await readFile(join(f.root, 'source.note.md'), 'utf8')), 'noteLink')[0]).toEqual(original)
  const graph = await f.services.owner.graph(await f.store.read(), { noteId: 'target' }); expect(graph.references[0]).toMatchObject({ target: { kind: 'block', noteId: 'target', blockId: 'heading-stable' }, resolution: 'resolved' })
  f.target.content.content!.pop(); await writeFile(join(f.root, 'target.note.md'), json(f.target))
  expect((await f.services.owner.graph(await f.store.read(), {})).references[0]!.resolution).toBe('missing')
})

it('preserves a cross-mark token starting format through the actual writer without inheriting its unrelated bold prefix', async () => {
  const f = await fixture(), source = await f.files.read(f.workspace, 'source.note.md'); if (source.status !== 'read') throw Error('Original source unavailable')
  const note = newNoteDocument('', 'source', 'source-block')
  note.content.content![0]!.content = [{ type: 'text', text: 'Bold prefix ', marks: [{ type: 'bold' }] }, { type: 'text', text: '[[Re' },
    { type: 'text', text: 'search]] italic tail', marks: [{ type: 'italic' }] }, { type: 'text', text: ' [[Research]]', marks: [{ type: 'bold' }] }]
  const written = await f.writer.write(f.workspace, { path: 'source.note.md', content: json(note), expectedRevision: source.document.revision }, { actor })
  expect(written.status).toBe('written')
  const saved = parsed(await readFile(join(f.root, 'source.note.md'), 'utf8')), links = nodes(saved, 'noteLink')
  expect(links).toHaveLength(2); expect(links[0]!.marks).toBeUndefined(); expect(links[1]!.marks).toEqual([{ type: 'bold' }])
  expect(saved.content.content![0]!.content![0]).toMatchObject({ text: 'Bold prefix ', marks: [{ type: 'bold' }] })
  expect(saved.content.content![0]!.content!.some(node => node.text === ' italic tail' && node.marks?.[0]?.type === 'italic')).toBe(true)
})

it('preserves missing or unavailable target queries as savable unbound occurrences, never using a mismatched body', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'target.note.md'), json(newNoteDocument('Other identity', 'wrong-note', 'wrong-block')))
  expect((await f.save('[[Research]]')).status).toBe('written')
  let graph = await f.services.owner.graph(await f.store.read(), {}); expect(graph.references[0]!.target).toEqual({ kind: 'unbound', text: 'Research' }); expect(graph.observations[0]!.status).toBe('identity-mismatch')
  await rm(join(f.root, 'target.note.md')); expect((await f.save('[[Research #Decision]]')).status).toBe('written')
  graph = await f.services.owner.graph(await f.store.read(), { noteId: 'target' }); expect(graph.references[0]!.resolution).toBe('missing'); expect(graph.completeness).toBe('partial')
  expect((await f.services.owner.resolve(await f.store.read(), { mode: 'resolve', text: 'Research', maxBytes: 1 })).mode).toBe('resolve')
  expect(parsed(await readFile(join(f.root, 'source.note.md'), 'utf8')).noteId).toBe('source')
})

it('indexes old raw tokens only as revision-bound text evidence with the exact nearest block, preserving code, escapes and original bytes', async () => {
  const f = await fixture(), note = newNoteDocument('x [[Research]]', 'source', 'inner-block')
  note.content.content = [{ type: 'blockquote', attrs: { blockId: 'outer-block' }, content: note.content.content! },
    { type: 'codeBlock', attrs: { blockId: 'code' }, content: [{ type: 'text', text: '[[Research]]' }] },
    { type: 'paragraph', attrs: { blockId: 'literals' }, content: [{ type: 'text', text: '[[Research]]', marks: [{ type: 'code' }] }, { type: 'text', text: ' \\[[Research]]' }] }]
  const raw = json(note); await writeFile(join(f.root, 'source.note.md'), raw)
  const graph = await f.services.owner.graph(await f.store.read(), { noteId: 'target' }), source = graph.observations.find(o => o.noteId === 'source')!
  expect(graph.references).toHaveLength(1); expect(graph.references[0]).toMatchObject({ source: { noteId: 'source', blockId: 'inner-block' }, target: { kind: 'page', noteId: 'target' }, query: 'Research', occurrence: { kind: 'text', revision: source.revision, from: 2, to: 14 }, resolution: 'resolved' })
  expect(graph.references[0]!.occurrence).not.toHaveProperty('referenceId'); expect(await readFile(join(f.root, 'source.note.md'), 'utf8')).toBe(raw)
  expect(await f.services.owner.graph(await f.store.read(), { noteId: 'target' })).toEqual(graph)
  const bad = structuredClone(graph); (bad.references[0]!.occurrence as { revision: string }).revision = 'another-revision'; expect(() => parseNotebookGraph(bad, { noteId: 'target' })).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  let allocated = 0; const prepared = prepareNoteWikiLinks(note, () => 'persistent-' + ++allocated)
  expect(allocated).toBe(1); expect(nodes(prepared.note, 'noteLink')).toHaveLength(1); expect(JSON.stringify(prepared.note)).toContain('[[Research]]')
  const knowledge = noteKnowledge([{ location: { workspaceId: 'notes', path: 'source.note.md' }, document: { path: 'source.note.md', revision: 'raw-rev', content: raw } }])
  expect(knowledge.references[0]!.blockId).toBe('inner-block')
})

it('treats duplicate headings and heading-versus-ID collisions as ambiguous, and rejects a forged different-heading RPC receipt', async () => {
  const f = await fixture(); f.target.content.content!.push({ type: 'heading', attrs: { blockId: 'second-heading' }, content: [{ type: 'text', text: 'Decision' }] }); await writeFile(join(f.root, 'target.note.md'), json(f.target))
  const params: NotebookResolveParams = { mode: 'resolve', text: 'Research #Decision' }, ambiguous = await f.services.owner.resolve(await f.store.read(), params)
  expect(ambiguous).toMatchObject({ result: { status: 'ambiguous', stage: 'fragment' } })
  if (ambiguous.mode !== 'resolve') throw Error('Expected original query result')
  const hiddenDuplicate = { ...ambiguous, blocks: ambiguous.blocks.filter(block => block.blockId !== 'second-heading'), result: { status: 'resolved', target: { noteId: 'target', blockId: 'heading-stable' } } }
  expect(() => parseNotebookResolveResult(hiddenDuplicate, params)).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  const hiding = new ObjectCliProbe(() => hiddenDuplicate); await hiding.start()
  try { const result = await runCompiledObjectCli(['notebook', 'resolve', '--link', '[[Research #Decision]]'], hiding.environment({ AGENTMUX_RPC_ENDPOINT: 'unix:' + hiding.socketPath })); expect(result.code).not.toBe(0); expect(result.stdout + result.stderr).toContain('CONTROL_PROTOCOL_ERROR') } finally { await hiding.stop() }
  expect(await f.services.owner.resolve(await f.store.read(), { ...params, select: { noteId: 'target', blockId: 'second-heading' } })).toMatchObject({ result: { target: { noteId: 'target', blockId: 'second-heading' } } })
  f.target.content.content!.pop(); await writeFile(join(f.root, 'target.note.md'), json(f.target))
  const good = await f.services.owner.resolve(await f.store.read(), params); if (good.mode !== 'resolve' || good.result.status !== 'resolved') throw Error('Original heading not resolved')
  const bad = { ...good, result: { status: 'resolved', target: { noteId: 'target', blockId: 'target-block' } } }
  expect(() => parseNotebookResolveResult(bad, params)).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  const probe = new ObjectCliProbe(() => bad); await probe.start()
  try { const result = await runCompiledObjectCli(['notebook', 'resolve', '--link', '[[Research #Decision]]'], probe.environment({ AGENTMUX_RPC_ENDPOINT: 'unix:' + probe.socketPath })); expect(result.code).not.toBe(0); expect(result.stdout + result.stderr).toContain('CONTROL_PROTOCOL_ERROR') } finally { await probe.stop() }
  const collision = newNoteDocument('ID collision', 'target', 'Decision'); collision.content.content!.push(f.target.content.content![1]!); await writeFile(join(f.root, 'target.note.md'), json(collision))
  expect(await f.services.owner.resolve(await f.store.read(), params)).toMatchObject({ result: { status: 'ambiguous' } })
  expect(scanNoteWikiLinks('[[Research #^Decision]]')[0]!.query.fragment!.kind).toBe('block')
})

it('uses the actual Renderer/preload/Main resolver transport and cancels only its exact pending original reader', async () => {
  const f = await fixture(); let entered!: (signal: AbortSignal) => void; const reading = new Promise<AbortSignal>(accept => { entered = accept })
  const services = createNotebookObservationServices(f.store, { workspace: () => f.workspace, files: { read: async (workspace, path, options) => {
    const signal = options?.signal
    if (signal) { entered(signal); await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }
    return f.files.read(workspace, path, options)
  } } })
  class Sender extends EventEmitter { isDestroyed() { return false } }
  const sender = new Sender(), calls: string[] = []
  const api = createRendererNotebookObservation(createPreloadNotebookObservation(async (channel, input) => {
    calls.push(channel)
    if (channel === 'notebook:resolve') return services.requests.resolve(sender, structuredClone(input))
    if (channel === 'notebook:cancelObservation') return services.requests.cancel(sender, input)
    throw Error('Unexpected transport')
  }))
  const controller = new AbortController(), reason = new Error('Picker hidden'), pending = api.resolve({ mode: 'resolve', text: 'Research' }, { signal: controller.signal }); void pending.catch(() => {})
  const original = await reading
  try {
    services.requests.cancel(new Sender(), 'same-looking-request'); expect(original.aborted).toBe(false)
    controller.abort(reason); expect(original.aborted).toBe(true); await expect(pending).rejects.toBe(reason)
    expect(calls).toEqual(['notebook:resolve', 'notebook:cancelObservation']); expect(sender.listenerCount('destroyed')).toBe(0)
    expect(await readFile(join(f.root, 'target.note.md'), 'utf8')).toBe(json(f.target))
  } finally { services.requests.dispose(); await pending.catch(() => {}) }
})

it('resolves the complete visible heading and block excerpt including inline atom text through the original owner and CLI', async () => {
  const f = await fixture()
  f.target.content.content!.push({ type: 'heading', attrs: { blockId: 'linked-heading', level: 2 }, content: [
    { type: 'text', text: 'Before ' }, { type: 'noteLink', attrs: { referenceId: 'heading-label-link', text: 'Source', target: { noteId: 'source' } } }, { type: 'text', text: ' after' }
  ] })
  await writeFile(join(f.root, 'target.note.md'), json(f.target))
  const result = await f.cli(['notebook', 'resolve', '--link', '[[Research #Before \\[\\[Source\\]\\] after]]'])
  expect(result.result).toEqual({ status: 'resolved', target: { noteId: 'target', blockId: 'linked-heading' } })
  expect(result.blocks.find((block: { blockId: string }) => block.blockId === 'linked-heading').text).toBe('Before [[Source]] after')
})
