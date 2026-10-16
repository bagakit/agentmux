// @vitest-environment happy-dom
import { act, useState } from 'react'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import type { ConnectionEnrollmentView, ConnectionMethod, ConnectionParamsMap, ConnectionResultMap } from '@agentmux/core/connections'
import { createDesktopConnections } from '../src/main/connector-host.js'
import { DesktopConnectorSecrets } from '../src/main/connector-secrets.js'
import { registerConnectorIpc } from '../src/main/connector-ipc.js'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import iconUrl from '../resources/icon-512.png'
import { composerDOM } from './helpers/composer-dom-fixture'
import { enrollmentEncryption } from '../../../packages/connectors/test/fixtures/connection-enrollment.js'

const dom = composerDOM()
const APP = { domain: 'open.feishu.cn', appId: 'cli_settings_web_bot' }
const QR = 'settings-private-sign-in-code', COOKIE = 'settings-private-cookie', CSRF = 'settings-private-csrf'
let root: string, services: Awaited<ReturnType<typeof createDesktopConnections>>, server: AgentMuxControlServer
let closeSettings: () => void, reopenSettings: () => void
let failList: boolean, loseCreate: boolean, loseCredential: boolean, asset: Buffer
let lastBegin: ConnectionEnrollmentView | null
let platform: Array<{ path: string; body: RequestInit['body'] }>, calls: Array<{ method: ConnectionMethod; input: unknown }>
let deliverBegin: ((resume: () => void) => void) | null
let trusted: ReturnType<typeof vi.fn>
let initWait: 'headers' | 'body' | null
let releaseInit: Set<() => void>, initSignals: Array<AbortSignal | null | undefined>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'settings-web-'))
  asset = await readFile(join(import.meta.dirname, '../resources/icon-512.png'))
  failList = false; loseCreate = false; loseCredential = false; lastBegin = null; deliverBegin = null; platform = []; calls = []
  initWait = null; releaseInit = new Set(); initSignals = []
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, options: RequestInit = {}) => {
    if (String(url) === iconUrl) return new Response(new Uint8Array(asset))
    const target = new URL(String(url))
    platform.push({ path: target.pathname, body: options.body })
    expect(options.redirect).toBe('manual')
    if (target.origin === 'https://accounts.feishu.cn' && target.pathname === '/accounts/qrlogin/init') {
      initSignals.push(options.signal)
      const waitForAbort = () => new Promise<never>((_, reject) => {
        const finish = () => {
          options.signal?.removeEventListener('abort', finish)
          releaseInit.delete(finish)
          reject(options.signal?.reason ?? new Error('Controlled init cleanup'))
        }
        releaseInit.add(finish)
        if (options.signal?.aborted) finish()
        else options.signal?.addEventListener('abort', finish, { once: true })
      })
      if (initWait === 'headers') return waitForAbort()
      const response = Response.json({ code: 0, data: { step_info: { token: QR } } }, { headers: { 'x-flow-key': 'settings-private-flow' } })
      // happy-dom removes Set-Cookie during Response construction; preserve the real response header.
      response.headers.append('set-cookie', `session=${COOKIE}; Domain=.feishu.cn; Path=/; Secure; HttpOnly`)
      if (initWait === 'body') Object.defineProperty(response, 'json', { value: waitForAbort })
      return response
    }
    if (target.origin === 'https://accounts.feishu.cn' && target.pathname === '/accounts/qrlogin/polling') return Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross' } } })
    if (target.href === 'https://accounts.feishu.cn/cross') return new Response(null, { status: 302, headers: { location: 'https://ask.feishu.cn/' } })
    if (target.href === 'https://ask.feishu.cn/') return new Response('This landing page is not account authority')
    if (target.href === 'https://open.feishu.cn/app') return new Response(`<script>window.user=${JSON.stringify({ id: 'settings-user', tenantId: 'settings-enterprise', name: 'Bot owner', tenantName: 'Original enterprise' })};window.csrfToken=${JSON.stringify(CSRF)};</script>`, { headers: { 'content-type': 'text/html' } })
    expect(target.origin).toBe('https://open.feishu.cn')
    expect(new Headers(options.headers).get('x-csrf-token')).toBe(CSRF)
    expect(new Headers(options.headers).get('cookie')).toContain(`session=${COOKIE}`)
    if (target.pathname === '/developers/v1/app/upload/image') return Response.json({ code: 0, data: { url: 'https://images.example.test/settings-bot.png' } })
    if (target.pathname === '/developers/v1/manifest/upsert_by_template') {
      if (loseCreate) throw new Error('Controlled original create reply loss')
      return Response.json({ code: 0, data: { ClientID: APP.appId } })
    }
    if (target.pathname === '/developers/v1/secret/' + APP.appId) return Response.json({ code: 0, data: loseCredential ? {} : { secret: 'settings-private-app-secret' } })
    throw new Error('Unexpected settings Web request')
  }))
  services = await createDesktopConnections({ directory: join(root, 'connections'), encryption: enrollmentEncryption() })
  const list = services.connections.list.bind(services.connections)
  server = new AgentMuxControlServer({ socketPath: join(root, 'public.sock'), connections: { ...services.connections, list: async () => { if (failList) throw new Error('Controlled saved-bot list gap'); return list() } }, coreClients: () => { throw new Error('Creating a bot must not borrow an Agent Runtime') } })
  await server.start()
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>()
  const sender = { syntheticRenderer: 'owned-settings-consumer' }
  trusted = vi.fn((channel, event) => { expect(channel).toBe('connections:call'); expect(event).toBe(sender) })
  registerConnectorIpc({ handleWithEvent: (channel, handler) => handlers.set(channel, handler), assertTrusted: trusted, socketPath: server.path, secrets: services.secrets })
  vi.spyOn(api.connections, 'call').mockImplementation(async <M extends ConnectionMethod>(method: M, input: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
    calls.push({ method, input: structuredClone(input) })
    const result = await handlers.get('connections:call')!(sender, method, input)
    if (method === 'connection.enrollment.begin') {
      lastBegin = result as ConnectionEnrollmentView
      if (deliverBegin) await new Promise<void>(resolve => deliverBegin!(resolve))
    }
    return result as ConnectionResultMap[M]
  })
})
afterEach(async () => {
  for (const release of releaseInit) release()
  const errors: unknown[] = []
  for (const cleanup of [async () => { await server?.stop() }, () => { services?.close() }, async () => { if (root) await rm(root, { recursive: true, force: true }) }]) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (errors.length) throw new AggregateError(errors, 'Settings Web consumer cleanup failed')
})

