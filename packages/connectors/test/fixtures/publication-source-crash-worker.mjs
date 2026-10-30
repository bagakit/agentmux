import { openSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { AgentMuxClient, AgentMuxMemoryAgentSessionStore, AgentMuxControlServer, AgentMuxHostedRuntimeService, AgentMuxSpatialStateStore } from '../../../core/dist/index.js'
import { ConnectionHost, RoomBindingHost, PublicationStore, PublicationHost } from '../../dist/index.js'

// Reopen only the existing fixture database. This child never seeds or replaces a record.
const input = JSON.parse(await readFile(process.argv[2], 'utf8'))
const lease = openSync(join(input.directory, 'connections.owner.lock'), 'a+', 0o600)
if (!createRequire(import.meta.url)('fs-native-extensions').tryLock(lease)) throw Error('Original private publication owner still holds its lease')
const database = new DatabaseSync(join(input.directory, 'connections.sqlite'))
const connections = new ConnectionHost({ database, secrets: { resolve: async () => null }, adapters: [] })
const bindings = new RoomBindingHost({ connections, spatial: new AgentMuxSpatialStateStore(input.spatial), checkpoint: async () => { throw Error('No new source discovery in this crash window') } })
const store = new PublicationStore(database, bindings)
const publication = new PublicationHost({ connections, bindings, store, conversation: {} })
connections.bindings = bindings; connections.delivery = publication
const original = store.inspect(input.operationId)
if (!original || original.state !== 'not-applied' || !store.delivery(original).retrySource) throw Error('Original failed effect is not retained')
const retry = store.retry.bind(store)
store.retry = (...args) => {
  const result = retry(...args)
  if (result.accepted && args[0].operationId === input.operationId) {
    writeFileSync(input.witness, JSON.stringify({ pid: process.pid, original, accepted: result, retained: store.inspect(input.operationId) }))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  }
  return result
}
const client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
const owner = { runtimeId: 'private-publication-runtime', ownerInstanceId: randomUUID(), protocolVersion: 2, processId: process.pid, availability: 'connected', ctxmux: null }
const hosted = new AgentMuxHostedRuntimeService(client, null, () => owner)
const server = new AgentMuxControlServer({ socketPath: input.socketPath, connections, coreClients: () => [], hostedRuntime: () => hosted })
await server.start()
process.stdout.write(JSON.stringify({ socketPath: server.path, owner }) + '\n')
