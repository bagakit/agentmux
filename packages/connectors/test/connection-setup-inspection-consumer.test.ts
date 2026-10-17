import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { CookieJar } from 'tough-cookie'
import { DesktopConnectorSecrets } from '../../../apps/desktop/src/main/connector-secrets.js'
import { AgentMuxControlServer, AgentMuxRpcService, connectAgentMuxRpc } from '@agentmux/core'
import { CONNECTION_SETUP_READ_ACTIONS } from '@agentmux/core/connections'
import type { ConnectionConfig, ConnectionSetupAction, ConnectionSetupAdvance, ConnectionSetupBegin, ConnectionSetupInspectionReceipt, ConnectionSetupView } from '@agentmux/core/connections'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { enrollmentEncryption } from './fixtures/connection-enrollment.js'
import { objectCliEnvironment, runCompiledObjectCli, type CliResult } from '../../core/test/helpers/object-cli-rpc.js'

const SECRET = 'fixture-inspection-saved-secret', TOKEN = 'fixture-inspection-token', FLOW = 'fixture-inspection-flow'
const SESSION = 'fixture-inspection-session', READ_COOKIE = 'fixture-private-read-cookie', DETAIL = 'fixture-private-role-description'
const accounts = [
  { user: 'fixture-inspection-user-a', tenant: 'fixture-inspection-tenant-a', csrf: 'fixture-inspection-csrf-a' },
  { user: 'fixture-inspection-user-b', tenant: 'fixture-inspection-tenant-b', csrf: 'fixture-inspection-csrf-b' }
]
const goal = { kind: 'agent-conversation', interaction: 'messages' } as const
const clean: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const close of clean.splice(0).reverse()) await close() })
function result<T = ConnectionSetupView>(output: CliResult): T { expect(output.code, output.stdout + output.stderr).toBe(0); return JSON.parse(output.stdout).result }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function inputFor(view: ConnectionSetupView, kind: ConnectionSetupAction['kind']): ConnectionSetupAdvance {
  expect(view.operation).not.toBeNull()
  const actions = kind === 'inspect-application' || kind === 'recover-application-inspection' ? view.applicationInspection?.actions : view.continuation?.actions
  const found = actions?.filter(action => action.kind === kind) ?? []
  expect(found, `Expected one ${kind} action`).toHaveLength(1)
  expect(found[0]).toMatchObject({ actionId: expect.any(String), expectedRevision: expect.any(Number) })
  return { operationId: view.operation!.operationId, expectedRevision: found[0].expectedRevision, decision: { actionId: found[0].actionId, value: kind === 'confirm-account' ? 'confirm' : kind === 'renew' ? 'renew' : 'continue' } }
}
function selected(view: ConnectionSetupView): ConnectionSetupInspectionReceipt {
  expect(view.applicationInspection?.selected).not.toBeNull(); expect(view.applicationInspection?.selected).toBeDefined()
  return view.applicationInspection!.selected!
}
function assertSafe(value: unknown) {
  const text = JSON.stringify(value)
  for (const privateValue of [SECRET, TOKEN, FLOW, SESSION, READ_COOKIE, DETAIL, 'app.info', ...accounts.flatMap(a => [a.user, a.tenant, a.csrf])]) expect(text).not.toContain(privateValue)
  for (const privateKey of ['roleType', 'readResource', 'writeResource', 'privateRef', 'credentialRef', 'csrfToken']) expect(text).not.toContain('"' + privateKey + '"')
}
function permission(read = true, write = false) {
  return Response.json({ code: 0, data: { roleType: 4, permission: { 1: { readResource: { 'app.info': true }, writeResource: {} }, 4: {
    // The pinned client tests own-key presence, not this resource's value or another role.
    readResource: read ? { 'app.info': false } : {}, writeResource: write ? { 'app.info': { description: DETAIL } } : {}
  } }, appExtKeys: [DETAIL] } })
}
function nativeRoute(observe: (url: URL, init: RequestInit) => Promise<Response> = async () => permission()) {
  let accountIndex = 0
  const route = async (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const target = new URL(String(url))
    expect(init.redirect).toBe('manual')
    if (target.origin === 'https://accounts.feishu.cn' && target.pathname === '/accounts/qrlogin/init') return Response.json({ code: 0, data: { step_info: { token: TOKEN } } }, { headers: [
      ['x-flow-key', FLOW], ['set-cookie', `session=${SESSION}; Domain=.feishu.cn; Path=/; Secure; HttpOnly`],
      ['set-cookie', 'pollOnly=fixture-poll-only; Path=/accounts/qrlogin; Secure']
    ] })
    if (target.origin === 'https://accounts.feishu.cn' && target.pathname === '/accounts/qrlogin/polling') return Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross-login' } } })
    if (target.href === 'https://accounts.feishu.cn/cross-login') return new Response('', { status: 302, headers: { location: 'https://ask.feishu.cn/' } })
    if (target.href === 'https://ask.feishu.cn/') return new Response('Landing is not identity', { headers: { 'set-cookie': 'askOnly=fixture-ask-only; Path=/; Secure' } })
    if (target.href === 'https://open.feishu.cn/app') {
      const a = accounts[accountIndex]
      return new Response(`<script>window.csrfToken=${JSON.stringify(a.csrf)};window.user=${JSON.stringify({ id: a.user, tenantId: a.tenant })};</script>`, { headers: [
        ['content-type', 'text/html'], ['set-cookie', `readScope=${READ_COOKIE}; Path=/developers/v1/app_role; Secure; HttpOnly`],
        ['set-cookie', 'unrelated=fixture-unrelated; Path=/another-resource; Secure'], ['set-cookie', 'expired=fixture-expired; Path=/; Max-Age=0; Secure']
      ] })
    }
    if (target.pathname.startsWith('/developers/v1/app_role/permission/')) return await observe(target, init)
    throw new Error('Unexpected inspection request ' + target.origin + target.pathname)
  }
  return { route, account: (index: number) => { accountIndex = index } }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'setup-inspection-')), directory = join(root, 'connections'), socketPath = join(root, 'owner.sock'), encryption = enrollmentEncryption()
  let services: Awaited<ReturnType<typeof createDesktopConnections>>, server: AgentMuxControlServer, sdk: Awaited<ReturnType<typeof connectAgentMuxRpc>>
  const open = async (missingAdapter = false) => {
    services = await createDesktopConnections({ directory, encryption, ...(missingAdapter ? { adapters: [] } : {}) })
    server = new AgentMuxControlServer({ socketPath, connections: services.connections, coreClients: () => { throw new Error('Application inspection cannot borrow an Agent Runtime') } })
    await server.start(); sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  }
  const close = async () => { await sdk?.dispose(); await server?.stop(); services?.close() }
  clean.push(async () => { await close(); await rm(root, { recursive: true, force: true }) })
  await open()
  const credential = await services.secrets.store({ operationId: 'inspection-credential', secret: SECRET })
  const config: ConnectionConfig = { connectionId: 'inspection-saved-bot', adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: 'cli_inspection_original_bot' }, label: 'Original inspection bot', enabled: false, credentialRef: credential.credentialRef }
  const saved = await sdk.call('connection.configure', { operationId: 'inspection-original-save', expectedRevision: null, connection: config })
  const input: ConnectionSetupBegin = { operationId: 'inspection-original-management', connectionId: config.connectionId, expectedConnectionRevision: saved.connection.revision, goal }
  const cli = (args: string[], body?: unknown, endpoint = socketPath) => runCompiledObjectCli(['--endpoint', 'unix:' + endpoint, 'connection', ...args], objectCliEnvironment(root), body === undefined ? '' : JSON.stringify(body))
  return { root, directory, socketPath, encryption, config, saved, input, cli, close, reopen: open, get sdk() { return sdk }, get services() { return services } }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