function MountedSettings() {
  const [visible, setVisible] = useState(true)
  closeSettings = () => setVisible(false); reopenSettings = () => setVisible(true)
  return <SettingsPanel visible={visible} initialSection="chat-connections" onClose={closeSettings} />
}
async function click(selector: string) {
  if (selector === '[data-enrollment-create]') {
    await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector(selector) ?? dom.container.querySelector('[data-enrollment-new]')).not.toBeNull() })
    if (!dom.container.querySelector(selector)) await click('[data-enrollment-new]')
  }
  let button: HTMLButtonElement | null = null
  await vi.waitFor(async () => { await act(async () => {}); button = dom.container.querySelector(selector); expect(button, selector).not.toBeNull(); expect(button!.disabled).toBe(false) })
  const disclosures: HTMLDetailsElement[] = []
  for (let node = button!.parentElement; node; node = node.parentElement) if (node.matches('details:not([open])')) disclosures.push(node as HTMLDetailsElement)
  for (const disclosure of disclosures.reverse()) await act(async () => disclosure.querySelector<HTMLElement>('summary')!.click())
  expect(button!.closest('details:not([open])'), 'Use a control through its actual disclosure').toBeNull()
  await act(async () => button!.click())
}
async function reachAccount() {
  await click('[data-enrollment-create]')
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[data-enrollment-code] svg')).not.toBeNull() })
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[data-enrollment-action="confirm-account"]'), JSON.stringify({ paths: platform.map(item => item.path), calls: calls.map(item => ({ method: item.method, ...item.method === 'connection.enrollment.advance' ? { input: item.input } : {} })), text: dom.container.querySelector('[data-bot-enrollment]')?.textContent })).not.toBeNull() }, { timeout: 10_000 })
  expect(platform.filter(call => call.path.startsWith('/developers/'))).toEqual([])
}

