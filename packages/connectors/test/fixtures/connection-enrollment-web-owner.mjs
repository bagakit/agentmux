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
  encryptString: value => { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv), bytes = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), bytes]) },
  decryptString: value => { const c = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); c.setAuthTag(value.subarray(12, 28)); return Buffer.concat([c.update(value.subarray(28)), c.final()]).toString() }
})
// The original private OS-encryption boundary, with real ciphertext and a held ACK.
const store = secrets.store.bind(secrets)
secrets.store = async input => {
  const receipt = await store(input)
  let snapshot; try { snapshot = JSON.parse(input.secret) } catch { /* Opaque app credential. */ }
  if (mode === 'secure-created' && snapshot?.kind === 'create') { process.send({ kind: mode }); return await new Promise(() => {}) }
  return receipt
}
globalThis.fetch = async (url, options) => {
  const target = new URL(String(url)), row = JSON.parse(String(database.prepare('SELECT record_json FROM connection_enrollment WHERE operation_id=?').get('web-child-original').record_json))
  await appendFile(join(root, 'native-effects.ndjson'), JSON.stringify({ path: target.pathname, attemptId: row.attemptId }) + '\n')
  if (mode === 'observe-only' || mode === 'credential-only' && target.pathname !== '/developers/v1/secret/cli_web_original') throw new Error('No unrelated native replay after owner replacement')
  if (mode === 'inflight-create' && target.pathname === '/developers/v1/app/create') { process.send({ kind: mode }); return await new Promise(() => {}) }
  if (target.pathname === '/accounts/qrlogin/init') return Response.json({ code: 0, data: { step_info: { token: 'web-original-private-qr' } } }, { headers: { 'x-flow-key': 'web-original-private-flow', 'set-cookie': 'session=web-original-private-session; Domain=.feishu.cn; Path=/; Secure' } })
  if (target.pathname === '/accounts/qrlogin/polling') return Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross' } } })
  if (target.href === 'https://accounts.feishu.cn/cross') return new Response(null, { status: 302, headers: { location: 'https://ask.feishu.cn/' } })
  if (target.href === 'https://ask.feishu.cn/') return new Response('Landing is not account identity')
  if (target.href === 'https://open.feishu.cn/app') return new Response('<script>window.user={"id":"web-original-user","tenantId":"web-original-tenant"};window.csrfToken="web-original-private-csrf";</script>', { headers: { 'content-type': 'text/html' } })
  if (target.pathname === '/developers/v1/app/upload/image') return Response.json({ code: 0, data: { url: 'https://images.example.test/original.png' } })
  if (target.pathname === '/developers/v1/app/create') return Response.json({ code: 0, data: { ClientID: 'cli_web_original' } })
  if (target.pathname === '/developers/v1/secret/cli_web_original') return Response.json({ code: 0, data: { secret: 'web-original-private-secret' } })
  throw new Error('Unexpected native creation path')
}
const connections = new ConnectionHost({ database, secrets, adapters: createBuiltinConnectionAdapters() })
const server = new AgentMuxControlServer({ socketPath: join(root, 'owner.sock'), connections, coreClients: () => { throw new Error('Enrollment cannot borrow an Agent Runtime') } })
await server.start(); process.send({ kind: 'ready' })
