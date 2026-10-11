import { appendFile } from 'node:fs/promises'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgentMuxControlServer } from '@agentmux/core'
import { ConnectionHost, createBuiltinConnectionAdapters } from '@agentmux/connectors'
import { DesktopConnectorSecrets } from '../../../../apps/desktop/src/main/connector-secrets.ts'

const root = process.argv[2], mode = process.argv[3], key = Buffer.alloc(32, 9)
const database = new DatabaseSync(join(root, 'connections.sqlite'))
const secrets = new DesktopConnectorSecrets(database, { isEncryptionAvailable: () => true,
  encryptString: value => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]) },
  decryptString: value => { const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString() }
})
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
