import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgentMuxControlServer } from '@agentmux/core'
import { ConnectionHost } from '@agentmux/connectors'
import { ConnectionSecrets } from '../../src/connection-secrets.ts'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../../test/fixture-values.mjs'


const root = process.argv[2], mode = process.argv[3]
const database = new DatabaseSync(join(root, 'connections.sqlite'))
const secrets = new ConnectionSecrets(database)
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
