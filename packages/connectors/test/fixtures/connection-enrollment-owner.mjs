import { appendFile } from 'node:fs/promises'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgentMuxControlServer } from '@agentmux/core'
import { ConnectionHost } from '@agentmux/connectors'
import { ConnectionSecrets } from '../../src/connection-secrets.ts'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../../test/fixture-values.mjs'


const root = process.argv[2], mode = process.argv[3], key = Buffer.alloc(32, 9)
const database = new DatabaseSync(join(root, 'connections.sqlite'))
const secrets = new ConnectionSecrets(database, { isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async value => { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), bytes]) },
  decryptStringAsync: async value => { const c = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); c.setAuthTag(value.subarray(12, 28)); return { result: (Buffer.concat([c.update(value.subarray(28)), c.final()]).toString()), shouldReEncrypt: false } }
})
async function unknown(kind, input) { await appendFile(join(root, 'effects'), kind + ':' + input.attemptId + '\n'); process.send({ kind: 'effect-applied' }); return await new Promise(() => {}) }
const connections = new ConnectionHost({ database, secrets, adapters: [{ adapterId: 'challenge', test: async () => { throw new Error('No connection test in this process fixture') }, enrollment: {
  domains: [{ domain: 'challenge.example', label: 'Challenge' }],
  begin: input => mode === 'begin' ? unknown('begin', input) : mode === 'authentication' ? Promise.resolve({ kind: 'authentication', stage: 'waiting', challenge: { qrPayload: 'original-private-qr', expiresAt: null, nextPollAt: _historyFixtureEpoch(0, 0, 0) }, account: null, privateState: 'original-private-state' }) : Promise.reject(new Error('No recovered begin is permitted')),
  advance: input => mode === 'authentication' ? unknown('authentication', input) : Promise.reject(new Error('No recovered authentication is permitted')),
  upload: async () => { throw new Error('No icon upload in this authentication fixture') },
  create: async () => { throw new Error('No application create in this authentication fixture') },
  credential: async () => { throw new Error('No application credential read in this authentication fixture') }
} }] })
const server = new AgentMuxControlServer({ socketPath: join(root, 'owner.sock'), connections, coreClients: () => [] })
await server.start(); process.send({ kind: 'ready' })
