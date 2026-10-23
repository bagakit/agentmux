import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto'
import { AgentMuxError, type AgentMuxRpcCallContext } from '@agentmux/core'
import type { ConnectionSecrets } from '@agentmux/connectors'

const PURPOSE = 'amux.connection-credential-entry.v1'
export type CredentialEntryTarget = { runtimeId: string; ownerInstanceId: string }
export type CredentialEntryKey = { purpose: typeof PURPOSE; target: CredentialEntryTarget; keyId: string; publicKey: string; maxBytes: number }
export type SealedCredentialEntry = { operationId: string; target: CredentialEntryTarget; keyId: string; ephemeralPublicKey: string; salt: string; iv: string; tag: string; ciphertext: string }
const fail = (): never => { throw new AgentMuxError('The sealed credential entry is invalid or belongs to another original Host operation. Retain and inspect the original operation.', 'INVALID_CONNECTION_CREDENTIAL_ENTRY') }
function record(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || Object.keys(value).some(field => !fields.includes(field))) return fail()
  return value as Record<string, unknown>
}
function identity(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) return fail(); return value }
function target(value: unknown): CredentialEntryTarget {
  const row = record(value, ['runtimeId', 'ownerInstanceId'])
  return { runtimeId: identity(row.runtimeId), ownerInstanceId: identity(row.ownerInstanceId) }
}
function sameTarget(a: CredentialEntryTarget, b: CredentialEntryTarget): boolean { return a.runtimeId === b.runtimeId && a.ownerInstanceId === b.ownerInstanceId }
function bytes(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/u.test(value)) return fail()
  const result = Buffer.from(value, 'base64url')
  if (result.toString('base64url') !== value || length !== undefined && result.length !== length) return fail()
  return result
}
function publicKey(value: unknown): KeyObject {
  try {
    const key = createPublicKey({ key: bytes(value), format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'x25519' || key.export({ format: 'der', type: 'spki' }).toString('base64url') !== value) return fail()
    return key
  } catch { return fail() }
}
function bound(value: unknown, maxBytes: number): void {
  try { if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || Buffer.byteLength(JSON.stringify(value)) > maxBytes) return fail() } catch { return fail() }
}
function binding(operationId: string, to: CredentialEntryTarget, keyId: string): Buffer { return Buffer.from(JSON.stringify([PURPOSE, operationId, to.runtimeId, to.ownerInstanceId, keyId])) }
function derive(privateKey: KeyObject, peer: KeyObject, salt: Buffer, aad: Buffer): Buffer {
  let shared: Buffer | undefined
  try { shared = diffieHellman({ privateKey, publicKey: peer }); return Buffer.from(hkdfSync('sha256', shared, salt, aad, 32)) }
  catch { return fail() }
  finally { shared?.fill(0) }
}

/** Called only in a trusted CLI/Main client. Plaintext never becomes a public RPC parameter. */
export function sealConnectionCredential(input: { key: CredentialEntryKey; operationId: string; secret: string }): SealedCredentialEntry {
  const description = record(input.key, ['purpose', 'target', 'keyId', 'publicKey', 'maxBytes']), to = target(description.target), operationId = identity(input.operationId)
  if (description.purpose !== PURPOSE || typeof input.secret !== 'string' || !input.secret.length || typeof description.maxBytes !== 'number') return fail()
  const receiver = publicKey(description.publicKey), keyId = createHash('sha256').update(receiver.export({ format: 'der', type: 'spki' })).digest('hex')
  if (description.keyId !== keyId) return fail()
  bound(input.secret, description.maxBytes)
  const plaintext = Buffer.from(JSON.stringify({ purpose: PURPOSE, operationId, target: to, secret: input.secret }))
  const pair = generateKeyPairSync('x25519'), salt = randomBytes(32), iv = randomBytes(12), aad = binding(operationId, to, keyId)
  const key = derive(pair.privateKey, receiver, salt, aad)
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad)
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const sealed: SealedCredentialEntry = { operationId, target: to, keyId, ephemeralPublicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'), salt: salt.toString('base64url'), iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') }
    bound(sealed, description.maxBytes)
    return sealed
  } finally { key.fill(0); plaintext.fill(0) }
}

/** One in-memory encryption key per original Host instance; the original SQLite receipt owns retries. */
export function createCredentialAdministration(options: {
  target: CredentialEntryTarget
  secrets: Pick<ConnectionSecrets, 'store' | 'inspect'>
  /** Borrow the actual receiving transport's frame budget, not a user setting or credential count limit. */
  maxBytes: number
}) {
  const to = target(options.target), pair = generateKeyPairSync('x25519')
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) return fail()
  const encodedKey = pair.publicKey.export({ format: 'der', type: 'spki' }), keyId = createHash('sha256').update(encodedKey).digest('hex')
  const authorized = async (context: AgentMuxRpcCallContext) => {
    context.signal?.throwIfAborted()
    if (context.caller || !context.principal || !['user', 'device'].includes(context.principal.kind) || !context.principal.id || !context.runtimeFence || !sameTarget(context.runtimeFence, to)) {
      throw new AgentMuxError('Credential entry requires the original authenticated person or device on this exact Host instance.', 'CONTROL_PERMISSION_DENIED')
    }
    await context.assertCurrent?.()
    context.signal?.throwIfAborted()
  }
  return {
    key: async (context: AgentMuxRpcCallContext): Promise<CredentialEntryKey> => {
      await authorized(context)
      return { purpose: PURPOSE, target: { ...to }, keyId, publicKey: encodedKey.toString('base64url'), maxBytes: options.maxBytes }
    },
    inspect: async (operationId: string, context: AgentMuxRpcCallContext) => {
      await authorized(context)
      const result = await options.secrets.inspect(identity(operationId))
      await authorized(context)
      return result
    },
    store: async (value: SealedCredentialEntry, context: AgentMuxRpcCallContext): Promise<{ credentialRef: string }> => {
      await authorized(context)
      bound(value, options.maxBytes)
      const sealed = record(value, ['operationId', 'target', 'keyId', 'ephemeralPublicKey', 'salt', 'iv', 'tag', 'ciphertext'])
      const operationId = identity(sealed.operationId), originalTarget = target(sealed.target)
      if (!sameTarget(originalTarget, to) || sealed.keyId !== keyId) return fail()
      const aad = binding(operationId, to, keyId), key = derive(pair.privateKey, publicKey(sealed.ephemeralPublicKey), bytes(sealed.salt, 32), aad)
      let plaintext: Buffer | undefined, input: { operationId: string; secret: string }
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, bytes(sealed.iv, 12)); decipher.setAAD(aad); decipher.setAuthTag(bytes(sealed.tag, 16))
        plaintext = Buffer.concat([decipher.update(bytes(sealed.ciphertext)), decipher.final()])
        const original = record(JSON.parse(plaintext.toString('utf8')), ['purpose', 'operationId', 'target', 'secret'])
        if (original.purpose !== PURPOSE || original.operationId !== operationId || !sameTarget(target(original.target), to) || typeof original.secret !== 'string' || !original.secret.length) return fail()
        input = { operationId, secret: original.secret }
      } catch { return fail() }
      finally { key.fill(0); plaintext?.fill(0) }
      await authorized(context)
      return await options.secrets.store(input, () => authorized(context))
    }
  }
}
