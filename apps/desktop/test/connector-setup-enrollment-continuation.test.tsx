// @vitest-environment happy-dom
import { act, useState } from 'react'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '@agentmux/core'
import type { ConnectionMethod, ConnectionParamsMap, ConnectionResultMap, ConnectionSetupBegin, ConnectionSetupView, ConnectionEnrollmentView, ConnectionEnrollmentAdvanceInput } from '@agentmux/core/connections'
import { createDesktopConnections } from '../src/main/connector-host.js'
import { DesktopConnectorSecrets } from '../src/main/connector-secrets.js'
import { registerConnectorIpc } from '../src/main/connector-ipc.js'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import iconUrl from '../resources/icon-512.png'
import { composerDOM } from './helpers/composer-dom-fixture'
import { enrollmentEncryption } from '../../../packages/connectors/test/fixtures/connection-enrollment.js'

const dom = composerDOM(), APP = 'cli_settings_continuation', USER = 'settings-continuation-user', TENANT = 'settings-continuation-enterprise'
let root: string, services: Awaited<ReturnType<typeof createDesktopConnections>>, server: AgentMuxControlServer
let closeSettings: () => void, reopen: () => void, native: string[], calls: Array<{ method: ConnectionMethod; input: unknown; result: unknown }>
let afterCall: ((method: ConnectionMethod, result: unknown) => Promise<void>) | undefined, forward: typeof api.connections.call
let pendingPolls: number[]
const releases: Array<() => void> = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'settings-continuation-')); native = []; calls = []; afterCall = undefined; pendingPolls = []
  const asset = await readFile(join(import.meta.dirname, '../resources/icon-512.png'))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    if (String(url) === iconUrl) return new Response(new Uint8Array(asset))
    const target = new URL(String(url)); native.push(target.pathname)
    if (target.pathname === '/accounts/qrlogin/init') {
      const response = Response.json({ code: 0, data: { step_info: { token: 'settings-continuation-private-qr' } } }, { headers: { 'x-flow-key': 'settings-continuation-private-flow' } })
      response.headers.append('set-cookie', 'session=settings-continuation-private-cookie; Domain=.feishu.cn; Path=/; Secure')
      return response
    }
    if (target.pathname === '/accounts/qrlogin/polling') {
      const headers = new Headers(options?.headers)
      expect(headers.get('x-flow-key')).toBe('settings-continuation-private-flow')
      expect(headers.get('cookie')).toContain('session=settings-continuation-private-cookie')
      const previous = calls.findLast(call => ['connection.enrollment.begin', 'connection.enrollment.advance'].includes(call.method))?.result as ConnectionEnrollmentView | undefined
      if (previous?.challenge) expect(Date.now()).toBeGreaterThanOrEqual(previous.challenge.nextPollAt)
      const status = pendingPolls.shift()
      return Response.json({ code: 0, data: status === undefined
        ? { next_step: 'enter_app', step_info: { cross_login_uri: 'https://ask.feishu.cn/cross' } }
        : { next_step: 'qr_login_polling', step_info: { status } } })
    }
    if (target.href === 'https://ask.feishu.cn/cross') return new Response('Cross-login is not account identity')
    if (target.href === 'https://ask.feishu.cn/') return new Response('Landing is not account identity')
    if (target.href === 'https://open.feishu.cn/app') return new Response(`<script>window.user=${JSON.stringify({ id: USER, tenantId: TENANT })};window.csrfToken="settings-continuation-private-csrf";</script>`, { headers: { 'content-type': 'text/html' } })
    if (target.pathname === '/developers/v1/app/upload/image') return Response.json({ code: 0, data: { url: 'https://images.example.test/original.png' } })
    if (target.pathname === '/developers/v1/manifest/upsert_by_template') return Response.json({ code: 0, data: { ClientID: APP } })
    if (target.pathname === '/developers/v1/secret/' + APP) return Response.json({ code: 0, data: { secret: 'settings-continuation-private-secret' } })
    if (target.pathname === '/developers/v1/robot/' + APP) {
      expect(new Headers(options?.headers).get('x-csrf-token')).toBe('settings-continuation-private-csrf')
      expect(new Headers(options?.headers).get('cookie')).toContain('session=settings-continuation-private-cookie')
      return Response.json({ code: 0, data: { enable: false } })
    }
    throw new Error('Unexpected Settings continuation request')
  }))
  services = await createDesktopConnections({ directory: join(root, 'connections'), encryption: enrollmentEncryption() })
  server = new AgentMuxControlServer({ socketPath: join(root, 'owner.sock'), connections: services.connections, coreClients: () => { throw new Error('Saved login continuation cannot borrow an Agent Runtime') } })
  await server.start()
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>(), sender = { ownedRenderer: true }
  registerConnectorIpc({ handleWithEvent: (channel, handler) => handlers.set(channel, handler), assertTrusted: (channel, event) => { expect(channel).toBe('connections:call'); expect(event).toBe(sender) }, socketPath: server.path, secrets: services.secrets })
  forward = async <M extends ConnectionMethod>(method: M, input: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
    const result = await handlers.get('connections:call')!(sender, method, input)
    calls.push({ method, input: structuredClone(input), result: structuredClone(result) })
    await afterCall?.(method, result)
    return result as ConnectionResultMap[M]
  }
  vi.spyOn(api.connections, 'call').mockImplementation(forward)
})
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  const errors: unknown[] = []
  for (const cleanup of [() => server?.stop(), () => services?.close(), () => rm(root, { recursive: true, force: true }), () => { vi.restoreAllMocks() }, () => { vi.unstubAllGlobals() }]) try { await cleanup() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Settings continuation cleanup failed')
})
function MountedSettings() {
  const [visible, setVisible] = useState(true)
  closeSettings = () => setVisible(false); reopen = () => setVisible(true)
  return <SettingsPanel visible={visible} initialSection="lark" onClose={closeSettings} />
}
async function click(selector: string) {
  let button: HTMLButtonElement | null = null
  await vi.waitFor(async () => { await act(async () => {}); button = dom.container.querySelector(selector); expect(button, selector).not.toBeNull(); expect(button!.disabled).toBe(false) })
  const disclosure = button!.closest<HTMLDetailsElement>('details:not([open])')
  if (disclosure) await act(async () => disclosure.querySelector<HTMLElement>('summary')!.click())
  await act(async () => button!.click())
}
async function savedCreation() {
  await dom.render(<MountedSettings />); await click('[data-enrollment-new]'); await click('[data-enrollment-create]')
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[data-enrollment-action="confirm-account"]')).not.toBeNull() }, { timeout: 10_000 })
  await click('[data-enrollment-action="confirm-account"]'); await click('[data-enrollment-action="create"]')
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[data-enrollment-continue]')).not.toBeNull() }, { timeout: 6000 })
  const original = (await services.connections.enrollment!.list({})).operations[0]!
  expect(original.configuration).toBe('configured'); expect(dom.container.querySelector('[data-enrollment-saved]')).not.toBeNull()
  expect(native.filter(path => path === '/developers/v1/manifest/upsert_by_template')).toHaveLength(1)
  expect(native).not.toContain('/developers/v1/app/create')
  const pane = dom.container.querySelector('[data-bot-enrollment]')!
  expect(pane.textContent).toContain('Continue with your saved sign-in')
  expect(pane.textContent).toContain('Next, review this bot’s setup')
  expect(pane.textContent).not.toContain('Next, choose an Agent and a group')
  const check = pane.querySelector<HTMLButtonElement>('[data-connection-check]')!
  expect(check.closest('details')?.open).toBe(false)
  expect(Array.from(pane.querySelectorAll('.primary-button')).filter(button => !button.closest('details:not([open])'))).toHaveLength(1)
  expect(calls.filter(call => call.method === 'connection.setup.begin')).toEqual([])
  return { original, before: [...native] }
}

