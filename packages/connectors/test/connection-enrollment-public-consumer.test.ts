import { isObjectId } from '@agentmux/core'
import { expectConnectionAllocations } from './helpers/unified-identifiers.js'
import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { DatabaseSync } from 'node:sqlite'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, AgentMuxError, AgentMuxRpcService, connectAgentMuxRpc } from '@agentmux/core'
import { parseConnectionEnrollmentDiagnostic, parseConnectionEnrollmentOperation, parseConnectionEnrollmentResult, type ConnectionEnrollmentActionKind, type ConnectionEnrollmentView } from '@agentmux/core/connections'
import { ConnectionHost } from '@agentmux/connectors'
import { DesktopConnectorSecrets } from '../../../apps/desktop/src/main/connector-secrets.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { enrollmentAvatar, enrollmentEncryption, enrollmentFixture, fixtureCredential, fixturePrivateState } from './fixtures/connection-enrollment.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const clean: Array<() => void | Promise<void>> = []
afterEach(async () => { const errors: unknown[] = []; try { for (const close of clean.splice(0).reverse()) { try { await close() } catch (error) { errors.push(error) } } } finally { try { vi.restoreAllMocks() } catch (error) { errors.push(error) }; try { vi.unstubAllGlobals() } catch (error) { errors.push(error) } }; if (errors.length) throw new AggregateError(errors, 'Enrollment consumer cleanup failed') })
async function fixture(options?: Parameters<typeof enrollmentFixture>[0]) { const f = await enrollmentFixture(options); clean.push(f.close); return f }
function result(o: { code: number | null; stdout: string; stderr: string }) { expect(o.code, o.stdout + o.stderr).toBe(0); return JSON.parse(o.stdout).result }
type Fixture = Awaited<ReturnType<typeof fixture>>
function decision(view: ConnectionEnrollmentView, kind: ConnectionEnrollmentActionKind) { const choices = view.actions.filter(action => action.kind === kind); expect(choices).toHaveLength(1); const action = choices[0]!; return { operationId: view.operation!.operationId, ownRevision: action.ownRevision, decision: { actionId: action.actionId, kind } } }
async function advance(f: Pick<Fixture, 'sdk'>, view: ConnectionEnrollmentView, kind: ConnectionEnrollmentActionKind) { return f.sdk.call('connection.enrollment.advance', decision(view, kind)) }
async function inspect(f: Pick<Fixture, 'sdk' | 'input'>) { return f.sdk.call('connection.enrollment.inspect', { operationId: f.input.operationId }) }
async function confirmed(f: Fixture) { const waiting = await f.sdk.call('connection.enrollment.begin', f.input); const account = await advance(f, waiting, 'continue-authentication'); expect(account.account).toMatchObject({ userId: 'original-user', tenantId: 'original-tenant' }); return advance(f, account, 'confirm-account') }
async function create(f: Fixture) { return advance(f, await confirmed(f), 'create') }
function stored(f: Pick<Fixture, 'services' | 'input'>) { return JSON.parse(String(f.services.database!.prepare('SELECT record_json FROM connection_enrollment WHERE operation_id=?').get(f.input.operationId)!.record_json)) }
async function defaultFixture() {
  const root = await mkdtemp(join(tmpdir(), 'enroll-default-')), directory = join(root, 'connections'), socketPath = join(root, 'public.sock'), encryption = enrollmentEncryption()
  let services: Awaited<ReturnType<typeof createDesktopConnections>>, server: AgentMuxControlServer, sdk: Awaited<ReturnType<typeof connectAgentMuxRpc>>
  const open = async () => {
    services = await createDesktopConnections({ directory, encryption })
    server = new AgentMuxControlServer({ socketPath, connections: services.connections, coreClients: () => { throw new Error('Registration cannot borrow an Agent Runtime') } })
    await server.start(); sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  }
  const closeOwner = async () => { const errors: unknown[] = []; for (const close of [async () => { await sdk?.dispose() }, async () => { await server?.stop() }, () => { services?.close() }]) { try { await close() } catch (error) { errors.push(error) } }; if (errors.length) throw new AggregateError(errors, 'Default enrollment owner cleanup failed') }
  clean.push(async () => { const errors: unknown[] = []; try { await closeOwner() } catch (error) { errors.push(error) }; try { await rm(root, { recursive: true, force: true }) } catch (error) { errors.push(error) }; if (errors.length) throw new AggregateError(errors, 'Default enrollment fixture cleanup failed') })
  await open()
  const input = { operationId: 'original-platform-enrollment', connectionId: 'original-platform-connection', adapterId: 'feishu', domain: 'open.feishu.cn', label: 'Original bot', preset: { name: 'Original bot', avatar: { pngDataUrl: enrollmentAvatar } } }
  const cli = (args: string[], body?: unknown) => runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', 'enrollment', ...args], objectCliEnvironment(root), body === undefined ? '' : JSON.stringify(body))
  return { root, directory, input, encryption, cli, closeOwner, reopen: open, get services() { return services }, get sdk() { return sdk } }
}
async function legacy(f: Awaited<ReturnType<typeof defaultFixture>> | Fixture, state: 'pending' | 'unknown') {
  await f.sdk.call('connection.enrollment.ls', {})
  const { preset: _preset, ...identity } = f.input
  const operation = { ...identity, revision: 1, authorization: state, credential: 'not-started', configuration: 'not-started', application: null, configured: null, challenge: { verificationUrl: 'https://open.feishu.cn/page/cli?user_code=ORIGINAL', expiresAt: null, nextPollAt: _historyFixtureEpoch(0, 0, 0) } }
  const row = { operation, actor: { kind: 'user', id: `local-user:${process.getuid?.() ?? 'current'}` }, credentialOperationId: 'legacy-credential', configureOperationId: 'legacy-configure', attemptId: null, attemptKind: null, snapshotOperationId: null, privateRef: null }
  f.services.database!.prepare('INSERT INTO connection_enrollment(operation_id,connection_id,record_json) VALUES(?,?,?)').run(f.input.operationId, f.input.connectionId, JSON.stringify(row))
  return JSON.stringify(row)
}

