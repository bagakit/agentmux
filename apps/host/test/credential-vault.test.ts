import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto'
import { AgentMuxError } from '@agentmux/core'
import { ConnectionSecrets } from '../../../packages/connectors/src/connection-secrets.js'
import { createHostCredentialEncryption } from '../src/credential-encryption.js'
import { createCredentialAdministration, sealConnectionCredential } from '../src/credential-administration.js'

const resources: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of resources.splice(0).reverse()) await close() })
function keyring() {
  let key: number[] | null = null, denied = false
  const entry = { getSecret: vi.fn(async () => { if (denied) throw Error('private OS detail'); return key && [...key] }),
    setSecret: vi.fn(async (value: Uint8Array) => { if (denied) throw Error('private OS detail'); key = [...value] }) }
  return { entry, get key() { return key && [...key] }, replace(value: number[] | null) { key = value && [...value] }, deny(value = true) { denied = value } }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amux-credential-vault-')); resources.push(() => rm(root, { recursive: true, force: true }))
  const database = new DatabaseSync(join(root, 'connections.sqlite')); resources.push(() => database.close())
  const backend = keyring(), encryption = createHostCredentialEncryption({ database, namespace: root, keyring: async () => backend.entry })
  const secrets = new ConnectionSecrets(database, encryption)
  const target = { runtimeId: 'original-runtime', ownerInstanceId: 'original-instance' }, context = { principal: { kind: 'user' as const, id: 'original-person' }, runtimeFence: target }
  const administration = createCredentialAdministration({ target, secrets, maxBytes: 8192 })
  return { root, database, backend, encryption, secrets, target, context, administration }
}
const original = { operationId: 'original-operation', secret: 'synthetic-private-credential-你好' }

it('reopens the same SQLite operation/ref through the real Node AES-GCM adapter without storing plaintext', async () => {
  const f = await fixture(), receipt = await f.secrets.store(original)
  const row = f.database.prepare('SELECT * FROM connection_credential').get()!
  expect(Buffer.from(row.ciphertext as Uint8Array).includes(Buffer.from(original.secret))).toBe(false)
  expect(await f.secrets.resolve(receipt.credentialRef)).toBe(original.secret)
  const reopened = new ConnectionSecrets(f.database, createHostCredentialEncryption({ database: f.database, namespace: f.root, keyring: async () => f.backend.entry }))
  expect(await reopened.inspect(original.operationId)).toEqual(receipt)
  expect(await reopened.store(original)).toEqual(receipt)
  expect(await reopened.resolve(receipt.credentialRef)).toBe(original.secret)
  expect(f.database.prepare('SELECT * FROM connection_credential').get()).toEqual(row)
  expect(f.backend.entry.setSecret).toHaveBeenCalledTimes(1)
})

it('serializes original master initialization and converges concurrent same-operation stores', async () => {
  const f = await fixture(), results = await Promise.all(Array.from({ length: 8 }, () => f.secrets.store(original)))
  expect(results.every(receipt => receipt.credentialRef === results[0]!.credentialRef)).toBe(true)
  expect(f.backend.entry.setSecret).toHaveBeenCalledTimes(1)
  expect(f.database.prepare('SELECT COUNT(*) AS n FROM connection_credential').get()!.n).toBe(1)
  await expect(f.secrets.store({ ...original, secret: 'different input' })).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
  expect(await f.secrets.resolve(results[0]!.credentialRef)).toBe(original.secret)
})

it('keeps a committed original operation inspectable after its commit acknowledgement is lost', async () => {
  const f = await fixture(), exec = f.database.exec.bind(f.database)
  let lost = true
  vi.spyOn(f.database, 'exec').mockImplementation(sql => { exec(sql); if (sql === 'COMMIT' && lost) { lost = false; throw Error('fixture commit ACK lost') } })
  await expect(f.secrets.store(original)).rejects.toMatchObject({ code: 'CONNECTION_CREDENTIAL_UNCONFIRMED' })
  const receipt = await f.secrets.inspect(original.operationId)
  expect(receipt).not.toBeNull()
  expect(await f.secrets.store(original)).toEqual(receipt)
  expect(f.database.prepare('SELECT COUNT(*) AS n FROM connection_credential').get()!.n).toBe(1)
})

