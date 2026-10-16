import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { DesktopConnectorSecrets } from '../../../apps/desktop/src/main/connector-secrets.js'
import { AgentMuxControlServer, AgentMuxError, AgentMuxRpcService, connectAgentMuxRpc } from '@agentmux/core'
import type { ConnectionEnrollmentActionKind, ConnectionEnrollmentAdvanceInput, ConnectionEnrollmentBeginInput, ConnectionEnrollmentView } from '@agentmux/core/connections'
import { once } from 'node:events'
import { fork } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { objectCliEnvironment, runCompiledObjectCli, type CliResult } from '../../core/test/helpers/object-cli-rpc.js'
import { enrollmentEncryption } from './fixtures/connection-enrollment.js'

const TOKEN = 'web-original-private-qr', FLOW = 'web-original-private-flow', SESSION = 'web-original-private-session', CSRF = 'web-original-private-csrf'
const USER = 'web-original-user', TENANT = 'web-original-tenant', SECRET = 'web-original-private-secret'
const APP = { domain: 'open.feishu.cn', appId: 'cli_web_original' }
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
const clean: Array<() => void | Promise<void>> = []
afterEach(async () => {
  const failures: unknown[] = []
  try { for (const close of clean.splice(0).reverse()) { try { await close() } catch (error) { failures.push(error) } } }
  finally { try { vi.restoreAllMocks() } catch (error) { failures.push(error) }; try { vi.unstubAllGlobals() } catch (error) { failures.push(error) } }
  if (failures.length) throw new AggregateError(failures, 'Web enrollment consumer cleanup failed')
})
const result = <T = ConnectionEnrollmentView>(output: CliResult): T => { expect(output.code, output.stdout + output.stderr).toBe(0); return JSON.parse(output.stdout).result }
function action(view: ConnectionEnrollmentView, kind: ConnectionEnrollmentActionKind): ConnectionEnrollmentAdvanceInput {
  expect(view.operation).not.toBeNull()
  const offered = view.actions.filter(value => value.kind === kind)
  expect(offered).toHaveLength(1)
  return { operationId: view.operation!.operationId, ownRevision: offered[0]!.ownRevision, decision: { actionId: offered[0]!.actionId, kind } }
}
const delay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds))
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'enrollment-web-')), directory = join(root, 'connections'), socketPath = join(root, 'public.sock'), encryption = enrollmentEncryption()
  let services: Awaited<ReturnType<typeof createDesktopConnections>> | undefined, server: AgentMuxControlServer | undefined, sdk: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  const open = async (withoutAdapter = false) => {
    services = await createDesktopConnections({ directory, encryption, ...(withoutAdapter ? { adapters: [] } : {}) })
    server = new AgentMuxControlServer({ socketPath, connections: services.connections, coreClients: () => { throw new Error('Application creation cannot borrow an Agent Runtime') } })
    await server.start(); sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  }
  const close = async () => {
    const errors: unknown[] = []
    for (const stop of [async () => { await sdk?.dispose() }, async () => { await server?.stop() }, () => { services?.close() }]) { try { await stop() } catch (error) { errors.push(error) } }
    if (errors.length) throw new AggregateError(errors, 'Original enrollment owner cleanup failed')
  }
  clean.push(async () => { const errors: unknown[] = []; try { await close() } catch (error) { errors.push(error) }; try { await rm(root, { recursive: true, force: true }) } catch (error) { errors.push(error) }; if (errors.length) throw new AggregateError(errors, 'Enrollment fixture cleanup failed') })
  await open()
  const off = await sdk!.call('connection.service.configure', { operationId: 'web-service-off', expectedRevision: 0, service: { enabled: false } })
  const input: ConnectionEnrollmentBeginInput = { operationId: 'web-original-enrollment', connectionId: 'web-original-connection', adapterId: 'feishu', domain: APP.domain, label: 'Original bot', preset: { name: 'Original bot', description: 'Frozen original description', avatar: { pngDataUrl: PNG } } }
  const cli = (args: string[], body?: unknown) => runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', 'enrollment', ...args], objectCliEnvironment(root), body === undefined ? '' : JSON.stringify(body))
  return { root, directory, encryption, input, off, cli, close, reopen: open, get sdk() { return sdk! }, get services() { return services! } }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
