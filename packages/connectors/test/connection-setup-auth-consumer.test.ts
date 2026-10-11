import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { DesktopConnectorSecrets } from '../../../apps/desktop/src/main/connector-secrets.js'
import { DatabaseSync } from 'node:sqlite'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, AgentMuxRpcService, connectAgentMuxRpc } from '@agentmux/core'
import type { ConnectionConfig, ConnectionSetupAdvance, ConnectionSetupBegin, ConnectionSetupView } from '@agentmux/core/connections'
import { objectCliEnvironment, runCompiledObjectCli, type CliResult } from '../../core/test/helpers/object-cli-rpc.js'
import { enrollmentEncryption } from './fixtures/connection-enrollment.js'

const TOKEN = 'fixture-auth-original-token', FLOW = 'fixture-auth-original-flow'
const SESSION = 'fixture-auth-private-session', CSRF = 'fixture-auth-private-csrf'
const USER = 'fixture-auth-stable-user', TENANT = 'fixture-auth-stable-tenant'
const CREDENTIAL = 'fixture-auth-saved-bot-secret'
const goal = { kind: 'agent-conversation', interaction: 'messages' } as const
const clean: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const close of clean.splice(0).reverse()) await close() })
function result<T = ConnectionSetupView>(output: CliResult): T { expect(output.code, output.stdout + output.stderr).toBe(0); return JSON.parse(output.stdout).result }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function qrResponse(token = TOKEN) {
  return Response.json({ code: 0, data: { step_info: { token } } }, { headers: [
    ['x-flow-key', FLOW],
    ['set-cookie', `session=${SESSION}; Domain=.feishu.cn; Path=/; Secure; HttpOnly`],
    ['set-cookie', 'pollOnly=fixture-poll-cookie; Path=/accounts/qrlogin; Secure'],
    ['set-cookie', 'crossOnly=fixture-cross-cookie; Path=/cross-login; Secure'],
    ['set-cookie', 'expired=fixture-expired-cookie; Domain=.feishu.cn; Path=/; Max-Age=0; Secure']
  ] })
}
const polling = (status: number, enter = false, uri = 'https://accounts.feishu.cn/cross-login') => Response.json({ code: 0, data: {
  next_step: enter ? 'enter_app' : null, step_info: { status, ...(enter ? { cross_login_uri: uri } : {}) }
} })
const bootstrap = (user: object = { id: USER, tenantId: TENANT, name: 'Fixture account', tenantName: 'Fixture enterprise' }) => `<script>window.csrfToken=${JSON.stringify(CSRF)};window.user=${JSON.stringify(user)};</script>`
function advanceInput(view: ConnectionSetupView, kind: 'continue' | 'confirm-account' | 'renew' = 'continue'): ConnectionSetupAdvance {
  expect(view.operation).not.toBeNull()
  const actions = view.continuation?.actions.filter(action => action.kind === kind) ?? []
  expect(actions, `Expected one ${kind} action in ${JSON.stringify(view)}`).toHaveLength(1)
  expect(actions[0]).toMatchObject({ actionId: expect.any(String), expectedRevision: expect.any(Number) })
  return { operationId: view.operation!.operationId, expectedRevision: actions[0].expectedRevision,
    decision: { actionId: actions[0].actionId, value: kind === 'confirm-account' ? 'confirm' : kind } }
}
async function fixture(options: { paused?: boolean; operationId?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'setup-auth-')), directory = join(root, 'connections'), socketPath = join(root, 'owner.sock'), encryption = enrollmentEncryption()
  let services: Awaited<ReturnType<typeof createDesktopConnections>>, server: AgentMuxControlServer, sdk: Awaited<ReturnType<typeof connectAgentMuxRpc>>
  const open = async () => {
    services = await createDesktopConnections({ directory, encryption })
    server = new AgentMuxControlServer({ socketPath, connections: services.connections, coreClients: () => { throw new Error('Authentication cannot borrow an Agent Runtime') } })
    await server.start(); sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  }
  const close = async () => { await sdk?.dispose(); await server?.stop(); services?.close() }
  clean.push(async () => { await close(); await rm(root, { recursive: true, force: true }) })
  await open()
  const credential = await services.secrets.store({ operationId: 'auth-saved-credential', secret: CREDENTIAL })
  const config: ConnectionConfig = { connectionId: 'auth-saved-bot', adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: 'cli_auth_saved_bot' }, label: 'Original saved bot', enabled: !options.paused, credentialRef: credential.credentialRef }
  const saved = await sdk.call('connection.configure', { operationId: 'auth-original-save', expectedRevision: null, connection: config })
  const input: ConnectionSetupBegin = { operationId: options.operationId ?? 'auth-original-management', connectionId: config.connectionId, expectedConnectionRevision: saved.connection.revision, goal }
  const cli = (args: string[], body?: unknown) => runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', 'setup', ...args], objectCliEnvironment(root), body === undefined ? '' : JSON.stringify(body))
  return { root, directory, encryption, config, saved, input, cli, close, reopen: open, get sdk() { return sdk }, get services() { return services } }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function inspect(f: Fixture, operationId = f.input.operationId) { return await f.sdk.call('connection.setup.inspect', { operationId }) }
