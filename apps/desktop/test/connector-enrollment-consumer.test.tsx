// @vitest-environment happy-dom
import { act, useState } from 'react'
import { join } from 'node:path'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '@agentmux/core'
import type { ConnectionMethod, ConnectionParamsMap, ConnectionResultMap } from '@agentmux/core/connections'
import { createDesktopConnections } from '../src/main/connector-host.js'
import { DesktopConnectorSecrets } from '../src/main/connector-secrets.js'
import { registerConnectorIpc } from '../src/main/connector-ipc.js'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'
import { ingressFixture } from '../../../packages/connectors/test/fixtures/ingress.js'
import { defaultFeishuSdkTransport, feishuConfig, feishuPayload } from '../../../packages/connectors/test/fixtures/feishu.js'
import { enrollmentEncryption } from '../../../packages/connectors/test/fixtures/connection-enrollment.js'

const dom = composerDOM(), privateDevice = 'private-mount-device-material', secret = 'private-mount-application-credential'
const clean: Array<() => void | Promise<void>> = []
let original: Awaited<ReturnType<typeof ingressFixture>>
let services: Awaited<ReturnType<typeof createDesktopConnections>>
let server: AgentMuxControlServer
let sdk: ReturnType<typeof defaultFeishuSdkTransport>
let calls: Array<{ method: ConnectionMethod; input: unknown; result: unknown }>
let platformCalls: string[], authorize: boolean, loseBegin: boolean, clock: number
let reopen: () => void
let openOwner: () => Promise<void>

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  original = await ingressFixture(true, feishuConfig); clean.push(() => original.close())
  sdk = defaultFeishuSdkTransport()
  calls = []; platformCalls = []; authorize = false; loseBegin = false; clock = Date.now()
  const actualNow = Date.now.bind(Date), anchor = clock
  vi.spyOn(Date, 'now').mockImplementation(() => actualNow() + clock - anchor)
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body)), action = body.get('action')!
    expect(String(url)).toBe('https://accounts.feishu.cn/oauth/v1/app/registration')
    platformCalls.push(action)
    if (action === 'begin') {
      if (loseBegin) throw new Error('Controlled registration acknowledgement loss')
      return Response.json({ device_code: privateDevice, user_code: 'BOT-CODE', verification_uri: 'https://open.feishu.cn/page/cli', verification_uri_complete: 'https://open.feishu.cn/page/cli?user_code=BOT-CODE', interval: 1, expires_in: 600 })
    }
    expect(action).toBe('poll'); expect(body.get('device_code')).toBe(privateDevice)
    return Response.json(authorize ? { client_id: feishuConfig.application.appId, client_secret: secret, user_info: { tenant_brand: 'feishu' } } : { error: 'authorization_pending' })
  }))
  const directory = join(original.root, 'mounted-enrollment'), encryption = enrollmentEncryption()
  openOwner = async () => {
    services = await createDesktopConnections({ directory, encryption,
      bindings: { spatial: original.spatial, checkpoint: async ref => ({ ...ref, checkpoint: await original.client.conversationCheckpoint(ref.agentSessionId) }) },
      ingress: { core: hostId => hostId === 'local' ? original.client : undefined } })
    server = new AgentMuxControlServer({ socketPath: join(original.root, 'mounted-enrollment.sock'), connections: services.connections, coreClients: original.coreClients })
    await server.start()
  }
  await openOwner(); clean.push(() => services.close()); clean.push(() => server.stop())
  const handlers = new Map<string, (...args: any[]) => Promise<any>>()
  registerConnectorIpc({ handleWithEvent: (channel, handler) => { handlers.set(channel, handler) }, assertTrusted: () => {}, socketPath: server.path,
    secrets: { store: input => services.secrets.store(input), inspect: operationId => services.secrets.inspect(operationId) } })
  vi.spyOn(api.connections, 'call').mockImplementation(async <M extends ConnectionMethod>(method: M, input: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
    const result = await handlers.get('connections:call')!({}, method, input)
    calls.push({ method, input: structuredClone(input), result: structuredClone(result) }); return result
  })
  vi.spyOn(api.connections, 'storeCredential').mockImplementation(async input => handlers.get('connections:storeCredential')!({}, input))
  vi.spyOn(api.connections, 'inspectCredential').mockImplementation(async operationId => handlers.get('connections:inspectCredential')!({}, operationId))
})
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function MountedSettings() {
  const [visible, setVisible] = useState(true)
  reopen = () => setVisible(true)
  return <SettingsPanel visible={visible} initialSection="chat-connections" onClose={() => setVisible(false)} />
}
async function mount() {
  await dom.render(<MountedSettings />)
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[data-enrollment-create]')).not.toBeNull() })
}
async function click(selector: string) {
  let button: HTMLElement | null = null
  await vi.waitFor(async () => { await act(async () => {}); button = dom.container.querySelector<HTMLElement>(selector); expect(button, selector).not.toBeNull(); if (button!.matches('button')) expect((button as HTMLButtonElement).disabled).toBe(false) })
  await act(async () => button!.click())
}
async function pending() {
  await click('[data-enrollment-create]')
  await vi.waitFor(async () => { await act(async () => {}); expect(calls.some(call => call.method === 'connection.enrollment.begin')).toBe(true); expect((await services.connections.enrollment!.list({})).operations).toHaveLength(1); expect(dom.container.querySelector('[data-enrollment-operation]')).not.toBeNull() })
  return (await services.connections.enrollment!.list({})).operations[0]!
}
async function saved() {
  await vi.waitFor(async () => { await act(async () => {}); expect((await services.connections.list()).connections).toHaveLength(1); expect(dom.container.querySelector('.connector-connection-state')).not.toBeNull() }, { timeout: 6000 })
  return (await services.connections.list()).connections[0]!
}

