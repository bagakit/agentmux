// @vitest-environment happy-dom
import { unwrapSessionInputOperationResult } from '../src/shared/session-input-result.js'
import { act } from 'react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '@agentmux/core'
import type { ConnectionMethod, ConnectionParamsMap, ConnectionResultMap, ConnectionSetupView } from '@agentmux/core/connections'
import { DesktopConnectorSecrets } from '../src/main/connector-secrets.js'
import { createDesktopConnections } from '../src/main/connector-host.js'
import { registerConnectorIpc } from '../src/main/connector-ipc.js'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'
import { enrollmentEncryption } from '../../../packages/connectors/test/fixtures/connection-enrollment.js'

const dom = composerDOM(), APP = 'cli_settings_message_reception'
const EVENT = 'im.message.receive_v1'
let directory: string, services: Awaited<ReturnType<typeof createDesktopConnections>>, server: AgentMuxControlServer
let settings: unknown, catalogAccept: boolean, accept: boolean, native: Array<{ path: string; body: unknown }>, calls: Array<{ method: ConnectionMethod; input: unknown; result: unknown }>
beforeEach(async () => {
  settings = { eventMode: 4, appEventDetails: [] }; catalogAccept = true; accept = true; native = []; calls = []
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  directory = await mkdtemp(join(tmpdir(), 'settings-reception-transport-'))
  services = await createDesktopConnections({ directory: join(directory, 'connections'), encryption: enrollmentEncryption() })
  server = new AgentMuxControlServer({ socketPath: join(directory, 'owner.sock'), connections: services.connections, coreClients: () => { throw new Error('Message reception settings cannot borrow an Agent Runtime') } })
  await server.start()
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>(), sender = { ownedRenderer: true }
  registerConnectorIpc({ handleWithEvent: (channel, handler) => handlers.set(channel, handler), assertTrusted: (channel, caller) => { expect(channel).toBe('connections:call'); expect(caller).toBe(sender) }, socketPath: server.path, secrets: services.secrets })
  vi.spyOn(api.connections, 'call').mockImplementation(async <M extends ConnectionMethod>(method: M, input: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
    const result = unwrapSessionInputOperationResult(await handlers.get('connections:call')!(sender, method, input))
    calls.push({ method, input: structuredClone(input), result: structuredClone(result) })
    return result as ConnectionResultMap[M]
  })
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(url)); native.push({ path: target.pathname, body: JSON.parse(String(init?.body ?? '{}')) })
    if (target.pathname === '/accounts/qrlogin/init') return Response.json({ code: 0, data: { step_info: { token: 'settings-reception-private-token' } } }, { headers: { 'x-flow-key': 'settings-reception-private-flow', 'set-cookie': 'session=settings-reception-private-cookie; Domain=.feishu.cn; Path=/; Secure' } })
    if (target.pathname === '/accounts/qrlogin/polling') return Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross' } } })
    if (target.href === 'https://accounts.feishu.cn/cross') return new Response(null, { status: 302, headers: { location: 'https://ask.feishu.cn/' } })
    if (target.href === 'https://ask.feishu.cn/') return new Response('Landing does not qualify an account')
    if (target.href === 'https://open.feishu.cn/app') return new Response('<script>window.user={"id":"settings-reception-user","tenantId":"settings-reception-enterprise"};window.csrfToken="settings-reception-private-csrf";</script>', { headers: { 'content-type': 'text/html' } })
    if (target.pathname === '/developers/v1/event/' + APP) return Response.json({ code: 0, data: settings })
    if (target.pathname === '/developers/v1/event/all/' + APP) return catalogAccept ? Response.json({ code: 0, data: { events: [{ items: [{ id: EVENT, supportIdentityTypes: [2] }] }] } }) : new Response('Unconfirmed', { status: 502 })
    if (target.pathname === '/developers/v1/event/update/' + APP) return accept ? Response.json({ code: 0, data: {} }) : new Response('Unconfirmed', { status: 502 })
    if (target.pathname === '/developers/v1/robot/' + APP) return Response.json({ code: 0, data: { enable: false } })
    if (target.pathname === '/developers/v1/event/switch/' + APP || target.pathname === '/developers/v1/robot/switch/' + APP) return accept ? Response.json({ code: 0, data: {} }) : new Response('Unconfirmed', { status: 502 })
    throw new Error('Unexpected event settings native request')
  }))
  const credential = await services.secrets.store({ operationId: 'settings-reception-credential', secret: 'settings-reception-private-secret' })
  await services.connections.configure({ operationId: 'settings-reception-save', expectedRevision: null, connection: { connectionId: 'settings-reception-bot', adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: APP }, label: 'Agent conversation bot', enabled: false, credentialRef: credential.credentialRef } })
})
afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of [() => server?.stop(), () => services?.close(), () => rm(directory, { recursive: true, force: true }), () => { vi.restoreAllMocks(); vi.unstubAllGlobals() }]) try { await cleanup() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Message reception Settings cleanup failed')
})
async function ready(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 12_000 }) }
async function click(selector: string) {
  let button: HTMLButtonElement | null = null
  await ready(() => { button = dom.container.querySelector(selector); expect(button, selector).not.toBeNull(); expect(button!.disabled, selector).toBe(false) })
  const details = button!.closest<HTMLDetailsElement>('details:not([open])')
  if (details) await act(async () => details.querySelector<HTMLElement>('summary')!.click())
  expect(button!.closest('[hidden], [inert]')).toBeNull()
  await act(async () => button!.click())
}
const writes = () => native.filter(call => call.path.includes('/event/update/'))
function current() { return calls.filter(call => (call.result as ConnectionSetupView)?.applicationConfiguration).at(-1)?.result as ConnectionSetupView }
async function open() {
  await dom.render(<SettingsPanel visible initialSection="lark" onClose={() => {}} />)
  await click('[data-connection="settings-reception-bot"] button'); await click('[data-management-open]'); await click('[data-management-start]')
  await ready(() => expect(dom.container.querySelector('[data-management-confirm]')).not.toBeNull())
  await click('[data-management-confirm]')
  await ready(() => expect(dom.container.querySelector('[data-management-read-bot]')).not.toBeNull())
  expect(native.filter(call => call.path.startsWith('/developers/'))).toEqual([])
  await click('[data-surface-mode="use-persistent-connection"]')
  await ready(() => expect(dom.container.querySelector('[data-management-review-reception]')).not.toBeNull())
  expect(writes()).toEqual([])
}