async function advance(f: Fixture, view: ConnectionSetupView, kind: 'continue' | 'confirm-account' | 'renew' = 'continue') {
  return await f.sdk.call('connection.setup.advance', advanceInput(view, kind))
}
function nativeRoute(options: { scanned?: boolean; html?: string; crossUri?: string; redirect?: string; consoleRedirect?: boolean } = {}) {
  let polls = 0
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const target = new URL(String(url)), headers = new Headers(init?.headers)
    expect(init?.redirect).toBe('manual')
    expect(target.protocol).toBe('https:'); expect(target.username + target.password + target.hash).toBe('')
    if (target.pathname === '/accounts/qrlogin/init') return qrResponse()
    if (target.pathname === '/accounts/qrlogin/polling') {
      expect(target.origin).toBe('https://accounts.feishu.cn'); expect(init?.method).toBe('POST')
      expect(headers.get('x-flow-key')).toBe(FLOW); expect(JSON.parse(String(init?.body))).toEqual({ biz_type: null })
      polls++
      return options.scanned && polls === 1 ? polling(2) : polling(1, true, options.crossUri)
    }
    expect(headers.get('x-flow-key')).toBeNull(); expect(headers.get('x-csrf-token')).toBeNull()
    if (target.href === 'https://accounts.feishu.cn/cross-login') return new Response('', { status: 302, headers: {
      location: options.redirect ?? 'https://ask.feishu.cn/', 'set-cookie': 'web_session=fixture-console-session; Domain=.feishu.cn; Path=/; Secure; HttpOnly'
    } })
    if (target.href === 'https://ask.feishu.cn/') return new Response('Landing page; this text is not identity', { headers: { 'set-cookie': 'askOnly=fixture-ask-cookie; Path=/; Secure' } })
    if (target.href === 'https://open.feishu.cn/app' && options.consoleRedirect) return new Response('', { status: 302, headers: { location: 'https://open.larkoffice.com/app' } })
    if (target.href === 'https://open.feishu.cn/app' || (options.consoleRedirect && target.href === 'https://open.larkoffice.com/app')) return new Response(options.html ?? bootstrap(), { headers: { 'content-type': 'text/html' } })
    throw new Error('Unexpected authentication request ' + target.origin + target.pathname)
  }
}
async function toAccount(f: Fixture, view: ConnectionSetupView): Promise<ConnectionSetupView> {
  for (let count = 0; count < 8 && view.continuation?.stage !== 'account'; count++) view = await advance(f, view)
  expect(view.continuation).toMatchObject({ stage: 'account', account: { userId: USER, tenantId: TENANT } })
  return view
}
function privateRows(database: DatabaseSync) {
  return database.prepare('SELECT operation_id,ciphertext FROM connection_credential ORDER BY operation_id').all().map(row => ({ operationId: String(row.operation_id), bytes: Buffer.from(row.ciphertext as Uint8Array) }))
}
function authenticationSnapshots(f: Fixture, operationId: string): Record<string, unknown>[] {
  return privateRows(f.services.database!).flatMap(row => {
    try {
      const envelope = JSON.parse(f.encryption.decryptString(row.bytes))
      return envelope?.operationId === operationId && typeof envelope.privateState === 'string' ? [JSON.parse(envelope.privateState) as Record<string, unknown>] : []
    } catch { return [] }
  })
}
async function assertSafeDiscovery(f: Fixture, view: ConnectionSetupView) {
  const listed = result<{ operations: unknown[]; next: string | null }>(await f.cli(['ls', '--connection', f.input.connectionId]))
  expect(listed).toEqual({ operations: [view.operation], next: null, support: { connectionRevision: view.operation!.expectedConnectionRevision, capabilities: ['management-authentication', 'application-inspection', 'messaging-capability', 'persistent-event-transport', 'application-permissions', 'enrollment-continuation'] } })
  const tables = f.services.database!.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
  expect(tables.length).toBeGreaterThan(0)
  const records = tables.map(table => f.services.database!.prepare('SELECT * FROM "' + String(table.name).replaceAll('"', '""') + '"').all())
  const plain = JSON.stringify({ listed, records })
  for (const value of [TOKEN, FLOW, SESSION, CSRF, USER, TENANT, CREDENTIAL, 'Fixture account', 'Fixture enterprise']) expect(plain).not.toContain(value)
  const encrypted = privateRows(f.services.database!)
  expect(encrypted.length).toBeGreaterThan(1)
  const decrypted = encrypted.map(row => f.encryption.decryptString(row.bytes))
  expect(decrypted.some(value => value.includes(FLOW))).toBe(true)
  expect(decrypted.some(value => value.includes(USER) && value.includes(TENANT) && value.includes(CSRF))).toBe(true)
  f.services.database!.exec('PRAGMA wal_checkpoint(FULL)')
  const files = [await readFile(join(f.directory, 'connections.sqlite'))]
  try { files.push(await readFile(join(f.directory, 'connections.sqlite-wal'))) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  for (const value of [TOKEN, FLOW, SESSION, CSRF, USER, TENANT, CREDENTIAL]) expect(Buffer.concat(files).includes(Buffer.from(value))).toBe(false)
}

it('compiled CLI and SDK consume one claimed HTTP per original action, then confirm the exact account without configuring the saved bot', async () => {
  const f = await fixture({ paused: true })
  const off = await f.sdk.call('connection.service.configure', { operationId: 'auth-traffic-off', expectedRevision: 0, service: { enabled: false } })
  const before = await f.sdk.call('connection.inspect', { connectionId: f.input.connectionId }), claims: Array<{ attemptId: string; stepId: string }> = []
  const route = nativeRoute({ scanned: true })
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(url)).pathname !== '/accounts/qrlogin/init') {
      const observed = await inspect(f)
      expect(observed.operation?.authentication).toMatchObject({ attemptId: expect.any(String), stepId: expect.any(String), request: 'dispatching' })
      claims.push({ attemptId: observed.operation!.authentication!.attemptId, stepId: observed.operation!.authentication!.stepId })
    }
    return await route(url, init)
  }); vi.stubGlobal('fetch', fetch)
  let view = result(await f.cli(['begin', '--input', '-'], f.input))
  const originalAttempt = view.operation!.request.attemptId
  expect(view.continuation).toMatchObject({ stage: 'waiting', account: null })
  expect(view.continuation?.actions.map(action => action.kind)).not.toContain('confirm-account')
  const firstInput = advanceInput(view), originalPrivate = privateRows(f.services.database!)
  view = result(await f.cli(['advance', '--input', '-'], firstInput))
  expect(view.receipt).toMatchObject({ actionId: firstInput.decision.actionId, stepId: expect.any(String), state: 'confirmed' })
  expect(view.continuation).toMatchObject({ stage: 'scanned', account: null })
  expect(view.continuation?.actions.map(action => action.kind)).not.toContain('confirm-account')
  expect(fetch).toHaveBeenCalledTimes(2)
  const repeated = await f.sdk.call('connection.setup.advance', firstInput)
  expect(repeated.receipt).toEqual(view.receipt); expect(fetch).toHaveBeenCalledTimes(2)
  const steps = [view.receipt!.stepId]
  for (let count = 0; count < 6 && view.continuation?.stage !== 'account'; count++) {
    const oldPrivate = privateRows(f.services.database!), input = advanceInput(view), calls = fetch.mock.calls.length
    view = await f.sdk.call('connection.setup.advance', input)
    expect(fetch.mock.calls.length - calls).toBe(1)
    expect(view.receipt).toMatchObject({ actionId: input.decision.actionId, state: 'confirmed' })
    steps.push(view.receipt!.stepId)
    const nextPrivate = privateRows(f.services.database!)
    expect(nextPrivate.length).toBeGreaterThan(oldPrivate.length)
    for (const old of oldPrivate) expect(nextPrivate.find(row => row.operationId === old.operationId)?.bytes).toEqual(old.bytes)
    if (view.continuation?.stage !== 'account') expect(view.continuation?.account).toBeNull()
  }
  expect(view.continuation).toMatchObject({ stage: 'account', account: { userId: USER, tenantId: TENANT, userName: 'Fixture account', tenantName: 'Fixture enterprise' } })
  expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/accounts/qrlogin/init', '/accounts/qrlogin/polling', '/accounts/qrlogin/polling', '/cross-login', '/', '/app'])
  expect(new Set(steps).size).toBe(steps.length)
  expect(claims).toHaveLength(5); expect(new Set(claims.map(claim => claim.attemptId)).size).toBe(1)
  expect(new Set(claims.map(claim => claim.stepId)).size).toBe(5)
  const confirm = advanceInput(view, 'confirm-account'), calls = fetch.mock.calls.length
  view = result(await f.cli(['advance', '--input', '-'], confirm))
  expect(view.continuation).toMatchObject({ stage: 'confirmed', account: { userId: USER, tenantId: TENANT } })
  expect(view.receipt).toMatchObject({ actionId: confirm.decision.actionId, state: 'confirmed' })
  expect(fetch).toHaveBeenCalledTimes(calls)
  expect(view.operation?.request.attemptId).toBe(originalAttempt)
  for (const old of originalPrivate) expect(privateRows(f.services.database!).find(row => row.operationId === old.operationId)?.bytes).toEqual(old.bytes)
  expect(await f.sdk.call('connection.inspect', { connectionId: f.input.connectionId })).toEqual(before)
  expect((await f.sdk.call('connection.inspect', { operationId: 'auth-original-save' })).operation).toEqual(f.saved)
  expect(await f.sdk.call('connection.service.get', {})).toEqual(off.service)
  await assertSafeDiscovery(f, view)
}, 45_000)

