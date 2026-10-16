import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { DesktopConnectorSecrets } from '../../../apps/desktop/src/main/connector-secrets.js'
import { AgentMuxControlServer, AgentMuxRpcService, connectAgentMuxRpc } from '@agentmux/core'
import type { ConnectionConfig, ConnectionSetupAction, ConnectionSetupAdvance, ConnectionSetupBegin, ConnectionSetupInspectionReceipt, ConnectionSetupReadSubject, ConnectionSetupView } from '@agentmux/core/connections'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { enrollmentEncryption } from './fixtures/connection-enrollment.js'
import { objectCliEnvironment, runCompiledObjectCli, type CliResult } from '../../core/test/helpers/object-cli-rpc.js'

const SECRET = 'fixture-settings-saved-secret', TOKEN = 'fixture-settings-qr-token', FLOW = 'fixture-settings-flow-key'
const SESSION = 'fixture-settings-session-cookie', READ_COOKIE = 'fixture-settings-business-cookie', PRIVATE = 'fixture-settings-private'
const accounts = [
  { user: 'fixture-settings-user-a', tenant: 'fixture-settings-tenant-a', csrf: 'fixture-settings-csrf-a' },
  { user: 'fixture-settings-user-b', tenant: 'fixture-settings-tenant-b', csrf: 'fixture-settings-csrf-b' }
]
const kinds = { 'application-details': 'read-application-details', 'event-settings': 'read-event-settings', 'callback-settings': 'read-callback-settings', 'bot-settings': 'read-bot-settings' } as const
const paths = { 'application-details': '/developers/v1/app/', 'event-settings': '/developers/v1/event/', 'callback-settings': '/developers/v1/callback/', 'bot-settings': '/developers/v1/robot/' } as const
const subjects = Object.keys(kinds) as ConnectionSetupReadSubject[]
const raw = {
  'application-details': { name: 'Saved bot label', desc: 'Bot description from the native object', appSecret: PRIVATE + '-application-details', ignored: { memberId: PRIVATE + '-member' } },
  'event-settings': { eventMode: 4, eventDetails: [{ items: [{ id: PRIVATE + '-event-id' }] }], appEventDetails: [], userEventDetails: [], encryptionKey: PRIVATE + '-event-settings' },
  'callback-settings': { callbackMode: 4, eventMode: 4, callbacks: [PRIVATE + '-callback-id'], verificationToken: PRIVATE + '-callback-settings' },
  'bot-settings': { enable: true, botMenuEnable: true, eventMode: 4, cardCallbackMode: 1, botMenuConfig: [{ eventKey: PRIVATE + '-bot-settings' }] }
}
const goal = { kind: 'agent-conversation', interaction: 'messages' } as const
const clean: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const close of clean.splice(0).reverse()) await close() })
function result<T = ConnectionSetupView>(output: CliResult): T { expect(output.code, output.stdout + output.stderr).toBe(0); return JSON.parse(output.stdout).result }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function action(view: ConnectionSetupView, kind: ConnectionSetupAction['kind']): ConnectionSetupAdvance {
  const offered = kind === 'continue' || kind === 'confirm-account' || kind === 'renew' ? view.continuation?.actions : view.applicationInspection?.actions
  const matches = offered?.filter(a => a.kind === kind) ?? []
  expect(matches, 'One exact offered ' + kind).toHaveLength(1)
  expect(matches[0]).toMatchObject({ actionId: expect.any(String), expectedRevision: expect.any(Number) })
  return { operationId: view.operation!.operationId, expectedRevision: matches[0].expectedRevision, decision: { actionId: matches[0].actionId, value: kind === 'confirm-account' ? 'confirm' : kind === 'renew' ? 'renew' : 'continue' } }
}
function selected(view: ConnectionSetupView): ConnectionSetupInspectionReceipt {
  expect(view.applicationInspection?.selected).toBeDefined(); expect(view.applicationInspection?.selected).not.toBeNull()
  return view.applicationInspection!.selected!
}
function assertPrivateFree(value: unknown) {
  const text = JSON.stringify(value)
  for (const secret of [SECRET, TOKEN, FLOW, SESSION, READ_COOKIE, PRIVATE, ...accounts.flatMap(a => [a.user, a.tenant, a.csrf])]) expect(text).not.toContain(secret)
  for (const key of ['appSecret', 'encryptionKey', 'eventDetails', 'eventMode', 'callbackMode', 'cardCallbackMode', 'botMenuEnable', 'privateRef', 'privateState', 'readResource']) expect(text).not.toContain('"' + key + '"')
}
function nativeRoute(read: (subject: ConnectionSetupReadSubject, target: URL, init: RequestInit) => Promise<Response> = async subject => Response.json({ code: 0, data: raw[subject] })) {
  let accountIndex = 0
  const route = async (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const target = new URL(String(url))
    if (target.origin === 'https://accounts.feishu.cn' && target.pathname === '/accounts/qrlogin/init') return Response.json({ code: 0, data: { step_info: { token: TOKEN } } }, { headers: [
      ['x-flow-key', FLOW], ['set-cookie', `session=${SESSION}; Domain=.feishu.cn; Path=/; Secure; HttpOnly`], ['set-cookie', 'pollOnly=fixture-poll-cookie; Path=/accounts/qrlogin; Secure']
    ] })
    if (target.origin === 'https://accounts.feishu.cn' && target.pathname === '/accounts/qrlogin/polling') return Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross-login' } } })
    if (target.href === 'https://accounts.feishu.cn/cross-login') return new Response('', { status: 302, headers: { location: 'https://ask.feishu.cn/' } })
    if (target.href === 'https://ask.feishu.cn/') return new Response('Landing text is not account identity')
    if (target.href === 'https://open.feishu.cn/app') {
      const a = accounts[accountIndex]
      return new Response(`<script>window.csrfToken=${JSON.stringify(a.csrf)};window.user=${JSON.stringify({ id: a.user, tenantId: a.tenant })};</script>`, { headers: [
        ['content-type', 'text/html'], ['set-cookie', `readScope=${READ_COOKIE}; Path=/developers/v1; Secure; HttpOnly`], ['set-cookie', 'unrelated=fixture-other-cookie; Path=/another-resource; Secure']
      ] })
    }
    if (target.pathname.startsWith('/developers/v1/app_role/permission/')) return Response.json({ code: 0, data: { roleType: 4, permission: { 4: { readResource: { 'app.info': true }, writeResource: {} } } } })
    const subject = subjects.find(s => target.pathname.startsWith(paths[s]))
    if (subject) return await read(subject, target, init)
    throw new Error('Unexpected settings native request ' + target.origin + target.pathname)
  }
  return { route, account: (index: number) => { accountIndex = index } }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'setup-settings-')), directory = join(root, 'connections'), socketPath = join(root, 'owner.sock'), encryption = enrollmentEncryption()
  let services: Awaited<ReturnType<typeof createDesktopConnections>>, server: AgentMuxControlServer, sdk: Awaited<ReturnType<typeof connectAgentMuxRpc>>
  const open = async (missingAdapter = false) => {
    services = await createDesktopConnections({ directory, encryption, ...(missingAdapter ? { adapters: [] } : {}) })
    server = new AgentMuxControlServer({ socketPath, connections: services.connections, coreClients: () => { throw new Error('Settings reads cannot borrow an Agent Runtime') } })
    await server.start(); sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  }
  const close = async () => { await sdk?.dispose(); await server?.stop(); services?.close() }
  clean.push(async () => { await close(); await rm(root, { recursive: true, force: true }) })
  await open()
  const credential = await services.secrets.store({ operationId: 'settings-credential', secret: SECRET })
  const config: ConnectionConfig = { connectionId: 'settings-saved-bot', adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: 'cli_settings_original_bot' }, label: 'Original saved settings bot', enabled: false, credentialRef: credential.credentialRef }
  const saved = await sdk.call('connection.configure', { operationId: 'settings-original-save', expectedRevision: null, connection: config })
  const input: ConnectionSetupBegin = { operationId: 'settings-original-management', connectionId: config.connectionId, expectedConnectionRevision: saved.connection.revision, goal }
  const cli = (args: string[], body?: unknown, endpoint = socketPath) => runCompiledObjectCli(['--endpoint', 'unix:' + endpoint, 'connection', ...args], objectCliEnvironment(root), body === undefined ? '' : JSON.stringify(body))
  return { root, directory, socketPath, config, saved, input, encryption, cli, close, reopen: open, get sdk() { return sdk }, get services() { return services } }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