it.each(['namespace', 'ciphertext', 'tag'] as const)('refuses %s tampering while retaining exact ciphertext', async kind => {
  const f = await fixture(), receipt = await f.secrets.store(original), row = f.database.prepare('SELECT ciphertext FROM connection_credential').get()!
  const encrypted = Buffer.from(row.ciphertext as Uint8Array)
  if (kind === 'namespace') {
    const foreign = createHostCredentialEncryption({ database: f.database, namespace: 'foreign-namespace', keyring: async () => f.backend.entry })
    await expect(foreign.decryptStringAsync(encrypted)).rejects.toMatchObject({ code: 'CONNECTION_CREDENTIAL_UNAVAILABLE' })
  } else {
    encrypted[kind === 'tag' ? encrypted.length - Buffer.byteLength(original.secret) - 1 : encrypted.length - 1]! ^= 1
    await expect(f.encryption.decryptStringAsync(encrypted)).rejects.toMatchObject({ code: 'CONNECTION_CREDENTIAL_UNAVAILABLE' })
  }
  expect(f.database.prepare('SELECT ciphertext FROM connection_credential').get()).toEqual(row)
  expect(await f.secrets.resolve(receipt.credentialRef)).toBe(original.secret)
})

it('does not cache a plaintext master key over backend denial, key loss or malformed key data', async () => {
  const f = await fixture(), receipt = await f.secrets.store(original), key = f.backend.key, row = f.database.prepare('SELECT * FROM connection_credential').get()
  f.backend.deny()
  await expect(f.secrets.resolve(receipt.credentialRef)).rejects.toMatchObject({ code: 'CONNECTION_CREDENTIAL_UNAVAILABLE' })
  expect(await f.secrets.inspect(original.operationId)).toEqual(receipt)
  f.backend.deny(false)
  for (const invalid of [null, [1, 2], Array(32).fill(256)]) {
    f.backend.replace(invalid)
    await expect(f.secrets.resolve(receipt.credentialRef)).rejects.toMatchObject({ code: 'CONNECTION_CREDENTIAL_UNAVAILABLE' })
    expect(f.backend.entry.setSecret).toHaveBeenCalledTimes(1)
  }
  f.backend.replace(key)
  expect(await f.secrets.resolve(receipt.credentialRef)).toBe(original.secret)
  expect(f.database.prepare('SELECT * FROM connection_credential').get()).toEqual(row)
})

it('retains unsupported original ciphertext and never creates a replacement key for existing data', async () => {
  const f = await fixture(), bytes = Buffer.from('synthetic-unsupported-original-ciphertext')
  f.database.prepare('INSERT INTO connection_credential VALUES (?,?,?)').run('original-ref', 'old-operation', bytes)
  await expect(f.encryption.decryptStringAsync(bytes)).rejects.toMatchObject({ code: 'CONNECTION_CREDENTIAL_FORMAT_UNSUPPORTED' })
  await expect(f.secrets.resolve('original-ref')).rejects.toMatchObject({ code: 'CONNECTION_CREDENTIAL_UNAVAILABLE' })
  expect(f.backend.entry.setSecret).not.toHaveBeenCalled()
  expect(await f.secrets.inspect('old-operation')).toEqual({ credentialRef: 'original-ref' })
  expect(Buffer.from(f.database.prepare('SELECT ciphertext FROM connection_credential').get()!.ciphertext as Uint8Array)).toEqual(bytes)
})

