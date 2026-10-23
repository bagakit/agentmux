import { appendFile } from 'node:fs/promises'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { AgentMuxControlServer } from '@agentmux/core'
import { DatabaseSync } from 'node:sqlite'
import { ConnectionHost, createBuiltinConnectionAdapters } from '@agentmux/connectors'
import { ConnectionSecrets } from '../../src/connection-secrets.ts'

const root = process.argv[2], mode = process.argv[3], key = Buffer.alloc(32, 17)
const encryption = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async value => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]) },
  decryptStringAsync: async value => { const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return { result: (Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString()), shouldReEncrypt: false } }
}
let effectStarted = false
const originalStore = ConnectionSecrets.prototype.store
ConnectionSecrets.prototype.store = async function(input) {
  const receipt = await originalStore.call(this, input)
  // This window holds only the real committed Vault ACK; no journal rows are fabricated.
  if (mode === 'vault-committed' && effectStarted) { process.send({ kind: 'vault-committed' }); return await new Promise(() => {}) }
  return receipt
}
globalThis.fetch = async (url, init) => {
  const target = new URL(String(url))
  await appendFile(join(root, 'native-effects.ndjson'), JSON.stringify({ method: init?.method, origin: target.origin, path: target.pathname, body: init?.body ?? null }) + '\n')
  if (mode === 'observe-only') throw new Error('Original effect recovery must not dispatch native work')
  if (target.pathname === '/accounts/qrlogin/init') return Response.json({ code: 0, data: { step_info: { token: 'fixture-configuration-qr-token' } } }, { headers: [['x-flow-key', 'fixture-configuration-flow-key'], ['set-cookie', 'session=fixture-configuration-session-cookie; Domain=.feishu.cn; Path=/; Secure; HttpOnly']] })
  if (target.pathname === '/accounts/qrlogin/polling') return Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross-login' } } })
  if (target.href === 'https://accounts.feishu.cn/cross-login') return new Response('', { status: 302, headers: { location: 'https://ask.feishu.cn/' } })
  if (target.href === 'https://ask.feishu.cn/') return new Response('Landing text is not identity')
  if (target.href === 'https://open.feishu.cn/app') return new Response('<script>window.csrfToken="fixture-configuration-csrf-a";window.user={"id":"fixture-configuration-user-a","tenantId":"fixture-configuration-tenant-a"};</script>', { headers: { 'content-type': 'text/html' } })
  if (target.href === 'https://open.feishu.cn/developers/v1/robot/cli_configuration_original_bot') return Response.json({ code: 0, data: { enable: false, verificationToken: 'fixture-configuration-private-read' } })
  if (target.href === 'https://open.feishu.cn/developers/v1/robot/switch/cli_configuration_original_bot') {
    effectStarted = true; process.send({ kind: 'effect-started' })
    if (mode === 'inflight') return await new Promise(() => {})
    return Response.json({ code: 0, data: { privateReceipt: 'fixture-configuration-private-effect' } })
  }
  throw new Error('Unexpected configuration fixture native endpoint')
}
const database = new DatabaseSync(join(root, 'connections.sqlite')), secrets = new ConnectionSecrets(database, encryption)
const connections = new ConnectionHost({ database, secrets, adapters: mode === 'observe-only' ? [] : createBuiltinConnectionAdapters() })
// A restart must consume original credentials and owner data, never seed a replacement.
const credential = mode === 'observe-only' ? null : await secrets.store({ operationId: 'configuration-child-credential', secret: 'fixture-configuration-saved-secret' })
const server = new AgentMuxControlServer({ socketPath: join(root, 'owner.sock'), connections, coreClients: () => { throw new Error('Configuration cannot borrow an Agent Runtime') } })
await server.start(); process.send({ kind: 'ready', credentialRef: credential?.credentialRef ?? null })