it('original v1 init and v2 authentication snapshots retain the exact saved application across owner reopen', async () => {
  const f = await fixture(), fetch = vi.fn(nativeRoute({ scanned: true })); vi.stubGlobal('fetch', fetch)
  let view = result(await f.cli(['begin', '--input', '-'], f.input))
  const scope = { operationId: f.input.operationId, connectionId: f.input.connectionId, attemptId: view.operation!.request.attemptId, application: f.config.application }
  const initial = authenticationSnapshots(f, f.input.operationId)
  expect(initial).toHaveLength(1)
  expect(initial[0]).toMatchObject({ ...scope, version: 1, flowKey: FLOW, token: TOKEN, setCookies: expect.any(Array) })
  expect(Object.keys(initial[0]!).sort()).toEqual(['version', 'operationId', 'connectionId', 'attemptId', 'application', 'flowKey', 'token', 'setCookies'].sort())
  const original = privateRows(f.services.database!), input = advanceInput(view)
  await f.close(); await f.reopen()
  expect((await inspect(f)).continuation).toEqual(view.continuation)
  expect(fetch).toHaveBeenCalledTimes(1)
  view = await f.sdk.call('connection.setup.advance', input)
  expect(view.continuation).toMatchObject({ stage: 'scanned', account: null })
  const progressed = authenticationSnapshots(f, f.input.operationId)
  expect(progressed).toHaveLength(2)
  expect(progressed.map(snapshot => snapshot.version).sort()).toEqual([1, 2])
  expect(progressed.find(snapshot => snapshot.version === 1)).toEqual(initial[0])
  expect(progressed.find(snapshot => snapshot.version === 2)).toMatchObject({ ...scope, version: 2, flowKey: FLOW, token: TOKEN, phase: 'poll', hops: 0, cookieJar: { cookies: expect.any(Array) } })
  await f.close(); await f.reopen()
  expect((await inspect(f)).continuation).toEqual(view.continuation)
  expect((await f.sdk.call('connection.setup.advance', input)).receipt).toEqual(view.receipt)
  expect(fetch).toHaveBeenCalledTimes(2)
  view = await toAccount(f, view)
  const completed = authenticationSnapshots(f, f.input.operationId)
  expect(completed.length).toBeGreaterThan(progressed.length)
  for (const snapshot of completed) expect(snapshot).toMatchObject(scope)
  expect(completed.find(snapshot => snapshot.phase === 'account')).toMatchObject({ version: 2, phase: 'account', account: { userId: USER, tenantId: TENANT }, csrf: CSRF, consoleOrigin: 'https://open.feishu.cn' })
  for (const old of original) expect(privateRows(f.services.database!).find(row => row.operationId === old.operationId)?.bytes).toEqual(old.bytes)
  expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/accounts/qrlogin/init', '/accounts/qrlogin/polling', '/accounts/qrlogin/polling', '/cross-login', '/', '/app'])
  expect((await f.sdk.call('connection.inspect', { operationId: 'auth-original-save' })).operation).toEqual(f.saved)
}, 45_000)

it.each([1, 2] as const)('the Setup wrapper refuses foreign bindings in a v%s native snapshot before any HTTP request', async version => {
  const f = await fixture(), route = nativeRoute({ scanned: true }), fetch = vi.fn(route); vi.stubGlobal('fetch', fetch)
  const originalResolve = DesktopConnectorSecrets.prototype.resolve
  const changes = [
    { operationId: 'foreign-management-intent' },
    { connectionId: 'foreign-saved-connection' },
    { attemptId: 'foreign-authentication-attempt' },
    { application: { ...f.config.application, appId: 'cli_foreign_saved_application' } },
    { application: { ...f.config.application, domain: 'open.larkoffice.com' } }
  ]
  for (const [index, changed] of changes.entries()) {
    const operationId = `foreign-native-v${version}-${index}`
    let view = await f.sdk.call('connection.setup.begin', { ...f.input, operationId })
    if (version === 2) view = await advance(f, view)
    const snapshots = authenticationSnapshots(f, operationId)
    expect(snapshots.length).toBeGreaterThan(0)
    expect(snapshots.find(snapshot => snapshot.version === version)).toBeDefined()
    const original = privateRows(f.services.database!), calls = fetch.mock.calls.length, input = advanceInput(view)
    let substituted = 0
    const fault = vi.spyOn(DesktopConnectorSecrets.prototype, 'resolve').mockImplementation(async function(this: DesktopConnectorSecrets, ref) {
      const value = await originalResolve.call(this, ref)
      if (value === null) return null
      let envelope: { operationId?: string; privateState?: string }
      try { envelope = JSON.parse(value) } catch { return value }
      if (envelope.operationId !== operationId || typeof envelope.privateState !== 'string') return value
      const native = JSON.parse(envelope.privateState)
      expect(native.version).toBe(version)
      substituted++
      return JSON.stringify({ ...envelope, privateState: JSON.stringify({ ...native, ...changed }) })
    })
    try {
      const refused = result(await f.cli(['advance', '--input', '-'], input))
      expect(substituted).toBeGreaterThan(0)
      expect(refused.continuation).toMatchObject({ stage: 'unknown', account: null })
      expect(refused.receipt).toMatchObject({ actionId: input.decision.actionId, state: 'unknown' })
      expect(refused.operation).toMatchObject({ operationId, connectionId: f.input.connectionId, application: f.config.application, expectedConnectionRevision: f.saved.connection.revision })
      expect((await f.sdk.call('connection.setup.advance', input)).receipt).toEqual(refused.receipt)
      expect(fetch).toHaveBeenCalledTimes(calls)
    } finally { fault.mockRestore() }
    for (const old of original) expect(privateRows(f.services.database!).find(row => row.operationId === old.operationId)?.bytes).toEqual(old.bytes)
  }
  expect((await f.sdk.call('connection.inspect', { operationId: 'auth-original-save' })).operation).toEqual(f.saved)
}, 45_000)

it('CookieJar selects domain, host, path and expiry cookies anew for each allowed origin and never forwards flow or CSRF headers', async () => {
  const f = await fixture(), route = nativeRoute({ consoleRedirect: true }), requests: Array<{ url: string; cookies: string[] }> = []
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(url)), headers = new Headers(init?.headers), cookies = (headers.get('cookie') ?? '').split(';').map(value => value.trim()).filter(Boolean).sort()
    requests.push({ url: target.href, cookies })
    expect(headers.get('x-csrf-token')).toBeNull()
    if (target.pathname !== '/accounts/qrlogin/polling') expect(headers.get('x-flow-key')).toBeNull()
    return await route(url, init)
  }); vi.stubGlobal('fetch', fetch)
  const view = await toAccount(f, await f.sdk.call('connection.setup.begin', f.input))
  expect(view.continuation?.account).toMatchObject({ userId: USER, tenantId: TENANT })
  expect(requests).toEqual([
    { url: 'https://accounts.feishu.cn/accounts/qrlogin/init', cookies: [] },
    { url: 'https://accounts.feishu.cn/accounts/qrlogin/polling', cookies: [`pollOnly=fixture-poll-cookie`, `session=${SESSION}`].sort() },
    { url: 'https://accounts.feishu.cn/cross-login', cookies: [`crossOnly=fixture-cross-cookie`, `session=${SESSION}`].sort() },
    { url: 'https://ask.feishu.cn/', cookies: [`session=${SESSION}`, 'web_session=fixture-console-session'].sort() },
    { url: 'https://open.feishu.cn/app', cookies: [`session=${SESSION}`, 'web_session=fixture-console-session'].sort() },
    { url: 'https://open.larkoffice.com/app', cookies: [] }
  ])
}, 30_000)

