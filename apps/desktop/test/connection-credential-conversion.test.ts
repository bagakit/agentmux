import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { ConnectionSecrets, encodeConnectionCredential } from '../../../packages/connectors/src/connection-secrets.js'
import { backupConnections } from '../../../packages/connectors/src/connection-backup.js'
import { convertConnectionCredentials } from '../scripts/lib/connection-credential-conversion.js'
import * as core from '@agentmux/core'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { startAgentMuxHost } from '../../host/src/host.js'
import { defaultFeishuSdkTransport, feishuConfig } from '../../../packages/connectors/test/fixtures/feishu.js'

const cleanup: Array<() => unknown | Promise<unknown>> = [], facts: unknown[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
afterAll(async () => { if (process.env.CONVERSION_FACTS) await writeFile(process.env.CONVERSION_FACTS, JSON.stringify({ scope: 'Synthetic private SQLite, real Online Backup and original Secrets codec; controlled native decrypt callback. No live data, Electron OS/keychain or installed activation.', facts }, null, 2) + '\n') })
const snapshot = (database: DatabaseSync) => database.prepare('SELECT * FROM connection_credential ORDER BY credential_ref').all()
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'credential-conversion-')), database = new DatabaseSync(join(directory, 'connections.sqlite'))
  cleanup.push(async () => { if (database.isOpen) database.close(); await rm(directory, { recursive: true, force: true }) })
  const secrets = new ConnectionSecrets(database)
  const raw = await secrets.store({ operationId: 'original-raw-operation', secret: '\uFEFFAlready current 中文🙂' })
  const bytes = Buffer.from('v10synthetic-original-ciphertext')
  database.prepare('INSERT INTO connection_credential VALUES (?,?,?)').run('legacy-ref', 'legacy-operation', bytes)
  database.prepare('INSERT INTO connection_credential VALUES (?,?,?)').run('legacy-ref-two', 'legacy-operation-two', bytes)
  database.exec("PRAGMA journal_mode=WAL; CREATE TABLE unknown_business (id TEXT PRIMARY KEY, state TEXT, opaque BLOB)")
  database.prepare('INSERT INTO unknown_business VALUES (?,?,?)').run('original-unknown-effect', 'unknown', Buffer.from([0, 7, 255]))
  const backup = await backupConnections(database, directory)
  const decryptLegacy = vi.fn(async (input: Buffer) => { expect(input).toEqual(bytes); return '\uFEFFConverted original 中文🙂' })
  const run = () => convertConnectionCredentials({ database, backup, decryptLegacy })
  return { directory, database, secrets, raw, bytes, backup, decryptLegacy, run }
}

it('converts exact original rows atomically through the real codec without a write lock across native authorization', async () => {
  const f = await fixture(), before = snapshot(f.database), business = f.database.prepare('SELECT * FROM unknown_business').all()
  f.decryptLegacy.mockImplementation(async bytes => {
    expect(bytes).toEqual(f.bytes)
    const writer = new DatabaseSync(f.database.location()!)
    try { writer.exec('BEGIN IMMEDIATE; ROLLBACK') } finally { writer.close() }
    bytes.fill(0) // The native callback cannot replace the retained original CAS bytes.
    return '\uFEFFConverted original 中文🙂'
  })
  const result = await f.run()
  expect(result).toEqual({ scanned: 3, alreadyCurrent: 1, converted: 2, verified: 2, backupConfirmed: true, committed: true })
  expect(await f.secrets.resolve('legacy-ref')).toBe('\uFEFFConverted original 中文🙂')
  expect(await f.secrets.inspect('legacy-operation')).toEqual({ credentialRef: 'legacy-ref' })
  expect(snapshot(f.database).map(row => [row.credential_ref, row.operation_id])).toEqual(before.map(row => [row.credential_ref, row.operation_id]))
  expect(snapshot(f.database).find(row => row.credential_ref === f.raw.credentialRef)).toEqual(before.find(row => row.credential_ref === f.raw.credentialRef))
  expect(f.database.prepare('SELECT * FROM unknown_business').all()).toEqual(business)
  expect(JSON.stringify(result)).not.toContain('Converted original')
  expect(await f.run()).toMatchObject({ alreadyCurrent: 3, converted: 0, verified: 0 })
  expect(f.decryptLegacy).toHaveBeenCalledTimes(2)
  facts.push({ case: 'atomic-original-conversion', ...result, sameIdentities: true, unchangedRawAndUnknown: true, nativeAuthorizationOutsideWriteLock: true })
})

