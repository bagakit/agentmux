import { chmodSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { mintObjectId, AgentMuxError } from '@agentmux/core'
import type { WritableSecretPort } from './connection-host.js'

const FORMAT = Buffer.from('amux.connection-credential.raw.v1\0')
/** The original Store and private maintenance tools share one exact value format. */
export function encodeConnectionCredential(secret: string): Buffer {
  if (typeof secret !== 'string' || !secret.length || Buffer.from(secret).toString('utf8') !== secret)
    throw new AgentMuxError('Credential input or operation identity is invalid.', 'INVALID_CONNECTION_DATA')
  return Buffer.concat([FORMAT, Buffer.from(secret)])
}
const unavailable = (): never => { throw new AgentMuxError('The original private credential storage is unavailable. Restore this Host storage and inspect the original operation; existing Agents and records are retained.', 'CONNECTION_CREDENTIAL_UNAVAILABLE') }
/** Permission-protected plaintext in the original SQLite owner. The historical column name does not imply encryption. */
export class ConnectionSecrets implements WritableSecretPort {
  constructor(private readonly database: DatabaseSync) {
    database.exec('CREATE TABLE IF NOT EXISTS connection_credential (credential_ref TEXT PRIMARY KEY, operation_id TEXT UNIQUE NOT NULL, ciphertext BLOB NOT NULL)')
  }
  async assertAvailable(): Promise<void> {
    try {
      const path = this.database.location()
      if (path) {
        const directory = statSync(dirname(path)), file = statSync(path), uid = process.getuid?.()
        if (!directory.isDirectory() || (directory.mode & 0o077) !== 0 || !file.isFile() || uid !== undefined && (directory.uid !== uid || file.uid !== uid)) return unavailable()
        // Only this exact database and its SQLite-owned sidecars; never a parent sweep or global umask.
        for (const owned of [path, path + '-journal', path + '-wal', path + '-shm']) {
          let metadata
          try { metadata = statSync(owned) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && owned !== path) continue; throw error }
          if (!metadata.isFile() || uid !== undefined && metadata.uid !== uid) return unavailable()
          chmodSync(owned, 0o600)
          if ((statSync(owned).mode & 0o777) !== 0o600) return unavailable()
        }
      }
      this.database.prepare('SELECT 1').get()
    } catch { return unavailable() }
  }
  async inspect(operationId: string): Promise<{ credentialRef: string } | null> {
    if (typeof operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(operationId)) throw new AgentMuxError('Credential operation identity is invalid.', 'INVALID_CONNECTION_DATA')
    try {
      const row = this.database.prepare('SELECT credential_ref FROM connection_credential WHERE operation_id = ?').get(operationId)
      return row ? { credentialRef: row.credential_ref as string } : null
    } catch { throw new AgentMuxError('The original credential operation is unconfirmed. Inspect it before replacing its identity.', 'CONNECTION_CREDENTIAL_UNCONFIRMED') }
  }
  private value(bytes: unknown): string {
    if (!(bytes instanceof Uint8Array)) throw new AgentMuxError('The original private credential value is unconfirmed. Its bytes and reference are retained.', 'CONNECTION_CREDENTIAL_UNCONFIRMED')
    if (!Buffer.from(bytes).subarray(0, FORMAT.length).equals(FORMAT)) throw new AgentMuxError('This original credential format is unsupported. Its bytes, operation and reference are retained; no conversion was attempted.', 'CONNECTION_CREDENTIAL_FORMAT_UNSUPPORTED')
    try { const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(FORMAT.length)); if (!value.length) throw new Error('Empty private credential'); return value }
    catch { throw new AgentMuxError('The original private credential value is unconfirmed. Its bytes and reference are retained.', 'CONNECTION_CREDENTIAL_UNCONFIRMED') }
  }
  async store(input: { operationId: string; secret: string }, assertCurrent?: () => void | Promise<void>): Promise<{ credentialRef: string }> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['operationId', 'secret'].includes(key)) || typeof input.operationId !== 'string' || typeof input.secret !== 'string' || !input.secret.length || Buffer.from(input.secret).toString('utf8') !== input.secret || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(input.operationId)) throw new AgentMuxError('Credential input or operation identity is invalid.', 'INVALID_CONNECTION_DATA')
    const { operationId, secret } = input
    await this.assertAvailable()
    await assertCurrent?.()
    try {
      this.database.exec('BEGIN IMMEDIATE')
      try {
        const original = this.database.prepare('SELECT credential_ref, ciphertext FROM connection_credential WHERE operation_id = ?').get(operationId)
        if (original) {
          if (this.value(original.ciphertext) !== secret) throw new AgentMuxError('The original credential operation has different input. Inspect it without replacing its identity.', 'CONNECTION_OPERATION_CONFLICT')
          this.database.exec('COMMIT'); return { credentialRef: original.credential_ref as string }
        }
        const credentialRef = mintObjectId()
        this.database.prepare('INSERT INTO connection_credential (credential_ref, operation_id, ciphertext) VALUES (?, ?, ?)').run(credentialRef, operationId, encodeConnectionCredential(secret))
        this.database.exec('COMMIT'); return { credentialRef }
      } catch (error) {
        try { this.database.exec('ROLLBACK') } catch { /* A committed original remains inspectable after a lost ACK. */ }
        throw error
      }
    } catch (error) {
      if (error instanceof AgentMuxError) throw error
      throw new AgentMuxError('Private credential storage could not confirm the original operation. Inspect it before retrying.', 'CONNECTION_CREDENTIAL_UNCONFIRMED')
    }
  }
  async resolve(credentialRef: string): Promise<string | null> {
    await this.assertAvailable()
    try {
      const row = this.database.prepare('SELECT ciphertext FROM connection_credential WHERE credential_ref = ?').get(credentialRef)
      return row ? this.value(row.ciphertext) : null
    } catch (error) {
      if (error instanceof AgentMuxError) throw error
      return unavailable()
    }
  }
}
