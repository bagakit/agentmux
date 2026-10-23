// @vitest-environment happy-dom
import { unwrapSessionInputOperationResult } from '../src/shared/session-input-result.js'
import { act } from 'react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '@agentmux/core'
import type { ConnectionMethod, ConnectionParamsMap, ConnectionResultMap, ConnectionSetupView } from '@agentmux/core/connections'
import { ConnectionSecrets } from '../../../packages/connectors/src/connection-secrets.js'
import { createConnectionServices } from '../../../packages/connectors/src/connection-services.js'
import { registerConnectorIpc } from '../src/main/connector-ipc.js'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM(), APP = 'cli_settings_permission_request'
const NAMES = ['im:message:send_as_bot', 'im:message:readonly', 'im:message.group_msg', 'im:chat:create', 'im:chat:read', 'im:chat.members:read', 'im:chat.members:write_only', 'application:application:patch', 'application:application:self_manage']
const IDS = NAMES.map((_, index) => 100 + index)
const REQUIRED_IDS = [...IDS.slice(0, 7), IDS[8]!] // Creator lookup needs self_manage, not the unrelated patch scope.
let directory: string, services: Awaited<ReturnType<typeof createConnectionServices>>, server: AgentMuxControlServer
let applied: unknown, appliedAccept: boolean, accept: boolean, native: Array<{ path: string; body: unknown }>, calls: Array<{ method: ConnectionMethod; input: unknown; result: unknown }>
beforeEach(async () => {
  applied = { scopes: [] }; appliedAccept = true; accept = true; native = []; calls = []
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  directory = await mkdtemp(join(tmpdir(), 'settings-permission-transport-'))
  services = await createConnectionServices({ directory: join(directory, 'connections') })
  server = new AgentMuxControlServer({ socketPath: join(directory, 'owner.sock'), connections: services.connections, coreClients: () => { throw new Error('Permission settings cannot borrow an Agent Runtime') } })
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
    if (target.pathname === '/accounts/qrlogin/init') return Response.json({ code: 0, data: { step_info: { token: 'settings-permission-private-token' } } }, { headers: { 'x-flow-key': 'settings-permission-private-flow', 'set-cookie': 'session=settings-permission-private-cookie; Domain=.feishu.cn; Path=/; Secure' } })
    if (target.pathname === '/accounts/qrlogin/polling') return Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross' } } })
    if (target.href === 'https://accounts.feishu.cn/cross') return new Response(null, { status: 302, headers: { location: 'https://ask.feishu.cn/' } })
    if (target.href === 'https://ask.feishu.cn/') return new Response('Landing does not qualify an account')
    if (target.href === 'https://open.feishu.cn/app') return new Response('<script>window.user={"id":"settings-permission-user","tenantId":"settings-permission-enterprise"};window.csrfToken="settings-permission-private-csrf";</script>', { headers: { 'content-type': 'text/html' } })
    if (target.pathname === '/developers/v1/scope/all/' + APP) return Response.json({ code: 0, data: { scopes: NAMES.map((name, index) => ({ name, id: IDS[index], scopeType: [2] })) } })
    if (target.pathname === '/developers/v1/scope/applied/' + APP) return appliedAccept ? Response.json({ code: 0, data: applied }) : new Response('Unconfirmed', { status: 502 })
    if (target.pathname === '/developers/v1/scope/update/' + APP) return accept ? Response.json({ code: 0, data: { needConfigurePrivilege: true } }) : new Response('Unconfirmed', { status: 502 })
    if (target.pathname === '/developers/v1/robot/' + APP) return Response.json({ code: 0, data: { enable: false } })
    if (target.pathname === '/developers/v1/event/switch/' + APP || target.pathname === '/developers/v1/robot/switch/' + APP) return accept ? Response.json({ code: 0, data: {} }) : new Response('Unconfirmed', { status: 502 })
    throw new Error('Unexpected event settings native request')
  }))
  const credential = await services.secrets.store({ operationId: 'settings-permission-credential', secret: 'settings-permission-private-secret' })
  await services.connections.configure({ operationId: 'settings-permission-save', expectedRevision: null, connection: { connectionId: 'settings-permission-bot', adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: APP }, label: 'Agent conversation bot', enabled: false, credentialRef: credential.credentialRef } })
})
afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of [() => server?.stop(), () => services?.close(), () => rm(directory, { recursive: true, force: true }), () => { vi.restoreAllMocks(); vi.unstubAllGlobals() }]) try { await cleanup() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Permission Settings cleanup failed')
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
const writes = () => native.filter(call => call.path.includes('/scope/update/'))
function current() { return calls.filter(call => (call.result as ConnectionSetupView)?.applicationConfiguration).at(-1)?.result as ConnectionSetupView }
async function open() {
  await dom.render(<SettingsPanel visible initialSection="lark" onClose={() => {}} />)
  await click('[data-connection="settings-permission-bot"] button'); await click('[data-management-open]'); await click('[data-management-start]')
  await ready(() => expect(dom.container.querySelector('[data-management-confirm]')).not.toBeNull())
  await click('[data-management-confirm]')
  await ready(() => expect(dom.container.querySelector('[data-management-read-bot]')).not.toBeNull())
  expect(native.filter(call => call.path.startsWith('/developers/'))).toEqual([])
  await click('[data-surface-mode="add-application-permissions"]')
  await ready(() => expect(dom.container.querySelector('[data-permission-review]')).not.toBeNull())
  expect(writes()).toEqual([])
}

it('original Settings reviews both sources with one consent then explicitly requests the eight consumer permissions; acceptance and fresh applied read stay distinct', async () => {
  await open()
  expect(native.filter(call => call.path.startsWith('/developers/'))).toEqual([])
  await click('[data-permission-review]')
  await ready(() => expect(dom.container.querySelector('[data-permission-add]')).not.toBeNull())
  expect(native.filter(call => call.path.startsWith('/developers/')).map(call => call.path)).toEqual(['/developers/v1/scope/all/' + APP, '/developers/v1/scope/applied/' + APP])
  expect(dom.container.textContent).toContain('8 missing application permissions')
  expect(dom.container.textContent).toContain('Applies to the whole')
  expect(writes()).toEqual([])
  const offered = current().applicationConfiguration!.actions.find(action => action.kind === 'add-application-permissions')!
  await click('[data-permission-add]')
  await ready(() => expect(current().applicationConfiguration!.selected?.secureStorage).toBe('stored'))
  expect(current().applicationConfiguration!.selected!.input).toEqual({ operationId: current().operation!.operationId, expectedRevision: offered.expectedRevision, decision: { actionId: offered.actionId, value: 'confirm' } })
  expect(writes()).toEqual([{ path: '/developers/v1/scope/update/' + APP, body: { clientId: APP, appScopeIDs: REQUIRED_IDS, userScopeIDs: [], scopeIds: [], operation: 'add', isDeveloperPanel: true } }])
  const selected = current().applicationConfiguration!.selected!
  expect(selected).toMatchObject({ effect: 'add-application-permissions', request: 'confirmed', secureStorage: 'stored' })
  expect(dom.container.querySelector('[data-permission-result="' + selected.stepId + '"] span')?.textContent).toBe('Accepted result saved')
  expect(dom.container.textContent).toContain('data-range configuration is still needed')
  expect(current().applicationConfiguration!.capability).toBe('unknown')
  applied = { scopes: REQUIRED_IDS.map(id => ({ id, scopeIdentityType: 2 })) }
  await click('[data-permission-review]')
  await ready(() => expect(dom.container.textContent).toContain('No additions needed'))
  expect(dom.container.querySelector('[data-permission-add]')).toBeNull()
  expect(writes()).toHaveLength(1)
  expect(dom.draft('agent-1')).toBe('Keep my draft')
  expect(dom.container.textContent).not.toContain('settings-permission-private')
}, 30_000)

it('permission review preserves a completed half on an unknown read and cannot replay an unknown addition after returning to its original task', async () => {
  await open()
  expect(dom.container.querySelector('[data-permission-profile-sync]')).toBeNull()
  await ready(() => expect(current().applicationConfiguration).toMatchObject({ effect: 'add-application-permissions', purpose: 'agent-conversation' }))
  expect(native.filter(call => call.path.startsWith('/developers/'))).toEqual([])
  appliedAccept = false; await click('[data-permission-review]')
  await ready(() => expect(current().applicationInspection?.selected?.request).toBe('unknown'))
  expect(dom.container.querySelector('[data-permission-add]')).toBeNull()
  expect(dom.container.textContent).toContain('Part of the check is saved')
  const configuration = current().applicationConfiguration!
  if (configuration.effect !== 'add-application-permissions') throw Error('Wrong permission view')
  const catalog = configuration.sources.catalog
  expect(catalog?.secureStorage).toBe('stored')
  appliedAccept = true; await click('[data-permission-review]')
  await ready(() => expect(dom.container.querySelector('[data-permission-add]')).not.toBeNull())
  expect(dom.container.textContent).toContain('8 missing application permissions')
  expect(native.filter(call => call.path.startsWith('/developers/')).map(call => call.path)).toEqual(['/developers/v1/scope/all/' + APP, '/developers/v1/scope/applied/' + APP, '/developers/v1/scope/applied/' + APP])
  expect(current().applicationConfiguration).toMatchObject({ sources: { catalog } })
  accept = false; await click('[data-permission-add]')
  await ready(() => expect(dom.container.querySelector('[data-permission-unresolved]')).not.toBeNull())
  const original = current().applicationConfiguration!.selected!
  await click('[data-surface-mode="enable-messaging"]'); await click('[data-surface-mode="add-application-permissions"]')
  await ready(() => expect(current().applicationConfiguration).toMatchObject({ purpose: 'agent-conversation', reason: 'original-effect-unconfirmed', selected: original }))
  expect(dom.container.querySelector('[data-permission-add]')).toBeNull()
  expect(writes()).toHaveLength(1)
  await click('[data-surface-mode="enable-messaging"]'); await click('[data-management-read-bot]')
  await ready(() => expect(dom.container.querySelector('[data-management-enable]')).not.toBeNull())
  accept = true; await click('[data-management-enable]')
  await ready(() => expect(current().applicationConfiguration!.selected).toMatchObject({ effect: 'enable-messaging', request: 'confirmed', secureStorage: 'stored' }))
  expect(writes()).toHaveLength(1)
}, 30_000)

it('a known accepted request with a lost local ACK makes same-child saving the primary action and never dispatches again', async () => {
  await open(); await click('[data-permission-review]')
  await ready(() => expect(dom.container.querySelector('[data-permission-add]')).not.toBeNull())
  const store = ConnectionSecrets.prototype.store
  let lost = false
  vi.spyOn(ConnectionSecrets.prototype, 'store').mockImplementation(async function (input) {
    const result = await store.call(this, input)
    if (!lost && input.operationId.startsWith('connection-setup-effect:')) { lost = true; throw Error('Local ACK interrupted after Vault commit') }
    return result
  })
  await click('[data-permission-add]')
  await ready(() => expect(dom.container.querySelector('[data-permission-recover].primary-button')).not.toBeNull())
  expect(dom.container.querySelector('[data-permission-recover]')?.textContent).toBe('Finish saving original result')
  expect(dom.container.querySelector('[data-permission-partial]')).toBeNull()
  const actions = [...dom.container.querySelectorAll('[data-management-permissions] button')], recover = dom.container.querySelector('[data-permission-recover]')!, review = dom.container.querySelector('[data-permission-review]')!
  expect(actions.indexOf(recover)).toBeLessThan(actions.indexOf(review))
  expect(review.classList.contains('primary-button')).toBe(false)
  const original = current().applicationConfiguration!.selected!
  expect(original).toMatchObject({ request: 'confirmed', secureStorage: 'unknown' })
  expect(dom.container.querySelector('[data-permission-result="' + original.stepId + '"] span')?.textContent).toBe('Accepted result needs saving')
  expect(dom.container.querySelector('[data-permission-original]')).toBeNull()
  expect(writes()).toHaveLength(1)
  const before = [...native]
  await click('[data-permission-recover]')
  await ready(() => expect(current().applicationConfiguration!.selected).toEqual({ ...original, secureStorage: 'stored' }))
  expect(native).toEqual(before)
  expect(dom.container.querySelector('[data-permission-recover]')).toBeNull()
}, 30_000)
