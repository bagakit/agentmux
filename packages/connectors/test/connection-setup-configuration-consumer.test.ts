import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { DesktopConnectorSecrets } from '../../../apps/desktop/src/main/connector-secrets.js'
import { AgentMuxControlServer, AgentMuxRpcService, connectAgentMuxRpc } from '@agentmux/core'
import type { ConnectionConfig, ConnectionSetupAction, ConnectionSetupAdvance, ConnectionSetupBegin, ConnectionSetupInspectionReceipt, ConnectionSetupConfigurationReceipt, ConnectionSetupReadSubject, ConnectionSetupView } from '@agentmux/core/connections'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { enrollmentEncryption } from './fixtures/connection-enrollment.js'
import { objectCliEnvironment, runCompiledObjectCli, type CliResult } from '../../core/test/helpers/object-cli-rpc.js'

const SECRET = 'fixture-configuration-saved-secret', TOKEN = 'fixture-configuration-qr-token', FLOW = 'fixture-configuration-flow-key'
const SESSION = 'fixture-configuration-session-cookie', READ_COOKIE = 'fixture-configuration-business-cookie', PRIVATE = 'fixture-configuration-private'
const accounts = [
  { user: 'fixture-configuration-user-a', tenant: 'fixture-configuration-tenant-a', csrf: 'fixture-configuration-csrf-a' },
  { user: 'fixture-configuration-user-b', tenant: 'fixture-configuration-tenant-b', csrf: 'fixture-configuration-csrf-b' }
]
const kinds = { 'application-details': 'read-application-details', 'event-settings': 'read-event-settings', 'callback-settings': 'read-callback-settings', 'bot-settings': 'read-bot-settings' } as const
const paths = { 'application-details': '/developers/v1/app/', 'event-settings': '/developers/v1/event/', 'callback-settings': '/developers/v1/callback/', 'bot-settings': '/developers/v1/robot/' } as const
const subjects = Object.keys(kinds) as ConnectionSetupReadSubject[]
const raw = {
  'application-details': { name: 'Saved bot label', desc: 'Bot description from the native object', appSecret: PRIVATE + '-application-details', ignored: { memberId: PRIVATE + '-member' } },
  'event-settings': { eventMode: 4, eventDetails: [{ items: [{ id: PRIVATE + '-event-id' }] }], appEventDetails: [], userEventDetails: [], encryptionKey: PRIVATE + '-event-settings' },
  'callback-settings': { callbackMode: 4, eventMode: 4, callbacks: [PRIVATE + '-callback-id'], verificationToken: PRIVATE + '-callback-settings' },
  'bot-settings': { enable: false, botMenuEnable: true, eventMode: 4, cardCallbackMode: 1, botMenuConfig: [{ eventKey: PRIVATE + '-bot-settings' }] }
}
const goal = { kind: 'agent-conversation', interaction: 'messages' } as const
const clean: Array<() => void | Promise<void>> = []
async function cleanup(steps: Array<() => void | Promise<void>>) {
  const errors: unknown[] = []
  for (const step of steps) { try { await step() } catch (error) { errors.push(error) } }
  if (errors.length) throw new AggregateError(errors, 'Owned configuration test cleanup failed')
}
afterEach(async () => { await cleanup([() => { vi.restoreAllMocks() }, () => { vi.unstubAllGlobals() }, ...clean.splice(0).reverse()]) })
function result<T = ConnectionSetupView>(output: CliResult): T { expect(output.code, output.stdout + output.stderr).toBe(0); return JSON.parse(output.stdout).result }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function action(view: ConnectionSetupView, kind: ConnectionSetupAction['kind']): ConnectionSetupAdvance {
  const offered = kind === 'enable-messaging' || kind === 'recover-configuration-effect' ? view.applicationConfiguration?.actions : kind === 'continue' || kind === 'confirm-account' || kind === 'renew' ? view.continuation?.actions : view.applicationInspection?.actions
  const matches = offered?.filter(a => a.kind === kind) ?? []
  expect(matches, 'One exact offered ' + kind).toHaveLength(1)
  expect(matches[0]).toMatchObject({ actionId: expect.any(String), expectedRevision: expect.any(Number) })
  return { operationId: view.operation!.operationId, expectedRevision: matches[0].expectedRevision, decision: { actionId: matches[0].actionId, value: kind === 'confirm-account' || kind === 'enable-messaging' ? 'confirm' : kind === 'renew' ? 'renew' : 'continue' } }
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
function nativeRoute(read: (subject: ConnectionSetupReadSubject, target: URL, init: RequestInit) => Promise<Response> = async subject => Response.json({ code: 0, data: raw[subject] }), write: (target: URL, init: RequestInit) => Promise<Response> = async () => Response.json({ code: 0, data: { privateReceipt: PRIVATE + '-effect' } })) {
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
    if (target.pathname.startsWith('/developers/v1/robot/switch/')) return await write(target, init)
    const subject = subjects.find(s => target.pathname.startsWith(paths[s]))
    if (subject) return await read(subject, target, init)
    throw new Error('Unexpected configuration native request ' + target.origin + target.pathname)
  }
  return { route, account: (index: number) => { accountIndex = index } }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'setup-configuration-')), directory = join(root, 'connections'), socketPath = join(root, 'owner.sock'), encryption = enrollmentEncryption()
  let services: Awaited<ReturnType<typeof createDesktopConnections>>, server: AgentMuxControlServer, sdk: Awaited<ReturnType<typeof connectAgentMuxRpc>>
  const open = async (missingAdapter = false) => {
    services = await createDesktopConnections({ directory, encryption, ...(missingAdapter ? { adapters: [] } : {}) })
    server = new AgentMuxControlServer({ socketPath, connections: services.connections, coreClients: () => { throw new Error('Configuration cannot borrow an Agent Runtime') } })
    await server.start(); sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  }
  const close = () => cleanup([() => sdk?.dispose(), () => server?.stop(), () => { services?.close() }])
  clean.push(() => cleanup([close, () => rm(root, { recursive: true, force: true })]))
  await open()
  const credential = await services.secrets.store({ operationId: 'configuration-credential', secret: SECRET })
  const config: ConnectionConfig = { connectionId: 'configuration-saved-bot', adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: 'cli_configuration_original_bot' }, label: 'Original saved configuration bot', enabled: false, credentialRef: credential.credentialRef }
  const saved = await sdk.call('connection.configure', { operationId: 'configuration-original-save', expectedRevision: null, connection: config })
  const input: ConnectionSetupBegin = { operationId: 'configuration-original-management', connectionId: config.connectionId, expectedConnectionRevision: saved.connection.revision, goal }
  const cli = (args: string[], body?: unknown, endpoint = socketPath) => runCompiledObjectCli(['--endpoint', 'unix:' + endpoint, 'connection', ...args], objectCliEnvironment(root), body === undefined ? '' : JSON.stringify(body))
  return { root, directory, socketPath, config, saved, input, encryption, cli, close, reopen: open, get sdk() { return sdk }, get services() { return services } }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
