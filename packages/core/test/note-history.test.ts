import { fixturePath as _historyFixturePath } from "./helpers/fixture-values.js"
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { legacySqliteFixture } from './helpers/notebook-files-fixture.js'
import { applyNotebookChange, emptyNotebookState } from '../src/notebook-catalog.js'
import { AgentMuxNotebookStore } from '../src/notebook-store.js'
import { noteHistoryRevision, parseNoteHistoryQuery, type NoteHistoryRecord } from '../src/note-history.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
it('imports original v1 metadata without changing catalog, original SQL bytes or library identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'note-history-schema-')); roots.push(root)
  const store = new AgentMuxNotebookStore(join(root, 'notebooks.sqlite'))
  const resource = { hostId: 'local', workspaceId: 'original-workspace', workspacePath: root, path: 'original.note.md' }
  const state = applyNotebookChange(emptyNotebookState(), { expectedRevision: 0, operationId: 'register-original', change: { kind: 'register', noteId: 'original-note', title: 'Original', resource } }, { kind: 'user', id: 'original-person' }, 1)
  const incarnation = 'original-v1-incarnation', sqlPath = join(root, 'notebooks.sqlite')
  await legacySqliteFixture(sqlPath, { incarnation, state, provenance: [] }, 1)
  const originalBytes = await readFile(sqlPath)
  expect((await store.readHistory({ noteId: 'original-note', resource })).entries).toEqual([])
  const content = 'Original historical body', event: NoteHistoryRecord = { eventId: 'first-original-history-event', batchId: 'first-original-history-event', sequence: 0,
    noteId: 'original-note', resource, originalResource: resource, status: 'committed', actor: { kind: 'user', id: 'original-person' }, parentEventId: null,
    at: _historyFixtureEpoch(0, 0, 1), operation: 'edit', requestFingerprint: 'original-trusted-request', baseRevision: null, beforeContent: null, revision: noteHistoryRevision(content), content }
  const saved = await store.recordHistory(event)
  expect(await store.read()).toEqual(state)
  expect(JSON.parse(await readFile(store.path, 'utf8')).incarnation).toBe(incarnation)
  expect(await readFile(sqlPath)).toEqual(originalBytes)
  expect((await store.readHistory({ noteId: event.noteId, resource, eventId: saved.eventId, includeContent: true })).entries).toEqual([expect.objectContaining({ eventId: event.eventId, content })])
})
it('keeps timeline content opt-in and tied to one exact event', () => {
  const resource = { hostId: 'local', workspaceId: 'workspace', workspacePath: _historyFixturePath("notes"), path: 'original.note.md' }
  expect(() => parseNoteHistoryQuery({ noteId: 'original-note', resource, includeContent: true })).toThrow(/exact history event/)
  expect(parseNoteHistoryQuery({ noteId: 'original-note', resource, includeContent: true, eventId: 'original-event' })).toMatchObject({ eventId: 'original-event', includeContent: true })
})