const inspect = (f: Fixture, selectedStepId?: string) => f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationInspection: selectedStepId ? { selectedStepId } : {} })
async function confirmed(f: Fixture, view?: ConnectionSetupView) {
  view ??= result(await f.cli(['setup', 'begin', '--input', '-'], f.input))
  for (let step = 0; step < 8 && view.continuation?.stage !== 'account'; step++) view = await f.sdk.call('connection.setup.advance', action(view, 'continue'))
  expect(view.continuation?.stage).toBe('account')
  const value = result(await f.cli(['setup', 'advance', '--input', '-'], action(view, 'confirm-account')))
  expect(value.continuation?.stage).toBe('confirmed'); return value
}
const changes = (f: Fixture) => f.services.database!.prepare('SELECT total_changes() AS count').get()

it('real SDK and compiled CLI read four independently claimed native subjects while preserving the original permission row, saved bot and private data boundary', async () => {
  const f = await fixture(), captured: Array<{ subject: ConnectionSetupReadSubject; target: URL; init: RequestInit; claim: ConnectionSetupInspectionReceipt }> = []
  const native = nativeRoute(async (subject, target, init) => { captured.push({ subject, target, init, claim: selected(await inspect(f)) }); return Response.json({ code: 0, data: raw[subject] }) })
  const fetch = vi.fn(native.route); vi.stubGlobal('fetch', fetch)
  const off = await f.sdk.call('connection.service.configure', { operationId: 'settings-service-off', expectedRevision: 0, service: { enabled: false } })
  await confirmed(f)
  const permission = await f.sdk.call('connection.setup.advance', action(await inspect(f), 'inspect-application')), original = selected(permission)
  expect(original).not.toHaveProperty('subject'); expect(permission.applicationInspection?.applicationInfoReadPermission).toBe('confirmed')
  const originalBytes = f.services.database!.prepare('SELECT record_json,private_ref FROM connection_setup_inspection WHERE step_id=?').get(original.stepId)
  const store = vi.spyOn(DesktopConnectorSecrets.prototype, 'store'), receipts: ConnectionSetupInspectionReceipt[] = []
  const expected = {
    'application-details': { subject: 'application-details', name: raw['application-details'].name, description: raw['application-details'].desc },
    'event-settings': { subject: 'event-settings', transport: 'persistent-connection' },
    'callback-settings': { subject: 'callback-settings' }, 'bot-settings': { subject: 'bot-settings' }
  }
  for (const [index, subject] of subjects.entries()) {
    const input = action(await inspect(f), kinds[subject]), before = fetch.mock.calls.length
    const view = index % 2 ? await f.sdk.call('connection.setup.advance', input) : result(await f.cli(['setup', 'advance', '--input', '-'], input))
    const receipt = selected(view); receipts.push(receipt)
    expect(receipt).toMatchObject({ subject, input, request: 'confirmed', secureStorage: 'stored' })
    expect(view.applicationInspection?.readResult).toEqual(expected[subject])
    expect(view.applicationInspection?.applicationInfoReadPermission).toBe('unknown')
    expect(fetch.mock.calls.length - before).toBe(1)
    const repeated = await f.sdk.call('connection.setup.advance', input)
    expect(selected(repeated)).toEqual(receipt); expect(repeated.applicationInspection?.readResult).toEqual(expected[subject])
    expect(fetch.mock.calls.length - before).toBe(1); assertPrivateFree(view.applicationInspection)
  }
  expect(captured.map(c => c.subject)).toEqual(subjects)
  for (const [index, entry] of captured.entries()) {
    expect(entry.target.href).toBe('https://open.feishu.cn' + paths[entry.subject] + f.config.application.appId)
    expect(entry.init).toMatchObject({ method: 'POST', redirect: 'manual' })
    expect(JSON.parse(String(entry.init.body))).toEqual(entry.subject === 'event-settings' ? { needEventDetail: true } : {})
    const headers = new Headers(entry.init.headers)
    expect(headers.get('content-type')).toMatch(/^application\/json\b/u); expect(headers.get('x-csrf-token')).toBe(accounts[0].csrf)
    expect(headers.get('x-timezone-offset')).toBe(String(new Date().getTimezoneOffset()))
    expect(headers.get('x-flow-key')).toBeNull(); expect(headers.get('X-AppPlatform-RequestFrom')).toBeNull()
    expect((headers.get('cookie') ?? '').split(';').map(x => x.trim()).sort()).toEqual([`session=${SESSION}`, `readScope=${READ_COOKIE}`].sort())
    expect(entry.claim).toMatchObject({ subject: entry.subject, stepId: receipts[index].stepId, input: receipts[index].input, request: 'dispatching', secureStorage: 'not-started' })
    const writes = store.mock.calls.filter(([input]) => input.secret.includes(PRIVATE + '-' + entry.subject))
    expect(writes).toHaveLength(1)
    expect(Object.values(JSON.parse(writes[0][0].secret))).toContain(JSON.stringify(raw[entry.subject]))
  }
  const calls = fetch.mock.calls.length, before = changes(f)
  const old = result(await f.cli(['setup', 'inspect', '--operation-id', f.input.operationId, '--application-inspection', '--inspection-step', original.stepId, '--inspection-limit', '1']))
  expect(selected(old)).toEqual(original); expect(old.applicationInspection?.readResult).toBeUndefined()
  expect(old.applicationInspection?.applicationInfoReadPermission).toBe('confirmed')
  expect(f.services.database!.prepare('SELECT record_json,private_ref FROM connection_setup_inspection WHERE step_id=?').get(original.stepId)).toEqual(originalBytes)
  const listing = await f.sdk.call('connection.setup.ls', { connectionId: f.input.connectionId }); assertPrivateFree(listing)
  expect(JSON.stringify(listing)).not.toContain('readResult'); expect(changes(f)).toEqual(before)
  expect(await f.sdk.call('connection.service.get', {})).toEqual(off.service)
  expect((await f.sdk.call('connection.inspect', { operationId: 'settings-original-save' })).operation).toEqual(f.saved)
  f.services.database!.exec('PRAGMA wal_checkpoint(FULL)')
  const bytes = await readFile(join(f.directory, 'connections.sqlite'))
  for (const secret of [SECRET, PRIVATE, TOKEN, FLOW, SESSION, READ_COOKIE, ...accounts.flatMap(a => [a.user, a.tenant, a.csrf])]) expect(bytes.includes(Buffer.from(secret))).toBe(false)
  await f.close(); await f.reopen(true)
  for (const receipt of receipts) {
    const retained = await inspect(f, receipt.stepId)
    expect(selected(retained)).toEqual(receipt); expect(retained.applicationInspection?.readResult).toEqual(expected[receipt.subject!])
    expect(retained.applicationInspection?.actions).toEqual([])
  }
  expect(fetch).toHaveBeenCalledTimes(calls)
}, 60_000)