const readInspect = (f: Fixture, selectedStepId?: string) => f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationInspection: selectedStepId ? { selectedStepId } : {} })
async function confirmed(f: Fixture, view?: ConnectionSetupView) {
  view ??= result(await f.cli(['setup', 'begin', '--input', '-'], f.input))
  for (let step = 0; step < 8 && view.continuation?.stage !== 'account'; step++) view = await f.sdk.call('connection.setup.advance', action(view, 'continue'))
  expect(view.continuation?.stage).toBe('account')
  const value = result(await f.cli(['setup', 'advance', '--input', '-'], action(view, 'confirm-account')))
  expect(value.continuation?.stage).toBe('confirmed'); return value
}
const changes = (f: Fixture) => f.services.database!.prepare('SELECT total_changes() AS count').get()

const inspect = (f: Fixture, selectedStepId?: string, operationId = f.input.operationId) => f.sdk.call('connection.setup.inspect', { operationId, applicationConfiguration: selectedStepId ? { effect: 'enable-messaging', selectedStepId } : { effect: 'enable-messaging' } })
function effect(view: ConnectionSetupView): ConnectionSetupConfigurationReceipt {
  expect(view.applicationConfiguration?.selected).toBeDefined(); expect(view.applicationConfiguration?.selected).not.toBeNull()
  return view.applicationConfiguration!.selected!
}
function offeredEnable(view: ConnectionSetupView) { return view.applicationConfiguration!.actions.filter(a => a.kind === 'enable-messaging') }
async function botRead(f: Fixture, operationId = f.input.operationId) {
  const view = await f.sdk.call('connection.setup.inspect', { operationId, applicationInspection: {} })
  return await f.sdk.call('connection.setup.advance', action(view, 'read-bot-settings'))
}
function readBytes(f: Fixture, stepId: string) {
  const row = f.services.database!.prepare('SELECT record_json,private_ref FROM connection_setup_inspection WHERE step_id=?').get(stepId)
  expect(row).toMatchObject({ record_json: expect.any(String) }); return row
}

it('SDK and compiled CLI explicitly enable one exact original bot with a durable preclaim, separate acceptance and unchanged read, auth and disabled-service facts', async () => {
  const f = await fixture(), captured: Array<{ target: URL; init: RequestInit; claim: ConnectionSetupConfigurationReceipt }> = []
  const fetch = vi.fn(nativeRoute(undefined, async (target, init) => {
    captured.push({ target, init, claim: effect(await inspect(f)) })
    return Response.json({ code: 0, data: { privateReceipt: PRIVATE + '-effect' } })
  }).route); vi.stubGlobal('fetch', fetch)
  const off = await f.sdk.call('connection.service.configure', { operationId: 'configuration-service-off', expectedRevision: 0, service: { enabled: false } })
  const auth = await confirmed(f), read = await botRead(f), source = selected(read), bytes = readBytes(f, source.stepId)
  expect(read.applicationInspection?.readResult).toEqual({ subject: 'bot-settings' })
  const before = changes(f), calls = fetch.mock.calls.length
  const offered = result(await f.cli(['setup', 'inspect', '--operation-id', f.input.operationId, '--application-configuration', 'enable-messaging']))
  expect(offered.applicationConfiguration).toMatchObject({ source, capability: 'disabled', effects: [], selected: null })
  expect(changes(f)).toEqual(before); expect(fetch).toHaveBeenCalledTimes(calls)
  const input = action(offered, 'enable-messaging')
  expect(input.decision.value).toBe('confirm')
  const store = vi.spyOn(DesktopConnectorSecrets.prototype, 'store')
  const accepted = result(await f.cli(['setup', 'advance', '--input', '-'], input)), receipt = effect(accepted)
  expect(receipt).toMatchObject({ effect: 'enable-messaging', sourceStepId: source.stepId, input, request: 'confirmed', secureStorage: 'stored' })
  expect(accepted.receipt).toMatchObject({ actionId: input.decision.actionId, stepId: receipt.stepId, state: 'confirmed' })
  expect(accepted.applicationConfiguration?.capability).not.toBe('enabled')
  expect(accepted.applicationConfiguration).not.toHaveProperty('online'); expect(accepted.applicationConfiguration).not.toHaveProperty('ready')
  expect(accepted.operation?.authentication).toEqual(auth.operation?.authentication)
  expect(captured).toHaveLength(1)
  const entry = captured[0]
  expect(entry.target.href).toBe('https://open.feishu.cn/developers/v1/robot/switch/' + f.config.application.appId)
  expect(entry.init).toMatchObject({ method: 'POST', redirect: 'manual' }); expect(JSON.parse(String(entry.init.body))).toEqual({ enable: true })
  expect(entry.claim).toEqual({ ...receipt, request: 'dispatching', secureStorage: 'not-started' })
  const headers = new Headers(entry.init.headers)
  expect(headers.get('content-type')).toMatch(/^application\/json\b/u); expect(headers.get('x-csrf-token')).toBe(accounts[0].csrf)
  expect(headers.get('x-timezone-offset')).toBe(String(new Date().getTimezoneOffset()))
  expect(headers.get('x-flow-key')).toBeNull(); expect(headers.get('X-AppPlatform-RequestFrom')).toBeNull()
  expect((headers.get('cookie') ?? '').split(';').map(x => x.trim()).sort()).toEqual([`session=${SESSION}`, `readScope=${READ_COOKIE}`].sort())
  expect(store.mock.calls.filter(([input]) => input.secret.includes(PRIVATE + '-effect'))).toHaveLength(1)
  expect(effect(await f.sdk.call('connection.setup.advance', input))).toEqual(receipt)
  const local = result(await f.cli(['setup', 'inspect', '--operation-id', f.input.operationId, '--application-configuration', 'enable-messaging', '--configuration-step', receipt.stepId, '--configuration-limit', '1']))
  expect(local.applicationConfiguration?.effects).toEqual([receipt]); expect(local.applicationConfiguration?.next).toBeNull()
  expect(effect(local)).toEqual(receipt); assertPrivateFree(local.applicationConfiguration)
  const reads = await readInspect(f)
  expect(reads.applicationInspection?.observations).toEqual([source]); expect(reads.applicationInspection?.readResult).toEqual({ subject: 'bot-settings' })
  expect(readBytes(f, source.stepId)).toEqual(bytes)
  const list = await f.sdk.call('connection.setup.ls', { connectionId: f.input.connectionId }); assertPrivateFree(list)
  expect(list.support?.capabilities).toEqual(['management-authentication', 'application-inspection', 'messaging-capability', 'persistent-event-transport', 'application-permissions', 'message-reception', 'card-actions', 'application-publication', 'enrollment-continuation', 'initial-setup'])
  expect(JSON.stringify(list)).not.toContain('sourceStepId')
  expect(await f.sdk.call('connection.service.get', {})).toEqual(off.service)
  expect((await f.sdk.call('connection.inspect', { operationId: 'configuration-original-save' })).operation).toEqual(f.saved)
  expect((await f.sdk.call('connection.inspect', { connectionId: f.config.connectionId })).connection).toEqual(f.saved.connection)
  expect(fetch.mock.calls.length - calls).toBe(1)
  f.services.database!.exec('PRAGMA wal_checkpoint(FULL)')
  const disk = await readFile(join(f.directory, 'connections.sqlite'))
  for (const secret of [SECRET, TOKEN, FLOW, SESSION, READ_COOKIE, PRIVATE, ...accounts.flatMap(a => [a.user, a.tenant, a.csrf])]) expect(disk.includes(Buffer.from(secret))).toBe(false)
}, 60_000)

