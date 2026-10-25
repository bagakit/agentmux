// @vitest-environment happy-dom
import { unwrapSessionInputOperationResult } from '../src/shared/session-input-result.js'
import { act, useState } from 'react'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, AgentMuxRpcService, connectAgentMuxRpc } from '@agentmux/core'
import { ConnectionSetupHost } from '../../../packages/connectors/src/connection-setup.js'
import { ConnectionSecrets } from '../../../packages/connectors/src/connection-secrets.js'
import { AgentMuxError } from '@agentmux/core'
import type { ConnectionMethod, ConnectionParamsMap, ConnectionRecord, ConnectionResultMap, ConnectionSetupAdvance, ConnectionSetupBegin, ConnectionSetupView } from '@agentmux/core/connections'
import { createConnectionServices } from '../../../packages/connectors/src/connection-services.js'
import { registerConnectorIpc } from '../src/main/connector-ipc.js'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { setBotTaskSelection, useAppStore } from '../src/renderer/src/store'
import { managementTaskScope, restoredManagementTask } from '../src/renderer/src/lib/bot-task-selection'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { moteEnrollmentWeb } from './fixtures/mote-enrollment-web'
import { imagePng } from './fixtures/mote-identity-image'
import { copyConnectorIdentity } from './helpers/connector-identity-copy'

const dom = composerDOM(), goal = { kind: 'agent-conversation', interaction: 'messages' } as const
const TOKEN = 'fixture-settings-private-qr', FLOW = 'fixture-settings-private-flow'
const USER = 'fixture-settings-account-id', TENANT = 'fixture-settings-enterprise-id', SECRET = 'fixture-settings-saved-secret'
type Call = { method: ConnectionMethod; input: unknown; result?: unknown; delivered?: boolean; error?: { code?: string; message: string } }
let directory: string, services: Awaited<ReturnType<typeof createConnectionServices>>, server: AgentMuxControlServer
let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>>, registration: ReturnType<typeof registerConnectorIpc>
const hostingTarget = { hostId: 'local', runtimeId: 'original-settings-auth-runtime' }
let forward: typeof api.connections.call, calls: Call[], beforeCall: ((call: Call) => Promise<void>) | undefined, afterCall: ((call: Call) => Promise<void>) | undefined
let native: Array<{ url: string; at: number }>, trusted: ReturnType<typeof vi.fn>, secureAvailable: boolean
let reopen: () => void
const releases: Array<() => void> = []

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  // New effect intents await the original Workbench writer; use its real startup/hydration.
  localStorage.removeItem('agentmux-workbench-v1')
  vi.spyOn(api.config, 'get').mockResolvedValue(composerConfig)
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  await useAppStore.persist.rehydrate()
  const stopStartup = await useAppStore.getState().initialize(); stopStartup()
  useAppStore.setState({ botTaskSelections: {} })
  directory = await mkdtemp(join(tmpdir(), 'settings-auth-'))
  secureAvailable = true
  const available = ConnectionSecrets.prototype.assertAvailable
  vi.spyOn(ConnectionSecrets.prototype, 'assertAvailable').mockImplementation(async function () {
    if (!secureAvailable) throw new AgentMuxError('Original private credential storage unavailable.', 'CONNECTION_CREDENTIAL_UNAVAILABLE')
    await available.call(this)
  })
  services = await createConnectionServices({ directory: join(directory, 'connections') })
  server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), connections: services.connections,
    coreClients: () => { throw new Error('Connection authentication may not borrow an Agent Runtime') } })
  await server.start()
  rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const handlers = new Map<string, (...args: any[]) => Promise<any>>()
  trusted = vi.fn(); calls = []; native = []; beforeCall = undefined; afterCall = undefined
  const runtime: import('../src/main/connection-host-ipc').ConnectionHostIpc = {
    connectionHostingTarget: async () => structuredClone(hostingTarget),
    callConnectionHost: async (target, method, input) => {
      expect(target).toEqual(hostingTarget)
      return await rpc.call(method, input)
    },
    watchConnectionMetadata: async (target, handlers) => {
      expect(target).toEqual(hostingTarget)
      return await rpc.subscribe('connection.metadata.watch', {}, handlers)
    }
  }
  registration = registerConnectorIpc({ handleWithEvent: (channel, handler) => { handlers.set(channel, handler) }, assertTrusted: trusted,
    runtime, metadata: { publish() {}, observation() {} } })
  vi.spyOn(api.connections, 'hostingTarget').mockImplementation(hostId => runtime.connectionHostingTarget(hostId))
  forward = async <M extends ConnectionMethod>(method: M, input: ConnectionParamsMap[M], target?: typeof hostingTarget): Promise<ConnectionResultMap[M]> => {
    const call: Call = { method, input: structuredClone(input) }; calls.push(call)
    await beforeCall?.(call)
    try {
      const result = unwrapSessionInputOperationResult(await handlers.get('connections:call')!({}, method, input, target))
      call.result = structuredClone(result)
      await afterCall?.(call)
      call.delivered = true
      return result
    } catch (error) {
      call.error = { ...((error as { code?: string }).code ? { code: (error as { code: string }).code } : {}), message: error instanceof Error ? error.message : String(error) }
      throw error
    }
  }
  vi.spyOn(api.connections, 'call').mockImplementation(forward)
  vi.spyOn(api.ui, 'openExternal').mockResolvedValue(undefined)
  vi.stubGlobal('fetch', vi.fn(nativeRoute()))
})
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  registration?.dispose(); await rpc?.dispose()
  await server?.stop()
  services?.close(); await rm(directory, { recursive: true, force: true })
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); releases.push(release); return { promise, release } }
function nativeRoute(options: { scanned?: boolean; poll?: () => Response | Promise<Response> } = {}) {
  let polls = 0
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const target = new URL(String(url)); native.push({ url: target.href, at: Date.now() })
    expect(init?.redirect).toBe('manual')
    if (target.origin === 'https://accounts.feishu.cn' && target.pathname === '/accounts/qrlogin/init') {
      const response = Response.json({ code: 0, data: { step_info: { token: TOKEN } } }, { headers: { 'x-flow-key': FLOW } })
      // Main consumes a Node HTTP response. DOM Response constructors strip Set-Cookie.
      response.headers.append('set-cookie', 'session=fixture-settings-private-cookie; Domain=.feishu.cn; Path=/; Secure; HttpOnly')
      return response
    }
    if (target.origin === 'https://accounts.feishu.cn' && target.pathname === '/accounts/qrlogin/polling') {
      expect(new Headers(init?.headers).get('x-flow-key')).toBe(FLOW)
      expect(JSON.parse(String(init?.body))).toEqual({ biz_type: null })
      if (options.poll) return await options.poll()
      polls++
      return Response.json({ code: 0, data: { next_step: options.scanned && polls === 1 ? null : 'enter_app', step_info: { status: options.scanned && polls === 1 ? 2 : 1, ...(options.scanned && polls === 1 ? {} : { cross_login_uri: 'https://accounts.feishu.cn/cross-login' }) } } })
    }
    if (target.href === 'https://accounts.feishu.cn/cross-login') return new Response('', { status: 302, headers: { location: 'https://ask.feishu.cn/' } })
    if (target.href === 'https://ask.feishu.cn/') return new Response('Landing text is not identity')
    if (target.href === 'https://open.feishu.cn/app') return new Response(`<script>(function(){window.user=${JSON.stringify({ id: USER, tenantId: TENANT })};window.csrfToken="fixture-settings-private-csrf";})();</script>`, { headers: { 'content-type': 'text/html' } })
    throw new Error('Unexpected external authentication request ' + target.origin + target.pathname)
  }
}
function MountedSettings() {
  const [visible, setVisible] = useState(true)
  reopen = () => setVisible(true)
  return <SettingsPanel visible={visible} initialSection="lark" onClose={() => setVisible(false)} />
}
async function ready(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 12_000 }) }
async function mount() { await dom.render(<MountedSettings />); await ready(() => expect(dom.container.querySelector('[data-connector-settings]')).not.toBeNull()) }
async function click(selector: string) {
  let target: HTMLElement | null = null
  await ready(() => { target = dom.container.querySelector(selector); expect(target, selector).not.toBeNull(); if (target!.matches('button')) expect((target as HTMLButtonElement).disabled, selector).toBe(false) })
  const details = target!.closest<HTMLDetailsElement>('details:not([open])')
  if (details && !target!.matches('summary')) await act(async () => details.querySelector('summary')!.click())
  expect(target!.closest('[hidden], [inert]'), 'Use the active Settings task').toBeNull()
  await act(async () => target!.click())
}
function panel() { return dom.container.querySelector<HTMLElement>('[data-management-setup]') }
function stage() { return panel()?.querySelector<HTMLElement>('[data-management-stage]')?.dataset.managementStage ?? panel()?.dataset.managementStage }
async function waitStage(value: string) { await ready(() => expect(stage(), JSON.stringify({ panel: panel()?.textContent,
  operations: calls.filter(call => call.method === 'connection.setup.begin' || call.method === 'connection.setup.advance').map(call => ({ method: call.method, result: call.result, error: call.error })),
  nativeEndpoints: native.map(call => new URL(call.url).pathname) })).toBe(value)) }
