// @vitest-environment happy-dom
import { act, useState } from 'react'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DesktopConnectorSecrets } from '../src/main/connector-secrets.js'
import { AgentMuxControlServer } from '@agentmux/core'
import type { ConnectionMethod, ConnectionParamsMap, ConnectionRecord, ConnectionResultMap, ConnectionSetupAdvance, ConnectionSetupBegin, ConnectionSetupInspectionReceipt, ConnectionSetupConfigurationReceipt, ConnectionSetupAction, ConnectionSetupView } from '@agentmux/core/connections'
import { createDesktopConnections } from '../src/main/connector-host.js'
import { registerConnectorIpc } from '../src/main/connector-ipc.js'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'
import { enrollmentEncryption } from '../../../packages/connectors/test/fixtures/connection-enrollment.js'

const dom = composerDOM(), goal = { kind: 'agent-conversation', interaction: 'messages' } as const
const TOKEN = 'fixture-settings-configuration-private-qr', FLOW = 'fixture-settings-configuration-private-flow'
const USER = 'fixture-settings-configuration-account-id', TENANT = 'fixture-settings-configuration-enterprise-id', SECRET = 'fixture-settings-configuration-saved-secret'
type Call = { method: ConnectionMethod; input: unknown; result?: unknown; delivered?: boolean; error?: { code?: string; message: string } }
let directory: string, services: Awaited<ReturnType<typeof createDesktopConnections>>, server: AgentMuxControlServer
let forward: typeof api.connections.call, calls: Call[], beforeCall: ((call: Call) => Promise<void>) | undefined, afterCall: ((call: Call) => Promise<void>) | undefined
let native: Array<{ url: string; at: number; init?: RequestInit }>, trusted: ReturnType<typeof vi.fn>, secureAvailable: boolean
let reopen: () => void
const releases: Array<() => void> = []

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  directory = await mkdtemp(join(tmpdir(), 'settings-configuration-'))
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
async function cleanup(steps: Array<() => void | Promise<void>>) {
  const errors: unknown[] = []
  for (const step of steps) { try { await step() } catch (error) { errors.push(error) } }
  if (errors.length) throw new AggregateError(errors, 'Owned Settings configuration cleanup failed')
}
afterEach(async () => { await cleanup([
  ...releases.splice(0).map(release => () => { release() }),
  () => server?.stop(), () => { services?.close() }, () => rm(directory, { recursive: true, force: true }),
  () => { vi.restoreAllMocks() }, () => { vi.unstubAllGlobals() }
]) })