function row(f: Fixture, operationId = f.input.operationId) { return JSON.parse(String(f.services.database!.prepare('SELECT record_json FROM connection_enrollment WHERE operation_id=?').get(operationId)!.record_json)) }
function encrypted(f: Fixture) { return f.services.database!.prepare('SELECT operation_id,ciphertext FROM connection_credential ORDER BY operation_id').all().map(r => ({ operationId: String(r.operation_id), bytes: Buffer.from(r.ciphertext as Uint8Array) })) }
async function inspect(f: Fixture) { return await f.sdk.call('connection.enrollment.inspect', { operationId: f.input.operationId }) }
async function advance(f: Pick<Fixture, 'sdk'>, view: ConnectionEnrollmentView, kind: ConnectionEnrollmentActionKind) { return await f.sdk.call('connection.enrollment.advance', action(view, kind)) }
function native(f?: Fixture, overrides: { poll?: () => Promise<Response>; create?: () => Promise<Response>; credential?: () => Promise<Response> } = {}) {
  const calls: Array<{ path: string; options: RequestInit }> = [], claims: Array<{ attemptId: string; kind: string; state: unknown; previousState: unknown }> = []
  const fetch = vi.fn(async (url: string | URL | Request, options: RequestInit = {}) => {
    const target = new URL(String(url)), headers = new Headers(options.headers)
    expect(options.redirect).toBe('manual'); expect(target.protocol).toBe('https:')
    if (f) {
      const original = row(f), claimed = f.services.database!.prepare('SELECT state,kind FROM connection_enrollment_attempt WHERE attempt_id=? AND operation_id=?').get(original.attemptId, f.input.operationId)!
      f.services.database!.exec('BEGIN IMMEDIATE; COMMIT')
      const previousState = claims.length ? f.services.database!.prepare('SELECT state FROM connection_enrollment_attempt WHERE attempt_id=?').get(claims.at(-1)!.attemptId)?.state : null
      claims.push({ attemptId: original.attemptId, kind: String(claimed.kind), state: claimed.state, previousState })
    }
    calls.push({ path: target.pathname, options })
    if (target.origin === 'https://accounts.feishu.cn' && target.pathname === '/accounts/qrlogin/init') return Response.json({ code: 0, data: { step_info: { token: TOKEN } } }, { headers: { 'x-flow-key': FLOW, 'set-cookie': `session=${SESSION}; Domain=.feishu.cn; Path=/; Secure; HttpOnly` } })
    if (target.origin === 'https://accounts.feishu.cn' && target.pathname === '/accounts/qrlogin/polling') return overrides.poll ? await overrides.poll() : Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross' } } })
    if (target.href === 'https://accounts.feishu.cn/cross') return new Response(null, { status: 302, headers: { location: 'https://ask.feishu.cn/' } })
    if (target.href === 'https://ask.feishu.cn/') return new Response('Landing content does not establish identity')
    if (target.href === 'https://open.feishu.cn/app') return new Response(`<script>window.user=${JSON.stringify({ id: USER, tenantId: TENANT, name: 'Original account', tenantName: 'Original enterprise' })};window.csrfToken=${JSON.stringify(CSRF)};</script>`, { headers: { 'content-type': 'text/html' } })
    expect(target.origin).toBe('https://open.feishu.cn'); expect(options.method).toBe('POST'); expect(headers.get('x-csrf-token')).toBe(CSRF); expect(headers.get('cookie')).toContain(SESSION)
    if (target.pathname === '/developers/v1/app/upload/image') return Response.json({ code: 0, data: { url: 'https://images.example.test/original.png' } })
    if (target.pathname === '/developers/v1/manifest/upsert_by_template' || target.pathname === '/developers/v1/app/create') return overrides.create ? await overrides.create() : Response.json({ code: 0, data: { ClientID: APP.appId } })
    if (target.pathname === '/developers/v1/secret/' + APP.appId) return overrides.credential ? await overrides.credential() : Response.json({ code: 0, data: { secret: SECRET } })
    throw new Error('Unexpected native enrollment route')
  })
  vi.stubGlobal('fetch', fetch)
  return { calls, claims, fetch }
}
async function account(f: Pick<Fixture, 'sdk'>, view: ConnectionEnrollmentView): Promise<ConnectionEnrollmentView> {
  for (let count = 0; count < 7 && view.operation?.authentication?.stage !== 'account'; count++) {
    if (view.challenge && view.challenge.nextPollAt > Date.now()) await delay(view.challenge.nextPollAt - Date.now())
    view = await advance(f, view, 'continue-authentication')
  }
  expect(view).toMatchObject({ operation: { application: null, authentication: { stage: 'account' } }, account: { userId: USER, tenantId: TENANT } })
  return view
}
async function confirmed(f: Fixture) { const view = await account(f, await f.sdk.call('connection.enrollment.begin', f.input)); return await advance(f, view, 'confirm-account') }
async function safeDiscovery(f: Fixture, view: ConnectionEnrollmentView) {
  const page = result<{ operations: unknown[]; next: string | null }>(await f.cli(['ls']))
  expect(page.operations).toEqual([view.operation]); expect(page.next).toBeNull()
  const tables = f.services.database!.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
  expect(tables.length).toBeGreaterThan(0)
  const rows = tables.map(t => f.services.database!.prepare('SELECT * FROM "' + String(t.name).replaceAll('"', '""') + '"').all())
  const plain = JSON.stringify({ page, rows })
  for (const secret of [TOKEN, FLOW, SESSION, CSRF, USER, TENANT, SECRET, PNG]) expect(plain).not.toContain(secret)
  const sealed = encrypted(f); expect(sealed.length).toBeGreaterThan(1)
  expect(sealed.map(r => f.encryption.decryptString(r.bytes)).some(v => v.includes(TOKEN))).toBe(true)
  f.services.database!.exec('PRAGMA wal_checkpoint(FULL)')
  const bytes = [await readFile(join(f.directory, 'connections.sqlite'))]
  try { bytes.push(await readFile(join(f.directory, 'connections.sqlite-wal'))) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  for (const secret of [TOKEN, FLOW, SESSION, CSRF, USER, TENANT, SECRET, PNG]) expect(Buffer.concat(bytes).includes(Buffer.from(secret))).toBe(false)
}

it('compiled CLI and SDK confirm the original account, explicitly create, and save the exact app through separately claimed native steps', async () => {
  const f = await fixture(), network = native(f)
  let view = result(await f.cli(['begin', '--input', '-'], f.input))
  expect(row(f).adapterProtocolId).toBe('developer-console-template-v1')
  expect(view.challenge?.qrPayload).toContain(TOKEN); expect(view.operation?.application).toBeNull()
  expect((await f.sdk.call('connection.ls', {})).connections).toEqual([])
  view = await account(f, view)
  expect(view.actions.map(a => a.kind)).not.toContain('create')
  const beforeConfirm = network.calls.length
  view = result(await f.cli(['advance', '--input', '-'], action(view, 'confirm-account')))
  expect(view.operation?.authentication?.stage).toBe('confirmed'); expect(network.calls).toHaveLength(beforeConfirm)
  const create = action(view, 'create'), originalPrivate = encrypted(f)
  view = result(await f.cli(['advance', '--input', '-'], create))
  expect(view.operation).toMatchObject({ application: APP, authorization: 'authorized', credential: 'stored', configuration: 'configured', creation: { upload: 'confirmed', create: 'confirmed' } })
  expect(view.operation!.configured).toMatchObject({ status: 'configured', connection: { revision: 1, config: { connectionId: f.input.connectionId, application: APP, enabled: true }, observation: { transport: { state: 'unknown' }, intake: { state: 'unknown' }, delivery: { state: 'unknown' } } } })
  expect(network.calls.map(c => c.path)).toEqual(['/accounts/qrlogin/init', '/accounts/qrlogin/polling', '/cross', '/', '/', '/app', '/developers/v1/app/upload/image', '/developers/v1/manifest/upsert_by_template', '/developers/v1/secret/' + APP.appId])
  expect(network.claims.map(c => c.kind)).toEqual(['begin', 'authentication', 'authentication', 'authentication', 'authentication', 'authentication', 'upload', 'create', 'credential'])
  expect(new Set(network.claims.map(c => c.attemptId)).size).toBe(9)
  expect(network.claims.map(c => c.state)).toEqual(Array(9).fill('claimed'))
  expect(network.claims.map(c => c.previousState)).toEqual([null, ...Array(8).fill('settled')])
  const form = network.calls[6]!.options.body as FormData
  expect([...form.keys()]).toEqual(['file', 'uploadType', 'isIsv', 'scale'])
  expect(Buffer.from(await (form.get('file') as File).arrayBuffer())).toEqual(Buffer.from(PNG.slice(22), 'base64'))
  expect([form.get('uploadType'), form.get('isIsv'), form.get('scale')]).toEqual(['4', 'false', '{"width":1,"height":1}'])
  expect(JSON.parse(String(network.calls[7]!.options.body))).toEqual({ appManifestTemplateID: 'developer_console', createAppUserCustomField: { avatar: 'https://images.example.test/original.png', i18n: { zh_cn: { name: f.input.preset.name, description: f.input.preset.description } }, primaryLang: 'zh_cn' }, cid: network.claims[7]!.attemptId, HTTPHead: {} })
  expect(network.calls[8]!.options.body).toBe('{}')
  const snapshots = encrypted(f).map(r => { try { return JSON.parse(f.encryption.decryptString(r.bytes)) } catch { return null } }).filter(r => r?.operationId === f.input.operationId && r.receipt)
  expect(snapshots.map(s => s.kind).sort()).toEqual(['begin', 'authentication', 'authentication', 'authentication', 'authentication', 'authentication', 'upload', 'create', 'credential'].sort())
  for (const original of originalPrivate) expect(encrypted(f).find(p => p.operationId === original.operationId)?.bytes).toEqual(original.bytes)
  const saved = view.operation!.configured, calls = network.calls.length
  expect((await f.sdk.call('connection.enrollment.advance', create)).operation?.configured).toEqual(saved)
  await f.close(); await f.reopen()
  expect((await inspect(f)).operation?.configured).toEqual(saved)
  expect((await f.sdk.call('connection.inspect', { operationId: saved!.operationId })).operation).toEqual(saved)
  expect(await f.sdk.call('connection.service.get', {})).toEqual(f.off.service)
  expect(network.calls).toHaveLength(calls)
  await safeDiscovery(f, await inspect(f))
}, 30_000)

it('does not let account display, stale actions or another actor authorize a create or reveal private account material', async () => {
  const f = await fixture(), network = native()
  const atAccount = await account(f, await f.sdk.call('connection.enrollment.begin', f.input)), confirm = action(atAccount, 'confirm-account'), before = network.calls.length
  await expect(f.sdk.call('connection.enrollment.advance', { ...confirm, decision: { ...confirm.decision, kind: 'create' } })).rejects.toMatchObject({ code: 'CONNECTION_REVISION_CONFLICT' })
  await expect(f.sdk.call('connection.enrollment.begin', { ...f.input, preset: { ...f.input.preset, name: 'Different intent' } })).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
  const service = new AgentMuxRpcService({ connections: f.services.connections }); clean.push(() => service.dispose())
  const wrong = { principal: { kind: 'device' as const, id: 'different-actor' } }
  await expect(service.call('connection.enrollment.inspect', { operationId: f.input.operationId }, wrong)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(service.call('connection.enrollment.advance', confirm, wrong)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(service.call('connection.enrollment.begin', f.input, wrong)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  const actor = row(f).actor, sameActor = { id: actor.id, kind: actor.kind }
  const sameRead = await f.services.connections.enrollment!.inspect({ operationId: f.input.operationId }, { actor: sameActor }).then(value => ({ value }), error => ({ error }))
  const sameBegin = await f.services.connections.enrollment!.begin(f.input, { actor: sameActor }).then(value => ({ value }), error => ({ error }))
  expect(sameRead).toEqual({ value: atAccount }); expect(sameBegin).toEqual({ value: atAccount })
  const view = await f.sdk.call('connection.enrollment.advance', confirm), create = action(view, 'create')
  await expect(f.sdk.call('connection.enrollment.advance', { ...create, ownRevision: create.ownRevision + 1 })).rejects.toMatchObject({ code: 'CONNECTION_REVISION_CONFLICT' })
  expect((await inspect(f)).actions).toContainEqual({ actionId: create.decision.actionId, kind: 'create', ownRevision: create.ownRevision })
  expect(network.calls).toHaveLength(before); expect((await f.sdk.call('connection.ls', {})).connections).toEqual([])
  expect((await inspect(f)).account).toEqual(atAccount.account)
  const other = { ...f.input, operationId: 'other-qualified-enrollment', connectionId: 'other-qualified-connection', preset: { ...f.input.preset, name: 'Another genuine intent' } }
  const otherView = await advance(f, await account(f, await f.sdk.call('connection.enrollment.begin', other)), 'confirm-account'), otherCreate = action(otherView, 'create'), afterOtherAuth = network.calls.length
  await expect(f.sdk.call('connection.enrollment.advance', { ...create, operationId: other.operationId, ownRevision: otherCreate.ownRevision })).rejects.toMatchObject({ code: 'CONNECTION_REVISION_CONFLICT' })
  expect(action(await inspect(f), 'create')).toEqual(create)
  expect(action(await f.sdk.call('connection.enrollment.inspect', { operationId: other.operationId }), 'create')).toEqual(otherCreate)
  expect(network.calls).toHaveLength(afterOtherAuth)
  expect(network.calls.filter(c => c.path.startsWith('/developers/'))).toEqual([])
}, 20_000)

it.each(['inflight-create', 'secure-created'] as const)('preserves the original create and app facts through real owner death: %s', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'enrollment-web-owner-')), socketPath = join(root, 'owner.sock')
  clean.push(() => rm(root, { recursive: true, force: true }))
  const start = async (fault: string) => {
    const child = fork(new URL('./fixtures/connection-enrollment-web-owner.mjs', import.meta.url), [root, fault], { execArgv: ['--experimental-transform-types'], env: objectCliEnvironment(root), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    clean.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit') } })
    let diagnostics = ''; child.stderr!.on('data', data => { diagnostics += String(data) })
    await new Promise<void>((resolve, reject) => { child.on('message', value => { if ((value as { kind: string }).kind === 'ready') resolve() }); child.once('exit', () => reject(new Error(diagnostics || 'Original enrollment owner exited before ready'))) })
    return child
  }
  const cli = (args: string[], input?: unknown) => runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', 'enrollment', ...args], objectCliEnvironment(root), input === undefined ? '' : JSON.stringify(input))
  const input: ConnectionEnrollmentBeginInput = { operationId: 'web-child-original', connectionId: 'web-child-connection', adapterId: 'feishu', domain: APP.domain, label: 'Original child bot', preset: { name: 'Original child bot', avatar: { pngDataUrl: PNG } } }
  const child = await start(mode), sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); clean.push(() => sdk.dispose())
  let view = await account({ sdk }, result(await cli(['begin', '--input', '-'], input)))
  view = await advance({ sdk }, view, 'confirm-account')
  const create = action(view, 'create')
  const reached = new Promise<void>(resolve => child.on('message', message => { if ((message as { kind: string }).kind === mode) resolve() }))
  const work = cli(['advance', '--input', '-'], create)
  await reached; child.kill('SIGKILL'); await once(child, 'exit'); expect((await work).code).not.toBe(0)
  const effects = async () => (await readFile(join(root, 'native-effects.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { path: string; attemptId: string })
  const before = await effects(); expect(before.filter(e => e.path === '/developers/v1/manifest/upsert_by_template')).toHaveLength(1)
  const originalCreateAttempt = before.find(e => e.path === '/developers/v1/manifest/upsert_by_template')!.attemptId
  const replacement = await start(mode === 'inflight-create' ? 'observe-only' : 'credential-only')
  const reopened = result(await cli(['inspect', '--operation-id', input.operationId]))
  expect(reopened.operation?.operationId).toBe(input.operationId); expect(reopened.operation?.connectionId).toBe(input.connectionId)
  if (mode === 'inflight-create') {
    expect(reopened.operation?.application).toBeNull()
    await cli(['advance', '--input', '-'], create)
    const inspected = result(await cli(['inspect', '--operation-id', input.operationId]))
    result(await cli(['advance', '--input', '-'], action(inspected, 'recover-local')))
    expect((await effects())).toEqual(before)
    expect(result(await cli(['inspect', '--operation-id', input.operationId])).actions.map(a => a.kind)).not.toContain('create')
  } else {
    expect(reopened.operation?.application).toEqual(APP)
    const restored = result(await cli(['advance', '--input', '-'], action(reopened, 'recover-local')))
    expect(restored.operation).toMatchObject({ application: APP, creation: { create: 'confirmed' } })
    expect(await effects()).toEqual(before)
    const saved = result(await cli(['advance', '--input', '-'], action(restored, 'read-credential')))
    expect(saved.operation).toMatchObject({ application: APP, credential: 'stored', configuration: 'configured' })
    expect((await effects()).slice(before.length).map(e => e.path)).toEqual(['/developers/v1/secret/' + APP.appId])
  }
  const database = new DatabaseSync(join(root, 'connections.sqlite'), { readOnly: true })
  try {
    expect(database.prepare('SELECT operation_id,kind FROM connection_enrollment_attempt WHERE attempt_id=?').get(originalCreateAttempt)).toEqual({ operation_id: input.operationId, kind: 'create' })
    expect(database.prepare("SELECT attempt_id FROM connection_enrollment_attempt WHERE kind='create'").all()).toEqual([{ attempt_id: originalCreateAttempt }])
  } finally { database.close() }
  replacement.kill('SIGKILL'); await once(replacement, 'exit')
}, 30_000)

it('retains an unknown original create across duplicate input, local recovery and owner reopen without a second upload/create/init', async () => {
  const f = await fixture(), network = native(f, { create: async () => { throw new Error('Private response was lost after platform dispatch') } })
  const create = action(await confirmed(f), 'create')
  const unknown = await f.sdk.call('connection.enrollment.advance', create)
  expect(unknown.operation).toMatchObject({ application: null, creation: { upload: 'confirmed', create: 'unknown' } })
  expect(unknown.operation?.diagnostic).toEqual({ stage: 'request', code: 'transport-unconfirmed' })
  const calls = network.calls.length, attempts = network.claims.slice()
  await f.sdk.call('connection.enrollment.advance', create)
  await f.sdk.call('connection.enrollment.begin', f.input)
  await advance(f, await inspect(f), 'recover-local')
  await f.close(); await f.reopen()
  const reopened = await inspect(f)
  expect(reopened.operation?.application).toBeNull(); expect(reopened.actions.map(a => a.kind)).not.toContain('create')
  await f.sdk.call('connection.enrollment.advance', create)
  expect(network.calls).toHaveLength(calls); expect(network.claims).toEqual(attempts)
  expect((await f.sdk.call('connection.ls', {})).connections).toEqual([])
  await safeDiscovery(f, await inspect(f))
}, 20_000)

it('offers an explicit same-app credential read after a failed read without replaying the original create action', async () => {
  let missing = true
  const f = await fixture(), network = native(f, { credential: async () => Response.json(missing ? { code: 0, data: {} } : { code: 0, data: { secret: SECRET } }) })
  const create = action(await confirmed(f), 'create'), failed = await f.sdk.call('connection.enrollment.advance', create)
  expect(failed.operation).toMatchObject({ application: APP, credential: 'unknown', configured: null, creation: { create: 'confirmed' } })
  const before = network.calls.length
  await f.sdk.call('connection.enrollment.advance', create)
  expect(network.calls).toHaveLength(before)
  missing = false
  const saved = await advance(f, await inspect(f), 'read-credential')
  expect(saved.operation).toMatchObject({ application: APP, configuration: 'configured' })
  expect(network.calls.slice(before).map(c => c.path)).toEqual(['/developers/v1/secret/' + APP.appId])
  expect(network.calls.filter(c => c.path === '/developers/v1/manifest/upsert_by_template')).toHaveLength(1)
}, 20_000)

it('continues the exact known app after its create snapshot store failed and a replacement Host has lost all unsettled memory', async () => {
  const f = await fixture(), network = native(f), store = DesktopConnectorSecrets.prototype.store
  let fail = true, blockedSnapshots = 0
  vi.spyOn(DesktopConnectorSecrets.prototype, 'store').mockImplementation(async function(this: DesktopConnectorSecrets, input) {
    let envelope: { kind?: string } | undefined; try { envelope = JSON.parse(input.secret) } catch { /* The app credential is an opaque string. */ }
    if (fail && envelope?.kind === 'create') { blockedSnapshots++; throw new AgentMuxError('Original private create snapshot was not secured.', 'CONNECTION_CREDENTIAL_UNAVAILABLE') }
    return await store.call(this, input)
  })


  const unknown = await advance(f, await confirmed(f), 'create')
  expect(blockedSnapshots).toBe(1)
  expect(unknown.operation?.application).toEqual(APP); expect(unknown.operation?.configuration).not.toBe('configured')
  expect(network.calls.filter(c => c.path.startsWith('/developers/v1/secret/'))).toEqual([])
  const calls = network.calls.length
  await f.close(); fail = false; await f.reopen()
  const reopened = await inspect(f)
  expect(reopened.operation?.application).toEqual(APP)
  const recovered = await advance(f, reopened, 'read-credential')
  expect(recovered.operation).toMatchObject({ application: APP, configuration: 'configured', credential: 'stored' })
  expect(network.calls.slice(calls).map(c => c.path)).toEqual(['/developers/v1/secret/' + APP.appId])
  expect(network.calls.filter(c => c.path === '/developers/v1/manifest/upsert_by_template')).toHaveLength(1)
  expect(network.calls.filter(c => c.path === '/developers/v1/app/upload/image')).toHaveLength(1)
}, 20_000)

it('repairs the committed original credential locally after ACK loss and adapter removal without current authentication', async () => {
  const f = await fixture(), network = native(f), store = DesktopConnectorSecrets.prototype.store
  let lose = true
  vi.spyOn(DesktopConnectorSecrets.prototype, 'store').mockImplementation(async function(this: DesktopConnectorSecrets, input) {
    const receipt = await store.call(this, input)
    if (lose && input.secret === SECRET) { lose = false; throw new AgentMuxError('Original secret ACK was lost.', 'CONNECTION_CREDENTIAL_UNCONFIRMED') }
    return receipt
  })
  const failed = await advance(f, await confirmed(f), 'create')
  expect(failed.operation?.application).toEqual(APP); expect(failed.operation?.configuration).not.toBe('configured')
  const calls = network.calls.length, original = row(f), credential = await f.services.secrets.inspect(original.credentialOperationId)
  expect(credential).not.toBeNull()
  await f.close(); await f.reopen(true)
  const saved = await advance(f, await inspect(f), 'recover-local')
  expect(saved.operation).toMatchObject({ application: APP, credential: 'stored', configuration: 'configured' })
  expect(row(f).credentialOperationId).toBe(original.credentialOperationId)
  expect(row(f).configureOperationId).toBe(original.configureOperationId)
  expect(network.calls).toHaveLength(calls)
}, 20_000)

it('preserves a late exact create receipt while rejecting the former transport authority before any credential request', async () => {
  let deliver!: (response: Response) => void
  const f = await fixture(), network = native(f, { create: () => new Promise<Response>(resolve => { deliver = resolve }) })
  const create = action(await confirmed(f), 'create'), service = new AgentMuxRpcService({ connections: f.services.connections }); clean.push(() => service.dispose())
  const actor = row(f).actor, failure = new AgentMuxError('The original transport authority was lost.', 'CONTROL_PERMISSION_DENIED')
  let current = true
  const work = service.call('connection.enrollment.advance', create, { principal: actor, assertCurrent: () => { if (!current) throw failure } })
  const settled = work.then(value => ({ value }), error => ({ error }))
  await vi.waitFor(() => expect(deliver).toBeTypeOf('function'))
  current = false; deliver(Response.json({ code: 0, data: { ClientID: APP.appId } }))
  expect(await settled).toMatchObject({ error: { code: 'CONTROL_PERMISSION_DENIED' } })
  const known = await inspect(f)
  expect(known.operation?.application).toEqual(APP)
  expect(network.calls.filter(c => c.path.startsWith('/developers/v1/secret/'))).toEqual([])
  const saved = await advance(f, known, 'read-credential')
  expect(saved.operation?.configuration).toBe('configured')
  expect(network.calls.filter(c => c.path === '/developers/v1/manifest/upsert_by_template')).toHaveLength(1)
}, 20_000)

it('rechecks the original transport after resolving private account bytes without deleting the original receipt', async () => {
  const f = await fixture(), network = native(f), view = await account(f, await f.sdk.call('connection.enrollment.begin', f.input))
  const service = new AgentMuxRpcService({ connections: f.services.connections }); clean.push(() => service.dispose())
  const original = DesktopConnectorSecrets.prototype.resolve, saved = encrypted(f), before = JSON.stringify(row(f))
  let entered = false, release!: () => void, current = true
  const barrier = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(DesktopConnectorSecrets.prototype, 'resolve').mockImplementation(async function(this: DesktopConnectorSecrets, ref) {
    const raw = await original.call(this, ref)
    if (!entered && raw?.includes('"operationId":"' + f.input.operationId + '"')) { entered = true; await barrier }
    return raw
  })
  const work = service.call('connection.enrollment.inspect', { operationId: f.input.operationId }, { principal: row(f).actor, assertCurrent: () => { if (!current) throw new AgentMuxError('Original authority is unavailable.', 'CONTROL_PERMISSION_DENIED') } })
  const settled = work.then(value => ({ value }), error => ({ error }))
  try { await vi.waitFor(() => expect(entered).toBe(true)); current = false } finally { release() }
  expect(await settled).toMatchObject({ error: { code: 'CONTROL_PERMISSION_DENIED' } })
  expect(JSON.stringify(row(f))).toBe(before)
  for (const receipt of saved) expect(encrypted(f).find(p => p.operationId === receipt.operationId)?.bytes).toEqual(receipt.bytes)
  expect((await inspect(f)).account).toEqual(view.account)
  expect(network.calls.filter(c => c.path.startsWith('/developers/'))).toEqual([])
}, 20_000)

it('withholds an old QR read after a real same-intent renewal changes the authentication attempt', async () => {
  const f = await fixture(), network = native(undefined, { poll: async () => { throw new TypeError('The original poll response is unconfirmed') } })
  const waiting = await f.sdk.call('connection.enrollment.begin', f.input), oldAttempt = waiting.operation!.authentication!.attemptId, original = DesktopConnectorSecrets.prototype.resolve, oldPrivate = encrypted(f)
  const service = new AgentMuxRpcService({ connections: f.services.connections }); clean.push(() => service.dispose())
  let entered = false, release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(DesktopConnectorSecrets.prototype, 'resolve').mockImplementation(async function(this: DesktopConnectorSecrets, ref) {
    const raw = await original.call(this, ref)
    if (!entered && raw?.includes('"operationId":"' + f.input.operationId + '"')) { entered = true; await barrier }
    return raw
  })
  const reading = service.call('connection.enrollment.inspect', { operationId: f.input.operationId }, { principal: row(f).actor })
  let renewed!: ConnectionEnrollmentView
  try {
    await vi.waitFor(() => expect(entered).toBe(true))
    if (waiting.challenge && waiting.challenge.nextPollAt > Date.now()) await delay(waiting.challenge.nextPollAt - Date.now())
    const unknown = await advance(f, waiting, 'continue-authentication')
    renewed = await advance(f, unknown, 'renew-authentication')
    expect(renewed.operation!.authentication!.attemptId).not.toBe(oldAttempt)
  } finally { release() }
  const late = await reading
  expect(late.operation!.authentication!.attemptId).toBe(renewed.operation!.authentication!.attemptId)
  expect(late.challenge).toBeNull(); expect(late.account).toBeNull()
  expect(late.actions.map(a => a.kind)).toEqual(['recover-local'])
  expect((await inspect(f)).challenge).toEqual(renewed.challenge)
  for (const receipt of oldPrivate) expect(encrypted(f).find(p => p.operationId === receipt.operationId)?.bytes).toEqual(receipt.bytes)
  expect(network.calls.filter(c => c.path.startsWith('/developers/'))).toEqual([])
}, 20_000)

it('refuses an unadmitted competing local action instead of returning the in-flight Create receipt as its own', async () => {
  let deliver!: (response: Response) => void
  const f = await fixture(), network = native(f, { create: () => new Promise<Response>(resolve => { deliver = resolve }) })
  const create = action(await confirmed(f), 'create'), first = f.sdk.call('connection.enrollment.advance', create)
  const firstResult = first.then(value => ({ value }), error => ({ error }))
  await vi.waitFor(() => expect(deliver).toBeTypeOf('function'))
  const competing = action(await inspect(f), 'recover-local'), observer = vi.spyOn(f.services.connections.enrollment!, 'advance')
  const secondResult = f.sdk.call('connection.enrollment.advance', competing).then(value => ({ value }), error => ({ error }))
  await vi.waitFor(() => expect(observer.mock.calls.some(([input]) => input.decision.actionId === competing.decision.actionId)).toBe(true))
  await inspect(f)
  deliver(Response.json({ code: 0, data: { ClientID: APP.appId } }))
  const original = await firstResult
  expect(original).toMatchObject({ value: { operation: { application: APP, configuration: 'configured' }, receipt: { actionId: create.decision.actionId, state: 'confirmed' } } })
  expect(await secondResult).toMatchObject({ error: { code: 'CONNECTION_REVISION_CONFLICT' } })
  const calls = network.calls.length
  await expect(f.sdk.call('connection.enrollment.advance', competing)).rejects.toMatchObject({ code: 'CONNECTION_REVISION_CONFLICT' })
  expect((await f.sdk.call('connection.enrollment.advance', create)).receipt?.actionId).toBe(create.decision.actionId)
  expect(network.calls).toHaveLength(calls)
}, 20_000)

it('keeps a durable ordinary-creation intent on its original route through same-intent authentication renewal', async () => {
  const f = await fixture()
  let expired = true
  const network = native(f, { poll: async () => expired
    ? Response.json({ code: 0, data: { next_step: null, step_info: { status: 5 } } })
    : Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross' } } }) })
  let view = await f.sdk.call('connection.enrollment.begin', f.input)
  // Exact persisted pre-template format: the original record had no protocol selection field.
  const legacy = row(f); delete legacy.adapterProtocolId
  f.services.database!.prepare('UPDATE connection_enrollment SET record_json=? WHERE operation_id=?').run(JSON.stringify(legacy), f.input.operationId)
  if (view.challenge && view.challenge.nextPollAt > Date.now()) await delay(view.challenge.nextPollAt - Date.now())
  view = await advance(f, view, 'continue-authentication')
  expect(view.operation?.authentication?.stage).toBe('expired')
  expired = false
  view = await advance(f, view, 'renew-authentication')
  expect(row(f).adapterProtocolId).toBeUndefined()
  view = await account(f, view)
  view = await advance(f, view, 'confirm-account')
  view = await advance(f, view, 'create')
  expect(view.operation?.configuration).toBe('configured')
  expect(network.calls.filter(call => call.path === '/developers/v1/app/create')).toHaveLength(1)
  expect(network.calls.filter(call => call.path === '/developers/v1/manifest/upsert_by_template')).toEqual([])
}, 20_000)
