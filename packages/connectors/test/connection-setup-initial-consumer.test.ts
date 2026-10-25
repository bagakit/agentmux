import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { parseConnectionSetupParams, parseConnectionSetupResult, type ConnectionSetupBegin, type ConnectionSetupView } from '@agentmux/core/connections'
import { createConnectionServices } from '../src/connection-services.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'

const APP = 'cli_initial_conversations', VERSION = 'initial-version', USER = 'original-creator'
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
const SCOPES = ['im:message:send_as_bot', 'im:message:readonly', 'im:message.group_msg', 'im:chat:create', 'im:chat:read', 'im:chat.members:read', 'im:chat.members:write_only', 'application:application:self_manage', 'im:message.reactions:write_only', 'contact:contact.base:readonly', 'contact:user.base:readonly']
const EVENT = 'im.message.receive_v1'
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (errors.length) throw new AggregateError(errors, 'Initial setup consumer cleanup failed')
})
async function fixture(interaction: 'messages' | 'cards' = 'cards', unknownEffect: string | null = null, versionStatus = 2) {
  const root = await mkdtemp(join(tmpdir(), 'initial-setup-')), socketPath = join(root, 'owner.sock')
  let services: Awaited<ReturnType<typeof createConnectionServices>>, server: AgentMuxControlServer, sdk: Awaited<ReturnType<typeof connectAgentMuxRpc>>
  const open = async () => {
    services = await createConnectionServices({ directory: join(root, 'connections') })
    server = new AgentMuxControlServer({ socketPath, connections: services.connections, coreClients: () => { throw Error('Initial setup cannot borrow an Agent Runtime') } })
    await server.start(); sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  }
  const close = async () => { sdk.dispose(); await server.stop(); services.close() }
  await open(); cleanup.push(() => rm(root, { recursive: true, force: true }), close)
  let messaging = false, eventMode = 1, callbackMode = 0, received = false, cardActions = false, scopes: unknown[] = [], versionCreated = false, submitted = false
  let blocked = unknownEffect
  const requests: Array<{ path: string; body: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(url)), path = target.pathname, body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    requests.push({ path, body })
    if (path === '/accounts/qrlogin/init') return Response.json({ code: 0, data: { step_info: { token: 'initial-private-qr' } } }, { headers: { 'x-flow-key': 'initial-private-flow', 'set-cookie': 'session=initial-private-cookie; Domain=.feishu.cn; Path=/; Secure' } })
    if (path === '/accounts/qrlogin/polling') return Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross' } } })
    if (target.href === 'https://accounts.feishu.cn/cross') return new Response(null, { status: 302, headers: { location: 'https://ask.feishu.cn/' } })
    if (target.href === 'https://ask.feishu.cn/') return new Response('Landing is not identity')
    if (target.href === 'https://open.feishu.cn/app') return new Response(`<script>window.user={"id":"${USER}","tenantId":"original-tenant"};window.csrfToken="initial-private-csrf";</script>`, { headers: { 'content-type': 'text/html' } })
    const reply = (data: unknown) => Response.json({ code: 0, data })
    if (path === '/developers/v1/app/upload/image') return reply({ url: 'https://images.example.test/amux.png' })
    if (path === '/developers/v1/manifest/upsert_by_template') { expect(body.createAppUserCustomField.i18n['zh_cn'].name).toBe('AMUX identity'); expect(body.createAppUserCustomField.i18n['zh_cn'].description).toBe('Saved Mote description'); return reply({ ClientID: APP }) }
    if (path === '/developers/v1/secret/' + APP) return reply({ secret: 'initial-private-secret' })
    expect(target.origin).toBe('https://open.feishu.cn')
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('initial-private-csrf')
    expect(new Headers(init?.headers).get('cookie')).toContain('session=initial-private-cookie')
    if (blocked === 'read-event-settings' && path.endsWith('/event/' + APP)) return new Response(null, { status: 502 })
    if (path.endsWith('/robot/' + APP)) return reply({ enable: messaging })
    if (path.endsWith('/event/' + APP)) return reply({ eventMode, appEventDetails: received ? [{ items: [{ id: EVENT }] }] : [] })
    if (path.endsWith('/callback/' + APP)) return reply({ callbackMode, callbacks: cardActions ? ['card.action.trigger'] : [] })
    if (path.endsWith('/scope/all/' + APP)) return reply({ scopes: SCOPES.map((name, i) => ({ name, id: i + 10, scopeType: [2] })) })
    if (path.endsWith('/scope/applied/' + APP)) return reply({ scopes })
    if (path.endsWith('/event/all/' + APP)) return reply({ events: [{ items: [{ id: EVENT, supportIdentityTypes: [2] }] }] })
    if (path.endsWith('/app_version/list/' + APP)) return reply({ versions: versionCreated ? [{ versionId: VERSION, appVersion: '1.0.0', versionStatus: submitted ? versionStatus : 0 }] : [] })
    if (path.endsWith('/app_version/detail/' + APP + '/' + VERSION)) return reply({ versionId: VERSION, appVersion: '1.0.0', versionStatus: submitted ? versionStatus : 0 })
    if (blocked && path.includes(blocked)) return new Response(null, { status: 502 })
    if (path.endsWith('/robot/switch/' + APP)) { expect(body).toEqual({ clientId: APP, enable: true }); messaging = true; return reply({}) }
    if (path.endsWith('/event/switch/' + APP)) { expect(body).toEqual({ clientId: APP, eventMode: 4 }); eventMode = 4; return reply({}) }
    if (path.endsWith('/scope/update/' + APP)) { expect(body.clientId).toBe(APP); scopes = body.appScopeIDs.map((id: number) => ({ id, scopeIdentityType: 2 })); return reply({ needConfigurePrivilege: false }) }
    if (path.endsWith('/event/update/' + APP)) { expect(body).toEqual({ clientId: APP, events: [], appEvents: [EVENT], userEvents: [], operation: 'add', eventMode: 4 }); received = true; return reply({}) }
    if (path.endsWith('/callback/switch/' + APP)) { callbackMode = 4; return reply({}) }
    if (path.endsWith('/callback/update/' + APP)) { cardActions = true; return reply({}) }
    if (path.endsWith('/app_version/create/' + APP)) { expect(body).not.toHaveProperty('autoPublish'); versionCreated = true; return reply({ versionId: VERSION }) }
    if (path.endsWith('/publish/commit/' + APP + '/' + VERSION)) { expect(body).toEqual({ clientId: APP }); submitted = true; return reply({}) }
    throw Error('Unexpected initial setup native request: ' + path)
  }))
  let enrollment = await sdk.call('connection.enrollment.begin', { operationId: 'initial-creation', connectionId: 'initial-bot', adapterId: 'feishu', domain: 'open.feishu.cn', label: 'AMUX identity', preset: { name: 'AMUX identity', description: 'Saved Mote description', avatar: { pngDataUrl: PNG } } })
  const enrollmentAction = async (kind: string) => {
    const action = enrollment.actions.find(action => action.kind === kind)!
    expect(action, kind).toBeDefined()
    enrollment = await sdk.call('connection.enrollment.advance', { operationId: enrollment.operation!.operationId, ownRevision: action.ownRevision, decision: { actionId: action.actionId, kind: action.kind } })
  }
  for (let i = 0; i < 8 && enrollment.operation!.authentication?.stage !== 'account'; i++) {
    if (enrollment.challenge && enrollment.challenge.nextPollAt > Date.now()) await new Promise(done => setTimeout(done, enrollment.challenge!.nextPollAt - Date.now()))
    await enrollmentAction('continue-authentication')
  }
  await enrollmentAction('confirm-account'); await enrollmentAction('create')
  expect(enrollment.operation!.configuration).toBe('configured')
  const saved = enrollment.operation!.configured!.connection
  const input: ConnectionSetupBegin = { operationId: 'initial-management', connectionId: saved.config.connectionId, expectedConnectionRevision: saved.revision, goal: { kind: 'agent-conversation', interaction }, initialPublication: { version: '1.0.0', notes: 'Enable AMUX conversations.' }, source: { kind: 'enrollment', operationId: enrollment.operation!.operationId, expectedRevision: enrollment.operation!.revision } }
  const cli = async (args: string[], value?: unknown): Promise<ConnectionSetupView> => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', 'setup', ...args], objectCliEnvironment(root), value === undefined ? '' : JSON.stringify(value))
    expect(result.code, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout).result
  }
  return { input, get sdk() { return sdk }, requests, cli, get services() { return services }, reopen: async () => { await close(); await open() }, unblock: () => { blocked = null } }
}

