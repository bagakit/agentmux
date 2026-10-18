// @vitest-environment happy-dom
import { unwrapSessionInputOperationResult } from '../src/shared/session-input-result.js'
import { act } from 'react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '@agentmux/core'
import type { ConnectionMethod, ConnectionParamsMap, ConnectionResultMap, ConnectionSetupView } from '@agentmux/core/connections'
import { DesktopConnectorSecrets } from '../src/main/connector-secrets.js'
import { createDesktopConnections } from '../src/main/connector-host.js'
import { registerConnectorIpc } from '../src/main/connector-ipc.js'
import { api } from '../src/renderer/src/lib/api'
import { createMoteApp } from './fixtures/mote-app'
import { useAppStore } from '../src/renderer/src/store'
import { defaultAgent, ordinaryAgent } from './fixtures/mote-workface'
import { enrollmentEncryption } from '../../../packages/connectors/test/fixtures/connection-enrollment.js'

const APP = 'cli_guided_setup', VERSION = 'guided-original-version'
let app: ReturnType<typeof createMoteApp>
const dom = { get container() { return document.body } }
const SCOPES = ['im:message:send_as_bot', 'im:message:readonly', 'im:message.group_msg', 'im:chat:create', 'im:chat:read', 'im:chat.members:read', 'im:chat.members:write_only', 'application:application:self_manage']
let bot: boolean, mode: number, callbackMode: number, cards: boolean, permissions: boolean, reception: boolean, submitted: boolean
let directory: string, services: Awaited<ReturnType<typeof createDesktopConnections>>, server: AgentMuxControlServer
let failObservation: boolean, accept: boolean, native: Array<{ path: string; body: unknown }>, calls: Array<{ method: ConnectionMethod; input: unknown; result: unknown }>
beforeEach(async () => {
  app = createMoteApp(); bot = false; mode = 1; callbackMode = 1; cards = false; permissions = false; reception = false; submitted = false;
  failObservation = false; accept = true; native = []; calls = []
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  directory = await mkdtemp(join(tmpdir(), 'settings-publication-transport-'))
  services = await createDesktopConnections({ directory: join(directory, 'connections'), encryption: enrollmentEncryption() })
  server = new AgentMuxControlServer({ socketPath: join(directory, 'owner.sock'), connections: services.connections, coreClients: () => { throw new Error('Publication settings cannot borrow an Agent Runtime') } })
  await server.start()
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>(), sender = { ownedRenderer: true }
  registerConnectorIpc({ handleWithEvent: (channel, handler) => handlers.set(channel, handler), assertTrusted: (channel, caller) => { expect(channel).toBe('connections:call'); expect(caller).toBe(sender) }, socketPath: server.path, secrets: services.secrets })
  vi.spyOn(api.connections, 'call').mockImplementation(async <M extends ConnectionMethod>(method: M, input: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
    if (failObservation && method === 'connection.setup.inspect') { failObservation = false; throw Error('Application observation interrupted') }
    const result = unwrapSessionInputOperationResult(await handlers.get('connections:call')!(sender, method, input))
    calls.push({ method, input: structuredClone(input), result: structuredClone(result) })
    return result as ConnectionResultMap[M]
  })
  const pending = { ChangeScope: { scopeNames: { 'scope-original': 'Original application permission' }, addScopesV2: ['scope-original'], removeScopesV2: [], addUserTypeScopes: [], removeUserTypeScopes: [], addTenantTypeScopes: [], removeTenantTypeScopes: [] }, changeClientSystemScope: { addScopesV2: [], removeScopesV2: [] }, changeEventConfig: { changed: true, eventModeChanged: false }, changeBotCardCallbackConfig: { abilityEnableState: 0, callbackMode: 1, callbackModeChanged: false }, changeExtension: { status: 1 }, changePrivilege: { changed: false, privileges: [] }, contactRangeDetail: {}, changeAllowRefreshToken: { changed: false, allowRefreshToken: false }, pcDefaultAbility: 'web-app', mobileDefaultAbility: 'web-app', pcDefaultAbilityList: ['bot', 'web-app'], mobileDefaultAbilityList: ['web-app'], equalToVisible: false, applyReasonConfig: { apiPrivilegeNeedReason: true, dataPrivilegeNeedReason: false, isDataPrivilegeExpandMap: {}, contactPrivilegeNeedReason: false, isContactExpand: false, visibleScopeNeedReason: true } }
  const visibility = { whiteList: { departments: [{ id: 17 }], members: [{ id: 'original-person' }], groups: [{ id: 'original-group' }], isAll: 0 }, blackList: { departments: [{ id: 'excluded-department' }], members: [{ id: 29 }], groups: [{ id: 31 }], isAll: 0 } }
  const versions = [{ versionId: 'unrelated-list-head', appVersion: '1.0.0', versionStatus: 2 }]
  const features = { hitFeatureKeyList: ['openplatform.b2c.bot_b2c_share_switch_split'] }, sharing = { onlineB2CShareSplitConfig: { b2cGroupChatShareEnable: true, b2cP2PChatShareEnable: true, b2cP2PChatNeedAudit: false } }
  const detail = { ...pending, ChangeScope: undefined, changeScope: pending.ChangeScope, appVersion: '1.1.0', versionStatus: 4, visibleRange: visibility, changeLog: 'Original selected version release notes', pcDefaultAbility: 'desktop-existing', mobileDefaultAbility: '', changeAppShareConfig: { b2cShareSplitConfigSuggest: { b2cGroupChatShareEnable: false, b2cP2PChatShareEnable: true, b2cP2PChatNeedAudit: true } }, changeB2BShareConfig: { changed: true, status: true } }
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(url)); native.push({ path: target.pathname, body: JSON.parse(String(init?.body ?? '{}')) })
    if (target.pathname === '/accounts/qrlogin/init') return Response.json({ code: 0, data: { step_info: { token: 'settings-publication-private-token' } } }, { headers: { 'x-flow-key': 'settings-publication-private-flow', 'set-cookie': 'session=settings-publication-private-cookie; Domain=.feishu.cn; Path=/; Secure' } })
    if (target.pathname === '/accounts/qrlogin/polling') return Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross' } } })
    if (target.href === 'https://accounts.feishu.cn/cross') return new Response(null, { status: 302, headers: { location: 'https://ask.feishu.cn/' } })
    if (target.href === 'https://ask.feishu.cn/') return new Response('Landing does not qualify an account')
    if (target.href === 'https://open.feishu.cn/app') return new Response('<script>window.user={"id":"settings-publication-user","tenantId":"settings-publication-enterprise"};window.csrfToken="settings-publication-private-csrf";</script>', { headers: { 'content-type': 'text/html' } })
    if (target.pathname === '/developers/v1/app_version/change/' + APP) return Response.json({ code: 0, data: pending })
    if (target.pathname === '/developers/v1/app_version/list/' + APP) return Response.json({ code: 0, data: { versions: [...versions, { versionId: VERSION, appVersion: '1.1.0', versionStatus: 4 }] } })
    if (target.pathname === '/developers/v1/visible/online/' + APP) return Response.json({ code: 0, data: visibility })
    if (target.pathname === '/developers/v1/b2c_share/' + APP) return Response.json({ code: 0, data: sharing })
    if (target.pathname === '/developers/v1/developer_panel/config') return Response.json({ code: 0, data: features })
    if (target.pathname === '/developers/v1/app_version/detail/' + APP + '/' + VERSION) return Response.json({ code: 0, data: { ...detail, versionStatus: submitted ? 1 : 4 } })
    if (target.pathname === '/developers/v1/app_version/create/' + APP) return accept ? Response.json({ code: 0, data: { versionId: VERSION } }) : new Response('Unconfirmed', { status: 502 })
    if (target.pathname === '/developers/v1/publish/commit/' + APP + '/' + VERSION) { submitted = true; return Response.json({ code: 0, data: { urlConflict: false, avatar: 'original-avatar', isOk: true } }) }
    if (target.pathname === '/developers/v1/robot/' + APP) return Response.json({ code: 0, data: { enable: bot } })
    if (target.pathname === '/developers/v1/robot/switch/' + APP) { bot = true; return accept ? Response.json({ code: 0, data: {} }) : new Response('Unconfirmed', { status: 502 }) }
    if (target.pathname === '/developers/v1/event/' + APP) return Response.json({ code: 0, data: { eventMode: mode, appEventDetails: reception ? [{ items: [{ id: 'im.message.receive_v1' }] }] : [] } })
    if (target.pathname === '/developers/v1/event/switch/' + APP) { mode = 4; return Response.json({ code: 0, data: {} }) }
    if (target.pathname === '/developers/v1/event/all/' + APP) return Response.json({ code: 0, data: { events: [{ items: [{ id: 'im.message.receive_v1', supportIdentityTypes: [2] }] }] } })
    if (target.pathname === '/developers/v1/event/update/' + APP) { reception = true; return Response.json({ code: 0, data: {} }) }
    if (target.pathname === '/developers/v1/callback/' + APP) return Response.json({ code: 0, data: { callbackMode, callbacks: cards ? ['unrelated.callback', 'card.action.trigger'] : ['unrelated.callback'] } })
    if (target.pathname === '/developers/v1/callback/switch/' + APP) { callbackMode = 4; return Response.json({ code: 0, data: {} }) }
    if (target.pathname === '/developers/v1/callback/update/' + APP) { cards = true; return Response.json({ code: 0, data: {} }) }
    if (target.pathname === '/developers/v1/scope/all/' + APP) return Response.json({ code: 0, data: { scopes: SCOPES.map((name, index) => ({ name, id: index + 1, scopeType: [2] })) } })
    if (target.pathname === '/developers/v1/scope/applied/' + APP) return Response.json({ code: 0, data: { scopes: permissions ? SCOPES.map((_, index) => ({ id: index + 1, scopeIdentityType: 2 })) : [] } })
    if (target.pathname === '/developers/v1/scope/update/' + APP) { permissions = true; return Response.json({ code: 0, data: { needConfigurePrivilege: false } }) }
    throw new Error('Unexpected publication native request')
  }))
  const credential = await services.secrets.store({ operationId: 'settings-publication-credential', secret: 'settings-publication-private-secret' })
  await services.connections.configure({ operationId: 'settings-publication-save', expectedRevision: null, connection: { connectionId: 'settings-publication-bot', adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: APP }, label: 'Agent conversation bot', enabled: false, credentialRef: credential.credentialRef } })
})
afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of [() => app?.dispose(), () => server?.stop(), () => services?.close(), () => rm(directory, { recursive: true, force: true }), () => { vi.restoreAllMocks() }]) try { await cleanup() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Publication Settings cleanup failed')
})
afterAll(() => vi.unstubAllGlobals())
async function ready(check: () => void) {
  const deadline = Date.now() + 12_000
  for (;;) {
    // Keep asynchronous IPC and React updates inside the same actual readiness turn.
    await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)) })
    try { check(); return } catch (error) { if (Date.now() >= deadline) throw error }
  }
}
async function click(selector: string) {
  let button: HTMLButtonElement | null = null
  await ready(() => { button = dom.container.querySelector(selector); expect(button, selector).not.toBeNull(); expect(button!.hasAttribute('disabled'), selector).toBe(false) })
  const details = button!.closest<HTMLDetailsElement>('details:not([open])')
  if (details) await act(async () => details.querySelector<HTMLElement>('summary')!.click())
  expect(button!.closest('[hidden], [inert]')).toBeNull()
  await act(async () => button!.click())
}
const writes = () => native.filter(call => ['/robot/switch/', '/event/switch/', '/scope/update/', '/event/update/', '/callback/switch/', '/callback/update/', '/app_version/create/', '/publish/commit/'].some(path => call.path.includes(path)))
async function idle() { await ready(() => expect(document.querySelector('[data-management-setup] > .connector-enrollment__action')?.getAttribute('aria-busy')).toBe('false')) }
function firstLayerPrimaries() { return [...document.querySelectorAll('[data-management-setup] .primary-button')].filter(button => !button.closest('details:not([open])')) }
function current() { return calls.filter(call => (call.result as ConnectionSetupView)?.applicationConfiguration).at(-1)?.result as ConnectionSetupView }
async function open() {
  await app.mount()
  await click('[aria-label="Settings"]'); await click('nav [data-settings-target="lark"]')
  await click('[data-connection="settings-publication-bot"] button'); await click('[data-management-open]'); await click('[data-management-start]')
  await ready(() => expect(dom.container.querySelector('[data-management-confirm]')).not.toBeNull())
  expect(dom.container.querySelector('[data-bot-setup-guide]')?.getAttribute('data-bot-setup-guide')).toBe('account')
  await click('[data-management-confirm]')
  await ready(() => expect(dom.container.querySelector('[data-guided-primary]')).not.toBeNull())
  expect(dom.container.querySelectorAll('[data-bot-setup-guide]')).toHaveLength(1)
  expect(dom.container.querySelector('[data-management-setup] > [data-bot-setup-guide]')?.getAttribute('data-bot-setup-guide')).toBe('connect')
}

