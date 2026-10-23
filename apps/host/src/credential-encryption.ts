import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { open, realpath } from 'node:fs/promises'
import { AgentMuxError } from '@agentmux/core'
import type { CredentialEncryption } from '@agentmux/connectors'

export type HostCredentialKeyringEntry = {
  getSecret(): Promise<number[] | null>
  setSecret(value: Uint8Array): Promise<void>
}
export const HOST_CREDENTIAL_KEYRING_SERVICE = 'dev.agentmux.connection-vault'
const FORMAT = Buffer.from('amux.connection-vault.v1\0')
const KEY_BYTES = 32, IV_BYTES = 12, TAG_BYTES = 16
const unavailable = (): never => { throw new AgentMuxError('The original Host credential key is unavailable. Restore its operating system secret service; credentials and Agents are retained.', 'CONNECTION_CREDENTIAL_UNAVAILABLE') }

/** Stable within the original connection database namespace, independent of owner process or release. */
export function hostCredentialKeyringAccount(namespace: string): string {
  if (typeof namespace !== 'string' || !namespace || /[\0\r\n]/u.test(namespace)) return unavailable()
  return createHash('sha256').update(namespace).digest('hex')
}

/** Only the existing Host owner may initialize this vault; this adapter owns no connection lifecycle. */
export function createHostCredentialEncryption(options: {
  database: DatabaseSync
  namespace: string
  /** Embeddings can provide an explicit secure provider. Product default is the native OS store below. */
  keyring?: (() => Promise<HostCredentialKeyringEntry>) | undefined
}): CredentialEncryption {
  const account = hostCredentialKeyringAccount(options.namespace)
  const aad = Buffer.from(JSON.stringify(['amux.connection-vault.v1', options.namespace]))
  let entry: Promise<HostCredentialKeyringEntry> | undefined
  const nativeEntry = async (): Promise<HostCredentialKeyringEntry> => {
    const { AsyncEntry } = await import('@napi-rs/keyring')
    if (!['darwin', 'win32', 'linux'].includes(process.platform)) return unavailable()
    // Never accept the library's Linux Secret Service -> volatile keyutils selection.
    return new AsyncEntry(HOST_CREDENTIAL_KEYRING_SERVICE, account, process.platform === 'linux' ? { linux: { store: 'secret-service' } } : undefined)
  }
  const getEntry = async () => {
    const original = entry ??= (options.keyring ?? nativeEntry)()
    try { return await original } catch { if (entry === original) entry = undefined; return unavailable() }
  }
  // Serialize key initialization within the original single Host owner. No SQLite writer is held
  // over OS authorization, and no plaintext master key is cached for later credential operations.
  let access = Promise.resolve()
  const master = async (): Promise<Buffer> => {
    const previous = access
    let release!: () => void
    access = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      const keyring = await getEntry()
      let value = await keyring.getSecret()
      if (value === null) {
        const path = options.database.location()
        const lease = path ? await open((await realpath(path)) + '.credential-key.lock', 'a+', 0o600) : undefined
        try {
          if (lease && !(createRequire(import.meta.url)('fs-native-extensions') as { tryLock(fd: number): boolean }).tryLock(lease.fd)) return unavailable()
          // Recheck after the namespace lease: a concurrent original initializer may have won.
          value = await keyring.getSecret()
          if (value === null) {
            // A missing/locked/lost key must never turn an existing vault into an empty new one.
            if (options.database.prepare('SELECT 1 FROM connection_credential LIMIT 1').get()) return unavailable()
            const created = randomBytes(KEY_BYTES)
            try { await keyring.setSecret(created) } finally { created.fill(0) }
            value = await keyring.getSecret()
          }
        } finally { await lease?.close() }
      }
      if (!Array.isArray(value) || value.length !== KEY_BYTES || value.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) return unavailable()
      const key = Buffer.from(value); value.fill(0)
      return key
    } catch { return unavailable() }
    finally { release() }
  }
  return {
    isAsyncEncryptionAvailable: async () => {
      try { const key = await master(); key.fill(0); return true } catch { return false }
    },
    getSelectedStorageBackend: () => process.platform === 'linux' ? 'secret-service' : process.platform === 'darwin' ? 'keychain' : 'windows-credential-manager',
    encryptStringAsync: async value => {
      const key = await master()
      try {
        const iv = randomBytes(IV_BYTES), cipher = createCipheriv('aes-256-gcm', key, iv)
        cipher.setAAD(aad)
        const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
        return Buffer.concat([FORMAT, iv, cipher.getAuthTag(), ciphertext])
      } catch { return unavailable() }
      finally { key.fill(0) }
    },
    decryptStringAsync: async value => {
      if (!Buffer.isBuffer(value) || value.length < FORMAT.length + IV_BYTES + TAG_BYTES || !value.subarray(0, FORMAT.length).equals(FORMAT)) {
        throw new AgentMuxError('This credential uses an unsupported encrypted format. Its original bytes and reference are retained.', 'CONNECTION_CREDENTIAL_FORMAT_UNSUPPORTED')
      }
      const key = await master()
      try {
        const offset = FORMAT.length, decipher = createDecipheriv('aes-256-gcm', key, value.subarray(offset, offset + IV_BYTES))
        decipher.setAAD(aad)
        decipher.setAuthTag(value.subarray(offset + IV_BYTES, offset + IV_BYTES + TAG_BYTES))
        return { result: Buffer.concat([decipher.update(value.subarray(offset + IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8'), shouldReEncrypt: false }
      } catch { return unavailable() }
      finally { key.fill(0) }
    }
  }
}
