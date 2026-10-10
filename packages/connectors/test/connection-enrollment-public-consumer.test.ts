import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { DatabaseSync } from 'node:sqlite'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, AgentMuxError, AgentMuxRpcService, connectAgentMuxRpc } from '@agentmux/core'
import { parseConnectionEnrollmentOperation, parseConnectionEnrollmentResult, type ConnectionEnrollmentDiagnostic } from '@agentmux/core/connections'
import { ConnectionHost } from '@agentmux/connectors'
import { DesktopConnectorSecrets } from '../../../apps/desktop/src/main/connector-secrets.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { enrollmentEncryption, enrollmentFixture, fixtureCredential, fixturePrivateState } from './fixtures/connection-enrollment.js'

const clean: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const close of clean.splice(0).reverse()) await close() })
async function fixture(options?: Parameters<typeof enrollmentFixture>[0]) { const f = await enrollmentFixture(options); clean.push(f.close); return f }
function result(o: { code: number | null; stdout: string; stderr: string }) { expect(o.code, o.stdout + o.stderr).toBe(0); return JSON.parse(o.stdout).result }
async function defaultFixture() {
  const root = await mkdtemp(join(tmpdir(), 'enroll-default-')), directory = join(root, 'connections'), socketPath = join(root, 'public.sock'), encryption = enrollmentEncryption()
  let services: Awaited<ReturnType<typeof createDesktopConnections>>, server: AgentMuxControlServer, sdk: Awaited<ReturnType<typeof connectAgentMuxRpc>>
  const open = async () => {
    services = await createDesktopConnections({ directory, encryption })
    server = new AgentMuxControlServer({ socketPath, connections: services.connections, coreClients: () => { throw new Error('Registration cannot borrow an Agent Runtime') } })
    await server.start(); sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  }
  const closeOwner = async () => { await sdk?.dispose(); await server?.stop(); services?.close() }
  clean.push(async () => { await closeOwner(); await rm(root, { recursive: true, force: true }) })
  await open()
  const input = { operationId: 'original-platform-enrollment', connectionId: 'original-platform-connection', adapterId: 'feishu', domain: 'open.feishu.cn', label: 'Original bot' }
  const cli = (args: string[], body?: unknown) => runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', 'enrollment', ...args], objectCliEnvironment(root), body === undefined ? '' : JSON.stringify(body))
  return { root, directory, input, encryption, cli, closeOwner, reopen: open, get services() { return services }, get sdk() { return sdk } }
}

it('uses compiled CLI and original SDK through the Desktop owner, preserving encrypted handoff and independent connection facts', async () => {
  const f = await fixture()
  const caps = result(await f.cli(['enrollment', 'ls'])); expect(caps.operations).toEqual([]); expect(caps.capabilities).toEqual([{ adapterId: f.input.adapterId, domain: f.input.domain, label: 'Signed challenge', availability: 'available' }]); expect(f.begin).not.toHaveBeenCalled()
  const pending = result(await f.cli(['enrollment', 'begin', '--input', '-'], f.input)); expect(pending.authorization).toBe('pending'); expect(pending.configured).toBeNull()
  expect(result(await f.cli(['ls'])).connections).toEqual([])
  const saved = result(await f.cli(['enrollment', 'advance', '--operation-id', f.input.operationId])); expect(saved.authorization).toBe('authorized'); expect(saved.credential).toBe('stored'); expect(saved.configuration).toBe('configured'); expect(saved.configured.connection.revision).toBe(1)
  expect(saved.configured.connection.config.enabled).toBe(true); expect(saved.configured.connection.config.connectionId).toBe(f.input.connectionId); expect(saved.configured.connection.observation.transport.state).toBe('unknown')
  expect(await f.sdk.call('connection.enrollment.inspect', { operationId: f.input.operationId })).toEqual({ operation: saved })
  expect((await f.sdk.call('connection.test', { connectionId: f.input.connectionId })).observation.authentication.state).toBe('ready')
  expect(f.begin).toHaveBeenCalledTimes(1); expect(f.poll).toHaveBeenCalledTimes(1)
  const serialized = JSON.stringify([caps, pending, saved]); expect(serialized).not.toContain(fixtureCredential); expect(serialized).not.toContain(fixturePrivateState)
  const rows = f.services.database!.prepare('SELECT record_json FROM connection_enrollment').all(); expect(JSON.stringify(rows)).not.toContain(fixtureCredential); expect(JSON.stringify(rows)).not.toContain('"signed":')
  const bytes = await readFile(join(f.directory, 'connections.sqlite')); expect(bytes.includes(Buffer.from(fixtureCredential))).toBe(false)
  await f.closeOwner(); await f.reopen()
  const reopened = result(await f.cli(['enrollment', 'ls'])); expect(reopened.operations).toEqual([saved]); expect(f.poll).toHaveBeenCalledTimes(1)
  expect(result(await f.cli(['enrollment', 'advance', '--operation-id', f.input.operationId]))).toEqual(saved)
}, 30_000)

