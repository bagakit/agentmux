import { fixturePath as _historyFixturePath } from "./helpers/fixture-values.js"
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxNotebookStore } from '../src/notebook-store.js'
import { noteHistoryRevision, parseNoteHistoryQuery, type NoteHistoryRecord } from '../src/note-history.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
it('extends original v1 metadata in place without changing catalog, provenance or database identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'note-history-schema-')); roots.push(root)
  const store = new AgentMuxNotebookStore(join(root, 'notebooks.sqlite'))
  const resource = { hostId: 'local', workspaceId: 'original-workspace', workspacePath: root, path: 'original.note.md' }
  const state = await store.apply({ expectedRevision: 0, operationId: 'register-original', change: { kind: 'register', noteId: 'original-note', title: 'Original', resource } }, { kind: 'user', id: 'original-person' })
  const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(store.path)
  let incarnation: unknown
  try {
    expect(db.prepare('SELECT count(*) AS n FROM note_history_event').get()?.n).toBe(0)
    incarnation = db.prepare('SELECT incarnation FROM identity').get()?.incarnation
    // This is the complete original v1 schema: no journal has ever been acknowledged.
    db.exec('DROP TABLE note_history_event; DROP TABLE note_history_content; PRAGMA user_version=1')
  } finally { db.close() }
  expect((await store.readHistory({ noteId: 'original-note', resource })).entries).toEqual([])
  const content = 'Original historical body', event: NoteHistoryRecord = { eventId: 'first-original-history-event', batchId: 'first-original-history-event', sequence: 0,
    noteId: 'original-note', resource, originalResource: resource, status: 'committed', actor: { kind: 'user', id: 'original-person' }, parentEventId: null,
    at: _historyFixtureEpoch(0, 0, 1), operation: 'edit', requestFingerprint: 'original-trusted-request', baseRevision: null, beforeContent: null, revision: noteHistoryRevision(content), content }
  const saved = await store.recordHistory(event)
  expect(await store.read()).toEqual(state)
  const reopened = new DatabaseSync(store.path, { readOnly: true })
  try { expect(reopened.prepare('PRAGMA user_version').get()?.user_version).toBe(2); expect(reopened.prepare('SELECT incarnation FROM identity').get()?.incarnation).toBe(incarnation) } finally { reopened.close() }
  expect((await store.readHistory({ noteId: event.noteId, resource, eventId: saved.eventId, includeContent: true })).entries).toEqual([expect.objectContaining({ eventId: event.eventId, content })])
})
it('keeps timeline content opt-in and tied to one exact event', () => {
  const resource = { hostId: 'local', workspaceId: 'workspace', workspacePath: _historyFixturePath("notes"), path: 'original.note.md' }
  expect(() => parseNoteHistoryQuery({ noteId: 'original-note', resource, includeContent: true })).toThrow(/exact history event/)
  expect(parseNoteHistoryQuery({ noteId: 'original-note', resource, includeContent: true, eventId: 'original-event' })).toMatchObject({ eventId: 'original-event', includeContent: true })
})