it('known pending gets a new explicit observation action while malformed machine fields never imply scan, expiry or identity', async () => {
  const f = await fixture(); let polls = 0
  const fetch = vi.fn(async (url: string | URL | Request) => new URL(String(url)).pathname.endsWith('/init') ? qrResponse() : polling(++polls === 1 ? 1 : 2))
  vi.stubGlobal('fetch', fetch)
  const pending = await f.sdk.call('connection.setup.begin', f.input), first = advanceInput(pending)
  const waiting = await f.sdk.call('connection.setup.advance', first)
  expect(waiting.continuation).toMatchObject({ stage: 'waiting', account: null })
  const next = advanceInput(waiting)
  expect(next.decision.actionId).not.toBe(first.decision.actionId)
  expect((await f.sdk.call('connection.setup.advance', first)).receipt).toEqual(waiting.receipt)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect((await f.sdk.call('connection.setup.advance', next)).continuation).toMatchObject({ stage: 'scanned', account: null })
  expect(fetch).toHaveBeenCalledTimes(3)
  const malformed = [
    () => Response.json({ detail: 'fixture-private-http-error' }, { status: 503 }),
    () => Response.json({ code: '0', data: { next_step: null, step_info: { status: 2 } } }),
    () => Response.json({ code: 0, data: { next_step: null, step_info: { status: '2' } } }),
    () => Response.json({ code: 0, data: { next_step: null, step_info: { status: '5' } } }),
    () => Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { status: 1 } } }),
    () => new Response('Phone confirmed. window.user is logged in.')
  ]
  for (const [index, response] of malformed.entries()) {
    const requests = vi.fn(async (url: string | URL | Request) => new URL(String(url)).pathname.endsWith('/init') ? qrResponse() : response())
    vi.stubGlobal('fetch', requests)
    const begun = await f.sdk.call('connection.setup.begin', { ...f.input, operationId: 'malformed-poll-' + index })
    const input = advanceInput(begun), unknown = await f.sdk.call('connection.setup.advance', input)
    expect(unknown.continuation).toMatchObject({ stage: 'unknown', account: null })
    expect(unknown.continuation?.actions.map(action => action.kind)).not.toContain('confirm-account')
    expect(JSON.stringify(unknown)).not.toContain('fixture-private-http-error')
    expect((await f.sdk.call('connection.setup.advance', input)).receipt).toEqual(unknown.receipt)
    expect(requests).toHaveBeenCalledTimes(2)
  }
}, 30_000)

it('concurrent original actions share the durable native claim and a changed decision cannot borrow its authority', async () => {
  const f = await fixture(), entered = deferred<void>(), response = deferred<Response>()
  clean.push(() => response.resolve(polling(2)))
  const fetch = vi.fn(async (url: string | URL | Request) => {
    if (new URL(String(url)).pathname.endsWith('/init')) return qrResponse()
    entered.resolve(); return await response.promise
  }); vi.stubGlobal('fetch', fetch)
  const pending = await f.sdk.call('connection.setup.begin', f.input), input = advanceInput(pending)
  const first = f.cli(['advance', '--input', '-'], input)
  await Promise.race([entered.promise, first.then(output => { expect(result(output).continuation?.stage).toBe('scanned') })])
  const claimed = await inspect(f)
  expect(claimed.operation?.authentication?.request).toBe('dispatching')
  const joined = f.sdk.call('connection.setup.advance', input)
  await expect(f.sdk.call('connection.setup.advance', { ...input, decision: { ...input.decision, value: 'confirm' } })).rejects.toMatchObject({ code: expect.any(String) })
  response.resolve(polling(2))
  const completed = result(await first), duplicate = await joined
  expect(completed.continuation).toMatchObject({ stage: 'scanned', account: null })
  expect(duplicate.receipt).toMatchObject({ actionId: input.decision.actionId, stepId: completed.receipt!.stepId })
  expect((await f.sdk.call('connection.setup.advance', input)).receipt).toEqual(completed.receipt)
  expect(fetch).toHaveBeenCalledTimes(2)
}, 30_000)

it('unsafe cross-login and redirect URLs stop only the exact authentication step before any forbidden fetch', async () => {
  const f = await fixture(), before = await f.sdk.call('connection.inspect', { connectionId: f.input.connectionId })
  const forbidden = ['https://accounts.feishu.cn.unqualified.invalid/cross-login', 'https://unqualified.invalid/', 'http://ask.feishu.cn/', 'https://user:pass@ask.feishu.cn/', 'https://ask.feishu.cn:8443/', 'https://ask.feishu.cn/#private', 'https://sub.ask.feishu.cn/']
  for (const [index, target] of forbidden.entries()) {
    for (const field of ['crossUri', 'redirect'] as const) {
      const input = { ...f.input, operationId: `unsafe-${field}-${index}` }, route = nativeRoute({ [field]: target })
      const fetch = vi.fn(route); vi.stubGlobal('fetch', fetch)
      let view = await f.sdk.call('connection.setup.begin', input)
      let attempted = advanceInput(view); view = await f.sdk.call('connection.setup.advance', attempted)
      if (field === 'redirect') { attempted = advanceInput(view); view = await f.sdk.call('connection.setup.advance', attempted) }
      expect(view.continuation?.stage).toBe('unknown'); expect(view.continuation?.account).toBeNull()
      expect(view.receipt).toMatchObject({ actionId: attempted.decision.actionId, stepId: expect.any(String) })
      expect(fetch.mock.calls.some(([url]) => String(url) === target)).toBe(false)
      expect(fetch).toHaveBeenCalledTimes(field === 'crossUri' ? 2 : 3)
      expect((await f.sdk.call('connection.setup.advance', attempted)).receipt).toEqual(view.receipt)
      expect(fetch).toHaveBeenCalledTimes(field === 'crossUri' ? 2 : 3)
    }
  }
  expect(await f.sdk.call('connection.inspect', { connectionId: f.input.connectionId })).toEqual(before)
  expect((await f.sdk.call('connection.inspect', { operationId: 'auth-original-save' })).operation).toEqual(f.saved)
}, 45_000)

it('redirect cycles are finitely observable steps and cannot start an unbounded hidden request chain', async () => {
  const f = await fixture(), route = nativeRoute(), fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(url)).pathname === '/cross-login') return new Response('', { status: 302, headers: { location: 'https://accounts.feishu.cn/cross-login' } })
    return await route(url, init)
  }); vi.stubGlobal('fetch', fetch)
  let view = await f.sdk.call('connection.setup.begin', f.input)
  for (let count = 0; count < 16 && view.continuation?.stage !== 'unknown'; count++) {
    const calls = fetch.mock.calls.length
    view = await advance(f, view)
    expect(fetch.mock.calls.length - calls).toBeLessThanOrEqual(1)
  }
  expect(view.continuation?.stage).toBe('unknown'); expect(view.continuation?.account).toBeNull()
  expect(fetch.mock.calls.length).toBeLessThan(18)
}, 30_000)

