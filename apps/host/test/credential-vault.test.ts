import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxError } from '../../../packages/core/src/errors.js'
import { ConnectionSecrets } from '../../../packages/connectors/src/connection-secrets.js'
import { createCredentialAdministration } from '../src/credential-administration.js'
import { parseConnectionCredentialParams, parseConnectionCredentialResult } from '../../../packages/core/src/connection-credential-codec.js'
import { parseAgentMuxCliInvocation } from '../../../packages/core/src/agentmux-cli-commands.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
const original = { operationId: 'original-operation', secret: 'synthetic-private-credential-你好\nverbatim ' }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amux-private-secret-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'connections.sqlite'), database = new DatabaseSync(path); cleanup.push(() => database.close())
  const secrets = new ConnectionSecrets(database), target = { runtimeId: 'original-runtime', ownerInstanceId: 'original-instance' }
  const context = { transport: 'unix' as const, principal: { kind: 'user' as const, id: 'original-user' }, runtimeFence: target }
  return { root, path, database, secrets, target, context, administration: createCredentialAdministration({ target, secrets }) }
}

it('persists explicitly marked plaintext in the original private SQLite row and returns only the original reference', async () => {
  const f = await fixture(), receipt = await f.administration.store(original, f.context)
  expect(Object.keys(receipt)).toEqual(['credentialRef'])
  const row = f.database.prepare('SELECT * FROM connection_credential').get()!
  expect(Buffer.from(row.ciphertext as Uint8Array)).toEqual(Buffer.from('amux.connection-credential.raw.v1\0' + original.secret))
  expect(await f.secrets.resolve(receipt.credentialRef)).toBe(original.secret)
  expect(await f.administration.inspect({ operationId: original.operationId }, f.context)).toEqual({ receipt })
  const reopened = new ConnectionSecrets(f.database)
  expect(await reopened.store(original)).toEqual(receipt)
  expect(f.database.prepare('SELECT * FROM connection_credential').get()).toEqual(row)
  expect((await stat(f.root)).mode & 0o777).toBe(0o700); expect((await stat(f.path)).mode & 0o777).toBe(0o600)
})

it('converges concurrent original operations, rejects changed input and preserves the exact original bytes', async () => {
  const f = await fixture(), results = await Promise.all(Array.from({ length: 8 }, () => f.secrets.store(original)))
  expect(new Set(results.map(value => value.credentialRef)).size).toBe(1)
  const rows = f.database.prepare('SELECT * FROM connection_credential').all()
  await expect(f.secrets.store({ ...original, secret: 'different-private-input' })).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
  expect(f.database.prepare('SELECT * FROM connection_credential').all()).toEqual(rows)
  expect(await f.secrets.inspect(original.operationId)).toEqual(results[0])
})

it('inspects a committed original after its commit acknowledgement was lost without minting or overwriting it', async () => {
  const f = await fixture(), exec = f.database.exec.bind(f.database); let lost = false
  vi.spyOn(f.database, 'exec').mockImplementation(sql => { const value = exec(sql); if (sql === 'COMMIT' && !lost) { lost = true; throw Error(original.secret) }; return value })
  const error = await f.secrets.store(original).catch(value => value)
  expect(error).toMatchObject({ code: 'CONNECTION_CREDENTIAL_UNCONFIRMED' }); expect(String(error)).not.toContain(original.secret)
  const receipt = await f.secrets.inspect(original.operationId); expect(receipt).not.toBeNull()
  expect(await f.secrets.store(original)).toEqual(receipt)
  expect(f.database.prepare('SELECT COUNT(*) AS n FROM connection_credential').get()!.n).toBe(1)
})