it('keeps the original QR through repeated waiting and scanning, then automatically reaches account review', async () => {
  pendingPolls = [1, 0, 2]
  await dom.render(<MountedSettings />); await click('[data-enrollment-new]'); await click('[data-enrollment-create]')
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[data-enrollment-code] svg')).not.toBeNull() })
  const qr = dom.container.querySelector('[data-enrollment-code] svg')!, original = calls.find(call => call.method === 'connection.enrollment.begin')!.result as ConnectionEnrollmentView
  const progress = () => calls.filter(call => call.method === 'connection.enrollment.advance').map(call => call.result as ConnectionEnrollmentView)
  for (const [index, stage] of ['waiting', 'waiting', 'scanned'].entries()) {
    await vi.waitFor(async () => { await act(async () => {}); expect(progress().length).toBeGreaterThan(index) }, { timeout: 4000 })
    expect(progress()[index]).toMatchObject({ operation: { operationId: original.operation!.operationId, authentication: { stage, attemptId: original.operation!.authentication!.attemptId } }, challenge: { qrPayload: original.challenge!.qrPayload } })
    expect(dom.container.querySelector('[data-enrollment-code] svg')).toBe(qr)
    expect(progress()[index]!.account).toBeNull()
    expect(progress()[index]!.actions.some(action => action.kind === 'continue-authentication')).toBe(true)
  }
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[data-enrollment-action="confirm-account"]')).not.toBeNull() }, { timeout: 5000 })
  expect(progress().map(view => view.operation!.authentication!.stage)).toEqual(['waiting', 'waiting', 'scanned', 'handoff', 'handoff', 'handoff', 'account'])
  expect(progress().every(view => view.operation!.authentication!.attemptId === original.operation!.authentication!.attemptId)).toBe(true)
  expect(progress().slice(3).every(view => view.challenge === null)).toBe(true)
  expect(dom.container.querySelector('[data-enrollment-code]')).toBeNull()
  expect(dom.container.textContent).toContain(USER); expect(dom.container.textContent).toContain(TENANT)
  expect(native).toEqual(['/accounts/qrlogin/init', ...Array(4).fill('/accounts/qrlogin/polling'), '/cross', '/', '/app'])
  expect(calls.filter(call => call.method === 'connection.enrollment.begin')).toHaveLength(1)
  const advances = calls.filter(call => call.method === 'connection.enrollment.advance')
  for (const [index, call] of advances.entries()) {
    const previous = index ? progress()[index - 1]! : original, input = call.input as ConnectionEnrollmentAdvanceInput
    const offered = previous.actions.find(action => action.kind === 'continue-authentication')!
    expect(input.operationId).toBe(original.operation!.operationId)
    expect(input.ownRevision).toBe(previous.operation!.revision)
    expect(input.decision).toEqual({ actionId: offered.actionId, kind: offered.kind })
  }
  expect(dom.draft('agent-1')).toBe('Keep my draft')
  expect((await services.connections.enrollment!.list({})).operations[0]!.application).toBeNull()
}, 20_000)