async function fill(label: string, value: string) {
  let element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null = null
  await ready(() => { element = dom.container.querySelector('[aria-label="' + label + '"]'); expect(element, label).not.toBeNull(); expect(element!.disabled, label).toBe(false) })
  const input = element!
  await act(async () => {
    const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : input.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  })
}
async function reviewCreationSources() {
  const feature = () => { const configuration = current()?.applicationConfiguration; return configuration && 'sources' in configuration && 'features' in configuration.sources ? configuration.sources.features?.stepId : undefined }
  const before = feature()
  await click('[data-publication-review]')
  await ready(() => {
    expect(feature()).toBeDefined(); expect(feature()).not.toBe(before)
    expect(current().applicationInspection?.selected?.subject).toBe('publication-features')
    expect(dom.container.querySelector<HTMLButtonElement>('[data-publication-review]')?.disabled).toBe(false)
  })
}
async function reviewCreation() {
  await fill('Publication version', '1.1.0'); await fill('Publication release notes', 'Original user-authored release notes')
  await reviewCreationSources()
  await ready(() => expect(dom.container.querySelector('[aria-label="Publication review reason"]')).not.toBeNull())
  await fill('Publication review reason', 'Explain the application permission change')
  await reviewCreationSources()
  await ready(() => expect(dom.container.querySelector('[data-publication-confirm]')).not.toBeNull())
}