it('only an active top-level console bootstrap supplies stable identity; display text, inert scripts and conflicting bindings stay unknown', async () => {
  const f = await fixture(), identity = JSON.stringify({ id: USER, tenantId: TENANT }), csrf = `window.csrfToken=${JSON.stringify(CSRF)};`
  const invalid = [
    `<p>window.user=${identity};${csrf}</p>`,
    `<!-- <script>window.user=${identity};${csrf}</script> -->`,
    `<script type="application/json">window.user=${identity};${csrf}</script>`,
    `<template><script>window.user=${identity};${csrf}</script></template>`,
    `<noscript><script>window.user=${identity};${csrf}</script></noscript>`,
    `<script>const text=${JSON.stringify(`window.user=${identity};`)};${csrf}</script>`,
    `<script>function later(){window.user=${identity};}${csrf}</script>`,
    `<script>if(false){window.user=${identity};}${csrf}</script>`,
    `<script>window['user']=${identity};${csrf}</script>`,
    `<script>const window={};window.user=${identity};${csrf}</script>`,
    bootstrap() + bootstrap({ id: 'conflicting-account', tenantId: TENANT }),
    bootstrap({ id: USER, userId: 'conflicting-alias', tenantId: TENANT }),
    bootstrap({ id: USER }),
    `<script>window.user=${identity};</script>`,
    `<script src="https://unqualified.invalid/bootstrap.js">window.user=${identity};${csrf}</script>`
  ]
  for (const [index, html] of invalid.entries()) {
    const fetch = vi.fn(nativeRoute({ html })); vi.stubGlobal('fetch', fetch)
    let view = await f.sdk.call('connection.setup.begin', { ...f.input, operationId: 'inactive-bootstrap-' + index })
    for (let step = 0; step < 8 && view.continuation?.stage !== 'unknown'; step++) view = await advance(f, view)
    expect(view.continuation?.stage, 'bootstrap sample ' + index).toBe('unknown')
    expect(view.continuation?.account).toBeNull()
    expect(view.continuation?.actions.map(action => action.kind)).not.toContain('confirm-account')
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/accounts/qrlogin/init', '/accounts/qrlogin/polling', '/cross-login', '/', '/app'])
  }
  const fetch = vi.fn(nativeRoute({ html: bootstrap({ user_id: USER, tenant_id: TENANT }) })); vi.stubGlobal('fetch', fetch)
  const valid = await toAccount(f, await f.sdk.call('connection.setup.begin', { ...f.input, operationId: 'stable-id-without-display-names' }))
  expect(valid.continuation?.account).toEqual({ userId: USER, tenantId: TENANT })
}, 60_000)

it('account confirmation refuses a foreign actor, invented action, changed decision and stale revision while retaining the original usable confirmation', async () => {
  const f = await fixture(), fetch = vi.fn(nativeRoute()); vi.stubGlobal('fetch', fetch)
  const account = await toAccount(f, await f.sdk.call('connection.setup.begin', f.input)), input = advanceInput(account, 'confirm-account'), calls = fetch.mock.calls.length
  const service = new AgentMuxRpcService({ connections: f.services.connections }); clean.push(() => service.dispose())
  await expect(service.call('connection.setup.advance', input, {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(service.call('connection.setup.advance', input, { principal: { kind: 'device', id: 'foreign-auth-device' } })).rejects.toMatchObject({ code: expect.stringMatching(/^(?:CONTROL_PERMISSION_DENIED|CONNECTION_SETUP_AUTHORITY_REQUIRED)$/u) })
  for (const changed of [
    { ...input, expectedRevision: input.expectedRevision - 1 },
    { ...input, decision: { ...input.decision, actionId: 'invented-confirmation' } },
    { ...input, decision: { ...input.decision, value: 'continue' as const } },
    { ...input, operationId: 'another-original-intent' }
  ]) await expect(f.sdk.call('connection.setup.advance', changed)).rejects.toMatchObject({ code: expect.any(String) })
  expect((await f.cli(['advance', '--input', '-'], { ...input, account: { userId: 'payload-user', tenantId: 'payload-tenant' } })).code).not.toBe(0)
  const unchanged = await inspect(f)
  expect(unchanged.operation).toEqual(account.operation); expect(unchanged.continuation).toEqual(account.continuation)
  expect(fetch).toHaveBeenCalledTimes(calls)
  const confirmed = await f.sdk.call('connection.setup.advance', input)
  expect(confirmed.continuation).toMatchObject({ stage: 'confirmed', account: { userId: USER, tenantId: TENANT } })
  expect((await f.sdk.call('connection.setup.advance', input)).receipt).toEqual(confirmed.receipt)
  expect(fetch).toHaveBeenCalledTimes(calls)
}, 30_000)

it('a Connection revision changed during console read preserves the original save and withholds the late identity and confirmation', async () => {
  const f = await fixture(), entered = deferred<void>(), response = deferred<Response>(), route = nativeRoute()
  clean.push(() => response.resolve(new Response(bootstrap(), { headers: { 'content-type': 'text/html' } })))
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(url)).pathname === '/app') { entered.resolve(); return await response.promise }
    return await route(url, init)
  }); vi.stubGlobal('fetch', fetch)
  let view = await f.sdk.call('connection.setup.begin', f.input)
  for (let step = 0; step < 3; step++) view = await advance(f, view)
  const input = advanceInput(view), inflight = f.sdk.call('connection.setup.advance', input)
  await Promise.race([entered.promise, inflight.then(value => { expect(value.continuation?.stage).toBe('account') })])
  const revised = await f.sdk.call('connection.configure', { operationId: 'auth-new-explicit-save', expectedRevision: 1, connection: { ...f.config, label: 'New saved bot revision' } })
  response.resolve(new Response(bootstrap(), { headers: { 'content-type': 'text/html' } }))
  const late = await inflight
  expect(late.reason).toBe('connection-revised'); expect(late.continuation?.account ?? null).toBeNull()
  expect(late.continuation?.actions ?? []).toEqual([])
  expect(late.operation).toMatchObject({ operationId: f.input.operationId, expectedConnectionRevision: 1, application: f.config.application })
  expect((await f.sdk.call('connection.inspect', { connectionId: f.input.connectionId })).connection).toEqual(revised.connection)
  expect((await f.sdk.call('connection.inspect', { operationId: 'auth-original-save' })).operation).toEqual(f.saved)
  const calls = fetch.mock.calls.length
  await expect(f.sdk.call('connection.setup.advance', input)).rejects.toMatchObject({ code: expect.any(String) })
  expect(fetch).toHaveBeenCalledTimes(calls)
}, 30_000)

it('lost secure ACK reconciles the exact original immutable snapshot and old action without a second poll', async () => {
  const f = await fixture(), fetch = vi.fn(async (url: string | URL | Request) => new URL(String(url)).pathname.endsWith('/init') ? qrResponse() : polling(2))
  vi.stubGlobal('fetch', fetch)
  const pending = await f.sdk.call('connection.setup.begin', f.input), input = advanceInput(pending), store = DesktopConnectorSecrets.prototype.store
  let lost = false
  const fault = vi.spyOn(DesktopConnectorSecrets.prototype, 'store').mockImplementation(async function(this: DesktopConnectorSecrets, value) {
    const saved = await store.call(this, value)
    if (!lost) { lost = true; throw new Error('fixture-lost-auth-vault-ack') }
    return saved
  })
  const uncertain = await f.sdk.call('connection.setup.advance', input)
  expect(fault).toHaveBeenCalledTimes(1)
  expect(uncertain.operation?.authentication).toMatchObject({ request: 'confirmed', secureStorage: 'unknown' })
  expect(uncertain.receipt).toMatchObject({ actionId: input.decision.actionId, stepId: expect.any(String) })
  const local = await inspect(f), recovery = local.continuation?.actions.find(action => action.actionId === input.decision.actionId)
  expect(recovery).toMatchObject({ actionId: input.decision.actionId, expectedRevision: input.expectedRevision })
  const recovered = await f.sdk.call('connection.setup.advance', input)
  expect(recovered.continuation).toMatchObject({ stage: 'scanned', account: null })
  expect(recovered.operation?.authentication).toMatchObject({ request: 'confirmed', secureStorage: 'stored' })
  expect(recovered.receipt?.stepId).toBe(uncertain.receipt?.stepId)
  expect(fault).toHaveBeenCalledTimes(1)
  expect(fetch).toHaveBeenCalledTimes(2)
  await f.close(); await f.reopen()
  expect((await inspect(f)).continuation).toEqual(recovered.continuation)
  expect((await f.sdk.call('connection.setup.advance', input)).receipt).toEqual(recovered.receipt)
  expect(fetch).toHaveBeenCalledTimes(2)
}, 30_000)

