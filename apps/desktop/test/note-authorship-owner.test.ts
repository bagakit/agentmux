import { fixtureEpoch as _liveTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { NoteFileWriter } from '../src/main/note-file-writer'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { FileReadOwner } from '../src/main/file-read-owner'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { newNoteDocument, readNoteDocument, type NoteDocument } from '../src/shared/note-document'
import { attributeNoteBlocks } from '@agentmux/client-ui/note/note-provenance'
import type { WorkspaceRecord } from '../src/shared/contracts'
import type { FileReadParams } from '@agentmux/core'

const roots: string[] = [], owners: WorkspaceFiles[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(owners.splice(0).map(owner => owner.dispose())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const actor = { kind: 'agent' as const, id: 'original-agent-session' }, human = { kind: 'user' as const, id: 'local-person' }
const raw = (note: NoteDocument) => JSON.stringify(note, null, 2) + '\n'
const provenance = (note: NoteDocument, index = 0) => note.content.content![index]!.attrs!.provenance
const parsed = (content: string) => { const result = readNoteDocument(content); expect(result.status).toBe('valid'); if (result.status !== 'valid') throw Error(result.message); return result.note }
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'note-authorship-'))); roots.push(root)
  const workspace: WorkspaceRecord = { id: 'original-workspace', hostId: 'local', name: 'Original', kind: 'folder', path: root }
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never); owners.push(files)
  return { workspace, files, writer: new NoteFileWriter(files), path: 'original.note.json' }
}

it('attributes real create/edit by stable block identity and preserves authors of untouched or reordered blocks', async () => {
  const { workspace, files, writer, path } = await fixture()
  const original = newNoteDocument('First finding', 'original-note', 'first')
  original.content.content!.push({ type: 'paragraph', attrs: { blockId: 'second' }, content: [{ type: 'text', text: 'Keep second finding' }] })
  const created = await writer.write(workspace, { path, content: raw(original), expectedRevision: null }, { actor })
  expect(created).toMatchObject({ status: 'written', noteAttribution: { status: 'recorded' } })
  if (created.status !== 'written') throw Error('Creation must publish')
  const saved = parsed(created.content!), first = provenance(saved), second = provenance(saved, 1)
  expect(first).toMatchObject({ created: { actor }, lastEdited: { actor } })
  const next = structuredClone(saved)
  next.content.content![0]!.content![0]!.text = 'Corrected finding'
  next.content.content!.reverse()
  next.content.content![0]!.attrs!.provenance = { created: { actor: { ...actor, id: 'forged-agent' }, at: _liveTailFixtureEpoch(0, 0, 1) }, lastEdited: null }
  const changed = await writer.write(workspace, { path, content: raw(next), expectedRevision: created.revision }, { actor: human })
  expect(changed.status).toBe('written'); if (changed.status !== 'written') throw Error('Edit must publish')
  const disk = parsed(await readFile(join(workspace.path, path), 'utf8'))
  expect(provenance(disk)).toEqual(second)
  expect(provenance(disk, 1)).toMatchObject({ created: first.created, lastEdited: { actor: human } })
  expect(disk.noteId).toBe(original.noteId)
  expect(disk.content.content!.map(block => block.attrs!.blockId)).toEqual(['second', 'first'])
  expect(await files.read(workspace, path)).toMatchObject({ status: 'read', document: { content: changed.content, revision: changed.revision } })
  const conflict = await writer.write(workspace, { path, content: raw(original), expectedRevision: created.revision }, { actor })
  expect(conflict.status).toBe('conflict'); expect(parsed(await readFile(join(workspace.path, path), 'utf8'))).toEqual(disk)
})