it('original Delivery reviews current mode and the directory under one consent, then explicitly adds reception with carried-mode impact', async () => {
  await open(); await click('[data-management-review-reception]')
  await ready(() => expect(dom.container.querySelector('[data-reception-add]')).not.toBeNull())
  expect(native.filter(call => call.path.startsWith('/developers/')).map(call => call.path)).toEqual(['/developers/v1/event/' + APP, '/developers/v1/event/all/' + APP])
  expect([...dom.container.querySelectorAll('[data-surface-mode]')].map(item => item.getAttribute('data-surface-mode'))).toEqual([
    'enable-messaging', 'use-persistent-connection', 'add-application-permissions', 'use-persistent-callback'
  ])
  expect(dom.container.querySelector('[data-surface-mode="use-persistent-connection"]')?.getAttribute('aria-selected')).toBe('true')
  expect(dom.container.textContent).toContain('last checked persistent delivery mode')
  expect(dom.container.textContent).toContain('other event consumers may be affected')
  expect(writes()).toEqual([])
  await click('[data-reception-add]')
  await ready(() => expect(current().applicationConfiguration!.selected?.secureStorage).toBe('stored'))
  expect(writes()).toEqual([{ path: '/developers/v1/event/update/' + APP, body: { clientId: APP, events: [], appEvents: [EVENT], userEvents: [], operation: 'add', eventMode: 4 } }])
  const selected = current().applicationConfiguration!.selected!
  expect(selected).toMatchObject({ effect: 'add-message-reception', request: 'confirmed', secureStorage: 'stored' })
  expect(dom.container.querySelector('[data-reception-result="' + selected.stepId + '"] span')?.textContent).toBe('Accepted result saved')
  expect(dom.container.querySelector('[data-reception-partial]')).toBeNull()
  expect(current().applicationConfiguration!.capability).toBe('unknown')
  settings = { eventMode: 4, appEventDetails: [{ items: [{ id: EVENT }] }] }
  await click('[data-reception-review]')
  await ready(() => expect(dom.container.querySelector('[data-reception-review-result] strong')?.textContent).toBe('Required message event is configured'))
  expect(dom.container.querySelector('[data-reception-add]')).toBeNull()
  expect(writes()).toHaveLength(1)
  expect(dom.draft('agent-1')).toBe('Keep my draft')
  expect(dom.container.textContent).not.toContain('settings-reception-private')
}, 30_000)