it('capability interpretation is local and uses only the exact stored raw boolean, without inheriting UI bot defaults or readiness', async () => {
  const f = await fixture(); let data: unknown = {}
  const fetch = vi.fn(nativeRoute(async subject => Response.json({ code: 0, data: subject === 'bot-settings' ? data : raw[subject] })).route)
  vi.stubGlobal('fetch', fetch); await confirmed(f)
  for (const [sample, capability] of [[{}, 'unknown'], [{ botMenuEnable: false }, 'unknown'], [{ enable: 'false' }, 'unknown'], [{ enable: 0 }, 'unknown'], [{ enable: null }, 'unknown'], [{ enable: true }, 'enabled'], [{ enable: false }, 'disabled']] as const) {
    data = sample
    const read = await botRead(f), source = selected(read), calls = fetch.mock.calls.length, before = changes(f)
    expect(read.applicationInspection?.readResult).toEqual({ subject: 'bot-settings' })
    const view = await inspect(f)
    expect(view.applicationConfiguration?.source).toEqual(source); expect(view.applicationConfiguration?.capability).toBe(capability)
    expect(offeredEnable(view)).toHaveLength(capability === 'disabled' ? 1 : 0)
    assertPrivateFree(view.applicationConfiguration)
    expect(fetch).toHaveBeenCalledTimes(calls); expect(changes(f)).toEqual(before)
  }
  expect(fetch.mock.calls.filter(([url]) => String(url).includes('/robot/switch/'))).toEqual([])
}, 45_000)

it('later bot observations including unknown supersede old false and local selection cannot revive an obsolete enable action', async () => {
  const f = await fixture(); let response = async () => Response.json({ code: 0, data: { enable: false } })
  const fetch = vi.fn(nativeRoute(async subject => subject === 'bot-settings' ? await response() : Response.json({ code: 0, data: raw[subject] })).route)
  vi.stubGlobal('fetch', fetch); await confirmed(f)
  const first = selected(await botRead(f)), firstBytes = readBytes(f, first.stepId), old = action(await inspect(f), 'enable-messaging')
  response = async () => Response.json({ code: 0, data: { enable: true } })
  const newer = selected(await botRead(f))
  await readInspect(f, first.stepId)
  const current = await inspect(f)
  expect(current.applicationConfiguration?.source).toEqual(newer); expect(current.applicationConfiguration?.capability).toBe('enabled'); expect(offeredEnable(current)).toEqual([])
  await expect(f.sdk.call('connection.setup.advance', old)).rejects.toMatchObject({ code: 'CONNECTION_SETUP_ACTION_STALE' })
  response = async () => Response.json({ code: 0, data: [] })
  const unknown = selected(await botRead(f)); expect(unknown.request).toBe('unknown')
  await readInspect(f, first.stepId)
  const unavailable = await inspect(f)
  expect(unavailable.applicationConfiguration?.capability).toBe('unknown'); expect(offeredEnable(unavailable)).toEqual([])
  await expect(f.sdk.call('connection.setup.advance', old)).rejects.toMatchObject({ code: 'CONNECTION_SETUP_ACTION_STALE' })
  expect(readBytes(f, first.stepId)).toEqual(firstBytes)
  expect(fetch.mock.calls.filter(([url]) => String(url).includes('/robot/switch/'))).toEqual([])
  expect((await f.sdk.call('connection.inspect', { operationId: 'configuration-original-save' })).operation).toEqual(f.saved)
}, 45_000)

it.each([null, undefined])('code0 write acceptance with data %s is not mistaken for an object-valued read or an enabled observation', async data => {
  const f = await fixture(), fetch = vi.fn(nativeRoute(undefined, async () => Response.json(data === undefined ? { code: 0 } : { code: 0, data })).route)
  vi.stubGlobal('fetch', fetch); await confirmed(f); await botRead(f)
  const input = action(await inspect(f), 'enable-messaging'), accepted = await f.sdk.call('connection.setup.advance', input)
  expect(effect(accepted)).toMatchObject({ input, request: 'confirmed', secureStorage: 'stored' })
  expect(accepted.applicationConfiguration?.capability).not.toBe('enabled')
  expect(effect(await f.sdk.call('connection.setup.advance', input))).toEqual(effect(accepted))
  expect(fetch.mock.calls.filter(([url]) => String(url).includes('/robot/switch/'))).toHaveLength(1)
}, 45_000)

