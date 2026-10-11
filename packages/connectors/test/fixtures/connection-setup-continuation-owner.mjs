import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgentMuxControlServer } from '@agentmux/core'
import { ConnectionHost, createBuiltinConnectionAdapters } from '@agentmux/connectors'
import { DesktopConnectorSecrets } from '../../../../apps/desktop/src/main/connector-secrets.ts'

const root = process.argv[2], mode = process.argv[3], key = Buffer.alloc(32, 9)
const database = new DatabaseSync(join(root, 'connections.sqlite'))
const secrets = new DesktopConnectorSecrets(database, {
  isEncryptionAvailable: () => true,
  encryptString: value => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv), bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]) },
  decryptString: value => { const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString() }
})
// This OS-encryption boundary stores real authenticated ciphertext before holding its ACK.
const store = secrets.store.bind(secrets)
secrets.store = async input => {
  const receipt = await store(input)
  if (mode === 'hold-ack' && input.operationId.startsWith('connection-setup-auth:')) {
    process.send({ kind: 'stored', credentialRef: receipt.credentialRef })
    return await new Promise(() => {})
  }
  return receipt
}
globalThis.fetch = async () => { process.send({ kind: 'unexpected-http' }); throw new Error('Local continuation must not issue a platform request') }
// Once safely bound, neither the old source nor its adapter is an availability lease.
if (mode === 'recover') database.exec('ALTER TABLE connection_enrollment RENAME TO enrollment_source_unavailable')
const connections = new ConnectionHost({ database, secrets, adapters: mode === 'recover' ? [] : createBuiltinConnectionAdapters() })
const server = new AgentMuxControlServer({ socketPath: join(root, 'owner.sock'), connections, coreClients: () => { throw new Error('Local continuation cannot borrow an Agent Runtime') } })
await server.start(); process.send({ kind: 'ready' })