it.each(['messages', 'cards'] as const)('public SDK and actual CLI complete original %s creation configuration and creator-only publication', async interaction => {
  const f = await fixture(interaction)
  const discovery = await f.sdk.call('connection.setup.ls', { connectionId: f.input.connectionId })
  expect(discovery.support?.capabilities).toContain('initial-setup')
  const before = f.requests.length
  const result = await f.cli(['begin', '--input', '-'], f.input)
  expect(result.initialSetup).toEqual({ stage: 'publication-status', state: 'complete', versionId: VERSION })
  expect(result.operation).toMatchObject(f.input)
  const native = f.requests.slice(before)
  const writes = native.filter(request => /\/(switch|update|create|commit)\//u.test(request.path))
  expect(writes.map(request => request.path)).toEqual([
    '/developers/v1/robot/switch/' + APP,
    '/developers/v1/event/switch/' + APP,
    '/developers/v1/scope/update/' + APP,
    '/developers/v1/event/update/' + APP,
    ...(interaction === 'cards' ? ['/developers/v1/callback/switch/' + APP, '/developers/v1/callback/update/' + APP] : []),
    '/developers/v1/app_version/create/' + APP,
    '/developers/v1/publish/commit/' + APP + '/' + VERSION
  ])
  const create = writes.find(request => request.path.includes('/app_version/create/'))!
  expect(create.body).toEqual({ appVersion: '1.0.0', changeLog: 'Enable AMUX conversations.', pcDefaultAbility: 'bot', mobileDefaultAbility: 'bot', visibleSuggest: { members: [USER], departments: [], groups: [], isAll: 0 }, blackVisibleSuggest: { departments: [], members: [], groups: [], isAll: 0 } })
  expect(writes.find(request => request.path.includes('/publish/commit/'))!.body).toEqual({ clientId: APP })
  const count = f.requests.length
  expect((await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId })).initialSetup).toEqual(result.initialSetup)
  expect(f.requests).toHaveLength(count)
  const repeated = await f.sdk.call('connection.setup.begin', f.input)
  expect(repeated.initialSetup).toEqual(result.initialSetup)
  expect(f.requests.slice(count).map(request => request.path)).toEqual(['/developers/v1/app_version/detail/' + APP + '/' + VERSION])
  const trace = await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, requestTrace: { limit: 100 } })
  expect(trace.requestTrace!.entries.some(row => row.kind === 'application-configuration')).toBe(true)
  for (const secret of ['initial-private', USER, 'original-tenant']) expect(JSON.stringify(trace)).not.toContain(secret)
}, 30_000)

