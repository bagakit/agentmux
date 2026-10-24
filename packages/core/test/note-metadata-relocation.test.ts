import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { historicalBodyPath, originalMetadata } from './helpers/notebook-files-fixture.js'
import { AgentMuxNotebookStore } from '../src/notebook-store.js'
import { noteHistoryRevision } from '../src/note-history.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

const roots: string[] = []
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })
const actor = { kind: 'agent' as const, id: 'original-agent' }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'note-metadata-move-')); roots.push(root)
  const store = new AgentMuxNotebookStore(join(root, 'notebooks.root.json'))
  const resource = { hostId: 'local', workspaceId: 'original', workspacePath: root, path: 'original.note.md' }, destination = { ...resource, path: 'moved.note.md' }
  const noteId = 'original-note', content = 'Original knowledge\n', revision = noteHistoryRevision(content)
  const provenance = { noteId, resource, revision, blocks: { original: { created: { actor, at: _historyFixtureEpoch(0, 0, 1) }, lastEdited: { actor, at: _historyFixtureEpoch(0, 0, 1) } } } }
  let state = await store.apply({ expectedRevision: 0, operationId: 'register', change: { kind: 'register', noteId, resource, title: 'Original' } }, actor)
  await store.recordProvenance(provenance)
  const event = await store.recordHistory({ noteId, resource, originalResource: resource, eventId: 'original-event', sequence: 0, batchId: 'original-batch', status: 'committed', operation: 'edit', actor, at: _historyFixtureEpoch(0, 0, 1),
    requestFingerprint: 'original-private-fingerprint', parentEventId: null, baseRevision: null, beforeContent: null, content, revision, provenance })
  const move = async (from = resource, to = destination, operationId = 'original-move') => state = await store.apply({ expectedRevision: state.revision, operationId, change: { kind: 'relocate', noteId, from, resource: to } }, actor)
  return { root, store, resource, destination, noteId, content, revision, provenance, event, move, state: () => state }
}
it('moves exact history and authors with the catalog without reading or rewriting historical content blobs', async () => {
  const f = await fixture()
  // An unrelated Note at this same source path must never be relocated by path alone.
  const { provenance: _provenance, ...foreignEvent } = f.event
  await f.store.recordHistory({ ...foreignEvent, noteId: 'another-note', eventId: 'another-event', sequence: 0 })
  // A damaged original body remains damaged. Relocation must not inflate or replace it.
  const blobPath = historicalBodyPath(f.store.path, f.revision), blobs = Buffer.from([1, 2, 3])
  await writeFile(blobPath, blobs)
  await f.move()
  expect(f.state().pages[f.noteId]!.resource).toEqual(f.destination)
  expect((await f.store.readHistory({ noteId: f.noteId, resource: f.resource })).entries).toEqual([])
  expect((await f.store.readHistory({ noteId: f.noteId, resource: f.destination })).entries).toEqual([expect.objectContaining({ resource: f.destination, originalResource: f.resource, eventId: f.event.eventId, sequence: f.event.sequence })])
  expect(await f.store.readProvenance({ noteId: f.noteId, resource: f.destination, revision: f.revision, blockIds: ['original'] })).toMatchObject({ status: 'recorded', blocks: f.provenance.blocks })
  expect((await f.store.readHistory({ noteId: 'another-note', resource: f.resource })).entries).toHaveLength(1)
  expect(await readFile(blobPath)).toEqual(blobs)
  const raw = (await originalMetadata(f.store.path, f.noteId, f.destination)).value.history[0]
  expect(raw).toMatchObject({ requestFingerprint: 'original-private-fingerprint', resource: f.destination, originalResource: f.resource, provenance: { resource: f.destination } })
  const moved = f.state()
  expect(await f.store.apply({ expectedRevision: 0, operationId: 'original-move', change: { kind: 'relocate', noteId: f.noteId, from: f.resource, resource: f.destination } }, actor)).toEqual(moved)
  await f.move(f.destination, f.resource, 'move-back')
  expect((await f.store.readHistory({ noteId: f.noteId, resource: f.resource })).entries).toHaveLength(1)
  expect((await f.store.readHistory({ noteId: f.noteId, resource: f.destination })).entries).toEqual([])
})
it('rolls back catalog and source metadata together when the destination already has original metadata', async () => {
  const f = await fixture(), before = await f.store.read()
  await f.store.recordProvenance({ ...f.provenance, resource: f.destination })
  await expect(f.move()).rejects.toMatchObject({ code: 'NOTE_METADATA_RELOCATION_CONFLICT' })
  expect(await f.store.read()).toEqual(before)
  expect((await f.store.readHistory({ noteId: f.noteId, resource: f.resource })).entries).toHaveLength(1)
  expect((await f.store.readHistory({ noteId: f.noteId, resource: f.destination })).entries).toEqual([])
  expect(await f.store.readProvenance({ noteId: f.noteId, resource: f.resource, revision: f.revision, blockIds: ['original'] })).toMatchObject({ status: 'recorded', blocks: f.provenance.blocks })
  expect(await f.store.readProvenance({ noteId: f.noteId, resource: f.destination, revision: f.revision, blockIds: ['original'] })).toMatchObject({ status: 'recorded', blocks: f.provenance.blocks })
})
