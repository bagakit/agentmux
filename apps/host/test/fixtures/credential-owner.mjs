import { DatabaseSync } from 'node:sqlite'
import { open, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ConnectionSecrets } from '../../../../packages/connectors/src/connection-secrets.ts'
import { createHostCredentialEncryption, HOST_CREDENTIAL_KEYRING_SERVICE, hostCredentialKeyringAccount } from '../../src/credential-encryption.ts'
import { createCredentialAdministration } from '../../src/credential-administration.ts'

const root = process.argv[2], provider = process.argv[3]
const database = new DatabaseSync(join(root, 'connections.sqlite'))
let request = 0, lease
const pending = new Map()
const backend = method => new Promise((resolve, reject) => { const id = ++request; pending.set(id, { resolve, reject }); process.send({ kind: 'keyring', id, method }) })
const keyring = provider === 'native' ? undefined : async () => ({ getSecret: () => backend('get'), setSecret: async value => {
  const id = ++request
  await new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); process.send({ kind: 'keyring', id, method: 'set', bytes: [...value] }) })
} })
const encryption = createHostCredentialEncryption({ database, namespace: root, keyring })
const secrets = new ConnectionSecrets(database, encryption)
const target = { runtimeId: 'synthetic-runtime', ownerInstanceId: randomUUID() }
const context = { principal: { kind: 'user', id: 'synthetic-person' }, runtimeFence: target }
const administration = createCredentialAdministration({ target, secrets, maxBytes: 64 * 1024 })
process.on('message', message => {
  if (message.kind === 'keyring-result') {
    const handler = pending.get(message.id); pending.delete(message.id)
    if (message.denied) handler.reject(Error('synthetic backend denied'))
    else handler.resolve(message.value)
    return
  }
  void (async () => {
    try {
      let value
      if (message.operation === 'key') value = await administration.key(context)
      else if (message.operation === 'store') value = await administration.store(message.input, message.context ?? context)
      else if (message.operation === 'inspect') value = await administration.inspect(message.operationId, context)
      else if (message.operation === 'resolve') value = await secrets.resolve(message.credentialRef)
      else if (message.operation === 'lock') {
        lease = await open((await realpath(join(root, 'connections.sqlite'))) + '.credential-key.lock', 'a+', 0o600)
        if (!createRequire(import.meta.url)('fs-native-extensions').tryLock(lease.fd)) throw Error('synthetic lock busy')
        value = true
      } else if (message.operation === 'unlock') { await lease.close(); lease = undefined; value = true }
      else if (message.operation === 'remove-synthetic-key') {
        const { AsyncEntry } = await import('@napi-rs/keyring')
        value = await new AsyncEntry(HOST_CREDENTIAL_KEYRING_SERVICE, hostCredentialKeyringAccount(root), process.platform === 'linux' ? { linux: { store: 'secret-service' } } : undefined).deleteCredential()
      } else throw Error('Unknown synthetic request')
      process.send({ kind: 'result', id: message.id, value })
    } catch (error) { process.send({ kind: 'result', id: message.id, error: { code: error.code ?? 'FIXTURE_FAILED' } }) }
  })()
})
process.once('disconnect', () => { void lease?.close().finally(() => {}); database.close() })
process.send({ kind: 'ready', pid: process.pid, target, source: __CREDENTIAL_SOURCE_RECEIPTS__ })