it('mounted original Settings creates through trusted IPC and the default Host, then uses the original SDK receiver', async () => {
  await mount()
  expect(dom.container.querySelector('[aria-label="Connection app secret"]')).toBeNull()
  expect(platformCalls).toEqual([])
  const operation = await pending()
  expect(operation.authorization).toBe('pending')
  expect(dom.container.querySelector('[data-enrollment-code] svg')).not.toBeNull()
  expect(dom.container.textContent).not.toContain(privateDevice)
  authorize = true; clock = operation.challenge!.nextPollAt + 1
  await click('[data-enrollment-advance]')
  const record = await saved()
  expect(record.config).toMatchObject({ connectionId: operation.connectionId, adapterId: 'feishu', application: feishuConfig.application, enabled: true })
  expect(platformCalls).toEqual(['begin', 'poll'])
  expect(api.connections.storeCredential).not.toHaveBeenCalled()
  expect(JSON.stringify(calls)).not.toContain(privateDevice); expect(JSON.stringify(calls)).not.toContain(secret)
  expect(dom.container.textContent).toContain('Agent')
  await click('[data-enrollment-saved]')
  expect(dom.container.querySelector('[data-connection-editor]'), 'View connection must enter the original saved-application consumer').not.toBeNull()
  await vi.waitFor(() => expect(sdk.sockets).toHaveLength(1))
  await sdk.receive(feishuPayload()); expect(sdk.ack()).toEqual([{ code: 200 }])
  expect((await services.ingress!.list({ connectionId: record.config.connectionId })).ingresses).toHaveLength(1)
})