it('pins the real Linux adapter to persistent Secret Service rather than the library fallback', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!, calls: unknown[] = []
  let key: number[] | null = null
  vi.doMock('@napi-rs/keyring', () => ({ AsyncEntry: class {
    constructor(service: string, account: string, options: unknown) { calls.push({ service, account, options }) }
    async getSecret() { return key && [...key] }
    async setSecret(bytes: Uint8Array) { key = [...bytes] }
  } }))
  const database = new DatabaseSync(':memory:')
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' })
    const secrets = new ConnectionSecrets(database, createHostCredentialEncryption({ database, namespace: 'synthetic-linux-adapter' }))
    expect(await secrets.resolve((await secrets.store(original)).credentialRef)).toBe(original.secret)
    expect(calls).toEqual([{ service: 'dev.agentmux.connection-vault', account: expect.stringMatching(/^[a-f0-9]{64}$/u), options: { linux: { store: 'secret-service' } } }])
  } finally { Object.defineProperty(process, 'platform', descriptor); database.close(); vi.doUnmock('@napi-rs/keyring') }
})

it('leaves the original SQLite writer and inspection available while OS master creation waits', async () => {
  const f = await fixture(), set = f.backend.entry.setSecret.getMockImplementation()!
  let release!: () => void, entered!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  f.backend.entry.setSecret.mockImplementation(async value => { entered(); await waiting; await set(value) })
  const pending = f.secrets.store(original)
  await started
  expect(await f.secrets.inspect(original.operationId)).toBeNull()
  expect(() => { f.database.exec('BEGIN IMMEDIATE'); f.database.exec('ROLLBACK') }).not.toThrow()
  release()
  expect(await f.secrets.resolve((await pending).credentialRef)).toBe(original.secret)
})

it('seals a trusted entry to its exact Host operation and returns only the retained reference', async () => {
  const f = await fixture(), key = await f.administration.key(f.context), sealed = sealConnectionCredential({ key, ...original })
  expect(JSON.stringify(sealed)).not.toContain(original.secret)
  const receipt = await f.administration.store(sealed, f.context)
  expect(Object.keys(receipt)).toEqual(['credentialRef'])
  expect(await f.administration.inspect(original.operationId, f.context)).toEqual(receipt)
  expect(await f.secrets.resolve(receipt.credentialRef)).toBe(original.secret)
  expect(await f.administration.store(sealConnectionCredential({ key, ...original }), f.context)).toEqual(receipt)
  await expect(f.administration.store(sealConnectionCredential({ key, ...original, secret: 'changed' }), f.context)).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
})

it.each(['operationId', 'target', 'keyId', 'ephemeralPublicKey', 'salt', 'iv', 'tag', 'ciphertext'] as const)('refuses altered sealed %s before the credential effect', async field => {
  const f = await fixture(), key = await f.administration.key(f.context), sealed = sealConnectionCredential({ key, ...original })
  const altered = { ...sealed, [field]: field === 'target' ? { ...f.target, runtimeId: 'foreign-runtime' } : field === 'operationId' ? 'foreign-operation' : field === 'keyId' ? '0'.repeat(64) : 'AA' }
  await expect(f.administration.store(altered, f.context)).rejects.toMatchObject({ code: 'INVALID_CONNECTION_CREDENTIAL_ENTRY' })
  expect(await f.secrets.inspect(original.operationId)).toBeNull()
  expect(f.backend.entry.setSecret).not.toHaveBeenCalled()
})