it('unknown original enable cannot be replayed or replaced through renew, ordinary new setup or a known saved target alias while current reads remain available', async () => {
  const f = await fixture(), fetch = vi.fn(nativeRoute(undefined, async () => { throw new TypeError(PRIVATE + '-unknown-native-write') }).route)
  vi.stubGlobal('fetch', fetch); await confirmed(f); await botRead(f)
  const input = action(await inspect(f), 'enable-messaging'), uncertain = effect(await f.sdk.call('connection.setup.advance', input))
  expect(uncertain).toMatchObject({ input, request: 'unknown' })
  expect(effect(await f.sdk.call('connection.setup.advance', input))).toEqual(uncertain)
  const renewed = await f.sdk.call('connection.setup.advance', action(await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId }), 'renew'))
  await confirmed(f, renewed); await botRead(f)
  const afterRenew = await inspect(f)
  expect(offeredEnable(afterRenew)).toEqual([]); expect(afterRenew.applicationConfiguration?.reason).toBe('original-effect-unconfirmed')
  expect(effect(await inspect(f, uncertain.stepId))).toEqual(uncertain)
  const secondInput = { ...f.input, operationId: 'configuration-independent-management' }
  await confirmed(f, await f.sdk.call('connection.setup.begin', secondInput)); await botRead(f, secondInput.operationId)
  const second = await inspect(f, undefined, secondInput.operationId)
  expect(offeredEnable(second)).toEqual([])
  expect(second.applicationConfiguration?.unresolved).toEqual({ operationId: f.input.operationId, connectionId: f.input.connectionId, stepId: uncertain.stepId })
  const alias = { ...f.config, connectionId: 'configuration-known-app-alias', label: 'Another local name for the same exact application' }
  await f.sdk.call('connection.configure', { operationId: 'configuration-save-alias', expectedRevision: null, connection: alias })
  const aliasInput = { ...f.input, operationId: 'configuration-alias-management', connectionId: alias.connectionId }
  await confirmed(f, await f.sdk.call('connection.setup.begin', aliasInput)); await botRead(f, aliasInput.operationId)
  const aliasView = await inspect(f, undefined, aliasInput.operationId)
  expect(offeredEnable(aliasView)).toEqual([])
  const unresolved = aliasView.applicationConfiguration?.unresolved
  expect(unresolved).toEqual({ operationId: f.input.operationId, connectionId: f.input.connectionId, stepId: uncertain.stepId })
  const original = result(await f.cli(['setup', 'inspect', '--operation-id', unresolved!.operationId, '--application-configuration', 'enable-messaging', '--configuration-step', unresolved!.stepId]))
  expect(original.operation?.connectionId).toBe(unresolved!.connectionId); expect(effect(original)).toEqual(uncertain)
  const service = new AgentMuxRpcService({ connections: f.services.connections }); clean.push(() => service.dispose())
  const foreign = { principal: { kind: 'device' as const, id: 'foreign-configuration-history-device' } }, foreignInput = { ...aliasInput, operationId: 'configuration-foreign-alias-management' }
  await service.call('connection.setup.begin', foreignInput, foreign)
  const otherActor = await service.call('connection.setup.inspect', { operationId: foreignInput.operationId, applicationConfiguration: { effect: 'enable-messaging' } }, foreign)
  expect(otherActor.applicationConfiguration?.reason).toBe('original-effect-unconfirmed')
  expect(otherActor.applicationConfiguration?.unresolved).toBeUndefined(); expect(offeredEnable(otherActor)).toEqual([])
  expect(JSON.stringify(otherActor.applicationConfiguration)).not.toContain(f.input.operationId)
  expect(JSON.stringify(otherActor.applicationConfiguration)).not.toContain(uncertain.stepId)
  await expect(service.call('connection.setup.inspect', { operationId: unresolved!.operationId, applicationConfiguration: { effect: 'enable-messaging', selectedStepId: unresolved!.stepId } }, foreign)).rejects.toMatchObject({ code: 'CONNECTION_SETUP_AUTHORITY_REQUIRED' })
  const read = await f.sdk.call('connection.setup.advance', action(await readInspect(f), 'read-event-settings'))
  expect(read.applicationInspection?.readResult).toEqual({ subject: 'event-settings', transport: 'persistent-connection' })
  expect(effect(await f.sdk.call('connection.setup.advance', input))).toEqual(uncertain)
  const writes = fetch.mock.calls.filter(([url]) => String(url).includes('/robot/switch/'))
  expect(writes).toHaveLength(1); expect(JSON.parse(String(writes[0][1]?.body))).toEqual({ enable: true })
  expect((await f.sdk.call('connection.inspect', { operationId: 'configuration-original-save' })).operation).toEqual(f.saved)
}, 60_000)
it('an enable action keeps its exact actor, decision and revision without taking away the saved bot or authentication', async () => {
  const f = await fixture(), fetch = vi.fn(nativeRoute().route); vi.stubGlobal('fetch', fetch)
  const auth = await confirmed(f); await botRead(f)
  const offered = await inspect(f), input = action(offered, 'enable-messaging')
  const otherConfig = { ...f.config, connectionId: 'configuration-different-application', application: { ...f.config.application, appId: 'cli_configuration_other_application' } }
  await f.sdk.call('connection.configure', { operationId: 'configuration-save-different-application', expectedRevision: null, connection: otherConfig })
  const otherInput = { ...f.input, operationId: 'configuration-other-application-management', connectionId: otherConfig.connectionId }
  await confirmed(f, await f.sdk.call('connection.setup.begin', otherInput)); await botRead(f, otherInput.operationId)
  const other = await inspect(f, undefined, otherInput.operationId), otherAction = action(other, 'enable-messaging')
  expect(other.operation?.application).toEqual(otherConfig.application)
  expect(other.applicationConfiguration?.capability).toBe('disabled'); expect(offeredEnable(other)).toHaveLength(1)
  const calls = fetch.mock.calls.length
  await expect(f.sdk.call('connection.setup.advance', { ...input, operationId: otherInput.operationId, expectedRevision: otherAction.expectedRevision })).rejects.toMatchObject({ code: 'CONNECTION_SETUP_ACTION_STALE' })
  expect(fetch).toHaveBeenCalledTimes(calls)
  expect(offeredEnable(await inspect(f, undefined, otherInput.operationId))).toEqual(offeredEnable(other))
  expect(offeredEnable(await inspect(f))).toEqual(offeredEnable(offered))
  const service = new AgentMuxRpcService({ connections: f.services.connections }); clean.push(() => service.dispose())
  const foreign = { principal: { kind: 'device' as const, id: 'foreign-configuration-device' } }
  await expect(service.call('connection.setup.advance', input, {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(service.call('connection.setup.advance', input, foreign)).rejects.toMatchObject({ code: expect.stringMatching(/^(?:CONTROL_PERMISSION_DENIED|CONNECTION_SETUP_AUTHORITY_REQUIRED)$/u) })
  for (const wrong of [{ ...input, expectedRevision: input.expectedRevision + 1 }, { ...input, decision: { ...input.decision, value: 'continue' as const } }]) {
    await expect(f.sdk.call('connection.setup.advance', wrong)).rejects.toMatchObject({ code: 'CONNECTION_SETUP_ACTION_STALE' })
  }
  expect((await inspect(f)).applicationConfiguration).toEqual(offered.applicationConfiguration); expect(fetch).toHaveBeenCalledTimes(calls)
  const accepted = await f.sdk.call('connection.setup.advance', input), original = effect(accepted)
  await expect(f.sdk.call('connection.setup.advance', { ...input, expectedRevision: input.expectedRevision + 1 })).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
  await expect(service.call('connection.setup.inspect', { operationId: f.input.operationId, applicationConfiguration: { effect: 'enable-messaging', selectedStepId: original.stepId } }, foreign)).rejects.toMatchObject({ code: expect.stringMatching(/^(?:CONTROL_PERMISSION_DENIED|CONNECTION_SETUP_AUTHORITY_REQUIRED)$/u) })
  expect(effect(await inspect(f, original.stepId))).toEqual(original)
  expect((await inspect(f)).operation?.authentication).toEqual(auth.operation?.authentication)
  expect(fetch.mock.calls.length - calls).toBe(1)
  expect((await f.sdk.call('connection.inspect', { operationId: 'configuration-original-save' })).operation).toEqual(f.saved)
}, 45_000)

it.each(['account', 'revision'] as const)('a late original enable ACK retains its frozen effect and cannot grant current capability across a newer %s', async change => {
  const f = await fixture(), entered = deferred<void>(), response = deferred<Response>()
  const native = nativeRoute(undefined, async () => { entered.resolve(); return await response.promise })
  const fetch = vi.fn(native.route); vi.stubGlobal('fetch', fetch); clean.push(() => response.resolve(Response.json({ code: 0 })))
  await confirmed(f); const source = selected(await botRead(f)), input = action(await inspect(f), 'enable-messaging')
  const pending = f.sdk.call('connection.setup.advance', input)
  expect(await Promise.race([entered.promise.then(() => true), pending.then(() => false)])).toBe(true)
  let current: ConnectionSetupView | undefined, revised: unknown
  if (change === 'account') {
    native.account(1)
    const renewed = await f.sdk.call('connection.setup.advance', action(await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId }), 'renew'))
    current = await confirmed(f, renewed)
    expect(current.continuation?.account).toEqual({ userId: accounts[1].user, tenantId: accounts[1].tenant })
  } else revised = (await f.sdk.call('connection.configure', { operationId: 'configuration-late-target', expectedRevision: 1, connection: { ...f.config, label: 'Target revision changed during the original enable' } })).connection
  response.resolve(Response.json({ code: 0, data: { privateReceipt: PRIVATE + '-late-effect' } }))
  const late = await pending, receipt = effect(late)
  expect(receipt).toMatchObject({ input, sourceStepId: source.stepId, request: 'confirmed' })
  expect(late.applicationConfiguration?.capability).toBe('unknown'); expect(offeredEnable(late)).toEqual([])
  const local = await inspect(f, receipt.stepId)
  expect(effect(local)).toEqual(receipt); expect(local.applicationConfiguration?.capability).toBe('unknown')
  assertPrivateFree(local.applicationConfiguration)
  if (current) expect(local.operation?.authentication).toEqual(current.operation?.authentication)
  else expect((await f.sdk.call('connection.inspect', { connectionId: f.config.connectionId })).connection).toEqual(revised)
  const writes = fetch.mock.calls.filter(([url]) => String(url).includes('/robot/switch/'))
  expect(writes).toHaveLength(1); expect(String(writes[0][0])).toBe('https://open.feishu.cn/developers/v1/robot/switch/' + f.config.application.appId)
  expect((await f.sdk.call('connection.inspect', { operationId: 'configuration-original-save' })).operation).toEqual(f.saved)
}, 60_000)

it('the exact original secure effect ACK is discoverable and locally recoverable after renewal, target revision, missing adapter and owner reopen', async () => {
  const f = await fixture(), native = nativeRoute(), fetch = vi.fn(native.route); vi.stubGlobal('fetch', fetch)
  await confirmed(f); const source = selected(await botRead(f)), bytes = readBytes(f, source.stepId)
  const input = action(await inspect(f), 'enable-messaging'), originalStore = DesktopConnectorSecrets.prototype.store
  const fault = vi.spyOn(DesktopConnectorSecrets.prototype, 'store').mockImplementationOnce(async function(this: DesktopConnectorSecrets, value) {
    await originalStore.call(this, value); throw new Error('fixture-original-configuration-ack-lost')
  })
  const uncertain = effect(await f.sdk.call('connection.setup.advance', input)); fault.mockRestore()
  expect(uncertain).toMatchObject({ effect: 'enable-messaging', input, sourceStepId: source.stepId, request: 'confirmed', secureStorage: 'unknown' })
  native.account(1)
  const renewed = await f.sdk.call('connection.setup.advance', action(await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId }), 'renew'))
  const auth = await confirmed(f, renewed)
  const revised = await f.sdk.call('connection.configure', { operationId: 'configuration-revised-target', expectedRevision: 1, connection: { ...f.config, label: 'Revised local saved bot' } })
  const calls = fetch.mock.calls.length
  await f.close(); await f.reopen(true)
  const before = changes(f), selectedOriginal = result(await f.cli(['setup', 'inspect', '--operation-id', f.input.operationId, '--application-configuration', 'enable-messaging', '--configuration-step', uncertain.stepId, '--configuration-limit', '1']))
  expect(effect(selectedOriginal)).toEqual(uncertain); expect(selectedOriginal.applicationConfiguration?.capability).toBe('unknown')
  expect(changes(f)).toEqual(before); expect(fetch).toHaveBeenCalledTimes(calls)
  const recover = action(selectedOriginal, 'recover-configuration-effect')
  expect(recover.expectedRevision).toBe(input.expectedRevision); expect(recover.decision.actionId).not.toBe(input.decision.actionId)
  const recovered = await f.sdk.call('connection.setup.advance', recover)
  expect(effect(recovered)).toEqual({ ...uncertain, secureStorage: 'stored' })
  expect(recovered.applicationConfiguration?.capability).toBe('unknown'); expect(offeredEnable(recovered)).toEqual([])
  expect(recovered.operation?.authentication).toEqual(auth.operation?.authentication)
  expect(effect(await f.sdk.call('connection.setup.advance', input))).toEqual(effect(recovered))
  await f.close(); await f.reopen(true)
  expect(effect(await inspect(f, uncertain.stepId))).toEqual(effect(recovered)); expect(readBytes(f, source.stepId)).toEqual(bytes)
  expect(fetch).toHaveBeenCalledTimes(calls)
  expect((await f.sdk.call('connection.inspect', { connectionId: f.config.connectionId })).connection).toEqual(revised.connection)
  expect((await f.sdk.call('connection.inspect', { operationId: 'configuration-original-save' })).operation).toEqual(f.saved)
}, 60_000)