it('keeps old unknown creation unknown and does not reattribute parent blocks for a nested text edit', () => {
  const old = newNoteDocument('Original', 'note', 'paragraph')
  old.content.content = [{ type: 'blockquote', attrs: { blockId: 'parent' }, content: old.content.content }]
  const changed = structuredClone(old); changed.content.content![0]!.content![0]!.content![0]!.text = 'Edited'
  const attributed = attributeNoteBlocks(old, changed, actor, _liveTailFixtureEpoch(0, 0, 100))
  expect(provenance(attributed)).toBeNull()
  expect(attributed.content.content![0]!.content![0]!.attrs!.provenance).toEqual({ created: null, lastEdited: { actor, at: _liveTailFixtureEpoch(0, 0, 100) } })
})
it('does not treat installed editor schema defaults as another edit to an unchanged block', async () => {
  const { workspace, files, writer, path } = await fixture()
  const original = newNoteDocument('Body', 'original-note', 'body')
  original.content.content!.unshift({ type: 'heading', attrs: { blockId: 'heading' }, content: [{ type: 'text', text: 'Original heading' }] })
  const attributed = attributeNoteBlocks(null, original, actor, _liveTailFixtureEpoch(0, 0, 100))
  await writeFile(join(workspace.path, path), raw(attributed))
  const observed = await files.read(workspace, path); if (observed.status !== 'read') throw Error('Baseline must read')
  const candidate = structuredClone(attributed)
  candidate.content.content![0]!.attrs!.level = 1
  candidate.content.content![1]!.content![0]!.text = 'New body'
  const result = await writer.write(workspace, { path, content: raw(candidate), expectedRevision: observed.document.revision }, { actor: human })
  expect(result.status).toBe('written')
  const saved = parsed(await readFile(join(workspace.path, path), 'utf8'))
  expect(provenance(saved)).toEqual(provenance(attributed))
  expect(provenance(saved, 1).lastEdited.actor).toEqual(human)
})

it.each(['unreadable', 'invalid-baseline', 'changed-identity', 'unknown-actor'])('retains legal saves while removing submitted agent claims on an unconfirmed attribution path: %s', async mode => {
  const { workspace, files, writer, path } = await fixture()
  const old = newNoteDocument('Old source', 'original-note', 'first')
  await writeFile(join(workspace.path, path), mode === 'invalid-baseline' ? '{original source needs repair' : raw(old))
  const observed = await files.read(workspace, path); if (observed.status !== 'read') throw Error('Baseline read failed')
  const next = attributeNoteBlocks(null, newNoteDocument('New source', mode === 'changed-identity' ? 'different-note' : old.noteId, 'first'), { ...actor, id: 'forged-agent' }, _liveTailFixtureEpoch(0, 0, 1))
  if (mode === 'unreadable') vi.spyOn(files, 'read').mockRejectedValueOnce(new Error('Read unavailable'))
  const written = await writer.write(workspace, { path, content: raw(next), expectedRevision: observed.document.revision }, mode === 'unknown-actor' ? undefined : { actor })
  expect(written).toMatchObject({ status: 'written', noteAttribution: { status: 'unconfirmed' } })
  const saved = parsed(await readFile(join(workspace.path, path), 'utf8'))
  expect(JSON.stringify(saved)).not.toContain('forged-agent')
  expect(provenance(saved).created).toBeNull()
  if (mode !== 'unknown-actor') expect(provenance(saved).lastEdited).toBeNull()
})

it('keeps invalid source repair and ordinary file writes available without claiming block authorship', async () => {
  const { workspace, writer, path } = await fixture()
  const invalid = '{note source under repair'
  expect(await writer.write(workspace, { path, content: invalid, expectedRevision: null }, { actor })).toMatchObject({ status: 'written', noteAttribution: { status: 'unconfirmed' } })
  expect(await readFile(join(workspace.path, path), 'utf8')).toBe(invalid)
  const ordinary = await writer.write(workspace, { path: 'ordinary.txt', content: 'ordinary text', expectedRevision: null })
  expect(ordinary).toEqual({ status: 'written', revision: expect.stringMatching(/^sha256:/) })
})

it('passes only the authenticated public caller into the real file owner and validates canonical content receipts', async () => {
  const { workspace, files, writer, path } = await fixture()
  const catalog = { zones: [{ zoneId: 'original-zone', workspaceId: workspace.id, kind: 'directory', hostId: 'local', directoryPath: workspace.path }], bindings: [] }
  const port = new FileReadOwner({ catalog: async () => catalog as never, workspace: () => workspace,
    files: { read: files.read.bind(files), listFiles: files.listFiles.bind(files), write: writer.write.bind(writer) } })
  const scope = { hostId: 'local', client: { authorizeRetainedAgentCaller: async (capability: string, sid: string) => {
    expect(capability).toBe('original-capability'); expect(sid).toBe(actor.id)
    return { agentSessionId: actor.id, hostId: 'local', run: { runId: 'original-run' } }
  } } }
  const service = new AgentMuxRpcService({ files: port, coreClients: () => [scope as never] })
  const params: FileReadParams = { zoneId: 'original-zone', path, expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: workspace.path } }
  const read = await service.call('file.read', params)
  expect(read.result.status).toBe('deleted')
  const candidate = attributeNoteBlocks(null, newNoteDocument('Public creation', 'public-note', 'public-block'), { ...actor, id: 'forged' }, _liveTailFixtureEpoch(0, 0, 1))
  const result = await service.call('file.create', { ...params, expectedResource: read.resource!, expectedRevision: null, content: raw(candidate) },
    { caller: { agentSessionId: actor.id, capability: 'original-capability' } })
  expect(result.result).toMatchObject({ status: 'written', content: expect.any(String), noteAttribution: { status: 'recorded' } })
  const saved = await service.call('file.read', params)
  expect(saved.result.status).toBe('read'); if (saved.result.status !== 'read') throw Error('Saved Note read failed')
  expect(provenance(parsed(saved.result.document.content))).toMatchObject({ created: { actor }, lastEdited: { actor } })
  expect(saved.result.document.content).not.toContain('forged')
})