it('native fields stay subject-specific and missing metadata or unsupported event modes never acquire display defaults or bot readiness', async () => {
  const f = await fixture(); let data: unknown = {}
  const fetch = vi.fn(nativeRoute(async () => Response.json({ code: 0, data })).route); vi.stubGlobal('fetch', fetch); await confirmed(f)
  for (const [eventMode, transport] of [[1, 'webhook'], [2, 'function'], [3, 'function'], [4, 'persistent-connection'], [0, 'unknown'], ['4', 'unknown'], [undefined, 'unknown']] as const) {
    data = eventMode === undefined ? {} : { eventMode }
    const view = await f.sdk.call('connection.setup.advance', action(await inspect(f), 'read-event-settings'))
    expect(selected(view)).toMatchObject({ subject: 'event-settings', request: 'confirmed', secureStorage: 'stored' })
    expect(view.applicationInspection?.readResult).toEqual({ subject: 'event-settings', transport })
  }
  data = { name: { secret: PRIVATE }, desc: 42, avatar: PRIVATE }
  const missing = await f.sdk.call('connection.setup.advance', action(await inspect(f), 'read-application-details'))
  expect(missing.applicationInspection?.readResult).toEqual({ subject: 'application-details', name: null, description: null })
  data = { name: 'n'.repeat(513), desc: 'd'.repeat(4097) }
  const bounded = (await f.sdk.call('connection.setup.advance', action(await inspect(f), 'read-application-details'))).applicationInspection?.readResult
  expect(bounded?.subject).toBe('application-details')
  if (bounded?.subject === 'application-details') {
    expect(bounded.name === null || bounded.name.length <= 512).toBe(true)
    expect(bounded.description === null || bounded.description.length <= 4096).toBe(true)
  }
  for (const subject of ['callback-settings', 'bot-settings'] as const) {
    data = { name: 'Not application metadata', eventMode: 4, callbackMode: 2, cardCallbackMode: 4, enable: true, botMenuEnable: true, secret: PRIVATE }
    const view = await f.sdk.call('connection.setup.advance', action(await inspect(f), kinds[subject]))
    expect(view.applicationInspection?.readResult).toEqual({ subject }); assertPrivateFree(view.applicationInspection)
  }
}, 45_000)

