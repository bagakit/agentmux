import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { DatabaseSync } from 'node:sqlite'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, AgentMuxRpcService, connectAgentMuxRpc } from '@agentmux/core'
import type { ConnectionConfig, ConnectionSetupBegin, ConnectionSetupView } from '@agentmux/core/connections'
import { objectCliEnvironment, runCompiledObjectCli, type CliResult } from '../../core/test/helpers/object-cli-rpc.js'
import { enrollmentEncryption } from './fixtures/connection-enrollment.js'

const TOKEN = 'fixture-original-qr-token', FLOW = 'fixture-original-flow-key'
const COOKIES = ['fixture-session=original-private-cookie; Secure; HttpOnly; Path=/', 'fixture-route=original-route; Secure; Path=/accounts']
const CREDENTIAL = 'fixture-existing-bot-secret'
const goal = { kind: 'agent-conversation', interaction: 'messages' } as const
const clean: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const close of clean.splice(0).reverse()) await close() })
function result<T = ConnectionSetupView>(output: CliResult): T { expect(output.code, output.stdout + output.stderr).toBe(0); return JSON.parse(output.stdout).result }
function qrResponse() {
  return Response.json({ code: 0, data: { step_info: { token: TOKEN } } }, { headers: [['x-flow-key', FLOW], ...COOKIES.map(value => ['set-cookie', value] as [string, string])] })
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
async function fixture(options: { paused?: boolean; domain?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'setup-public-')), directory = join(root, 'connections'), socketPath = join(root, 'owner.sock'), encryption = enrollmentEncryption()
  let services: Awaited<ReturnType<typeof createDesktopConnections>>, server: AgentMuxControlServer, sdk: Awaited<ReturnType<typeof connectAgentMuxRpc>>
  const open = async () => {
    services = await createDesktopConnections({ directory, encryption })
    server = new AgentMuxControlServer({ socketPath, connections: services.connections, coreClients: () => { throw new Error('Management challenge cannot borrow an Agent Runtime') } })
    await server.start(); sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  }
  const closeOwner = async () => { await sdk?.dispose(); await server?.stop(); services?.close() }
  clean.push(async () => { await closeOwner(); await rm(root, { recursive: true, force: true }) })
  await open()
  const credential = await services.secrets.store({ operationId: 'saved-bot-credential', secret: CREDENTIAL })
  const config: ConnectionConfig = { connectionId: 'saved-bot', adapterId: 'feishu', application: { domain: options.domain ?? 'open.feishu.cn', appId: 'cli_original_saved_bot' }, label: 'Original saved bot', enabled: !options.paused, credentialRef: credential.credentialRef }
  const saved = await sdk.call('connection.configure', { operationId: 'original-local-save', expectedRevision: null, connection: config })
  const input: ConnectionSetupBegin = { operationId: 'original-management', connectionId: config.connectionId, expectedConnectionRevision: saved.connection.revision, goal }
  const cli = (args: string[], body?: unknown) => runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', 'setup', ...args], objectCliEnvironment(root), body === undefined ? '' : JSON.stringify(body))
  return { root, directory, input, config, saved, encryption, cli, closeOwner, reopen: open, get services() { return services }, get sdk() { return sdk } }
}
function assertChallenge(view: ConnectionSetupView, input: ConnectionSetupBegin) {
  expect(view.operation).toMatchObject({ ...input, adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: 'cli_original_saved_bot' }, request: { state: 'confirmed', attemptId: expect.any(String) }, secureStorage: 'stored' })
  expect(view.challenge).toEqual({ qrPayload: JSON.stringify({ qrlogin: { token: TOKEN } }), expiresAt: null, nextPollAt: expect.any(Number) })
  expect(view.challenge).not.toHaveProperty('verificationUrl')
  expect(view.operation).not.toHaveProperty('authorization')
  expect(view.operation).not.toHaveProperty('configured')
}
async function assertPrivateStorage(database: DatabaseSync, directory: string, encryption: ReturnType<typeof enrollmentEncryption>, view: ConnectionSetupView) {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
  expect(tables.length).toBeGreaterThan(0)
  const records = tables.map(table => database.prepare('SELECT * FROM "' + String(table.name).replaceAll('"', '""') + '"').all())
  const safeRecords = JSON.stringify(records)
  for (const privateValue of [TOKEN, FLOW, ...COOKIES, CREDENTIAL]) expect(safeRecords).not.toContain(privateValue)
  const envelopes = database.prepare('SELECT ciphertext FROM connection_credential').all().map(row => encryption.decryptString(Buffer.from(row.ciphertext as Uint8Array)))
  const privateEnvelope = envelopes.find(value => value.includes(FLOW))
  expect(privateEnvelope).toBeDefined()
  const snapshot = JSON.parse(privateEnvelope!)
  const original = { operationId: view.operation!.operationId, connectionId: view.operation!.connectionId, attemptId: view.operation!.request.attemptId }
  expect(snapshot).toMatchObject(original)
  expect(JSON.parse(snapshot.privateState)).toMatchObject({ ...original, application: view.operation!.application, flowKey: FLOW, token: TOKEN, setCookies: COOKIES })
  expect(snapshot.challenge.qrPayload).toBe(JSON.stringify({ qrlogin: { token: TOKEN } }))
  database.exec('PRAGMA wal_checkpoint(FULL)')
  const files = [await readFile(join(directory, 'connections.sqlite'))]
  try { files.push(await readFile(join(directory, 'connections.sqlite-wal'))) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  for (const privateValue of [TOKEN, FLOW, ...COOKIES, CREDENTIAL]) expect(Buffer.concat(files).includes(Buffer.from(privateValue))).toBe(false)
}

it('compiled CLI and SDK reach the default QR leaf and original encrypted owner without claiming login or changing the saved bot', async () => {
  const f = await fixture(), before = await f.sdk.call('connection.inspect', { connectionId: f.input.connectionId })
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(new URL(String(url)).origin + new URL(String(url)).pathname).toBe('https://accounts.feishu.cn/accounts/qrlogin/init')
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' })
    const headers = new Headers(init?.headers)
    expect(headers.get('x-app-id')).toBe('12'); expect(headers.get('x-api-version')).toBe('1.0.28')
    expect(headers.get('content-type')).toBe('application/json'); expect(headers.get('cookie')).toBeNull(); expect(headers.get('x-flow-key')).toBeNull()
    expect(JSON.parse(String(init?.body))).toEqual({ biz_type: null, redirect_uri: 'https://ask.feishu.cn/' })
    const claimed = await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId })
    expect(claimed.operation?.request).toMatchObject({ attemptId: expect.any(String) })
    expect(claimed.operation?.request.state).not.toBe('not-dispatched'); expect(claimed.challenge).toBeNull()
    return qrResponse()
  })
  vi.stubGlobal('fetch', fetch)
  const pending = result(await f.cli(['begin', '--input', '-'], f.input)); assertChallenge(pending, f.input)
  expect(await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId })).toEqual(pending)
  expect(result(await f.cli(['inspect', '--operation-id', f.input.operationId]))).toEqual(pending)
  const list = result<{ operations: unknown[]; next: string | null }>(await f.cli(['ls', '--connection', f.input.connectionId]))
  expect(list).toEqual({ operations: [pending.operation], next: null, support: { connectionRevision: 1, capabilities: ['management-authentication', 'application-inspection', 'messaging-capability', 'persistent-event-transport', 'application-permissions', 'enrollment-continuation'] } })
  expect(JSON.stringify(list)).not.toContain(TOKEN); expect(JSON.stringify(list)).not.toContain(FLOW)
  expect(await f.sdk.call('connection.inspect', { connectionId: f.input.connectionId })).toEqual(before)
  expect((await f.sdk.call('connection.inspect', { operationId: 'original-local-save' })).operation).toEqual(f.saved)
  expect((await f.cli(['advance', '--operation-id', f.input.operationId])).code).not.toBe(0)
  const help = await f.cli(['--help']); expect(help.code).toBe(0); expect(help.stdout).toContain('begin'); expect(help.stdout).toContain('inspect'); expect(help.stdout).toContain('ls'); expect(help.stdout).toContain('setup advance')
  expect(fetch).toHaveBeenCalledTimes(1)
  await assertPrivateStorage(f.services.database!, f.directory, f.encryption, pending)
}, 30_000)