it('uses compiled CLI and original SDK through the Desktop owner, preserving encrypted handoff and independent connection facts', async () => {
  const f = await fixture()
  const caps = result(await f.cli(['enrollment', 'ls'])); expect(caps.operations).toEqual([]); expect(caps.capabilities).toEqual([{ adapterId: f.input.adapterId, domain: f.input.domain, label: 'Signed challenge', availability: 'available' }]); expect(f.begin).not.toHaveBeenCalled()
  const pending = result(await f.cli(['enrollment', 'begin', '--input', '-'], f.input)); expect(pending.operation.authentication.stage).toBe('waiting'); expect(pending.operation.application).toBeNull(); expect(pending.operation.configured).toBeNull()
  expect(result(await f.cli(['ls'])).connections).toEqual([])
  const account = result(await f.cli(['enrollment', 'advance', '--input', '-'], decision(pending, 'continue-authentication')))
  const consent = result(await f.cli(['enrollment', 'advance', '--input', '-'], decision(account, 'confirm-account')))
  const originalCreate = decision(consent, 'create'), view = result(await f.cli(['enrollment', 'advance', '--input', '-'], originalCreate)), saved = view.operation
  expect(saved.authorization).toBe('authorized'); expect(saved.credential).toBe('stored'); expect(saved.configuration).toBe('configured'); expect(saved.configured.connection.revision).toBe(1)
  expect(saved.configured.connection.config.enabled).toBe(true); expect(saved.configured.connection.config.connectionId).toBe(f.input.connectionId); expect(saved.configured.connection.observation.transport.state).toBe('unknown')
  expect(await inspect(f)).toEqual(view)
  expect((await f.sdk.call('connection.test', { connectionId: f.input.connectionId })).observation.authentication.state).toBe('ready')
  expect(f.begin).toHaveBeenCalledTimes(1); expect(f.authentication).toHaveBeenCalledTimes(1); expect(f.create).toHaveBeenCalledTimes(1); expect(f.credential).toHaveBeenCalledTimes(1)
  const serialized = JSON.stringify([caps, pending, saved]); expect(serialized).not.toContain(fixtureCredential); expect(serialized).not.toContain(fixturePrivateState)
  const rows = f.services.database!.prepare('SELECT record_json FROM connection_enrollment').all(); expect(JSON.stringify(rows)).not.toContain(fixtureCredential); expect(JSON.stringify(rows)).not.toContain('"signed":')
  expectConnectionAllocations(JSON.parse(String(rows[0]!.record_json)))
  const owners = f.services.database!.prepare('SELECT owner FROM connection_enrollment_attempt').all()
  expect(owners.length).toBeGreaterThan(0)
  for (const owner of owners) expect(isObjectId(owner.owner)).toBe(true)
  const bytes = await readFile(join(f.directory, 'connections.sqlite')); expect(bytes.includes(Buffer.from(fixtureCredential))).toBe(false)
  await f.closeOwner(); await f.reopen()
  const reopened = result(await f.cli(['enrollment', 'ls'])); expect(reopened.operations).toEqual([saved]); expect(f.authentication).toHaveBeenCalledTimes(1)
  expect(result(await f.cli(['enrollment', 'advance', '--input', '-'], originalCreate))).toEqual(view)
}, 30_000)