it('failed native observations and an unrecoverable original result do not block another explicit read subject or replay old work', async () => {
  const f = await fixture(); let respond = async () => Response.json({ code: 0, data: raw['callback-settings'] })
  const fetch = vi.fn(nativeRoute(async subject => subject === 'callback-settings' ? await respond() : Response.json({ code: 0, data: raw[subject] })).route)
  vi.stubGlobal('fetch', fetch); const auth = await confirmed(f)
  for (const sample of [
    async () => Response.json({ code: 403, data: raw['callback-settings'] }),
    async () => Response.json({ code: 0, data: raw['callback-settings'] }, { status: 503 }),
    async () => Response.json({ code: 0, data: [] }),
    async () => new Response('{"code":0,', { headers: { 'content-type': 'application/json' } }),
    async () => new Response('callback ready ' + PRIVATE),
    async () => new Response(null, { status: 302, headers: { location: 'https://open.feishu.cn/app' } }),
    async () => { throw new TypeError(PRIVATE) }
  ]) {
    respond = sample
    const input = action(await inspect(f), 'read-callback-settings'), count = fetch.mock.calls.length
    const unknown = await f.sdk.call('connection.setup.advance', input), original = selected(unknown)
    expect(original).toMatchObject({ subject: 'callback-settings', input, request: 'unknown' })
    expect(unknown.applicationInspection?.readResult).toBeUndefined(); assertPrivateFree(unknown.applicationInspection)
    expect(selected(await f.sdk.call('connection.setup.advance', input))).toEqual(original)
    expect(fetch.mock.calls.length - count).toBe(1)
  }
  const fail = vi.spyOn(f.encryption, 'encryptString').mockImplementationOnce(() => { throw new Error('fixture-original-result-not-written') })
  const input = action(await inspect(f), 'read-event-settings'), uncertain = selected(await f.sdk.call('connection.setup.advance', input)); fail.mockRestore()
  expect(uncertain).toMatchObject({ subject: 'event-settings', request: 'confirmed', secureStorage: 'unknown' })
  const calls = fetch.mock.calls.length
  await f.close(); await f.reopen()
  const unrecovered = await f.sdk.call('connection.setup.advance', action(await inspect(f, uncertain.stepId), 'recover-application-inspection'))
  expect(selected(unrecovered)).toEqual(uncertain); expect(unrecovered.applicationInspection?.readResult).toBeUndefined()
  expect(fetch).toHaveBeenCalledTimes(calls)
  const fresh = await f.sdk.call('connection.setup.advance', action(await inspect(f, uncertain.stepId), 'read-bot-settings'))
  expect(fresh.applicationInspection?.readResult).toEqual({ subject: 'bot-settings' })
  expect(fresh.operation?.authentication).toEqual(auth.operation?.authentication)
  expect(selected(await inspect(f, uncertain.stepId))).toEqual(uncertain)
  expect(selected(await f.sdk.call('connection.setup.advance', input))).toEqual(uncertain)
  expect(fetch.mock.calls.length - calls).toBe(1)
  expect((await f.sdk.call('connection.inspect', { operationId: 'settings-original-save' })).operation).toEqual(f.saved)
}, 60_000)