it('explicit administration works for a paused bot with automatic Connector traffic off and keeps both policies unchanged', async () => {
  const f = await fixture({ paused: true }), fetch = vi.fn(async () => qrResponse()); vi.stubGlobal('fetch', fetch)
  const service = await f.sdk.call('connection.service.configure', { operationId: 'automatic-traffic-off', expectedRevision: 0, service: { enabled: false } })
  const before = await f.sdk.call('connection.inspect', { connectionId: f.input.connectionId })
  assertChallenge(await f.sdk.call('connection.setup.begin', f.input), f.input)
  expect(await f.sdk.call('connection.inspect', { connectionId: f.input.connectionId })).toEqual(before)
  expect(before.connection?.config.enabled).toBe(false)
  expect(await f.sdk.call('connection.service.get', {})).toEqual(service.service)
  expect(fetch).toHaveBeenCalledTimes(1)
}, 20_000)

it('joins duplicate native work and refuses changed intent or foreign authority without exposing the original challenge', async () => {
  const f = await fixture(), entered = deferred<void>(), response = deferred<Response>()
  const fetch = vi.fn(async () => { entered.resolve(); return await response.promise }); vi.stubGlobal('fetch', fetch)
  const first = f.sdk.call('connection.setup.begin', f.input)
  await Promise.race([entered.promise, first.then(() => { expect(fetch).toHaveBeenCalledTimes(1) })])
  const concurrent = f.sdk.call('connection.setup.begin', f.input)
  response.resolve(qrResponse()); const pending = await first; await concurrent
  expect(await f.sdk.call('connection.setup.begin', f.input)).toEqual(pending)
  await expect(f.sdk.call('connection.setup.begin', { ...f.input, goal: { ...goal, interaction: 'cards' } })).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
  await expect(f.sdk.call('connection.setup.begin', { ...f.input, connectionId: 'another-saved-bot' })).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
  expect((await f.cli(['begin', '--input', '-'], { ...f.input, actor: { kind: 'user', id: 'payload-authored' } })).code).not.toBe(0)
  const service = new AgentMuxRpcService({ connections: f.services.connections }); clean.push(() => service.dispose())
  for (const [method, input] of [['connection.setup.begin', f.input], ['connection.setup.inspect', { operationId: f.input.operationId }]] as const) {
    await expect(service.call(method, input, {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    await expect(service.call(method, input, { principal: { kind: 'device', id: 'foreign-management-device' } })).rejects.toMatchObject({ code: expect.stringMatching(/^(?:CONTROL_PERMISSION_DENIED|CONNECTION_SETUP_AUTHORITY_REQUIRED)$/u) })
  }
  expect(await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId })).toEqual(pending)
  expect((await f.sdk.call('connection.inspect', { operationId: 'original-local-save' })).operation).toEqual(f.saved)
  expect(fetch).toHaveBeenCalledTimes(1)
}, 30_000)

it('a revision changed during QR init retains the original operation but withholds its late challenge from the revised bot', async () => {
  const f = await fixture(), entered = deferred<void>(), response = deferred<Response>()
  const fetch = vi.fn(async () => { entered.resolve(); return await response.promise }); vi.stubGlobal('fetch', fetch)
  const inflight = f.sdk.call('connection.setup.begin', f.input)
  await Promise.race([entered.promise, inflight.then(() => { expect(fetch).toHaveBeenCalledTimes(1) })])
  const revised = await f.sdk.call('connection.configure', { operationId: 'explicit-revised-save', expectedRevision: 1, connection: { ...f.config, label: 'Revised saved bot' } })
  response.resolve(qrResponse())
  const late = await inflight
  expect(late.operation).toMatchObject({ operationId: f.input.operationId, expectedConnectionRevision: 1, application: f.config.application })
  expect(late.challenge).toBeNull(); expect(late.reason).toBe('connection-revised')
  expect(await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId })).toEqual(late)
  await expect(f.sdk.call('connection.setup.begin', { ...f.input, operationId: 'stale-new-intent' })).rejects.toMatchObject({ code: 'CONNECTION_REVISION_CONFLICT' })
  expect((await f.sdk.call('connection.inspect', { connectionId: f.input.connectionId })).connection).toEqual(revised.connection)
  expect((await f.sdk.call('connection.inspect', { operationId: 'original-local-save' })).operation).toEqual(f.saved)
  expect(fetch).toHaveBeenCalledTimes(1)
}, 20_000)