it('unknown finite effects stop at their exact stage across original begin and CLI inspection without replay', async () => {
  const f = await fixture('cards', '/event/switch/')
  const result = await f.sdk.call('connection.setup.begin', f.input)
  expect(result.initialSetup).toEqual({ stage: 'event-transport', state: 'attention' })
  const child = await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationConfiguration: { effect: 'use-persistent-connection' } })
  expect(child.applicationConfiguration!.selected).toMatchObject({ request: 'unknown' })
  const before = [...f.requests]
  f.unblock(); await f.reopen()
  expect((await f.cli(['begin', '--input', '-'], f.input)).initialSetup).toEqual(result.initialSetup)
  expect((await f.cli(['inspect', '--operation-id', f.input.operationId])).initialSetup).toEqual(result.initialSetup)
  expect(f.requests).toEqual(before)
  expect(f.requests.some(request => request.path.includes('/app_version/create/'))).toBe(false)
  await expect(f.sdk.call('connection.setup.begin', { ...f.input, initialPublication: { ...f.input.initialPublication!, notes: 'Changed intent' } })).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
}, 30_000)

it('a failed native read stays attention in local inspection and a same-intent continuation can observe recovery', async () => {
  const f = await fixture('messages', 'read-event-settings')
  const result = await f.sdk.call('connection.setup.begin', f.input)
  expect(result.initialSetup).toEqual({ stage: 'event-transport', state: 'attention' })
  const count = f.requests.length
  expect((await f.cli(['inspect', '--operation-id', f.input.operationId])).initialSetup).toEqual(result.initialSetup)
  expect(f.requests).toHaveLength(count)
  f.unblock()
  expect((await f.sdk.call('connection.setup.begin', f.input)).initialSetup?.state).toBe('complete')
  expect(f.requests.filter(request => request.path.includes('/robot/switch/'))).toHaveLength(1)
  expect(f.requests.filter(request => request.path.includes('/manifest/upsert_by_template'))).toHaveLength(1)
}, 30_000)