it('an exact new-subject vault ACK remains locally recoverable after account renewal, target revision, missing adapter and reopen without activating stale summary', async () => {
  const f = await fixture(), native = nativeRoute(), fetch = vi.fn(native.route); vi.stubGlobal('fetch', fetch); await confirmed(f)
  const input = action(await inspect(f), 'read-event-settings'), originalStore = DesktopConnectorSecrets.prototype.store
  const fault = vi.spyOn(DesktopConnectorSecrets.prototype, 'store').mockImplementationOnce(async function(this: DesktopConnectorSecrets, value) {
    await originalStore.call(this, value); throw new Error('fixture-original-settings-ack-lost')
  })
  const uncertain = await f.sdk.call('connection.setup.advance', input), receipt = selected(uncertain); fault.mockRestore()
  expect(receipt).toMatchObject({ subject: 'event-settings', input, request: 'confirmed', secureStorage: 'unknown' })
  expect(uncertain.applicationInspection?.readResult).toBeUndefined()
  native.account(1)
  const renewed = await f.sdk.call('connection.setup.advance', action(await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId }), 'renew'))
  const current = await confirmed(f, renewed)
  const revised = await f.sdk.call('connection.configure', { operationId: 'settings-revised-target', expectedRevision: 1, connection: { ...f.config, label: 'Revised saved bot label' } })
  const calls = fetch.mock.calls.length
  await f.close(); await f.reopen(true)
  const before = changes(f), local = await inspect(f, receipt.stepId)
  expect(selected(local)).toEqual(receipt); expect(local.applicationInspection?.readResult).toBeUndefined()
  expect(changes(f)).toEqual(before); expect(fetch).toHaveBeenCalledTimes(calls)
  const recovery = action(local, 'recover-application-inspection')
  expect(recovery.expectedRevision).toBe(input.expectedRevision)
  const recovered = await f.sdk.call('connection.setup.advance', recovery)
  expect(selected(recovered)).toEqual({ ...receipt, secureStorage: 'stored' })
  expect(recovered.applicationInspection?.readResult).toBeUndefined()
  expect(recovered.operation?.authentication).toEqual(current.operation?.authentication)
  const repeated = await f.sdk.call('connection.setup.advance', input)
  expect(selected(repeated)).toEqual(selected(recovered)); expect(repeated.applicationInspection?.readResult).toBeUndefined()
  await f.close(); await f.reopen(true)
  expect(selected(await inspect(f, receipt.stepId))).toEqual(selected(recovered)); expect(fetch).toHaveBeenCalledTimes(calls)
  expect((await f.sdk.call('connection.inspect', { connectionId: f.config.connectionId })).connection).toEqual(revised.connection)
  expect((await f.sdk.call('connection.inspect', { operationId: 'settings-original-save' })).operation).toEqual(f.saved)
}, 60_000)

