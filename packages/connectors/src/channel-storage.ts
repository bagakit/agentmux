import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { AgentMuxError } from '@agentmux/core'
import type { ConnectionConfig } from '@agentmux/core/connections'

export type ChannelStorageScope = Pick<ConnectionConfig, 'adapterId' | 'application'>
export type ChannelStorageValue = { kind: 'json'; value: unknown } | { kind: 'bytes'; value: Uint8Array }
export type ChannelStorageRecord = { key: string; revision: string; value: ChannelStorageValue }
export interface ChannelStoragePort {
  get(key: string): ChannelStorageRecord | null
  /** null creates an absent key; an exact revision replaces only that original value. */
  put(input: { key: string; value: ChannelStorageValue; expectedRevision: string | null }): ChannelStorageRecord
  delete(input: { key: string; expectedRevision: string }): boolean
  /** Values are read individually: listing large retained attachments never materializes their bytes. */
  list(input?: { limit?: number; after?: string }): { entries: Array<Pick<ChannelStorageRecord, 'key' | 'revision'>>; next: string | null }
}
const invalid = (): never => { throw new AgentMuxError('The exact Channel storage request is invalid.', 'INVALID_CHANNEL_STORAGE_REQUEST') }
const conflict = (): never => { throw new AgentMuxError('The original Channel value changed. Read its current revision before updating.', 'CHANNEL_STORAGE_CONFLICT') }
function key(value: string): string { if (typeof value !== 'string' || !value || value.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(value)) return invalid(); return value }

/** One original Connection database, with opaque values and an immutable adapter/application namespace. */
export class ChannelStorage {
  constructor(private readonly database: DatabaseSync) {
    this.safe(() => database.exec('CREATE TABLE IF NOT EXISTS channel_storage (adapter_id TEXT NOT NULL, domain TEXT NOT NULL, app_id TEXT NOT NULL, storage_key TEXT NOT NULL, revision TEXT NOT NULL, value_kind TEXT NOT NULL, value ANY NOT NULL, PRIMARY KEY(adapter_id,domain,app_id,storage_key)) STRICT;'))
  }
  private safe<T>(read: () => T): T {
    try { return read() } catch (error) {
      if (error instanceof AgentMuxError) throw error
      throw new AgentMuxError('Channel metadata storage is unavailable. Original messages, permissions and Agent input remain available.', 'CHANNEL_STORAGE_UNAVAILABLE')
    }
  }
  namespace(scope: ChannelStorageScope): ChannelStoragePort {
    const namespace = [key(scope.adapterId), key(scope.application.domain), key(scope.application.appId)]
    const get = (originalKey: string): ChannelStorageRecord | null => this.safe(() => {
      const row = this.database.prepare('SELECT revision,value_kind,value FROM channel_storage WHERE adapter_id=? AND domain=? AND app_id=? AND storage_key=?').get(...namespace, key(originalKey))
      if (!row) return null
      let value: ChannelStorageValue
      if (row.value_kind === 'json' && typeof row.value === 'string') value = { kind: 'json', value: JSON.parse(row.value) }
      else if (row.value_kind === 'bytes' && row.value instanceof Uint8Array) value = { kind: 'bytes', value: new Uint8Array(row.value) }
      else throw Error('The original Channel value representation is unconfirmed')
      return { key: originalKey, revision: String(row.revision), value }
    })
    return {
      get,
      put: input => this.safe(() => {
        const originalKey = key(input.key), revision = randomUUID()
        if (input.expectedRevision !== null) key(input.expectedRevision)
        const value = input.value.kind === 'json' ? JSON.stringify(input.value.value) : input.value.kind === 'bytes' && input.value.value instanceof Uint8Array ? Buffer.from(input.value.value) : invalid()
        if (value === undefined) return invalid()
        const changed = input.expectedRevision === null
          ? this.database.prepare('INSERT INTO channel_storage VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').run(...namespace, originalKey, revision, input.value.kind, value)
          : this.database.prepare('UPDATE channel_storage SET revision=?,value_kind=?,value=? WHERE adapter_id=? AND domain=? AND app_id=? AND storage_key=? AND revision=?').run(revision, input.value.kind, value, ...namespace, originalKey, input.expectedRevision)
        if (changed.changes !== 1) return conflict()
        // The successful write owns these exact bytes even if a separate owner subsequently updates the key.
        return { key: originalKey, revision, value: input.value.kind === 'json' ? { kind: 'json', value: JSON.parse(String(value)) } : { kind: 'bytes', value: new Uint8Array(value as Buffer) } }
      }),
      delete: input => this.safe(() => {
        const originalKey = key(input.key), revision = key(input.expectedRevision)
        const changed = this.database.prepare('DELETE FROM channel_storage WHERE adapter_id=? AND domain=? AND app_id=? AND storage_key=? AND revision=?').run(...namespace, originalKey, revision)
        if (changed.changes === 1) return true
        if (get(originalKey)) return conflict()
        return false
      }),
      list: (input = {}) => this.safe(() => {
        const limit = input.limit ?? 30
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return invalid()
        let after = ''
        if (input.after !== undefined) {
          try {
            const cursor = JSON.parse(Buffer.from(input.after, 'base64url').toString('utf8'))
            if (!Array.isArray(cursor) || cursor.length !== 2 || JSON.stringify(cursor[0]) !== JSON.stringify(namespace)) return invalid()
            after = key(cursor[1])
          } catch { return invalid() }
        }
        const rows = this.database.prepare('SELECT storage_key,revision FROM channel_storage WHERE adapter_id=? AND domain=? AND app_id=? AND storage_key>? ORDER BY storage_key LIMIT ?').all(...namespace, after, limit + 1)
        const entries = rows.slice(0, limit).map(row => ({ key: String(row.storage_key), revision: String(row.revision) }))
        return { entries, next: rows.length > limit ? Buffer.from(JSON.stringify([namespace, entries.at(-1)!.key])).toString('base64url') : null }
      })
    }
  }
}
