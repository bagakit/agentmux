import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { ConnectionSecrets } from '../../../packages/connectors/src/connection-secrets'

const databases: DatabaseSync[] = []
afterEach(() => { for (const database of databases.splice(0)) database.close() })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept }); return { promise, resolve } }
function fixture() {
  const database = new DatabaseSync(':memory:'); databases.push(database)
  const encryption = {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'fixture-secure'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from('sealed:' + value)),
    decryptStringAsync: vi.fn(async (value: Buffer) => ({ result: value.toString().slice(7), shouldReEncrypt: false })),
    isEncryptionAvailable: vi.fn((): never => { throw Error('Synchronous OS access is forbidden') }),
    encryptString: vi.fn((): never => { throw Error('Synchronous OS access is forbidden') }),
    decryptString: vi.fn((): never => { throw Error('Synchronous OS access is forbidden') }),
  }
  const secrets = new ConnectionSecrets(database, encryption)
  const unlocked = () => expect(() => { database.exec('BEGIN IMMEDIATE'); database.exec('ROLLBACK') }).not.toThrow()
  return { database, encryption, secrets, unlocked }
}

it('keeps original inspection and SQLite usable while OS availability and encryption are pending', async () => {
  const f = fixture(), available = deferred<boolean>(), encrypted = deferred<Buffer>()
  f.encryption.isAsyncEncryptionAvailable.mockReturnValueOnce(available.promise)
  f.encryption.encryptStringAsync.mockReturnValueOnce(encrypted.promise)
  const request = { operationId: 'original-operation', secret: 'original-fixture-secret' }
  const work = f.secrets.store(request)
  request.operationId = 'caller-mutated-operation'; request.secret = 'caller-mutated-secret'
  expect(f.encryption.isAsyncEncryptionAvailable).toHaveBeenCalledTimes(1)
  expect(f.encryption.encryptStringAsync).not.toHaveBeenCalled()
  let inspectionSettled = false
  const inspection = f.secrets.inspect('original-operation').then(value => { inspectionSettled = true; return value })
  await Promise.resolve()
  expect(inspectionSettled).toBe(true)
  expect(await inspection).toBeNull(); f.unlocked()
  available.resolve(true); await Promise.resolve(); await Promise.resolve()
  expect(f.encryption.encryptStringAsync).toHaveBeenCalledExactlyOnceWith('original-fixture-secret')
  expect(await f.secrets.inspect('original-operation')).toBeNull(); f.unlocked()
  encrypted.resolve(Buffer.from('sealed:original-fixture-secret'))
  const receipt = await work
  expect(await f.secrets.inspect('original-operation')).toEqual(receipt)
  expect(await f.secrets.inspect('caller-mutated-operation')).toBeNull()
  expect(await f.secrets.resolve(receipt.credentialRef)).toBe('original-fixture-secret')
  expect(f.encryption.isEncryptionAvailable).not.toHaveBeenCalled()
  expect(f.encryption.encryptString).not.toHaveBeenCalled(); expect(f.encryption.decryptString).not.toHaveBeenCalled()
})

it('reuses concurrent same-operation receipts and refuses another secret without replacing original bytes', async () => {
  const f = fixture(), first = deferred<Buffer>(), second = deferred<Buffer>(), conflict = deferred<Buffer>()
  f.encryption.encryptStringAsync.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(conflict.promise)
  const a = f.secrets.store({ operationId: 'original-operation', secret: 'original' })
  const b = f.secrets.store({ operationId: 'original-operation', secret: 'original' })
  const c = f.secrets.store({ operationId: 'original-operation', secret: 'conflicting' }).catch(error => error)
  await Promise.resolve(); await Promise.resolve(); f.unlocked()
  first.resolve(Buffer.from('sealed:original'))
  const original = await a
  const row = f.database.prepare('SELECT * FROM connection_credential').get()!
  second.resolve(Buffer.from('other-encrypted-candidate')); conflict.resolve(Buffer.from('sealed:conflicting'))
  expect(await b.catch(error => error)).toEqual(original)
  expect(await c).toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
  expect(f.database.prepare('SELECT * FROM connection_credential').all()).toEqual([row])
  expect(await f.secrets.inspect('original-operation')).toEqual(original)
  expect(await f.secrets.resolve(original.credentialRef)).toBe('original')
})

it('keeps retained ciphertext and its receipt immutable while asynchronous decryption waits or suggests rotation', async () => {
  const f = fixture(), decrypt = deferred<{ result: string; shouldReEncrypt: boolean }>()
  const original = await f.secrets.store({ operationId: 'original-operation', secret: 'original' })
  const row = f.database.prepare('SELECT * FROM connection_credential').get()!
  f.encryption.encryptStringAsync.mockClear()
  f.encryption.decryptStringAsync.mockReturnValue(decrypt.promise)
  const read = f.secrets.resolve(original.credentialRef)
  const repeated = f.secrets.store({ operationId: 'original-operation', secret: 'original' })
  await Promise.resolve(); await Promise.resolve(); f.unlocked()
  expect(await f.secrets.inspect('original-operation')).toEqual(original)
  decrypt.resolve({ result: 'original', shouldReEncrypt: true })
  expect(await read).toBe('original'); expect(await repeated).toEqual(original)
  expect(f.database.prepare('SELECT * FROM connection_credential').get()).toEqual(row)
  expect(f.encryption.encryptStringAsync).not.toHaveBeenCalled()
})

it.each(['unavailable', 'plaintext', 'availability-failed', 'encryption-failed', 'decryption-failed'] as const)('retains original secure storage under %s without leaking OS detail', async kind => {
  const f = fixture(), original = await f.secrets.store({ operationId: 'retained-operation', secret: 'retained' })
  const row = f.database.prepare('SELECT * FROM connection_credential').get()!
  const raw = 'private-os-error-and-secret-marker'
  if (kind === 'unavailable') f.encryption.isAsyncEncryptionAvailable.mockResolvedValue(false)
  if (kind === 'plaintext') f.encryption.getSelectedStorageBackend.mockReturnValue('basic_text')
  if (kind === 'availability-failed') f.encryption.isAsyncEncryptionAvailable.mockRejectedValue(Error(raw))
  if (kind === 'encryption-failed') f.encryption.encryptStringAsync.mockRejectedValue(Error(raw))
  if (kind === 'decryption-failed') f.encryption.decryptStringAsync.mockRejectedValue(Error(raw))
  const result = await (kind === 'decryption-failed' ? f.secrets.resolve(original.credentialRef)
    : f.secrets.store({ operationId: 'new-operation', secret: 'new' })).catch(error => error)
  expect(result).toMatchObject({ code: kind === 'encryption-failed' ? 'CONNECTION_CREDENTIAL_UNCONFIRMED' : 'CONNECTION_CREDENTIAL_UNAVAILABLE' })
  expect(result.message).not.toContain(raw)
  expect(f.database.prepare('SELECT * FROM connection_credential').all()).toEqual([row]); f.unlocked()
  expect(await f.secrets.inspect('retained-operation')).toEqual(original)
})
