import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgentMuxControlServer } from '@agentmux/core'
import { ConnectionHost, createBuiltinConnectionAdapters } from '@agentmux/connectors'
import { ConnectionSecrets } from '../../src/connection-secrets.ts'

const root = process.argv[2], mode = process.argv[3]
const database = new DatabaseSync(join(root, 'connections.sqlite'))
const secrets = new ConnectionSecrets(database)
const store = secrets.store.bind(secrets)
secrets.store = async input => {
  const receipt = await store(input)
  if (mode === 'stored-ack' && input.operationId.startsWith('connection-setup-effect:')) { process.send({ kind: 'stored-ack', credentialRef: receipt.credentialRef }); return await new Promise(() => {}) }
  return receipt
}
globalThis.fetch = async (url, init) => {
  const target = new URL(String(url))
  await appendFile(join(root, 'message-writes.ndjson'), JSON.stringify({ path: target.pathname, body: JSON.parse(String(init.body)) }) + '\n')
  if (mode === 'recover' || target.href !== 'https://open.feishu.cn/developers/v1/event/update/cli_message_reception_original') throw new Error('Only the original explicit message addition is allowed')
  process.send({ kind: 'native-dispatched' })
  if (mode === 'native-inflight') return await new Promise(() => {})
  return Response.json({ code: 0, data: {} })
}
const connections = new ConnectionHost({ database, secrets, adapters: mode === 'recover' ? [] : createBuiltinConnectionAdapters() })
const server = new AgentMuxControlServer({ socketPath: join(root, 'owner.sock'), connections, coreClients: () => { throw new Error('Message reception cannot borrow an Agent Runtime') } })
await server.start(); process.send({ kind: 'ready' })
