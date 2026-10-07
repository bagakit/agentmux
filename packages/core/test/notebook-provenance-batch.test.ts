import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { AgentMuxNotebookStore } from '../src/notebook-store.js'
import type { NoteProvenanceWrite } from '../src/note-provenance.js'
const roots: string[] = []
const sha = (s: string) => 'sha256:' + createHash('sha256').update(s).digest('hex')
const author = (id: string) => ({ actor: { kind: 'agent' as const, id }, at: _newTailFixtureEpoch(0, 0, 1) })
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'note-creator-batch-')); roots.push(root)
  const store = new AgentMuxNotebookStore(join(root, 'notebooks.sqlite'))
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
function observeHistoryQueries() {
  const queries: string[] = [], original = DatabaseSync.prototype.prepare
  vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (/FROM provenance\b/u.test(sql)) queries.push(sql)
    return original.call(this, sql)
  })
  return queries
}
it('reads first confirmed creators across several original revisions in one batch without borrowing last editors', async () => {
  const f = await fixture(), queries = observeHistoryQueries()
  const result = await f.store.readProvenance({ noteId: 'original', resource: f.resource, revision: sha('external-edit'), blockIds: [...f.ids, 'never-known'] })
  expect(result.status).toBe('unconfirmed')
  for (const id of f.ids) expect(result.blocks[id]).toEqual({ created: f.expected[id], lastEdited: null })
  expect(result.blocks['never-known']).toEqual({ created: null, lastEdited: null })
  expect(queries.length).toBeGreaterThan(0)
  expect(queries.length).toBeLessThanOrEqual(2)
})
it('records many original blocks under the same creator and revision conflict checks with bounded history queries', async () => {
  const f = await fixture(), queries = observeHistoryQueries()
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
  const f = await fixture(), db = new DatabaseSync(f.store.path)
  const row = db.prepare('SELECT json FROM provenance ORDER BY rowid LIMIT 1').get()!
  db.prepare('UPDATE provenance SET json=? WHERE rowid=(SELECT MIN(rowid) FROM provenance)').run(JSON.stringify({ ...JSON.parse(String(row.json)), noteId: 'foreign-note' }))
  db.close()
  await expect(f.store.readProvenance({ noteId: 'original', resource: f.resource, revision: sha('external-edit'), blockIds: [f.ids[22]!] })).rejects.toMatchObject({ code: 'NOTEBOOK_READ_UNCONFIRMED' })
})