it('malformed or unconfirmed native write envelopes preserve one unknown original request and private data without retrying it', async () => {
  for (const respond of [
    async () => Response.json({ code: 403, data: { privateReceipt: PRIVATE } }),
    async () => Response.json({ code: '0', data: {} }),
    async () => Response.json({ code: 0 }, { status: 503 }),
    async () => new Response('{"code":0,', { headers: { 'content-type': 'application/json' } }),
    async () => new Response('enabled ' + PRIVATE),
    async () => new Response(null, { status: 302, headers: { location: 'https://open.feishu.cn/app' } })
  ]) {
    const f = await fixture(), fetch = vi.fn(nativeRoute(undefined, respond).route); vi.stubGlobal('fetch', fetch)
    await confirmed(f); await botRead(f)
    const input = action(await inspect(f), 'enable-messaging'), calls = fetch.mock.calls.length
    const unknown = await f.sdk.call('connection.setup.advance', input), receipt = effect(unknown)
    expect(receipt).toMatchObject({ input, request: 'unknown' }); expect(offeredEnable(unknown)).toEqual([])
    expect(unknown.applicationConfiguration?.capability).not.toBe('enabled'); assertPrivateFree(unknown.applicationConfiguration)
    expect(effect(await f.sdk.call('connection.setup.advance', input))).toEqual(receipt)
    expect(effect(await inspect(f, receipt.stepId))).toEqual(receipt)
    expect(fetch.mock.calls.length - calls).toBe(1)
    expect((await f.sdk.call('connection.inspect', { operationId: 'configuration-original-save' })).operation).toEqual(f.saved)
  }
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
        if (frame.result?.applicationConfiguration) { originals.push(frame.result); frame.result = corrupt(frame.result) }
        client.write(JSON.stringify(frame) + '\n')
      }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
  clean.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); clean.push(() => sdk.dispose())
  return { path, sdk, originals, fault: (value: typeof corrupt) => { corrupt = value } }
}