it('keeps independently available creation after list failure and reaches native authorization before any create consent', async () => {
  failList = true
  await dom.render(<MountedSettings />)
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Controlled saved-bot list gap'))
  expect(dom.container.querySelector('[data-enrollment-existing]')).not.toBeNull()
  await click('[data-enrollment-new]')
  const field = dom.container.querySelector<HTMLInputElement>('[aria-label="New bot name"]')!
  expect(field, 'Independent creation remains available after a saved-bot list gap').not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'My Agent bot'); field.dispatchEvent(new Event('input', { bubbles: true })) })
  await reachAccount()
  expect(dom.container.textContent).toContain('Bot owner')
  expect(dom.container.textContent).toContain('Original enterprise')
  await click('[data-enrollment-action="confirm-account"]')
  await vi.waitFor(() => expect(dom.container.querySelector('[data-enrollment-action="create"]')).not.toBeNull())
  expect(platform.filter(call => call.path.startsWith('/developers/'))).toEqual([])
  const begin = calls.find(call => call.method === 'connection.enrollment.begin')!.input as import('@agentmux/core/connections').ConnectionEnrollmentBeginInput
  expect(begin.preset.name).toBe('My Agent bot')
  expect(Buffer.from(begin.preset.avatar.pngDataUrl.slice(22), 'base64')).toEqual(asset)
  expect([asset.readUInt32BE(16), asset.readUInt32BE(20)]).toEqual([512, 512])
  await click('[data-enrollment-action="create"]')
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[data-enrollment-saved]')).not.toBeNull() }, { timeout: 6000 })
  expect((await services.connections.list()).connections[0]!.config).toMatchObject({ connectionId: begin.connectionId, application: APP, label: 'My Agent bot' })
  expect(platform.filter(call => call.path.startsWith('/developers/')).map(call => call.path)).toEqual(['/developers/v1/app/upload/image', '/developers/v1/manifest/upsert_by_template', '/developers/v1/secret/' + APP.appId])
  expect(JSON.parse(String(platform.find(call => call.path === '/developers/v1/manifest/upsert_by_template')!.body)).createAppUserCustomField.i18n.zh_cn.name).toBe('My Agent bot')
  expect(trusted).toHaveBeenCalled()
  for (const privateText of [QR, COOKIE, CSRF, 'settings-private-app-secret']) expect(dom.container.textContent).not.toContain(privateText)
  expect(dom.draft('agent-1')).toBe('Keep my draft')
}, 20_000)

it.each(['headers', 'body'] as const)('ends only the original QR init observation when its %s stall, then explicitly renews the same setup', async phase => {
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  // Compress only the native request clock; Unix IPC and React keep their real scheduling.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => timeout(ms === 20_000 ? 10 : ms))
  initWait = phase
  await dom.render(<MountedSettings />); await click('[data-enrollment-create]')
  await vi.waitFor(async () => {
    await act(async () => {})
    expect(lastBegin?.operation?.authentication?.stage, 'The original init must finish as unconfirmed rather than remain pending').toBe('unknown')
  })
  const original = lastBegin!.operation
  assert.ok(original)
  expect(original.diagnostic).toEqual({ stage: 'authentication', code: 'native-unconfirmed', step: 'initialize', failure: phase === 'headers' ? 'transport-unconfirmed' : 'invalid-response', ...(phase === 'body' ? { httpStatus: 200 } : {}) })
  expect(initSignals[0]?.aborted).toBe(true)
  expect(platform.map(call => call.path)).toEqual(['/accounts/qrlogin/init'])
  expect(dom.container.querySelector('[data-enrollment-code]')).toBeNull()
  expect(dom.container.querySelector('[data-enrollment-action="renew-authentication"]')).not.toBeNull()
  const inspected = await api.connections.call('connection.enrollment.inspect', { operationId: original.operationId })
  expect(inspected.operation).toEqual(original)
  const details = dom.container.querySelector<HTMLDetailsElement>('.connector-diagnostics')!
  await act(async () => details.querySelector<HTMLElement>('summary')!.click())
  await click('[data-enrollment-recover]')
  expect(platform.map(call => call.path)).toEqual(['/accounts/qrlogin/init'])
  expect((await api.connections.call('connection.ls', {})).connections).toEqual([])
  expect(dom.draft('agent-1')).toBe('Keep my draft')
  initWait = null
  await click('[data-enrollment-action="renew-authentication"]')
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[data-enrollment-code] svg')).not.toBeNull() })
  await act(async () => closeSettings())
  const renewed = await api.connections.call('connection.enrollment.inspect', { operationId: original.operationId })
  assert.ok(renewed.operation)
  expect(renewed.operation.operationId).toBe(original.operationId)
  expect(renewed.operation.connectionId).toBe(original.connectionId)
  expect(renewed.operation.authentication?.attemptId).not.toBe(original.authentication?.attemptId)
  expect(renewed.operation.authentication?.stage).toBe('waiting')
  expect(platform.map(call => call.path)).toEqual(['/accounts/qrlogin/init', '/accounts/qrlogin/init'])
  expect(calls.filter(call => call.method === 'connection.enrollment.begin')).toHaveLength(1)
  expect((await services.connections.enrollment!.list({})).operations).toHaveLength(1)
}, 10_000)