function setupCalls(method: ConnectionMethod) { return calls.filter(call => call.method === method) }
function view(call: Call) { return call.result as ConnectionSetupView }
function beginInput(operationId: string, record: ConnectionRecord): ConnectionSetupBegin {
  return { operationId, connectionId: record.config.connectionId, expectedConnectionRevision: record.revision, goal }
}
async function seed(id = 'settings-saved-bot', appId = 'cli_settings_saved_bot') {
  const credential = await services.secrets.store({ operationId: id + ':credential', secret: SECRET })
  const saved = await forward('connection.configure', { operationId: id + ':save', expectedRevision: null,
    connection: { connectionId: id, adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId }, label: id, enabled: false, credentialRef: credential.credentialRef } })
  return saved
}
async function select(record: ConnectionRecord) { await click(`[data-connection="${record.config.connectionId}"] button`) }
async function enter(record: ConnectionRecord) {
  await ready(() => expect(panel() ?? dom.container.querySelector('[data-management-open]')).not.toBeNull())
  if (!panel()) await click('[data-management-open]')
  await ready(() => expect(panel()?.dataset.managementSetup).toBe(record.config.connectionId))
}
async function leavePrivate() { await click('[data-management-back]'); await ready(() => expect(panel()).toBeNull()) }
function expectNoSetupWrites() {
  expect(calls.filter(call => call.method === 'connection.configure' || call.method.startsWith('connection.binding.') || call.method.startsWith('connection.room.') || call.method.startsWith('connection.profile.'))).toEqual([])
}
async function unchanged(saved: Awaited<ReturnType<typeof seed>>) {
  expect((await forward('connection.inspect', { operationId: saved.operationId })).operation).toEqual(saved)
  const current = (await forward('connection.inspect', { connectionId: saved.connection.config.connectionId })).connection!
  const { capabilities, ...stored } = current
  expect(stored).toEqual(saved.connection)
  expect(capabilities).toEqual({ roomDiscovery: true, roomCreation: true, roomLink: true })
}
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }) }

async function enrollmentWithInitialSetup(pauseBeforeSecureHandoff = false) {
  const issuer = moteEnrollmentWeb()
  vi.stubGlobal('fetch', vi.fn(issuer.fetch))
  const input = { operationId: 'management-enrollment', connectionId: 'management-enrollment-bot', adapterId: 'feishu', domain: 'open.feishu.cn', label: 'Created bot',
    preset: { name: 'AMUX original bot', description: 'Original profile', avatar: { pngDataUrl: 'data:image/png;base64,' + imagePng().toString('base64') } },
    initialPublication: { version: '1.0.0', notes: 'Enable AMUX conversations.' } }
  let originalInput: ConnectionSetupBegin | null = null
  const actualBegin = ConnectionSetupHost.prototype.begin
  const begin = vi.spyOn(ConnectionSetupHost.prototype, 'begin').mockImplementation(async function (value, context) {
    if (!originalInput) { originalInput = structuredClone(value); if (pauseBeforeSecureHandoff) secureAvailable = false }
    return await actualBegin.call(this, value, context)
  })
  let enrollment = await forward('connection.enrollment.begin', input)
  while (!enrollment.account) {
    const action = enrollment.actions.find(action => action.kind === 'continue-authentication')!
    expect(action, 'Continue the actual Enrollment until its account is available').toBeDefined()
    if (enrollment.challenge) await new Promise(resolve => setTimeout(resolve, Math.max(0, enrollment.challenge!.nextPollAt - Date.now())))
    enrollment = await forward('connection.enrollment.advance', { operationId: input.operationId, ownRevision: action.ownRevision, decision: { actionId: action.actionId, kind: 'continue-authentication' } })
  }
  for (const kind of ['confirm-account', 'create'] as const) {
    const action = enrollment.actions.find(action => action.kind === kind)!
    expect(action, 'Consume the actual Enrollment action').toBeDefined()
    try { enrollment = await forward('connection.enrollment.advance', { operationId: input.operationId, ownRevision: action.ownRevision, decision: { actionId: action.actionId, kind } }) }
    catch (error) { if (!pauseBeforeSecureHandoff || kind !== 'create') throw error; expect(error).toMatchObject({ code: 'CONNECTION_CREDENTIAL_UNAVAILABLE' }) }
  }
  secureAvailable = true
  enrollment = await forward('connection.enrollment.inspect', { operationId: input.operationId })
  expect(enrollment.operation?.configured).not.toBeNull()
  expect(originalInput).toMatchObject({ goal: { kind: 'agent-conversation', interaction: 'cards' }, initialPublication: input.initialPublication,
    source: { kind: 'enrollment', operationId: input.operationId } })
  const setupId = enrollment.operation!.initialSetup!.operationId
  expect((await forward('connection.setup.inspect', { operationId: setupId })).operation?.operationId).toBe(setupId)
  return { connection: enrollment.operation!.configured!.connection, setupId, originalInput: originalInput!, issuer, begin }
}