const inspect = (f: Fixture, selection: { selectedStepId?: string; cursor?: string; limit?: number } = {}) => f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationInspection: selection })
async function authenticate(f: Fixture, view?: ConnectionSetupView) {
  view ??= result(await f.cli(['setup', 'begin', '--input', '-'], f.input))
  for (let step = 0; step < 8 && view.continuation?.stage !== 'account'; step++) view = await f.sdk.call('connection.setup.advance', inputFor(view, 'continue'))
  expect(view.continuation?.stage).toBe('account')
  return view
}
async function confirmed(f: Fixture, view?: ConnectionSetupView) {
  const account = await authenticate(f, view)
  const value = result(await f.cli(['setup', 'advance', '--input', '-'], inputFor(account, 'confirm-account')))
  expect(value.continuation?.stage).toBe('confirmed')
  return value
}
function changes(f: Fixture) { return f.services.database!.prepare('SELECT total_changes() AS count').get() }

it('compiled CLI and SDK explicitly inspect the exact saved application after account confirmation without configuring it or exposing native permission data', async () => {
  const f = await fixture(), claims: ConnectionSetupInspectionReceipt[] = []
  const native = nativeRoute(async (target, init) => {
    expect(target.href).toBe('https://open.feishu.cn/developers/v1/app_role/permission/' + f.config.application.appId)
    expect(init.method).toBe('POST'); expect(JSON.parse(String(init.body))).toEqual({})
    const headers = new Headers(init.headers)
    expect(headers.get('content-type')).toMatch(/^application\/json\b/u); expect(headers.get('x-csrf-token')).toBe(accounts[0].csrf)
    expect(headers.get('x-flow-key')).toBeNull(); expect(headers.get('X-AppPlatform-RequestFrom')).toBeNull()
    expect((headers.get('cookie') ?? '').split(';').map(v => v.trim()).sort()).toEqual([`readScope=${READ_COOKIE}`, `session=${SESSION}`].sort())
    const claimed = selected(await inspect(f)); expect(claimed.request).toBe('dispatching'); claims.push(claimed)
    return permission()
  })
  const fetch = vi.fn(native.route); vi.stubGlobal('fetch', fetch)
  const off = await f.sdk.call('connection.service.configure', { operationId: 'inspection-traffic-off', expectedRevision: 0, service: { enabled: false } })
  const before = await f.sdk.call('connection.inspect', { connectionId: f.input.connectionId }), account = await authenticate(f)
  expect((await inspect(f)).applicationInspection?.actions).toEqual([])
  await confirmed(f, account)
  expect((await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId })).applicationInspection).toBeUndefined()
  const initial = result(await f.cli(['setup', 'inspect', '--operation-id', f.input.operationId, '--application-inspection']))
  expect(initial.applicationInspection).toMatchObject({ observations: [], selected: null, next: null, applicationInfoReadPermission: 'unknown' })
  const input = inputFor(initial, 'inspect-application'), count = fetch.mock.calls.length
  const observed = result(await f.cli(['setup', 'advance', '--input', '-'], input))
  const request = fetch.mock.calls.filter(([url]) => new URL(String(url)).pathname.startsWith('/developers/'))
  expect(request).toHaveLength(1)
  expect(new Headers(request[0][1]?.headers).get('x-timezone-offset')).toBe(String(new Date().getTimezoneOffset()))
  expect(claims).toHaveLength(1); expect(claims[0].input).toEqual(input)
  expect(observed.applicationInspection?.applicationInfoReadPermission).toBe('confirmed')
  expect(selected(observed)).toMatchObject({ input, request: 'confirmed', secureStorage: 'stored' })
  expect((await f.sdk.call('connection.setup.advance', input)).applicationInspection?.selected).toEqual(selected(observed))
  expect(fetch.mock.calls.length - count).toBe(1)
  assertSafe(observed.applicationInspection)
  const list = await f.sdk.call('connection.setup.ls', { connectionId: f.input.connectionId }); assertSafe(list)
  expect(JSON.stringify(list)).not.toContain(selected(observed).stepId)
  expect(await f.sdk.call('connection.inspect', { connectionId: f.input.connectionId })).toEqual(before)
  expect((await f.sdk.call('connection.inspect', { operationId: 'inspection-original-save' })).operation).toEqual(f.saved)
  expect(await f.sdk.call('connection.service.get', {})).toEqual(off.service)
  f.services.database!.exec('PRAGMA wal_checkpoint(FULL)')
  const bytes = [await readFile(join(f.directory, 'connections.sqlite'))]
  try { bytes.push(await readFile(join(f.directory, 'connections.sqlite-wal'))) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  for (const value of [SECRET, TOKEN, FLOW, SESSION, READ_COOKIE, DETAIL, 'app.info', ...accounts.flatMap(a => [a.user, a.tenant, a.csrf])]) expect(Buffer.concat(bytes).includes(Buffer.from(value))).toBe(false)
  const calls = fetch.mock.calls.length
  await f.close(); await f.reopen(true)
  const withoutAdapter = await inspect(f, { selectedStepId: selected(observed).stepId })
  expect(withoutAdapter.applicationInspection?.applicationInfoReadPermission).toBe('confirmed')
  expect(withoutAdapter.applicationInspection?.actions).toEqual([])
  expect(fetch).toHaveBeenCalledTimes(calls)
}, 45_000)

it('CLI selector pagination reads bounded original children and can select an older child outside the page without a request or ACK write', async () => {
  const f = await fixture(), fetch = vi.fn(nativeRoute().route); vi.stubGlobal('fetch', fetch)
  await confirmed(f)
  const originals: ConnectionSetupInspectionReceipt[] = []
  for (let index = 0; index < 3; index++) originals.push(selected(await f.sdk.call('connection.setup.advance', inputFor(await inspect(f), 'inspect-application'))))
  expect(new Set(originals.map(row => row.stepId)).size).toBe(3)
  const before = changes(f), calls = fetch.mock.calls.length, store = vi.spyOn(DesktopConnectorSecrets.prototype, 'store')
  const first = result(await f.cli(['setup', 'inspect', '--operation-id', f.input.operationId, '--application-inspection', '--inspection-limit', '1']))
  expect(first.applicationInspection?.observations).toEqual([originals[2]]); expect(first.applicationInspection?.next).toEqual(expect.any(String))
  const second = await inspect(f, { cursor: first.applicationInspection!.next!, limit: 1 })
  expect(second.applicationInspection?.observations).toEqual([originals[1]]); expect(second.applicationInspection?.next).toEqual(expect.any(String))
  const last = result(await f.cli(['setup', 'inspect', '--operation-id', f.input.operationId, '--application-inspection', '--inspection-cursor', second.applicationInspection!.next!, '--inspection-limit', '1']))
  expect(last.applicationInspection?.observations).toEqual([originals[0]]); expect(last.applicationInspection?.next).toBeNull()
  const outside = result(await f.cli(['setup', 'inspect', '--operation-id', f.input.operationId, '--application-inspection', '--inspection-limit', '1', '--inspection-step', originals[0].stepId]))
  expect(outside.applicationInspection?.observations).toEqual([originals[2]]); expect(outside.applicationInspection?.selected).toEqual(originals[0])
  expect((await inspect(f)).applicationInspection?.selected).toEqual(originals[2])
  expect(changes(f)).toEqual(before); expect(store).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(calls)
  assertSafe([first.applicationInspection, second.applicationInspection, last.applicationInspection, outside.applicationInspection])
}, 45_000)