it('the actual App keeps one guided task, reads only this bot and explicitly confirms each necessary write before publication', async () => {
  await open(); expect(writes()).toEqual([])
  await click('[data-guided-primary]')
  await idle()
  expect(dom.container.querySelector('[data-guided-primary]')?.textContent).toBe('Turn on bot messages')
  expect(firstLayerPrimaries()).toHaveLength(1)
  expect(native.filter(call => call.path.startsWith('/developers/'))).toEqual([{ path: '/developers/v1/robot/' + APP, body: {} }])
  expect(writes()).toEqual([])
  await click('[data-guided-primary]')
  await ready(() => expect(current().applicationConfiguration!.selected?.secureStorage).toBe('stored'))
  expect(writes()).toHaveLength(1)
  await click('[data-guided-primary]')
  await ready(() => expect(document.querySelector('[data-guided-primary]')?.textContent).toBe('Use persistent connection'))
  expect(writes()).toHaveLength(1)
  await click('[data-guided-primary]')
  await ready(() => expect(current().applicationConfiguration!.selected?.secureStorage).toBe('stored'))
  await click('[data-guided-primary]')
  await ready(() => expect(document.querySelector('[data-guided-primary]')?.textContent).toBe('Request required permissions'))
  expect(writes()).toHaveLength(2)
  await click('[data-guided-primary]')
  await ready(() => expect(current().applicationConfiguration!.selected?.secureStorage).toBe('stored'))
  await click('[data-guided-primary]')
  await ready(() => expect(document.querySelector('[data-guided-primary]')?.textContent).toBe('Add message reception'))
  expect(writes()).toHaveLength(3)
  await click('[data-guided-primary]')
  await ready(() => expect(current().applicationConfiguration!.selected?.secureStorage).toBe('stored'))
  await click('[data-guided-primary]')
  await ready(() => expect(document.querySelector('[data-guided-primary]')?.textContent).toBe('Connect card interactions'))
  expect(writes()).toHaveLength(4)
  await click('[data-guided-primary]')
  await ready(() => expect(current().applicationConfiguration!.selected?.secureStorage).toBe('stored'))
  await click('[data-guided-primary]')
  await ready(() => expect(document.querySelector('[data-guided-primary]')?.textContent).toBe('Enable card replies'))
  expect(writes()).toHaveLength(5)
  await click('[data-guided-primary]')
  await ready(() => expect(current().applicationConfiguration!.selected?.secureStorage).toBe('stored'))
  await click('[data-guided-primary]')
  await ready(() => expect(document.querySelector('[aria-label="Publication version"]')).not.toBeNull())
  expect(writes()).toHaveLength(6)
  await reviewCreation(); await click('[data-publication-confirm]')
  await ready(() => expect(document.querySelector('[data-publication-review-created]')).not.toBeNull())
  await click('[data-publication-review-created]')
  await ready(() => expect(document.querySelector('[data-publication-confirm]')).not.toBeNull())
  await click('[data-publication-confirm]')
  await ready(() => expect(document.querySelector('[data-guided-primary]')?.textContent).toBe('Check version status'))
  expect(writes()).toHaveLength(8)
  await click('[data-guided-primary]')
  await ready(() => expect(document.querySelector('[data-guided-task]')?.textContent).toContain('Waiting for platform review'))
  expect(writes()).toHaveLength(8); expect(app.launch).not.toHaveBeenCalled()
}, 30_000)