it('a new read keeps exact offered revision and actor fences without taking away the original authentication or saved bot', async () => {
  const f = await fixture(), fetch = vi.fn(nativeRoute().route); vi.stubGlobal('fetch', fetch); const auth = await confirmed(f)
  const offered = await inspect(f), input = action(offered, 'read-event-settings'), count = fetch.mock.calls.length
  const service = new AgentMuxRpcService({ connections: f.services.connections }); clean.push(() => service.dispose())
  const foreign = { principal: { kind: 'device' as const, id: 'foreign-settings-device' } }
  await expect(service.call('connection.setup.advance', input, {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(service.call('connection.setup.advance', input, foreign)).rejects.toMatchObject({ code: expect.stringMatching(/^(?:CONTROL_PERMISSION_DENIED|CONNECTION_SETUP_AUTHORITY_REQUIRED)$/u) })
  for (const wrong of [{ ...input, expectedRevision: input.expectedRevision + 1 }, { ...input, decision: { ...input.decision, value: 'confirm' as const } }]) {
    await expect(f.sdk.call('connection.setup.advance', wrong)).rejects.toMatchObject({ code: 'CONNECTION_SETUP_ACTION_STALE' })
  }
  expect((await inspect(f)).applicationInspection).toEqual(offered.applicationInspection); expect(fetch).toHaveBeenCalledTimes(count)
  const observed = await f.sdk.call('connection.setup.advance', input), receipt = selected(observed)
  expect(observed.applicationInspection?.readResult).toEqual({ subject: 'event-settings', transport: 'persistent-connection' })
  await expect(f.sdk.call('connection.setup.advance', { ...input, expectedRevision: input.expectedRevision + 1 })).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
  await expect(service.call('connection.setup.inspect', { operationId: f.input.operationId, applicationInspection: { selectedStepId: receipt.stepId } }, foreign)).rejects.toMatchObject({ code: expect.stringMatching(/^(?:CONTROL_PERMISSION_DENIED|CONNECTION_SETUP_AUTHORITY_REQUIRED)$/u) })
  expect(selected(await inspect(f, receipt.stepId))).toEqual(receipt)
  expect((await inspect(f)).operation?.authentication).toEqual(auth.operation?.authentication)
  expect(fetch.mock.calls.length - count).toBe(1)
  expect((await f.sdk.call('connection.inspect', { operationId: 'settings-original-save' })).operation).toEqual(f.saved)
}, 45_000)

it.each(['account', 'revision'] as const)('a late native app result cannot cross a newer %s or overwrite the selected original child', async change => {
  const f = await fixture(), entered = deferred<void>(), response = deferred<Response>(); let reads = 0
  const native = nativeRoute(async subject => {
    if (subject === 'application-details' && ++reads === 1) { entered.resolve(); return await response.promise }
    return Response.json({ code: 0, data: { ...raw[subject], name: 'Latest account bot label' } })
  })
  const fetch = vi.fn(native.route); vi.stubGlobal('fetch', fetch); clean.push(() => response.resolve(Response.json({ code: 0, data: raw['application-details'] })))
  await confirmed(f)
  const input = action(await inspect(f), 'read-application-details'), pending = f.sdk.call('connection.setup.advance', input)
  expect(await Promise.race([entered.promise.then(() => true), pending.then(() => false)])).toBe(true)
  let latest: ConnectionSetupView | undefined, revised: unknown
  if (change === 'account') {
    native.account(1)
    const renewed = await f.sdk.call('connection.setup.advance', action(await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId }), 'renew'))
    const account = await confirmed(f, renewed)
    expect(account.continuation?.account).toEqual({ userId: accounts[1].user, tenantId: accounts[1].tenant })
    latest = await f.sdk.call('connection.setup.advance', action(await inspect(f), 'read-application-details'))
    expect(latest.applicationInspection?.readResult).toEqual({ subject: 'application-details', name: 'Latest account bot label', description: raw['application-details'].desc })
  } else revised = (await f.sdk.call('connection.configure', { operationId: 'settings-late-target-revision', expectedRevision: 1, connection: { ...f.config, label: 'Target changed while reading' } })).connection
  response.resolve(Response.json({ code: 0, data: raw['application-details'] }))
  const late = await pending
  expect(selected(late)).toMatchObject({ subject: 'application-details', input })
  expect(late.applicationInspection?.readResult).toBeUndefined(); expect(JSON.stringify(late)).not.toContain(raw['application-details'].name)
  const now = await inspect(f)
  if (latest) {
    expect(now.applicationInspection?.selected).toEqual(selected(latest)); expect(now.applicationInspection?.readResult).toEqual(latest.applicationInspection?.readResult)
    expect(now.operation?.authentication).toEqual(latest.operation?.authentication); expect(now.continuation?.account).toEqual(latest.continuation?.account)
  } else {
    expect(now.applicationInspection?.readResult).toBeUndefined()
    expect((await f.sdk.call('connection.inspect', { connectionId: f.config.connectionId })).connection).toEqual(revised)
  }
  expect((await f.sdk.call('connection.inspect', { operationId: 'settings-original-save' })).operation).toEqual(f.saved)
}, 60_000)

async function wireFault(f: Fixture) {
  const path = join(f.root, 'wire.sock'), sockets = new Set<Socket>(); let corrupt: (original: ConnectionSetupView) => unknown = value => value
  const originals: ConnectionSetupView[] = []
  const server = createServer(client => {
    const owner = createConnection(f.socketPath); sockets.add(client); sockets.add(owner)
    client.on('error', () => owner.destroy()); owner.on('error', () => client.destroy())
    client.once('close', () => { sockets.delete(client); owner.destroy() }); owner.once('close', () => { sockets.delete(owner); client.end() }); client.pipe(owner)
    let pending = ''; owner.setEncoding('utf8'); owner.on('data', chunk => {
      pending += chunk
      for (;;) {
        const newline = pending.indexOf('\n'); if (newline < 0) break
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1); if (!line) continue
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

it('real SDK and compiled CLI strictly reject a read summary for another subject, unsafe fields, invalid public enums or unconfirmed storage on the actual forwarded owner result', async () => {
  const f = await fixture(), fetch = vi.fn(nativeRoute().route); vi.stubGlobal('fetch', fetch); await confirmed(f)
  const records = new Map<ConnectionSetupReadSubject, ConnectionSetupInspectionReceipt>()
  for (const subject of subjects) records.set(subject, selected(await f.sdk.call('connection.setup.advance', action(await inspect(f), kinds[subject]))))
  const wire = await wireFault(f), calls = fetch.mock.calls.length, before = changes(f)
  const samples: Array<{ subject: ConnectionSetupReadSubject; corrupt: (value: ConnectionSetupView) => unknown }> = [
    { subject: 'application-details', corrupt: value => ({ ...value, applicationInspection: { ...value.applicationInspection!, readResult: { subject: 'bot-settings' } } }) },
    { subject: 'application-details', corrupt: value => ({ ...value, applicationInspection: { ...value.applicationInspection!, selected: null, observations: [] } }) },
    { subject: 'application-details', corrupt: value => ({ ...value, applicationInspection: { ...value.applicationInspection!, selected: { ...selected(value), secureStorage: 'unknown' }, observations: [] } }) },
    { subject: 'application-details', corrupt: value => ({ ...value, applicationInspection: { ...value.applicationInspection!, applicationInfoReadPermission: 'confirmed' } }) },
    { subject: 'application-details', corrupt: value => ({ ...value, applicationInspection: { ...value.applicationInspection!, readResult: { subject: 'application-details', name: 'n'.repeat(513), description: null } } }) },
    { subject: 'application-details', corrupt: value => ({ ...value, applicationInspection: { ...value.applicationInspection!, readResult: { ...value.applicationInspection!.readResult!, appSecret: PRIVATE + '-wire-secret' } } }) },
    { subject: 'event-settings', corrupt: value => ({ ...value, applicationInspection: { ...value.applicationInspection!, readResult: { subject: 'event-settings', transport: 4 } } }) },
    { subject: 'bot-settings', corrupt: value => ({ ...value, applicationInspection: { ...value.applicationInspection!, readResult: { subject: 'bot-settings', enabled: true } } }) }
  ]
  const outcomes = []
  for (const sample of samples) {
    const stepId = records.get(sample.subject)!.stepId; wire.fault(sample.corrupt)
    const sdk = await wire.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationInspection: { selectedStepId: stepId } }).then(() => ({ accepted: true, code: null }), error => ({ accepted: false, code: error.code }))
    const output = await f.cli(['setup', 'inspect', '--operation-id', f.input.operationId, '--application-inspection', '--inspection-step', stepId], undefined, wire.path)
    const error = output.code === 0 ? null : JSON.parse(output.stderr)
    outcomes.push({ sdk, cli: { accepted: output.code === 0, operation: error?.operation ?? null, code: error?.error?.code ?? null } })
    expect(output.stdout + output.stderr).not.toContain(PRIVATE + '-wire-secret')
  }
  expect(outcomes).toEqual(samples.map(() => ({ sdk: { accepted: false, code: 'CONTROL_PROTOCOL_ERROR' }, cli: { accepted: false, operation: 'connection.setup.inspect', code: 'CONTROL_PROTOCOL_ERROR' } })))
  wire.fault(value => value)
  const retained = await inspect(f, records.get('event-settings')!.stepId)
  expect(await wire.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationInspection: { selectedStepId: records.get('event-settings')!.stepId } })).toEqual(retained)
  expect(result(await f.cli(['setup', 'inspect', '--operation-id', f.input.operationId, '--application-inspection', '--inspection-step', records.get('bot-settings')!.stepId], undefined, wire.path)).applicationInspection?.readResult).toEqual({ subject: 'bot-settings' })
  expect(wire.originals.length).toBeGreaterThan(samples.length); expect(changes(f)).toEqual(before); expect(fetch).toHaveBeenCalledTimes(calls)
}, 60_000)

function childMessage(child: ChildProcess, kind: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (value: unknown) => {
      if (value && typeof value === 'object' && (value as { kind?: string }).kind === kind) {
        child.off('message', onMessage); child.off('exit', onExit); resolve(value as Record<string, unknown>)
      }
    }
    const onExit = () => { child.off('message', onMessage); reject(new Error('Settings owner exited before ' + kind)) }
    child.on('message', onMessage); child.once('exit', onExit)
  })
}