function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); releases.push(release); return { promise, release } }
function nativeRoute(options: { scanned?: boolean; poll?: () => Response | Promise<Response>; read?: () => Response | Promise<Response>; write?: () => Response | Promise<Response> } = {}) {
  let polls = 0
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const target = new URL(String(url)); native.push({ url: target.href, at: Date.now(), init })
    expect(init?.redirect).toBe('manual')
    if (target.origin === 'https://accounts.feishu.cn' && target.pathname === '/accounts/qrlogin/init') return Response.json({ code: 0, data: { step_info: { token: TOKEN } } }, { headers: {
      'x-flow-key': FLOW, 'set-cookie': 'session=fixture-settings-configuration-private-cookie; Domain=.feishu.cn; Path=/; Secure; HttpOnly'
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
    if (target.href === 'https://open.feishu.cn/app') return new Response(`<script>(function(){window.user=${JSON.stringify({ id: USER, tenantId: TENANT })};window.csrfToken="fixture-settings-configuration-private-csrf";})();</script>`, { headers: { 'content-type': 'text/html' } })
    if (target.pathname.startsWith('/developers/v1/robot/switch/')) return options.write ? await options.write() : Response.json({ code: 0, data: { privateReceipt: 'fixture-configuration-private-effect' } })
    if (target.pathname.startsWith('/developers/v1/robot/')) return options.read ? await options.read() : Response.json({ code: 0, data: { enable: false, verificationToken: 'fixture-configuration-private-bot' } })
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

function configuration() { return panel()?.querySelector<HTMLElement>('[data-management-configuration]') }
function originalId() { return (setupCalls('connection.setup.begin')[0]!.input as ConnectionSetupBegin).operationId }
function currentView(operationId = originalId()): ConnectionSetupView {
  const values = calls.filter(call => call.delivered && view(call)?.operation?.operationId === operationId && (view(call)?.applicationInspection || view(call)?.applicationConfiguration))
  expect(values.length, 'An actual delivered original owner view').toBeGreaterThan(0)
  return view(values.at(-1)!)
}
function action(view: ConnectionSetupView, kind: ConnectionSetupAction['kind']): ConnectionSetupAdvance {
  const choices = kind === 'enable-messaging' || kind === 'recover-configuration-effect' ? view.applicationConfiguration?.actions
    : kind === 'continue' || kind === 'confirm-account' || kind === 'renew' ? view.continuation?.actions : view.applicationInspection?.actions
  const offered = choices?.filter(value => value.kind === kind) ?? []
  expect(offered, 'One exact Host-offered ' + kind).toHaveLength(1)
  return { operationId: view.operation!.operationId, expectedRevision: offered[0].expectedRevision, decision: { actionId: offered[0].actionId, value: kind === 'confirm-account' || kind === 'enable-messaging' ? 'confirm' : kind === 'renew' ? 'renew' : 'continue' } }
}
function effect(view: ConnectionSetupView): ConnectionSetupConfigurationReceipt {
  expect(view.applicationConfiguration?.selected).toBeDefined(); expect(view.applicationConfiguration?.selected).not.toBeNull()
  return view.applicationConfiguration!.selected!
}
function readResult(view: ConnectionSetupView): ConnectionSetupInspectionReceipt {
  expect(view.applicationInspection?.selected).toBeDefined(); expect(view.applicationInspection?.selected).not.toBeNull()
  return view.applicationInspection!.selected!
}
const business = () => native.filter(value => new URL(value.url).pathname.startsWith('/developers/'))
const writes = () => native.filter(value => new URL(value.url).pathname.startsWith('/developers/v1/robot/switch/'))
async function signIn(record: ConnectionRecord, waitForActions = true) {
  await mount(); await select(record); await enter(record)
  await click('[data-management-start]'); await waitStage('account'); await click('[data-management-confirm]'); await waitStage('confirmed')
  if (waitForActions) await ready(() => { expect(configuration()).not.toBeNull(); expect(currentView().applicationInspection?.actions.some(a => a.kind === 'read-bot-settings')).toBe(true) })
}
async function clickAction(selector: string, kind: ConnectionSetupAction['kind'], operationId = originalId()) {
  const input = action(currentView(operationId), kind), before = setupCalls('connection.setup.advance').length
  await click(selector)
  await ready(() => { const advance = setupCalls('connection.setup.advance').slice(before).find(call => (call.input as ConnectionSetupAdvance).decision.actionId === input.decision.actionId); expect(advance?.delivered).toBe(true); expect(advance?.input).toEqual(input) })
  await ready(() => { expect(currentView(operationId).operation?.revision).toBeGreaterThanOrEqual(view(setupCalls('connection.setup.advance').slice(before).find(call => (call.input as ConnectionSetupAdvance).decision.actionId === input.decision.actionId)!).operation!.revision); expect(panel()?.querySelector('[aria-busy="true"]')).toBeNull() })
  return view(setupCalls('connection.setup.advance').slice(before).find(call => (call.input as ConnectionSetupAdvance).decision.actionId === input.decision.actionId)!)
}
async function prepared(record: ConnectionRecord, operationId: string) {
  let value = await forward('connection.setup.begin', beginInput(operationId, record))
  for (let i = 0; i < 8 && value.continuation?.stage !== 'account'; i++) {
    const remaining = (value.challenge?.nextPollAt ?? 0) - Date.now()
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining))
    value = await forward('connection.setup.advance', action(value, 'continue'))
  }
  expect(value.continuation?.stage).toBe('account')
  return await forward('connection.setup.advance', action(value, 'confirm-account'))
}
async function localView(operationId: string, selectedRead?: string, selectedEffect?: string) {
  return await forward('connection.setup.inspect', { operationId, applicationInspection: selectedRead ? { selectedStepId: selectedRead } : {}, applicationConfiguration: selectedEffect ? { effect: 'enable-messaging', selectedStepId: selectedEffect } : { effect: 'enable-messaging' } })
}
async function chooseOriginal(record: ConnectionRecord, operationId: string) {
  await enter(record)
  const before = setupCalls('connection.setup.inspect').length
  await click(`[data-management-original="${operationId}"]`)
  await ready(() => { expect(setupCalls('connection.setup.inspect').slice(before).some(call => (call.input as { operationId: string }).operationId === operationId && call.delivered)).toBe(true); expect(panel()?.querySelector('[aria-busy="true"]')).toBeNull() })
}
function assertPrivateFree(value: unknown) {
  for (const secret of [USER, TENANT, TOKEN, FLOW, SECRET, 'fixture-configuration-private-bot', 'fixture-configuration-private-effect']) expect(JSON.stringify(value)).not.toContain(secret)
}

it('original mounted Settings reads the exact bot, explicitly enables once and checks current state separately from native acceptance', async () => {
  const saved = await seed(), off = await forward('connection.service.configure', { operationId: 'settings-configuration-service-off', expectedRevision: 0, service: { enabled: false } })
  let enabled = false
  vi.stubGlobal('fetch', vi.fn(nativeRoute({ read: () => Response.json({ code: 0, data: { enable: enabled, verificationToken: 'fixture-configuration-private-bot' } }) })))
  calls = []; let failedSupplement = false
  afterCall = async call => { if (!failedSupplement && call.method === 'connection.setup.inspect' && view(call).continuation?.stage === 'confirmed') { failedSupplement = true; throw new Error('fixture-setup-actions-read-reply-lost') } }
  await signIn(saved.connection, false)
  await ready(() => expect(failedSupplement).toBe(true))
  expect(stage()).toBe('confirmed'); expect(panel()?.textContent).toContain(USER); expect(panel()?.textContent).toContain(TENANT)
  expect(business()).toEqual([]); expect(configuration()?.querySelector('[data-management-enable]')).toBeNull()
  afterCall = undefined
  await click('[data-management-inspect]')
  await ready(() => expect(currentView().applicationInspection?.actions.some(a => a.kind === 'read-bot-settings')).toBe(true))
  const read = await clickAction('[data-management-read-bot]', 'read-bot-settings')
  expect(readResult(read)).toMatchObject({ subject: 'bot-settings', request: 'confirmed', secureStorage: 'stored' })
  await settle(); expect(writes()).toEqual([])
  await ready(() => expect(currentView().applicationConfiguration?.capability).toBe('disabled'))
  const offered = action(currentView(), 'enable-messaging')
  expect(offered.decision.value).toBe('confirm')
  const accepted = await clickAction('[data-management-enable]', 'enable-messaging')
  expect(effect(accepted)).toMatchObject({ input: offered, request: 'confirmed', secureStorage: 'stored' })
  await ready(() => expect(currentView().applicationConfiguration?.capability).toBe('unknown'))
  expect(configuration()?.querySelector('[data-management-current-setting]')?.textContent).toBe('Check current setting')
  expect(configuration()?.querySelector('[data-management-enable]')).toBeNull()
  expect(writes()).toHaveLength(1)
  expect(writes()[0].url).toBe('https://open.feishu.cn/developers/v1/robot/switch/' + saved.connection.config.application.appId)
  expect(JSON.parse(String(writes()[0].init?.body))).toEqual({ enable: true })
  await settle(); expect(business()).toHaveLength(2)
  await clickAction('[data-management-current-setting]', 'read-bot-settings')
  expect(currentView().applicationConfiguration?.capability).toBe('disabled')
  expect(panel()?.querySelector('h3')?.textContent).toBe('Prepare your bot for conversations')
  expect(effect(currentView())).toEqual(effect(accepted))
  expect(configuration()?.querySelector('[data-management-enable]')).toBeNull()
  expect(writes()).toHaveLength(1); expect(business()).toHaveLength(3)
  enabled = true
  await clickAction('[data-management-current-setting]', 'read-bot-settings')
  await ready(() => expect(currentView().applicationConfiguration?.capability).toBe('enabled'))
  expect(configuration()?.querySelector('[data-management-current-setting]')?.textContent).toBe('Check current setting')
  expect(panel()?.textContent).not.toMatch(/connection ready|setup complete|ready to chat/iu)
  expect(configuration()?.querySelector('[data-management-enable]')).toBeNull(); expect(writes()).toHaveLength(1)
  expect(business().map(value => new URL(value.url).pathname)).toEqual(['/developers/v1/robot/' + saved.connection.config.application.appId, '/developers/v1/robot/switch/' + saved.connection.config.application.appId, '/developers/v1/robot/' + saved.connection.config.application.appId, '/developers/v1/robot/' + saved.connection.config.application.appId])
  await click('[data-management-console]'); expect(api.ui.openExternal).toHaveBeenCalledWith('https://open.feishu.cn/app')
  await leavePrivate(); expect(dom.container.querySelector('[data-connection-check]')).not.toBeNull()
  expectNoSetupWrites(); await unchanged(saved); expect(await forward('connection.service.get', {})).toEqual(off.service)
  expect(trusted.mock.calls.map(value => value[0])).toContain('connections:call')
  assertPrivateFree(await forward('connection.setup.ls', { connectionId: saved.connection.config.connectionId }))
  assertPrivateFree({ local: { ...localStorage }, session: { ...sessionStorage } })
}, 30_000)

it('unknown enable is kept across Settings close and local query; a distinct explicit current read never ACKs it or submits a replacement', async () => {
  const saved = await seed(); calls = []; let enabled = false
  vi.stubGlobal('fetch', vi.fn(nativeRoute({ read: () => Response.json({ code: 0, data: { enable: enabled } }), write: () => { throw new TypeError('fixture-original-write-response-unconfirmed') } })))
  await signIn(saved.connection); await clickAction('[data-management-read-bot]', 'read-bot-settings')
  const unknown = effect(await clickAction('[data-management-enable]', 'enable-messaging')), operationId = originalId()
  expect(unknown.request).toBe('unknown'); expect(writes()).toHaveLength(1)
  const count = native.length
  await click('[data-management-original-effect]')
  await ready(() => expect(currentView().applicationConfiguration?.selected).toEqual(unknown))
  expect(native).toHaveLength(count)
  await click('[aria-label="Close settings"]'); await act(async () => reopen()); await chooseOriginal(saved.connection, operationId)
  expect(effect(currentView())).toEqual(unknown); expect(native).toHaveLength(count)
  expect(configuration()?.querySelector('[data-management-enable]')).toBeNull()
  enabled = true
  await clickAction('[data-management-current-setting], [data-management-read-bot]', 'read-bot-settings')
  expect(currentView().applicationConfiguration?.capability).toBe('enabled')
  expect(effect(currentView())).toEqual(unknown); expect(currentView().applicationConfiguration?.reason).toBe('original-effect-unconfirmed')
  expect(writes()).toHaveLength(1); expect(native.length - count).toBe(1)
  expect(setupCalls('connection.setup.begin')).toHaveLength(1)
  expect(configuration()?.querySelector('[data-management-enable]')).toBeNull()
  await leavePrivate(); expectNoSetupWrites(); await unchanged(saved)
}, 30_000)

it('selected original read and effect ACKs repair locally with their own revisions, including after expired sign-in and saved-target revision', async () => {
  const saved = await seed(); calls = []; let expire = false
  vi.stubGlobal('fetch', vi.fn(nativeRoute({ poll: () => Response.json({ code: 0, data: { next_step: expire ? null : 'enter_app', step_info: expire ? { status: 5 } : { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross-login' } } }) })))
  await signIn(saved.connection)
  const originalStore = DesktopConnectorSecrets.prototype.store
  const loseAck = () => vi.spyOn(DesktopConnectorSecrets.prototype, 'store').mockImplementationOnce(async function(this: DesktopConnectorSecrets, input) { await originalStore.call(this, input); throw new Error('fixture-committed-private-ack-lost') })
  const readFault = loseAck(), failedRead = await clickAction('[data-management-read-bot]', 'read-bot-settings'); readFault.mockRestore()
  const originalRead = readResult(failedRead)
  expect(originalRead).toMatchObject({ request: 'confirmed', secureStorage: 'unknown' })
  await click(`[data-management-read-result="${originalRead.stepId}"]`)
  await ready(() => expect(currentView().applicationInspection?.selected).toEqual(originalRead))
  const readRecovery = action(currentView(), 'recover-application-inspection'), nativeBeforeReadRepair = native.length
  expect(readRecovery.expectedRevision).toBe(originalRead.input.expectedRevision)
  expect(readRecovery.expectedRevision).toBeLessThan(currentView().operation!.revision)
  await clickAction('[data-management-recover-read]', 'recover-application-inspection')
  expect(currentView().applicationInspection?.selected).toEqual({ ...originalRead, secureStorage: 'stored' }); expect(native).toHaveLength(nativeBeforeReadRepair)
  const effectFault = loseAck(), failedEffect = await clickAction('[data-management-enable]', 'enable-messaging'); effectFault.mockRestore()
  const originalEffect = effect(failedEffect), operationId = originalId()
  expect(originalEffect).toMatchObject({ request: 'confirmed', secureStorage: 'unknown' })
  await leavePrivate(); expire = true
  const renewed = await forward('connection.setup.advance', action(await forward('connection.setup.inspect', { operationId }), 'renew'))
  const expired = await forward('connection.setup.advance', action(renewed, 'continue'))
  expect(expired.continuation?.stage).toBe('expired')
  const revised = await forward('connection.configure', { operationId: 'settings-configuration-revised-save', expectedRevision: saved.connection.revision, connection: { ...saved.connection.config, label: 'Revised original bot' } })
  const count = native.length, beginCount = setupCalls('connection.setup.begin').length
  await dom.render(null); await mount(); await select(revised.connection); await chooseOriginal(revised.connection, operationId)
  await click(`[data-management-effect-result="${originalEffect.stepId}"]`)
  await ready(() => expect(effect(currentView(operationId))).toEqual(originalEffect))
  expect(panel()?.querySelector('[data-management-code]')).toBeNull()
  expect(configuration()?.querySelector('[data-management-recover-effect]')).not.toBeNull()
  const recovery = action(currentView(operationId), 'recover-configuration-effect')
  expect(recovery.expectedRevision).toBe(originalEffect.input.expectedRevision); expect(recovery.expectedRevision).toBeLessThan(currentView(operationId).operation!.revision)
  await clickAction('[data-management-recover-effect]', 'recover-configuration-effect', operationId)
  expect(effect(currentView(operationId))).toEqual({ ...originalEffect, secureStorage: 'stored' })
  expect(currentView(operationId).applicationConfiguration?.capability).toBe('unknown')
  expect(native).toHaveLength(count); expect(setupCalls('connection.setup.begin')).toHaveLength(beginCount); expect(writes()).toHaveLength(1)
  expect((await forward('connection.inspect', { operationId: saved.operationId })).operation).toEqual(saved)
  expect((await forward('connection.inspect', { connectionId: saved.connection.config.connectionId })).connection).toEqual(revised.connection)
}, 40_000)
it('bounded original activity pages and selecting an old false are local, never repair or enable after a later unknown bot read', async () => {
  const saved = await seed(), operationId = 'settings-configuration-history'; calls = []
  let confirmed = true
  vi.stubGlobal('fetch', vi.fn(nativeRoute({ read: () => Response.json({ code: 0, data: confirmed ? { enable: false } : [] }) })))
  await prepared(saved.connection, operationId)
  const receipts: ConnectionSetupInspectionReceipt[] = []
  for (let i = 0; i < 26; i++) {
    const value = await localView(operationId)
    receipts.push(readResult(await forward('connection.setup.advance', action(value, 'read-bot-settings'))))
  }
  confirmed = false
  const latest = readResult(await forward('connection.setup.advance', action(await localView(operationId), 'read-bot-settings')))
  expect(latest.request).toBe('unknown'); expect(receipts).toHaveLength(26)
  const count = native.length, advances = setupCalls('connection.setup.advance').length
  await mount(); await select(saved.connection); await chooseOriginal(saved.connection, operationId)
  expect(currentView(operationId).applicationConfiguration?.capability).toBe('unknown')
  expect(configuration()?.querySelector('[data-management-enable]')).toBeNull()
  await click('[data-management-activity] > summary')
  expect(panel()?.querySelector(`[data-management-read-result="${receipts[0].stepId}"]`)).toBeNull()
  const cursor = currentView(operationId).applicationInspection!.next
  expect(cursor).toEqual(expect.any(String)); expect(cursor).not.toBe('')
  await click('[data-management-more-reads]')
  await ready(() => expect(setupCalls('connection.setup.inspect').some(call => (call.input as { applicationInspection?: { cursor?: string } }).applicationInspection?.cursor === cursor && call.delivered)).toBe(true))
  await click(`[data-management-read-result="${receipts[0].stepId}"]`)
  await ready(() => expect(currentView(operationId).applicationInspection?.selected).toEqual(receipts[0]))
  const selectedRow = panel()?.querySelector<HTMLElement>(`[data-management-read-result="${receipts[0].stepId}"]`)
  expect(selectedRow).not.toBeNull()
  expect(selectedRow?.getAttribute('aria-pressed')).toBe('true')
  expect(selectedRow?.textContent).toContain(receipts[0].stepId)
  expect(selectedRow?.closest<HTMLDetailsElement>('details')?.open).toBe(true)
  expect(selectedRow?.closest('[hidden], [inert]')).toBeNull()
  expect(currentView(operationId).applicationConfiguration?.capability).toBe('unknown')
  expect(configuration()?.querySelector('[data-management-enable]')).toBeNull()
  expect(native).toHaveLength(count); expect(setupCalls('connection.setup.advance')).toHaveLength(advances); expect(writes()).toEqual([])
  assertPrivateFree(currentView(operationId).applicationInspection)
  expectNoSetupWrites(); await unchanged(saved)
}, 40_000)

it.each(['API source', 'another target', 'Settings close'] as const)('a real late bot read cannot revive its private view or configuration action after leaving for %s', async exit => {
  const saved = await seed('settings-configuration-target-a'), other = await seed('settings-configuration-target-b', 'cli_settings_configuration_other_bot'); calls = []
  await signIn(saved.connection)
  const delayed = deferred(); let held: Call | undefined
  afterCall = async call => { if (!held && call.method === 'connection.setup.inspect' && view(call).applicationConfiguration?.capability === 'disabled') { held = call; await delayed.promise } }
  const input = action(currentView(), 'read-bot-settings')
  await click('[data-management-read-bot]'); await ready(() => expect(held).toBeDefined())
  expect(setupCalls('connection.setup.advance').at(-1)?.input).toEqual(input)
  expect(business()).toHaveLength(1); expect(writes()).toEqual([])
  const source = api.connections.call
  try {
    if (exit === 'API source') {
      api.connections.call = async <M extends ConnectionMethod>(method: M, params: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => await forward(method, params)
      await dom.render(<MountedSettings />)
      await ready(() => expect(setupCalls('connection.setup.ls').length).toBeGreaterThan(1))
    } else if (exit === 'another target') {
      await leavePrivate(); await click('[data-connection-editor] > .connector-back'); await select(other.connection); await enter(other.connection)
    } else {
      await click('[aria-label="Close settings"]'); await act(async () => reopen()); await enter(saved.connection)
    }
    await act(async () => { delayed.release(); await delayed.promise }); await ready(() => expect(held?.delivered).toBe(true)); await settle()
    expect(panel()?.dataset.managementSetup).toBe(exit === 'another target' ? other.connection.config.connectionId : saved.connection.config.connectionId)
    expect(panel()?.querySelector('[data-management-enable]')).toBeNull()
    expect(panel()?.querySelector('[data-management-code]')).toBeNull()
    expect(dom.container.textContent).not.toContain(USER); expect(dom.container.textContent).not.toContain(TENANT)
    expect(writes()).toEqual([]); expect(business()).toHaveLength(1)
    expectNoSetupWrites(); await unchanged(saved); await unchanged(other)
  } finally { api.connections.call = source }
}, 30_000)

it('same-Connection unresolved requests select the original operation locally while another Connection only shows its safe location and bot-library exit', async () => {
  const saved = await seed(), alias = await seed('settings-configuration-alias', saved.connection.config.application.appId)
  const original = 'settings-configuration-original-effect', next = 'settings-configuration-next-task', cross = 'settings-configuration-cross-connection'
  vi.stubGlobal('fetch', vi.fn(nativeRoute({ write: () => { throw new TypeError('fixture-original-enable-ack-unknown') } })))
  calls = []
  await prepared(saved.connection, original)
  await forward('connection.setup.advance', action(await localView(original), 'read-bot-settings'))
  const uncertain = effect(await forward('connection.setup.advance', action(await localView(original), 'enable-messaging')))
  await prepared(saved.connection, next)
  await forward('connection.setup.advance', action(await localView(next), 'read-bot-settings'))
  await prepared(alias.connection, cross)
  await forward('connection.setup.advance', action(await localView(cross), 'read-bot-settings'))
  const count = native.length, advances = setupCalls('connection.setup.advance').length
  await mount(); await select(saved.connection); await chooseOriginal(saved.connection, next)
  expect(currentView(next).applicationConfiguration?.unresolved).toEqual({ operationId: original, connectionId: saved.connection.config.connectionId, stepId: uncertain.stepId })
  await click('[data-management-original-effect]')
  await ready(() => expect(effect(currentView(original))).toEqual(uncertain))
  const selection = setupCalls('connection.setup.inspect').at(-1)!.input
  expect(selection).toMatchObject({ operationId: original, applicationConfiguration: { selectedStepId: uncertain.stepId } })
  expect(native).toHaveLength(count)
  await leavePrivate(); await click('[data-connection-editor] > .connector-back'); await select(alias.connection); await chooseOriginal(alias.connection, cross)
  const before = setupCalls('connection.setup.inspect').length
  expect(panel()?.querySelector('[data-management-unresolved]')).not.toBeNull()
  expect(panel()?.querySelector('[data-management-unresolved]')?.textContent).toContain(saved.connection.config.connectionId)
  expect(panel()?.querySelector('[data-management-original-effect]')).toBeNull()
  expect(panel()?.querySelector('[data-management-enable]')).toBeNull()
  await click('[data-management-library]')
  await ready(() => expect(dom.container.querySelector(`[data-connection="${saved.connection.config.connectionId}"]`)).not.toBeNull())
  expect(panel()).toBeNull(); expect(setupCalls('connection.setup.inspect')).toHaveLength(before)
  expect(native).toHaveLength(count); expect(setupCalls('connection.setup.advance')).toHaveLength(advances); expect(writes()).toHaveLength(1)
  expectNoSetupWrites(); await unchanged(saved); await unchanged(alias)
}, 40_000)

it('a delayed accepted effect after a newer selection stays an original receipt and cannot automatically check or enable another saved bot', async () => {
  const saved = await seed('settings-configuration-enable-a'), other = await seed('settings-configuration-enable-b', 'cli_settings_configuration_enable_b'); calls = []
  await signIn(saved.connection); await clickAction('[data-management-read-bot]', 'read-bot-settings')
  const delayed = deferred(); let held: Call | undefined
  afterCall = async call => { if (!held && call.method === 'connection.setup.advance' && view(call).applicationConfiguration?.selected?.request === 'confirmed') { held = call; await delayed.promise } }
  const input = action(currentView(), 'enable-messaging')
  await click('[data-management-enable]'); await ready(() => expect(held).toBeDefined())
  expect(held!.input).toEqual(input); expect(writes()).toHaveLength(1)
  await leavePrivate(); await click('[data-connection-editor] > .connector-back'); await select(other.connection); await enter(other.connection)
  const count = native.length
  await act(async () => { delayed.release(); await delayed.promise }); await ready(() => expect(held?.delivered).toBe(true)); await settle()
  expect(panel()?.dataset.managementSetup).toBe(other.connection.config.connectionId)
  expect(panel()?.querySelector('[data-management-enable]')).toBeNull()
  expect(panel()?.querySelector('[data-management-current-setting]')).toBeNull()
  expect(dom.container.textContent).not.toContain(USER); expect(dom.container.textContent).not.toContain(TENANT)
  expect(native).toHaveLength(count); expect(writes()).toHaveLength(1)
  const original = await localView((input as ConnectionSetupAdvance).operationId)
  expect(effect(original)).toMatchObject({ input, request: 'confirmed', secureStorage: 'stored' })
  expectNoSetupWrites(); await unchanged(saved); await unchanged(other)
}, 30_000)
