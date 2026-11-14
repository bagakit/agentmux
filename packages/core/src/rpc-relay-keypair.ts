import { mkdir, readFile, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { deriveSharedKey } from '@agentmux/relay'
import { generateKeyPair, exportPublicKey, exportSecretKey, importPublicKey, importSecretKey, type KeyPair } from '@agentmux/relay/e2ee'
import { AgentMuxError } from './errors.js'

export type RelayKeyPairOptions = {
  signal?: AbortSignal
  /** The original endpoint/publication owner decides whether this is genuinely first use. */
  createIfMissing?: boolean
  /** Only actual creation/write/sync work, never a pending read observation. */
  observeMutation?(work: Promise<void>): void
}
/** Existing identity bytes are never regenerated after a read/validation failure. */
export async function loadOrCreateRelayKeyPair(path: string, options: RelayKeyPairOptions = {}): Promise<KeyPair> {
  const unavailable = () => new AgentMuxError('Relay identity is unconfirmed. Preserve its original key file and restore the original bytes; existing Sessions remain retained.', 'CONTROL_PROTOCOL_ERROR')
  const read = async (): Promise<KeyPair> => {
    try {
      const value = JSON.parse(await readFile(path, { encoding: 'utf8', ...(options.signal ? { signal: options.signal } : {}) })) as Record<string, unknown>
      if (!value || Object.keys(value).length !== 3 || value.v !== 2 || typeof value.publicKeyB64 !== 'string' || typeof value.secretKeyB64 !== 'string') throw unavailable()
      const pair = { publicKey: importPublicKey(value.publicKeyB64), secretKey: importSecretKey(value.secretKeyB64) }
      if (exportPublicKey(pair.publicKey) !== value.publicKeyB64 || exportSecretKey(pair.secretKey) !== value.secretKeyB64) throw unavailable()
      // Reuse the package's actual key agreement; a malformed public/private pair
      // cannot be adopted as the endpoint's original public binding.
      const probe = generateKeyPair()
      if (!timingSafeEqual(deriveSharedKey(pair.secretKey, probe.publicKey), deriveSharedKey(probe.secretKey, pair.publicKey))) throw unavailable()
      return pair
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error; throw unavailable() }
  }
  try { return await read() } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (options.createIfMissing === false) throw unavailable()
  options.signal?.throwIfAborted()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  options.signal?.throwIfAborted()
  const keyPair = generateKeyPair()
  // Once wx has dispatched namespace creation this owner finishes and syncs the
  // exact key before releasing its mutation lease. Cancellation cannot invent a
  // replacement or leave another owner racing a late write.
  const mutation = (async () => {
    const file = await open(path, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify({ v: 2, publicKeyB64: exportPublicKey(keyPair.publicKey), secretKeyB64: exportSecretKey(keyPair.secretKey) }) + '\n'); await file.sync() }
    finally { await file.close() }
    const directory = await open(dirname(path), 'r')
    try { await directory.sync() } finally { await directory.close() }
  })()
  options.observeMutation?.(mutation)
  try { await mutation; return keyPair }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return await read(); throw unavailable() }
}