it.each(['purpose', 'operationId', 'target'] as const)('rejects a cryptographically valid seal whose inner %s is another operation', async field => {
  const f = await fixture(), description = await f.administration.key(f.context), operationId = original.operationId
  const pair = generateKeyPairSync('x25519'), peer = createPublicKey({ key: Buffer.from(description.publicKey, 'base64url'), format: 'der', type: 'spki' })
  const salt = randomBytes(32), iv = randomBytes(12), aad = Buffer.from(JSON.stringify([description.purpose, operationId, f.target.runtimeId, f.target.ownerInstanceId, description.keyId]))
  const shared = diffieHellman({ privateKey: pair.privateKey, publicKey: peer }), key = Buffer.from(hkdfSync('sha256', shared, salt, aad, 32))
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad)
  const body = { purpose: description.purpose, operationId, target: f.target, secret: original.secret, [field]: field === 'target' ? { ...f.target, runtimeId: 'inner-foreign-runtime' } : 'inner-foreign-value' }
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(body), 'utf8'), cipher.final()]); shared.fill(0); key.fill(0)
  const sealed = { operationId, target: f.target, keyId: description.keyId, ephemeralPublicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'), salt: salt.toString('base64url'), iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') }
  await expect(f.administration.store(sealed, f.context)).rejects.toMatchObject({ code: 'INVALID_CONNECTION_CREDENTIAL_ENTRY' })
  expect(await f.secrets.inspect(operationId)).toBeNull()
  expect(f.backend.entry.setSecret).not.toHaveBeenCalled()
})

it.each(['anonymous', 'agent', 'foreign-fence'] as const)('refuses %s credential administration without touching the secure backend', async kind => {
  const f = await fixture(), sealed = sealConnectionCredential({ key: await f.administration.key(f.context), ...original })
  const context = kind === 'anonymous' ? {} : kind === 'agent' ? { ...f.context, caller: { agentSessionId: 'managed-agent', capability: 'fixture' } } : { ...f.context, runtimeFence: { ...f.target, runtimeId: 'foreign-runtime' } }
  await expect(f.administration.key(context)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(f.administration.store(sealed, context)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(f.administration.inspect(original.operationId, context)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(f.backend.entry.getSecret).not.toHaveBeenCalled()
})

it('retains the original write across owner restart while refusing an old instance seal', async () => {
  const f = await fixture(), key = await f.administration.key(f.context), sealed = sealConnectionCredential({ key, ...original }), receipt = await f.administration.store(sealed, f.context)
  const target = { ...f.target, ownerInstanceId: 'restarted-instance' }, context = { ...f.context, runtimeFence: target }, reopened = createCredentialAdministration({ target, secrets: f.secrets, maxBytes: 8192 })
  await expect(reopened.store(sealed, context)).rejects.toMatchObject({ code: 'INVALID_CONNECTION_CREDENTIAL_ENTRY' })
  expect(await reopened.inspect(original.operationId, context)).toEqual(receipt)
  expect(await reopened.store(sealConnectionCredential({ key: await reopened.key(context), ...original }), context)).toEqual(receipt)
})

it('checks current administration again after OS authorization waits, before any SQLite credential write', async () => {
  const f = await fixture(), sealed = sealConnectionCredential({ key: await f.administration.key(f.context), ...original }), set = f.backend.entry.setSecret.getMockImplementation()!
  let release!: () => void, entered!: () => void, current = true
  const waiting = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  f.backend.entry.setSecret.mockImplementation(async value => { entered(); await waiting; await set(value) })
  const context = { ...f.context, assertCurrent: () => { if (!current) throw new AgentMuxError('revoked', 'CONTROL_PERMISSION_DENIED') } }
  const outcome = f.administration.store(sealed, context).catch(error => error)
  await started; current = false; release()
  expect(await outcome).toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(await f.secrets.inspect(original.operationId)).toBeNull()
})

it('uses the actual receiving budget and rejects raw or oversized entry shapes', async () => {
  const f = await fixture(), key = await f.administration.key(f.context)
  expect(() => sealConnectionCredential({ key: { ...key, maxBytes: 100 }, ...original })).toThrow()
  await expect(f.administration.store({ ...sealConnectionCredential({ key, ...original }), secret: original.secret }, f.context)).rejects.toMatchObject({ code: 'INVALID_CONNECTION_CREDENTIAL_ENTRY' })
  await expect(f.administration.store({ ...sealConnectionCredential({ key, ...original }), ciphertext: 'A'.repeat(8193) }, f.context)).rejects.toMatchObject({ code: 'INVALID_CONNECTION_CREDENTIAL_ENTRY' })
  expect(f.backend.entry.setSecret).not.toHaveBeenCalled()
})