it('a submitted original version awaiting platform approval remains observable and does not submit again', async () => {
  const f = await fixture('messages', null, 1)
  const result = await f.sdk.call('connection.setup.begin', f.input)
  expect(result.initialSetup).toEqual({ stage: 'publication-status', state: 'approval-required', versionId: VERSION })
  const before = f.requests.length
  await f.reopen()
  await f.cli(['begin', '--input', '-'], f.input)
  expect(f.requests.slice(before)).toEqual([{ path: '/developers/v1/app_version/detail/' + APP + '/' + VERSION, body: {} }])
  expect(f.requests.filter(request => request.path.includes('/publish/commit/'))).toHaveLength(1)
}, 30_000)

it('strict public intent requires an enrollment source and binds the same begin response to original publication consent', () => {
  const input: ConnectionSetupBegin = { operationId: 'initial-management', connectionId: 'initial-bot', expectedConnectionRevision: 1, goal: { kind: 'agent-conversation', interaction: 'messages' }, source: { kind: 'enrollment', operationId: 'initial-enrollment', expectedRevision: 1 }, initialPublication: { version: '1.0.0', notes: 'AMUX conversations' } }
  expect(parseConnectionSetupParams('connection.setup.begin', input)).toMatchObject(input)
  const { source, ...missing } = input
  expect(() => parseConnectionSetupParams('connection.setup.begin', missing)).toThrow()
  expect(() => parseConnectionSetupParams('connection.setup.begin', { ...input, initialPublication: { version: '0.0.0', notes: 'AMUX' } })).toThrow()
  const operation = { ...input, revision: 1, adapterId: 'generic', application: { domain: 'example.test', appId: 'original' }, request: { kind: 'enrollment-handoff', state: 'not-dispatched', attemptId: null }, secureStorage: 'not-started' }
  expect(() => parseConnectionSetupResult('connection.setup.begin', input, { operation: { ...operation, initialPublication: { ...input.initialPublication!, notes: 'Different' } }, challenge: null })).toThrow()
  expect(() => parseConnectionSetupResult('connection.setup.begin', input, { operation, challenge: null, initialSetup: { stage: 'messaging', state: 'complete', versionId: VERSION } })).toThrow()
})

it.each([
  ['/event/update/', 'event', 'add-message-reception', 'message-reception', false],
  ['/callback/update/', 'callback', 'add-card-actions', 'card-actions', false],
  ['/event/update/', 'event', 'add-message-reception', 'message-reception', true],
  ['/callback/update/', 'callback', 'add-card-actions', 'card-actions', true]
] as const)('original %s (%s, %s, %s, readback=%s) stays visible', async (nativePath, readKind, effect, stage, readback) => {
  const f = await fixture('cards'), native = globalThis.fetch
  let release!: () => void, entered!: () => void, writerStarted = false
  const blocked = new Promise<void>(done => { release = done }), started = new Promise<void>(done => { entered = done })
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    if (path.includes(nativePath)) {
      writerStarted = true
      if (!readback) { entered(); await blocked }
    }
    if (readback && writerStarted && path === '/developers/v1/' + readKind + '/' + APP) { entered(); await blocked }
    return native(url, init)
  })
  const pending = f.sdk.call('connection.setup.begin', f.input)
  try {
    await started
    const count = f.requests.length
    const view = await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId })
    const child = await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationConfiguration: { effect } })
    expect(child.applicationConfiguration?.selected?.request).toBe(readback ? 'confirmed' : 'dispatching')
    expect(view.initialSetup).toEqual({ stage, state: 'running' })
    expect(f.requests).toHaveLength(count)
  } finally { release(); await pending }
  expect(f.requests.filter(request => request.path.includes(nativePath))).toHaveLength(1)
}, 30_000)
