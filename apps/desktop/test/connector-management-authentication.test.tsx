// @vitest-environment happy-dom
import { act, useState } from 'react'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '@agentmux/core'
import type { ConnectionMethod, ConnectionParamsMap, ConnectionRecord, ConnectionResultMap, ConnectionSetupAdvance, ConnectionSetupBegin, ConnectionSetupView } from '@agentmux/core/connections'
import { createDesktopConnections } from '../src/main/connector-host.js'
import { registerConnectorIpc } from '../src/main/connector-ipc.js'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'
import { enrollmentEncryption } from '../../../packages/connectors/test/fixtures/connection-enrollment.js'

const dom = composerDOM(), goal = { kind: 'agent-conversation', interaction: 'messages' } as const
const TOKEN = 'fixture-settings-private-qr', FLOW = 'fixture-settings-private-flow'
const USER = 'fixture-settings-account-id', TENANT = 'fixture-settings-enterprise-id', SECRET = 'fixture-settings-saved-secret'
type Call = { method: ConnectionMethod; input: unknown; result?: unknown; delivered?: boolean; error?: { code?: string; message: string } }
let directory: string, services: Awaited<ReturnType<typeof createDesktopConnections>>, server: AgentMuxControlServer
let forward: typeof api.connections.call, calls: Call[], beforeCall: ((call: Call) => Promise<void>) | undefined, afterCall: ((call: Call) => Promise<void>) | undefined
let native: Array<{ url: string; at: number }>, trusted: ReturnType<typeof vi.fn>, secureAvailable: boolean
let reopen: () => void
const releases: Array<() => void> = []

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  directory = await mkdtemp(join(tmpdir(), 'settings-auth-'))
  const encryption = enrollmentEncryption(); secureAvailable = true
  services = await createDesktopConnections({ directory: join(directory, 'connections'), encryption: { ...encryption, isEncryptionAvailable: () => secureAvailable } })
  server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), connections: services.connections,
    coreClients: () => { throw new Error('Connection authentication may not borrow an Agent Runtime') } })
  await server.start()
  const handlers = new Map<string, (...args: any[]) => Promise<any>>()
  trusted = vi.fn(); calls = []; native = []; beforeCall = undefined; afterCall = undefined
  registerConnectorIpc({ handleWithEvent: (channel, handler) => { handlers.set(channel, handler) }, assertTrusted: trusted, socketPath: server.path,
    secrets: { store: input => services.secrets.store(input), inspect: operationId => services.secrets.inspect(operationId) } })
  forward = async <M extends ConnectionMethod>(method: M, input: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
    const call: Call = { method, input: structuredClone(input) }; calls.push(call)
    await beforeCall?.(call)
    try {
      const result = await handlers.get('connections:call')!({}, method, input)
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
    if (target.origin === 'https://accounts.feishu.cn' && target.pathname === '/accounts/qrlogin/init') return Response.json({ code: 0, data: { step_info: { token: TOKEN } } }, { headers: {
      'x-flow-key': FLOW, 'set-cookie': 'session=fixture-settings-private-cookie; Domain=.feishu.cn; Path=/; Secure; HttpOnly'
    } })
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
  return <SettingsPanel visible={visible} initialSection="chat-connections" onClose={() => setVisible(false)} />
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
async function waitStage(value: string) { await ready(() => expect(stage()).toBe(value)) }
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
  if (!panel()) await click('[data-management-open]')
  await ready(() => expect(panel()?.dataset.managementSetup).toBe(record.config.connectionId))
}
async function leavePrivate() { await click('[data-management-back]'); await ready(() => expect(panel()).toBeNull()) }
function expectNoSetupWrites() {
  expect(calls.filter(call => call.method === 'connection.configure' || call.method.startsWith('connection.binding.') || call.method.startsWith('connection.room.') || call.method.startsWith('connection.profile.'))).toEqual([])
}
async function unchanged(saved: Awaited<ReturnType<typeof seed>>) {
  expect((await forward('connection.inspect', { operationId: saved.operationId })).operation).toEqual(saved)
  expect((await forward('connection.inspect', { connectionId: saved.connection.config.connectionId })).connection).toEqual(saved.connection)
}
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }) }

it('the real Settings task follows native scan and phone confirmation, then explicitly confirms the exact account and keeps the saved bot separate', async () => {
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

it('an unconfirmed encrypted handoff stops automatic work and explicit resume copies the original offered action revision without another poll', async () => {
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
  await click(`[data-management-original="${first.operationId}"]`)
  await ready(() => expect(setupCalls('connection.setup.inspect').some(call => (call.input as { operationId: string }).operationId === first.operationId && call.result !== undefined)).toBe(true))
  expect(view(setupCalls('connection.setup.inspect').find(call => (call.input as { operationId: string }).operationId === first.operationId)!).operation).toBeNull()
  expect(setupCalls('connection.setup.begin')).toHaveLength(2)
  await leavePrivate(); await enter(saved.connection)
  expect(panel()?.querySelector(`[data-management-original="${second.operationId}"]`)).not.toBeNull()
  await click(`[data-management-original="${first.operationId}"]`)
  await ready(() => expect(setupCalls('connection.setup.inspect').filter(call => (call.input as { operationId: string }).operationId === first.operationId && call.result !== undefined)).toHaveLength(2))
  await click('[data-management-resume]')
  await ready(() => expect(setupCalls('connection.setup.begin')[2]?.result).toBeDefined())
  await waitStage('unknown')
  expect(setupCalls('connection.setup.begin')[2]!.input).toEqual(first)
  expect(native).toHaveLength(1)
  await leavePrivate(); a.release(); b.release()
  await ready(() => expect(setupCalls('connection.setup.begin').slice(0, 2).map(call => call.result !== undefined)).toEqual([true, true]))
  expect(native).toHaveLength(2)
  await enter(saved.connection); await click(`[data-management-original="${first.operationId}"]`); await click('[data-management-inspect]')
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
  await click(`[data-management-original="${b.operationId}"]`)
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
    expect(panel()?.querySelector('[data-management-code]')).toBeNull()
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
  expect(dom.container.textContent).not.toContain(USER); expect(dom.container.textContent).not.toContain(TENANT)
  expect(stage()).not.toBe('account'); expect(panel()?.querySelector('[data-management-code]')).toBeNull()
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
  await leavePrivate(); await enter(saved.connection); await click(`[data-management-original="${original.operationId}"]`)
  await ready(() => expect(setupCalls('connection.setup.inspect').some(call => (call.input as { operationId: string }).operationId === original.operationId && call.result !== undefined)).toBe(true))
  const observed = view(setupCalls('connection.setup.inspect').find(call => (call.input as { operationId: string }).operationId === original.operationId)!)
  if (position === 'before admission') { expect(observed.operation).toBeNull(); expect(native).toEqual([]) }
  else { expect(observed.operation?.operationId).toBe(original.operationId); expect(observed.challenge).not.toBeNull(); expect(native).toHaveLength(1) }
  expect(setupCalls('connection.setup.begin')).toHaveLength(1)
  if (position === 'after admission') {
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
