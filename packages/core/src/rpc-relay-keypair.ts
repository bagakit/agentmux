import { mkdir, readFile, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { generateKeyPair, exportPublicKey, exportSecretKey, importPublicKey, importSecretKey, type KeyPair } from '@agentmux/relay/e2ee'
import { AgentMuxError } from './errors.js'

/** Existing identity bytes are never regenerated after a read/validation failure. */
export async function loadOrCreateRelayKeyPair(path: string): Promise<KeyPair> {
  const read = async (): Promise<KeyPair> => {
    const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    if (!value || Object.keys(value).length !== 3 || value.v !== 2 || typeof value.publicKeyB64 !== 'string' || typeof value.secretKeyB64 !== 'string') {
      throw new AgentMuxError('Relay identity cannot be read. Restore the original file; existing Sessions remain available.', 'CONTROL_PROTOCOL_ERROR')
    }
    return { publicKey: importPublicKey(value.publicKeyB64), secretKey: importSecretKey(value.secretKeyB64) }
  }
  try { return await read() } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const keyPair = generateKeyPair()
  try {
    const file = await open(path, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify({ v: 2, publicKeyB64: exportPublicKey(keyPair.publicKey), secretKeyB64: exportSecretKey(keyPair.secretKey) })+'\n'); await file.sync() }
    finally { await file.close() }
    return keyPair
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return await read()
  }
}
