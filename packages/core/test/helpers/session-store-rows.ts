import { DatabaseSync } from 'node:sqlite'

type StoreTable = 'sessions' | 'reservations' | 'retired_sessions'
type StoreRow = { id: string; json: Record<string, any> }

/**
 * Read or alter the durable Session Store the way it is actually persisted: one SQLite row per
 * object. The Store file is a SQLite database, so tests cannot JSON.parse it; they read and
 * rewrite the exact row they reason about and leave every other row untouched.
 */
export function readStoreRows(path: string, table: StoreTable): StoreRow[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return db.prepare(`SELECT id, json FROM ${table} ORDER BY rowid`).all().map(row => ({ id: String(row.id), json: JSON.parse(String(row.json)) })) }
  finally { db.close() }
}

export function rewriteStoreRow(path: string, table: StoreTable, id: string, edit: (json: Record<string, any>) => void): void {
  const db = new DatabaseSync(path)
  try {
    const row = db.prepare(`SELECT json FROM ${table} WHERE id=?`).get(id)
    if (!row) throw new Error(`No ${table} row for ${id}`)
    const json = JSON.parse(String(row.json)); edit(json)
    db.prepare(`UPDATE ${table} SET json=? WHERE id=?`).run(JSON.stringify(json), id)
  } finally { db.close() }
}

/** Every durable row, for "nothing changed" assertions that once compared whole JSON files. */
export function storeSnapshot(path: string): Record<StoreTable, StoreRow[]> {
  return { sessions: readStoreRows(path, 'sessions'), reservations: readStoreRows(path, 'reservations'), retired_sessions: readStoreRows(path, 'retired_sessions') }
}
