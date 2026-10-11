// @vitest-environment happy-dom
import { act } from 'react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '@agentmux/core'
import type { ConnectionMethod, ConnectionParamsMap, ConnectionResultMap } from '@agentmux/core/connections'
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
const SCOPES = ['im:message:send_as_bot', 'im:message:readonly', 'im:message.group_msg', 'im:chat:create', 'im:chat:read', 'im:chat.members:read', 'im:chat.members:write_only']
let bot: boolean, mode: number, permissions: boolean, reception: boolean, submitted: boolean
let directory: string, services: Awaited<ReturnType<typeof createDesktopConnections>>, server: AgentMuxControlServer
let failObservation: boolean, accept: boolean, native: Array<{ path: string; body: unknown }>, calls: Array<{ method: ConnectionMethod; input: unknown; result: unknown }>
beforeEach(async () => {
  app = createMoteApp(); bot = false; mode = 1; permissions = false; reception = false; submitted = false;
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
    const result = await handlers.get('connections:call')!(sender, method, input)
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
    if (target.pathname === '/developers/v1/robot/switch/' + APP) { bot = true; return Response.json({ code: 0, data: {} }) }
    if (target.pathname === '/developers/v1/event/' + APP) return Response.json({ code: 0, data: { eventMode: mode, appEventDetails: reception ? [{ items: [{ id: 'im.message.receive_v1' }] }] : [] } })
    if (target.pathname === '/developers/v1/event/switch/' + APP) { mode = 4; return Response.json({ code: 0, data: {} }) }
    if (target.pathname === '/developers/v1/event/all/' + APP) return Response.json({ code: 0, data: { events: [{ items: [{ id: 'im.message.receive_v1', supportIdentityTypes: [2] }] }] } })
    if (target.pathname === '/developers/v1/event/update/' + APP) { reception = true; return Response.json({ code: 0, data: {} }) }
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
async function ready(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 12_000 }) }
async function click(selector: string) {
  let button: HTMLButtonElement | null = null
  await ready(() => { button = dom.container.querySelector(selector); expect(button, selector).not.toBeNull(); expect(button!.disabled, selector).toBe(false) })
  const details = button!.closest<HTMLDetailsElement>('details:not([open])')
  if (details) await act(async () => details.querySelector<HTMLElement>('summary')!.click())
  expect(button!.closest('[hidden], [inert]')).toBeNull()
  await act(async () => button!.click())
}
const writes = () => native.filter(call => ['/robot/switch/', '/event/switch/', '/scope/update/', '/event/update/', '/app_version/create/', '/publish/commit/'].some(path => call.path.includes(path)))
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
  await ready(() => { item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.trim() === (dialog ? 'Shared group details' : 'Enable a chat application')); expect(item).toBeDefined() })
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
  await app.mount(); await click('[aria-label="Settings"]'); await click('nav [data-settings-target="chat-connections"]'); await click('[data-connection="settings-publication-bot"] button')
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
  expect(document.querySelector('[data-settings-page="chat-connections"]')?.hasAttribute('hidden')).toBe(false)
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
  const all = [...document.querySelectorAll<HTMLButtonElement>('.connector-back')].find(button => button.textContent === 'All applications')!
  await act(async () => all.click())
  hideOriginal = false
  const refresh = [...document.querySelectorAll<HTMLButtonElement>('.settings-pane-toolbar button')].find(button => button.textContent === 'Refresh')!
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
  const refresh = [...document.querySelectorAll<HTMLButtonElement>('.settings-pane-toolbar button')].find(button => button.textContent === 'Refresh')!
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