it('the real Settings task follows native scan and phone confirmation, then explicitly confirms the exact account and keeps the saved bot separate', async () => {
  vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const saved = await seed()
  const off = await forward('connection.service.configure', { operationId: 'settings-traffic-off', expectedRevision: 0, service: { enabled: false } })
  calls = []; vi.stubGlobal('fetch', vi.fn(nativeRoute({ scanned: true })))
  await mount(); await select(saved.connection); await enter(saved.connection)
  expect(native).toEqual([])
  await click('[data-management-start]'); await waitStage('waiting')
  expect(panel()?.querySelector('[data-management-code]')).not.toBeNull()
  const started = setupCalls('connection.setup.begin')[0]!, original = started.input as ConnectionSetupBegin
  expect(original).toMatchObject({ connectionId: saved.connection.config.connectionId, expectedConnectionRevision: saved.connection.revision, goal })
  await waitStage('scanned'); await waitStage('account')
  expect(panel()?.textContent).toContain(USER); expect(panel()?.textContent).toContain(TENANT)
  const accountSummary = panel()!.querySelector<HTMLElement>('.connector-account-summary')!
  expect(accountSummary).not.toBeNull()
  expect(accountSummary.querySelector('img')).toBeNull()
  expect(accountSummary.textContent).toContain('Account name unavailable')
  expect(accountSummary.textContent).toContain('Tenant name unavailable')
  expect(accountSummary.textContent).not.toContain('open_id')
  await copyConnectorIdentity(accountSummary, 'Copy Account ID', USER)
  await copyConnectorIdentity(accountSummary, 'Copy Tenant ID', TENANT)
  expect(setupCalls('connection.setup.advance').filter(call => (call.input as ConnectionSetupAdvance).decision.value === 'confirm')).toEqual([])
  const account = view(setupCalls('connection.setup.advance').at(-1)!), action = account.continuation!.actions.find(value => value.kind === 'confirm-account')!
  expect(action).toBeDefined()
  await click('[data-management-confirm]'); await waitStage('confirmed')
  const confirmed = setupCalls('connection.setup.advance').at(-1)!
  expect(confirmed.input).toEqual({ operationId: original.operationId, expectedRevision: action.expectedRevision, decision: { actionId: action.actionId, value: 'confirm' } })
  expect(native.map(value => new URL(value.url).pathname)).toEqual(['/accounts/qrlogin/init', '/accounts/qrlogin/polling', '/accounts/qrlogin/polling', '/cross-login', '/', '/', '/app'])
  expect(native[1]!.at).toBeGreaterThanOrEqual(view(started).challenge!.nextPollAt)
  await click('[data-management-console]'); expect(api.ui.openExternal).toHaveBeenCalledWith('https://open.feishu.cn/app')
  await leavePrivate()
  expect(dom.container.querySelector('[data-connection-check]')).not.toBeNull()
  expect(dom.container.textContent).not.toContain(USER); expect(dom.container.textContent).not.toContain(TENANT)
  expectNoSetupWrites(); await unchanged(saved)
  expect(await forward('connection.service.get', {})).toEqual(off.service)
  expect(trusted.mock.calls.map(value => value[0])).toContain('connections:call')
  const safe = await forward('connection.setup.ls', { connectionId: saved.connection.config.connectionId })
  for (const value of [USER, TENANT, TOKEN, FLOW, SECRET]) {
    expect(JSON.stringify(safe)).not.toContain(value)
    expect(JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })).not.toContain(value)
  }
}, 30_000)

