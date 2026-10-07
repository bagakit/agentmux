import { appendFile } from 'node:fs/promises'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgentMuxControlServer } from '@agentmux/core'
import { ConnectionHost } from '@agentmux/connectors'
import { DesktopConnectorSecrets } from '../../../../apps/desktop/src/main/connector-secrets.ts'

const root = process.argv[2], mode = process.argv[3], key = Buffer.alloc(32, 9)
const database = new DatabaseSync(join(root, 'connections.sqlite'))
const secrets = new DesktopConnectorSecrets(database, { isEncryptionAvailable: () => true,
  encryptString: value => { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), bytes]) },
  decryptString: value => { const c = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); c.setAuthTag(value.subarray(12, 28)); return Buffer.concat([c.update(value.subarray(28)), c.final()]).toString() }
})
async function unknown(kind, input) { await appendFile(join(root, 'effects'), kind + ':' + input.attemptId + '\n'); process.send({ kind: 'effect-applied' }); return await new Promise(() => {}) }
const connections = new ConnectionHost({ database, secrets, adapters: [{ adapterId: 'challenge', test: async () => { throw new Error('No connection test in this process fixture') }, enrollment: {
  domains: [{ domain: 'challenge.example', label: 'Challenge' }],
  begin: input => mode === 'begin' ? unknown('begin', input) : mode === 'poll' ? Promise.resolve({ kind: 'pending', verificationUrl: 'https://challenge.example/verify', expiresInMs: null, pollIntervalMs: 0, privateState: 'original-private-state' }) : Promise.reject(new Error('No recovered begin is permitted')),
  poll: input => mode === 'poll' ? unknown('poll', input) : Promise.reject(new Error('No recovered poll is permitted'))
} }] })
const server = new AgentMuxControlServer({ socketPath: join(root, 'owner.sock'), connections, coreClients: () => [] })
await server.start(); process.send({ kind: 'ready' })
