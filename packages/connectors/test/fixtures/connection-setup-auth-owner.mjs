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
const credential = await secrets.store({ operationId: 'auth-saved-credential', secret: 'fixture-auth-saved-bot-secret' })
globalThis.fetch = async (url, init) => {
  const target = new URL(String(url))
  await appendFile(join(root, 'native-effects.ndjson'), JSON.stringify({ method: init?.method, origin: target.origin, path: target.pathname }) + '\n')
  process.send({ kind: 'request-started', path: target.pathname })
  if (mode === 'inflight-poll' && target.pathname === '/accounts/qrlogin/polling') return await new Promise(() => {})
  if (mode === 'observe-only') throw new Error('Recovered original actions cannot issue another native request')
  if (target.pathname === '/accounts/qrlogin/init') return Response.json({ code: 0, data: { step_info: { token: 'fixture-auth-original-token' } } }, { headers: [
    ['x-flow-key', 'fixture-auth-original-flow'], ['set-cookie', 'session=fixture-auth-private-session; Domain=.feishu.cn; Path=/; Secure; HttpOnly']
  ] })
  if (target.pathname === '/accounts/qrlogin/polling') return Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross-login' } } })
  if (target.href === 'https://accounts.feishu.cn/cross-login') return new Response('', { status: 302, headers: { location: 'https://ask.feishu.cn/' } })
  if (target.href === 'https://ask.feishu.cn/') return new Response('Landing text does not establish identity')
  if (target.href === 'https://open.feishu.cn/app') return new Response('<script>window.csrfToken="fixture-auth-private-csrf";window.user={"id":"fixture-auth-stable-user","tenantId":"fixture-auth-stable-tenant"};</script>', { headers: { 'content-type': 'text/html' } })
  throw new Error('Unexpected native authentication endpoint')
}
const connections = new ConnectionHost({ database, secrets, adapters: createBuiltinConnectionAdapters() })
const server = new AgentMuxControlServer({ socketPath: join(root, 'owner.sock'), connections, coreClients: () => { throw new Error('Authentication cannot borrow an Agent Runtime') } })
await server.start(); process.send({ kind: 'ready', credentialRef: credential.credentialRef })