it('a failed settings check stops its finite reads, removes prior authority and retries the same setup without calling the failure a sign-in result', async () => {
  await open(); bot = true
  const call = vi.mocked(api.connections.call).getMockImplementation()!
  let failed = false
  vi.mocked(api.connections.call).mockImplementation(async (method, input) => {
    if (!failed && method === 'connection.setup.inspect' && 'applicationConfiguration' in input && input.applicationConfiguration?.effect === 'use-persistent-connection') { failed = true; throw Error('Current settings check interrupted') }
    return call(method, input)
  })
  await click('[data-guided-primary]'); await idle()
  expect(document.querySelector('.connector-management .connector-editor-title')?.textContent).toBe('Setup check interrupted')
  expect(document.querySelector('[data-guided-primary]')).toBeNull()
  expect(document.querySelector('.connector-management__account')).not.toBeNull()
  expect(document.querySelector('.connector-management__account')?.textContent).toContain('Last confirmed account')
  expect(document.querySelector('[data-bot-setup-guide] [aria-current="step"]')?.textContent).toContain('Configure & publish')
  expect(document.querySelector('[data-management-inspect]')?.textContent).toBe('Retry setup check')
  expect(native.filter(call => call.path.startsWith('/developers/')).map(call => call.path)).toEqual(['/developers/v1/robot/' + APP])
  expect(writes()).toEqual([])
  const operationId = calls.find(call => call.method === 'connection.setup.begin')!.input as ConnectionParamsMap['connection.setup.begin']
  await click('[data-management-inspect]'); await idle()
  expect(current().operation?.operationId).toBe(operationId.operationId)
  expect(document.querySelector('[data-guided-primary]')).not.toBeNull()
  expect(writes()).toEqual([])
}, 30_000)

it.each(['close', 'another-bot'] as const)('a late settings result after %s cannot publish old account actions or continue the finite reads', async change => {
  if (change === 'another-bot') {
    const record = (await services.connections.list()).connections[0]!
    await services.connections.configure({ operationId: 'guided-cancel-another-bot', expectedRevision: null, connection: { ...record.config, connectionId: 'another-bot', label: 'Another bot' } })
  }
  await open(); bot = true
  const call = vi.mocked(api.connections.call).getMockImplementation()!
  let release!: () => void, pending: Promise<unknown> | undefined
  const barrier = new Promise<void>(resolve => { release = resolve })
  vi.mocked(api.connections.call).mockImplementation((method, input) => {
    const request = (async () => {
      const result = await call(method, input)
      if (method === 'connection.setup.advance' && 'applicationInspection' in result && result.applicationInspection?.selected?.subject === 'bot-settings') await barrier
      return result
    })()
    if (method === 'connection.setup.advance') pending = request
    return request
  })
  try {
    await click('[data-guided-primary]')
    await ready(() => expect(native.some(call => call.path === '/developers/v1/robot/' + APP)).toBe(true))
    expect(pending).toBeDefined()
    if (change === 'close') await click('[aria-label="Close settings"]')
    else {
      await click('[data-management-back]')
      const all = [...document.querySelectorAll<HTMLButtonElement>('.connector-back')].find(button => button.textContent === 'Back to bots')!
      await act(async () => all.click())
      await click('[data-connection="another-bot"] button')
    }
    await act(async () => { release(); await pending })
    expect(document.querySelector('.connector-management__account')).toBeNull()
    expect(document.querySelector('[data-guided-primary]')).toBeNull()
    expect(native.filter(call => call.path.startsWith('/developers/')).map(call => call.path)).toEqual(['/developers/v1/robot/' + APP])
    expect(writes()).toEqual([])
    expect(app.launch).not.toHaveBeenCalled()
  } finally { release() }
}, 30_000)

it.each(['accepted', 'unknown'] as const)('an %s settings reply with a lost local ACK presents one saving task without implying platform success or replay', async outcome => {
  await open(); await click('[data-guided-primary]'); await idle()
  accept = outcome === 'accepted'
  const request = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (...args) => {
    const response = await request(...args)
    if (new URL(String(args[0])).pathname === '/developers/v1/robot/switch/' + APP) response.headers.append('set-cookie', 'continued=fixture-guided-continuation; Path=/; Secure')
    return response
  })
  const store = DesktopConnectorSecrets.prototype.store; let lost = false
  vi.spyOn(DesktopConnectorSecrets.prototype, 'store').mockImplementation(async function (this: DesktopConnectorSecrets, input) {
    const result = await store.call(this, input)
    if (!lost && input.operationId.startsWith('connection-setup-effect:')) { lost = true; throw Error('Local ACK interrupted after Vault commit') }
    return result
  })
  await click('[data-guided-primary]'); await idle()
  expect(current().applicationConfiguration!.selected?.request).toBe(outcome === 'accepted' ? 'confirmed' : 'unknown')
  expect(current().applicationConfiguration!.selected?.secureStorage).toBe('unknown')
  expect(document.querySelector('[data-guided-primary]')?.textContent).toBe('Finish saving original result')
  expect(document.querySelector('[data-guided-task]')?.textContent).toContain('Finish saving the original result')
  expect(document.querySelector('[data-guided-task]')?.textContent).not.toContain('accepted result')
  expect(firstLayerPrimaries()).toHaveLength(1)
  const original = current().applicationConfiguration!.selected!, before = [...native]
  await click('[data-guided-primary]'); await idle()
  expect(current().applicationConfiguration!.selected).toEqual({ ...original, secureStorage: 'stored' })
  expect(native).toEqual(before)
  expect(writes()).toHaveLength(1)
}, 30_000)

