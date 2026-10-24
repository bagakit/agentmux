import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { noteProvenanceResourceKey } from '../../src/note-provenance.js'
import type { NoteResource } from '../../src/notebook-catalog.js'
import type { NotebookFileSnapshot } from '../../src/notebook-files.js'
export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
export const historicalBodyPath = (root: string, revision: string) => join(root + '.files', 'bodies', revision.slice(7) + '.md')
export async function originalMetadata(root: string, noteId: string, resource: NoteResource) {
  const manifest = JSON.parse(await readFile(root, 'utf8'))
  const original = Object.values(manifest.originals).find((entry: any) => entry.noteId === noteId && noteProvenanceResourceKey(entry.resource) === noteProvenanceResourceKey(resource)) as { metadata: string }
  const value = JSON.parse(await readFile(join(root + '.files', 'metadata', original.metadata + '.json'), 'utf8'))
  return { manifest, original, value }
}
/** Fault injection changes the payload and checksum together, so identity checks must still reject it. */
export async function changeOriginalMetadata(root: string, noteId: string, resource: NoteResource, change: (value: any) => void) {
  const { manifest, original, value } = await originalMetadata(root, noteId, resource)
  change(value)
  const bytes = JSON.stringify(value) + '\n', hash = digest(bytes)
  await writeFile(join(root + '.files', 'metadata', hash + '.json'), bytes)
  original.metadata = hash
  await writeFile(root, JSON.stringify(manifest) + '\n')
}
/** An original v1/v2 SQL input, created only by tests; production imports it read-only. */
export async function legacySqliteFixture(path: string, snapshot: NotebookFileSnapshot, version: 1 | 2 = 2) {
  const db = new DatabaseSync(path)
  try {
    db.exec(`PRAGMA application_id=1095585346; PRAGMA user_version=${version};
      CREATE TABLE identity(incarnation TEXT NOT NULL);
      CREATE TABLE notebook_state(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);
      CREATE TABLE provenance(note_id TEXT NOT NULL,resource TEXT NOT NULL,revision TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(note_id,resource,revision));`)
    db.prepare('INSERT INTO identity VALUES(?)').run(snapshot.incarnation)
    db.prepare('INSERT INTO notebook_state VALUES(1,?)').run(JSON.stringify(snapshot.state))
    for (const row of snapshot.provenance) db.prepare('INSERT INTO provenance VALUES(?,?,?,?)').run(row.noteId, noteProvenanceResourceKey(row.resource), row.revision, JSON.stringify(row))
    if (version === 2) {
      db.exec('CREATE TABLE note_history_content(revision TEXT PRIMARY KEY,content BLOB NOT NULL); CREATE TABLE note_history_event(sequence INTEGER PRIMARY KEY AUTOINCREMENT,note_id TEXT NOT NULL,resource TEXT NOT NULL,event_id TEXT NOT NULL,batch_id TEXT NOT NULL,json TEXT NOT NULL,UNIQUE(note_id,resource,event_id));')
      for (const row of snapshot.history ?? []) {
        for (const [revision, body] of [[row.baseRevision, row.beforeContent], [row.revision, row.content]] as const) if (revision && body !== null) db.prepare('INSERT OR IGNORE INTO note_history_content VALUES(?,?)').run(revision, gzipSync(body))
        const { content: _content, beforeContent: _before, sequence, ...metadata } = row
        db.prepare('INSERT INTO note_history_event VALUES(?,?,?,?,?,?)').run(sequence || null, row.noteId, noteProvenanceResourceKey(row.resource), row.eventId, row.batchId, JSON.stringify(metadata))
      }
    }
  } finally { db.close() }
  await writeFile(path + '.sqlite-identity', snapshot.incarnation)
}