it('only the selected numeric role own resource key confirms read permission; malformed, lost and redirect observations remain independent unknowns', async () => {
  const f = await fixture(); let response = async () => permission()
  const fetch = vi.fn(nativeRoute(async () => await response()).route); vi.stubGlobal('fetch', fetch)
  await confirmed(f)
  const samples = [
    async () => permission(false),
    async () => Response.json({ code: 0, data: { roleType: 'Owner', permission: { Owner: { readResource: { 'app.info': true }, writeResource: {} } } } }),
    async () => Response.json({ code: 0, data: { roleType: 4, permission: { 1: { readResource: { 'app.info': true }, writeResource: {} } } } }),
    async () => Response.json({ code: 0, data: { roleType: 4, permission: { 4: { readResource: ['app.info'], writeResource: {} } } } }),
    async () => new Response('{"code":0,"data":{"roleType":4,"permission":{"4":{"readResource":{"__proto__":{"app.info":true}},"writeResource":{}}}}}', { headers: { 'content-type': 'application/json' } }),
    async () => Response.json({ code: '0', data: { roleType: 4, permission: { 4: { readResource: { 'app.info': true }, writeResource: {} } } } }),
    async () => Response.json({ code: 0, data: { roleType: 4 } }, { status: 503 }),
    async () => new Response(DETAIL + ' Owner read.app.info'),
    async () => new Response(null, { status: 302, headers: { location: 'https://open.feishu.cn/app' } }),
    async () => { throw new TypeError(DETAIL) }
  ]
  for (const [index, sample] of samples.entries()) {
    response = sample
    const input = inputFor(await inspect(f), 'inspect-application'), count = fetch.mock.calls.length
    const unknown = await f.sdk.call('connection.setup.advance', input), original = selected(unknown)
    expect(unknown.applicationInspection?.applicationInfoReadPermission, 'sample ' + index).toBe('unknown')
    expect(original.input).toEqual(input); expect(original.stepId).toEqual(expect.any(String)); assertSafe(unknown.applicationInspection)
    expect((await f.sdk.call('connection.setup.advance', input)).applicationInspection?.selected).toEqual(original)
    expect(fetch.mock.calls.length - count).toBe(1)
  }
  response = async () => permission(false, true)
  const positive = await f.sdk.call('connection.setup.advance', inputFor(await inspect(f), 'inspect-application'))
  expect(positive.applicationInspection?.applicationInfoReadPermission).toBe('confirmed')
  expect((await f.sdk.call('connection.inspect', { operationId: 'inspection-original-save' })).operation).toEqual(f.saved)
}, 45_000)

it('an original encrypted ACK remains selectable and locally recoverable after renewal, revision, missing adapter and owner reopen without reactivating old permission', async () => {
  const f = await fixture(), native = nativeRoute(), fetch = vi.fn(native.route); vi.stubGlobal('fetch', fetch)
  await confirmed(f)
  const originalInput = inputFor(await inspect(f), 'inspect-application'), store = DesktopConnectorSecrets.prototype.store
  const fault = vi.spyOn(DesktopConnectorSecrets.prototype, 'store').mockImplementationOnce(async function(this: DesktopConnectorSecrets, input) {
    await store.call(this, input)
    throw new Error('fixture-lost-inspection-vault-ack')
  })
  const uncertain = await f.sdk.call('connection.setup.advance', originalInput), receipt = selected(uncertain)
  expect(receipt).toMatchObject({ input: originalInput, request: 'confirmed', secureStorage: 'unknown' })
  expect(uncertain.applicationInspection?.applicationInfoReadPermission).toBe('unknown'); expect(fault).toHaveBeenCalledTimes(1); fault.mockRestore()
  const before = changes(f)
  expect(selected(await inspect(f, { selectedStepId: receipt.stepId }))).toEqual(receipt)
  expect(changes(f)).toEqual(before)
  const originalAuth = (await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId })).operation!.authentication!
  const renewal = inputFor(await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId }), 'renew')
  const renewed = await f.sdk.call('connection.setup.advance', renewal)
  expect(renewed.continuation?.stage).toBe('waiting'); expect(renewed.operation!.authentication!.attemptId).not.toBe(originalAuth.attemptId)
  const revised = await f.sdk.call('connection.configure', { operationId: 'inspection-revised-save', expectedRevision: 1, connection: { ...f.config, label: 'Revised saved bot' } })
  const calls = fetch.mock.calls.length
  await f.close(); await f.reopen(true)
  const local = result(await f.cli(['setup', 'inspect', '--operation-id', f.input.operationId, '--application-inspection', '--inspection-step', receipt.stepId]))
  expect(selected(local)).toEqual(receipt); expect(local.applicationInspection?.applicationInfoReadPermission).toBe('unknown')
  const recovery = inputFor(local, 'recover-application-inspection')
  expect(recovery.decision.actionId).not.toBe(originalInput.decision.actionId)
  const recovered = result(await f.cli(['setup', 'advance', '--input', '-'], recovery))
  expect(selected(recovered)).toEqual({ ...receipt, secureStorage: 'stored' })
  expect(recovered.applicationInspection?.applicationInfoReadPermission).toBe('unknown')
  const repeated = await f.sdk.call('connection.setup.advance', originalInput)
  expect(selected(repeated)).toEqual(selected(recovered)); expect(repeated.applicationInspection?.applicationInfoReadPermission).toBe('unknown')
  expect(repeated.operation?.authentication).toEqual(local.operation?.authentication)
  expect(fetch).toHaveBeenCalledTimes(calls)
  await f.close(); await f.reopen(true)
  const reopened = await inspect(f, { selectedStepId: receipt.stepId })
  expect(selected(reopened)).toEqual(selected(recovered)); expect(reopened.applicationInspection?.applicationInfoReadPermission).toBe('unknown')
  assertSafe(reopened.applicationInspection)
  expect((await f.sdk.call('connection.inspect', { connectionId: f.config.connectionId })).connection).toEqual(revised.connection)
  expect((await f.sdk.call('connection.inspect', { operationId: 'inspection-original-save' })).operation).toEqual(f.saved)
}, 45_000)

