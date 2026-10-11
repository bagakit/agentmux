// @vitest-environment happy-dom
import { act, useState } from 'react'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import iconUrl from '../resources/icon-512.png'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '@agentmux/core'
import type { ConnectionMethod, ConnectionParamsMap, ConnectionRecord, ConnectionResultMap } from '@agentmux/core/connections'
import { createDesktopConnections } from '../src/main/connector-host.js'
import { registerConnectorIpc } from '../src/main/connector-ipc.js'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'
import { ingressFixture } from '../../../packages/connectors/test/fixtures/ingress.js'
import { defaultFeishuSdkTransport, feishuConfig, feishuPayload } from '../../../packages/connectors/test/fixtures/feishu.js'
import { enrollmentEncryption } from '../../../packages/connectors/test/fixtures/connection-enrollment.js'

const dom = composerDOM(), privateCode = 'private-setup-sign-in-code', credential = 'private-setup-credential'
let original: Awaited<ReturnType<typeof ingressFixture>>
let services: Awaited<ReturnType<typeof createDesktopConnections>>, server: AgentMuxControlServer
let sdk: ReturnType<typeof defaultFeishuSdkTransport>, reopen: () => void
let forward: typeof api.connections.call
let calls: Array<{ method: ConnectionMethod; input: unknown; result: unknown }>
let platformCalls: string[]
let trusted: ReturnType<typeof vi.fn>