it.each([Buffer.from([0xde, 0xad, 0x00, 0xff]), Buffer.from('legacy-unversioned-ciphertext')])('preserves unsupported original ciphertext, operation and reference through every attempted read/write', async bytes => {
  const f = await fixture(), receipt = { credentialRef: 'original-legacy-reference' }
  f.database.prepare('INSERT INTO connection_credential VALUES (?,?,?)').run(receipt.credentialRef, original.operationId, bytes)
  const row = f.database.prepare('SELECT * FROM connection_credential').get()
  expect(await f.secrets.inspect(original.operationId)).toEqual(receipt)
  await expect(f.secrets.resolve(receipt.credentialRef)).rejects.toMatchObject({ code: 'CONNECTION_CREDENTIAL_FORMAT_UNSUPPORTED' })
  await expect(f.secrets.store(original)).rejects.toMatchObject({ code: 'CONNECTION_CREDENTIAL_FORMAT_UNSUPPORTED' })
  expect(f.database.prepare('SELECT * FROM connection_credential').all()).toEqual([row])
  const fresh = await f.secrets.store({ ...original, operationId: 'independent-new-operation' })
  expect(await f.secrets.resolve(fresh.credentialRef)).toBe(original.secret)
  expect(f.database.prepare('SELECT * FROM connection_credential WHERE credential_ref=?').get(receipt.credentialRef)).toEqual(row)
})

it.each([Buffer.from('amux.connection-credential.raw.v1\0'), Buffer.concat([Buffer.from('amux.connection-credential.raw.v1\0'), Buffer.from([0xff])]), 'wrong-sql-type'])('does not treat a corrupt marked value as a missing or healthy credential', async bytes => {
  const f = await fixture(); f.database.prepare('INSERT INTO connection_credential VALUES (?,?,?)').run('corrupt-ref', original.operationId, bytes)
  await expect(f.secrets.resolve('corrupt-ref')).rejects.toMatchObject({ code: 'CONNECTION_CREDENTIAL_UNCONFIRMED' })
  expect(await f.secrets.inspect(original.operationId)).toEqual({ credentialRef: 'corrupt-ref' })
})

it('refuses only private access while the exact directory is exposed and can retry after its permissions recover', async () => {
  const f = await fixture(), sibling = join(f.root, 'unrelated.txt'); await writeFile(sibling, 'not-owned', { mode: 0o644 }); await chmod(f.root, 0o755)
  await expect(f.secrets.store(original)).rejects.toMatchObject({ code: 'CONNECTION_CREDENTIAL_UNAVAILABLE' })
  expect(await f.secrets.inspect(original.operationId)).toBeNull()
  await chmod(f.root, 0o700); const receipt = await f.secrets.store(original)
  expect(await f.secrets.resolve(receipt.credentialRef)).toBe(original.secret)
  expect((await stat(sibling)).mode & 0o777).toBe(0o644); expect(await readFile(sibling, 'utf8')).toBe('not-owned')
})

it('tightens only its exact database and live SQLite sidecars, preserving neighboring resources', async () => {
  const f = await fixture(); f.database.exec('PRAGMA journal_mode=WAL; CREATE TABLE own_probe (id TEXT)')
  await chmod(f.path, 0o644)
  for (const path of [f.path + '-wal', f.path + '-shm']) await chmod(path, 0o644)
  const receipt = await f.secrets.store(original).catch(error => error)
  expect(receipt).toHaveProperty('credentialRef')
  expect(await f.secrets.resolve(receipt.credentialRef)).toBe(original.secret)
  for (const path of [f.path, f.path + '-wal', f.path + '-shm']) expect((await stat(path)).mode & 0o777).toBe(0o600)
})

it('rechecks original authority after asynchronous availability without retaining a write transaction or secret error', async () => {
  const f = await fixture(); let release!: () => void, current = true
  vi.spyOn(f.secrets, 'assertAvailable').mockImplementationOnce(() => new Promise<void>(done => { release = done }))
  const context = { ...f.context, assertCurrent: async () => { if (!current) throw new AgentMuxError('Original device revoked.', 'CONTROL_PERMISSION_DENIED') } }
  const work = f.administration.store(original, context).catch(value => value)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  expect(await f.secrets.inspect(original.operationId)).toBeNull(); f.database.exec('BEGIN IMMEDIATE; ROLLBACK')
  current = false; release()
  expect(await work).toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' }); expect(await f.secrets.inspect(original.operationId)).toBeNull()
  current = true; expect(await f.administration.store(original, context)).toHaveProperty('credentialRef')
})