it('an unrecoverable original result after reopen stays unknown but cannot suppress an explicit new observation under the same confirmed authentication', async () => {
  const f = await fixture(), fetch = vi.fn(nativeRoute().route); vi.stubGlobal('fetch', fetch)
  const auth = await confirmed(f), originalInput = inputFor(await inspect(f), 'inspect-application')
  const failEncryption = vi.spyOn(f.encryption, 'encryptString').mockImplementationOnce(() => { throw new Error('fixture-encryption-failed-before-original-write') })
  const uncertain = await f.sdk.call('connection.setup.advance', originalInput), original = selected(uncertain)
  expect(original).toMatchObject({ request: 'confirmed', secureStorage: 'unknown' }); failEncryption.mockRestore()
  const calls = fetch.mock.calls.length
  await f.close(); await f.reopen()
  const local = await inspect(f, { selectedStepId: original.stepId }), recover = inputFor(local, 'recover-application-inspection')
  expect(local.applicationInspection?.actions.map(action => action.kind).sort()).toEqual(['inspect-application', 'recover-application-inspection', ...Object.values(CONNECTION_SETUP_READ_ACTIONS)].sort())
  const stillUnknown = await f.sdk.call('connection.setup.advance', recover)
  expect(selected(stillUnknown)).toEqual(original); expect(stillUnknown.applicationInspection?.applicationInfoReadPermission).toBe('unknown')
  expect(fetch).toHaveBeenCalledTimes(calls)
  const freshInput = inputFor(await inspect(f, { selectedStepId: original.stepId }), 'inspect-application')
  expect(freshInput.decision.actionId).not.toBe(originalInput.decision.actionId)
  const fresh = await f.sdk.call('connection.setup.advance', freshInput)
  expect(selected(fresh).stepId).not.toBe(original.stepId); expect(fresh.applicationInspection?.applicationInfoReadPermission).toBe('confirmed')
  expect(fresh.operation?.authentication).toEqual(auth.operation?.authentication)
  expect(selected(await inspect(f, { selectedStepId: original.stepId }))).toEqual(original)
  expect((await inspect(f, { selectedStepId: original.stepId })).applicationInspection?.applicationInfoReadPermission).toBe('unknown')
  expect((await f.sdk.call('connection.setup.advance', originalInput)).applicationInspection?.selected).toEqual(original)
  expect(fetch.mock.calls.length - calls).toBe(1)
}, 45_000)

it('foreign actors and changed frozen action inputs are refused without changing the original observation, saved bot or usable authentication', async () => {
  const f = await fixture(), fetch = vi.fn(nativeRoute().route); vi.stubGlobal('fetch', fetch)
  await confirmed(f)
  const view = await inspect(f), input = inputFor(view, 'inspect-application'), calls = fetch.mock.calls.length
  const service = new AgentMuxRpcService({ connections: f.services.connections }); clean.push(() => service.dispose())
  await expect(service.call('connection.setup.advance', input, {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(service.call('connection.setup.inspect', { operationId: f.input.operationId, applicationInspection: {} }, { principal: { kind: 'device', id: 'foreign-inspection-device' } })).rejects.toMatchObject({ code: expect.stringMatching(/^(?:CONTROL_PERMISSION_DENIED|CONNECTION_SETUP_AUTHORITY_REQUIRED)$/u) })
  for (const changed of [
    { ...input, expectedRevision: input.expectedRevision + 1 },
    { ...input, decision: { ...input.decision, value: 'confirm' as const } },
    { ...input, decision: { ...input.decision, actionId: 'unoffered-inspection-action' } },
    { ...input, operationId: 'another-inspection-intent' }
  ]) await expect(f.sdk.call('connection.setup.advance', changed)).rejects.toMatchObject({ code: expect.any(String) })
  expect((await inspect(f)).applicationInspection).toEqual(view.applicationInspection); expect(fetch).toHaveBeenCalledTimes(calls)
  const observed = await f.sdk.call('connection.setup.advance', input), original = selected(observed)
  const foreign = { principal: { kind: 'device' as const, id: 'foreign-inspection-device' } }
  await expect(service.call('connection.setup.advance', input, foreign)).rejects.toMatchObject({ code: expect.stringMatching(/^(?:CONTROL_PERMISSION_DENIED|CONNECTION_SETUP_AUTHORITY_REQUIRED)$/u) })
  await expect(f.sdk.call('connection.setup.advance', { ...input, expectedRevision: input.expectedRevision + 1 })).rejects.toMatchObject({ code: expect.any(String) })
  const secondInput = inputFor(await inspect(f), 'inspect-application')
  const revised = await f.sdk.call('connection.configure', { operationId: 'inspection-before-dispatch-revision', expectedRevision: 1, connection: { ...f.config, label: 'New revision before read' } })
  await expect(f.sdk.call('connection.setup.advance', secondInput)).rejects.toMatchObject({ code: 'CONNECTION_SETUP_UNCONFIRMED' })
  expect(selected(await f.sdk.call('connection.setup.advance', input))).toEqual(original)
  expect(fetch.mock.calls.length - calls).toBe(1)
  expect((await f.sdk.call('connection.inspect', { connectionId: f.config.connectionId })).connection).toEqual(revised.connection)
  expect((await f.sdk.call('connection.inspect', { operationId: 'inspection-original-save' })).operation).toEqual(f.saved)
}, 45_000)

it('late old permission cannot replace a newer observation or the newly confirmed account', async () => {
  const f = await fixture(), entered = deferred<void>(), response = deferred<Response>(); let reads = 0
  const native = nativeRoute(async (_target, init) => {
    if (++reads === 1) { expect(new Headers(init.headers).get('x-csrf-token')).toBe(accounts[0].csrf); entered.resolve(); return await response.promise }
    expect(new Headers(init.headers).get('x-csrf-token')).toBe(accounts[1].csrf)
    return permission(false)
  })
  const fetch = vi.fn(native.route); vi.stubGlobal('fetch', fetch); clean.push(() => response.resolve(permission()))
  await confirmed(f)
  const oldInput = inputFor(await inspect(f), 'inspect-application'), pending = f.sdk.call('connection.setup.advance', oldInput)
  await Promise.race([entered.promise, pending.then(value => { expect(selected(value).request).toBe('dispatching') })])
  native.account(1)
  const renewed = await f.sdk.call('connection.setup.advance', inputFor(await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId }), 'renew'))
  const current = await confirmed(f, renewed)
  expect(current.continuation?.account).toEqual({ userId: accounts[1].user, tenantId: accounts[1].tenant })
  const fresh = await f.sdk.call('connection.setup.advance', inputFor(await inspect(f), 'inspect-application')), newest = selected(fresh)
  expect(fresh.applicationInspection?.applicationInfoReadPermission).toBe('unknown')
  response.resolve(permission())
  const late = await pending
  expect(selected(late).input).toEqual(oldInput); expect(late.applicationInspection?.applicationInfoReadPermission).toBe('unknown')
  expect(JSON.stringify(late)).not.toContain(accounts[0].user)
  const now = await inspect(f)
  expect(now.continuation?.account).toEqual(current.continuation?.account); expect(now.operation?.authentication).toEqual(current.operation?.authentication)
  expect(now.applicationInspection?.selected).toEqual(newest); expect(now.applicationInspection?.applicationInfoReadPermission).toBe('unknown')
  expect(now.applicationInspection?.observations.map(row => row.input.decision.actionId)).toEqual([newest.input.decision.actionId, oldInput.decision.actionId])
  expect(reads).toBe(2)
}, 45_000)

it('a target revision changed during the native read retains the original child but withholds the late permission and never rereads the revised target', async () => {
  const f = await fixture(), entered = deferred<void>(), response = deferred<Response>()
  const fetch = vi.fn(nativeRoute(async () => { entered.resolve(); return await response.promise }).route)
  vi.stubGlobal('fetch', fetch); clean.push(() => response.resolve(permission()))
  await confirmed(f)
  const input = inputFor(await inspect(f), 'inspect-application'), pending = f.sdk.call('connection.setup.advance', input)
  await Promise.race([entered.promise, pending.then(value => { expect(selected(value).request).toBe('dispatching') })])
  const revised = await f.sdk.call('connection.configure', { operationId: 'inspection-replaced-app', expectedRevision: 1, connection: { ...f.config, label: 'Revised target while original read is in flight' } })
  response.resolve(permission())
  const late = await pending
  expect(selected(late).input).toEqual(input); expect(late.applicationInspection?.applicationInfoReadPermission).toBe('unknown')
  expect((await inspect(f)).applicationInspection?.applicationInfoReadPermission).toBe('unknown')
  expect(fetch.mock.calls.filter(([url]) => new URL(String(url)).pathname.startsWith('/developers/')).map(([url]) => String(url))).toEqual(['https://open.feishu.cn/developers/v1/app_role/permission/' + f.config.application.appId])
  expect((await f.sdk.call('connection.inspect', { connectionId: f.config.connectionId })).connection).toEqual(revised.connection)
  expect((await f.sdk.call('connection.inspect', { operationId: 'inspection-original-save' })).operation).toEqual(f.saved)
}, 45_000)

it('an allowed authentication bootstrap alias never qualifies an unsourced business-read origin or removes the confirmed account', async () => {
  const f = await fixture(), native = nativeRoute(), business: string[] = []
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(url))
    if (target.href === 'https://open.feishu.cn/app') return new Response('', { status: 302, headers: { location: 'https://open.larkoffice.com/app' } })
    if (target.href === 'https://open.larkoffice.com/app') return new Response(`<script>window.csrfToken=${JSON.stringify(accounts[0].csrf)};window.user=${JSON.stringify({ id: accounts[0].user, tenantId: accounts[0].tenant })};</script>`, { headers: { 'content-type': 'text/html' } })
    if (target.pathname.startsWith('/developers/')) { business.push(target.href); return permission() }
    return await native.route(url, init)
  })
  vi.stubGlobal('fetch', fetch)
  const auth = await confirmed(f)
  expect(auth.continuation).toMatchObject({ stage: 'confirmed', account: { userId: accounts[0].user, tenantId: accounts[0].tenant } })
  expect(fetch.mock.calls.map(([url]) => String(url))).toContain('https://open.larkoffice.com/app')
  const observed = await f.sdk.call('connection.setup.advance', inputFor(await inspect(f), 'inspect-application'))
  expect(business).toEqual([])
  expect(observed.applicationInspection?.applicationInfoReadPermission).toBe('unknown')
  expect(observed.operation?.authentication).toEqual(auth.operation?.authentication)
  expect(observed.continuation).toMatchObject({ stage: 'confirmed', account: auth.continuation!.account })
  expect((await f.sdk.call('connection.inspect', { operationId: 'inspection-original-save' })).operation).toEqual(f.saved)
  expect((await f.sdk.call('connection.inspect', { connectionId: f.config.connectionId })).connection).toEqual(f.saved.connection)
}, 45_000)

