import type { DatabaseSync } from 'node:sqlite'
import { mintObjectId, AgentMuxError } from '@agentmux/core'
import type { WritableSecretPort } from '@agentmux/connectors'

export type CredentialEncryption = {
  isAsyncEncryptionAvailable(): Promise<boolean>
  getSelectedStorageBackend?(): string
  encryptStringAsync(value: string): Promise<Buffer>
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
}
/** The executing Desktop Host stores only OS-encrypted bytes; unavailable encryption never writes plaintext. */
export class DesktopConnectorSecrets implements WritableSecretPort {
  constructor(private readonly database: DatabaseSync, private readonly encryption: CredentialEncryption) {
    database.exec('CREATE TABLE IF NOT EXISTS connection_credential (credential_ref TEXT PRIMARY KEY, operation_id TEXT UNIQUE NOT NULL, ciphertext BLOB NOT NULL)')
  }
  async assertAvailable(): Promise<void> {
    let available = false
    try { available = await this.encryption.isAsyncEncryptionAvailable() && this.encryption.getSelectedStorageBackend?.() !== 'basic_text' } catch { /* Never expose raw OS credential-service errors. */ }
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
    const { operationId, secret } = input
    await this.assertAvailable()
    try {
      const original = this.database.prepare('SELECT credential_ref, ciphertext FROM connection_credential WHERE operation_id = ?').get(operationId)
      if (original) return await this.matchOriginal(original, secret)
      // OS authorization can remain pending. Never hold a SQLite writer across it.
      const ciphertext = await this.encryption.encryptStringAsync(secret)
      let concurrent: Record<string, unknown> | undefined
      this.database.exec('BEGIN IMMEDIATE')
      try {
        concurrent = this.database.prepare('SELECT credential_ref, ciphertext FROM connection_credential WHERE operation_id = ?').get(operationId)
        if (!concurrent) {
          const credentialRef = mintObjectId()
          this.database.prepare('INSERT INTO connection_credential (credential_ref, operation_id, ciphertext) VALUES (?, ?, ?)').run(credentialRef, operationId, ciphertext)
          this.database.exec('COMMIT'); return { credentialRef }
        }
        this.database.exec('COMMIT')
      } catch (error) {
        try { this.database.exec('ROLLBACK') } catch { /* Original commit may already exist. Inspect its operation. */ }
        throw error
      }
      return await this.matchOriginal(concurrent, secret)
    } catch (error) {
      if (error instanceof AgentMuxError) throw error
      throw new AgentMuxError('Secure credential storage could not confirm the original operation. Inspect it before retrying.', 'CONNECTION_CREDENTIAL_UNCONFIRMED')
    }
  }
  private async matchOriginal(row: Record<string, unknown>, secret: string): Promise<{ credentialRef: string }> {
    const decrypted = await this.encryption.decryptStringAsync(Buffer.from(row.ciphertext as Uint8Array))
    if (decrypted.result !== secret) throw new AgentMuxError('The original credential operation has different input. Inspect it without replacing its identity.', 'CONNECTION_OPERATION_CONFLICT')
    return { credentialRef: row.credential_ref as string }
  }
  async resolve(credentialRef: string): Promise<string | null> {
    await this.assertAvailable()
    try {
      const row = this.database.prepare('SELECT ciphertext FROM connection_credential WHERE credential_ref = ?').get(credentialRef)
      return row ? (await this.encryption.decryptStringAsync(Buffer.from(row.ciphertext as Uint8Array))).result : null
    } catch { throw new AgentMuxError('Secure credential resolution is unavailable. The credential and original connection are retained.', 'CONNECTION_CREDENTIAL_UNAVAILABLE') }
  }
}