it('expired-code renewal creates a new auth attempt within the original intent while preserving old init, action receipts and encrypted snapshots', async () => {
  const f = await fixture(); let inits = 0
  const fetch = vi.fn(async (url: string | URL | Request) => new URL(String(url)).pathname.endsWith('/init') ? qrResponse(++inits === 1 ? TOKEN : 'fixture-renewed-token') : polling(5))
  vi.stubGlobal('fetch', fetch)
  const pending = await f.sdk.call('connection.setup.begin', f.input), input = advanceInput(pending), oldRows = privateRows(f.services.database!)
  const expired = await f.sdk.call('connection.setup.advance', input)
  expect(expired.continuation).toMatchObject({ stage: 'expired', account: null })
  expect(expired.challenge).toBeNull()
  const renewal = advanceInput(expired, 'renew'), renewed = await f.sdk.call('connection.setup.advance', renewal)
  expect(renewed.operation).toMatchObject({ operationId: f.input.operationId, connectionId: f.input.connectionId, request: pending.operation!.request })
  expect(renewed.operation?.authentication?.attemptId).not.toBe(expired.operation?.authentication?.attemptId)
  expect(renewed.continuation).toMatchObject({ stage: 'waiting', account: null })
  expect(renewed.challenge?.qrPayload).toBe(JSON.stringify({ qrlogin: { token: 'fixture-renewed-token' } }))
  expect((await f.sdk.call('connection.setup.advance', input)).receipt).toEqual(expired.receipt)
  expect((await f.sdk.call('connection.setup.advance', renewal)).receipt).toEqual(renewed.receipt)
  expect((await inspect(f)).continuation).toEqual(renewed.continuation)
  expect(fetch).toHaveBeenCalledTimes(3)
  const rows = privateRows(f.services.database!)
  for (const old of oldRows) expect(rows.find(row => row.operationId === old.operationId)?.bytes).toEqual(old.bytes)
  const decrypted = rows.map(row => f.encryption.decryptString(row.bytes))
  expect(decrypted.length).toBeGreaterThan(oldRows.length)
  expect(decrypted.some(value => value.includes(TOKEN))).toBe(true)
  expect(decrypted.some(value => value.includes('fixture-renewed-token'))).toBe(true)
  expect((await f.sdk.call('connection.inspect', { operationId: 'auth-original-save' })).operation).toEqual(f.saved)
}, 30_000)

it('a lost poll response remains the same unknown action after reopen and neither inspect nor duplicate advance replays it', async () => {
  const f = await fixture(), detail = 'fixture-private-lost-poll-detail'
  const fetch = vi.fn(async (url: string | URL | Request) => { if (new URL(String(url)).pathname.endsWith('/init')) return qrResponse(); throw new TypeError(detail) })
  vi.stubGlobal('fetch', fetch)
  const pending = await f.sdk.call('connection.setup.begin', f.input), input = advanceInput(pending)
  const unknown = await f.sdk.call('connection.setup.advance', input)
  expect(unknown.continuation).toMatchObject({ stage: 'unknown', account: null })
  expect(unknown.receipt).toMatchObject({ actionId: input.decision.actionId, stepId: expect.any(String), state: 'unknown' })
  expect(JSON.stringify(unknown)).not.toContain(detail)
  await f.close(); await f.reopen()
  const observed = await inspect(f)
  expect(observed.operation?.authentication).toEqual(unknown.operation?.authentication)
  expect((await f.sdk.call('connection.setup.advance', input)).receipt).toEqual(unknown.receipt)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect((await f.sdk.call('connection.inspect', { operationId: 'auth-original-save' })).operation).toEqual(f.saved)
}, 30_000)

it.each(['throw new Error("fixture-before-bootstrap");', 'for (;;) {}'] as const)('unreachable console bootstrap after %s cannot supply an account', async prefix => {
  const f = await fixture(), html = `<script>${prefix}window.csrfToken=${JSON.stringify(CSRF)};window.user=${JSON.stringify({ id: USER, tenantId: TENANT })};</script>`
  const fetch = vi.fn(nativeRoute({ html })); vi.stubGlobal('fetch', fetch)
  let view = await f.sdk.call('connection.setup.begin', f.input)
  for (let step = 0; step < 8 && !['account', 'unknown'].includes(view.continuation!.stage); step++) view = await advance(f, view)
  expect(view.continuation).toMatchObject({ stage: 'unknown', account: null })
  expect(view.continuation?.actions.map(action => action.kind)).not.toContain('confirm-account')
  expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/accounts/qrlogin/init', '/accounts/qrlogin/polling', '/cross-login', '/', '/app'])
}, 30_000)

it.each(['https://open.feishu.cn/unqualified-bootstrap', 'https://open.feishu.cn/app?source=unqualified'] as const)('console redirects cannot promote an unsourced page %s to identity', async target => {
  const f = await fixture(), route = nativeRoute()
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === 'https://open.feishu.cn/app') return new Response('', { status: 302, headers: { location: target } })
    if (String(url) === target) return new Response(bootstrap(), { headers: { 'content-type': 'text/html' } })
    return await route(url, init)
  }); vi.stubGlobal('fetch', fetch)
  let view = await f.sdk.call('connection.setup.begin', f.input)
  for (let step = 0; step < 8 && !['account', 'unknown'].includes(view.continuation!.stage); step++) view = await advance(f, view)
  expect(fetch.mock.calls.map(([url]) => String(url))).not.toContain(target)
  expect(view.continuation).toMatchObject({ stage: 'unknown', account: null })
  expect(view.continuation?.actions.map(action => action.kind)).not.toContain('confirm-account')
}, 30_000)