async function wireFault(f: Fixture) {
  const path = join(f.root, 'wire.sock'), sockets = new Set<Socket>()
  let corrupt: (original: ConnectionSetupView) => unknown = value => value
  const originals: ConnectionSetupView[] = []
  const server = createServer(client => {
    const owner = createConnection(f.socketPath); sockets.add(client); sockets.add(owner)
    client.on('error', () => owner.destroy()); owner.on('error', () => client.destroy())
    client.once('close', () => { sockets.delete(client); owner.destroy() }); owner.once('close', () => { sockets.delete(owner); client.end() })
    client.pipe(owner)
    let pending = ''; owner.setEncoding('utf8')
    owner.on('data', chunk => {
      pending += chunk
      for (;;) {
        const newline = pending.indexOf('\n'); if (newline < 0) break
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1)
        if (!line) continue
        const frame = JSON.parse(line)
        if (frame.result?.applicationInspection) { originals.push(frame.result); frame.result = corrupt(frame.result) }
        client.write(JSON.stringify(frame) + '\n')
      }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
  clean.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); clean.push(() => sdk.dispose())
  return { path, sdk, originals, fault: (value: typeof corrupt) => { corrupt = value } }
}

it('actual SDK and compiled CLI decoders reject malformed selected-child results without exposing private fields or changing the real owner', async () => {
  const f = await fixture(), fetch = vi.fn(nativeRoute().route); vi.stubGlobal('fetch', fetch)
  await confirmed(f); await f.sdk.call('connection.setup.advance', inputFor(await inspect(f), 'inspect-application'))
  const valid = await inspect(f), wire = await wireFault(f), calls = fetch.mock.calls.length, before = changes(f)
  expect(valid.applicationInspection?.actions.map(action => action.kind)).toEqual(['inspect-application', ...Object.values(CONNECTION_SETUP_READ_ACTIONS)])
  expect(await wire.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationInspection: {} })).toEqual(valid)
  const faults = [
    (value: ConnectionSetupView) => ({ ...value, applicationInspection: { ...value.applicationInspection!, selected: { ...selected(value), privateRef: 'fixture-forbidden-inspection-private-ref' } } }),
    (value: ConnectionSetupView) => ({ ...value, applicationInspection: { ...value.applicationInspection!, actions: [...value.applicationInspection!.actions, value.applicationInspection!.actions[0]] } }),
    (value: ConnectionSetupView) => ({ ...value, applicationInspection: { ...value.applicationInspection!, selected: { ...selected(value), input: { ...selected(value).input, operationId: 'foreign-original-inspection' } } } }),
    (value: ConnectionSetupView) => ({ ...value, applicationInspection: { ...value.applicationInspection!, applicationInfoReadPermission: 'confirmed', selected: { ...selected(value), secureStorage: 'unknown' } } }),
    (value: ConnectionSetupView) => ({ ...value, applicationInspection: { ...value.applicationInspection!, selected: { ...selected(value), request: 'ready' } } }),
    (value: ConnectionSetupView) => ({ ...value, applicationInspection: { ...value.applicationInspection!, actions: value.applicationInspection!.actions.map(action => ({ ...action, kind: 'continue' })) } })
  ]
  for (const fault of faults) {
    wire.fault(fault)
    await expect(wire.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationInspection: {} })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    const output = await f.cli(['setup', 'inspect', '--operation-id', f.input.operationId, '--application-inspection'], undefined, wire.path)
    expect(output.code).not.toBe(0)
    expect(JSON.parse(output.stderr)).toMatchObject({ ok: false, operation: 'connection.setup.inspect', error: { code: 'CONTROL_PROTOCOL_ERROR' } })
    expect(output.stdout + output.stderr).not.toContain('fixture-forbidden-inspection-private-ref')
  }
  wire.fault(value => value)
  expect(result(await f.cli(['setup', 'inspect', '--operation-id', f.input.operationId, '--application-inspection'], undefined, wire.path))).toEqual(valid)
  expect(wire.originals.length).toBeGreaterThan(faults.length)
  expect(await inspect(f)).toEqual(valid); expect(changes(f)).toEqual(before); expect(fetch).toHaveBeenCalledTimes(calls)
}, 45_000)

