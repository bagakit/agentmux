import type { DatabaseSync } from 'node:sqlite'
import { mintObjectId, AgentMuxError } from '@agentmux/core'
import type { WritableSecretPort } from '@agentmux/connectors'

export type CredentialEncryption = {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}
/** The executing Desktop Host stores only OS-encrypted bytes; unavailable encryption never writes plaintext. */
export class DesktopConnectorSecrets implements WritableSecretPort {
  constructor(private readonly database: DatabaseSync, private readonly encryption: CredentialEncryption) {
    database.exec('CREATE TABLE IF NOT EXISTS connection_credential (credential_ref TEXT PRIMARY KEY, operation_id TEXT UNIQUE NOT NULL, ciphertext BLOB NOT NULL)')
  }
  private assertAvailable(): void {
    let available = false
    try { available = this.encryption.isEncryptionAvailable() && this.encryption.getSelectedStorageBackend?.() !== 'basic_text' } catch { /* Never expose raw OS credential-service errors. */ }
    if (!available) throw new AgentMuxError('Secure credential storage is unavailable on this Host. Unlock the operating system credential service and retry the same operation.', 'CONNECTION_CREDENTIAL_UNAVAILABLE')
  }
  async inspect(operationId: string): Promise<{ credentialRef: string } | null> {
    if (typeof operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(operationId)) throw new AgentMuxError('Credential operation identity is invalid.', 'INVALID_CONNECTION_DATA')
    try {
      const row = this.database.prepare('SELECT credential_ref FROM connection_credential WHERE operation_id = ?').get(operationId)
      return row ? { credentialRef: row.credential_ref as string } : null
    } catch { throw new AgentMuxError('The original credential operation is unconfirmed. Inspect it before replacing its identity.', 'CONNECTION_CREDENTIAL_UNCONFIRMED') }
  }
  async store(input: { operationId: string; secret: string }): Promise<{ credentialRef: string }> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['operationId', 'secret'].includes(key)) || typeof input.operationId !== 'string' || typeof input.secret !== 'string' || !input.secret.length || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(input.operationId)) throw new AgentMuxError('Credential input or operation identity is invalid.', 'INVALID_CONNECTION_DATA')
    this.assertAvailable()
    try {
      this.database.exec('BEGIN IMMEDIATE')
      const row = this.database.prepare('SELECT credential_ref, ciphertext FROM connection_credential WHERE operation_id = ?').get(input.operationId)
      if (row) {
        if (this.encryption.decryptString(Buffer.from(row.ciphertext as Uint8Array)) !== input.secret) throw new AgentMuxError('The original credential operation has different input. Inspect it without replacing its identity.', 'CONNECTION_OPERATION_CONFLICT')
        this.database.exec('COMMIT'); return { credentialRef: row.credential_ref as string }
      }
      const credentialRef = mintObjectId(), ciphertext = this.encryption.encryptString(input.secret)
      this.database.prepare('INSERT INTO connection_credential (credential_ref, operation_id, ciphertext) VALUES (?, ?, ?)').run(credentialRef, input.operationId, ciphertext)
      this.database.exec('COMMIT'); return { credentialRef }
    } catch (error) {
      try { this.database.exec('ROLLBACK') } catch { /* Original commit may already exist. Inspect its operation. */ }
      if (error instanceof AgentMuxError) throw error
      throw new AgentMuxError('Secure credential storage could not confirm the original operation. Inspect it before retrying.', 'CONNECTION_CREDENTIAL_UNCONFIRMED')
    }
  }
  async resolve(credentialRef: string): Promise<string | null> {
    this.assertAvailable()
    try {
      const row = this.database.prepare('SELECT ciphertext FROM connection_credential WHERE credential_ref = ?').get(credentialRef)
      return row ? this.encryption.decryptString(Buffer.from(row.ciphertext as Uint8Array)) : null
    } catch { throw new AgentMuxError('Secure credential resolution is unavailable. The credential and original connection are retained.', 'CONNECTION_CREDENTIAL_UNAVAILABLE') }
  }
}