it('parallel local Vault recovery on a fresh owner returns the same stored action after its original durable ACK was delayed', async () => {
  const f = await fixture(), committed = deferred<void>(), release = deferred<void>(), inspected = deferred<void>()
  clean.push(() => release.resolve())
  const fetch = vi.fn(async (url: string | URL | Request) => new URL(String(url)).pathname.endsWith('/init') ? qrResponse() : polling(2))
  vi.stubGlobal('fetch', fetch)
  const pending = await f.sdk.call('connection.setup.begin', f.input), input = advanceInput(pending)
  const store = DesktopConnectorSecrets.prototype.store, originalInspect = DesktopConnectorSecrets.prototype.inspect
  let privateOperation = '', reads = 0
  const fault = vi.spyOn(DesktopConnectorSecrets.prototype, 'store').mockImplementation(async function(this: DesktopConnectorSecrets, value) {
    const saved = await store.call(this, value)
    if (!privateOperation) { privateOperation = value.operationId; committed.resolve(); await release.promise }
    return saved
  })
  const original = f.sdk.call('connection.setup.advance', input).then(value => ({ status: 'fulfilled' as const, value }), reason => ({ status: 'rejected' as const, reason }))
  await committed.promise
  const recoveredServices = await createDesktopConnections({ directory: f.directory, encryption: f.encryption })
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'fresh-recovery.sock'), connections: recoveredServices.connections, coreClients: () => { throw new Error('Local secure recovery cannot borrow an Agent Runtime') } })
  await server.start()
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'fresh-recovery.sock') } })
  clean.push(async () => { await sdk.dispose(); await server.stop(); recoveredServices.close() })
  const before = await sdk.call('connection.setup.inspect', { operationId: f.input.operationId })
  expect(before.operation?.authentication).toMatchObject({ request: 'confirmed', secureStorage: 'storing' })
  const receiptBarrier = vi.spyOn(DesktopConnectorSecrets.prototype, 'inspect').mockImplementation(async function(this: DesktopConnectorSecrets, operationId) {
    const value = await originalInspect.call(this, operationId)
    if (operationId === privateOperation && ++reads <= 2) { if (reads === 2) inspected.resolve(); await inspected.promise }
    return value
  })
  try {
    const recoveries = await Promise.allSettled([sdk.call('connection.setup.advance', input), sdk.call('connection.setup.advance', input)])
    expect(reads).toBe(2)
    expect(recoveries.map(value => value.status)).toEqual(['fulfilled', 'fulfilled'])
    for (const recovered of recoveries) {
      expect(recovered.status).toBe('fulfilled')
      if (recovered.status !== 'fulfilled') throw recovered.reason
      expect(recovered.value.operation?.authentication).toMatchObject({ request: 'confirmed', secureStorage: 'stored' })
      expect(recovered.value.continuation).toMatchObject({ stage: 'scanned', account: null })
      expect(recovered.value.receipt).toMatchObject({ actionId: input.decision.actionId, stepId: before.operation!.authentication!.stepId, state: 'confirmed' })
    }
    expect(fault).toHaveBeenCalledTimes(1); expect(receiptBarrier).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenCalledTimes(2)
  } finally { release.resolve(); await original }
  const finished = await original
  expect(finished.status).toBe('fulfilled')
  expect((await sdk.call('connection.setup.inspect', { operationId: f.input.operationId })).operation?.authentication).toMatchObject({ request: 'confirmed', secureStorage: 'stored' })
  expect(fetch).toHaveBeenCalledTimes(2)
}, 30_000)

function syntheticInitializer(user: object): string {
  const fields: Array<[string, unknown]> = [
    ['nonce', 'fixture-native-nonce'], ['user', user], ['features', ['fixture-feature']], ['csrfToken', CSRF],
    ['unit', 'fixture-unit'], ['unitType', 0], ['isOversea', false],
    ['env', { unit: 'fixture-unit', unitType: 0, isOversea: false }],
    ['outDomain', { larkOpen: 'https://metadata-synthetic.invalid', appStore: 'https://metadata-synthetic.invalid', suiteAdmin: 'https://metadata-synthetic.invalid', passportOrigin: 'https://metadata-synthetic.invalid', larkApiDomain: 'https://metadata-synthetic.invalid', internalApiDomain: 'https://metadata-synthetic.invalid' }],
    ['resource', { commonStaticCDN: 'https://assets-synthetic.invalid', resourceUrl: 'https://assets-synthetic.invalid', domain: 'https://assets-synthetic.invalid' }],
    ['domainBrand', 'fixture-brand'], ['seoType', 'fixture-seo']
  ]
  return fields.map(([key, value]) => `window.${key}=${JSON.stringify(value)};`).join('')
}

it('native literal IIFE encoding reaches exact account confirmation through compiled CLI and default owner without using metadata as authority', async () => {
  const f = await fixture(), before = await f.sdk.call('connection.inspect', { connectionId: f.input.connectionId })
  const examples = [
    `<script>(function(){${syntheticInitializer({ id: USER, tenantId: TENANT, name: 'Fixture IIFE account', tenantName: 'Fixture IIFE enterprise' })}})();</script>`,
    `<script>(function(){;window.user=${JSON.stringify({ user_id: USER, tenant_id: TENANT })};window.csrfToken=${JSON.stringify(CSRF)};;})();</script>`,
    bootstrap({ userId: USER, tenant_id: TENANT }),
    `<script>window.user=${JSON.stringify({ id: USER, tenantId: TENANT })};window.csrfToken='${CSRF}';</script>`
  ]
  for (const [index, html] of examples.entries()) {
    const fetch = vi.fn(nativeRoute({ html })); vi.stubGlobal('fetch', fetch)
    const input = { ...f.input, operationId: 'native-encoding-account-' + index }
    const account = await toAccount(f, result(await f.cli(['begin', '--input', '-'], input)))
    expect(account.continuation?.account).toEqual(index === 0 ? { userId: USER, tenantId: TENANT, userName: 'Fixture IIFE account', tenantName: 'Fixture IIFE enterprise' } : { userId: USER, tenantId: TENANT })
    const confirmed = result(await f.cli(['advance', '--input', '-'], advanceInput(account, 'confirm-account')))
    expect(confirmed.continuation).toMatchObject({ stage: 'confirmed', account: { userId: USER, tenantId: TENANT } })
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(['https://accounts.feishu.cn/accounts/qrlogin/init', 'https://accounts.feishu.cn/accounts/qrlogin/polling', 'https://accounts.feishu.cn/cross-login', 'https://ask.feishu.cn/', 'https://open.feishu.cn/app'])
    expect(JSON.stringify(confirmed.operation)).not.toContain(USER); expect(JSON.stringify(confirmed.operation)).not.toContain(TENANT)
  }
  expect(await f.sdk.call('connection.inspect', { connectionId: f.input.connectionId })).toEqual(before)
  expect((await f.sdk.call('connection.inspect', { operationId: 'auth-original-save' })).operation).toEqual(f.saved)
}, 45_000)