it('public decoders require the requested inspection and keep recovery and advance receipts tied to their exact selected child', async () => {
  const f = await fixture(), fetch = vi.fn(nativeRoute().route); vi.stubGlobal('fetch', fetch)
  await confirmed(f)
  const input = inputFor(await inspect(f), 'inspect-application')
  const original = selected(await f.sdk.call('connection.setup.advance', input)), wire = await wireFault(f)
  const recover = { kind: 'recover-application-inspection', actionId: 'fixture-unqualified-recovery', expectedRevision: input.expectedRevision }
  const samples = [
    { operation: 'inspect', corrupt: (value: ConnectionSetupView) => { const { applicationInspection: _missing, ...rest } = value; return rest } },
    { operation: 'inspect', corrupt: (value: ConnectionSetupView) => ({ ...value, applicationInspection: { ...value.applicationInspection!, selected: null, applicationInfoReadPermission: 'unknown', actions: [recover] } }) },
    { operation: 'inspect', corrupt: (value: ConnectionSetupView) => ({ ...value, applicationInspection: { ...value.applicationInspection!, actions: [recover] } }) },
    { operation: 'advance', corrupt: (value: ConnectionSetupView) => ({ ...value, applicationInspection: { ...value.applicationInspection!, selected: { ...selected(value), stepId: 'fixture-different-selected-step' } } }) }
  ]
  const outcomes = [], calls = fetch.mock.calls.length, before = changes(f)
  for (const sample of samples) {
    wire.fault(sample.corrupt)
    const request = sample.operation === 'inspect'
      ? wire.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationInspection: {} })
      : wire.sdk.call('connection.setup.advance', input)
    const sdk = await request.then(() => ({ accepted: true, code: null }), error => ({ accepted: false, code: error.code }))
    const output = sample.operation === 'inspect'
      ? await f.cli(['setup', 'inspect', '--operation-id', f.input.operationId, '--application-inspection'], undefined, wire.path)
      : await f.cli(['setup', 'advance', '--input', '-'], input, wire.path)
    const error = output.code === 0 ? null : JSON.parse(output.stderr)
    outcomes.push({ operation: sample.operation, sdk, cli: { accepted: output.code === 0, operation: error?.operation ?? null, code: error?.error?.code ?? null } })
  }
  expect(outcomes).toEqual(samples.map(sample => ({ operation: sample.operation, sdk: { accepted: false, code: 'CONTROL_PROTOCOL_ERROR' }, cli: { accepted: false, operation: 'connection.setup.' + sample.operation, code: 'CONTROL_PROTOCOL_ERROR' } })))
  wire.fault(value => value)
  expect(selected(await inspect(f))).toEqual(original)
  expect(selected(await wire.sdk.call('connection.setup.advance', input))).toEqual(original)
  expect(changes(f)).toEqual(before); expect(fetch).toHaveBeenCalledTimes(calls)
}, 45_000)

function childMessage(child: ChildProcess, kind: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (value: unknown) => {
      if (value && typeof value === 'object' && (value as { kind?: string }).kind === kind) {
        child.off('message', onMessage); child.off('exit', onExit); resolve(value as Record<string, unknown>)
      }
    }
    const onExit = () => { child.off('message', onMessage); reject(new Error('Inspection owner exited before ' + kind)) }
    child.on('message', onMessage); child.once('exit', onExit)
  })
}

it.each(['inflight', 'vault-committed'] as const)('a real process restart preserves the original %s inspection and never replays its native read', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'setup-inspection-child-')); clean.push(() => rm(root, { recursive: true, force: true }))
  const start = async (fault: string) => {
    const child = fork(new URL('./fixtures/connection-setup-inspection-owner.mjs', import.meta.url), [root, fault], { execArgv: ['--experimental-transform-types'], env: objectCliEnvironment(root), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    clean.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit') } })
    let errors = ''; child.stderr!.on('data', value => { errors += value })
    const ready = await childMessage(child, 'ready').catch(error => { throw new Error(errors || String(error)) })
    return { child, ready }
  }
  const first = await start(mode), socketPath = join(root, 'owner.sock')
  const cli = (args: string[], body?: unknown) => runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', ...args], objectCliEnvironment(root), body === undefined ? '' : JSON.stringify(body))
  const config: ConnectionConfig = { connectionId: 'inspection-saved-bot', adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: 'cli_inspection_original_bot' }, label: 'Original inspection bot', enabled: false, credentialRef: String(first.ready.credentialRef) }
  const saved = result(await cli(['configure', '--input', '-'], { operationId: 'inspection-child-save', expectedRevision: null, connection: config }))
  const input: ConnectionSetupBegin = { operationId: 'inspection-child-management', connectionId: config.connectionId, expectedConnectionRevision: 1, goal }
  let view = result(await cli(['setup', 'begin', '--input', '-'], input))
  for (let step = 0; step < 8 && view.continuation?.stage !== 'account'; step++) view = result(await cli(['setup', 'advance', '--input', '-'], inputFor(view, 'continue')))
  expect(view.continuation?.stage).toBe('account')
  view = result(await cli(['setup', 'advance', '--input', '-'], inputFor(view, 'confirm-account')))
  const auth = view.operation!.authentication!
  const originalInput = inputFor(result(await cli(['setup', 'inspect', '--operation-id', input.operationId, '--application-inspection'])), 'inspect-application')
  const entered = childMessage(first.child, mode === 'inflight' ? 'inspection-started' : 'vault-committed')
  const pending = cli(['setup', 'advance', '--input', '-'], originalInput)
  await Promise.race([entered, pending.then(output => { expect(result(output).applicationInspection?.selected?.request).toBe('dispatching') })])
  const original = selected(result(await cli(['setup', 'inspect', '--operation-id', input.operationId, '--application-inspection'])))
  expect(original.input).toEqual(originalInput)
  expect(original.request).toBe(mode === 'inflight' ? 'dispatching' : 'confirmed')
  first.child.kill('SIGKILL'); await once(first.child, 'exit'); expect((await pending).code).not.toBe(0)
  const effects = await readFile(join(root, 'native-effects.ndjson'), 'utf8')
  await start('observe-only')
  const observed = result(await cli(['setup', 'inspect', '--operation-id', input.operationId, '--application-inspection', '--inspection-step', original.stepId]))
  expect(selected(observed)).toMatchObject({ stepId: original.stepId, input: originalInput })
  expect(observed.operation?.authentication).toEqual(auth)
  if (mode === 'inflight') {
    expect(selected(observed).request).toBe('unknown'); expect(observed.applicationInspection?.applicationInfoReadPermission).toBe('unknown')
    const repeated = result(await cli(['setup', 'advance', '--input', '-'], originalInput))
    expect(selected(repeated)).toEqual(selected(observed))
    expect(observed.applicationInspection?.actions.map(action => action.kind)).toContain('inspect-application')
  } else {
    expect(selected(observed).secureStorage).not.toBe('stored')
    const recovered = result(await cli(['setup', 'advance', '--input', '-'], inputFor(observed, 'recover-application-inspection')))
    expect(selected(recovered)).toEqual({ ...original, secureStorage: 'stored' })
    expect(recovered.applicationInspection?.applicationInfoReadPermission).toBe('confirmed')
    expect(selected(result(await cli(['setup', 'advance', '--input', '-'], originalInput)))).toEqual(selected(recovered))
  }
  expect(await readFile(join(root, 'native-effects.ndjson'), 'utf8')).toBe(effects)
  expect(effects.trim().split('\n').map(line => JSON.parse(line).path)).toEqual(['/accounts/qrlogin/init', '/accounts/qrlogin/polling', '/cross-login', '/', '/', '/app', '/developers/v1/app_role/permission/' + config.application.appId])
  expect(result<{ operation: unknown }>(await cli(['inspect', '--operation-id', 'inspection-child-save'])).operation).toEqual(saved)
  expect(result<{ connection: unknown }>(await cli(['inspect', '--connection', config.connectionId])).connection).toMatchObject({ config, revision: 1 })
}, 60_000)