it('a completed permission-directory check with lost local ACK is saved before any other native check', async () => {
  await open(); bot = true; mode = 4
  const store = DesktopConnectorSecrets.prototype.store; let lost = false
  vi.spyOn(DesktopConnectorSecrets.prototype, 'store').mockImplementation(async function (this: DesktopConnectorSecrets, input) {
    const result = await store.call(this, input)
    if (!lost && input.operationId.startsWith('connection-setup-inspection:') && native.at(-1)?.path === '/developers/v1/scope/all/' + APP) { lost = true; throw Error('Read ACK interrupted after Vault commit') }
    return result
  })
  await click('[data-guided-primary]'); await idle()
  const original = current().applicationInspection!.selected!, before = [...native]
  expect(original.subject).toBe('permission-catalog')
  expect(original.request).toBe('confirmed'); expect(original.secureStorage).toBe('unknown')
  expect(document.querySelector('[data-guided-primary]')?.textContent).toBe('Finish saving original result')
  expect(firstLayerPrimaries()).toHaveLength(1)
  await click('[data-guided-primary]'); await idle()
  expect(current().applicationInspection!.selected).toEqual({ ...original, secureStorage: 'stored' })
  expect(native).toEqual(before)
  expect(writes()).toEqual([])
}, 30_000)

it('an unconfirmed native delivery read names the failed check and allows a fresh explicit read without acknowledging the old result', async () => {
  await open(); bot = true
  const fetch = globalThis.fetch; let fail = true
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    if (fail && path === '/developers/v1/event/' + APP) { fail = false; native.push({ path, body: JSON.parse(String(init?.body ?? '{}')) }); return new Response('Current delivery read unconfirmed', { status: 502 }) }
    return fetch(url, init)
  }))
  await click('[data-guided-primary]'); await idle()
  const original = current().applicationInspection!.selected!
  expect(original.subject).toBe('event-settings'); expect(original.request).toBe('unknown')
  expect(document.querySelector('[data-guided-task] strong')?.textContent).toBe('Delivery check not confirmed')
  expect(document.querySelector('[data-guided-primary]')?.textContent).toBe('Retry settings check')
  expect(document.querySelector('[data-management-inspect]')).toBeNull()
  expect(writes()).toEqual([])
  await click('[data-guided-primary]'); await idle()
  expect(document.querySelector('[data-guided-primary]')?.textContent).toBe('Use persistent connection')
  expect(current().applicationInspection!.observations.find(receipt => receipt.stepId === original.stepId)?.request).toBe('unknown')
  expect(current().applicationInspection!.selected?.stepId).not.toBe(original.stepId)
  expect(writes()).toEqual([])
}, 30_000)

it('the original permission response requiring a data range keeps an explicit console task even after fresh applied permissions are visible', async () => {
  await open(); bot = true; mode = 4
  const fetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const result = await fetch(url, init)
    return new URL(String(url)).pathname === '/developers/v1/scope/update/' + APP ? Response.json({ code: 0, data: { needConfigurePrivilege: true } }) : result
  }))
  const external = vi.spyOn(api.ui, 'openExternal').mockResolvedValue(undefined)
  await click('[data-guided-primary]'); await idle()
  expect(document.querySelector('[data-guided-primary]')?.textContent).toBe('Request required permissions')
  await click('[data-guided-primary]'); await idle()
  const original = current().applicationConfiguration!.selected!
  expect(original.effect === 'add-application-permissions' && original.requiresDataRangeConfiguration).toBe(true)
  expect(document.querySelector('[data-guided-primary]')?.textContent).toBe('Open developer console')
  expect(document.querySelector('[data-guided-task]')?.textContent).toContain('original permission request')
  await click('[data-guided-primary]')
  expect(external).toHaveBeenCalledExactlyOnceWith('https://open.feishu.cn/app')
  const details = document.querySelector<HTMLDetailsElement>('[data-guided-management]')!
  await act(async () => details.querySelector<HTMLElement>('summary')!.click())
  await ready(() => expect(document.querySelector('[data-guided-primary]')).toBeNull())
  await click('[data-permission-review]'); await idle()
  expect(current().applicationConfiguration!.capability).toBe('enabled')
  expect(current().applicationConfiguration!.selected?.stepId).toBe(original.stepId)
  const selected = current().applicationConfiguration!.selected
  expect(selected?.effect === 'add-application-permissions' && selected.requiresDataRangeConfiguration).toBe(true)
  await act(async () => details.querySelector<HTMLElement>('summary')!.click())
  await ready(() => expect(document.querySelector('[data-guided-primary]')).not.toBeNull())
  await click('[data-guided-primary]'); await idle()
  expect(document.querySelector('[data-guided-primary]')?.textContent).toBe('Open developer console')
  expect(native.some(call => call.path.includes('/event/all/') || call.path.includes('/app_version/'))).toBe(false)
  expect(writes()).toHaveLength(1)
  expect(document.querySelector<HTMLButtonElement>('[data-connector-return-agent]')?.disabled).toBe(false)
  expect(app.launch).not.toHaveBeenCalled()
}, 30_000)