it('SDK and compiled CLI reject unsafe configuration relations on the actual forwarded owner response while valid local effect selection remains available', async () => {
  const f = await fixture(), fetch = vi.fn(nativeRoute().route); vi.stubGlobal('fetch', fetch)
  await confirmed(f); await botRead(f)
  const input = action(await inspect(f), 'enable-messaging'), original = effect(await f.sdk.call('connection.setup.advance', input))
  const source = selected(await botRead(f)), valid = await inspect(f, original.stepId)
  expect(valid.applicationConfiguration?.source).toEqual(source)
  expect(valid.applicationConfiguration?.capability).toBe('disabled')
  const wire = await wireFault(f), calls = fetch.mock.calls.length, before = changes(f)
  const faults: Array<(value: ConnectionSetupView) => unknown> = [
    value => { const { applicationConfiguration: _missing, ...rest } = value; return rest },
    value => ({ ...value, applicationConfiguration: { ...value.applicationConfiguration!, capability: true } }),
    value => ({ ...value, applicationConfiguration: { ...value.applicationConfiguration!, source: { ...value.applicationConfiguration!.source!, subject: 'callback-settings' } } }),
    value => ({ ...value, applicationConfiguration: { ...value.applicationConfiguration!, effects: [], selected: { ...effect(value), request: 'dispatching', secureStorage: 'stored' } } }),
    value => ({ ...value, applicationConfiguration: { ...value.applicationConfiguration!, effects: [], selected: { ...effect(value), input: { ...input, decision: { ...input.decision, value: 'continue' } } } } }),
    value => ({ ...value, applicationConfiguration: { ...value.applicationConfiguration!, capability: 'enabled', actions: [{ actionId: input.decision.actionId, expectedRevision: value.operation!.revision, kind: 'enable-messaging' }] } }),
    value => ({ ...value, applicationConfiguration: { ...value.applicationConfiguration!, actions: [{ actionId: 'fixture-wrong-recover', expectedRevision: input.expectedRevision, kind: 'recover-configuration-effect' }] } }),
    value => ({ ...value, applicationConfiguration: { ...value.applicationConfiguration!, effects: [], selected: { ...effect(value), stepId: 'fixture-another-effect' } } }),
    value => ({ ...value, applicationConfiguration: { ...value.applicationConfiguration!, raw: PRIVATE + '-wire-secret' } })
  ]
  const outcomes = []
  for (const fault of faults) {
    wire.fault(fault)
    const sdk = await wire.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationConfiguration: { effect: 'enable-messaging', selectedStepId: original.stepId } }).then(() => ({ accepted: true, code: null }), error => ({ accepted: false, code: error.code }))
    const output = await f.cli(['setup', 'inspect', '--operation-id', f.input.operationId, '--application-configuration', 'enable-messaging', '--configuration-step', original.stepId], undefined, wire.path)
    const error = output.code === 0 ? null : JSON.parse(output.stderr)
    outcomes.push({ sdk, cli: { accepted: output.code === 0, operation: error?.operation ?? null, code: error?.error?.code ?? null } })
    expect(output.stdout + output.stderr).not.toContain(PRIVATE + '-wire-secret')
  }
  expect(outcomes).toEqual(faults.map(() => ({ sdk: { accepted: false, code: 'CONTROL_PROTOCOL_ERROR' }, cli: { accepted: false, operation: 'connection.setup.inspect', code: 'CONTROL_PROTOCOL_ERROR' } })))
  wire.fault(value => value)
  const expected = await inspect(f, original.stepId)
  expect(await wire.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationConfiguration: { effect: 'enable-messaging', selectedStepId: original.stepId } })).toEqual(expected)
  expect(effect(result(await f.cli(['setup', 'inspect', '--operation-id', f.input.operationId, '--application-configuration', 'enable-messaging', '--configuration-step', original.stepId], undefined, wire.path)))).toEqual(original)
  expect(wire.originals.length).toBeGreaterThan(faults.length); expect(changes(f)).toEqual(before); expect(fetch).toHaveBeenCalledTimes(calls)
}, 60_000)

