// @vitest-environment happy-dom
import { unwrapSessionInputOperationResult } from '../src/shared/session-input-result.js'
import { act } from 'react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '@agentmux/core'
import type { ConnectionMethod, ConnectionParamsMap, ConnectionResultMap, ConnectionSetupView } from '@agentmux/core/connections'
import { createDesktopConnections } from '../src/main/connector-host.js'
import { registerConnectorIpc } from '../src/main/connector-ipc.js'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'
import { enrollmentEncryption } from '../../../packages/connectors/test/fixtures/connection-enrollment.js'

const dom = composerDOM(), APP = 'cli_settings_event_transport'
let directory: string, services: Awaited<ReturnType<typeof createDesktopConnections>>, server: AgentMuxControlServer
let mode: number, accept: boolean, native: Array<{ path: string; body: unknown }>, calls: Array<{ method: ConnectionMethod; input: unknown; result: unknown }>
beforeEach(async () => {
  mode = 1; accept = true; native = []; calls = []
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  directory = await mkdtemp(join(tmpdir(), 'settings-event-transport-'))
  services = await createDesktopConnections({ directory: join(directory, 'connections'), encryption: enrollmentEncryption() })
  server = new AgentMuxControlServer({ socketPath: join(directory, 'owner.sock'), connections: services.connections, coreClients: () => { throw new Error('Event settings cannot borrow an Agent Runtime') } })
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
    if (target.pathname === '/accounts/qrlogin/init') return Response.json({ code: 0, data: { step_info: { token: 'settings-event-private-token' } } }, { headers: { 'x-flow-key': 'settings-event-private-flow', 'set-cookie': 'session=settings-event-private-cookie; Domain=.feishu.cn; Path=/; Secure' } })
    if (target.pathname === '/accounts/qrlogin/polling') return Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross' } } })
    if (target.href === 'https://accounts.feishu.cn/cross') return new Response(null, { status: 302, headers: { location: 'https://ask.feishu.cn/' } })
    if (target.href === 'https://ask.feishu.cn/') return new Response('Landing does not qualify an account')
    if (target.href === 'https://open.feishu.cn/app') return new Response('<script>window.user={"id":"settings-event-user","tenantId":"settings-event-enterprise"};window.csrfToken="settings-event-private-csrf";</script>', { headers: { 'content-type': 'text/html' } })
    if (target.pathname === '/developers/v1/event/' + APP) return Response.json({ code: 0, data: { eventMode: mode } })
    if (target.pathname === '/developers/v1/robot/' + APP) return Response.json({ code: 0, data: { enable: false } })
    if (target.pathname === '/developers/v1/event/switch/' + APP || target.pathname === '/developers/v1/robot/switch/' + APP) return accept ? Response.json({ code: 0, data: {} }) : new Response('Unconfirmed', { status: 502 })
    throw new Error('Unexpected event settings native request')
  }))
  const credential = await services.secrets.store({ operationId: 'settings-event-credential', secret: 'settings-event-private-secret' })
  await services.connections.configure({ operationId: 'settings-event-save', expectedRevision: null, connection: { connectionId: 'settings-event-bot', adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: APP }, label: 'Event delivery bot', enabled: false, credentialRef: credential.credentialRef } })
})
afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of [() => server?.stop(), () => services?.close(), () => rm(directory, { recursive: true, force: true }), () => { vi.restoreAllMocks(); vi.unstubAllGlobals() }]) try { await cleanup() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Event Settings cleanup failed')
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
const writes = () => native.filter(call => call.path.includes('/switch/'))
function current() { return calls.filter(call => (call.result as ConnectionSetupView)?.applicationConfiguration).at(-1)?.result as ConnectionSetupView }
async function open() {
  await dom.render(<SettingsPanel visible initialSection="lark" onClose={() => {}} />)
  await click('[data-connection="settings-event-bot"] button'); await click('[data-management-open]'); await click('[data-management-start]')
  await ready(() => expect(dom.container.querySelector('[data-management-confirm]')).not.toBeNull())
  await click('[data-management-confirm]')
  await ready(() => expect(dom.container.querySelector('[data-management-read-bot]')).not.toBeNull())
  expect(native.filter(call => call.path.startsWith('/developers/'))).toEqual([])
  await click('[data-surface-mode="use-persistent-connection"]')
  await ready(() => expect(dom.container.querySelector('[data-management-read-events]')).not.toBeNull())
  expect(writes()).toEqual([])
}

it('original mounted Settings reads the event mode then explicitly confirms its application-wide scalar change, with current readback separate from acceptance', async () => {
  await open(); await click('[data-management-read-events]')
  await ready(() => expect(dom.container.querySelector('[data-management-use-persistent]')).not.toBeNull())
  expect(dom.container.textContent).toContain('including existing event consumers')
  expect(writes()).toEqual([])
  expect(dom.container.querySelector('[data-management-current-transport]')?.textContent).toContain('Webhook')
  const action = current().applicationConfiguration!.actions.find(a => a.kind === 'use-persistent-connection')!
  await click('[data-management-use-persistent]')
  await ready(() => expect(current().applicationConfiguration!.selected?.secureStorage).toBe('stored'))
  expect(current().applicationConfiguration!.selected!.input).toMatchObject({ expectedRevision: action.expectedRevision, decision: { actionId: action.actionId, value: 'confirm' } })
  const selected = current().applicationConfiguration!.selected!
  expect(selected).toMatchObject({ effect: 'use-persistent-connection', request: 'confirmed', secureStorage: 'stored' })
  expect(dom.container.querySelector('[data-management-effect-result="' + selected.stepId + '"] small')?.textContent).toBe('Result saved')
  expect(current().applicationConfiguration!.capability).toBe('unknown')
  expect(writes()).toEqual([{ path: '/developers/v1/event/switch/' + APP, body: { clientId: APP, eventMode: 4 } }])
  mode = 4; await click('[data-management-read-events]')
  await ready(() => expect(dom.container.querySelector('[data-management-current-transport]')?.textContent).toBe('Last checked event delivery: Persistent connection'))
  expect(current().applicationConfiguration!.capability).toBe('enabled')
  expect(dom.container.querySelector('[data-management-use-persistent]')).toBeNull()
  expect(writes()).toHaveLength(1); expect(dom.draft('agent-1')).toBe('Keep my draft')
  expect(dom.container.textContent).not.toContain('settings-event-private')
}, 30_000)

it('unknown event writes retain the original request and leave the independent bot message action usable in the same Settings task', async () => {
  await open(); await click('[data-management-read-events]')
  await ready(() => expect(dom.container.querySelector('[data-management-use-persistent]')).not.toBeNull())
  accept = false; await click('[data-management-use-persistent]')
  await ready(() => expect(dom.container.querySelector('[data-management-unresolved]')).not.toBeNull())
  const original = current().applicationConfiguration!.selected!
  expect(original.request).toBe('unknown')
  expect(dom.container.querySelector('[data-management-use-persistent]')).toBeNull()
  await click('[data-surface-mode="enable-messaging"]'); await click('[data-management-read-bot]')
  await ready(() => expect(dom.container.querySelector('[data-management-enable]')).not.toBeNull())
  accept = true; await click('[data-management-enable]')
  await ready(() => expect(current().applicationConfiguration!.selected).toMatchObject({ effect: 'enable-messaging', request: 'confirmed', secureStorage: 'stored' }))
  await click('[data-surface-mode="use-persistent-connection"]')
  await ready(() => expect(current().applicationConfiguration!.selected!.stepId).toBe(original.stepId))
  expect(current().applicationConfiguration!.reason).toBe('original-effect-unconfirmed')
  expect(writes().filter(call => call.path.includes('/event/switch/'))).toHaveLength(1)
  expect(writes().filter(call => call.path.includes('/robot/switch/'))).toHaveLength(1)
}, 30_000)