async function openOwner(receiver = true) {
  services = await createDesktopConnections({ directory: join(original.root, 'setup-continuation'), encryption: enrollmentEncryption(),
    bindings: { spatial: original.spatial, checkpoint: async ref => await original.client.conversationCheckpoint(ref) },
    ...(receiver ? { ingress: { core: (hostId: string) => hostId === 'local' ? original.client : undefined } } : {}) })
  server = new AgentMuxControlServer({ socketPath: join(original.root, 'setup-continuation.sock'), connections: services.connections, coreClients: original.coreClients })
  await server.start()
}

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  original = await ingressFixture(true, feishuConfig)
  sdk = defaultFeishuSdkTransport()
  calls = []; platformCalls = []
  const image = await readFile(join(import.meta.dirname, '../resources/icon-512.png'))
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === iconUrl) return new Response(new Uint8Array(image))
    const target = new URL(String(url))
    platformCalls.push(target.pathname)
    expect(init?.redirect).toBe('manual')
    if (target.href === 'https://accounts.feishu.cn/accounts/qrlogin/init') {
      const response = Response.json({ code: 0, data: { step_info: { token: privateCode } } }, { headers: { 'x-flow-key': 'private-setup-flow' } })
      response.headers.append('set-cookie', 'session=private-setup-cookie; Domain=.feishu.cn; Path=/; Secure; HttpOnly')
      return response
    }
    if (target.href === 'https://accounts.feishu.cn/accounts/qrlogin/polling') return Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross' } } })
    if (target.href === 'https://accounts.feishu.cn/cross') return new Response(null, { status: 302, headers: { location: 'https://ask.feishu.cn/' } })
    if (target.href === 'https://ask.feishu.cn/') return new Response('No account authority here')
    if (target.href === 'https://open.feishu.cn/app') return new Response(`<script>window.user=${JSON.stringify({ id: 'setup-user', tenantId: 'setup-enterprise', name: 'Setup owner' })};window.csrfToken="private-setup-csrf";</script>`, { headers: { 'content-type': 'text/html' } })
    expect(target.origin).toBe('https://open.feishu.cn')
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('private-setup-csrf')
    expect(new Headers(init?.headers).get('cookie')).toContain('session=private-setup-cookie')
    if (target.pathname === '/developers/v1/app/upload/image') return Response.json({ code: 0, data: { url: 'https://images.example.test/setup-bot.png' } })
    if (target.pathname === '/developers/v1/app/create') return Response.json({ code: 0, data: { ClientID: feishuConfig.application.appId } })
    if (target.pathname === '/developers/v1/secret/' + feishuConfig.application.appId) return Response.json({ code: 0, data: { secret: credential } })
    throw new Error('Unexpected continuation Web request')
  }))
  await openOwner()
  const handlers = new Map<string, (...args: any[]) => Promise<any>>()
  trusted = vi.fn()
  registerConnectorIpc({ handleWithEvent: (channel, handler) => { handlers.set(channel, handler) }, assertTrusted: trusted, socketPath: server.path,
    secrets: { store: input => services.secrets.store(input), inspect: operationId => services.secrets.inspect(operationId) } })
  forward = async <M extends ConnectionMethod>(method: M, input: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
    const result = await handlers.get('connections:call')!({}, method, input)
    calls.push({ method, input: structuredClone(input), result: structuredClone(result) })
    return result
  }
  vi.spyOn(api.connections, 'call').mockImplementation(forward)
  vi.spyOn(api.connections, 'storeCredential').mockImplementation(async input => handlers.get('connections:storeCredential')!({}, input))
  vi.spyOn(api.connections, 'inspectCredential').mockImplementation(async operationId => handlers.get('connections:inspectCredential')!({}, operationId))
})
afterEach(async () => { await server?.stop(); services?.close(); await original?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function MountedSettings() {
  const [visible, setVisible] = useState(true)
  reopen = () => setVisible(true)
  return <SettingsPanel visible={visible} initialSection="chat-connections" onClose={() => setVisible(false)} />
}
async function mount() {
  await dom.render(<MountedSettings />)
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[data-connector-settings]')).not.toBeNull() })
}
async function click(selector: string) {
  let target: HTMLElement | null = null
  await vi.waitFor(async () => { await act(async () => {}); target = dom.container.querySelector(selector); expect(target, selector).not.toBeNull(); if (target!.matches('button')) expect((target as HTMLButtonElement).disabled).toBe(false) })
  const hiddenBy = target!.matches('summary') ? target!.parentElement?.parentElement?.closest('details:not([open])') : target!.closest('details:not([open])')
  expect(hiddenBy ?? null, 'Use the control through its visible disclosure').toBeNull()
  await act(async () => target!.click())
}
async function fill(label: string, value: string) {
  const input = dom.container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
  expect(input).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
function result() { return dom.container.querySelector<HTMLElement>('[data-connection-setup-result]') }
function stages() {
  const pane = result()!
  expect(pane, 'The same setup task must expose current connection facts').not.toBeNull()
  const disclosure = pane.querySelector('[data-connection-stage]')?.closest<HTMLDetailsElement>('details')
  if (disclosure) disclosure.open = true
  return Object.fromEntries([...pane.querySelectorAll<HTMLElement>('[data-connection-stage]')].map(element => [element.dataset.connectionStage!, element.dataset.state]))
}
async function createAndSave() {
  await click('[data-enrollment-create]')
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[data-enrollment-action="confirm-account"]')).not.toBeNull() }, { timeout: 10_000 })
  const operation = (await services.connections.enrollment!.list({})).operations[0]!
  await click('[data-enrollment-action="confirm-account"]')
  await vi.waitFor(() => expect(dom.container.querySelector('[data-enrollment-action="create"]')).not.toBeNull())
  expect(platformCalls.filter(path => path === '/developers/v1/app/create')).toHaveLength(0)
  await click('[data-enrollment-action="create"]')
  await vi.waitFor(async () => { await act(async () => {}); expect((await forward('connection.enrollment.inspect', { operationId: operation.operationId })).operation?.configuration).toBe('configured') })
  return (await forward('connection.enrollment.inspect', { operationId: operation.operationId })).operation!
}

async function seed(connectionId: string, appId = feishuConfig.application.appId, enabled = true) {
  const stored = await services.secrets.store({ operationId: connectionId + ':credential', secret: credential })
  return (await services.connections.configure({ operationId: connectionId + ':save', expectedRevision: null,
    connection: { ...feishuConfig, connectionId, application: { ...feishuConfig.application, appId }, label: connectionId, enabled, credentialRef: stored.credentialRef } })).connection
}
async function select(connectionId: string) {
  await click(`[data-connection="${connectionId}"] button`)
  await vi.waitFor(async () => { await act(async () => {}); expect(result()?.dataset.connectionSetupResult).toBe(connectionId); expect(reads(connectionId).length).toBeGreaterThan(0) })
}
function reads(connectionId: string) { return calls.filter(call => call.method === 'connection.inspect' && (call.input as { connectionId?: string }).connectionId === connectionId) }
function checks(connectionId: string) { return calls.filter(call => call.method === 'connection.test' && (call.input as { connectionId: string }).connectionId === connectionId) }
function deferred() { let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve }); return { gate, release } }
function expectNoAdditionalWrites() {
  const methods = calls.map(call => call.method)
  expect(methods.length).toBeGreaterThan(0)
  expect(methods.filter(method => !['connection.ls', 'connection.inspect', 'connection.test', 'connection.enrollment.ls', 'connection.enrollment.inspect', 'connection.service.get', 'connection.setup.ls'].includes(method))).toEqual([])
}

it('continues the original creation through current Host reads, explicit checks and the original SDK receiver without navigating away', async () => {
  await mount()
  const operation = await createAndSave(), saved = operation.configured!.connection
  expect(saved.observation).toMatchObject({ authentication: { state: 'unknown' }, transport: { state: 'unknown' }, intake: { state: 'unknown' }, delivery: { state: 'unknown' } })
  await vi.waitFor(() => expect(result()?.dataset.connectionSetupResult).toBe(operation.connectionId))
  expect(dom.container.querySelector('[data-bot-enrollment]')?.getAttribute('data-enrollment-operation')).toBe(operation.operationId)
  expect(dom.container.querySelector('[data-connection-editor]')).toBeNull()
  await vi.waitFor(() => expect(reads(operation.connectionId).length).toBeGreaterThan(0))
  expect(checks(operation.connectionId)).toEqual([])
  await vi.waitFor(() => expect(sdk.sockets).toHaveLength(1))
  await click('[data-connection-check]')
  await vi.waitFor(() => expect(checks(operation.connectionId)).toHaveLength(1))
  await vi.waitFor(() => expect(stages()).toEqual({ authentication: 'ready', transport: 'ready', intake: 'unknown', delivery: 'unknown' }))
  expect(result()?.textContent).not.toContain('Needs attention')
  await sdk.receive(feishuPayload())
  expect(sdk.ack()).toEqual([{ code: 200 }])
  expect((await services.ingress!.list({ connectionId: operation.connectionId })).ingresses).toHaveLength(1)
  await click('[data-connection-check]')
  await vi.waitFor(() => expect(stages()).toEqual({ authentication: 'ready', transport: 'ready', intake: 'ready', delivery: 'unknown' }))
  expect((await forward('connection.enrollment.inspect', { operationId: operation.operationId })).operation?.configured).toEqual(operation.configured)
  expect(platformCalls).toEqual(['/accounts/qrlogin/init', '/accounts/qrlogin/polling', '/cross', '/', '/app', '/developers/v1/app/upload/image', '/developers/v1/app/create', '/developers/v1/secret/' + feishuConfig.application.appId])
  expect(trusted.mock.calls.map(call => call[0])).toContain('connections:call')
  expect(calls.filter(call => call.method.startsWith('connection.room.') || call.method.startsWith('connection.binding.') || call.method.startsWith('connection.profile.'))).toEqual([])
  expect(api.connections.storeCredential).not.toHaveBeenCalled()
  expect(JSON.stringify(calls.filter(call => call.method === 'connection.enrollment.ls'))).not.toContain(privateCode); expect(JSON.stringify(calls)).not.toContain(credential)
})

it('continues an existing bot save in place and keeps accepted credentials separate from unconfirmed transport, intake and delivery', async () => {
  await server.stop(); services.close(); await openOwner(false)
  await mount(); await click('[data-enrollment-existing]')
  await fill('Connection app ID', feishuConfig.application.appId); await fill('Connection app secret', credential)
  await click('[data-connection-save]')
  await vi.waitFor(() => expect(result()).not.toBeNull())
  const saved = (await services.connections.list()).connections[0]!
  expect(result()?.closest('[data-connection-editor]')).not.toBeNull()
  expect(result()?.dataset.connectionSetupResult).toBe(saved.config.connectionId)
  await vi.waitFor(() => expect(reads(saved.config.connectionId).length).toBeGreaterThan(0))
  expect(stages()).toEqual({ authentication: 'unknown', transport: 'unknown', intake: 'unknown', delivery: 'unknown' })
  expect(checks(saved.config.connectionId)).toEqual([])
  expect(api.connections.storeCredential).toHaveBeenCalledTimes(1)
  expect(trusted.mock.calls.map(call => call[0])).toContain('connections:storeCredential')
  expect(calls.filter(call => call.method === 'connection.configure')).toHaveLength(1)
  calls = []
  await click('[data-connection-check]')
  await vi.waitFor(() => expect(stages()).toEqual({ authentication: 'ready', transport: 'unknown', intake: 'unknown', delivery: 'unknown' }))
  expect(checks(saved.config.connectionId)).toHaveLength(1)
  expectNoAdditionalWrites()
  expect(platformCalls).toEqual([])
  expect(sdk.sockets).toHaveLength(0)
  expect((await services.connections.inspect({ connectionId: saved.config.connectionId })).connection?.revision).toBe(saved.revision)
})

it('keeps the saved creation and usable check when a current lookup or explicit check reply is unavailable', async () => {
  let failRead = true, failCheck = true
  vi.mocked(api.connections.call).mockImplementation(async <M extends ConnectionMethod>(method: M, input: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
    if (method === 'connection.inspect' && (input as { connectionId?: string }).connectionId && failRead) throw new Error('Controlled current lookup gap')
    if (method === 'connection.test' && failCheck) { await forward(method, input); throw new Error('Controlled check reply gap') }
    return await forward(method, input)
  })
  await mount(); const operation = await createAndSave()
  await vi.waitFor(() => expect(result()?.textContent).toContain('could not'))
  const pane = dom.container.querySelector('[data-bot-enrollment]')!
  expect(pane.getAttribute('data-enrollment-operation')).toBe(operation.operationId)
  expect((await forward('connection.enrollment.inspect', { operationId: operation.operationId })).operation?.configured).toEqual(operation.configured)
  expect((await services.connections.list()).connections).toHaveLength(1)
  calls = []; failRead = false
  await click('[data-connection-check]')
  await vi.waitFor(() => expect(checks(operation.connectionId)).toHaveLength(1))
  await vi.waitFor(() => expect(dom.container.querySelector<HTMLButtonElement>('[data-connection-check]')?.disabled).toBe(false))
  expect(result()?.textContent).toContain('could not')
  expectNoAdditionalWrites()
  failCheck = false
  await click('[data-connection-check]')
  await vi.waitFor(() => expect(checks(operation.connectionId)).toHaveLength(2))
  await vi.waitFor(() => expect(stages().transport).toBe('ready'))
  expect(result()?.textContent).not.toContain('Controlled check reply gap')
  expectNoAdditionalWrites()
  expect(platformCalls).toEqual(['/accounts/qrlogin/init', '/accounts/qrlogin/polling', '/cross', '/', '/app', '/developers/v1/app/upload/image', '/developers/v1/app/create', '/developers/v1/secret/' + feishuConfig.application.appId])
  expect((await forward('connection.enrollment.inspect', { operationId: operation.operationId })).operation?.configured).toEqual(operation.configured)
})

it('does not let an earlier application check take over the next selected application or block its check', async () => {
  const a = await seed('application-a'), b = await seed('application-b', 'cli_fedcba9876543210')
  await mount(); await select(a.config.connectionId)
  const delayed = deferred(); let held = false
  vi.mocked(api.connections.call).mockImplementation(async <M extends ConnectionMethod>(method: M, input: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
    const response = await forward(method, input)
    if (method === 'connection.test' && (input as { connectionId: string }).connectionId === a.config.connectionId) { held = true; await delayed.gate; throw new Error('Earlier application reply unavailable') }
    return response
  })
  try {
    await click('[data-connection-check]'); await vi.waitFor(() => expect(held).toBe(true))
    await click('[data-connection-editor] > .connector-back'); await select(b.config.connectionId)
    expect(dom.container.querySelector<HTMLButtonElement>('[data-connection-check]')?.disabled).toBe(false)
    await click('[data-connection-check]'); await vi.waitFor(() => expect(checks(b.config.connectionId)).toHaveLength(1))
    await act(async () => { delayed.release(); await delayed.gate })
    expect(result()?.dataset.connectionSetupResult).toBe(b.config.connectionId)
    expect(result()?.textContent).not.toContain('Earlier application reply unavailable')
    expect(dom.container.querySelector('[data-connection-editor]')?.textContent).toContain(b.config.application.appId)
    expect((await services.connections.inspect({ connectionId: a.config.connectionId })).connection?.revision).toBe(a.revision)
    expectNoAdditionalWrites()
    expect(platformCalls).toEqual([])
  } finally { delayed.release() }
})

it('reads the current saved revision after reopening and rejects an older reply from the previous reading window', async () => {
  const saved = await seed('revision-application')
  const delayed = deferred(); let held = false, holdFirst = true
  vi.mocked(api.connections.call).mockImplementation(async <M extends ConnectionMethod>(method: M, input: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
    const response = await forward(method, input)
    if (method === 'connection.inspect' && (input as { connectionId?: string }).connectionId === saved.config.connectionId && holdFirst) { holdFirst = false; held = true; await delayed.gate }
    return response
  })
  try {
    await mount(); await select(saved.config.connectionId); await vi.waitFor(() => expect(held).toBe(true))
    await click('[aria-label="Close settings"]')
    const latest = (await services.connections.configure({ operationId: 'pause-original-application', expectedRevision: saved.revision, connection: { ...saved.config, enabled: false } })).connection
    expect(latest.revision).toBeGreaterThan(saved.revision)
    await act(async () => reopen())
    await vi.waitFor(() => expect(stages()).toEqual({ authentication: 'disabled', transport: 'disabled', intake: 'disabled', delivery: 'disabled' }))
    await act(async () => { delayed.release(); await delayed.gate })
    expect(stages()).toEqual({ authentication: 'disabled', transport: 'disabled', intake: 'disabled', delivery: 'disabled' })
    expect(result()?.dataset.connectionSetupResult).toBe(saved.config.connectionId)
    await click('[data-connection-check]')
    await vi.waitFor(() => expect(checks(saved.config.connectionId)).toHaveLength(1))
    expect((checks(saved.config.connectionId)[0]!.result as ConnectionRecord).revision).toBe(latest.revision)
    expectNoAdditionalWrites()
    expect(platformCalls).toEqual([])
  } finally { delayed.release() }
})

it('does not certify a selected application with another application’s otherwise valid reply', async () => {
  const a = await seed('scope-application-a'), b = await seed('scope-application-b', 'cli_fedcba9876543210', false)
  vi.mocked(api.connections.call).mockImplementation(async <M extends ConnectionMethod>(method: M, input: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
    const response = await forward(method, input)
    if (method === 'connection.test' && (input as { connectionId: string }).connectionId === a.config.connectionId) return await forward('connection.test', { connectionId: b.config.connectionId }) as ConnectionResultMap[M]
    return response
  })
  await mount(); await select(a.config.connectionId)
  await vi.waitFor(() => expect(dom.container.querySelector<HTMLButtonElement>('[data-connection-check]')?.disabled).toBe(false))
  const before = stages()
  await click('[data-connection-check]')
  await vi.waitFor(() => expect(checks(b.config.connectionId)).toHaveLength(1))
  await vi.waitFor(() => expect(dom.container.querySelector<HTMLButtonElement>('[data-connection-check]')?.disabled).toBe(false))
  expect(result()?.dataset.connectionSetupResult).toBe(a.config.connectionId)
  expect(stages()).toEqual(before)
  expect(dom.container.querySelector('[data-connection-editor]')?.textContent).toContain(a.config.application.appId)
  expect(dom.container.querySelector('[data-connection-editor]')?.textContent).not.toContain(b.config.application.appId)
  expectNoAdditionalWrites()
  expect(platformCalls).toEqual([])
})

it('keeps a new source lookup pending when an earlier source check replies in the same Settings component', async () => {
  const saved = await seed('source-application'), oldReply = deferred(), newRead = deferred()
  let checking = false, reading = false
  vi.mocked(api.connections.call).mockImplementation(async <M extends ConnectionMethod>(method: M, input: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
    const response = await forward(method, input)
    if (method === 'connection.test') { checking = true; await oldReply.gate }
    return response
  })
  const originalSource = api.connections.call
  try {
    await mount(); await select(saved.config.connectionId)
    await click('[data-connection-check]'); await vi.waitFor(() => expect(checking).toBe(true))
    api.connections.call = async <M extends ConnectionMethod>(method: M, input: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
      const response = await forward(method, input)
      if (method === 'connection.inspect' && (input as { connectionId?: string }).connectionId === saved.config.connectionId) { reading = true; await newRead.gate }
      return response
    }
    await dom.render(<MountedSettings />)
    await vi.waitFor(() => expect(reading).toBe(true))
    const currentPane = result()
    expect(dom.container.querySelector<HTMLButtonElement>('[data-connection-check]')?.disabled).toBe(true)
    await act(async () => { oldReply.release(); await oldReply.gate })
    expect(result()).toBe(currentPane)
    expect(dom.container.querySelector<HTMLButtonElement>('[data-connection-check]')?.disabled, 'The earlier source may not finish the current source’s read').toBe(true)
    expect(stages()).toEqual({ authentication: 'unknown', transport: 'unknown', intake: 'unknown', delivery: 'unknown' })
    await act(async () => { newRead.release(); await newRead.gate })
    await vi.waitFor(() => expect(dom.container.querySelector<HTMLButtonElement>('[data-connection-check]')?.disabled).toBe(false))
    expect(result()?.dataset.connectionSetupResult).toBe(saved.config.connectionId)
    expectNoAdditionalWrites()
    expect(platformCalls).toEqual([])
  } finally { oldReply.release(); newRead.release(); api.connections.call = originalSource }
})