function childMessage(child: ChildProcess, kind: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (value: unknown) => {
      if (value && typeof value === 'object' && (value as { kind?: string }).kind === kind) { child.off('message', onMessage); child.off('exit', onExit); resolve(value as Record<string, unknown>) }
    }
    const onExit = () => { child.off('message', onMessage); reject(new Error('Configuration owner exited before ' + kind)) }
    child.on('message', onMessage); child.once('exit', onExit)
  })
}

it.each(['inflight', 'vault-committed'] as const)('actual process restart preserves the original %s enable intent without reseeding, replay or current native qualification', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'setup-configuration-child-')); clean.push(() => rm(root, { recursive: true, force: true }))
  const start = async (fault: string) => {
    const child = fork(new URL('./fixtures/connection-setup-configuration-owner.mjs', import.meta.url), [root, fault], { execArgv: ['--experimental-transform-types'], env: objectCliEnvironment(root), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    clean.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit') } })
    let errors = ''; child.stderr!.on('data', value => { errors += value })
    const ready = await childMessage(child, 'ready').catch(error => { throw new Error(errors || String(error)) })
    return { child, ready }
  }
  const first = await start(mode), socketPath = join(root, 'owner.sock')
  const cli = (args: string[], body?: unknown) => runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', ...args], objectCliEnvironment(root), body === undefined ? '' : JSON.stringify(body))
  const config: ConnectionConfig = { connectionId: 'configuration-saved-bot', adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: 'cli_configuration_original_bot' }, label: 'Original saved configuration bot', enabled: false, credentialRef: String(first.ready.credentialRef) }
  const saved = result(await cli(['configure', '--input', '-'], { operationId: 'configuration-child-save', expectedRevision: null, connection: config }))
  const input: ConnectionSetupBegin = { operationId: 'configuration-child-management', connectionId: config.connectionId, expectedConnectionRevision: 1, goal }
  let view = result(await cli(['setup', 'begin', '--input', '-'], input))
  for (let step = 0; step < 8 && view.continuation?.stage !== 'account'; step++) view = result(await cli(['setup', 'advance', '--input', '-'], action(view, 'continue')))
  expect(view.continuation?.stage).toBe('account')
  view = result(await cli(['setup', 'advance', '--input', '-'], action(view, 'confirm-account')))
  const auth = view.operation!.authentication!
  const read = result(await cli(['setup', 'advance', '--input', '-'], action(result(await cli(['setup', 'inspect', '--operation-id', input.operationId, '--application-inspection'])), 'read-bot-settings')))
  const source = selected(read), originalInput = action(result(await cli(['setup', 'inspect', '--operation-id', input.operationId, '--application-configuration', 'enable-messaging'])), 'enable-messaging')
  const entered = childMessage(first.child, mode === 'inflight' ? 'effect-started' : 'vault-committed'), pending = cli(['setup', 'advance', '--input', '-'], originalInput)
  expect(await Promise.race([entered.then(() => true), pending.then(() => false)])).toBe(true)
  const original = effect(result(await cli(['setup', 'inspect', '--operation-id', input.operationId, '--application-configuration', 'enable-messaging'])))
  expect(original).toMatchObject({ effect: 'enable-messaging', input: originalInput, sourceStepId: source.stepId, request: mode === 'inflight' ? 'dispatching' : 'confirmed' })
  first.child.kill('SIGKILL'); await once(first.child, 'exit'); expect((await pending).code).not.toBe(0)
  const effects = await readFile(join(root, 'native-effects.ndjson'), 'utf8')
  await start('observe-only')
  const observed = result(await cli(['setup', 'inspect', '--operation-id', input.operationId, '--application-configuration', 'enable-messaging', '--configuration-step', original.stepId]))
  expect(effect(observed)).toMatchObject({ stepId: original.stepId, input: originalInput, sourceStepId: source.stepId })
  expect(observed.operation?.authentication).toEqual(auth); expect(observed.applicationConfiguration?.capability).toBe('unknown')
  if (mode === 'inflight') {
    expect(effect(observed).request).toBe('unknown'); expect(offeredEnable(observed)).toEqual([])
    expect(effect(result(await cli(['setup', 'advance', '--input', '-'], originalInput)))).toEqual(effect(observed))
  } else {
    expect(effect(observed).secureStorage).not.toBe('stored')
    const recovered = result(await cli(['setup', 'advance', '--input', '-'], action(observed, 'recover-configuration-effect')))
    expect(effect(recovered)).toEqual({ ...original, secureStorage: 'stored' })
    expect(recovered.applicationConfiguration?.capability).toBe('unknown')
    expect(effect(result(await cli(['setup', 'advance', '--input', '-'], originalInput)))).toEqual(effect(recovered))
  }
  const originalRead = result(await cli(['setup', 'inspect', '--operation-id', input.operationId, '--application-inspection', '--inspection-step', source.stepId]))
  expect(selected(originalRead)).toEqual(source); expect(originalRead.applicationInspection?.readResult).toEqual({ subject: 'bot-settings' })
  expect(await readFile(join(root, 'native-effects.ndjson'), 'utf8')).toBe(effects)
  const business = effects.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.path.startsWith('/developers/'))
  expect(business).toEqual([
    { origin: 'https://open.feishu.cn', method: 'POST', path: '/developers/v1/robot/' + config.application.appId, body: '{}' },
    { origin: 'https://open.feishu.cn', method: 'POST', path: '/developers/v1/robot/switch/' + config.application.appId, body: '{"enable":true}' }
  ])
  expect(result<{ operation: unknown }>(await cli(['inspect', '--operation-id', 'configuration-child-save'])).operation).toEqual(saved)
  expect(result<{ connection: unknown }>(await cli(['inspect', '--connection', config.connectionId])).connection).toMatchObject({ config, revision: 1 })
}, 60_000)