it.each(['observed', 'unknown'] as const)('retains a rotated native session across owner reopen with an %s business receipt', async outcome => {
  const f = await fixture(), rotated = 'fixture-rotated-inspection-session'
  let count = 0
  const fetch = vi.fn(nativeRoute(async (_target, init) => {
    if (count++ > 0) {
      expect(new Headers(init.headers).get('cookie')).toContain('session=' + rotated)
      expect(new Headers(init.headers).get('cookie')).not.toContain('session=' + SESSION)
      return permission()
    }
    const response = outcome === 'observed' ? permission() : Response.json({ code: 0, data: {} })
    response.headers.append('set-cookie', `session=${rotated}; Domain=.feishu.cn; Path=/; Secure; HttpOnly`)
    return response
  }).route); vi.stubGlobal('fetch', fetch)
  await confirmed(f)
  const observed = result(await f.cli(['setup', 'advance', '--input', '-'], inputFor(await inspect(f), 'inspect-application')))
  expect(selected(observed)).toMatchObject({ request: outcome === 'observed' ? 'confirmed' : 'unknown', secureStorage: 'stored' })
  expect(observed.applicationInspection?.applicationInfoReadPermission).toBe(outcome === 'observed' ? 'confirmed' : 'unknown')
  expect(observed.applicationInspection?.readResult).toBeUndefined()
  expect(JSON.stringify(observed)).not.toContain(rotated)
  await f.close(); await f.reopen()
  const continued = await f.sdk.call('connection.setup.advance', inputFor(await inspect(f), 'inspect-application'))
  expect(continued.applicationInspection?.applicationInfoReadPermission).toBe('confirmed')
  expect(count).toBe(2)
})

it.each(['observed', 'unknown'] as const)('locally recovers one encrypted Cookie continuation after a lost ACK with an %s original result', async outcome => {
  const f = await fixture(), rotated = 'fixture-ack-rotated-session'
  let count = 0
  vi.stubGlobal('fetch', vi.fn(nativeRoute(async (_target, init) => {
    if (count++ > 0) { expect(new Headers(init.headers).get('cookie')).toContain('session=' + rotated); return permission() }
    const response = outcome === 'observed' ? permission() : Response.json({ code: 0, data: {} })
    response.headers.append('set-cookie', `session=${rotated}; Domain=.feishu.cn; Path=/; Secure`)
    return response
  }).route))
  await confirmed(f)
  const store = DesktopConnectorSecrets.prototype.store
  const fault = vi.spyOn(DesktopConnectorSecrets.prototype, 'store').mockImplementationOnce(async function(this: DesktopConnectorSecrets, input) {
    await store.call(this, input); throw new Error('fixture-cookie-evidence-ack-lost')
  })
  const originalInput = inputFor(await inspect(f), 'inspect-application')
  const original = await f.sdk.call('connection.setup.advance', originalInput)
  expect(selected(original)).toMatchObject({ request: outcome === 'observed' ? 'confirmed' : 'unknown', secureStorage: 'unknown' })
  expect(fault).toHaveBeenCalledTimes(1); fault.mockRestore()
  await f.close(); await f.reopen()
  const local = await inspect(f), recovery = inputFor(local, 'recover-application-inspection')
  const recovered = result(await f.cli(['setup', 'advance', '--input', '-'], recovery))
  expect(selected(recovered)).toEqual({ ...selected(original), secureStorage: 'stored' })
  expect(recovered.applicationInspection?.applicationInfoReadPermission).toBe(outcome === 'observed' ? 'confirmed' : 'unknown')
  expect(count).toBe(1)
  expect(selected(await f.sdk.call('connection.setup.advance', originalInput))).toEqual(selected(recovered))
  expect(count).toBe(1)
  expect(selected(await f.sdk.call('connection.setup.advance', inputFor(await inspect(f), 'inspect-application'))).request).toBe('confirmed')
  expect(count).toBe(2)
})

it('a late response from the same authentication source preserves its receipt without replacing a newer Cookie continuation', async () => {
  const f = await fixture(), started = deferred<void>(), delayed = deferred<Response>()
  let count = 0
  vi.stubGlobal('fetch', vi.fn(nativeRoute(async (_target, init) => {
    count++
    if (count === 1) { started.resolve(); return delayed.promise }
    if (count > 2) { expect(new Headers(init.headers).get('cookie')).toContain('session=fixture-newer-cookie'); return permission() }
    const response = permission(); response.headers.append('set-cookie', 'session=fixture-newer-cookie; Domain=.feishu.cn; Path=/; Secure'); return response
  }).route))
  await confirmed(f)
  const older = f.sdk.call('connection.setup.advance', inputFor(await inspect(f), 'inspect-application'))
  await started.promise
  const newer = await f.sdk.call('connection.setup.advance', inputFor(await inspect(f), 'inspect-application'))
  expect(selected(newer).request).toBe('confirmed')
  const oldResponse = permission(); oldResponse.headers.append('set-cookie', 'session=fixture-older-cookie; Domain=.feishu.cn; Path=/; Secure')
  delayed.resolve(oldResponse)
  expect(selected(await older)).toMatchObject({ request: 'confirmed', secureStorage: 'stored' })
  await f.close(); await f.reopen()
  expect(selected(await f.sdk.call('connection.setup.advance', inputFor(await inspect(f), 'inspect-application'))).request).toBe('confirmed')
  expect(count).toBe(3)
})

