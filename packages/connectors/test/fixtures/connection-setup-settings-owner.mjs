import { appendFile } from 'node:fs/promises'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgentMuxControlServer } from '@agentmux/core'
import { ConnectionHost, createBuiltinConnectionAdapters } from '@agentmux/connectors'
import { ConnectionSecrets } from '../../src/connection-secrets.ts'

const root = process.argv[2], mode = process.argv[3], key = Buffer.alloc(32, 13)
const database = new DatabaseSync(join(root, 'connections.sqlite'))
const secrets = new ConnectionSecrets(database, {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async value => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]) },
  decryptStringAsync: async value => { const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return { result: (Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString()), shouldReEncrypt: false } }
})
let readStarted = false
const originalStore = ConnectionSecrets.prototype.store
ConnectionSecrets.prototype.store = async function(input) {
  const receipt = await originalStore.call(this, input)
  // Hold only the actual committed Vault ACK; the original durable bytes already exist.
  if (mode === 'vault-committed' && readStarted) { process.send({ kind: 'vault-committed' }); return await new Promise(() => {}) }
  return receipt
}
const credential = await secrets.store({ operationId: 'settings-child-credential', secret: 'fixture-settings-saved-secret' })
globalThis.fetch = async (url, init) => {
  const target = new URL(String(url))
  await appendFile(join(root, 'native-effects.ndjson'), JSON.stringify({ method: init?.method, origin: target.origin, path: target.pathname, body: init?.body ?? null }) + '\n')
  if (mode === 'observe-only') throw new Error('Original settings recovery must not dispatch native work')
  if (target.pathname === '/accounts/qrlogin/init') return Response.json({ code: 0, data: { step_info: { token: 'fixture-settings-qr-token' } } }, { headers: [['x-flow-key', 'fixture-settings-flow-key'], ['set-cookie', 'session=fixture-settings-session-cookie; Domain=.feishu.cn; Path=/; Secure; HttpOnly']] })
  if (target.pathname === '/accounts/qrlogin/polling') return Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross-login' } } })
  if (target.href === 'https://accounts.feishu.cn/cross-login') return new Response('', { status: 302, headers: { location: 'https://ask.feishu.cn/' } })
  if (target.href === 'https://ask.feishu.cn/') return new Response('Landing text is not identity')
  if (target.href === 'https://open.feishu.cn/app') return new Response('<script>window.csrfToken="fixture-settings-csrf-a";window.user={"id":"fixture-settings-user-a","tenantId":"fixture-settings-tenant-a"};</script>', { headers: { 'content-type': 'text/html' } })
  if (target.href === 'https://open.feishu.cn/developers/v1/event/cli_settings_original_bot') {
    readStarted = true; process.send({ kind: 'read-started' })
    if (mode === 'inflight') return await new Promise(() => {})
    return Response.json({ code: 0, data: { eventMode: 4, encryptionKey: 'fixture-settings-private-event-settings', eventDetails: [] } })
  }
  throw new Error('Unexpected settings fixture native endpoint')
}
const connections = new ConnectionHost({ database, secrets, adapters: mode === 'observe-only' ? [] : createBuiltinConnectionAdapters() })
const server = new AgentMuxControlServer({ socketPath: join(root, 'owner.sock'), connections, coreClients: () => { throw new Error('Settings reads cannot borrow an Agent Runtime') } })
await server.start(); process.send({ kind: 'ready', credentialRef: credential.credentialRef })