it.each(['anonymous', 'managed', 'wrong-runtime', 'old-instance', 'http'] as const)('refuses only the exact %s administration and retains a healthy original store', async kind => {
  const f = await fixture(); const context: any = { ...f.context }
  if (kind === 'anonymous') delete context.principal
  if (kind === 'managed') context.caller = { agentSessionId: 'managed', capability: 'not-a-person' }
  if (kind === 'wrong-runtime') context.runtimeFence = { ...f.target, runtimeId: 'foreign-runtime' }
  if (kind === 'old-instance') context.runtimeFence = { ...f.target, ownerInstanceId: 'previous-instance' }
  if (kind === 'http') context.transport = 'http'
  await expect(f.administration.store(original, context)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(await f.secrets.inspect(original.operationId)).toBeNull()
  expect(await f.administration.store(original, f.context)).toHaveProperty('credentialRef')
})

it('admits the authenticated original device on the protected relay and returns references alone', async () => {
  const f = await fixture(), context = { ...f.context, transport: 'relay' as const, principal: { kind: 'device' as const, id: 'original-device' } }
  const receipt = await f.administration.store(original, context)
  expect(await f.administration.inspect({ operationId: original.operationId }, context)).toEqual({ receipt })
  expect(JSON.stringify(receipt)).not.toContain(original.secret)
})

it.each([{ ...original, extra: 'not-allowed' }, { operationId: 'original', secret: '' }, { operationId: 'original', secret: '\ud800' }])('strictly rejects malformed secret input without reflecting its value', async input => {
  const f = await fixture(); const parseError = (() => { try { parseConnectionCredentialParams('connection.credential.store', input) } catch (error) { return error } })()
  expect(parseError).toMatchObject({ code: 'INVALID_CONNECTION_CREDENTIAL_DATA' })
  await expect(f.secrets.store(input)).rejects.toMatchObject({ code: 'INVALID_CONNECTION_DATA' })
  expect(await f.secrets.inspect('original')).toBeNull()
})

it('strict result codecs forbid a secret, raw bytes or extra fields on every public receipt', () => {
  for (const [method, result] of [['connection.credential.store', { credentialRef: 'ref', secret: original.secret }], ['connection.credential.inspect', { receipt: { credentialRef: 'ref', secret: original.secret } }], ['connection.credential.inspect', { receipt: null, bytes: [1] }]] as const) {
    expect(() => parseConnectionCredentialResult(method, result)).toThrowError(expect.objectContaining({ code: 'INVALID_CONNECTION_CREDENTIAL_DATA' }))
  }
})

it('discovers only stdin credential commands and never reflects accidental secret arguments in CLI errors', async () => {
  expect((await parseAgentMuxCliInvocation(['connection', 'credential', 'store', '--operation-id', 'original', '--secret-stdin'])).params).toEqual({ operationId: 'original' })
  for (const args of [['--secret', original.secret], [original.secret], ['--input', original.secret], ['--secret-stdin', original.secret]]) {
    const error = await parseAgentMuxCliInvocation(['connection', 'credential', 'store', '--operation-id', 'original', ...args]).catch(value => value)
    expect(error).toMatchObject({ code: 'INVALID_CLI_ARGUMENT' }); expect(String(error)).not.toContain(original.secret)
  }
})

it.each(['\ufefforiginal-with-BOM', 'original\0with-null', '中文🙂\r\n  '])('preserves exact UTF-8 input including non-command characters', async secret => {
  const f = await fixture(), input = { operationId: 'exact-text', secret }, receipt = await f.secrets.store(input)
  expect(parseConnectionCredentialParams('connection.credential.store', input)).toEqual(input)
  expect(await f.secrets.resolve(receipt.credentialRef)).toBe(secret)
  expect(await f.secrets.store(input)).toEqual(receipt)
})