it('anonymous native shape and unqualified IIFE programs remain unknown without executing code or granting a confirmation', async () => {
  const f = await fixture(), identity = JSON.stringify({ id: USER, tenantId: TENANT })
  const body = `window.user=${identity};window.csrfToken=${JSON.stringify(CSRF)};`
  const wrap = (source: string) => `<script>(function(){${source}})();</script>`
  const anonymous = syntheticInitializer({}), full = syntheticInitializer({ id: USER, tenantId: TENANT })
  const invalid = [
    wrap(anonymous),
    `<script>function notInvoked(){${body}}</script>`,
    `<script>(function(unused){${body}})();</script>`,
    `<script>(function(){${body}})(null);</script>`,
    `<script>(function named(){${body}})();</script>`,
    `<script>(()=>{${body}})();</script>`,
    `<script>(async function(){${body}})();</script>`,
    `<script>(function*(){${body}})();</script>`,
    `<script>(function(){${body}}).call(window);</script>`,
    `<script>(function(){${body}}).apply(window,[]);</script>`,
    `<script>(function(){${body}})();window.extra=true;</script>`,
    wrap(`true;${body}`),
    wrap(`unexpectedCall();${body}`),
    wrap(`const unused=1;${body}`),
    wrap(`if(true){${body}}`),
    wrap(`throw new Error("fixture-initializer-throw");${body}`),
    wrap(`for(;;){}${body}`),
    wrap(`return;${body}`),
    wrap(`${full}window.unobservedMetadata=true;`),
    wrap(`window["user"]=${identity};window.csrfToken=${JSON.stringify(CSRF)};`),
    wrap(`const alias=window;alias.user=${identity};window.csrfToken=${JSON.stringify(CSRF)};`),
    `<script>(function(window){${body}})();</script>`,
    wrap(`const window={};${body}`),
    wrap(`${body}window.user=${identity};`),
    wrap(`${body}window.csrfToken=${JSON.stringify(CSRF)};`),
    wrap(`${full}window.nonce="fixture-native-nonce";`),
    wrap(`window.user={"id":"fixture-first-id","id":${JSON.stringify(USER)},"tenantId":${JSON.stringify(TENANT)}};window.csrfToken=${JSON.stringify(CSRF)};`),
    wrap(`${body}window.env={"unit":"fixture-first-unit","unit":"fixture-second-unit"};`),
    wrap(`${body}window.features=undefined;`),
    wrap(`${body}window.unit=NaN;`),
    wrap(`${body}window.features=[...[]];`),
    wrap(`${body}window.env={"value":unexpectedCall()};`),
    wrap(`${body}window.env={get unit(){return "fixture"}};`),
    wrap(`window.user=${identity};`),
    wrap(`window.user=${identity};window.csrfToken=0;`),
    wrap(full) + wrap(syntheticInitializer({ id: 'fixture-conflicting-user', tenantId: TENANT })),
    `<script>var window={};(function(){${body}})();</script>`,
    `<script>const text=${JSON.stringify(`(function(){${body}})()`)};</script>`,
    `<script type="application/json">(function(){${body}})();</script>`,
    `<template>${wrap(full)}</template>`
  ]
  for (const [index, html] of invalid.entries()) {
    const fetch = vi.fn(nativeRoute({ html })); vi.stubGlobal('fetch', fetch)
    let view = await f.sdk.call('connection.setup.begin', { ...f.input, operationId: 'unqualified-native-initializer-' + index })
    for (let step = 0; step < 8 && !['account', 'unknown'].includes(view.continuation!.stage); step++) view = await advance(f, view)
    expect(view.continuation, 'initializer sample ' + index).toMatchObject({ stage: 'unknown', account: null })
    expect(view.continuation?.actions.map(action => action.kind)).not.toContain('confirm-account')
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(['https://accounts.feishu.cn/accounts/qrlogin/init', 'https://accounts.feishu.cn/accounts/qrlogin/polling', 'https://accounts.feishu.cn/cross-login', 'https://ask.feishu.cn/', 'https://open.feishu.cn/app'])
  }
  expect((await f.sdk.call('connection.inspect', { operationId: 'auth-original-save' })).operation).toEqual(f.saved)
}, 60_000)

function childMessage(child: ChildProcess, kind: string, path?: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (value: unknown) => {
      if (value && typeof value === 'object' && (value as { kind?: string }).kind === kind && (path === undefined || (value as { path?: string }).path === path)) {
        child.off('message', onMessage); child.off('exit', onExit); resolve(value as Record<string, unknown>)
      }
    }
    const onExit = () => { child.off('message', onMessage); reject(new Error('Authentication fixture exited before ' + kind)) }
    child.on('message', onMessage); child.once('exit', onExit)
  })
}
it.each(['account', 'unknown'] as const)('a real owner process restart preserves the same %s authentication and frozen action without replaying a native request', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'setup-auth-child-')); clean.push(() => rm(root, { recursive: true, force: true }))
  const socketPath = join(root, 'owner.sock')
  const start = async (fault: string) => {
    const child = fork(new URL('./fixtures/connection-setup-auth-owner.mjs', import.meta.url), [root, fault], { execArgv: ['--experimental-transform-types'], env: objectCliEnvironment(root), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    clean.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit') } })
    let errors = ''; child.stderr!.on('data', value => { errors += value })
    const ready = await childMessage(child, 'ready').catch(error => { throw new Error(errors || String(error)) })
    return { child, ready }
  }
  const first = await start(mode === 'account' ? 'respond' : 'inflight-poll')
  const cli = (args: string[], body?: unknown) => runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', ...args], objectCliEnvironment(root), body === undefined ? '' : JSON.stringify(body))
  const config: ConnectionConfig = { connectionId: 'auth-saved-bot', adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: 'cli_auth_saved_bot' }, label: 'Original saved bot', enabled: false, credentialRef: String(first.ready.credentialRef) }
  const saved = result(await cli(['configure', '--input', '-'], { operationId: 'auth-child-save', expectedRevision: null, connection: config }))
  const input: ConnectionSetupBegin = { operationId: 'auth-child-management', connectionId: config.connectionId, expectedConnectionRevision: 1, goal }
  let view = result(await cli(['setup', 'begin', '--input', '-'], input)), originalAction = advanceInput(view)
  let inflight: Promise<CliResult> | undefined
  if (mode === 'account') {
    for (let step = 0; step < 8 && view.continuation?.stage !== 'account'; step++) view = result(await cli(['setup', 'advance', '--input', '-'], advanceInput(view)))
    expect(view.continuation).toMatchObject({ stage: 'account', account: { userId: USER, tenantId: TENANT } })
    originalAction = advanceInput(view, 'confirm-account')
  } else {
    const entered = childMessage(first.child, 'request-started', '/accounts/qrlogin/polling')
    inflight = cli(['setup', 'advance', '--input', '-'], originalAction)
    await Promise.race([entered, inflight.then(output => { expect(result(output).receipt?.state).toBe('dispatching') })])
    view = result(await cli(['setup', 'inspect', '--operation-id', input.operationId]))
    expect(view.operation?.authentication?.request).toBe('dispatching')
  }
  const attempt = view.operation!.authentication!.attemptId, step = view.operation!.authentication!.stepId
  first.child.kill('SIGKILL'); await once(first.child, 'exit')
  if (inflight) expect((await inflight).code).not.toBe(0)
  await start('observe-only')
  const recovered = result(await cli(['setup', 'inspect', '--operation-id', input.operationId]))
  expect(recovered.operation?.authentication).toMatchObject({ attemptId: attempt, stepId: step })
  const replay = result(await cli(['setup', 'advance', '--input', '-'], originalAction))
  if (mode === 'account') {
    expect(recovered.continuation).toEqual(view.continuation)
    expect(replay.continuation).toMatchObject({ stage: 'confirmed', account: { userId: USER, tenantId: TENANT } })
    expect(replay.receipt).toMatchObject({ actionId: originalAction.decision.actionId, state: 'confirmed' })
  } else {
    expect(recovered.continuation).toMatchObject({ stage: 'unknown', account: null })
    expect(recovered.operation?.authentication?.request).toBe('unknown')
    expect(replay.receipt).toMatchObject({ actionId: originalAction.decision.actionId, stepId: step, state: 'unknown' })
  }
  expect(result<{ operations: unknown[] }>(await cli(['setup', 'ls', '--connection', input.connectionId])).operations).toEqual([replay.operation])
  expect(JSON.stringify(replay.operation)).not.toContain(USER); expect(JSON.stringify(replay.operation)).not.toContain(TENANT)
  expect(result<{ connection: unknown }>(await cli(['inspect', '--connection', input.connectionId])).connection).toMatchObject({ config, revision: 1 })
  expect(result<{ operation: unknown }>(await cli(['inspect', '--operation-id', 'auth-child-save'])).operation).toEqual(saved)
  const effects = (await readFile(join(root, 'native-effects.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(effects.map(value => value.path)).toEqual(mode === 'account' ? ['/accounts/qrlogin/init', '/accounts/qrlogin/polling', '/cross-login', '/', '/app'] : ['/accounts/qrlogin/init', '/accounts/qrlogin/polling'])
}, 60_000)
