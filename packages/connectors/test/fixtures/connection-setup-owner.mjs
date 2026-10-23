import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgentMuxControlServer } from '@agentmux/core'
import { ConnectionHost, createBuiltinConnectionAdapters } from '@agentmux/connectors'
import { ConnectionSecrets } from '../../src/connection-secrets.ts'

const root = process.argv[2], mode = process.argv[3]
const database = new DatabaseSync(join(root, 'connections.sqlite'))
const secrets = new ConnectionSecrets(database)
const credential = await secrets.store({ operationId: 'saved-bot-credential', secret: 'fixture-existing-bot-secret' })
globalThis.fetch = async (url, init) => {
  await appendFile(join(root, 'native-effects.ndjson'), JSON.stringify({ method: init?.method, path: new URL(String(url)).pathname }) + '\n')
  process.send({ kind: 'request-started' })
  if (mode === 'inflight') return await new Promise(() => {})
  if (mode !== 'respond') throw new Error('Recovered operations cannot issue another native request')
  return Response.json({ code: 0, data: { step_info: { token: 'fixture-original-qr-token' } } }, { headers: [
    ['x-flow-key', 'fixture-original-flow-key'],
    ['set-cookie', 'fixture-session=original-private-cookie; Secure; HttpOnly; Path=/'],
    ['set-cookie', 'fixture-route=original-route; Secure; Path=/accounts']
  ] })
}
const connections = new ConnectionHost({ database, secrets, adapters: createBuiltinConnectionAdapters() })
const server = new AgentMuxControlServer({ socketPath: join(root, 'owner.sock'), connections, coreClients: () => { throw new Error('Management challenge cannot borrow an Agent Runtime') } })
await server.start(); process.send({ kind: 'ready', credentialRef: credential.credentialRef })