it.each(['inflight', 'vault-committed'] as const)('actual process restart preserves the original %s data-subject receipt and local recovery without another native read or loaded adapter', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'setup-settings-child-')); clean.push(() => rm(root, { recursive: true, force: true }))
  const start = async (fault: string) => {
    const child = fork(new URL('./fixtures/connection-setup-settings-owner.mjs', import.meta.url), [root, fault], { execArgv: ['--experimental-transform-types'], env: objectCliEnvironment(root), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    clean.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit') } })
    let errors = ''; child.stderr!.on('data', value => { errors += value })
    const ready = await childMessage(child, 'ready').catch(error => { throw new Error(errors || String(error)) })
    return { child, ready }
  }
  const first = await start(mode), socketPath = join(root, 'owner.sock')
  const cli = (args: string[], body?: unknown) => runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', ...args], objectCliEnvironment(root), body === undefined ? '' : JSON.stringify(body))
  const config: ConnectionConfig = { connectionId: 'settings-saved-bot', adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: 'cli_settings_original_bot' }, label: 'Original saved settings bot', enabled: false, credentialRef: String(first.ready.credentialRef) }
  const saved = result(await cli(['configure', '--input', '-'], { operationId: 'settings-child-save', expectedRevision: null, connection: config }))
  const input: ConnectionSetupBegin = { operationId: 'settings-child-management', connectionId: config.connectionId, expectedConnectionRevision: 1, goal }
  let view = result(await cli(['setup', 'begin', '--input', '-'], input))
  for (let step = 0; step < 8 && view.continuation?.stage !== 'account'; step++) view = result(await cli(['setup', 'advance', '--input', '-'], action(view, 'continue')))
  expect(view.continuation?.stage).toBe('account')
  view = result(await cli(['setup', 'advance', '--input', '-'], action(view, 'confirm-account')))
  const authentication = view.operation!.authentication!
  const originalInput = action(result(await cli(['setup', 'inspect', '--operation-id', input.operationId, '--application-inspection'])), 'read-event-settings')
  const entered = childMessage(first.child, mode === 'inflight' ? 'read-started' : 'vault-committed'), pending = cli(['setup', 'advance', '--input', '-'], originalInput)
  expect(await Promise.race([entered.then(() => true), pending.then(() => false)])).toBe(true)
  const original = selected(result(await cli(['setup', 'inspect', '--operation-id', input.operationId, '--application-inspection'])))
  expect(original).toMatchObject({ subject: 'event-settings', input: originalInput, request: mode === 'inflight' ? 'dispatching' : 'confirmed' })
  first.child.kill('SIGKILL'); await once(first.child, 'exit'); expect((await pending).code).not.toBe(0)
  const effects = await readFile(join(root, 'native-effects.ndjson'), 'utf8')
  await start('observe-only')
  const observed = result(await cli(['setup', 'inspect', '--operation-id', input.operationId, '--application-inspection', '--inspection-step', original.stepId]))
  expect(selected(observed)).toMatchObject({ stepId: original.stepId, subject: 'event-settings', input: originalInput })
  expect(observed.operation?.authentication).toEqual(authentication); expect(observed.applicationInspection?.readResult).toBeUndefined()
  if (mode === 'inflight') {
    expect(selected(observed).request).toBe('unknown')
    expect(selected(result(await cli(['setup', 'advance', '--input', '-'], originalInput)))).toEqual(selected(observed))
  } else {
    expect(selected(observed).secureStorage).not.toBe('stored')
    const recovered = result(await cli(['setup', 'advance', '--input', '-'], action(observed, 'recover-application-inspection')))
    expect(selected(recovered)).toEqual({ ...original, secureStorage: 'stored' })
    expect(recovered.applicationInspection?.readResult).toEqual({ subject: 'event-settings', transport: 'persistent-connection' })
    expect(selected(result(await cli(['setup', 'advance', '--input', '-'], originalInput)))).toEqual(selected(recovered))
  }
  expect(await readFile(join(root, 'native-effects.ndjson'), 'utf8')).toBe(effects)
  const nativeReads = effects.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.path.startsWith('/developers/'))
  expect(nativeReads).toEqual([{ origin: 'https://open.feishu.cn', method: 'POST', path: '/developers/v1/event/' + config.application.appId, body: '{"needEventDetail":true}' }])
  expect(result<{ operation: unknown }>(await cli(['inspect', '--operation-id', 'settings-child-save'])).operation).toEqual(saved)
  expect(result<{ connection: unknown }>(await cli(['inspect', '--connection', config.connectionId])).connection).toMatchObject({ config, revision: 1 })
}, 60_000)