it('HTTP, redirect, malformed and lost responses stay unknown across reopen and duplicate begin never reissues init', async () => {
  const f = await fixture(), detail = 'fixture-private-response-detail'
  const samples = [
    () => Response.json({ detail }, { status: 503 }),
    () => new Response(null, { status: 302, headers: { location: 'https://unqualified.example.invalid/' } }),
    () => new Response(detail),
    () => Response.json({ code: 0, data: { step_info: { token: TOKEN } } }),
    () => Response.json({ code: '0', data: { step_info: { token: TOKEN } } }, { headers: { 'x-flow-key': FLOW } }),
    () => { throw new TypeError(detail) }
  ]
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  const originals: ConnectionSetupView[] = []
  for (const [index, sample] of samples.entries()) {
    fetch.mockImplementation(async () => sample())
    const input = { ...f.input, operationId: 'unknown-management-' + index }
    const unknown = await f.sdk.call('connection.setup.begin', input)
    expect(unknown.operation).toMatchObject({ ...input, request: { state: 'unknown', attemptId: expect.any(String) } })
    expect(unknown.challenge).toBeNull(); expect(JSON.stringify(unknown)).not.toContain(detail)
    expect(await f.sdk.call('connection.setup.begin', input)).toEqual(unknown); originals.push(unknown)
  }
  await f.closeOwner(); await f.reopen()
  for (const original of originals) {
    expect(await f.sdk.call('connection.setup.inspect', { operationId: original.operation!.operationId })).toEqual(original)
    expect(await f.sdk.call('connection.setup.begin', { ...f.input, operationId: original.operation!.operationId })).toEqual(original)
  }
  expect(fetch).toHaveBeenCalledTimes(samples.length)
  expect((await f.sdk.call('connection.inspect', { operationId: 'original-local-save' })).operation).toEqual(f.saved)
}, 30_000)