it('preserves a new raw row created while native authorization is pending', async () => {
  const f = await fixture(); let added: { credentialRef: string } | undefined
  f.decryptLegacy.mockImplementationOnce(async () => {
    const writer = new DatabaseSync(f.database.location()!)
    try { added = await new ConnectionSecrets(writer).store({ operationId: 'concurrent-raw', secret: 'Concurrent raw original' }) } finally { writer.close() }
    return 'Converted original'
  })
  expect(await f.run()).toMatchObject({ scanned: 3, converted: 2 })
  expect(snapshot(f.database)).toHaveLength(4)
  expect(await f.secrets.resolve(added!.credentialRef)).toBe('Concurrent raw original')
})

it('refuses the whole conversion when an original raw tuple changes during native authorization', async () => {
  const f = await fixture()
  f.decryptLegacy.mockImplementation(async () => {
    const writer = new DatabaseSync(f.database.location()!)
    try { writer.prepare('UPDATE connection_credential SET ciphertext=? WHERE credential_ref=?').run(encodeConnectionCredential('Concurrent replacement'), f.raw.credentialRef) } finally { writer.close() }
    return 'Converted original'
  })
  const result = await f.run().then(() => 'committed', error => error.message)
  const legacyUnchanged = Buffer.from(snapshot(f.database).find(row => row.credential_ref === 'legacy-ref')!.ciphertext as Uint8Array).equals(f.bytes)
  facts.push({ case: 'changed-original-cas', result, legacyUnchanged, originalCount: snapshot(f.database).length })
  expect(result).toContain('original credential comparison'); expect(legacyUnchanged).toBe(true)
  expect(await f.secrets.resolve(f.raw.credentialRef)).toBe('Concurrent replacement')
})

it('refuses a backup that does not cover the exact original ciphertext tuple', async () => {
  const f = await fixture(), replacement = Buffer.from('v10unbacked-original')
  f.database.prepare('UPDATE connection_credential SET ciphertext=? WHERE credential_ref=?').run(replacement, 'legacy-ref')
  f.decryptLegacy.mockImplementation(async () => 'Converted original')
  const result = await f.run().then(() => 'committed', error => error.message)
  const legacyUnchanged = Buffer.from(snapshot(f.database).find(row => row.credential_ref === 'legacy-ref')!.ciphertext as Uint8Array).equals(replacement)
  facts.push({ case: 'unbacked-original', result, legacyUnchanged, nativeDecryptCalls: f.decryptLegacy.mock.calls.length })
  expect(result).toContain('backup confirmation'); expect(legacyUnchanged).toBe(true); expect(f.decryptLegacy).not.toHaveBeenCalled()
})

it('rolls back all converted bytes when the real Store readback is unconfirmed and redacts its exception', async () => {
  const f = await fixture(), before = snapshot(f.database), resolve = ConnectionSecrets.prototype.resolve
  vi.spyOn(ConnectionSecrets.prototype, 'resolve').mockImplementation(async function (ref) {
    const value = await resolve.call(this, ref)
    if (ref === 'legacy-ref') throw new Error('Synthetic decrypted value MUST_NOT_APPEAR')
    return value
  })
  const result = await f.run().then(() => 'committed', error => error.message)
  const legacyUnchanged = Buffer.from(snapshot(f.database).find(row => row.credential_ref === 'legacy-ref')!.ciphertext as Uint8Array).equals(f.bytes)
  facts.push({ case: 'unconfirmed-readback', result, legacyUnchanged, originalCount: snapshot(f.database).length })
  expect(result).toContain('original Store verification'); expect(result).not.toContain('MUST_NOT_APPEAR')
  expect(snapshot(f.database)).toEqual(before)
})