it('an unknown write keeps the exact original result primary and never turns a fresh current setting into permission to replay it', async () => {
  await open(); await click('[data-guided-primary]'); await idle()
  accept = false
  await click('[data-guided-primary]'); await idle()
  const original = current().applicationConfiguration!.selected!, before = [...native]
  expect(original.request).toBe('unknown')
  expect(document.querySelector('[data-guided-primary]')?.textContent).toBe('Check original request')
  expect(firstLayerPrimaries()).toHaveLength(1)
  await click('[data-guided-primary]'); await idle()
  expect(current().applicationConfiguration!.selected?.stepId).toBe(original.stepId)
  expect(native).toEqual(before)
  const details = document.querySelector<HTMLDetailsElement>('[data-guided-management]')!
  await act(async () => details.querySelector<HTMLElement>('summary')!.click())
  await ready(() => expect(document.querySelector('[data-guided-primary]')).toBeNull())
  expect(document.querySelector('[aria-label="Bot setup step"]')).not.toBeNull()
  expect(writes()).toHaveLength(1); expect(app.launch).not.toHaveBeenCalled()
}, 30_000)

async function enableMenu(dialog: boolean, connectionId = 'settings-publication-bot', beforeSettings?: () => void, selectBot = true) {
  const policy = await services.connections.service!.get()
  await services.connections.service!.configure({ operationId: 'guided-menu-policy', expectedRevision: policy.revision, service: { enabled: true } })
  if (dialog) {
    const record = (await services.connections.list()).connections.find(record => record.config.connectionId === 'settings-publication-bot')!
    await services.connections.configure({ operationId: 'guided-menu-bot', expectedRevision: record.revision, connection: { ...record.config, enabled: true } })
  }
  const item = await agentMenuItem(dialog)
  await act(async () => item.click())
  if (dialog) {
    await ready(() => expect(document.querySelector('[aria-label="Close group setup"]')).not.toBeNull())
    const choice = document.querySelector<HTMLElement>('[aria-label="Group application"]')!
    await act(async () => { choice.focus(); choice.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
    await ready(() => expect(document.querySelector('[role="menuitemradio"][data-value="settings-publication-bot"]')).not.toBeNull())
    await act(async () => document.querySelector<HTMLElement>('[role="menuitemradio"][data-value="settings-publication-bot"]')!.click())
    expect(choice.dataset.value).toBe('settings-publication-bot')
    await act(async () => useAppStore.getState().selectSession(ordinaryAgent.id))
    const details = [...document.querySelectorAll<HTMLDetailsElement>('[role="dialog"] details')].find(node => node.querySelector('summary')?.textContent === 'Connection details')!
    await act(async () => details.querySelector<HTMLElement>('summary')!.click())
    const application = [...details.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Application settings')!
    beforeSettings?.()
    await act(async () => application.click())
  }
  await ready(() => expect(document.querySelector('[data-connector-settings]')).not.toBeNull())
  await ready(() => expect(document.querySelector('[data-connection="' + connectionId + '"]') || document.querySelector('[data-connection-editor]')).not.toBeNull())
  if (!selectBot) return
  if (document.querySelector('[data-connection="' + connectionId + '"]')) await click('[data-connection="' + connectionId + '"] button')
  await ready(() => expect(document.querySelector('[data-connector-return-agent]')).not.toBeNull())
}

async function agentMenuItem(dialog: boolean) {
  await app.mount()
  const trigger = document.querySelector<HTMLElement>('[data-workbench-region-id="default-region"] .agent-region-header__more')!
  expect(trigger).not.toBeNull()
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  let item: HTMLElement | undefined
  await ready(() => { item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.trim() === (dialog ? 'Shared group details' : 'Lark settings')); expect(item).toBeDefined() })
  return item!
}

it.each([false, true])('the original Agent route from menu or dialog (%s) survives another focused Agent and actually returns through Store navigation', async dialog => {
  await enableMenu(dialog)
  expect(document.querySelector('[data-connector-return-agent]')?.textContent).toBe('Return to Agent')
  await act(async () => useAppStore.getState().selectSession(ordinaryAgent.id))
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(ordinaryAgent.id)
  const sessions = useAppStore.getState().sessions, drafts = useAppStore.getState().agentComposerDrafts
  await click('[data-connector-return-agent]')
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ tabId: 'default-tab', regionId: 'default-region' })
  expect(useAppStore.getState().agentFocus.pmo.sessionId).toBe(defaultAgent.id)
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(ordinaryAgent.id)
  expect(useAppStore.getState().reportError).not.toHaveBeenCalled()
  expect(document.querySelector('[data-connector-settings]')).toBeNull()
  expect(useAppStore.getState().sessions).toBe(sessions); expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
  expect(app.launch).not.toHaveBeenCalled(); expect(writes()).toEqual([])
}, 30_000)

it('Settings with no original Agent opens the existing QuickSwitcher and activates the explicitly chosen existing Agent', async () => {
  await app.mount(); await click('[aria-label="Settings"]'); await click('nav [data-settings-target="lark"]'); await click('[data-connection="settings-publication-bot"] button')
  await click('[data-connector-return-agent]')
  await ready(() => expect(document.querySelector('.quick-switch')).not.toBeNull())
  const option = [...document.querySelectorAll<HTMLButtonElement>('.quick-switch [role="option"]')].find(node => node.querySelector('.quick-switch__row-title')?.textContent === ordinaryAgent.label)!
  expect(option).toBeDefined(); await act(async () => option.click())
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(ordinaryAgent.id)
  expect(app.launch).not.toHaveBeenCalled(); expect(writes()).toEqual([])
}, 30_000)