it('secure-storage failure preserves the original request and recovers only local handoff without repeating native work', async () => {
  const f = await fixture(), fetch = vi.fn(async () => qrResponse()); vi.stubGlobal('fetch', fetch)
  f.encryption.isEncryptionAvailable = () => false
  const blocked = await f.sdk.call('connection.setup.begin', f.input)
  expect(blocked.operation).toMatchObject({ request: { state: 'not-dispatched', attemptId: null }, reason: 'secure-storage-unavailable' }); expect(blocked.challenge).toBeNull(); expect(fetch).not.toHaveBeenCalled()
  f.encryption.isEncryptionAvailable = () => true
  const encrypt = f.encryption.encryptString; let failed = false
  f.encryption.encryptString = value => { if (!failed) { failed = true; throw new Error('fixture-private-encryption-detail') } return encrypt(value) }
  const uncertain = await f.sdk.call('connection.setup.begin', f.input)
  expect(uncertain.operation).toMatchObject({ request: { state: 'confirmed', attemptId: expect.any(String) }, secureStorage: 'unknown' }); expect(uncertain.challenge).toBeNull()
  expect(JSON.stringify(uncertain)).not.toContain('fixture-private-encryption-detail')
  const recovered = await f.sdk.call('connection.setup.begin', f.input); assertChallenge(recovered, f.input)
  expect(recovered.operation?.request.attemptId).toBe(uncertain.operation?.request.attemptId)
  expect(fetch).toHaveBeenCalledTimes(1)
  await f.closeOwner(); await f.reopen()
  expect(await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId })).toEqual(recovered)
  expect(await f.sdk.call('connection.setup.begin', f.input)).toEqual(recovered)
  await assertPrivateStorage(f.services.database!, f.directory, f.encryption, recovered)
}, 30_000)

it('unqualified Lark management keeps the saved bot and makes no Feishu request', async () => {
  const f = await fixture({ domain: 'open.larksuite.com' }), fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  const view = await f.sdk.call('connection.setup.begin', f.input)
  expect(view.operation).toMatchObject({ application: f.config.application, request: { state: 'not-dispatched', attemptId: null }, reason: 'adapter-unavailable' })
  expect(view.challenge).toBeNull()
  expect(await f.sdk.call('connection.setup.begin', f.input)).toEqual(view)
  expect(await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId })).toEqual(view)
  expect(await f.sdk.call('connection.setup.ls', { connectionId: f.input.connectionId })).toEqual({ operations: [view.operation], next: null, support: { connectionRevision: 1, capabilities: [] } })
  expect(fetch).not.toHaveBeenCalled()
  expect((await f.sdk.call('connection.inspect', { operationId: 'original-local-save' })).operation).toEqual(f.saved)
}, 20_000)