it('saved Settings creation explicitly continues the same bot with its original account, then separately confirms and reads it', async () => {
  const { original, before } = await savedCreation()
  await click('[data-enrollment-continue]')
  await vi.waitFor(() => expect(dom.container.querySelector('[data-management-stage="account"]')).not.toBeNull())
  expect(dom.container.textContent).toContain(USER); expect(dom.container.textContent).toContain(TENANT)
  expect(native).toEqual(before); expect(dom.container.querySelector('[data-management-code]')).toBeNull()
  const begin = calls.find(call => call.method === 'connection.setup.begin')!.input as ConnectionSetupBegin
  expect(begin).toMatchObject({ connectionId: original.connectionId, expectedConnectionRevision: original.configured!.connection.revision, source: { kind: 'enrollment', operationId: original.operationId, expectedRevision: original.revision } })
  expect(calls.filter(call => call.method === 'connection.setup.advance')).toEqual([])
  await click('[data-management-confirm]')
  await vi.waitFor(() => expect(dom.container.querySelector('[data-management-stage="confirmed"]')).not.toBeNull())
  expect(native).toEqual(before)
  await click('[data-management-read-bot]')
  await vi.waitFor(() => expect(native.slice(before.length)).toEqual(['/developers/v1/robot/' + APP]))
  await vi.waitFor(() => expect(dom.container.querySelector('[data-management-read-result]')).not.toBeNull())
  expect((await services.connections.enrollment!.list({})).operations[0]).toEqual(original)
  expect(dom.draft('agent-1')).toBe('Keep my draft')
  for (const value of ['settings-continuation-private', 'settings-continuation-private-secret']) expect(dom.container.textContent).not.toContain(value)
}, 20_000)

