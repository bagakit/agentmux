import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { afterEach, expect, it, vi } from 'vitest'
import { changeOriginalMetadata } from './helpers/notebook-files-fixture.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { AgentMuxNotebookStore } from '../src/notebook-store.js'
import type { NoteProvenanceWrite } from '../src/note-provenance.js'
const io = vi.hoisted(() => ({ enabled: false, reads: [] as string[] }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    const value = await actual.readFile(...args)
    if (io.enabled && String(args[0]).includes('.files/metadata/')) io.reads.push(String(args[0]))
    return value
  } }
})
const roots: string[] = []
const sha = (s: string) => 'sha256:' + createHash('sha256').update(s).digest('hex')
const author = (id: string) => ({ actor: { kind: 'agent' as const, id }, at: _newTailFixtureEpoch(0, 0, 1) })
afterEach(async () => { io.enabled = false; io.reads = []; vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'note-creator-batch-')); roots.push(root)
  const store = new AgentMuxNotebookStore(join(root, 'notebooks.root.json'))
  const resource = { hostId: 'local', workspaceId: 'original-workspace', workspacePath: root, path: 'original.note.md' }
  const ids = Array.from({ length: 64 }, (_, i) => 'block-' + i)
  const expected = Object.fromEntries(ids.map((id, i) => [id, author(i < 22 ? 'later-confirmed' : i < 43 ? 'first-known' : 'introduced-later')]))
  for (let version = 0; version < 3; version++) {
    const blocks: NoteProvenanceWrite['blocks'] = Object.create(null)
    ids.forEach((id, i) => {
      if (version === 0 && i >= 43) return
      const created = i < 22 && version === 0 || i >= 43 && version === 1 ? null : expected[id]!
      blocks[id] = { created, lastEdited: null }
    })
    await store.recordProvenance({ noteId: 'original', resource, revision: sha('version-' + version), blocks })
  }
  return { store, resource, ids, expected }
}
function observeHistoryReads() { io.enabled = true; io.reads = []; return io.reads }
it('reads first confirmed creators across several original revisions with bounded original metadata reads without borrowing last editors', async () => {
  const f = await fixture(), queries = observeHistoryReads()
  const result = await f.store.readProvenance({ noteId: 'original', resource: f.resource, revision: sha('external-edit'), blockIds: [...f.ids, 'never-known'] })
  expect(result.status).toBe('unconfirmed')
  for (const id of f.ids) expect(result.blocks[id]).toEqual({ created: f.expected[id], lastEdited: null })
  expect(result.blocks['never-known']).toEqual({ created: null, lastEdited: null })
  expect(queries.length).toBeGreaterThan(0)
  expect(queries.length).toBeLessThanOrEqual(2)
})
it('records many original blocks under the same creator and revision conflict checks with bounded original metadata reads', async () => {
  const f = await fixture(), queries = observeHistoryReads()
  const next: NoteProvenanceWrite = { noteId: 'original', resource: f.resource, revision: sha('next-save'),
    blocks: Object.fromEntries(f.ids.map(id => [id, { created: null, lastEdited: author('current-editor') }])) }
  const result = await f.store.recordProvenance(next)
  for (const id of f.ids) expect(result.blocks[id]).toEqual({ created: f.expected[id], lastEdited: author('current-editor') })
  expect(queries.length).toBeGreaterThan(0)
  expect(queries.length).toBeLessThanOrEqual(3)
  await expect(f.store.recordProvenance({ ...next, revision: sha('forged-creator'), blocks: { [f.ids[0]!]: { created: author('another-creator'), lastEdited: null } } })).rejects.toMatchObject({ code: 'NOTE_PROVENANCE_CONFLICT' })
  await expect(f.store.recordProvenance({ ...next, blocks: { [f.ids[0]!]: { created: null, lastEdited: author('another-editor') } } })).rejects.toMatchObject({ code: 'NOTE_PROVENANCE_CONFLICT' })
})
it('validates consumed history row identities even when the requested revision has never been saved', async () => {
  const f = await fixture()
  await changeOriginalMetadata(f.store.path, 'original', f.resource, value => { value.provenance[0].noteId = 'foreign-note' })
  await expect(f.store.readProvenance({ noteId: 'original', resource: f.resource, revision: sha('external-edit'), blockIds: [f.ids[22]!] })).rejects.toMatchObject({ code: 'NOTEBOOK_READ_UNCONFIRMED' })
})