it('a partial review retains its current settings and an unknown add remains original while independent bot setup is usable', async () => {
  await open(); catalogAccept = false; await click('[data-management-review-reception]')
  await ready(() => expect(current().applicationInspection?.selected?.request).toBe('unknown'))
  expect(dom.container.textContent).toContain('The completed part of this check is saved')
  const configuration = current().applicationConfiguration!
  if (configuration.effect !== 'add-message-reception') throw Error('Wrong reception effect')
  const originalSettings = configuration.sources.settings
  expect(originalSettings?.secureStorage).toBe('stored')
  catalogAccept = true; await click('[data-reception-review]')
  await ready(() => expect(dom.container.querySelector('[data-reception-add]')).not.toBeNull())
  expect(native.filter(call => call.path.startsWith('/developers/')).map(call => call.path)).toEqual(['/developers/v1/event/' + APP, '/developers/v1/event/all/' + APP, '/developers/v1/event/all/' + APP])
  expect(current().applicationConfiguration).toMatchObject({ sources: { settings: originalSettings } })
  accept = false; await click('[data-reception-add]')
  await ready(() => expect(dom.container.querySelector('[data-reception-unresolved]')).not.toBeNull())
  const original = current().applicationConfiguration!.selected!
  const beforeCheck = native.length
  await click('[data-reception-review]')
  await ready(() => expect(current().applicationConfiguration).toMatchObject({ reason: 'original-effect-unconfirmed', selected: original }))
  await ready(() => expect(native.slice(beforeCheck).map(call => call.path)).toEqual(['/developers/v1/event/' + APP, '/developers/v1/event/all/' + APP]))
  expect(dom.container.querySelector('[data-reception-add]')).toBeNull()
  expect(writes()).toHaveLength(1)
  await click('[data-surface-mode="enable-messaging"]'); await click('[data-management-read-bot]')
  await ready(() => expect(dom.container.querySelector('[data-management-enable]')).not.toBeNull())
  accept = true; await click('[data-management-enable]')
  await ready(() => expect(current().applicationConfiguration!.selected).toMatchObject({ effect: 'enable-messaging', request: 'confirmed', secureStorage: 'stored' }))
  expect(writes()).toHaveLength(1)
}, 30_000)

it('accepted reception with a lost local ACK prioritizes same-child saving without another native request', async () => {
  await open(); await click('[data-management-review-reception]')
  await ready(() => expect(dom.container.querySelector('[data-reception-add]')).not.toBeNull())
  const store = DesktopConnectorSecrets.prototype.store
  let lost = false
  vi.spyOn(DesktopConnectorSecrets.prototype, 'store').mockImplementation(async function (input) {
    const result = await store.call(this, input)
    if (!lost && input.operationId.startsWith('connection-setup-effect:')) { lost = true; throw Error('Local ACK interrupted after Vault commit') }
    return result
  })
  await click('[data-reception-add]')
  await ready(() => expect(dom.container.querySelector('[data-reception-recover].primary-button')).not.toBeNull())
  expect(dom.container.querySelector('[data-reception-recover]')?.textContent).toBe('Finish saving original result')
  expect(dom.container.querySelector('[data-reception-partial]')).toBeNull()
  const actions = [...dom.container.querySelectorAll('[data-management-reception] button')]
  expect(actions.indexOf(dom.container.querySelector('[data-reception-recover]')!)).toBeLessThan(actions.indexOf(dom.container.querySelector('[data-reception-review]')!))
  expect(dom.container.querySelector('[data-reception-review].primary-button')).toBeNull()
  const original = current().applicationConfiguration!.selected!, before = [...native]
  expect(original).toMatchObject({ effect: 'add-message-reception', request: 'confirmed', secureStorage: 'unknown' })
  expect(dom.container.querySelector('[data-reception-result="' + original.stepId + '"] span')?.textContent).toBe('Accepted result needs saving')
  await click('[data-reception-recover]')
  await ready(() => expect(current().applicationConfiguration!.selected).toEqual({ ...original, secureStorage: 'stored' }))
  expect(native).toEqual(before)
}, 30_000)

it('switching delivery then reviewing reception reads new post-switch settings instead of getting stuck on the old partial source', async () => {
  settings = { eventMode: 1, appEventDetails: [] }
  await open(); await click('[data-management-read-events]')
  await ready(() => expect(dom.container.querySelector('[data-management-use-persistent]')).not.toBeNull())
  await click('[data-management-use-persistent]')
  await ready(() => expect(current().applicationConfiguration!.selected?.secureStorage).toBe('stored'))
  settings = { eventMode: 4, appEventDetails: [] }
  const before = native.length
  await click('[data-management-review-reception]')
  await ready(() => expect(dom.container.querySelector('[data-reception-add]')).not.toBeNull())
  expect(native.slice(before)).toEqual([
    { path: '/developers/v1/event/' + APP, body: { needEventDetail: true } },
    { path: '/developers/v1/event/all/' + APP, body: {} }
  ])
  await click('[data-reception-add]')
  await ready(() => expect(current().applicationConfiguration!.selected?.secureStorage).toBe('stored'))
  expect(writes()).toHaveLength(1)
  expect(native.filter(call => call.path.includes('/event/switch/'))).toHaveLength(1)
}, 30_000)