it('joins concurrent same intent once and rejects changed target, actor and payload-authored authority', async () => {
  let release!: () => void
  const f = await fixture({ begin: async () => { await new Promise<void>(r => { release = r }); return { kind: 'pending', verificationUrl: 'https://verify.example.invalid/confirm', expiresInMs: null, pollIntervalMs: 0, privateState: 'private-original' } } })
  const a = f.sdk.call('connection.enrollment.begin', f.input), b = f.sdk.call('connection.enrollment.begin', f.input)
  await vi.waitFor(() => expect(f.begin).toHaveBeenCalledTimes(1)); release(); expect(await a).toEqual(await b)
  await expect(f.sdk.call('connection.enrollment.begin', { ...f.input, label: 'Different' })).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
  expect((await f.cli(['enrollment', 'begin', '--input', '-'], { ...f.input, actor: { kind: 'user', id: 'claimed' } })).code).not.toBe(0)
  const service = new AgentMuxRpcService({ connections: f.services.connections }); clean.push(() => service.dispose())
  await expect(service.call('connection.enrollment.advance', { operationId: f.input.operationId }, {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(service.call('connection.enrollment.advance', { operationId: f.input.operationId }, { principal: { kind: 'device', id: 'another-device' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(f.begin).toHaveBeenCalledTimes(1); expect(f.poll).not.toHaveBeenCalled()
}, 20_000)

it('keeps encryption unavailable before begin, and retains unknown effect without automatic poll or creation', async () => {
  const f = await fixture({ begin: async () => { throw new Error('private remote device code and credential') } })
  f.encryption.isEncryptionAvailable = () => false
  const notStarted = await f.sdk.call('connection.enrollment.begin', f.input); expect(notStarted.authorization).toBe('not-started'); expect(notStarted.reason).toBe('secure-storage-unavailable'); expect(f.begin).not.toHaveBeenCalled()
  f.encryption.isEncryptionAvailable = () => true
  const unknown = await f.sdk.call('connection.enrollment.begin', f.input); expect(unknown.authorization).toBe('unknown'); expect(JSON.stringify(unknown)).not.toContain('private remote')
  expect(await f.sdk.call('connection.enrollment.advance', { operationId: f.input.operationId })).toEqual(unknown)
  await f.closeOwner(); await f.reopen(); expect(result(await f.cli(['enrollment', 'ls'])).operations).toEqual([unknown]); expect(f.begin).toHaveBeenCalledTimes(1); expect(f.poll).not.toHaveBeenCalled()
}, 20_000)

it('recovers committed secure credential after acknowledgement loss without polling the one-time secret again', async () => {
  const f = await fixture(), original = DesktopConnectorSecrets.prototype.store
  let lost = false
  vi.spyOn(DesktopConnectorSecrets.prototype, 'store').mockImplementation(async function(this: DesktopConnectorSecrets, input) { const saved = await original.call(this, input); if (input.secret === fixtureCredential && !lost) { lost = true; throw new AgentMuxError('Credential acknowledgement unavailable.', 'CONNECTION_CREDENTIAL_UNCONFIRMED') }; return saved })
  await f.sdk.call('connection.enrollment.begin', f.input)
  const unknown = await f.sdk.call('connection.enrollment.advance', { operationId: f.input.operationId }); expect(unknown.authorization).toBe('authorized'); expect(unknown.credential).toBe('unknown'); expect(unknown.application?.appId).toBe('application-original')
  expect(unknown.diagnostic).toEqual({ stage: 'secure-storage', code: 'credential-unconfirmed' })
  await f.closeOwner(); await f.reopen()
  const saved = result(await f.cli(['enrollment', 'advance', '--operation-id', f.input.operationId])); expect(saved.configuration).toBe('configured'); expect(f.poll).toHaveBeenCalledTimes(1)
  expect(saved).not.toHaveProperty('diagnostic')
}, 20_000)

it('continues a live verified secret after transient storage failure without a second platform poll', async () => {
  const f = await fixture(), original = DesktopConnectorSecrets.prototype.store
  let fail = true
  vi.spyOn(DesktopConnectorSecrets.prototype, 'store').mockImplementation(async function(this: DesktopConnectorSecrets, input) {
    if (input.secret === fixtureCredential && fail) throw new AgentMuxError('Secure storage is temporarily locked.', 'CONNECTION_CREDENTIAL_UNAVAILABLE')
    return await original.call(this, input)
  })
  await f.sdk.call('connection.enrollment.begin', f.input)
  const unknown = await f.sdk.call('connection.enrollment.advance', { operationId: f.input.operationId })
  expect(unknown.authorization).toBe('authorized'); expect(unknown.credential).toBe('unknown')
  expect(unknown.diagnostic).toEqual({ stage: 'secure-storage', code: 'credential-unconfirmed' })
  expect(f.services.database!.prepare('SELECT * FROM connection_credential').all()).toHaveLength(1)
  fail = false
  const saved = await f.sdk.call('connection.enrollment.advance', { operationId: f.input.operationId })
  expect(saved.configuration).toBe('configured'); expect(f.poll).toHaveBeenCalledTimes(1)
  expect(saved).not.toHaveProperty('diagnostic')
}, 20_000)

it('joins original configure after lost receipt and refuses a foreign configure operation instead of certifying it', async () => {
  const f = await fixture(), original = ConnectionHost.prototype.configure
  let lost = false
  const configure = vi.spyOn(ConnectionHost.prototype, 'configure').mockImplementation(async function(this: ConnectionHost, input) { const saved = await original.call(this, input); if (!lost) { lost = true; throw new AgentMuxError('Configuration acknowledgement unavailable.', 'CONNECTION_STORAGE_UNCONFIRMED') }; return saved })
  await f.sdk.call('connection.enrollment.begin', f.input)
  const unknown = await f.sdk.call('connection.enrollment.advance', { operationId: f.input.operationId }); expect(unknown.configuration).toBe('unknown'); expect(unknown.credential).toBe('stored')
  const inspect = ConnectionHost.prototype.inspect
  const spy = vi.spyOn(ConnectionHost.prototype, 'inspect').mockImplementation(async function(this: ConnectionHost, input) { const r = await inspect.call(this, input); return r.operation ? { ...r, operation: { ...r.operation, operationId: 'foreign-configure' } } : r })
  expect((await f.sdk.call('connection.enrollment.advance', { operationId: f.input.operationId })).configuration).toBe('unknown')
  spy.mockRestore()
  const saved = result(await f.cli(['enrollment', 'advance', '--operation-id', f.input.operationId])); expect(saved.configuration).toBe('configured'); expect(configure).toHaveBeenCalledTimes(1); expect(f.poll).toHaveBeenCalledTimes(1)
  expect(f.services.database!.prepare('SELECT * FROM connection_configuration_operation').all()).toHaveLength(1)
}, 20_000)

it('retains the verified original response before a transient application journal write failure', async () => {
  let failIdentity = false
  const f = await fixture({ poll: async input => { failIdentity = true; return { kind: 'authorized', application: { domain: input.domain, appId: 'application-original' }, secret: fixtureCredential } } })
  await f.sdk.call('connection.enrollment.begin', f.input)
  const database = f.services.database!, prepare = database.prepare.bind(database)
  vi.spyOn(database, 'prepare').mockImplementation(sql => {
    if (failIdentity && sql.startsWith('UPDATE connection_enrollment SET')) { failIdentity = false; throw new Error('Original application journal temporarily unavailable') }
    return prepare(sql)
  })
  const unknown = await f.sdk.call('connection.enrollment.advance', { operationId: f.input.operationId })
  expect(unknown.authorization).toBe('unknown'); expect(f.poll).toHaveBeenCalledTimes(1)
  const saved = await f.sdk.call('connection.enrollment.advance', { operationId: f.input.operationId })
  expect(saved.configuration).toBe('configured'); expect(saved.application?.appId).toBe('application-original'); expect(f.poll).toHaveBeenCalledTimes(1)
}, 20_000)

it('rejects a stale poll snapshot after another owner advances its revision and original interval', async () => {
  const f = await fixture({ poll: async () => ({ kind: 'pending', verificationUrl: 'https://verify.example.invalid/confirm', expiresInMs: null, pollIntervalMs: 60_000, privateState: 'next-original-private-state' }) })
  await f.sdk.call('connection.enrollment.begin', f.input)
  const row = f.services.database!.prepare('SELECT record_json FROM connection_enrollment WHERE operation_id=?').get(f.input.operationId)!
  const actor = JSON.parse(String(row.record_json)).actor as { kind: 'user'; id: string }
  const second = await createDesktopConnections({ directory: f.directory, encryption: f.encryption, adapters: [f.adapter] })
  clean.push(() => second.close())
  let release!: () => void, paused!: () => void, checks = 0
  const reached = new Promise<void>(r => { paused = r }), resume = new Promise<void>(r => { release = r })
  const late = f.services.connections.enrollment!.advance({ operationId: f.input.operationId }, { actor, assertCurrent: async () => { if (++checks === 2) { paused(); await resume } } })
  await reached
  const current = await second.connections.enrollment!.advance({ operationId: f.input.operationId }, { actor })
  expect(f.poll).toHaveBeenCalledTimes(1); expect(current.challenge!.nextPollAt).toBeGreaterThan(Date.now())
  release()
  expect(await late).toEqual(current)
  expect(f.poll).toHaveBeenCalledTimes(1)
  expect(f.services.database!.prepare("SELECT * FROM connection_enrollment_attempt WHERE kind='poll'").all()).toHaveLength(1)
}, 20_000)

it('isolates enrollment-only schema failure and retries without closing the original connection owner', async () => {
  const connections = new ConnectionHost({ databasePath: ':memory:', secrets: { resolve: async () => null } })
  const saved = await connections.configure({ operationId: 'existing-configure', expectedRevision: null, connection: { connectionId: 'existing-connection', adapterId: 'original', application: { domain: 'original.example', appId: 'application-original' }, label: 'Existing connection', enabled: true, credentialRef: 'original-credential' } })
  const execute = DatabaseSync.prototype.exec, close = vi.spyOn(DatabaseSync.prototype, 'close')
  const failure = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function(this: DatabaseSync, sql) {
    if (sql.includes('CREATE TABLE IF NOT EXISTS connection_enrollment (')) throw new Error('Private enrollment storage diagnostic')
    return execute.call(this, sql)
  })
  try {
    await expect(connections.enrollment!.list({})).rejects.toMatchObject({ code: 'CONNECTION_ENROLLMENT_UNAVAILABLE' })
    expect(await connections.list()).toEqual({ connections: [saved.connection] })
    expect((await connections.inspect({ operationId: saved.operationId })).operation).toEqual(saved)
    expect(close).not.toHaveBeenCalled()
    failure.mockRestore()
    expect((await connections.enrollment!.list({})).operations).toEqual([])
    expect((await connections.list()).connections).toHaveLength(1)
  } finally { failure.mockRestore(); connections.close() }
  expect(close).toHaveBeenCalledTimes(1)
  const shared = new DatabaseSync(':memory:')
  try {
    const unopened = new ConnectionHost({ database: shared, secrets: { resolve: async () => null } })
    unopened.close()
    await expect(unopened.enrollment!.list({})).rejects.toMatchObject({ code: 'CONNECTION_ENROLLMENT_UNAVAILABLE' })
    expect(shared.prepare('SELECT 1 AS retained').get()).toEqual({ retained: 1 })
  } finally { shared.close() }
})

it('lists bounded original attempts without platform activity and rejects unsafe public projections', async () => {
  const f = await fixture()
  for (const id of ['first', 'second', 'third']) await f.sdk.call('connection.enrollment.begin', { ...f.input, operationId: id, connectionId: 'connection-' + id })
  const first = result(await f.cli(['enrollment', 'ls', '--limit', '1'])); expect(first.operations.map((o: { operationId: string }) => o.operationId)).toEqual(['third']); expect(first.next).not.toBeNull()
  const second = result(await f.cli(['enrollment', 'ls', '--limit', '1', '--cursor', first.next])); expect(second.operations[0].operationId).toBe('second')
  expect(f.begin).toHaveBeenCalledTimes(3); expect(f.poll).not.toHaveBeenCalled()
  const fact = first.operations[0]
  expect(() => parseConnectionEnrollmentOperation({ ...fact, secret: fixtureCredential })).toThrow()
  expect(() => parseConnectionEnrollmentResult('connection.enrollment.inspect', { operation: { ...fact, operationId: 'foreign' } }, { operationId: 'third' })).toThrow()
  expect(() => parseConnectionEnrollmentOperation({ ...fact, configuration: 'configured' })).toThrow()
  expect((await f.cli(['enrollment', 'ls', '--limit', '0'])).code).not.toBe(0)
}, 20_000)

it('the default Host and compiled CLI preserve the original public-code challenge across owner reopen', async () => {
  const f = await defaultFixture(), deviceCode = 'private-platform-device-material'
  const fetch = vi.fn(async () => {
    const row = f.services.database!.prepare('SELECT record_json FROM connection_enrollment WHERE operation_id=?').get(f.input.operationId)!
    expect(JSON.parse(String(row.record_json)).operation).toMatchObject({ authorization: 'unknown', reason: 'begin-unconfirmed' })
    return Response.json({ device_code: deviceCode, user_code: 'PUBLIC-CODE', verification_uri: 'https://open.feishu.cn/page/cli', expire_in: 600, interval: 5 })
  })
  vi.stubGlobal('fetch', fetch)
  const pending = result(await f.cli(['begin', '--input', '-'], f.input))
  expect(pending.authorization).toBe('pending')
  const url = new URL(pending.challenge.verificationUrl)
  expect(url.origin + url.pathname).toBe('https://open.feishu.cn/page/cli')
  expect(url.searchParams.get('user_code')).toBe('PUBLIC-CODE')
  expect(url.searchParams.get('source')).toBe('node-sdk/agentmux')
  expect(pending).not.toHaveProperty('diagnostic')
  expect((await f.sdk.call('connection.enrollment.inspect', { operationId: f.input.operationId })).operation).toEqual(pending)
  f.services.database!.exec('PRAGMA wal_checkpoint(FULL)')
  expect((await readFile(join(f.directory, 'connections.sqlite'))).includes(Buffer.from(deviceCode))).toBe(false)
  await f.closeOwner(); await f.reopen()
  expect(result(await f.cli(['inspect', '--operation-id', f.input.operationId])).operation).toEqual(pending)
  expect(result(await f.cli(['ls'])).operations).toEqual([pending])
  expect(await f.sdk.call('connection.enrollment.begin', f.input)).toEqual(pending)
  expect(fetch).toHaveBeenCalledTimes(1)
}, 20_000)

it('public SDK and compiled CLI retain distinct safe response stages without replay after owner reopen', async () => {
  const f = await defaultFixture(), privateDetail = 'private-response-diagnostic-material'
  const samples: Array<{ name: string; response(): Response; diagnostic: ConnectionEnrollmentDiagnostic }> = [
    { name: 'http', response: () => Response.json({ error: privateDetail }, { status: 503 }), diagnostic: { stage: 'response', code: 'http-status', httpStatus: 503 } },
    { name: 'platform', response: () => Response.json({ error: 'invalid_request', error_description: privateDetail }, { status: 400 }), diagnostic: { stage: 'response', code: 'platform-error', httpStatus: 400 } },
    { name: 'json', response: () => new Response(privateDetail), diagnostic: { stage: 'response', code: 'invalid-json', httpStatus: 200 } },
    { name: 'shape', response: () => Response.json([]), diagnostic: { stage: 'response', code: 'invalid-response', httpStatus: 200 } },
    { name: 'malformed-error', response: () => Response.json({ error: false }), diagnostic: { stage: 'response', code: 'invalid-response', httpStatus: 200 } },
    { name: 'transport', response: () => { throw new TypeError(privateDetail) }, diagnostic: { stage: 'request', code: 'transport-unconfirmed' } },
    { name: 'challenge', response: () => Response.json({ device_code: privateDetail, user_code: 'PUBLIC', verification_uri_complete: 'https://attacker.invalid/confirm' }), diagnostic: { stage: 'challenge', code: 'unsafe-verification' } }
  ]
  const observations = []
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  for (const sample of samples) {
    fetch.mockImplementation(async () => sample.response())
    const input = { ...f.input, operationId: 'original-' + sample.name, connectionId: 'connection-' + sample.name }
    const value = await f.sdk.call('connection.enrollment.begin', input)
    expect(value).toMatchObject({ operationId: input.operationId, connectionId: input.connectionId, authorization: 'unknown', credential: 'not-started', configuration: 'not-started', challenge: null, diagnostic: sample.diagnostic })
    expect(JSON.stringify(value)).not.toContain(privateDetail)
    expect(JSON.stringify(value)).not.toContain('attacker.invalid')
    expect((await f.sdk.call('connection.enrollment.inspect', { operationId: input.operationId })).operation).toEqual(value)
    observations.push(value)
  }
  expect(fetch).toHaveBeenCalledTimes(samples.length)
  await f.closeOwner(); await f.reopen()
  const list = result(await f.cli(['ls']))
  expect(list.operations).toEqual(observations.toReversed())
  for (const value of observations) {
    expect(result(await f.cli(['inspect', '--operation-id', value.operationId])).operation).toEqual(value)
    expect(await f.sdk.call('connection.enrollment.advance', { operationId: value.operationId })).toEqual(value)
  }
  expect(fetch).toHaveBeenCalledTimes(samples.length)
}, 30_000)

it('distinguishes a secure challenge checkpoint failure and clears it on original local recovery', async () => {
  const f = await fixture(), store = DesktopConnectorSecrets.prototype.store
  let blocked = true
  vi.spyOn(DesktopConnectorSecrets.prototype, 'store').mockImplementation(async function(this: DesktopConnectorSecrets, input) {
    if (blocked) throw new Error('private secure-storage detail')
    return store.call(this, input)
  })
  const unknown = await f.sdk.call('connection.enrollment.begin', f.input)
  expect(unknown).toMatchObject({ authorization: 'unknown', reason: 'begin-unconfirmed', challenge: null, diagnostic: { stage: 'secure-storage', code: 'challenge-unconfirmed' } })
  expect(JSON.stringify(unknown)).not.toContain('private secure-storage')
  expect(result(await f.cli(['enrollment', 'inspect', '--operation-id', f.input.operationId])).operation).toEqual(unknown)
  blocked = false
  const pending = await f.sdk.call('connection.enrollment.advance', { operationId: f.input.operationId })
  expect(pending.authorization).toBe('pending'); expect(pending).not.toHaveProperty('diagnostic')
  expect(f.begin).toHaveBeenCalledTimes(1); expect(f.poll).not.toHaveBeenCalled()
  await f.closeOwner(); await f.reopen()
  expect(result(await f.cli(['enrollment', 'inspect', '--operation-id', f.input.operationId])).operation).toEqual(pending)
  expect(f.begin).toHaveBeenCalledTimes(1); expect(f.poll).not.toHaveBeenCalled()
}, 20_000)

it.each(['begin', 'poll'] as const)('does not invent a transport stage from a generic adapter exception during %s', async phase => {
  const fail = async (): Promise<never> => { throw new Error('private adapter decode or preparation failure') }
  const f = await fixture(phase === 'begin' ? { begin: fail } : { poll: fail })
  const pending = await f.sdk.call('connection.enrollment.begin', f.input)
  const original = phase === 'begin' ? pending : await f.sdk.call('connection.enrollment.advance', { operationId: f.input.operationId })
  expect(original.authorization).toBe('unknown')
  expect(original).not.toHaveProperty('diagnostic')
  expect(JSON.stringify(original)).not.toContain('private adapter')
  expect(result(await f.cli(['enrollment', 'inspect', '--operation-id', f.input.operationId])).operation).toEqual(original)
  expect(await f.sdk.call('connection.enrollment.advance', { operationId: f.input.operationId })).toEqual(original)
  expect(f.begin).toHaveBeenCalledTimes(1)
  expect(f.poll).toHaveBeenCalledTimes(phase === 'poll' ? 1 : 0)
}, 20_000)

it('does not attach a late checkpoint error to an original challenge another owner has recovered', async () => {
  const f = await fixture(), store = DesktopConnectorSecrets.prototype.store
  let release!: () => void, reached!: () => void, held = true
  const waiting = new Promise<void>(r => { reached = r }), resume = new Promise<void>(r => { release = r })
  vi.spyOn(DesktopConnectorSecrets.prototype, 'store').mockImplementation(async function(this: DesktopConnectorSecrets, input) {
    const saved = await store.call(this, input)
    if (held) { held = false; reached(); await resume; throw new Error('private late checkpoint acknowledgement') }
    return saved
  })
  const original = f.sdk.call('connection.enrollment.begin', f.input)
  await waiting
  const second = await createDesktopConnections({ directory: f.directory, encryption: f.encryption, adapters: [f.adapter] }); clean.push(() => second.close())
  const row = f.services.database!.prepare('SELECT record_json FROM connection_enrollment WHERE operation_id=?').get(f.input.operationId)!
  const actor = JSON.parse(String(row.record_json)).actor as { kind: 'user'; id: string }
  const recovered = await second.connections.enrollment!.advance({ operationId: f.input.operationId }, { actor })
  expect(recovered.authorization).toBe('pending'); expect(recovered).not.toHaveProperty('diagnostic')
  release()
  expect(await original).toEqual(recovered)
  expect(f.begin).toHaveBeenCalledTimes(1); expect(f.poll).not.toHaveBeenCalled()
}, 20_000)

it('keeps old unknown receipts valid and rejects extra or cross-stage diagnostic fields', async () => {
  const f = await fixture({ begin: async () => ({ kind: 'unknown' }) })
  const original = await f.sdk.call('connection.enrollment.begin', f.input)
  expect(original).not.toHaveProperty('diagnostic')
  expect(parseConnectionEnrollmentOperation(original)).toEqual(original)
  for (const diagnostic of [
    { stage: 'request', code: 'invalid-json' }, { stage: 'request', code: 'cancelled', httpStatus: 200 },
    { stage: 'response', code: 'http-status', httpStatus: 99 }, { stage: 'response', code: 'http-status', httpStatus: 600 },
    { stage: 'response', code: 'http-status', httpStatus: 200.5 }, { stage: 'response', code: 'http-status', httpStatus: '400' },
    { stage: 'response', code: 'platform-error', raw: 'private response' },
    { stage: 'challenge', code: 'unsafe-verification', verificationUrl: 'https://attacker.invalid' },
    { stage: 'secure-storage', code: 'credential-unconfirmed', secret: fixtureCredential },
    { stage: 'foreign', code: 'transport-unconfirmed' }
  ]) expect(() => parseConnectionEnrollmentOperation({ ...original, diagnostic })).toThrowError(expect.objectContaining({ code: 'INVALID_CONNECTION_ENROLLMENT_DATA' }))
  await f.closeOwner(); await f.reopen()
  expect(result(await f.cli(['enrollment', 'inspect', '--operation-id', f.input.operationId])).operation).toEqual(original)
  expect(f.begin).toHaveBeenCalledTimes(1); expect(f.poll).not.toHaveBeenCalled()
}, 20_000)

it.each(['begin', 'poll'] as const)('keeps a preclaimed unknown %s across actual child death and a new public owner', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'enroll-child-')); clean.push(() => rm(root, { recursive: true, force: true }))
  const socketPath = join(root, 'owner.sock'), input = { operationId: 'child-original', connectionId: 'child-connection', adapterId: 'challenge', domain: 'challenge.example', label: 'Child bot' }
  const start = async (fault: string) => {
    const child = fork(new URL('./fixtures/connection-enrollment-owner.mjs', import.meta.url), [root, fault], { execArgv: ['--experimental-transform-types'], env: objectCliEnvironment(root), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    let errors = ''; child.stderr!.on('data', v => { errors += v })
    clean.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit') } })
    await new Promise<void>((resolve, reject) => { child.on('message', v => { if ((v as { kind: string }).kind === 'ready') resolve() }); child.once('exit', () => reject(new Error(errors || 'Owner exited before ready'))) })
    return child
  }
  const cli = (args: string[], body?: unknown) => runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', 'enrollment', ...args], objectCliEnvironment(root), body ? JSON.stringify(body) : '')
  const child = await start(mode)
  if (mode === 'poll') expect(result(await cli(['begin', '--input', '-'], input)).authorization).toBe('pending')
  const applied = new Promise<void>(resolve => child.on('message', m => { if ((m as { kind: string }).kind === 'effect-applied') resolve() }))
  const inflight = mode === 'begin' ? cli(['begin', '--input', '-'], input) : cli(['advance', '--operation-id', input.operationId])
  await applied; child.kill('SIGKILL'); await once(child, 'exit'); expect((await inflight).code).not.toBe(0)
  const replacement = await start('observe')
  const inspected = result(await cli(['inspect', '--operation-id', input.operationId])); expect(inspected.operation.authorization).toBe('unknown'); expect(inspected.operation.connectionId).toBe(input.connectionId)
  expect(result(await cli(['ls'])).operations).toEqual([inspected.operation])
  expect(result(await cli(['advance', '--operation-id', input.operationId]))).toEqual(inspected.operation)
  const effects = (await readFile(join(root, 'effects'), 'utf8')).trim().split('\n')
  expect(effects).toHaveLength(1)
  const durable = new DatabaseSync(join(root, 'connections.sqlite'), { readOnly: true })
  try {
    const attempts = durable.prepare('SELECT attempt_id,operation_id,kind,state FROM connection_enrollment_attempt WHERE kind=?').all(mode)
    expect(attempts).toEqual([{ attempt_id: effects[0]!.slice(mode.length + 1), operation_id: input.operationId, kind: mode, state: 'claimed' }])
  } finally { durable.close() }
  replacement.kill('SIGKILL'); await once(replacement, 'exit')
}, 30_000)