it('keeps caller-cancelled native init unknown and inspectable on its original operation', async () => {
  await dom.render(<MountedSettings />); await click('[data-enrollment-create]')
  await vi.waitFor(() => expect(lastBegin?.challenge).toBeTruthy())
  await act(async () => closeSettings())
  const input = calls.find(call => call.method === 'connection.enrollment.begin')!.input as import('@agentmux/core/connections').ConnectionEnrollmentBeginInput
  const cancelled = { ...input, operationId: 'caller-cancelled-init', connectionId: 'caller-cancelled-bot' }
  initWait = 'headers'
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }), caller = new AbortController()
  try {
    const pending = client.call('connection.enrollment.begin', cancelled, { signal: caller.signal })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
    await vi.waitFor(() => expect(initSignals).toHaveLength(2))
    caller.abort()
    await rejected
    await vi.waitFor(() => expect(initSignals[1]?.aborted).toBe(true))
    const result = await client.call('connection.enrollment.inspect', { operationId: cancelled.operationId })
    assert.ok(result.operation)
    expect(result.operation.operationId).toBe(cancelled.operationId)
    expect(result.operation.authentication?.stage).toBe('unknown')
    expect(result.actions.some(action => action.kind === 'renew-authentication')).toBe(true)
    expect(platform.map(call => call.path)).toEqual(['/accounts/qrlogin/init', '/accounts/qrlogin/init'])
    expect((await client.call('connection.ls', {})).connections).toEqual([])
  } finally { await client.dispose() }
}, 10_000)

it('keeps an unknown create on the same original request without another native mutation', async () => {
  loseCreate = true
  await dom.render(<MountedSettings />)
  await reachAccount(); await click('[data-enrollment-action="confirm-account"]'); await click('[data-enrollment-action="create"]')
  await vi.waitFor(() => expect(dom.container.querySelector('.connector-enrollment__heading')?.textContent).toContain('Bot creation is not confirmed'))
  const operationId = dom.container.querySelector<HTMLElement>('[data-bot-enrollment]')!.dataset.enrollmentOperation!
  const count = platform.length
  expect(dom.container.querySelector('[data-enrollment-action="create"]')).toBeNull()
  await click('[data-enrollment-action="recover-local"]')
  expect(platform).toHaveLength(count)
  expect(platform.filter(call => call.path === '/developers/v1/manifest/upsert_by_template')).toHaveLength(1)
  expect(dom.container.querySelector<HTMLElement>('[data-bot-enrollment]')!.dataset.enrollmentOperation).toBe(operationId)
  expect((await services.connections.enrollment!.list({})).operations.map(item => item.operationId)).toEqual([operationId])
  expect((await services.connections.list()).connections).toEqual([])
}, 20_000)

it('drops a late private begin response after leaving and reopens only the original safe history', async () => {
  let release: (() => void) | undefined
  deliverBegin = resume => { release = resume }
  await dom.render(<MountedSettings />); await click('[data-enrollment-create]')
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  await act(async () => closeSettings())
  release!()
  await act(async () => {})
  await act(async () => reopenSettings())
  await vi.waitFor(() => expect(dom.container.querySelector('[data-bot-enrollment]')).not.toBeNull())
  expect(dom.container.querySelector('[data-enrollment-code]')).toBeNull()
  expect(dom.container.textContent).not.toContain('Bot owner')
  expect(dom.container.textContent).not.toContain(QR)
  expect(platform.map(call => call.path)).toEqual(['/accounts/qrlogin/init'])
  expect((await services.connections.enrollment!.list({})).operations).toHaveLength(1)
}, 10_000)

it.each(['late-code', 'active-code'] as const)('stops private auth when opening the existing-bot form inside this module: %s', async mode => {
  let release: (() => void) | undefined
  if (mode === 'late-code') deliverBegin = resume => { release = resume }
  await dom.render(<MountedSettings />); await click('[data-enrollment-create]')
  await vi.waitFor(() => expect(lastBegin?.challenge).toBeTruthy())
  if (mode === 'active-code') await vi.waitFor(() => expect(dom.container.querySelector('[data-enrollment-code] svg')).not.toBeNull())
  await click('[data-enrollment-existing]')
  const field = dom.container.querySelector<HTMLInputElement>('[aria-label="Connection app ID"]')!
  expect(field).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'cli_existing_draft'); field.dispatchEvent(new Event('input', { bubbles: true })) })
  release?.()
  await act(async () => { await new Promise(resolve => setTimeout(resolve, Math.max(0, lastBegin!.challenge!.nextPollAt - Date.now()) + 100)) })
  expect(calls.filter(call => call.method === 'connection.enrollment.advance')).toEqual([])
  expect(platform.map(call => call.path)).toEqual(['/accounts/qrlogin/init'])
  expect(dom.container.querySelector('[data-enrollment-code]')).toBeNull()
  expect(field.value).toBe('cli_existing_draft')
  expect((await services.connections.enrollment!.list({})).operations).toHaveLength(1)
}, 10_000)