it.each(['unknown-format', 'spoofed-legacy-prefix', 'corrupt-raw', 'native-failure', 'invalid-plaintext', 'changed-operation', 'new-legacy', 'wrong-backup-hash'] as const)('retains original bytes for %s without partial conversion', async kind => {
  const f = await fixture()
  if (kind === 'unknown-format') f.database.prepare('UPDATE connection_credential SET ciphertext=? WHERE credential_ref=?').run(Buffer.from('v99unknown-original'), 'legacy-ref')
  if (kind === 'spoofed-legacy-prefix') f.database.prepare('UPDATE connection_credential SET ciphertext=? WHERE credential_ref=?').run(Buffer.from([0xf6, 0xb1, 0xb0, 0]), 'legacy-ref')
  if (kind === 'corrupt-raw') { const encoded = encodeConnectionCredential('x'); f.database.prepare('UPDATE connection_credential SET ciphertext=? WHERE credential_ref=?').run(Buffer.concat([encoded.subarray(0, -1), Buffer.from([255])]), f.raw.credentialRef) }
  if (kind === 'wrong-backup-hash') f.backup.sha256 = '0'.repeat(64)
  const before = snapshot(f.database)
  if (kind === 'native-failure') f.decryptLegacy.mockRejectedValue(Error('Synthetic native error MUST_NOT_APPEAR'))
  if (kind === 'invalid-plaintext') f.decryptLegacy.mockResolvedValue('\uD800')
  if (kind === 'changed-operation' || kind === 'new-legacy') f.decryptLegacy.mockImplementationOnce(async () => {
    const writer = new DatabaseSync(f.database.location()!)
    try {
      if (kind === 'changed-operation') writer.prepare('UPDATE connection_credential SET operation_id=? WHERE credential_ref=?').run('concurrent-new-operation', 'legacy-ref')
      else writer.prepare('INSERT INTO connection_credential VALUES (?,?,?)').run('concurrent-legacy', 'concurrent-legacy-op', Buffer.from('v10concurrent'))
    } finally { writer.close() }
    return 'Converted original'
  })
  const result = await f.run().then(() => 'committed', error => error.message)
  expect(result).toContain('not confirmed'); expect(result).not.toContain('MUST_NOT_APPEAR')
  if (kind === 'unknown-format' || kind === 'spoofed-legacy-prefix' || kind === 'corrupt-raw') { expect(result).toContain('original snapshot'); expect(f.decryptLegacy).not.toHaveBeenCalled() }
  if (kind !== 'changed-operation' && kind !== 'new-legacy') expect(snapshot(f.database)).toEqual(before)
  else expect(Buffer.from(snapshot(f.database).find(row => row.credential_ref === 'legacy-ref')!.ciphertext as Uint8Array)).toEqual(f.bytes)
})

it('the actual Host reopens the original converted references and consumes them through the default SDK without Desktop', async () => {
  const f = await fixture(); await f.run(); f.database.close()
  const sdk = defaultFeishuSdkTransport(), original = await rpcOwnerFixture([], core)
  cleanup.push(original.close)
  const runtime = original.inner.kernel
  await original.client.dispose()
  let host: Awaited<ReturnType<typeof startAgentMuxHost>> | undefined
  const stop = async () => { const previous = host; host = undefined; await previous?.dispose() }
  cleanup.push(stop)
  const start = async () => {
    const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
      const inner = this as unknown as typeof original.inner
      await inner.registry.load('local'); inner.connected = true
      for (const name of ['isConnected', 'status', 'identity', 'input', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[name] = runtime[name]
    })
    try {
      host = await startAgentMuxHost({ store: original.store, socketPath: join(original.root, 'converted-host.sock'),
        desktopSocketPath: join(original.root, 'absent-desktop.sock'), mobileBuildDirectory: join(original.root, 'absent-mobile'), connections: { directory: f.directory } })
      await vi.waitFor(() => expect((host!.client as unknown as typeof original.inner).connected).toBe(true))
    } finally { connect.mockRestore() }
  }
  await start()
  const request = { operationId: 'original-converted-configure', expectedRevision: null, connection: { ...feishuConfig, credentialRef: 'legacy-ref' } }
  const check = async () => {
    const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(original.root, 'converted-host.sock') } })
    try {
      const owner = (await rpc.call('runtime.owner.identity', {})).owner
      await rpc.call('connection.configure', request)
      expect(await rpc.call('connection.test', { connectionId: feishuConfig.connectionId })).toMatchObject({ observation: { authentication: { state: 'ready' } } })
      expect((await rpc.call('connection.inspect', { operationId: request.operationId })).operation?.connection.config.credentialRef).toBe('legacy-ref')
      return owner
    } finally { await rpc.dispose() }
  }
  const before = await check(); await stop(); await start(); const after = await check()
  expect(after.runtimeId).toBe(before.runtimeId); expect(after.ownerInstanceId).not.toBe(before.ownerInstanceId)
  await vi.waitFor(() => expect(sdk.sockets).toHaveLength(2))
  expect(sdk.request.mock.calls.filter(([input]) => input.url?.includes('/auth/v3/')).length).toBeGreaterThanOrEqual(2)
  const database = new DatabaseSync(join(f.directory, 'connections.sqlite')); try {
    expect(await new ConnectionSecrets(database).inspect('legacy-operation')).toEqual({ credentialRef: 'legacy-ref' })
    expect(database.prepare('SELECT state,opaque FROM unknown_business').get()).toEqual({ state: 'unknown', opaque: Uint8Array.from([0, 7, 255]) })
  } finally { database.close() }
  facts.push({ case: 'actual-host-converted-reopen', sameRuntimeId: true, newOwnerInstance: true, originalReferenceAndOperation: true, independentSdkAuthentications: 2, desktopAbsent: true, unknownBusinessPreserved: true })
})
