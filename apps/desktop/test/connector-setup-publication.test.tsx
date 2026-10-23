// @vitest-environment happy-dom
import { unwrapSessionInputOperationResult } from '../src/shared/session-input-result.js'
import { act } from 'react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '@agentmux/core'
import type { ConnectionMethod, ConnectionParamsMap, ConnectionResultMap, ConnectionSetupView } from '@agentmux/core/connections'
import { ConnectionSecrets } from '../../../packages/connectors/src/connection-secrets.js'
import { createConnectionServices } from '../../../packages/connectors/src/connection-services.js'
import { registerConnectorIpc } from '../src/main/connector-ipc.js'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'
import { enrollmentEncryption } from '../../../packages/connectors/test/fixtures/connection-enrollment.js'

const dom = composerDOM(), APP = 'cli_settings_publication', VERSION = 'original-selected-version'
let directory: string, services: Awaited<ReturnType<typeof createConnectionServices>>, server: AgentMuxControlServer
let failObservation: boolean, accept: boolean, native: Array<{ path: string; body: unknown }>, calls: Array<{ method: ConnectionMethod; input: unknown; result: unknown }>
beforeEach(async () => {
  failObservation = false; accept = true; native = []; calls = []
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  directory = await mkdtemp(join(tmpdir(), 'settings-publication-transport-'))
  services = await createConnectionServices({ directory: join(directory, 'connections'), encryption: enrollmentEncryption() })
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
    if (target.pathname === '/developers/v1/app_version/detail/' + APP + '/' + VERSION) return Response.json({ code: 0, data: detail })
    if (target.pathname === '/developers/v1/app_version/create/' + APP) return accept ? Response.json({ code: 0, data: { versionId: VERSION } }) : new Response('Unconfirmed', { status: 502 })
    if (target.pathname === '/developers/v1/publish/commit/' + APP + '/' + VERSION) return Response.json({ code: 0, data: { urlConflict: false, avatar: 'original-avatar', isOk: true } })
    throw new Error('Unexpected publication native request')
  }))
  const credential = await services.secrets.store({ operationId: 'settings-publication-credential', secret: 'settings-publication-private-secret' })
  await services.connections.configure({ operationId: 'settings-publication-save', expectedRevision: null, connection: { connectionId: 'settings-publication-bot', adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: APP }, label: 'Agent conversation bot', enabled: false, credentialRef: credential.credentialRef } })
})
afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of [() => server?.stop(), () => services?.close(), () => rm(directory, { recursive: true, force: true }), () => { vi.restoreAllMocks() }]) try { await cleanup() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Publication Settings cleanup failed')
})
afterAll(() => vi.unstubAllGlobals())
async function ready(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 12_000 }) }
async function click(selector: string) {
  let button: HTMLButtonElement | null = null
  await ready(() => { button = dom.container.querySelector(selector); expect(button, selector).not.toBeNull(); expect(button!.disabled, selector).toBe(false) })
  const details = button!.closest<HTMLDetailsElement>('details:not([open])')
  if (details) await act(async () => details.querySelector<HTMLElement>('summary')!.click())
  expect(button!.closest('[hidden], [inert]')).toBeNull()
  await act(async () => button!.click())
}
const writes = () => native.filter(call => call.path.includes('/app_version/create/') || call.path.includes('/publish/commit/'))
function current() { return calls.filter(call => (call.result as ConnectionSetupView)?.applicationConfiguration).at(-1)?.result as ConnectionSetupView }
async function open() {
  await dom.render(<SettingsPanel visible initialSection="lark" onClose={() => {}} />)
  await click('[data-connection="settings-publication-bot"] button'); await click('[data-management-open]'); await click('[data-management-start]')
  await ready(() => expect(dom.container.querySelector('[data-management-confirm]')).not.toBeNull())
  await click('[data-management-confirm]')
  await ready(() => expect(dom.container.querySelector('[data-management-read-bot]')).not.toBeNull())
  expect(native.filter(call => call.path.startsWith('/developers/'))).toEqual([])
  await click('[data-management-publication-open]')
  await ready(() => expect(dom.container.querySelector('[data-management-publication]')).not.toBeNull())
  expect(writes()).toEqual([])
}
async function fill(label: string, value: string) {
  const element = dom.container.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[aria-label="' + label + '"]')!
  expect(element, label).not.toBeNull()
  await act(async () => {
    const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
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

it('Settings reviews complete application impact, creates the explicit draft and submits only its returned exact version', async () => {
  await open(); await reviewCreation()
  expect(dom.container.querySelector('[data-publication-impact]')?.textContent).toContain('whole Agent conversation bot application')
  await act(async () => dom.container.querySelector<HTMLElement>('[data-publication-review-details] summary')!.click())
  expect(dom.container.textContent).toContain('original-person'); expect(dom.container.textContent).toContain('excluded-department')
  await fill('Publication release notes', 'Edited release notes require another review')
  expect(dom.container.querySelector('[data-publication-confirm]')).toBeNull()
  await reviewCreationSources(); await ready(() => expect(dom.container.querySelector('[data-publication-confirm]')).not.toBeNull())
  expect(writes()).toEqual([])
  await click('[data-publication-confirm]')
  await ready(() => expect(dom.container.querySelector('[data-publication-review-created]')).not.toBeNull())
  expect(writes()).toHaveLength(1)
  expect(writes()[0]!.body).toMatchObject({ appVersion: '1.1.0', changeLog: 'Edited release notes require another review', pcDefaultAbility: 'web-app', blackVisibleSuggest: { departments: ['excluded-department'], members: [29], groups: [31], isAll: 0 } })
  await click('[data-publication-review-created]')
  await ready(() => expect(current().applicationConfiguration).toMatchObject({ effect: 'submit-application-version', draft: { versionId: VERSION } }))
  await ready(() => expect(dom.container.querySelector('[data-publication-confirm]')).not.toBeNull())
  expect((dom.container.querySelector('[aria-label="Publication selected version"]') as HTMLSelectElement).value).toBe(VERSION)
  expect(dom.container.querySelector('[data-publication-selected-content]')?.textContent).toContain('Original selected version release notes')
  expect(dom.container.querySelector('[data-publication-selected-content]')?.textContent).toContain('desktop-existing')
  await click('[data-publication-confirm]')
  await ready(() => expect(dom.container.querySelector('[data-publication-submission]')?.textContent).toContain('submission was accepted'))
  expect(writes()).toHaveLength(2)
  expect(writes()[1]).toEqual({ path: '/developers/v1/publish/commit/' + APP + '/' + VERSION, body: { is_full_release: false } })
  expect(dom.draft()).toBe('Keep my draft')
  expect(dom.container.textContent).not.toContain('settings-publication-private')
}, 30_000)

it('an unknown creation keeps its original while an explicit existing-version submission remains independent', async () => {
  await open(); await reviewCreation(); accept = false
  await click('[data-publication-confirm]')
  await ready(() => expect(dom.container.querySelector('[data-publication-original]')).not.toBeNull())
  await click('[data-publication-original]')
  await ready(() => expect(dom.container.querySelector('[data-publication-original]')).not.toBeNull())
  expect(writes()).toHaveLength(1); expect(dom.container.querySelector('[data-publication-confirm]')).toBeNull()
  await click('[data-publication-switch]'); await click('[data-publication-review]')
  await ready(() => expect(current().applicationConfiguration).toMatchObject({ effect: 'submit-application-version', review: { versions: expect.arrayContaining([expect.objectContaining({ versionId: VERSION })]) } }))
  await fill('Publication selected version', VERSION); await click('[data-publication-review]')
  await ready(() => expect(dom.container.querySelector('[data-publication-confirm]')).not.toBeNull())
  await click('[data-publication-confirm]')
  await ready(() => expect(current().applicationConfiguration!.selected?.secureStorage).toBe('stored'))
  expect(writes()).toHaveLength(2)
}, 30_000)

it('accepted version creation with lost local ACK has one primary saving action and never repeats the native write', async () => {
  await open(); await reviewCreation()
  const store = ConnectionSecrets.prototype.store; let lost = false
  vi.spyOn(ConnectionSecrets.prototype, 'store').mockImplementation(async function (this: ConnectionSecrets, input) {
    const result = await store.call(this, input)
    if (!lost && input.operationId.startsWith('connection-setup-effect:')) { lost = true; throw Error('Local ACK interrupted after Vault commit') }
    return result
  })
  await click('[data-publication-confirm]')
  await ready(() => expect(dom.container.querySelector('[data-publication-recover].primary-button')).not.toBeNull())
  expect(dom.container.querySelectorAll('[data-management-publication] .primary-button')).toHaveLength(1)
  expect(dom.container.querySelector('[data-publication-review].primary-button')).toBeNull()
  expect(dom.container.textContent).toContain('original platform response was received')
  const before = [...native], original = current().applicationConfiguration!.selected!
  await click('[data-publication-recover]')
  await ready(() => expect(current().applicationConfiguration!.selected).toEqual({ ...original, secureStorage: 'stored' }))
  expect(native).toEqual(before)
}, 30_000)

it('an ordinary observation failure keeps confirmed account facts and same-operation drafts without retaining write authority', async () => {
  await open(); await reviewCreation()
  await fill('Publication release notes', 'Unsaved notes stay with this operation')
  const operationId = current().operation!.operationId
  failObservation = true; await click('[data-publication-review]')
  await ready(() => expect(dom.container.textContent).toContain('Application observation interrupted'))
  expect(dom.container.querySelector('[data-publication-confirm]')).toBeNull()
  const account = dom.container.querySelector('.connector-management__account')!
  expect(account.textContent).toContain('Last confirmed account')
  expect(account.textContent).toContain('settings-publication-user')
  expect(dom.container.querySelector('[data-management-code]')).toBeNull()
  expect(dom.container.querySelector('[data-management-confirm]')).toBeNull()
  expect(writes()).toEqual([])
  await click('[data-management-inspect]')
  await ready(() => expect(dom.container.querySelector('[aria-label="Publication release notes"]')).not.toBeNull())
  expect(current().operation!.operationId).toBe(operationId)
  expect((dom.container.querySelector('[aria-label="Publication release notes"]') as HTMLTextAreaElement).value).toBe('Unsaved notes stay with this operation')
  expect((dom.container.querySelector('[aria-label="Publication version"]') as HTMLInputElement).value).toBe('1.1.0')
  expect((dom.container.querySelector('[aria-label="Publication review reason"]') as HTMLTextAreaElement).value).toBe('Explain the application permission change')
  await reviewCreationSources(); await ready(() => expect(dom.container.querySelector('[data-publication-confirm]')).not.toBeNull())
  expect(writes()).toEqual([])
  await click('[data-publication-confirm]')
  await ready(() => expect(writes()).toHaveLength(1))
  expect(writes()[0]!.body).toMatchObject({ changeLog: 'Unsaved notes stay with this operation' })
}, 30_000)
