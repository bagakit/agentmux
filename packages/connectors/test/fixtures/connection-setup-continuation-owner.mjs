import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgentMuxControlServer } from '@agentmux/core'
import { ConnectionHost, createBuiltinConnectionAdapters } from '@agentmux/connectors'
import { ConnectionSecrets } from '../../src/connection-secrets.ts'

const root = process.argv[2], mode = process.argv[3]
const database = new DatabaseSync(join(root, 'connections.sqlite'))
const secrets = new ConnectionSecrets(database)
// The original private SQLite owner commits the value before holding its ACK.
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
