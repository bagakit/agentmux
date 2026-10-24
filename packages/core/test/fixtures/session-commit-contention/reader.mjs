import { DatabaseSync } from 'node:sqlite'
import { once } from 'node:events'

const database = new DatabaseSync(process.argv[2], { readOnly: true })
try {
  database.exec('BEGIN')
  const row = database.prepare('SELECT json FROM sessions WHERE id=?').get('original')
  console.log(JSON.stringify({ phase: 'read-transaction-owned', updatedAt: JSON.parse(row.json).updatedAt,
    node: process.version, sqlite: database.prepare('SELECT sqlite_version() AS version').get().version }))
  await once(process.stdin, 'data')
  database.exec('COMMIT')
} finally { database.close() }