function message(child: ChildProcess, kind: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (value: unknown) => { if (value && typeof value === 'object' && (value as { kind?: string }).kind === kind) { child.off('message', onMessage); child.off('exit', onExit); resolve(value as Record<string, unknown>) } }
    const onExit = () => { child.off('message', onMessage); reject(new Error('Fixture owner exited before ' + kind)) }
    child.on('message', onMessage); child.once('exit', onExit)
  })
}

it.each(['challenge', 'unknown'] as const)('a real owner process restart retains the original %s and cannot replay QR init', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'setup-child-')); clean.push(() => rm(root, { recursive: true, force: true }))
  const socketPath = join(root, 'owner.sock'), encryption = enrollmentEncryption()
  const start = async (fault: string) => {
    const child = fork(new URL('./fixtures/connection-setup-owner.mjs', import.meta.url), [root, fault], { execArgv: ['--experimental-transform-types'], env: objectCliEnvironment(root), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    clean.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit') } })
    let errors = ''; child.stderr!.on('data', value => { errors += value })
    const ready = await message(child, 'ready').catch(error => { throw new Error(errors || String(error)) })
    return { child, ready }
  }
  const first = await start(mode === 'challenge' ? 'respond' : 'inflight')
  const cli = (args: string[], body?: unknown) => runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', ...args], objectCliEnvironment(root), body === undefined ? '' : JSON.stringify(body))
  const config: ConnectionConfig = { connectionId: 'saved-bot', adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: 'cli_original_saved_bot' }, label: 'Original saved bot', enabled: false, credentialRef: String(first.ready.credentialRef) }
  result(await cli(['configure', '--input', '-'], { operationId: 'original-child-save', expectedRevision: null, connection: config }))
  const input: ConnectionSetupBegin = { operationId: 'original-child-management', connectionId: config.connectionId, expectedConnectionRevision: 1, goal }
  const started = message(first.child, 'request-started')
  const inflight = cli(['setup', 'begin', '--input', '-'], input)
  await Promise.race([started, inflight.then(output => { expect(result(output).challenge).not.toBeNull() })])
  let original: ConnectionSetupView | null = null
  if (mode === 'challenge') { original = result(await inflight); assertChallenge(original, input) }
  const claimed = original ?? result(await cli(['setup', 'inspect', '--operation-id', input.operationId]))
  expect(claimed.operation?.request.attemptId).toEqual(expect.any(String))
  first.child.kill('SIGKILL'); await once(first.child, 'exit')
  if (mode === 'unknown') expect((await inflight).code).not.toBe(0)
  await start('observe-only')
  const observed = result(await cli(['setup', 'inspect', '--operation-id', input.operationId]))
  if (original) expect(observed).toEqual(original)
  else { expect(observed.operation).toMatchObject({ ...input, application: config.application, request: { state: 'unknown', attemptId: expect.any(String) } }); expect(observed.challenge).toBeNull() }
  expect(observed.operation?.request.attemptId).toBe(claimed.operation?.request.attemptId)
  expect(result(await cli(['setup', 'begin', '--input', '-'], input))).toEqual(observed)
  expect(result(await cli(['setup', 'ls', '--connection', input.connectionId]))).toEqual({ operations: [observed.operation], next: null, support: { connectionRevision: 1, capabilities: ['management-authentication', 'application-inspection', 'messaging-capability', 'persistent-event-transport', 'application-permissions', 'enrollment-continuation'] } })
  expect(result<{ connection: unknown }>(await cli(['inspect', '--connection', input.connectionId])).connection).toMatchObject({ config, revision: 1 })
  const effects = (await readFile(join(root, 'native-effects.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(effects).toEqual([{ method: 'POST', path: '/accounts/qrlogin/init' }])
  if (original) {
    const database = new DatabaseSync(join(root, 'connections.sqlite'))
    try { await assertPrivateStorage(database, root, encryption, original) } finally { database.close() }
  }
}, 40_000)