it('a missing original Agent presentation keeps the independent settings route usable without manufacturing an origin', async () => {
  const policy = await services.connections.service!.get()
  await services.connections.service!.configure({ operationId: 'guided-missing-origin-policy', expectedRevision: policy.revision, service: { enabled: true } })
  const item = await agentMenuItem(false)
  await act(async () => {
    useAppStore.setState(state => ({ sessions: state.sessions.filter(session => session.id !== defaultAgent.id) }))
    item.click()
  })
  expect(document.querySelector('[data-settings-page="lark"]')?.hasAttribute('hidden')).toBe(false)
  await click('[data-connection="settings-publication-bot"] button')
  expect(document.querySelector('[data-connector-return-agent]')?.textContent).toBe('Choose an Agent')
  expect(app.launch).not.toHaveBeenCalled(); expect(writes()).toEqual([])
}, 30_000)

it.each(['hostId', 'agentSessionId'] as const)('a changed original %s never redirects to a same-label or currently focused Agent', async field => {
  await enableMenu(false)
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.kind === 'agent' && session.id === defaultAgent.id ? { ...session, control: { ...session.control, [field]: 'different-agent-identity' } } : session) })))
  await ready(() => expect(document.querySelector('[data-connector-return-agent]')?.textContent).toBe('Choose an Agent'))
  await click('[data-connector-return-agent]')
  expect(document.querySelector('.quick-switch')).not.toBeNull()
  expect(app.launch).not.toHaveBeenCalled(); expect(writes()).toEqual([])
}, 30_000)

it('an unconfirmed original display occurrence opens the existing chooser rather than pretending the Agent was selected', async () => {
  await enableMenu(false)
  await act(async () => {
    useAppStore.getState().selectSession(ordinaryAgent.id)
    useAppStore.setState(state => {
      const tab = state.tabs['neighbor-tab']!, region = tab.regions['neighbor-region']!
      expect(region.kind).toBe('agent')
      return { tabs: { ...state.tabs, [tab.id]: { ...tab, regions: { ...tab.regions, [region.regionId]: { ...region, sessionId: defaultAgent.id } } } } }
    })
  })
  const before = useAppStore.getState().workbenchSpaceSelection, drafts = useAppStore.getState().agentComposerDrafts
  await click('[data-connector-return-agent]')
  expect(useAppStore.getState().reportError).toHaveBeenCalled()
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(before)
  expect(document.querySelector('.quick-switch')).not.toBeNull()
  expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
  expect(app.launch).not.toHaveBeenCalled(); expect(writes()).toEqual([])
}, 30_000)

it('a later bot-list response cannot replace the application the user selected while the original route was unavailable', async () => {
  const original = (await services.connections.list()).connections[0]!
  await services.connections.configure({ operationId: 'guided-another-bot', expectedRevision: null, connection: { ...original.config, connectionId: 'another-bot', label: 'Another bot' } })
  let hideOriginal = true
  await enableMenu(true, 'another-bot', () => {
    const call = vi.mocked(api.connections.call).getMockImplementation()!
    vi.mocked(api.connections.call).mockImplementation(async (method, input) => {
      const result = await call(method, input)
      return method === 'connection.ls' && hideOriginal ? { ...(result as ConnectionResultMap['connection.ls']), connections: (result as ConnectionResultMap['connection.ls']).connections.filter(record => record.config.connectionId !== original.config.connectionId) } as typeof result : result
    })
  })
  expect(document.querySelector('.connector-editor-title')?.textContent).toBe('Another bot')
  const all = [...document.querySelectorAll<HTMLButtonElement>('.connector-back')].find(button => button.textContent === 'Back to bots')!
  await act(async () => all.click())
  hideOriginal = false
  const refresh = [...document.querySelectorAll<HTMLButtonElement>('.connector-saved-identities header button')].find(button => button.textContent === 'Refresh')!
  const before = calls.filter(call => call.method === 'connection.ls').length
  await act(async () => refresh.click())
  await ready(() => expect(calls.filter(call => call.method === 'connection.ls').length).toBeGreaterThan(before))
  await ready(() => expect(document.querySelector('[data-connection="settings-publication-bot"]') || document.querySelector('[data-connection-editor]')).not.toBeNull())
  expect(document.querySelector('[data-connection="another-bot"]')).not.toBeNull()
  expect(document.querySelector('[data-connection-editor]')).toBeNull()
  expect(app.launch).not.toHaveBeenCalled(); expect(writes()).toEqual([])
}, 30_000)

it('a later original-bot response preserves the new bot setup the user explicitly opened', async () => {
  const original = (await services.connections.list()).connections[0]!
  await services.connections.configure({ operationId: 'guided-new-bot-choice', expectedRevision: null, connection: { ...original.config, connectionId: 'another-bot', label: 'Another bot' } })
  let release!: () => void, block = false, lateRequest: Promise<unknown> | undefined
  const barrier = new Promise<void>(resolve => { release = resolve })
  await enableMenu(true, 'another-bot', () => {
    const call = vi.mocked(api.connections.call).getMockImplementation()!
    vi.mocked(api.connections.call).mockImplementation((method, input) => {
      const delayed = block
      const request = (async () => {
        const result = await call(method, input)
        if (method !== 'connection.ls') return result
        if (delayed) { await barrier; return result }
        return { ...(result as ConnectionResultMap['connection.ls']), connections: (result as ConnectionResultMap['connection.ls']).connections.filter(record => record.config.connectionId !== original.config.connectionId) } as typeof result
      })()
      if (method === 'connection.ls' && delayed) lateRequest = request
      return request
    })
  }, false)
  block = true
  const refresh = [...document.querySelectorAll<HTMLButtonElement>('.connector-saved-identities header button')].find(button => button.textContent === 'Refresh')!
  try {
    await act(async () => refresh.click())
    await click('[data-enrollment-new]')
    expect(document.querySelector('[data-connection="another-bot"]')).toBeNull()
    expect(lateRequest).toBeDefined()
    await act(async () => { release(); await lateRequest })
    expect(document.querySelector('[data-connection-editor]')).toBeNull()
    expect(document.querySelector('[data-bot-enrollment]')).not.toBeNull()
    expect(app.launch).not.toHaveBeenCalled(); expect(writes()).toEqual([])
  } finally { release() }
}, 30_000)

