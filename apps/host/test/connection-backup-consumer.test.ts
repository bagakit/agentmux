import { appendFile, chmod, lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { closeSync, openSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { DefaultRestOptions } from '@discordjs/rest'
import * as core from '../../../packages/core/src/index.js'
import * as connectors from '../../../packages/connectors/src/index.js'
import { ConnectionSecrets } from '../../../packages/connectors/src/connection-secrets.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { discordConfig, discordRoomId, discordTransport } from '../../../packages/connectors/test/fixtures/discord.js'
import { startAgentMuxHost } from '../src/host.js'
import { backupProgress } from './fixtures/connection-backup-native.js'

const cleanup: Array<() => void | Promise<void>> = [], facts: unknown[] = []
afterEach(async () => { try { for (const close of cleanup.splice(0).reverse()) await close() } finally { vi.restoreAllMocks(); delete backupProgress.current; vi.unstubAllEnvs() } })
afterAll(async () => { if (process.env.CONNECTION_BACKUP_FACTS) await writeFile(process.env.CONNECTION_BACKUP_FACTS, JSON.stringify({ schema: 'agentmux.actual-host-backup-consumer.v1', node: process.version, sqlite: process.versions.sqlite, scope: 'Actual Host and original ConnectionServices/SQLite/lease; synthetic credentials and controlled Native/Discord SDK IO. No live backup, old ciphertext conversion, installation or owner activation.', facts }, null, 2) + '\n') })

async function fixture() {
  const original = await rpcOwnerFixture(['original-agent'], core, root => ({ providerId: 'claude', executorId: 'claude', nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'original-native', transcriptPath: join(root, 'native.jsonl') } })); cleanup.push(original.close)
  const wire = await discordTransport(); cleanup.push(wire.close); vi.spyOn(DefaultRestOptions, 'makeRequest').mockImplementation(wire.http.makeRequest)
  const transcript = join(original.root, 'native.jsonl'), directory = join(original.root, 'connections'), socketPath = join(original.root, 'host.sock')
  const native = (id: string, text: string) => JSON.stringify({ type: 'assistant', sessionId: 'original-native', uuid: id, message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'
  await writeFile(transcript, native('private-before-sharing', 'Earlier private answer')); await mkdir(directory, { mode: 0o700 }); await original.client.dispose()
  const factory = connectors.createConnectionServices, opened: connectors.ConnectionServices[] = []
  let factoryOptions!: Parameters<typeof factory>[0]
  vi.spyOn(connectors, 'createConnectionServices').mockImplementation(async options => { factoryOptions = options; const owner = await factory(options); opened.push(owner); return owner })
  let host: Awaited<ReturnType<typeof startAgentMuxHost>> | undefined
  const start = async () => {
    const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () { const inner = this as unknown as typeof original.inner; await inner.registry.load('local'); inner.connected = true; for (const name of ['isConnected', 'status', 'identity', 'input', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[name] = original.inner.kernel[name] })
    try { host = await startAgentMuxHost({ store: original.store, socketPath, desktopSocketPath: join(original.root, 'no-desktop.sock'), mobileBuildDirectory: join(original.root, 'absent-mobile'), connections: { directory } }); return host }
    finally { connect.mockRestore() }
  }
  const stop = async () => { const previous = host; host = undefined; await previous?.dispose() }; cleanup.push(stop)
  await start()
  const rpc = async () => { const client = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); cleanup.push(() => client.dispose()); return client }
  const client = await rpc(), owner = (await client.call('runtime.owner.identity', {})).owner
  const stored = await client.call('connection.credential.store', { operationId: 'original-credential', secret: 'synthetic-private-backup-value' }, { runtimeFence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId } })
  await client.call('connection.configure', { operationId: 'original-configure', expectedRevision: null, connection: { ...discordConfig, credentialRef: stored.credentialRef } })
  await vi.waitFor(() => expect(wire.sessions).toHaveLength(1))
  const service = () => opened.at(-1)!, database = () => service().database!
  const artifact = (receipt: Awaited<ReturnType<connectors.ConnectionServices['backup']>>) => join(directory, 'backups', receipt.artifactId, 'connections.sqlite')
  return { original, wire, directory, client, stored, owner, rpc, start, stop, service, database, artifact, host: () => host!, opened,
    competing: () => factory(factoryOptions), options: () => factoryOptions, native: async (id: string, body: string) => appendFile(transcript, native(id, body)) }
}

it('backs up the actual Host WAL without decoding opaque bytes and reopens original unknown effects on the same database', async () => {
  const f = await fixture()
  const bound = await f.client.call('connection.bind', { operationId: 'original-bind', bindingId: 'original-binding', connectionId: discordConfig.connectionId, expectedConnectionRevision: 1, executionHostId: 'local', agentSessionId: 'original-agent', externalConversationId: discordRoomId, expectedSource: { providerId: 'claude', nativeSessionId: 'original-native' }, scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } })
  expect(bound.state).toBe('applied')
  const list = (client = f.client) => client.call('connection.delivery.ls', { connectionId: discordConfig.connectionId, bindingId: 'original-binding', bindingRevision: 1, limit: 100 })
  await vi.waitFor(async () => { const rows = (await list()).deliveries; expect(rows.length).toBeGreaterThan(0); expect(rows.every(row => row.state === 'confirmed')).toBe(true) })
  f.wire.loseNextMessageResponse(false); await f.native('unknown-backup-reply', 'Original unknown backup reply')
  let operationId = ''
  await vi.waitFor(async () => { const row = (await list()).deliveries.find(row => row.state === 'unknown'); expect(row).toBeDefined(); operationId = row!.operationId }, { timeout: 15_000 })
  const copies = () => f.wire.calls.filter(call => call.method === 'POST' && call.path === '/channels/300/messages' && call.body.includes('Original unknown backup reply')).length
  expect(copies()).toBe(1)
  const db = f.database(), opaque = Buffer.from([0, 255, 13, 66, 77])
  db.exec('PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE)')
  db.prepare('INSERT INTO connection_credential VALUES (?,?,?)').run('original-opaque-ref', 'original-opaque-op', opaque)
  const policy = await f.client.call('connection.service.configure', { operationId: 'wal-policy', expectedRevision: 0, service: { enabled: true } })
  expect((await stat(join(f.directory, 'connections.sqlite-wal'))).size).toBeGreaterThan(0)
  facts.push({ case: 'backup-source-witness', originalConnections: (await f.client.call('connection.ls', {})).connections.length, walBytes: (await stat(join(f.directory, 'connections.sqlite-wal'))).size, opaqueByteLength: opaque.length, operationId, unknownCopies: copies() })
  const foreign = join(f.original.root, 'unrelated-directory'); await mkdir(foreign, { mode: 0o700 })
  const receipt = await (async () => { f.options().directory = foreign; try { return await f.service().backup() } finally { f.options().directory = f.directory } })()
  expect(await readdir(foreign)).toEqual([])
  const path = f.artifact(receipt), snapshot = new DatabaseSync(path, { readOnly: true })
  try {
    expect(snapshot.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    const opaqueRow = snapshot.prepare('SELECT ciphertext FROM connection_credential WHERE credential_ref=?').get('original-opaque-ref')
    expect(opaqueRow).toBeDefined(); expect(Buffer.from(opaqueRow!.ciphertext as Uint8Array)).toEqual(opaque)
    expect(snapshot.prepare('SELECT credential_ref FROM connection_credential WHERE operation_id=?').get('original-credential')).toEqual({ credential_ref: f.stored.credentialRef })
    expect(snapshot.prepare('SELECT result_json FROM connection_configuration_operation WHERE operation_id=?').get('wal-policy')).toBeDefined()
  } finally { snapshot.close() }
  expect(receipt.pages).toBeGreaterThan(0); expect(receipt.sha256).toBe(createHash('sha256').update(await readFile(path)).digest('hex'))
  for (const entry of [f.directory, join(f.directory, 'backups'), join(f.directory, 'backups', receipt.artifactId)]) expect((await lstat(entry)).mode & 0o777).toBe(0o700)
  for (const entry of await readdir(join(f.directory, 'backups', receipt.artifactId))) expect((await lstat(join(f.directory, 'backups', receipt.artifactId, entry))).mode & 0o777).toBe(0o600)
  const originalInode = (await stat(join(f.directory, 'connections.sqlite'))).ino
  await f.stop(); await f.start(); const reopened = await f.rpc(), nextOwner = (await reopened.call('runtime.owner.identity', {})).owner
  expect(nextOwner.runtimeId).toBe(f.owner.runtimeId); expect(nextOwner.ownerInstanceId).not.toBe(f.owner.ownerInstanceId)
  expect((await stat(join(f.directory, 'connections.sqlite'))).ino).toBe(originalInode)
  expect(await reopened.call('connection.credential.inspect', { operationId: 'original-credential' }, { runtimeFence: { runtimeId: nextOwner.runtimeId, ownerInstanceId: nextOwner.ownerInstanceId } })).toEqual({ receipt: f.stored })
  expect(await reopened.call('connection.service.inspect', { operationId: 'wal-policy' })).toEqual({ operation: policy })
  await vi.waitFor(async () => expect((await list(reopened)).deliveries.find(row => row.operationId === operationId)).toMatchObject({ state: 'unknown' }))
  expect(copies()).toBe(1)
  await expect(new ConnectionSecrets(f.database()).resolve('original-opaque-ref')).rejects.toHaveProperty('code', 'CONNECTION_CREDENTIAL_FORMAT_UNSUPPORTED')
  expect(Buffer.from(f.database().prepare('SELECT ciphertext FROM connection_credential WHERE credential_ref=?').get('original-opaque-ref')!.ciphertext as Uint8Array)).toEqual(opaque)
  facts.push({ case: 'actual-host-wal-and-reopen', receipt, credentialRef: f.stored.credentialRef, opaqueRef: 'original-opaque-ref', opaqueByteLength: opaque.length, originalInode, operationId, unknownCopies: copies(), sameRuntimeId: true, policy })
})

it('retains the original Host after a private backup failure and refuses a competing SDK owner', async () => {
  const f = await fixture(), other = await f.competing(); cleanup.push(() => other.close())
  facts.push({ case: 'lease-source-witness', originalConnections: (await f.client.call('connection.ls', {})).connections.length, sourceOpen: f.database().isOpen, competingOpen: other.database?.isOpen ?? false })
  expect(f.database()).not.toBeNull(); expect(other.database).toBeNull()
  await expect(other.connections.list()).rejects.toHaveProperty('code', 'CONNECTION_OWNER_BUSY')
  const parent = join(f.directory, 'backups'); await mkdir(parent, { mode: 0o700 }); await chmod(parent, 0o755); await writeFile(join(parent, 'preserved'), 'owned fixture sentinel')
  await expect(f.service().backup()).rejects.toHaveProperty('code', 'CONNECTION_BACKUP_UNCONFIRMED')
  expect(await readFile(join(parent, 'preserved'), 'utf8')).toBe('owned fixture sentinel')
  expect((await f.client.call('connection.ls', {})).connections).toHaveLength(1); expect((await f.client.call('runtime.owner.identity', {})).owner).toEqual(f.owner)
  await chmod(parent, 0o700); const receipt = await f.service().backup(); expect(receipt.pages).toBeGreaterThan(0)
  facts.push({ case: 'backup-failure-and-original-lease', sourceConnections: 1, originalOwner: f.owner, conflictCode: 'CONNECTION_OWNER_BUSY', retry: receipt })
})

it('awaits the real native backup through Host close before releasing its original DB and lease', async () => {
  const f = await fixture(), db = f.database(), uid = process.getuid!()
  db.exec('CREATE TABLE backup_payload (bytes BLOB NOT NULL)'); db.prepare('INSERT INTO backup_payload VALUES (?)').run(Buffer.alloc(128 * 1024, 7))
  const authority = await f.host().deviceAuthority(); await authority.flush(); vi.spyOn(authority, 'flush').mockResolvedValue()
  const originalClose = f.service().close
  let closing: Promise<void> | undefined, entered = false, copyInProgress = false, dbOpenAtClose = false, leaseRetained = false, hostClosed = false, hostClosedBeforeBackup = false, backupSettled = false
  vi.spyOn(f.service(), 'close').mockImplementation(() => { const pending = originalClose(); entered = true; dbOpenAtClose = db.isOpen; const fd = openSync(join(f.directory, 'connections.owner.lock'), 'a+'); try { leaseRetained = !createRequire(import.meta.url)('fs-native-extensions').tryLock(fd) } finally { closeSync(fd) }; return pending })
  backupProgress.current = info => {
    if (!closing) { copyInProgress = info.remainingPages > 0; closing = f.stop().then(() => { hostClosed = true; hostClosedBeforeBackup = !backupSettled }); expect(backupSettled).toBe(false) }
  }
  const backup = f.service().backup(); expect(f.service().backup()).toBe(backup)
  const receipt = await backup; backupSettled = true
  const evidence = { case: 'real-backup-and-host-close', receipt, copyInProgress, dbOpenAtClose, leaseRetained, hostClosed, hostClosedBeforeBackup, sameOwnerSingleFlight: true }; facts.push(evidence)
  expect({ copyInProgress, entered, dbOpenAtClose, leaseRetained }).toEqual({ copyInProgress: true, entered: true, dbOpenAtClose: true, leaseRetained: true })
  await closing; evidence.hostClosed = hostClosed; evidence.hostClosedBeforeBackup = hostClosedBeforeBackup; expect(hostClosedBeforeBackup).toBe(false); expect(hostClosed).toBe(true); expect(db.isOpen).toBe(false)
  expect((await lstat(f.artifact(receipt))).uid).toBe(uid)
  delete backupProgress.current; await f.start(); const client = await f.rpc(); expect((await client.call('connection.ls', {})).connections).toHaveLength(1)
})