it('keeps the offered sign-in recovery reachable for the same known bot after a credential read gap', async () => {
  loseCredential = true
  await dom.render(<MountedSettings />); await reachAccount()
  await click('[data-enrollment-action="confirm-account"]'); await click('[data-enrollment-action="create"]')
  await vi.waitFor(() => expect(dom.container.querySelector('[data-enrollment-action="read-credential"]')).not.toBeNull())
  const renew = dom.container.querySelector<HTMLButtonElement>('[data-enrollment-renew]')!
  expect(renew).not.toBeNull()
  const disclosure = renew.closest<HTMLDetailsElement>('details')!
  await act(async () => disclosure.querySelector<HTMLElement>('summary')!.click())
  await click('[data-enrollment-renew]')
  await vi.waitFor(() => expect(platform.filter(call => call.path === '/accounts/qrlogin/init')).toHaveLength(2))
  expect(platform.filter(call => call.path === '/developers/v1/manifest/upsert_by_template')).toHaveLength(1)
  expect((await services.connections.enrollment!.list({})).operations).toHaveLength(1)
}, 20_000)

it('keeps the offered same-application credential read reachable when its create snapshot cannot be stored', async () => {
  const store = DesktopConnectorSecrets.prototype.store
  vi.spyOn(DesktopConnectorSecrets.prototype, 'store').mockImplementation(async function(this: DesktopConnectorSecrets, input) {
    let snapshot: { receipt?: { kind?: string } } | null = null
    try { snapshot = JSON.parse(input.secret) } catch { /* The ordinary secret is not a snapshot. */ }
    if (snapshot?.receipt?.kind === 'created') throw new Error('Controlled persistent create-snapshot storage gap')
    return store.call(this, input)
  })
  await dom.render(<MountedSettings />)
  await reachAccount(); await click('[data-enrollment-action="confirm-account"]'); await click('[data-enrollment-action="create"]')
  await vi.waitFor(() => expect(dom.container.querySelector('[data-enrollment-action="read-credential"]'), 'The offered same-bot read must remain reachable despite the local snapshot gap').not.toBeNull())
  expect(platform.filter(item => item.path === '/developers/v1/manifest/upsert_by_template')).toHaveLength(1)
  expect(platform.filter(item => item.path.startsWith('/developers/v1/secret/'))).toHaveLength(0)
  await click('[data-enrollment-action="read-credential"]')
  await vi.waitFor(() => expect(dom.container.querySelector('[data-enrollment-saved]')).not.toBeNull())
  expect(platform.filter(item => item.path === '/developers/v1/manifest/upsert_by_template')).toHaveLength(1)
  expect(platform.filter(item => item.path === '/developers/v1/secret/' + APP.appId)).toHaveLength(1)
  expect((await services.connections.list()).connections[0]?.config.application).toEqual(APP)
}, 20_000)

it('repairs an original credential ACK locally while the platform is unavailable', async () => {
  const store = DesktopConnectorSecrets.prototype.store
  let loseAcknowledgement = true
  vi.spyOn(DesktopConnectorSecrets.prototype, 'store').mockImplementation(async function(this: DesktopConnectorSecrets, input) {
    const result = await store.call(this, input)
    if (loseAcknowledgement && input.secret === 'settings-private-app-secret') {
      loseAcknowledgement = false
      throw new Error('Controlled original credential ACK loss')
    }
    return result
  })
  await dom.render(<MountedSettings />)
  await reachAccount(); await click('[data-enrollment-action="confirm-account"]'); await click('[data-enrollment-action="create"]')
  await vi.waitFor(() => expect(dom.container.querySelector('[data-enrollment-action="read-credential"]')).not.toBeNull())
  const requests = vi.mocked(fetch).mock.calls.length
  vi.mocked(fetch).mockRejectedValue(new Error('Controlled platform unavailable after original secure commit'))
  await act(async () => dom.container.querySelector<HTMLElement>('.connector-enrollment > .connector-diagnostics > summary')!.click())
  await click('[data-enrollment-recover]')
  await vi.waitFor(() => expect(dom.container.querySelector('[data-enrollment-saved]')).not.toBeNull())
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(requests)
  expect((await services.connections.list()).connections[0]?.config.application).toEqual(APP)
}, 20_000)