it('joins concurrent same intent once and rejects changed target, actor and payload-authored authority', async () => {
  let release!: () => void
  const f = await fixture({ begin: async () => { await new Promise<void>(r => { release = r }); return { kind: 'authentication', stage: 'waiting', challenge: { qrPayload: 'private-original', expiresAt: null, nextPollAt: _historyFixtureEpoch(0, 0, 0) }, account: null, privateState: 'private-original' } } })
  const a = f.sdk.call('connection.enrollment.begin', f.input), b = f.sdk.call('connection.enrollment.begin', f.input)
  await vi.waitFor(() => expect(f.begin).toHaveBeenCalledTimes(1)); release(); expect(await a).toEqual(await b)
  await expect(f.sdk.call('connection.enrollment.begin', { ...f.input, label: 'Different' })).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
  expect((await f.cli(['enrollment', 'begin', '--input', '-'], { ...f.input, actor: { kind: 'user', id: 'claimed' } })).code).not.toBe(0)
  const service = new AgentMuxRpcService({ connections: f.services.connections }); clean.push(() => service.dispose())
  const original = decision(await inspect(f), 'continue-authentication')
  await expect(service.call('connection.enrollment.advance', original, {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(service.call('connection.enrollment.advance', original, { principal: { kind: 'device', id: 'another-device' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(f.begin).toHaveBeenCalledTimes(1); expect(f.authentication).not.toHaveBeenCalled()
}, 20_000)

it('keeps encryption unavailable before begin, and retains unknown effect without automatic authentication or creation', async () => {
  const f = await fixture({ begin: async () => { throw new Error('private remote device code and credential') } })
  f.encryption.isEncryptionAvailable = () => false
  const notStarted = await f.sdk.call('connection.enrollment.begin', f.input); expect(notStarted.operation!.authorization).toBe('not-started'); expect(notStarted.operation!.diagnostic).toEqual({ stage: 'secure-storage', code: 'asset-unconfirmed' }); expect(f.begin).not.toHaveBeenCalled()
  f.encryption.isEncryptionAvailable = () => true
  const unknown = await f.sdk.call('connection.enrollment.begin', f.input); expect(unknown.operation!.authentication!.stage).toBe('unknown'); expect(JSON.stringify(unknown)).not.toContain('private remote')
  const recovered = await advance(f, unknown, 'recover-local'); expect(recovered.operation!.authentication!.stage).toBe('unknown')
  await f.closeOwner(); await f.reopen(); expect(result(await f.cli(['enrollment', 'ls'])).operations).toEqual([recovered.operation]); expect(f.begin).toHaveBeenCalledTimes(1); expect(f.authentication).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled()
}, 20_000)

it('recovers committed secure credential after acknowledgement loss without reading the original secret again', async () => {
  const f = await fixture(), original = DesktopConnectorSecrets.prototype.store
  let lost = false
  vi.spyOn(DesktopConnectorSecrets.prototype, 'store').mockImplementation(async function(this: DesktopConnectorSecrets, input) { const saved = await original.call(this, input); if (input.secret === fixtureCredential && !lost) { lost = true; throw new AgentMuxError('Credential acknowledgement unavailable.', 'CONNECTION_CREDENTIAL_UNCONFIRMED') }; return saved })
  const unknown = await create(f); expect(unknown.operation!.authorization).toBe('authorized'); expect(unknown.operation!.credential).toBe('unknown'); expect(unknown.operation!.application?.appId).toBe('application-original')
  expect(unknown.operation!.diagnostic).toEqual({ stage: 'secure-storage', code: 'credential-unconfirmed' })
  await f.closeOwner(); await f.reopen()
  const saved = result(await f.cli(['enrollment', 'advance', '--input', '-'], decision(await inspect(f), 'recover-local'))); expect(saved.operation.configuration).toBe('configured'); expect(f.credential).toHaveBeenCalledTimes(1)
  expect(saved.operation).not.toHaveProperty('diagnostic')
}, 20_000)

it('continues a live verified secret after transient storage failure without a second native credential read', async () => {
  const f = await fixture(), original = DesktopConnectorSecrets.prototype.store
  let fail = true
  vi.spyOn(DesktopConnectorSecrets.prototype, 'store').mockImplementation(async function(this: DesktopConnectorSecrets, input) {
    if (input.secret === fixtureCredential && fail) throw new AgentMuxError('Secure storage is temporarily locked.', 'CONNECTION_CREDENTIAL_UNAVAILABLE')
    return await original.call(this, input)
  })
  const unknown = await create(f)
  expect(unknown.operation!.authorization).toBe('authorized'); expect(unknown.operation!.credential).toBe('unknown')
  expect(unknown.operation!.diagnostic).toEqual({ stage: 'secure-storage', code: 'credential-unconfirmed' })
  expect(await f.services.secrets.inspect(stored(f).credentialOperationId)).toBeNull()
  fail = false
  const saved = await advance(f, unknown, 'recover-local')
  expect(saved.operation!.configuration).toBe('configured'); expect(f.credential).toHaveBeenCalledTimes(1)
  expect(saved.operation).not.toHaveProperty('diagnostic')
}, 20_000)

it('joins original configure after lost receipt and refuses a foreign configure operation instead of certifying it', async () => {
  const f = await fixture(), original = ConnectionHost.prototype.configure
  let lost = false
  const configure = vi.spyOn(ConnectionHost.prototype, 'configure').mockImplementation(async function(this: ConnectionHost, input) { const saved = await original.call(this, input); if (!lost) { lost = true; throw new AgentMuxError('Configuration acknowledgement unavailable.', 'CONNECTION_STORAGE_UNCONFIRMED') }; return saved })
  const unknown = await create(f); expect(unknown.operation!.configuration).toBe('unknown'); expect(unknown.operation!.credential).toBe('stored')
  const originalInspect = ConnectionHost.prototype.inspect
  const spy = vi.spyOn(ConnectionHost.prototype, 'inspect').mockImplementation(async function(this: ConnectionHost, input) { const r = await originalInspect.call(this, input); return r.operation ? { ...r, operation: { ...r.operation, operationId: 'foreign-configure' } } : r })
  expect((await advance(f, unknown, 'recover-local')).operation!.configuration).toBe('unknown')
  spy.mockRestore()
  const saved = result(await f.cli(['enrollment', 'advance', '--input', '-'], decision(await inspect(f), 'recover-local'))); expect(saved.operation.configuration).toBe('configured'); expect(configure).toHaveBeenCalledTimes(1); expect(f.credential).toHaveBeenCalledTimes(1)
  expect(f.services.database!.prepare('SELECT * FROM connection_configuration_operation').all()).toHaveLength(1)
}, 20_000)

it('retains the verified original response before a transient application journal write failure', async () => {
  let failIdentity = false
  const f = await fixture({ create: async input => { failIdentity = true; return { kind: 'created', application: { domain: input.domain, appId: 'application-original' }, privateState: input.privateState } } })
  const consent = await confirmed(f)
  const database = f.services.database!, prepare = database.prepare.bind(database)
  vi.spyOn(database, 'prepare').mockImplementation(sql => {
    if (failIdentity && sql.startsWith('UPDATE connection_enrollment SET')) { failIdentity = false; throw new Error('Original application journal temporarily unavailable') }
    return prepare(sql)
  })
  const unknown = await advance(f, consent, 'create')
  expect(unknown.operation!.creation!.create).toBe('unknown'); expect(unknown.operation!.application).toBeNull(); expect(f.create).toHaveBeenCalledTimes(1)
  const known = await advance(f, unknown, 'recover-local')
  expect(known.operation!.application?.appId).toBe('application-original')
  const saved = await advance(f, known, 'read-credential')
  expect(saved.operation!.configuration).toBe('configured'); expect(saved.operation!.application?.appId).toBe('application-original'); expect(f.create).toHaveBeenCalledTimes(1)
}, 20_000)

it('rejects a stale authentication action after another owner advances its revision and original interval', async () => {
  const f = await fixture({ advance: async input => ({ kind: 'authentication', stage: 'waiting', challenge: { qrPayload: 'next-private-qr', expiresAt: null, nextPollAt: Date.now() + 60_000 }, account: null, privateState: input.privateState }) })
  const waiting = await f.sdk.call('connection.enrollment.begin', f.input), input = decision(waiting, 'continue-authentication')
  const row = f.services.database!.prepare('SELECT record_json FROM connection_enrollment WHERE operation_id=?').get(f.input.operationId)!
  const actor = JSON.parse(String(row.record_json)).actor as { kind: 'user'; id: string }
  const second = await createDesktopConnections({ directory: f.directory, encryption: f.encryption, adapters: [f.adapter] })
  clean.push(() => second.close())
  let release!: () => void, paused!: () => void, checks = 0
  const reached = new Promise<void>(r => { paused = r }), resume = new Promise<void>(r => { release = r })
  const late = f.services.connections.enrollment!.advance(input, { actor, assertCurrent: async () => { if (++checks === 2) { paused(); await resume } } })
  const lateResult = late.then(value => ({ value }), error => ({ error }))
  await reached
  const current = await second.connections.enrollment!.advance(input, { actor })
  expect(f.authentication).toHaveBeenCalledTimes(1); expect(current.challenge!.nextPollAt).toBeGreaterThan(Date.now())
  release()
  expect(await lateResult).toMatchObject({ error: { code: 'CONNECTION_REVISION_CONFLICT' } })
  expect((await inspect(f)).operation).toEqual(current.operation)
  expect(f.authentication).toHaveBeenCalledTimes(1)
  expect(f.services.database!.prepare("SELECT * FROM connection_enrollment_attempt WHERE kind='authentication'").all()).toHaveLength(1)
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
  expect(f.begin).toHaveBeenCalledTimes(3); expect(f.authentication).not.toHaveBeenCalled()
  const fact = first.operations[0]
  expect(() => parseConnectionEnrollmentOperation({ ...fact, secret: fixtureCredential })).toThrow()
  expect(() => parseConnectionEnrollmentResult('connection.enrollment.inspect', { operation: { ...fact, operationId: 'foreign' }, challenge: null, account: null, actions: [] }, { operationId: 'third' })).toThrow()
  expect(() => parseConnectionEnrollmentOperation({ ...fact, configuration: 'configured' })).toThrow()
  expect((await f.cli(['enrollment', 'ls', '--limit', '0'])).code).not.toBe(0)
}, 20_000)

it('the default Host and compiled CLI preserve retired public-code records without executing the retired issuer', async () => {
  const f = await defaultFixture(), original = await legacy(f, 'pending')
  const fetch = vi.fn(async () => { throw new Error('A retired native route cannot be executed') })
  vi.stubGlobal('fetch', fetch)
  const pending = result(await f.cli(['inspect', '--operation-id', f.input.operationId]))
  expect(pending.operation.authorization).toBe('pending'); expect(pending.operation).not.toHaveProperty('challenge')
  expect(pending.challenge).toBeNull(); expect(pending.account).toBeNull(); expect(pending.actions.map((a: { kind: string }) => a.kind)).toEqual(['recover-local'])
  expect((await inspect(f)).operation).toEqual(pending.operation)
  expect(JSON.stringify(stored(f))).toBe(original)
  await f.closeOwner(); await f.reopen()
  expect(result(await f.cli(['inspect', '--operation-id', f.input.operationId]))).toEqual(pending)
  expect(result(await f.cli(['ls'])).operations).toEqual([pending.operation])
  expect((await advance(f, pending, 'recover-local')).operation).toEqual(pending.operation)
  await expect(f.sdk.call('connection.enrollment.begin', f.input)).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
  expect(JSON.stringify(stored(f))).toBe(original); expect(fetch).not.toHaveBeenCalled()
}, 20_000)

it('public SDK and compiled CLI retain opaque native authentication diagnostics without guessing response stages or replaying after reopen', async () => {
  const f = await defaultFixture(), privateDetail = 'private-response-diagnostic-material'
  const samples = [
    { name: 'http', response: () => Response.json({ error: privateDetail }, { status: 503 }) },
    { name: 'platform', response: () => Response.json({ error: 'invalid_request', error_description: privateDetail }, { status: 400 }) },
    { name: 'json', response: () => new Response(privateDetail) },
    { name: 'shape', response: () => Response.json([]) },
    { name: 'malformed-error', response: () => Response.json({ error: false }) },
    { name: 'transport', response: () => { throw new TypeError(privateDetail) } },
    { name: 'challenge', response: () => Response.json({ code: 0, data: { step_info: { token: null, verificationUrl: 'https://attacker.invalid/confirm' } } }) }
  ]
  const observations = []
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  for (const sample of samples) {
    fetch.mockImplementation(async () => sample.response())
    const input = { ...f.input, operationId: 'original-' + sample.name, connectionId: 'connection-' + sample.name }
    const value = await f.sdk.call('connection.enrollment.begin', input)
    expect(value).toMatchObject({ operation: { operationId: input.operationId, connectionId: input.connectionId, authentication: { stage: 'unknown' }, credential: 'not-started', configuration: 'not-started', diagnostic: { stage: 'authentication', code: 'native-unconfirmed' } }, challenge: null, account: null })
    expect(JSON.stringify(value)).not.toContain(privateDetail)
    expect(JSON.stringify(value)).not.toContain('attacker.invalid')
    expect(await f.sdk.call('connection.enrollment.inspect', { operationId: input.operationId })).toEqual(value)
    observations.push(value)
  }
  expect(fetch).toHaveBeenCalledTimes(samples.length)
  await f.closeOwner(); await f.reopen()
  const list = result(await f.cli(['ls']))
  expect(list.operations).toEqual(observations.map(value => value.operation).toReversed())
  for (const value of observations) {
    expect(result(await f.cli(['inspect', '--operation-id', value.operation!.operationId]))).toEqual(value)
    expect((await advance(f, value, 'recover-local')).operation!.authentication!.stage).toBe('unknown')
  }
  expect(fetch).toHaveBeenCalledTimes(samples.length)
}, 30_000)

it('distinguishes a secure challenge checkpoint failure and clears it on original local recovery', async () => {
  const f = await fixture(), store = DesktopConnectorSecrets.prototype.store
  let blocked = true
  vi.spyOn(DesktopConnectorSecrets.prototype, 'store').mockImplementation(async function(this: DesktopConnectorSecrets, input) {
    if (blocked && JSON.parse(input.secret).receipt) throw new Error('private secure-storage detail')
    return store.call(this, input)
  })
  const unknown = await f.sdk.call('connection.enrollment.begin', f.input)
  expect(unknown).toMatchObject({ operation: { authentication: { stage: 'unknown' }, diagnostic: { stage: 'secure-storage', code: 'challenge-unconfirmed' } }, challenge: null })
  expect(JSON.stringify(unknown)).not.toContain('private secure-storage')
  expect(result(await f.cli(['enrollment', 'inspect', '--operation-id', f.input.operationId]))).toEqual(unknown)
  blocked = false
  const pending = await advance(f, unknown, 'recover-local')
  expect(pending.operation!.authentication!.stage).toBe('waiting'); expect(pending.operation).not.toHaveProperty('diagnostic')
  expect(f.begin).toHaveBeenCalledTimes(1); expect(f.authentication).not.toHaveBeenCalled()
  await f.closeOwner(); await f.reopen()
  expect(result(await f.cli(['enrollment', 'inspect', '--operation-id', f.input.operationId]))).toEqual(pending)
  expect(f.begin).toHaveBeenCalledTimes(1); expect(f.authentication).not.toHaveBeenCalled()
}, 20_000)

it.each(['begin', 'authentication'] as const)('does not invent a transport stage from a generic adapter exception during %s', async phase => {
  const fail = async (): Promise<never> => { throw new Error('private adapter decode or preparation failure') }
  const f = await fixture(phase === 'begin' ? { begin: fail } : { advance: fail })
  const pending = await f.sdk.call('connection.enrollment.begin', f.input)
  const input = phase === 'begin' ? null : decision(pending, 'continue-authentication')
  const original = input ? await f.sdk.call('connection.enrollment.advance', input) : pending
  expect(original.operation!.authentication!.stage).toBe('unknown')
  expect(original.operation!.diagnostic).toEqual({ stage: 'adapter', code: 'receipt-unconfirmed' })
  expect(JSON.stringify(original)).not.toContain('private adapter')
  expect(result(await f.cli(['enrollment', 'inspect', '--operation-id', f.input.operationId]))).toEqual(original)
  expect(input ? await f.sdk.call('connection.enrollment.advance', input) : await f.sdk.call('connection.enrollment.begin', f.input)).toEqual(original)
  expect(f.begin).toHaveBeenCalledTimes(1)
  expect(f.authentication).toHaveBeenCalledTimes(phase === 'authentication' ? 1 : 0)
}, 20_000)

it('does not attach a late checkpoint error to an original challenge another owner has recovered', async () => {
  const f = await fixture(), store = DesktopConnectorSecrets.prototype.store
  let release!: () => void, reached!: () => void, held = true
  const waiting = new Promise<void>(r => { reached = r }), resume = new Promise<void>(r => { release = r })
  vi.spyOn(DesktopConnectorSecrets.prototype, 'store').mockImplementation(async function(this: DesktopConnectorSecrets, input) {
    const saved = await store.call(this, input)
    if (held && JSON.parse(input.secret).receipt) { held = false; reached(); await resume; throw new Error('private late checkpoint acknowledgement') }
    return saved
  })
  const original = f.sdk.call('connection.enrollment.begin', f.input)
  const originalResult = original.then(value => ({ value }), error => ({ error }))
  await waiting
  const second = await createDesktopConnections({ directory: f.directory, encryption: f.encryption, adapters: [f.adapter] }); clean.push(() => second.close())
  const row = f.services.database!.prepare('SELECT record_json FROM connection_enrollment WHERE operation_id=?').get(f.input.operationId)!
  const actor = JSON.parse(String(row.record_json)).actor as { kind: 'user'; id: string }
  const waitingView = await second.connections.enrollment!.inspect({ operationId: f.input.operationId }, { actor })
  let recovered!: ConnectionEnrollmentView
  try {
    recovered = await second.connections.enrollment!.advance(decision(waitingView, 'recover-local'), { actor })
    expect(recovered.operation!.authentication!.stage).toBe('waiting'); expect(recovered.operation).not.toHaveProperty('diagnostic')
  } finally { release() }
  expect(await originalResult).toEqual({ value: recovered })
  expect(f.begin).toHaveBeenCalledTimes(1); expect(f.authentication).not.toHaveBeenCalled()
}, 20_000)

it('keeps old unknown receipts valid and rejects extra or cross-stage diagnostic fields', async () => {
  const f = await fixture(), raw = await legacy(f, 'unknown')
  const original = await inspect(f)
  expect(original.operation).not.toHaveProperty('diagnostic')
  expect(parseConnectionEnrollmentOperation(original.operation)).toEqual(original.operation)
  for (const diagnostic of [
    { stage: 'request', code: 'invalid-json' }, { stage: 'request', code: 'cancelled', httpStatus: 200 },
    { stage: 'response', code: 'http-status', httpStatus: 99 }, { stage: 'response', code: 'http-status', httpStatus: 600 },
    { stage: 'response', code: 'http-status', httpStatus: 200.5 }, { stage: 'response', code: 'http-status', httpStatus: '400' },
    { stage: 'response', code: 'platform-error', raw: 'private response' },
    { stage: 'challenge', code: 'unsafe-verification', verificationUrl: 'https://attacker.invalid' },
    { stage: 'secure-storage', code: 'credential-unconfirmed', secret: fixtureCredential },
    { stage: 'foreign', code: 'transport-unconfirmed' }
  ]) expect(() => parseConnectionEnrollmentOperation({ ...original.operation, diagnostic })).toThrowError(expect.objectContaining({ code: 'INVALID_CONNECTION_ENROLLMENT_DATA' }))
  await f.closeOwner(); await f.reopen()
  expect(result(await f.cli(['enrollment', 'inspect', '--operation-id', f.input.operationId]))).toEqual(original)
  expect(JSON.stringify(stored(f))).toBe(raw); expect(f.begin).not.toHaveBeenCalled(); expect(f.authentication).not.toHaveBeenCalled()
}, 20_000)

it('preserves finite response diagnostics without accepting unsafe or cross-stage values', () => {
  for (const nativeCode of [0, 17, -17, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]) {
    const diagnostic = { stage: 'response', code: 'platform-error', httpStatus: 200, nativeCode }
    expect(parseConnectionEnrollmentDiagnostic(diagnostic)).toEqual(diagnostic)
  }
  for (const nativeCode of ['17', 1.5, null, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1]) {
    expect(() => parseConnectionEnrollmentDiagnostic({ stage: 'response', code: 'platform-error', nativeCode })).toThrow()
  }
  for (const stage of ['request', 'preparation', 'adapter', 'secure-storage']) {
    expect(() => parseConnectionEnrollmentDiagnostic({ stage, code: 'cancelled', nativeCode: 17 })).toThrow()
  }
  expect(() => parseConnectionEnrollmentDiagnostic({ stage: 'response', code: 'platform-error', nativeCode: 17, message: 'private platform text' })).toThrow()
})

it('retains the original native creation rejection through durable inspect, public SDK and compiled CLI without replay', async () => {
  const f = await defaultFixture(), calls: string[] = []
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
  const responses = [
    Response.json({ code: 0, data: { step_info: { token: 'private-diagnostic-qr' } } }, { headers: { 'x-flow-key': 'private-diagnostic-flow' } }),
    Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { cross_login_uri: 'https://accounts.feishu.cn/cross' } } }),
    new Response(null, { status: 302, headers: { location: 'https://ask.feishu.cn/cross-finish' } }),
    new Response('Cross-login complete'),
    new Response('Fixed landing'),
    new Response('<script>window.user={"id":"private-diagnostic-user","tenantId":"private-diagnostic-tenant"};window.csrfToken="private-diagnostic-csrf";</script>', { headers: { 'content-type': 'text/html' } }),
    Response.json({ code: 0, data: { url: 'https://images.example.invalid/private-diagnostic-avatar.png' } }),
    Response.json({ code: 17, message: 'private-diagnostic-native-message', data: { token: 'private-diagnostic-secret' } })
  ]
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(new URL(url).pathname)
    const response = responses.shift()
    if (!response) throw Error('Unexpected extra native request')
    return response
  }))
  let view = await f.sdk.call('connection.enrollment.begin', f.input)
  for (let index = 0; index < 6 && !view.account; index++) {
    clock.mockReturnValue(Math.max(Date.now() + 2000, view.challenge?.nextPollAt ?? 0))
    view = await advance(f, view, 'continue-authentication')
  }
  expect({ authentication: view.operation!.authentication, diagnostic: view.operation!.diagnostic, calls, remaining: responses.length }).toMatchObject({ authentication: { stage: 'account' }, diagnostic: undefined, remaining: 2 })
  expect(view.account).not.toBeNull()
  view = await advance(f, view, 'confirm-account')
  const originalDecision = decision(view, 'create')
  view = await f.sdk.call('connection.enrollment.advance', originalDecision)
  const expected = { stage: 'response', code: 'platform-error', httpStatus: 200, nativeCode: 17 }
  expect(view.operation).toMatchObject({ operationId: f.input.operationId, connectionId: f.input.connectionId, creation: { upload: 'confirmed', create: 'unknown' }, credential: 'not-started', configuration: 'not-started', application: null, diagnostic: expected })
  expect(view.actions.map(action => action.kind)).not.toContain('create')
  expect(responses).toHaveLength(0)
  expect(calls.filter(path => path.includes('upsert_by_template'))).toHaveLength(1)
  const count = calls.length
  await f.closeOwner(); await f.reopen()
  const observed = await f.sdk.call('connection.enrollment.inspect', { operationId: f.input.operationId, requestTrace: { limit: 100 } })
  const copied = result(await f.cli(['inspect', '--operation-id', f.input.operationId, '--request-trace']))
  for (const value of [observed, copied]) {
    expect(value.operation.diagnostic).toEqual(expected)
    expect(value.requestTrace.operationId).toBe(f.input.operationId)
    expect(value.requestTrace.entries.find((row: any) => row.action === 'create')).toMatchObject({ request: 'claimed', secureStorage: null })
    expect(JSON.stringify(value)).not.toMatch(/private-diagnostic|native-message|csrf|cookie/)
  }
  expect((await f.sdk.call('connection.enrollment.begin', f.input)).operation!.diagnostic).toEqual(expected)
  expect((await f.sdk.call('connection.enrollment.advance', originalDecision)).operation!.diagnostic).toEqual(expected)
  expect(calls).toHaveLength(count)
}, 30_000)

it('keeps another provider response code diagnostic through the same public inspect contract', async () => {
  const diagnostic = { stage: 'response' as const, code: 'platform-error' as const, nativeCode: -41 }
  const f = await fixture({ create: async () => ({ kind: 'unknown', diagnostic }) })
  const view = await create(f)
  expect(view.operation!.diagnostic).toEqual(diagnostic)
  await f.closeOwner(); await f.reopen()
  expect((await inspect(f)).operation!.diagnostic).toEqual(diagnostic)
  expect(result(await f.cli(['enrollment', 'inspect', '--operation-id', f.input.operationId])).operation.diagnostic).toEqual(diagnostic)
  expect(f.create).toHaveBeenCalledTimes(1)
}, 20_000)

it('keeps repeated local recovery receipts out of the original intent row while retaining the earliest exact action', async () => {
  const f = await fixture(), initial = await f.sdk.call('connection.enrollment.begin', f.input)
  const stable = () => { const row = stored(f); delete row.operation.revision; delete row.activeActionId; return JSON.stringify(row) }
  const before = stable(), first = decision(initial, 'recover-local')
  let current = initial, firstReceipt
  for (let count = 0; count < 32; count++) { current = await advance(f, current, 'recover-local'); if (!count) firstReceipt = current.receipt }
  expect(stable()).toBe(before)
  const decisions = f.services.database!.prepare('SELECT record_json FROM connection_enrollment_decision WHERE operation_id=?').all(f.input.operationId)
  expect(decisions).toHaveLength(32)
  expect(decisions.some(r => JSON.parse(String(r.record_json)).input.decision.actionId === first.decision.actionId)).toBe(true)
  expect((await f.sdk.call('connection.enrollment.advance', first)).receipt).toEqual(firstReceipt)
  expect(f.begin).toHaveBeenCalledTimes(1); expect(f.authentication).not.toHaveBeenCalled(); expect(f.upload).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled(); expect(f.credential).not.toHaveBeenCalled()
}, 20_000)

it.each(['begin', 'authentication'] as const)('keeps a preclaimed unknown %s across actual child death and a new public owner', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'enroll-child-')); clean.push(() => rm(root, { recursive: true, force: true }))
  const socketPath = join(root, 'owner.sock'), input = { operationId: 'child-original', connectionId: 'child-connection', adapterId: 'challenge', domain: 'challenge.example', label: 'Child bot', preset: { name: 'Child bot', avatar: { pngDataUrl: enrollmentAvatar } } }
  const start = async (fault: string) => {
    const child = fork(new URL('./fixtures/connection-enrollment-owner.mjs', import.meta.url), [root, fault], { execArgv: ['--experimental-transform-types'], env: objectCliEnvironment(root), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    let errors = ''; child.stderr!.on('data', v => { errors += v })
    clean.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit') } })
    await new Promise<void>((resolve, reject) => { child.on('message', v => { if ((v as { kind: string }).kind === 'ready') resolve() }); child.once('exit', () => reject(new Error(errors || 'Owner exited before ready'))) })
    return child
  }
  const cli = (args: string[], body?: unknown) => runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', 'enrollment', ...args], objectCliEnvironment(root), body ? JSON.stringify(body) : '')
  const child = await start(mode)
  const original = mode === 'authentication' ? result(await cli(['begin', '--input', '-'], input)) as ConnectionEnrollmentView : null
  if (original) expect(original.operation!.authentication!.stage).toBe('waiting')
  const originalAction = original ? decision(original, 'continue-authentication') : null
  const applied = new Promise<void>(resolve => child.on('message', m => { if ((m as { kind: string }).kind === 'effect-applied') resolve() }))
  const inflight = originalAction ? cli(['advance', '--input', '-'], originalAction) : cli(['begin', '--input', '-'], input)
  await applied; child.kill('SIGKILL'); await once(child, 'exit'); expect((await inflight).code).not.toBe(0)
  const replacement = await start('observe')
  const inspected = result(await cli(['inspect', '--operation-id', input.operationId])); expect(inspected.operation.authentication.stage).toBe('unknown'); expect(inspected.operation.connectionId).toBe(input.connectionId)
  expect(result(await cli(['ls'])).operations).toEqual([inspected.operation])
  const restored = result(await cli(['advance', '--input', '-'], decision(inspected, 'recover-local')))
  expect(restored.operation).toMatchObject({ connectionId: input.connectionId, authentication: inspected.operation.authentication, application: null, configuration: 'not-started' })
  if (originalAction) expect(result(await cli(['advance', '--input', '-'], originalAction)).receipt.actionId).toBe(originalAction.decision.actionId)
  else expect(result(await cli(['begin', '--input', '-'], input)).operation.authentication).toEqual(inspected.operation.authentication)
  const effects = (await readFile(join(root, 'effects'), 'utf8')).trim().split('\n')
  expect(effects).toHaveLength(1)
  const durable = new DatabaseSync(join(root, 'connections.sqlite'), { readOnly: true })
  try {
    const attempts = durable.prepare('SELECT attempt_id,operation_id,kind,state FROM connection_enrollment_attempt WHERE kind=?').all(mode)
    expect(attempts).toEqual([{ attempt_id: effects[0]!.slice(mode.length + 1), operation_id: input.operationId, kind: mode, state: 'claimed' }])
  } finally { durable.close() }
  replacement.kill('SIGKILL'); await once(replacement, 'exit')
}, 30_000)