it('closing and reopening the original settings recovers the exact durable intent after the original Host owner reopens', async () => {
  await mount(); const operation = await pending()
  await click('[aria-label="Close settings"]')
  expect(dom.container.querySelector('.settings-page')?.hasAttribute('hidden')).toBe(true)
  await server.stop(); services.close(); await openOwner()
  await act(async () => reopen())
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[data-enrollment-operation]')?.getAttribute('data-enrollment-operation')).toBe(operation.operationId) })
  await click('[data-bot-enrollment] .connector-back')
  await click('.connector-enrollment__history summary')
  await click('[data-enrollment-select="' + operation.operationId + '"]')
  expect(dom.container.querySelector('[data-enrollment-operation]')?.getAttribute('data-enrollment-operation')).toBe(operation.operationId)
  const recovered = (await services.connections.enrollment!.inspect({ operationId: operation.operationId })).operation!
  expect(recovered.connectionId).toBe(operation.connectionId)
  expect(recovered.authorization).toBe('pending')
  expect(platformCalls).toEqual(['begin'])
})

it('unknown registration keeps the original operation and never refreshes its QR or repeats creation', async () => {
  loseBegin = true
  await mount(); const operation = await pending()
  expect(operation.authorization).toBe('unknown')
  expect(dom.container.querySelector('[data-enrollment-code] svg')).toBeNull()
  await click('[data-enrollment-inspect]')
  await click('[data-enrollment-advance]')
  expect(platformCalls).toEqual(['begin'])
  expect((await services.connections.enrollment!.list({})).operations.map(value => value.operationId)).toEqual([operation.operationId])
  expect(dom.container.querySelector('[data-enrollment-operation]')?.getAttribute('data-enrollment-operation')).toBe(operation.operationId)
})

it('an authorized bot whose secure save is interrupted continues locally without polling its one-time credential twice', async () => {
  const store = DesktopConnectorSecrets.prototype.store
  let unavailable = true
  vi.spyOn(DesktopConnectorSecrets.prototype, 'store').mockImplementation(async function(this: DesktopConnectorSecrets, input) {
    if (input.secret === secret && unavailable) throw new Error('Controlled private credential-store interruption')
    return await store.call(this, input)
  })
  await mount(); const operation = await pending(); authorize = true; clock = operation.challenge!.nextPollAt + 1
  await click('[data-enrollment-advance]')
  await vi.waitFor(async () => expect((await services.connections.enrollment!.inspect({ operationId: operation.operationId })).operation).toMatchObject({ authorization: 'authorized', credential: 'unknown', configuration: 'not-started' }))
  expect(platformCalls).toEqual(['begin', 'poll'])
  unavailable = false
  await click('[data-enrollment-advance]')
  const record = await saved()
  expect(record.config.connectionId).toBe(operation.connectionId)
  expect(platformCalls).toEqual(['begin', 'poll'])
  expect(dom.container.textContent).not.toContain('Controlled private credential-store interruption')
})

it('a lost Renderer reply preserves the admitted original setup when returning and resumes without creating another bot', async () => {
  const actualCall = vi.mocked(api.connections.call).getMockImplementation()! as typeof api.connections.call
  let loseReply = true
  vi.mocked(api.connections.call).mockImplementation(async <M extends ConnectionMethod>(method: M, input: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
    const result = await actualCall(method, input)
    if (method === 'connection.enrollment.begin' && loseReply) { loseReply = false; throw new Error('Controlled Renderer receipt interruption') }
    return result
  })
  await mount(); const original = await pending()
  expect(original.authorization).toBe('pending')
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.textContent).toContain('Controlled Renderer receipt interruption') })
  await click('.connector-enrollment > .connector-back')
  expect(dom.container.querySelector('[data-enrollment-create]'), 'An unconfirmed original creation must keep its recovery action instead of a fresh creation').toBeNull()
  await click('[data-enrollment-resume]')
  expect(dom.container.querySelector('[data-enrollment-create]')).toBeNull()
  expect(dom.container.querySelector('[data-enrollment-operation]')?.getAttribute('data-enrollment-operation')).toBe(original.operationId)
  await click('.connector-enrollment > .connector-diagnostics > summary')
  await click('[data-enrollment-inspect]')
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[data-enrollment-code] svg')).not.toBeNull() })
  expect(platformCalls).toEqual(['begin'])
  expect((await services.connections.enrollment!.list({})).operations.map(value => value.operationId)).toEqual([original.operationId])
})