it('real executable CLI creates/edits the original Note through its authenticated file service and another process reads the same persisted authors', async () => {
  const { workspace, files, writer, path } = await fixture()
  const catalog = { zones: [{ zoneId: 'original-zone', workspaceId: workspace.id, kind: 'directory', hostId: 'local', directoryPath: workspace.path }], bindings: [] }
  const port = new FileReadOwner({ catalog: async () => catalog as never, workspace: () => workspace,
    files: { read: files.read.bind(files), listFiles: files.listFiles.bind(files), write: writer.write.bind(writer) } })
  const server = new AgentMuxControlServer({ socketPath: join(workspace.path, 'control.sock'), files: port,
    coreClients: () => [{ hostId: 'local', client: { authorizeRetainedAgentCaller: async () => ({ agentSessionId: actor.id, hostId: 'local', run: { runId: 'run' } }) } } as never],
    execute: async () => { throw Error('File CLI must not send Agent or UI operations') } })
  await server.start()
  try {
    const target = resolve('.local/state/note-model/T001-cli.mjs'); await mkdir(dirname(target), { recursive: true })
    await symlink(resolve('packages/core/node_modules'), join(dirname(target), 'node_modules'), 'dir').catch(error => { if (error.code !== 'EEXIST') throw error })
    await createRequire(resolve('packages/core/package.json'))('esbuild').build({ entryPoints: ['packages/core/src/agentmux.ts'], outfile: target, platform: 'node', format: 'esm', packages: 'external', bundle: true, logLevel: 'silent' })
    const cli = (args: string[], input = '') => new Promise<any>((accept, reject) => {
      const child = spawn(process.execPath, [target, '--endpoint', 'unix:' + server.path, ...args], { env: { ...process.env,
        AGENTMUX_AGENT_SESSION_ID: actor.id, AGENTMUX_AGENT_CAPABILITY: 'original-capability', AGENTMUX_ENV: undefined }, stdio: ['pipe', 'pipe', 'pipe'] })
      let out = '', error = ''; child.stdout.on('data', data => { out += data }); child.stderr.on('data', data => { error += data })
      child.on('error', reject); child.on('close', code => { if (code) reject(Error(error || out)); else { try { accept(JSON.parse(out).result) } catch (failure) { reject(failure) } } }); child.stdin.end(input)
    })
    const args = ['file', 'read', '--zone', 'original-zone', '--path', path, '--host', 'local', '--workspace', workspace.id, '--workspace-path', workspace.path]
    const absent = await cli(args), initial = newNoteDocument('CLI initial body', 'cli-note', 'cli-block')
    const created = await cli(['file', 'create', '--input', '-'], JSON.stringify({ zoneId: 'original-zone', path, expectedResource: absent.resource, expectedRevision: null, content: raw(initial) }))
    expect(created.result).toMatchObject({ status: 'written', noteAttribution: { status: 'recorded' } })
    const observed = await cli(args), note = parsed(observed.result.document.content)
    note.content.content![0]!.content![0]!.text = 'CLI corrected body'
    const edited = await cli(['file', 'write', '--zone', 'original-zone', '--path', path, '--resource', JSON.stringify(observed.resource), '--expected-revision', observed.result.document.revision], raw(note))
    expect(edited.result.status).toBe('written')
    const childRead = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', 'import { readFileSync } from "node:fs"; process.stdout.write(readFileSync(process.argv[1], "utf8"))', join(workspace.path, path)])
    const restored = parsed(childRead.stdout)
    expect(restored).toMatchObject({ noteId: 'cli-note', content: { content: [{ attrs: { blockId: 'cli-block' }, content: [{ text: 'CLI corrected body' }] }] } })
    expect(provenance(restored)).toMatchObject({ created: { actor }, lastEdited: { actor } })
  } finally { await server.stop() }
}, 30_000)