it('an unconfirmed private credential handoff stops automatic work and explicit resume copies the original offered action revision without another poll', async () => {
  const saved = await seed(); calls = []
  let polls = 0
  const route = nativeRoute({ poll: () => { if (++polls === 1) { secureAvailable = false; return Response.json({ code: 0, data: { next_step: null, step_info: { status: 2 } } }) } return Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross-login' } } }) } })
  vi.stubGlobal('fetch', vi.fn(route))
  await mount(); await select(saved.connection); await enter(saved.connection); await click('[data-management-start]')
  await ready(() => expect(setupCalls('connection.setup.advance').some(call => view(call)?.operation?.authentication?.secureStorage === 'unknown')).toBe(true))
  await waitStage('unknown')
  const first = setupCalls('connection.setup.advance')[0]!, failed = view(first)
  expect(failed.operation?.authentication).toMatchObject({ request: 'confirmed', secureStorage: 'unknown' })
  const offered = failed.continuation!.actions.find(action => action.kind === 'continue')!
  expect(offered.expectedRevision).toBeLessThan(failed.operation!.revision)
  expect(setupCalls('connection.setup.advance')).toHaveLength(1); expect(polls).toBe(1)
  secureAvailable = true
  await click('[data-management-inspect]'); await click('[data-management-resume]')
  await ready(() => expect(setupCalls('connection.setup.advance').filter(call => (call.input as ConnectionSetupAdvance).decision.actionId === offered.actionId)).toHaveLength(2))
  const recovered = setupCalls('connection.setup.advance').filter(call => (call.input as ConnectionSetupAdvance).decision.actionId === offered.actionId)[1]!
  expect(recovered.input).toEqual(first.input)
  await ready(() => expect(recovered.result).toBeDefined())
  expect(view(recovered).receipt).toEqual(failed.receipt)
  await waitStage('account')
  expect(polls).toBe(2)
  expect(view(recovered).operation?.authentication?.secureStorage).toBe('stored')
  expectNoSetupWrites(); await unchanged(saved)
}, 30_000)

it('retains separate safe submissions before admission across Back and Settings close without a global begin gate or replacing an unknown original', async () => {
  const saved = await seed(); calls = []
  const a = deferred(), b = deferred(); let held = 0
  beforeCall = async call => { if (call.method === 'connection.setup.begin' && held < 2) await (++held === 1 ? a : b).promise }
  let uncertainDeliveries = 0
  vi.mocked(api.connections.call).mockImplementation(async <M extends ConnectionMethod>(method: M, input: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
    const delivery = forward(method, input)
    if (method === 'connection.setup.begin' && ++uncertainDeliveries <= 2) {
      // The caller lost its transport receipt; the exact queued delivery still reaches real IPC later.
      void delivery.catch(() => {})
      throw new Error('fixture-original-send-receipt-unconfirmed')
    }
    return await delivery
  })
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => { native.push({ url: String(url), at: Date.now() }); throw new TypeError('fixture-native-response-unconfirmed') }))
  await mount(); await select(saved.connection); await enter(saved.connection); await click('[data-management-start]')
  await ready(() => expect(held).toBe(1))
  const first = setupCalls('connection.setup.begin')[0]!.input as ConnectionSetupBegin
  await leavePrivate(); await enter(saved.connection); await click('[data-management-another]')
  expect(native).toEqual([])
  await click('[data-management-start]'); await ready(() => expect(held).toBe(2))
  const second = setupCalls('connection.setup.begin')[1]!.input as ConnectionSetupBegin
  expect(second.operationId).not.toBe(first.operationId)
  await click('[aria-label="Close settings"]')
  await act(async () => reopen()); await enter(saved.connection)
  await click('[data-management-select]'); await click(`[data-management-original="${first.operationId}"]`)
  await ready(() => expect(setupCalls('connection.setup.inspect').some(call => (call.input as { operationId: string }).operationId === first.operationId && call.result !== undefined)).toBe(true))
  expect(view(setupCalls('connection.setup.inspect').find(call => (call.input as { operationId: string }).operationId === first.operationId)!).operation).toBeNull()
  expect(setupCalls('connection.setup.begin')).toHaveLength(2)
  await leavePrivate(); await enter(saved.connection)
  await click('[data-management-select]')
  expect(panel()?.querySelector(`[data-management-original="${second.operationId}"]`)).not.toBeNull()
  await click(`[data-management-original="${first.operationId}"]`)
  await ready(() => expect(setupCalls('connection.setup.inspect').filter(call => (call.input as { operationId: string }).operationId === first.operationId && call.result !== undefined)).toHaveLength(3))
  await click('[data-management-resume]')
  await ready(() => expect(setupCalls('connection.setup.begin')[2]?.result).toBeDefined())
  await waitStage('unknown')
  expect(setupCalls('connection.setup.begin')[2]!.input).toEqual(first)
  expect(native).toHaveLength(1)
  await leavePrivate(); a.release(); b.release()
  await ready(() => expect(setupCalls('connection.setup.begin').slice(0, 2).map(call => call.result !== undefined)).toEqual([true, true]))
  expect(native).toHaveLength(2)
  await enter(saved.connection); await waitStage('unknown'); await click('[data-management-inspect]')
  await waitStage('unknown')
  expect(native).toHaveLength(2); expect(setupCalls('connection.setup.begin')).toHaveLength(3)
  expect((await forward('connection.setup.ls', { connectionId: saved.connection.config.connectionId })).operations.map(operation => operation.operationId).sort()).toEqual([first.operationId, second.operationId].sort())
  const unknown = await forward('connection.setup.inspect', { operationId: first.operationId })
  const offeredRenew = unknown.continuation!.actions.find(action => action.kind === 'renew')!
  vi.stubGlobal('fetch', vi.fn(nativeRoute()))
  await click('[data-management-renew]')
  await ready(() => { const call = setupCalls('connection.setup.advance').at(-1); expect(call?.result !== undefined || call?.error !== undefined).toBe(true) })
  expect(setupCalls('connection.setup.advance').at(-1)!.input).toEqual({ operationId: first.operationId, expectedRevision: offeredRenew.expectedRevision, decision: { actionId: offeredRenew.actionId, value: 'renew' } })
  expect(native.map(value => new URL(value.url).pathname)).toEqual(['/accounts/qrlogin/init', '/accounts/qrlogin/init', '/accounts/qrlogin/init'])
  const durable = (await forward('connection.setup.ls', { connectionId: saved.connection.config.connectionId })).operations.find(operation => operation.operationId === first.operationId)!
  expect(durable.request).toEqual(unknown.operation!.request)
  expect(durable.authentication).toMatchObject({ request: 'confirmed', secureStorage: 'stored', stage: 'waiting' })
  expect(setupCalls('connection.setup.advance').at(-1)!.error, 'Explicit renewal must return its actual public receipt').toBeUndefined()
  await waitStage('waiting')
  const renewed = view(setupCalls('connection.setup.advance').at(-1)!)
  expect(renewed.operation?.operationId).toBe(first.operationId)
  expect(renewed.operation?.request).toEqual(unknown.operation!.request)
  expect(renewed.operation?.authentication?.attemptId).not.toBe(unknown.operation!.request.attemptId)
  expect(setupCalls('connection.setup.begin')).toHaveLength(3); expect(native).toHaveLength(3)
  await leavePrivate()
  expectNoSetupWrites(); await unchanged(saved)
}, 30_000)

it('does not let a late earlier original selection display its code or advance after a different original is selected', async () => {
  const saved = await seed(), a = beginInput('settings-original-a', saved.connection), b = beginInput('settings-original-b', saved.connection)
  const route = nativeRoute(); let inits = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => { if (new URL(String(url)).pathname.endsWith('/init') && ++inits === 2) { native.push({ url: String(url), at: Date.now() }); throw new TypeError('fixture-second-original-unconfirmed') } return await route(url, init) }))
  await forward('connection.setup.begin', a); await forward('connection.setup.begin', b); calls = []
  const delayed = deferred(); let held = false
  afterCall = async call => { if (call.method === 'connection.setup.inspect' && (call.input as { operationId: string }).operationId === a.operationId) { held = true; await delayed.promise } }
  await mount(); await select(saved.connection); await enter(saved.connection)
  await click(`[data-management-original="${a.operationId}"]`); await ready(() => expect(held).toBe(true))
  await leavePrivate(); await enter(saved.connection)
  await click('[data-management-select]'); await click(`[data-management-original="${b.operationId}"]`)
  await ready(() => expect(setupCalls('connection.setup.inspect').some(call => (call.input as { operationId: string }).operationId === b.operationId && view(call)?.continuation?.stage === 'unknown')).toBe(true))
  await waitStage('unknown')
  await act(async () => { delayed.release(); await delayed.promise }); await settle()
  expect(stage()).toBe('unknown'); expect(panel()?.querySelector('[data-management-code]')).toBeNull()
  expect(setupCalls('connection.setup.advance')).toEqual([]); expect(native).toHaveLength(2)
  expectNoSetupWrites(); await unchanged(saved)
}, 30_000)