it('recovers the original child ACK after its Cookie continuation was already adopted', async () => {
  const f = await fixture(), fetch = vi.fn(nativeRoute(async () => {
    const response = permission(); response.headers.append('set-cookie', 'continued=fixture-already-adopted; Path=/; Secure'); return response
  }).route); vi.stubGlobal('fetch', fetch)
  await confirmed(f)
  const prepare = f.services.database!.prepare.bind(f.services.database!)
  let interrupted = false
  const fault = vi.spyOn(f.services.database!, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql)
    if (sql.startsWith('UPDATE connection_setup_inspection SET record_json=')) {
      const run = statement.run.bind(statement)
      vi.spyOn(statement, 'run').mockImplementation((...args) => {
        if (!interrupted && String(args[0]).includes('"secureStorage":"stored"')) { interrupted = true; throw new Error('fixture-child-ack-after-adoption') }
        return run(...args)
      })
    }
    return statement
  })
  const observed = await f.sdk.call('connection.setup.advance', inputFor(await inspect(f), 'inspect-application'))
  expect(interrupted).toBe(true); expect(selected(observed)).toMatchObject({ request: 'confirmed', secureStorage: 'unknown' })
  const calls = fetch.mock.calls.length; fault.mockRestore()
  await f.close(); await f.reopen()
  const recovered = await f.sdk.call('connection.setup.advance', inputFor(await inspect(f), 'recover-application-inspection'))
  expect(selected(recovered)).toEqual({ ...selected(observed), secureStorage: 'stored' })
  expect(recovered.applicationInspection?.applicationInfoReadPermission).toBe('confirmed')
  expect(fetch).toHaveBeenCalledTimes(calls)
})


it('a local Cookie serialization fault cannot erase the already received application observation', async () => {
  const f = await fixture()
  vi.stubGlobal('fetch', vi.fn(nativeRoute(async () => {
    const response = permission(); response.headers.append('set-cookie', 'continued=fixture-unconfirmed-cookie-save; Path=/; Secure')
    vi.spyOn(CookieJar.prototype, 'serializeSync').mockImplementationOnce(() => { throw new Error('fixture-cookie-snapshot-fault') })
    return response
  }).route))
  await confirmed(f)
  const observed = await f.sdk.call('connection.setup.advance', inputFor(await inspect(f), 'inspect-application'))
  expect(selected(observed)).toMatchObject({ request: 'confirmed', secureStorage: 'stored' })
  expect(observed.applicationInspection?.applicationInfoReadPermission).toBe('confirmed')
  expect(observed.continuation?.stage).toBe('confirmed')
})

it('exposes the original unknown permission inspection in a secret-free ordered Setup trace through SDK and compiled CLI', async () => {
  const f = await fixture(), fetch = vi.fn(nativeRoute(async () => { throw new Error('private failed permission response') }).route)
  vi.stubGlobal('fetch', fetch)
  await confirmed(f)
  const offered = await inspect(f), original = inputFor(offered, 'inspect-application')
  const failed = await f.sdk.call('connection.setup.advance', original)
  expect(selected(failed)).toMatchObject({ request: 'unknown', secureStorage: 'not-started' })
  const count = fetch.mock.calls.length, before = changes(f), resolve = vi.spyOn(DesktopConnectorSecrets.prototype, 'resolve'), store = vi.spyOn(DesktopConnectorSecrets.prototype, 'store')
  f.encryption.isEncryptionAvailable = () => false
  let page = result(await f.cli(['setup', 'inspect', '--operation-id', f.input.operationId, '--request-trace', '--trace-limit', '2']))
  const entries = [...page.requestTrace!.entries]
  expect(page.challenge).toBeNull(); expect(page.continuation).toBeUndefined(); expect(page.applicationInspection).toBeUndefined()
  expect(entries.map(entry => entry.action)).toEqual(['initialize', 'continue'])
  const firstCursor = page.requestTrace!.next!
  while (page.requestTrace!.next !== null) {
    page = await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, requestTrace: { cursor: page.requestTrace!.next!, limit: 2 } })
    entries.push(...page.requestTrace!.entries)
  }
  expect(entries.map(entry => entry.kind)).toEqual(['setup-initialize', ...Array.from({ length: 6 }, () => 'setup-authentication'), 'application-inspection'])
  expect(entries.at(-1)).toEqual({ sequence: original.expectedRevision + 1, stepId: selected(failed).stepId, kind: 'application-inspection', action: 'inspect-application', subject: null, effect: null, request: 'unknown', secureStorage: 'not-started', network: null })
  expect(entries.map(entry => entry.sequence)).toEqual([...entries.map(entry => entry.sequence)].sort((a,b) => a-b))
  expect(new Set(entries.map(entry => entry.sequence)).size).toBe(entries.length)
  expect(entries.map(entry => entry.network)).toEqual(Array.from({ length: 8 }, () => null))
  assertSafe(entries)
  expect(JSON.stringify(entries)).not.toMatch(/https?:|cookie|qrPayload|privateRef|\/developers|\?/u)
  expect(resolve).not.toHaveBeenCalled(); expect(store).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(count); expect(changes(f)).toEqual(before)
  const service = new AgentMuxRpcService({ connections: f.services.connections }); clean.push(() => service.dispose())
  await expect(service.call('connection.setup.inspect', { operationId: f.input.operationId, requestTrace: {} }, { principal: { kind: 'device', id: 'foreign-trace-actor' } })).rejects.toMatchObject({ code: 'CONNECTION_SETUP_AUTHORITY_REQUIRED' })
  await expect(f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, requestTrace: {}, applicationInspection: {} })).rejects.toMatchObject({ code: 'INVALID_CONNECTION_SETUP_DATA' })
  await f.close(); await f.reopen(true)
  const restored = result(await f.cli(['setup', 'inspect', '--operation-id', f.input.operationId, '--request-trace']))
  expect(restored.requestTrace!.entries).toEqual(entries)
  const next = await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, requestTrace: { cursor: firstCursor, limit: 2 } })
  expect(next.requestTrace!.entries).toEqual(entries.slice(2,4))
  expect(resolve).not.toHaveBeenCalled(); expect(store).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(count)
}, 45_000)

it('keeps Setup trace cursors stable while new original inspection steps are appended', async () => {
  const f = await fixture(), fetch = vi.fn(nativeRoute().route); vi.stubGlobal('fetch', fetch)
  await confirmed(f)
  const original = selected(await f.sdk.call('connection.setup.advance', inputFor(await inspect(f), 'inspect-application')))
  const before = await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, requestTrace: {} })
  const first = await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, requestTrace: { limit: 2 } })
  expect(first.requestTrace!.entries).toEqual(before.requestTrace!.entries.slice(0,2))
  const later = selected(await f.sdk.call('connection.setup.advance', inputFor(await inspect(f), 'inspect-application')))
  expect(later.stepId).not.toBe(original.stepId)
  const count = fetch.mock.calls.length, rest = await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, requestTrace: { cursor: first.requestTrace!.next! } })
  expect([...first.requestTrace!.entries, ...rest.requestTrace!.entries].map(entry => entry.stepId)).toEqual([...before.requestTrace!.entries.map(entry => entry.stepId), later.stepId])
  expect(rest.requestTrace!.entries.at(-1)).toMatchObject({ stepId: later.stepId, sequence: later.input.expectedRevision+1, request: 'confirmed', network: null })
  expect(rest.requestTrace!.next).toBeNull()
  await expect(f.sdk.call('connection.setup.inspect', { operationId: 'other-original-operation', requestTrace: { cursor: first.requestTrace!.next! } })).rejects.toMatchObject({ code: 'INVALID_CONNECTION_REQUEST_TRACE' })
  expect(fetch).toHaveBeenCalledTimes(count)
}, 30_000)