it('the primary check reads the frozen version after an unknown submit without changing or replaying that submission', async () => {
  await open(); bot = true; mode = 4; callbackMode = 4; cards = true; permissions = true; reception = true
  await click('[data-guided-primary]'); await idle()
  await reviewCreation(); await click('[data-publication-confirm]')
  await ready(() => expect(dom.container.querySelector('[data-publication-review-created]')).not.toBeNull())
  await click('[data-publication-review-created]')
  await ready(() => expect(dom.container.querySelector('[data-publication-confirm]')).not.toBeNull())
  const request = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (...args) => {
    const response = await request(...args)
    return new URL(String(args[0])).pathname === '/developers/v1/publish/commit/' + APP + '/' + VERSION ? new Response('Original acknowledgement lost', { status: 502 }) : response
  })
  await click('[data-publication-confirm]'); await idle()
  expect(document.querySelector('[data-guided-primary]')?.textContent).toBe('Check version status')
  const original = structuredClone(current().applicationConfiguration!.selected!)
  expect(original).toMatchObject({ effect: 'submit-application-version', versionId: VERSION, request: 'unknown' })
  for (let check = 0; check < 2; check++) {
    const before = native.length, count = writes().length
    await click('[data-guided-primary]'); await idle()
    expect(native.slice(before).map(call => call.path)).toEqual(['/developers/v1/app_version/detail/' + APP + '/' + VERSION])
    expect(current().applicationConfiguration!.selected).toEqual(original)
    expect(current().applicationInspection!.readResult).toEqual({ subject: 'publication-version', versionId: VERSION, status: 'reviewing' })
    expect(document.querySelector('[data-guided-task]')?.textContent).toContain('Waiting for platform review')
    expect(document.querySelector('[data-guided-task]')?.textContent).toContain('original submission result is not confirmed')
    expect(writes()).toHaveLength(count)
  }
}, 30_000)


it('keeps all milestones and reads the exact original request trace without platform effects or private data', async () => {
  await open()
  const progress = document.querySelector('[aria-label="Bot setup progress"]')!
  expect(progress.querySelectorAll('li')).toHaveLength(4)
  expect(progress.querySelector('[data-step="3"]')?.textContent).toContain('Already saved')
  expect(progress.querySelector('[data-step="4"]')?.getAttribute('aria-current')).toBe('step')
  bot = true; mode = 4
  const originalFetch = vi.mocked(globalThis.fetch).getMockImplementation()!
  vi.mocked(globalThis.fetch).mockImplementation(async (...args) => {
    const result = await originalFetch(...args)
    return new URL(String(args[0])).pathname === '/developers/v1/scope/applied/' + APP ? new Response('Not confirmed', { status: 502 }) : result
  })
  await click('[data-guided-primary]'); await idle()
  expect(document.querySelector('[data-guided-task]')?.textContent).toContain('Permission check not confirmed')
  const permission = [...document.querySelectorAll('[aria-label="Configuration progress"] li')].find(node => node.textContent?.includes('Permissions'))!
  expect(permission.textContent).toContain('Result unconfirmed')
  expect(document.querySelector('[aria-label="Bot setup progress"] [data-step="2"]')?.textContent).toContain('Confirmed')
  const before = native.length
  await act(async () => document.querySelector<HTMLElement>('[data-request-trace] > summary')!.click())
  await ready(() => expect(document.querySelector('[aria-label="Original request steps"] tbody tr')).not.toBeNull())
  expect(native.length).toBe(before)
  const traceCalls = calls.filter(call => call.method === 'connection.setup.inspect' && 'requestTrace' in (call.input as any))
  expect(traceCalls.length).toBeGreaterThan(0)
  const id = (calls.find(call => call.method === 'connection.setup.begin')!.input as any).operationId
  expect(traceCalls.at(-1)?.input).toMatchObject({ operationId: id, requestTrace: { limit: 25 } })
  expect((traceCalls.at(-1)?.result as any).requestTrace.entries.length).toBeGreaterThan(0)
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const trace = document.querySelector('[data-request-trace]')!.closest('.connector-request-trace')!
  const button = [...trace.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Copy diagnosis')!
  expect(button).toBeDefined()
  await act(async () => button.click())
  await ready(() => expect(clipboard).toHaveBeenCalledOnce())
  const copied = clipboard.mock.calls[0]![0]
  expect(copied).toContain('setup ' + id + ' — recorded')
  expect(copied).toContain('Trace setup ' + id + ' — complete')
  for (const entry of (traceCalls.at(-1)?.result as ConnectionResultMap['connection.setup.inspect']).requestTrace!.entries) expect(copied).toContain(entry.stepId)
  for (const value of ['settings-publication-private-token', 'settings-publication-private-flow', 'settings-publication-private-cookie', 'settings-publication-private-csrf', 'settings-publication-user', 'settings-publication-enterprise']) expect(copied).not.toContain(value)
  expect(copied).toContain('HTTP request details were not recorded')
  expect(trace.textContent).toContain('No request URLs, bodies, cookies, secrets, sign-in codes or account details are included')
  expect(native.length).toBe(before)
}, 30_000)