it('an API source replacement with identical saved IDs and revision rejects the earlier private QR response and its automatic action', async () => {
  const saved = await seed(); calls = []
  const delayed = deferred(); let held = false
  afterCall = async call => { if (call.method === 'connection.setup.begin') { held = true; await delayed.promise } }
  await mount(); await select(saved.connection); await enter(saved.connection); await click('[data-management-start]')
  await ready(() => expect(held).toBe(true))
  const source = api.connections.call
  try {
    api.connections.call = async <M extends ConnectionMethod>(method: M, input: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => await forward(method, input)
    await dom.render(<MountedSettings />)
    await ready(() => expect(setupCalls('connection.setup.ls').length).toBeGreaterThan(1))
    await act(async () => { delayed.release(); await delayed.promise }); await settle()
    expect(panel()?.dataset.managementSetup).toBe(saved.connection.config.connectionId)
    await ready(() => expect(setupCalls('connection.setup.inspect').some(call => view(call)?.challenge?.qrPayload.includes(TOKEN) && call.delivered)).toBe(true))
    expect(panel()?.querySelector('[data-management-code]')).not.toBeNull()
    expect(dom.container.textContent).not.toContain(USER)
    expect(setupCalls('connection.setup.advance')).toEqual([])
    expect(native.map(value => new URL(value.url).pathname)).toEqual(['/accounts/qrlogin/init'])
    expectNoSetupWrites(); await unchanged(saved)
  } finally { api.connections.call = source }
}, 30_000)

it.each(['another target', 'Settings close'] as const)('a delayed real account response cannot return after leaving for %s', async exit => {
  const a = await seed('settings-target-a'), b = await seed('settings-target-b', 'cli_settings_other_bot'); calls = []
  const delayed = deferred(); let held = false
  afterCall = async call => { if (call.method === 'connection.setup.advance' && view(call).continuation?.stage === 'account') { held = true; await delayed.promise } }
  await mount(); await select(a.connection); await enter(a.connection); await click('[data-management-start]')
  await ready(() => expect(held).toBe(true))
  if (exit === 'another target') {
    await leavePrivate(); await click('[data-connection-editor] > .connector-back'); await select(b.connection); await enter(b.connection)
  } else {
    await click('[aria-label="Close settings"]'); await act(async () => reopen()); await enter(a.connection)
  }
  await act(async () => { delayed.release(); await delayed.promise }); await settle()
  expect(panel()?.dataset.managementSetup).toBe(exit === 'another target' ? b.connection.config.connectionId : a.connection.config.connectionId)
  if (exit === 'another target') {
    expect(dom.container.textContent).not.toContain(USER); expect(dom.container.textContent).not.toContain(TENANT)
    expect(stage()).not.toBe('account')
  } else {
    await waitStage('account')
    expect(setupCalls('connection.setup.inspect').some(call => view(call)?.continuation?.account?.userId === USER && call.delivered)).toBe(true)
  }
  expect(panel()?.querySelector('[data-management-code]')).toBeNull()
  expect(setupCalls('connection.setup.advance').filter(call => (call.input as ConnectionSetupAdvance).decision.value === 'confirm')).toEqual([])
  expect(native.map(value => new URL(value.url).pathname)).toEqual(['/accounts/qrlogin/init', '/accounts/qrlogin/polling', '/cross-login', '/', '/', '/app'])
  expectNoSetupWrites(); await unchanged(a); await unchanged(b)
}, 30_000)

it('a failed local discovery response keeps the existing bot check and working manual console without creating a scan', async () => {
  const saved = await seed(); calls = []
  afterCall = async call => { if (call.method === 'connection.setup.ls') throw new Error('fixture-discovery-reply-unconfirmed') }
  await mount(); await select(saved.connection)
  await ready(() => expect(setupCalls('connection.setup.ls').some(call => call.result !== undefined)).toBe(true))
  expect(dom.container.querySelector('[data-connection-check]')).not.toBeNull()
  await enter(saved.connection); await click('[data-management-console]')
  expect(api.ui.openExternal).toHaveBeenCalledWith('https://open.feishu.cn/app')
  expect(setupCalls('connection.setup.begin')).toEqual([]); expect(native).toEqual([])
  await leavePrivate(); expect(dom.container.querySelector('[data-connection-check]')).not.toBeNull()
  expectNoSetupWrites(); await unchanged(saved)
}, 30_000)

it('machine-reported expiry stops automatic continuation until explicit same-intent renewal consumes its exact action', async () => {
  const saved = await seed(); calls = []
  vi.stubGlobal('fetch', vi.fn(nativeRoute({ poll: () => Response.json({ code: 0, data: { next_step: null, step_info: { status: 5 } } }) })))
  await mount(); await select(saved.connection); await enter(saved.connection); await click('[data-management-start]')
  await waitStage('expired')
  const expired = view(setupCalls('connection.setup.advance').at(-1)!), offered = expired.continuation!.actions.find(action => action.kind === 'renew')!
  expect(expired.operation?.authentication?.stage).toBe('expired')
  expect(native.map(value => new URL(value.url).pathname)).toEqual(['/accounts/qrlogin/init', '/accounts/qrlogin/polling'])
  expect(setupCalls('connection.setup.advance')).toHaveLength(1)
  await click('[data-management-renew]'); await waitStage('waiting')
  const renewed = setupCalls('connection.setup.advance').at(-1)!
  expect(renewed.input).toEqual({ operationId: expired.operation!.operationId, expectedRevision: offered.expectedRevision, decision: { actionId: offered.actionId, value: 'renew' } })
  expect(view(renewed).operation?.request).toEqual(expired.operation!.request)
  expect(view(renewed).operation?.authentication?.attemptId).not.toBe(expired.operation!.authentication!.attemptId)
  expect(setupCalls('connection.setup.begin')).toHaveLength(1)
  expect(native.map(value => new URL(value.url).pathname)).toEqual(['/accounts/qrlogin/init', '/accounts/qrlogin/polling', '/accounts/qrlogin/init'])
  await leavePrivate(); expectNoSetupWrites(); await unchanged(saved)
}, 30_000)

it.each(['before admission', 'after admission'] as const)('an original local inspect remains available while its begin reply is still pending %s', async position => {
  const saved = await seed(); calls = []
  const delayed = deferred(); let held = false
  vi.stubGlobal('fetch', vi.fn(nativeRoute({ poll: () => Response.json({ code: 0, data: { next_step: null, step_info: { status: 5 } } }) })))
  const pause = async (call: Call) => { if (call.method === 'connection.setup.begin') { held = true; await delayed.promise } }
  if (position === 'before admission') beforeCall = pause
  else afterCall = pause
  await mount(); await select(saved.connection); await enter(saved.connection); await click('[data-management-start]')
  await ready(() => expect(held).toBe(true))
  const original = setupCalls('connection.setup.begin')[0]!.input as ConnectionSetupBegin
  await leavePrivate(); await enter(saved.connection)
  await ready(() => expect(setupCalls('connection.setup.inspect').some(call => (call.input as { operationId: string }).operationId === original.operationId && call.result !== undefined)).toBe(true))
  const observed = view(setupCalls('connection.setup.inspect').find(call => (call.input as { operationId: string }).operationId === original.operationId)!)
  if (position === 'before admission') { expect(observed.operation).toBeNull(); expect(native).toEqual([]) }
  else { expect(observed.operation?.operationId).toBe(original.operationId); expect(observed.challenge).not.toBeNull(); expect(native).toHaveLength(1) }
  expect(setupCalls('connection.setup.begin')).toHaveLength(1)
  if (position === 'after admission') {
    await waitStage('waiting')
    expect(setupCalls('connection.setup.advance')).toEqual([])
    await click('[data-management-resume]')
    await waitStage('expired')
    expect(view(setupCalls('connection.setup.advance')[0]!).operation?.authentication?.stage).toBe('expired')
  } else await leavePrivate()
  await act(async () => { delayed.release(); await delayed.promise })
  await ready(() => expect(setupCalls('connection.setup.begin')[0]!.delivered).toBe(true)); await settle()
  if (position === 'after admission') {
    expect(stage(), 'A newer observation of this same original must survive the late begin receipt').toBe('expired')
    expect(panel()?.querySelector('[data-management-code]')).toBeNull()
    expect(setupCalls('connection.setup.advance')).toHaveLength(1)
    expect(native.map(value => new URL(value.url).pathname)).toEqual(['/accounts/qrlogin/init', '/accounts/qrlogin/polling'])
    await leavePrivate()
  } else {
    expect(panel()).toBeNull(); expect(dom.container.querySelector('[data-management-code]')).toBeNull()
    expect(setupCalls('connection.setup.advance')).toEqual([])
    expect(native.map(value => new URL(value.url).pathname)).toEqual(['/accounts/qrlogin/init'])
  }
  expectNoSetupWrites(); await unchanged(saved)
}, 30_000)

it('opens the original cards task produced by actual Enrollment through Settings without changing its goal or repeating platform work', async () => {
  const original = await enrollmentWithInitialSetup(), before = original.issuer.calls.length
  calls = []
  await mount(); await select(original.connection); await enter(original.connection)
  await click(`[data-management-original="${original.setupId}"]`)
  await waitStage('confirmed')
  const selected = setupCalls('connection.setup.inspect').find(call => (call.input as { operationId: string }).operationId === original.setupId && view(call)?.operation)!
  expect(view(selected).operation).toMatchObject({ operationId: original.setupId, goal: original.originalInput.goal, source: original.originalInput.source, initialPublication: original.originalInput.initialPublication })
  expect(panel()?.textContent).toContain('Bot setup')
  expect(panel()?.textContent).not.toContain('could not be matched')
  expect(setupCalls('connection.setup.begin')).toEqual([]); expect(setupCalls('connection.setup.advance')).toEqual([])
  expect(original.issuer.calls).toHaveLength(before); expect(original.issuer.creates).toBe(1)
}, 30_000)

it('continues the original admitted Enrollment cards intent with its exact source and initial publication after secure handoff was unavailable', async () => {
  const original = await enrollmentWithInitialSetup(true), before = original.issuer.calls.length
  calls = []
  await mount(); await select(original.connection); await enter(original.connection)
  await click(`[data-management-original="${original.setupId}"]`)
  await waitStage('unknown')
  await click('[data-management-resume]')
  await ready(() => expect(setupCalls('connection.setup.begin')).toHaveLength(1))
  const resumed = setupCalls('connection.setup.begin')[0]!
  expect(resumed.input).toEqual(original.originalInput)
  await ready(() => expect(resumed.delivered).toBe(true))
  await waitStage('confirmed')
  expect(original.issuer.creates).toBe(1)
  expect(original.issuer.calls.slice(before).some(call => call.target.pathname.includes('/manifest/upsert_by_template') || call.target.pathname.includes('/qrlogin/'))).toBe(false)
}, 30_000)

it.each(['foreign target', 'revised target', 'foreign actor'] as const)('keeps the original cards read boundary for %s', async boundary => {
  const saved = await seed(), input = { ...beginInput('management-scoped-cards', saved.connection), goal: { kind: 'agent-conversation', interaction: 'cards' } as const }
  if (boundary === 'foreign actor') {
    const foreign = new AgentMuxRpcService({ connections: services.connections })
    await foreign.call('connection.setup.begin', input, { principal: { kind: 'device', id: 'another-original-actor' } })
  } else await forward('connection.setup.begin', input)
  let current = saved.connection
  if (boundary === 'revised target') current = (await forward('connection.configure', { operationId: 'management-scoped-revision', expectedRevision: saved.connection.revision, connection: { ...saved.connection.config, label: 'Same bot, new revision' } })).connection
  if (boundary === 'foreign target') {
    const another = await seed('management-other-bot', 'cli_management_other')
    const other = { ...beginInput('management-other-cards', another.connection), goal: input.goal }
    await forward('connection.setup.begin', other)
    vi.mocked(api.connections.call).mockImplementation(async (method, value) => method === 'connection.setup.inspect' && (value as { operationId: string }).operationId === input.operationId
      ? await forward(method, { ...(value as any), operationId: other.operationId }) : await forward(method, value as never))
  }
  const before = native.length; calls = []
  await mount(); await select(current); await enter(current)
  await click(`[data-management-original="${input.operationId}"]`)
  await waitStage(boundary === 'revised target' ? 'revised' : 'unknown')
  if (boundary === 'foreign target') expect(panel()?.textContent).toContain('could not be matched')
  if (boundary === 'foreign actor') expect(setupCalls('connection.setup.inspect').find(call => (call.input as { operationId: string }).operationId === input.operationId)?.error).toMatchObject({ code: 'CONNECTION_SETUP_AUTHORITY_REQUIRED' })
  expect(panel()?.querySelector('[data-management-code]')).toBeNull(); expect(panel()?.querySelector('[data-management-confirm]')).toBeNull()
  expect(setupCalls('connection.setup.begin')).toEqual([]); expect(setupCalls('connection.setup.advance')).toEqual([])
  expect(native).toHaveLength(before)
}, 30_000)


it('retains the exact Enrollment cards selection across Back, category changes and Settings remount with passive inspection only', async () => {
  const original = await enrollmentWithInitialSetup(), before = original.issuer.calls.length
  calls = []
  await mount(); await select(original.connection); await enter(original.connection)
  expect(panel()?.querySelector('[data-management-selection-note]')?.textContent).toContain('No original request selected')
  expect(panel()?.textContent).not.toContain('No request yet')
  await click(`[data-management-original="${original.setupId}"]`); await waitStage('confirmed')
  const selections = structuredClone(useAppStore.getState().botTaskSelections)
  expect(restoredManagementTask(selections)).toEqual({ scope: managementTaskScope(original.connection), operationId: original.setupId })
  expect(JSON.stringify(selections)).not.toMatch(/revision|account|csrf|qrPayload|initialPublication|preset|AMUX original bot/)
  await leavePrivate(); calls = []; await enter(original.connection); await waitStage('confirmed')
  await click('[data-settings-target="overview"]'); await click('[data-settings-target="lark"]'); await waitStage('confirmed')
  await dom.render(<MountedSettings key="remounted-original" />); await waitStage('confirmed')
  expect(setupCalls('connection.inspect').some(call => (call.input as { connectionId?: string }).connectionId === original.connection.config.connectionId)).toBe(true)
  expect(setupCalls('connection.setup.inspect').filter(call => !(call.input as { requestTrace?: unknown }).requestTrace).every(call => (call.input as { operationId: string }).operationId === original.setupId)).toBe(true)
  expect(setupCalls('connection.setup.begin')).toEqual([]); expect(setupCalls('connection.setup.advance')).toEqual([])
  expect(original.issuer.calls).toHaveLength(before); expect(original.issuer.creates).toBe(1)
}, 30_000)

it('restores a known original independently of held discovery, keeps named read activity, and copies every safe receipt while the local view is held', async () => {
  const original = await enrollmentWithInitialSetup(), before = original.issuer.calls.length
  setBotTaskSelection(managementTaskScope(original.connection), original.setupId)
  const held = deferred(), listing = deferred(); let readingOriginal = false
  beforeCall = async call => {
    if (call.method === 'connection.ls' || call.method === 'connection.setup.ls') await listing.promise
    if (call.method === 'connection.setup.inspect' && (call.input as { applicationInspection?: unknown }).applicationInspection) { readingOriginal = true; await held.promise }
  }
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  vi.spyOn(api.ui, 'readLoadedIdentity').mockResolvedValue({ package: null, renderer: null })
  calls = []; await mount(); await ready(() => expect(readingOriginal).toBe(true))
  expect(panel()?.dataset.managementSetup).toBe(original.connection.config.connectionId)
  const activity = panel()?.querySelector('[data-management-activity][role="status"]')
  expect(activity?.getAttribute('aria-busy')).toBe('true'); expect(activity?.querySelector('svg')).not.toBeNull()
  expect(panel()?.textContent).not.toContain('could not be read')
  expect(panel()?.textContent).not.toContain('No request yet')
  const button = [...panel()!.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Copy diagnosis')!
  expect(button.disabled).toBe(false); await act(async () => button.click())
  await ready(() => expect(copy).toHaveBeenCalledOnce())
  const text = copy.mock.calls[0]![0]
  const trace = await forward('connection.setup.inspect', { operationId: original.setupId, requestTrace: { limit: 100 } })
  expect(text).toContain(original.setupId)
  for (const entry of trace.requestTrace!.entries) expect(text).toContain(entry.stepId)
  for (const privateValue of [TOKEN, FLOW, USER, TENANT, SECRET, 'fixture-settings-private-cookie', 'fixture-settings-private-csrf', 'data:image/png']) expect(text).not.toContain(privateValue)
  expect(panel()?.querySelector('[data-management-activity][role="status"]')).toBe(activity)
  held.release(); await waitStage('confirmed')
  expect(panel()?.querySelector('[data-management-activity][role="status"]')).toBeNull()
  expect(setupCalls('connection.setup.begin')).toEqual([]); expect(setupCalls('connection.setup.advance')).toEqual([])
  expect(original.issuer.calls).toHaveLength(before)
}, 30_000)

it.each(['absent', 'foreign actor', 'revised'] as const)('retains a selected original and diagnosis when passive restoration is %s', async boundary => {
  const saved = await seed(), input = beginInput('return-original-task', saved.connection)
  if (boundary === 'foreign actor') {
    const foreign = new AgentMuxRpcService({ connections: services.connections })
    await foreign.call('connection.setup.begin', input, { principal: { kind: 'device', id: 'other-operator' } })
  } else if (boundary !== 'absent') await forward('connection.setup.begin', input)
  if (boundary === 'revised') await forward('connection.configure', { operationId: 'return-revised-save', expectedRevision: saved.connection.revision, connection: { ...saved.connection.config, label: 'Revised saved name' } })
  setBotTaskSelection(managementTaskScope(saved.connection), input.operationId)
  const before = native.length; calls = []
  await mount(); await waitStage(boundary === 'revised' ? 'revised' : 'unknown')
  expect(panel()?.textContent).toContain(input.operationId)
  const button = [...panel()!.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Copy diagnosis')!
  expect(button.disabled).toBe(false)
  if (boundary === 'foreign actor') expect(setupCalls('connection.setup.inspect').find(call => call.error)?.error).toMatchObject({ code: 'CONNECTION_SETUP_AUTHORITY_REQUIRED' })
  if (boundary === 'absent') expect(panel()?.textContent).toContain('not visible yet')
  if (boundary === 'revised') expect(panel()?.textContent).toContain('This application changed')
  expect(panel()?.querySelector('[data-management-code]')).toBeNull(); expect(panel()?.querySelector('[data-management-confirm]')).toBeNull()
  expect(setupCalls('connection.setup.begin')).toEqual([]); expect(setupCalls('connection.setup.advance')).toEqual([]); expect(native).toHaveLength(before)
}, 30_000)

it('keeps the exact target and diagnosis visible when restoring the saved application fails, then retries that same target', async () => {
  const saved = await seed(), input = beginInput('return-application-read', saved.connection)
  await forward('connection.setup.begin', input); setBotTaskSelection(managementTaskScope(saved.connection), input.operationId)
  const held = deferred(); let fail = true, requested = false
  beforeCall = async call => { if (call.method === 'connection.inspect' && (call.input as { connectionId?: string }).connectionId === saved.connection.config.connectionId) { requested = true; await held.promise; if (fail) throw new Error('fixture-original-application-read-unavailable') } }
  const before = native.length; calls = []; await mount(); await ready(() => expect(requested).toBe(true))
  expect(dom.container.querySelector('[data-management-restoring] [data-management-activity]')).not.toBeNull()
  expect(dom.container.textContent).toContain(input.operationId); expect(dom.container.textContent).not.toContain('fixture-original-application-read-unavailable')
  const copy = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Copy diagnosis')!
  expect(copy.disabled).toBe(false)
  held.release(); await ready(() => expect(dom.container.textContent).toContain('fixture-original-application-read-unavailable'))
  expect(dom.container.querySelector('[data-management-restoring] [data-management-activity]')).toBeNull()
  fail = false
  const retry = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Read original application again')!
  await act(async () => retry.click()); await waitStage('waiting')
  expect(setupCalls('connection.setup.advance')).toEqual([]); expect(setupCalls('connection.setup.begin')).toEqual([]); expect(native).toHaveLength(before)
}, 30_000)

it('discards a late saved-application restoration after an explicit different target is opened', async () => {
  const a = await seed('return-target-a'), b = await seed('return-target-b', 'cli_return_other_bot')
  const input = beginInput('return-late-original', a.connection)
  await forward('connection.setup.begin', input); setBotTaskSelection(managementTaskScope(a.connection), input.operationId)
  const held = deferred(); let reading = false
  afterCall = async call => { if (call.method === 'connection.inspect' && (call.input as { connectionId?: string }).connectionId === a.connection.config.connectionId) { reading = true; await held.promise } }
  const before = native.length; calls = []; await mount(); await ready(() => expect(reading).toBe(true))
  await click('[data-management-restoring] .connector-back'); await select(b.connection); await enter(b.connection)
  held.release(); await settle()
  expect(panel()?.dataset.managementSetup).toBe(b.connection.config.connectionId)
  expect(panel()?.textContent).not.toContain(input.operationId); expect(panel()?.querySelector('[data-management-code]')).toBeNull()
  expect(restoredManagementTask(useAppStore.getState().botTaskSelections)).toBeNull()
  expect(setupCalls('connection.setup.advance')).toEqual([]); expect(native).toHaveLength(before)
}, 30_000)

it('reads the explicitly selected request beyond the first history page without selecting a newer request or restarting its poll', async () => {
  const saved = await seed(), original = beginInput('management-stored-oldest', saved.connection)
  await forward('connection.setup.begin', original)
  for (let index = 0; index < 26; index++) await forward('connection.setup.begin', beginInput('management-other-' + index, saved.connection))
  const firstPage = await forward('connection.setup.ls', { connectionId: saved.connection.config.connectionId })
  expect(firstPage.operations).toHaveLength(25); expect(firstPage.operations.some(operation => operation.operationId === original.operationId)).toBe(false)
  setBotTaskSelection(managementTaskScope(saved.connection), original.operationId)
  const before = native.length; calls = []; await mount(); await waitStage('waiting')
  expect(panel()?.textContent).toContain(original.operationId)
  const observed = setupCalls('connection.setup.inspect').find(call => view(call)?.operation?.operationId === original.operationId)!
  await act(async () => { await new Promise(resolve => setTimeout(resolve, Math.max(0, view(observed).challenge!.nextPollAt - Date.now()) + 30)) })
  expect(setupCalls('connection.setup.begin')).toEqual([]); expect(setupCalls('connection.setup.advance')).toEqual([]); expect(native).toHaveLength(before)
}, 30_000)

it('keeps named activity visible throughout an explicitly resumed original sign-in reply without duplicating its action', async () => {
  const saved = await seed(), original = beginInput('management-held-continuation', saved.connection)
  await forward('connection.setup.begin', original); setBotTaskSelection(managementTaskScope(saved.connection), original.operationId)
  const held = deferred(); let inFlight: Call | undefined
  afterCall = async call => { if (!inFlight && call.method === 'connection.setup.advance') { inFlight = call; await held.promise } }
  calls = []; await mount(); await waitStage('waiting'); await click('[data-management-resume]')
  await ready(() => expect(inFlight).toBeDefined())
  const activity = panel()?.querySelector('[data-management-activity][role="status"]')
  expect(activity?.textContent).toContain('Continuing this original setup'); expect(activity?.querySelector('svg')).not.toBeNull()
  expect(activity?.getAttribute('aria-busy')).toBe('true')
  await settle(); expect(panel()?.querySelector('[data-management-activity][role="status"]')).toBe(activity)
  expect(setupCalls('connection.setup.advance')).toHaveLength(1)
  held.release(); await waitStage('account')
  expect(panel()?.querySelector('[data-management-activity][role="status"]')).toBeNull()
  expect(setupCalls('connection.setup.advance').filter(call => (call.input as ConnectionSetupAdvance).decision.actionId === (inFlight!.input as ConnectionSetupAdvance).decision.actionId)).toHaveLength(1)
  expect(setupCalls('connection.setup.advance').some(call => (call.input as ConnectionSetupAdvance).decision.value === 'confirm')).toBe(false)
  await leavePrivate()
}, 30_000)
