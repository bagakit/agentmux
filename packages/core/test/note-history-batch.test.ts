import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { historicalBodyPath } from './helpers/notebook-files-fixture.js'
import { AgentMuxNotebookStore } from '../src/notebook-store.js'
import { noteHistoryRevision } from '../src/note-history.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

const clean: string[] = []
afterEach(async () => { for (const path of clean.splice(0)) await rm(path, { recursive: true, force: true }) })
it('reads the complete indexed batch beyond a timeline page without inflating intermediate historical bodies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'note-full-batch-')); clean.push(root)
  const store = new AgentMuxNotebookStore(join(root, 'notebooks.root.json')), resource = { hostId: 'local', workspaceId: 'original', workspacePath: root, path: 'original.note.md' }
  let before = 'Original before\n'
  for (let index = 0; index < 205; index++) {
    const content = `Original version ${index}\n`
    await store.recordHistory({ eventId: `event-${index}`, sequence: 0, batchId: 'original-batch', noteId: 'original-note', resource, originalResource: resource,
      actor: { kind: 'agent', id: 'original-agent' }, at: index, status: 'committed', operation: 'edit', requestFingerprint: `original-${index}`,
      parentEventId: index ? `event-${index - 1}` : null, baseRevision: noteHistoryRevision(before), beforeContent: before, content, revision: noteHistoryRevision(content) })
    before = content
  }
  await store.recordHistory({ eventId: 'foreign-event', sequence: 0, batchId: 'original-batch', noteId: 'foreign-note', resource: { ...resource, path: 'foreign.note.md' }, originalResource: { ...resource, path: 'foreign.note.md' },
    actor: { kind: 'agent', id: 'other-agent' }, at: _historyFixtureEpoch(0, 0, 1), status: 'committed', operation: 'edit', requestFingerprint: 'foreign', parentEventId: null, baseRevision: null, beforeContent: null, content: 'Foreign\n', revision: noteHistoryRevision('Foreign\n') })
  const page = await store.readHistory({ noteId: 'original-note', resource, limit: 200 })
  expect(page.entries).toHaveLength(200); expect(page.hasMore).toBe(true)
  await writeFile(historicalBodyPath(store.path, noteHistoryRevision('Original version 100\n')), new Uint8Array([1, 2, 3]))
  const batch = await store.readHistoryBatch({ noteId: 'original-note', resource, batchId: 'original-batch' })
  expect(batch).toHaveLength(205); expect(batch[0]!.eventId).toBe('event-0'); expect(batch.at(-1)!.eventId).toBe('event-204')
  expect(batch.every(event => !Object.hasOwn(event, 'content') && !Object.hasOwn(event, 'beforeContent') && !Object.hasOwn(event, 'requestFingerprint'))).toBe(true)
  await expect(store.readHistoryOperation('event-100')).rejects.toThrow()
  expect((await store.readHistoryOperation('event-204'))!.content).toBe('Original version 204\n')
}, 30000)