it('a newer admitted bot read during the original private source yield invalidates the old false before native enable admission', async () => {
  const f = await fixture(); let data = { enable: false }
  const fetch = vi.fn(nativeRoute(async subject => Response.json({ code: 0, data: subject === 'bot-settings' ? data : raw[subject] })).route)
  vi.stubGlobal('fetch', fetch); await confirmed(f)
  const source = selected(await botRead(f)), input = action(await inspect(f), 'enable-messaging')
  const entered = deferred<void>(), release = deferred<void>(), originalResolve = DesktopConnectorSecrets.prototype.resolve
  let armed = true
  const pause = vi.spyOn(DesktopConnectorSecrets.prototype, 'resolve').mockImplementation(async function(this: DesktopConnectorSecrets, ref) {
    const value = await originalResolve.call(this, ref)
    let stepId: unknown; try { stepId = value ? JSON.parse(value).stepId : null } catch { /* Credentials are opaque; only the exact original envelope may pause. */ }
    if (armed && stepId === source.stepId) { armed = false; entered.resolve(); await release.promise }
    return value
  })
  clean.push(() => release.resolve())
  const pending = f.sdk.call('connection.setup.advance', input).then(value => ({ value, code: null }), error => ({ value: null, code: error.code }))
  expect(await Promise.race([entered.promise.then(() => true), pending.then(() => false)])).toBe(true)
  data = { enable: true }
  const latest = selected(await botRead(f))
  release.resolve()
  expect(await pending).toMatchObject({ value: null, code: 'CONNECTION_SETUP_ACTION_STALE' }); pause.mockRestore()
  const current = await inspect(f)
  expect(current.applicationConfiguration?.source).toEqual(latest); expect(current.applicationConfiguration?.capability).toBe('enabled')
  expect(offeredEnable(current)).toEqual([])
  expect(fetch.mock.calls.filter(([url]) => String(url).includes('/robot/switch/'))).toEqual([])
}, 45_000)

it('a later bot observation through a known saved application alias supersedes the original false even when the later receipt is unknown', async () => {
  const f = await fixture(); let response = async () => Response.json({ code: 0, data: { enable: false } })
  const fetch = vi.fn(nativeRoute(async subject => subject === 'bot-settings' ? await response() : Response.json({ code: 0, data: raw[subject] })).route)
  vi.stubGlobal('fetch', fetch); await confirmed(f); await botRead(f)
  const alias = { ...f.config, connectionId: 'configuration-read-alias', label: 'Known alias for exact original application' }
  await f.sdk.call('connection.configure', { operationId: 'configuration-save-read-alias', expectedRevision: null, connection: alias })
  const aliasInput = { ...f.input, operationId: 'configuration-read-alias-management', connectionId: alias.connectionId }
  await confirmed(f, await f.sdk.call('connection.setup.begin', aliasInput))
  for (const later of [async () => Response.json({ code: 0, data: { enable: true } }), async () => Response.json({ code: 0, data: [] })]) {
    response = async () => Response.json({ code: 0, data: { enable: false } })
    await botRead(f)
    const originalAction = action(await inspect(f), 'enable-messaging')
    response = later; await botRead(f, aliasInput.operationId)
    const current = await inspect(f)
    expect(current.applicationConfiguration?.capability).toBe('unknown'); expect(offeredEnable(current)).toEqual([])
    await expect(f.sdk.call('connection.setup.advance', originalAction)).rejects.toMatchObject({ code: 'CONNECTION_SETUP_ACTION_STALE' })
  }
  expect(fetch.mock.calls.filter(([url]) => String(url).includes('/robot/switch/'))).toEqual([])
}, 60_000)

it.each(['accepted', 'unknown'] as const)('persists Cookie continuation from an %s configuration reply without changing its business result', async outcome => {
  const f = await fixture(), rotated = 'fixture-configuration-rotated-cookie'
  let writes = 0
  vi.stubGlobal('fetch', vi.fn(nativeRoute(async (subject, _target, init) => {
    if (writes) {
      expect(new Headers(init.headers).get('cookie')).toContain('session=' + rotated)
      expect(new Headers(init.headers).get('cookie')).not.toContain('session=' + SESSION)
    }
    return Response.json({ code: 0, data: raw[subject] })
  }, async () => {
    writes++
    return Response.json(outcome === 'accepted' ? { code: 0, data: { privateReceipt: PRIVATE + '-effect' } } : { code: 1 }, { headers: { 'set-cookie': `session=${rotated}; Domain=.feishu.cn; Path=/; Secure; HttpOnly` } })
  }).route))
  await confirmed(f); await botRead(f)
  const input = action(await inspect(f), 'enable-messaging')
  const observed = result(await f.cli(['setup', 'advance', '--input', '-'], input))
  expect(effect(observed)).toMatchObject({ request: outcome === 'accepted' ? 'confirmed' : 'unknown', secureStorage: 'stored' })
  expect(observed.applicationConfiguration?.capability).toBe('unknown')
  expect(offeredEnable(observed)).toEqual([])
  assertPrivateFree(observed.applicationConfiguration); expect(JSON.stringify(observed)).not.toContain(rotated)
  await f.close(); await f.reopen()
  expect(selected(await botRead(f)).request).toBe('confirmed')
  expect(effect(await f.sdk.call('connection.setup.advance', input))).toEqual(effect(observed))
  expect(writes).toBe(1)
})

it('projects original read subjects and finite effect receipts in one ordered Setup trace without private snapshots', async () => {
  const f = await fixture(), fetch = vi.fn(nativeRoute().route); vi.stubGlobal('fetch', fetch)
  await confirmed(f)
  const source = selected(await botRead(f)), accepted = await f.sdk.call('connection.setup.advance', action(await inspect(f), 'enable-messaging')), written = effect(accepted)
  const calls = fetch.mock.calls.length, before = changes(f), resolve = vi.spyOn(DesktopConnectorSecrets.prototype, 'resolve'), store = vi.spyOn(DesktopConnectorSecrets.prototype, 'store')
  f.encryption.isEncryptionAvailable = () => false
  const view = result(await f.cli(['setup', 'inspect', '--operation-id', f.input.operationId, '--request-trace']))
  const entries = view.requestTrace!.entries
  expect(entries.filter(entry => entry.kind === 'application-inspection').map(entry => ({ stepId: entry.stepId, action: entry.action, subject: entry.subject, effect: entry.effect, request: entry.request }))).toEqual([{ stepId: source.stepId, action: 'read-application', subject: 'bot-settings', effect: null, request: 'confirmed' }])
  expect(entries.filter(entry => entry.kind === 'application-configuration')).toEqual([{ stepId: written.stepId, sequence: written.input.expectedRevision+1, kind: 'application-configuration', action: 'configure-application', subject: null, effect: 'enable-messaging', request: 'confirmed', secureStorage: 'stored', network: null }])
  expect(entries.at(-1)!.stepId).toBe(written.stepId)
  assertPrivateFree(entries)
  expect(view.continuation).toBeUndefined(); expect(view.applicationConfiguration).toBeUndefined()
  expect(resolve).not.toHaveBeenCalled(); expect(store).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(calls); expect(changes(f)).toEqual(before)
}, 45_000)