it('reads bounded original Enrollment trace through SDK and compiled CLI without secrets, replay or invented HTTP', async () => {
  const f = await fixture(), configured = await create(f), operationId = f.input.operationId
  expect(configured.operation!.configuration).toBe('configured')
  const before = f.services.database!.prepare('SELECT total_changes() AS count').get()
  const resolve = vi.spyOn(DesktopConnectorSecrets.prototype, 'resolve'), store = vi.spyOn(f.services.secrets, 'store')
  f.encryption.isEncryptionAvailable = () => false
  const first = result(await f.cli(['enrollment', 'inspect', '--operation-id', operationId, '--request-trace', '--trace-limit', '2']))
  expect(first.challenge).toBeNull(); expect(first.account).toBeNull(); expect(first.actions).toEqual([])
  expect(first.requestTrace.entries.map((entry: any) => entry.action)).toEqual(['initialize', 'authentication'])
  expect(first.requestTrace.next).toEqual(expect.any(String))
  const second = await f.sdk.call('connection.enrollment.inspect', { operationId, requestTrace: { cursor: first.requestTrace.next, limit: 2 } })
  expect(second.requestTrace!.entries.map(entry => entry.action)).toEqual(['upload', 'create'])
  const third = result(await f.cli(['enrollment', 'inspect', '--operation-id', operationId, '--request-trace', '--trace-cursor', second.requestTrace!.next!, '--trace-limit', '2']))
  expect(third.requestTrace.entries.map((entry: any) => entry.action)).toEqual(['credential'])
  expect(third.requestTrace.next).toBeNull()
  const entries = [...first.requestTrace.entries, ...second.requestTrace!.entries, ...third.requestTrace.entries]
  expect(entries.map(entry => entry.sequence)).toEqual([1, 2, 3, 4, 5])
  expect(entries.map(entry => ({ kind: entry.kind, request: entry.request, secureStorage: entry.secureStorage, network: entry.network, subject: entry.subject, effect: entry.effect }))).toEqual(Array.from({ length: 5 }, () => ({ kind: 'enrollment-request', request: 'settled', secureStorage: null, network: null, subject: null, effect: null })))
  const steps = f.services.database!.prepare('SELECT attempt_id FROM connection_enrollment_attempt WHERE operation_id=? ORDER BY rowid').all(operationId)
  expect(entries.map(entry => entry.stepId)).toEqual(steps.map(step => step.attempt_id))
  expect(JSON.stringify([first.requestTrace, second.requestTrace, third.requestTrace])).not.toMatch(/original-user|original-tenant|private|credentialRef|cookie|qrPayload|data:image|verify\.example|Original bot/u)
  expect(resolve).not.toHaveBeenCalled(); expect(store).not.toHaveBeenCalled()
  expect(f.services.database!.prepare('SELECT total_changes() AS count').get()).toEqual(before)
  expect(f.begin).toHaveBeenCalledTimes(1); expect(f.authentication).toHaveBeenCalledTimes(1); expect(f.create).toHaveBeenCalledTimes(1); expect(f.credential).toHaveBeenCalledTimes(1)
  await f.closeOwner(); await f.reopen()
  const reopenedResolve = vi.spyOn(DesktopConnectorSecrets.prototype, 'resolve')
  const restored = await f.sdk.call('connection.enrollment.inspect', { operationId, requestTrace: { cursor: first.requestTrace.next, limit: 2 } })
  expect(restored.requestTrace).toEqual(second.requestTrace)
  expect(reopenedResolve).not.toHaveBeenCalled()
}, 30_000)