it('lost local handoff ACK reopens the original safe submission and repairs only its original child', async () => {
  const { before } = await savedCreation(), store = DesktopConnectorSecrets.prototype.store
  let lost = false
  vi.spyOn(DesktopConnectorSecrets.prototype, 'store').mockImplementation(async function (input) {
    const result = await store.call(this, input)
    if (!lost && input.operationId.startsWith('connection-setup-auth:')) { lost = true; throw new Error('Controlled handoff ACK loss') }
    return result
  })
  await click('[data-enrollment-continue]')
  await vi.waitFor(() => expect(calls.some(call => call.method === 'connection.setup.begin' && (call.result as ConnectionSetupView).operation?.secureStorage === 'unknown')).toBe(true))
  const input = calls.find(call => call.method === 'connection.setup.begin')!.input as ConnectionSetupBegin
  await act(async () => closeSettings()); await act(async () => reopen())
  await click(`[data-management-original="${input.operationId}"]`)
  await vi.waitFor(() => expect(dom.container.querySelector('[data-management-stage="unknown"]')).not.toBeNull())
  await click('[data-management-resume]')
  await vi.waitFor(() => expect(dom.container.querySelector('[data-management-stage="account"]')).not.toBeNull())
  const submitted = calls.filter(call => call.method === 'connection.setup.begin')
  expect(submitted).toHaveLength(2); expect(submitted[1]!.input).toEqual(input)
  expect((submitted[1]!.result as ConnectionSetupView).operation!.request.attemptId).toBe((submitted[0]!.result as ConnectionSetupView).operation!.request.attemptId)
  expect(native).toEqual(before)
}, 20_000)

it.each(['leave', 'source'] as const)('a late call-through handoff does not redisplay private account after changing %s', async change => {
  const { before } = await savedCreation()
  let release!: () => void, held = false
  afterCall = async method => { if (method === 'connection.setup.begin') { held = true; await new Promise<void>(done => { release = done; releases.push(done) }) } }
  await click('[data-enrollment-continue]'); await vi.waitFor(() => expect(held).toBe(true))
  const source = api.connections.call
  try {
    if (change === 'leave') await act(async () => closeSettings())
    else {
      api.connections.call = async <M extends ConnectionMethod>(method: M, input: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => forward(method, input)
      await dom.render(<MountedSettings />)
    }
    release(); await act(async () => {})
    if (change === 'leave') await act(async () => reopen())
    await vi.waitFor(() => expect(dom.container.querySelector('[data-management-original]')).not.toBeNull())
    expect(dom.container.querySelector('[data-management-confirm]')).toBeNull()
    expect(dom.container.textContent).not.toContain(USER); expect(dom.container.textContent).not.toContain(TENANT)
    expect(calls.filter(call => call.method === 'connection.setup.advance')).toEqual([]); expect(native).toEqual(before)
  } finally { api.connections.call = source }
}, 20_000)


it('Settings reads the exact safe authentication failure from its original durable request', async () => {
  const nativeFetch = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (url, options) => String(url).startsWith('https://accounts.feishu.cn/accounts/qrlogin/polling?')
    ? new Response('private-unparsed-body', { status: 200 }) : nativeFetch(url, options))
  await dom.render(<MountedSettings />); await click('[data-enrollment-new]'); await click('[data-enrollment-create]')
  await vi.waitFor(async () => {
    await act(async () => {})
    expect(dom.container.querySelector('.connector-enrollment .connector-diagnostics')?.textContent).toContain('poll · invalid-response · json')
  }, { timeout: 6000 })
  expect(dom.container.textContent).not.toContain('private-unparsed-body')
  expect(dom.container.querySelector('[data-enrollment-action="create"]')).toBeNull()
  const before = vi.mocked(fetch).mock.calls.length
  const checks = calls.length
  await click('[data-enrollment-recover], [data-enrollment-inspect]')
  await vi.waitFor(() => expect(calls).toHaveLength(checks + 1))
  expect(calls.at(-1)!.result).toMatchObject({ operation: { diagnostic: { boundary: 'json' } } })
  expect(fetch).toHaveBeenCalledTimes(before)
}, 10_000)