it('scopes trace cursors to the exact Enrollment operation and actor while original unknown steps remain readable', async () => {
  const f = await fixture({ advance: async () => ({ kind: 'unknown', diagnostic: { stage: 'adapter', code: 'receipt-unconfirmed' } }) })
  const pending = await f.sdk.call('connection.enrollment.begin', f.input)
  const unknown = await advance(f, pending, 'continue-authentication')
  expect(unknown.operation!.authentication!.stage).toBe('unknown')
  const first = await f.sdk.call('connection.enrollment.inspect', { operationId: f.input.operationId, requestTrace: { limit: 1 } })
  expect(first.requestTrace!.entries.map(entry => entry.action)).toEqual(['initialize'])
  const last = await f.sdk.call('connection.enrollment.inspect', { operationId: f.input.operationId, requestTrace: { cursor: first.requestTrace!.next!, limit: 1 } })
  expect(last.requestTrace!.entries.map(entry => ({ action: entry.action, request: entry.request, network: entry.network }))).toEqual([{ action: 'authentication', request: 'claimed', network: null }])
  f.services.database!.prepare('INSERT INTO connection_enrollment_attempt VALUES(?,?,?,?,?)').run('orphan-step', 'missing-parent', 'begin', 'unattributed-owner', 'settled')
  const orphan = await f.sdk.call('connection.enrollment.inspect', { operationId: 'missing-parent', requestTrace: {} })
  expect(orphan.operation).toBeNull(); expect(orphan.requestTrace!.entries).toEqual([])
  const other = { ...f.input, operationId: 'another-trace-operation', connectionId: 'another-trace-connection' }
  await f.sdk.call('connection.enrollment.begin', other)
  await expect(f.sdk.call('connection.enrollment.inspect', { operationId: other.operationId, requestTrace: { cursor: first.requestTrace!.next! } })).rejects.toMatchObject({ code: 'INVALID_CONNECTION_REQUEST_TRACE' })
  const service = new AgentMuxRpcService({ connections: f.services.connections }); clean.push(() => service.dispose())
  await expect(service.call('connection.enrollment.inspect', { operationId: f.input.operationId, requestTrace: {} }, { principal: { kind: 'device', id: 'foreign-actor' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect((await f.sdk.call('connection.enrollment.inspect', { operationId: f.input.operationId, requestTrace: {} })).requestTrace!.entries).toHaveLength(2)
  expect(f.authentication).toHaveBeenCalledTimes(1)
  const help = await f.cli(['enrollment', 'inspect', '--help'])
  expect(help.code).toBe(0); expect(help.stdout).toContain('--request-trace'); expect(help.stdout).toContain('HTTP details were not recorded')
  expect((await f.cli(['enrollment', 'inspect', '--operation-id', f.input.operationId, '--trace-limit', '1'])).code).not.toBe(0)
}, 30_000)

it('strict trace replies preserve operation scope, order, bounds and secret-free selection', async () => {
  const f = await fixture(); await create(f)
  const input = { operationId: f.input.operationId, requestTrace: { limit: 2 } }
  const view = await f.sdk.call('connection.enrollment.inspect', input), trace = view.requestTrace!
  expect(trace.entries).toHaveLength(2)
  const variants = [
    { ...view, requestTrace: undefined },
    { ...view, requestTrace: { ...trace, operationId: 'foreign-operation' } },
    { ...view, requestTrace: { ...trace, entries: [...trace.entries].reverse() } },
    { ...view, requestTrace: { ...trace, entries: [trace.entries[0], trace.entries[0]] } },
    { ...view, requestTrace: { ...trace, entries: [{ ...trace.entries[0], network: { httpStatus: 200 } }, trace.entries[1]] } },
    { ...view, requestTrace: { ...trace, entries: [{ ...trace.entries[0], cookie: 'private-cookie' }, trace.entries[1]] } },
    { ...view, account: { userId: 'private-user', tenantId: 'private-tenant' } }
  ]
  for (const value of variants) expect(() => parseConnectionEnrollmentResult('connection.enrollment.inspect', value, input)).toThrow()
  expect(() => parseConnectionEnrollmentResult('connection.enrollment.inspect', view, { operationId: input.operationId })).toThrow()
  expect(() => parseConnectionEnrollmentResult('connection.enrollment.inspect', view, { ...input, requestTrace: { limit: 1 } })).toThrow()
  const owner = f.services.connections.enrollment!, inspect = owner.inspect.bind(owner)
  vi.spyOn(owner, 'inspect').mockImplementation(async (value, context) => { const result = await inspect(value, context); if (value.requestTrace) delete result.requestTrace; return result })
  await expect(f.sdk.call('connection.enrollment.inspect', input)).rejects.toMatchObject({ code: 'INVALID_CONNECTION_ENROLLMENT_DATA' })
  expect((await f.cli(['enrollment', 'inspect', '--operation-id', input.operationId, '--request-trace'])).code).not.toBe(0)
}, 30_000)
