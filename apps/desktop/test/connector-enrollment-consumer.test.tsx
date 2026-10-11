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
let beginReply: (() => Response) | null
let reopen: () => void
let openOwner: () => Promise<void>

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  original = await ingressFixture(true, feishuConfig); clean.push(() => original.close())
  sdk = defaultFeishuSdkTransport()
  calls = []; platformCalls = []; authorize = false; loseBegin = false; beginReply = null; clock = Date.now()
  const actualNow = Date.now.bind(Date), anchor = clock
  vi.spyOn(Date, 'now').mockImplementation(() => actualNow() + clock - anchor)
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body)), action = body.get('action')!
    expect(String(url)).toBe('https://accounts.feishu.cn/oauth/v1/app/registration')
    platformCalls.push(action)
    if (action === 'begin') {
      if (loseBegin) throw new Error('Controlled registration acknowledgement loss')
      if (beginReply) return beginReply()
      return Response.json({ device_code: privateDevice, user_code: 'BOT-CODE', verification_uri: 'https://open.feishu.cn/page/cli', verification_uri_complete: 'https://open.feishu.cn/page/cli?user_code=BOT-CODE', interval: 1, expires_in: 600 })
    }
    expect(action).toBe('poll'); expect(body.get('device_code')).toBe(privateDevice)
    return Response.json(authorize ? { client_id: feishuConfig.application.appId, client_secret: secret, user_info: { tenant_brand: 'feishu' } } : { error: 'authorization_pending' })
  }))
  const directory = join(original.root, 'mounted-enrollment'), encryption = enrollmentEncryption()
  openOwner = async () => {
    services = await createDesktopConnections({ directory, encryption,
      bindings: { spatial: original.spatial, checkpoint: async ref => ({ ...ref, checkpoint: await original.client.sessionHistoryCheckpoint(ref.agentSessionId) }) },
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
  const hiddenBy = button!.matches('summary') ? button!.parentElement?.parentElement?.closest('details:not([open])') : button!.closest('details:not([open])')
  expect(hiddenBy ?? null, 'Open the actual disclosure before using its control').toBeNull()
  await act(async () => button!.click())
}
async function inspectOriginal() {
  await act(async () => {
    const button = dom.container.querySelector<HTMLButtonElement>('[data-enrollment-inspect]')!
    expect(button).toBeTruthy()
    const details = button.closest<HTMLDetailsElement>('details:not([open])')
    if (details) details.querySelector<HTMLElement>('summary')!.click()
    expect(button.closest('details:not([open])'), 'Open the current receipt disclosure before reading it').toBeNull()
    button.click()
  })
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

it('clears a recovered bot-list error without creating or replacing a bot setup', async () => {
  const forward = vi.mocked(api.connections.call).getMockImplementation()!
  let failList = true
  vi.mocked(api.connections.call).mockImplementation(async (method, input) => {
    if (method === 'connection.ls' && failList) throw new Error('Controlled bot-list response gap')
    return forward(method, input)
  })
  await dom.render(<MountedSettings />)
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Controlled bot-list response gap'))
  expect(platformCalls).toEqual([])
  failList = false
  const refresh = [...dom.container.querySelectorAll<HTMLButtonElement>('.connector-onboarding button')].find(button => button.textContent === 'Refresh')!
  expect(refresh).toBeTruthy()
  await act(async () => refresh.click())
  await vi.waitFor(() => expect(dom.container.querySelector('[data-enrollment-create]')).not.toBeNull())
  expect(dom.container.textContent).not.toContain('Controlled bot-list response gap')
  expect(platformCalls).toEqual([])
  const operation = await pending()
  expect((await services.connections.enrollment!.inspect({ operationId: operation.operationId })).operation?.operationId).toBe(operation.operationId)
  expect(platformCalls).toEqual(['begin'])
})

it('keeps a failed check beside its original creation and the raw error inside closed technical details', async () => {
  loseBegin = true
  await mount()
  const operation = await pending()
  const forward = vi.mocked(api.connections.call).getMockImplementation()!
  vi.mocked(api.connections.call).mockImplementation(async (method, input) => {
    if (method === 'connection.enrollment.advance') throw new Error('Controlled RPC response ended')
    return forward(method, input)
  })
  await click('[data-enrollment-advance]')
  await vi.waitFor(() => expect(dom.container.querySelector('[data-enrollment-feedback]')?.textContent).toContain('Could not check this request'))
  const pane = dom.container.querySelector<HTMLElement>('[data-bot-enrollment]')!
  const feedback = pane.querySelector('[data-enrollment-feedback]')!
  expect(feedback.closest('.connector-enrollment__action')).not.toBeNull()
  expect(feedback.textContent).not.toContain('Controlled RPC response ended')
  const raw = pane.querySelector('[data-enrollment-error-detail]')!
  expect(raw.textContent).toContain('Controlled RPC response ended')
  expect(raw.closest<HTMLDetailsElement>('details')?.open).toBe(false)
  expect(pane.dataset.enrollmentOperation).toBe(operation.operationId)
  expect(pane.querySelectorAll('.primary-button')).toHaveLength(1)
  expect(platformCalls).toEqual(['begin'])
  vi.mocked(api.connections.call).mockImplementation(forward)
  await click('[data-enrollment-advance]')
  await vi.waitFor(() => expect(pane.querySelector('[data-enrollment-feedback]')?.textContent).toContain('Still no setup link'))
  expect(pane.querySelector('[data-enrollment-error-detail]')).toBeNull()
  expect(pane.dataset.enrollmentOperation).toBe(operation.operationId)
  expect(platformCalls).toEqual(['begin'])
})

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

it('the official public-code response reaches the original confirmation UI without a complete URL field', async () => {
  beginReply = () => Response.json({ device_code: privateDevice, user_code: 'BOT-CODE', verification_uri: 'https://open.feishu.cn/page/cli', interval: 1, expires_in: 600 })
  await mount(); const operation = await pending()
  expect(operation.authorization).toBe('pending')
  const url = new URL(operation.challenge!.verificationUrl)
  expect(url.origin).toBe('https://open.feishu.cn'); expect(url.pathname).toBe('/page/cli')
  expect(url.searchParams.get('user_code')).toBe('BOT-CODE')
  expect(dom.container.querySelector('[data-enrollment-code] svg')).not.toBeNull()
  expect(dom.container.querySelector('.connector-enrollment__heading')?.textContent).toContain('Scan with Feishu to continue')
  expect(dom.container.querySelectorAll('[data-bot-enrollment] .primary-button')).toHaveLength(1)
  expect(platformCalls).toEqual(['begin'])
  expect(JSON.stringify(calls)).not.toContain(privateDevice)
})

it.each([
  ['http-status', () => new Response('private platform body', { status: 503 }), { stage: 'response', code: 'http-status', httpStatus: 503 }, 'The platform returned an unsuccessful response.'],
  ['invalid-json', () => new Response('private platform body'), { stage: 'response', code: 'invalid-json' }, 'The platform response could not be read.'],
  ['unsafe-verification', () => Response.json({ device_code: privateDevice, user_code: 'BOT-CODE', verification_uri_complete: 'https://unrelated.example.invalid/confirm', interval: 1 }), { stage: 'challenge', code: 'unsafe-verification' }, 'The confirmation link could not be accepted for this setup.']
] as const)('shows the original %s diagnosis with one main action and no unsafe replay', async (_name, reply, diagnostic, message) => {
  beginReply = reply
  await mount(); const operation = await pending()
  expect(operation).toMatchObject({ authorization: 'unknown', challenge: null, diagnostic })
  const pane = dom.container.querySelector<HTMLElement>('[data-bot-enrollment]')!
  expect(pane.querySelector('h3')?.textContent).toBe('We couldn’t get a setup link')
  expect(pane.querySelector('[data-enrollment-diagnosis]')?.textContent).toBe(message)
  expect(pane.querySelectorAll('.primary-button')).toHaveLength(1)
  expect(pane.querySelector('[data-enrollment-advance]')?.textContent).toBe('Check this creation')
  const details = pane.querySelector<HTMLDetailsElement>('.connector-diagnostics')!
  expect(details.open).toBe(false)
  expect(pane.querySelector('[data-enrollment-inspect]')?.closest('details')).toBe(details)
  expect(pane.querySelector('[data-enrollment-existing]')?.classList.contains('primary-button')).toBe(false)
  await inspectOriginal()
  expect(details.textContent).toContain(diagnostic.stage); expect(details.textContent).toContain(diagnostic.code)
  await click('[data-enrollment-advance]')
  await vi.waitFor(() => expect(pane.querySelector<HTMLButtonElement>('[data-enrollment-advance]')?.disabled).toBe(false))
  expect((await services.connections.enrollment!.inspect({ operationId: operation.operationId })).operation).toEqual(operation)
  expect(platformCalls).toEqual(['begin'])
  expect(JSON.stringify(calls)).not.toContain(privateDevice); expect(JSON.stringify(calls)).not.toContain('private platform body')
  expect(pane.textContent).not.toContain(privateDevice); expect(pane.textContent).not.toContain('private platform body')
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

it('an unchanged unknown registration explains each check and keeps the existing-bot route on the original page', async () => {
  loseBegin = true
  await mount(); const operation = await pending()
  expect(operation.authorization).toBe('unknown')
  expect(dom.container.querySelector('[data-enrollment-code] svg')).toBeNull()
  expect(dom.container.querySelector('[data-enrollment-advance]')?.textContent).toBe('Check this creation')
  await inspectOriginal()
  await vi.waitFor(() => expect(dom.container.querySelector('[data-bot-enrollment] [role="status"]')?.textContent).toContain('Still no setup link'))
  await click('[data-enrollment-advance]')
  await vi.waitFor(() => expect(dom.container.querySelector('[data-enrollment-advance]')?.hasAttribute('disabled')).toBe(false))
  expect(dom.container.querySelector('[data-bot-enrollment] [role="status"]')?.textContent).toContain('cannot confirm whether the bot was created')
  expect((await services.connections.enrollment!.inspect({ operationId: operation.operationId })).operation).toEqual(operation)
  expect(platformCalls).toEqual(['begin'])
  expect((await services.connections.enrollment!.list({})).operations.map(value => value.operationId)).toEqual([operation.operationId])
  expect(dom.container.querySelector('[data-enrollment-operation]')?.getAttribute('data-enrollment-operation')).toBe(operation.operationId)
  await click('[data-bot-enrollment] [data-enrollment-existing]')
  expect(dom.container.querySelector('[aria-label="Connection app ID"]')).not.toBeNull()
  expect((await services.connections.enrollment!.inspect({ operationId: operation.operationId })).operation).toEqual(operation)
  expect(platformCalls).toEqual(['begin'])
})

it('explains an early confirmation check without polling before the original platform interval', async () => {
  await mount(); const operation = await pending()
  await click('[data-enrollment-advance]')
  await vi.waitFor(() => expect(dom.container.querySelector('[data-bot-enrollment] [role="status"]')?.textContent).toContain('Give it a moment, then check again'))
  expect((await services.connections.enrollment!.inspect({ operationId: operation.operationId })).operation).toEqual(operation)
  expect(platformCalls).toEqual(['begin'])
})

it('opens a separate setup directly from the original unknown result without creating a second bot', async () => {
  loseBegin = true
  await mount(); const operation = await pending()
  await click('[data-enrollment-separate] > summary')
  expect(dom.container.querySelector('[data-enrollment-separate]')?.textContent).toContain('may create another bot')
  await click('[data-enrollment-start-another]')
  expect(dom.container.querySelector('[data-enrollment-create]')).not.toBeNull()
  expect(dom.container.querySelector('[data-enrollment-operation]')).toBeNull()
  expect(platformCalls).toEqual(['begin'])
  expect((await services.connections.enrollment!.list({})).operations).toEqual([operation])
  await click('.connector-enrollment__history > summary')
  await click('[data-enrollment-select="' + operation.operationId + '"]')
  expect(dom.container.querySelector('[data-enrollment-operation]')?.getAttribute('data-enrollment-operation')).toBe(operation.operationId)
  expect(platformCalls).toEqual(['begin'])
})

it('keeps a late unchanged check attached to its original setup after the user opens a separate intent', async () => {
  loseBegin = true
  await mount(); const operation = await pending()
  const forward = vi.mocked(api.connections.call).getMockImplementation()!
  let release!: () => void, checked = false
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.mocked(api.connections.call).mockImplementation(async <M extends ConnectionMethod>(method: M, input: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
    const result = await forward(method, input)
    if (method === 'connection.enrollment.advance') { checked = true; await gate }
    return result
  })
  try {
    await click('[data-enrollment-advance]'); await vi.waitFor(() => expect(checked).toBe(true))
    await click('[data-enrollment-separate] > summary'); await click('[data-enrollment-start-another]')
    expect(dom.container.querySelector('[data-enrollment-create]')).not.toBeNull()
    await act(async () => { release(); await gate })
    expect(dom.container.querySelector('[data-enrollment-operation]')).toBeNull()
    expect(dom.container.querySelector('[data-enrollment-create]')).not.toBeNull()
    expect(dom.container.querySelector('[data-bot-enrollment] [role="status"]')).toBeNull()
    expect((await services.connections.enrollment!.inspect({ operationId: operation.operationId })).operation).toEqual(operation)
    expect(platformCalls).toEqual(['begin'])
  } finally { release() }
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
  await inspectOriginal()
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[data-enrollment-code] svg')).not.toBeNull() })
  expect(platformCalls).toEqual(['begin'])
  expect((await services.connections.enrollment!.list({})).operations.map(value => value.operationId)).toEqual([original.operationId])
})

it('a delayed result for one original setup keeps another setup inspectable through the actual Settings consumer', async () => {
  const a = await api.connections.call('connection.enrollment.begin', { operationId: 'setup-a', connectionId: 'application-a', adapterId: 'feishu', domain: 'open.feishu.cn', label: 'Bot A' })
  const b = await api.connections.call('connection.enrollment.begin', { operationId: 'setup-b', connectionId: 'application-b', adapterId: 'feishu', domain: 'open.feishu.cn', label: 'Bot B' })
  await mount(); await click('.connector-enrollment__history > summary'); await click('[data-enrollment-select="' + a.operationId + '"]')
  const actualCall = vi.mocked(api.connections.call).getMockImplementation()! as typeof api.connections.call
  let release!: () => void, held = false
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.mocked(api.connections.call).mockImplementation(async <M extends ConnectionMethod>(method: M, input: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
    const result = await actualCall(method, input)
    if (method === 'connection.enrollment.inspect' && (input as { operationId: string }).operationId === a.operationId) { held = true; await gate; throw new Error('Only the earlier setup lookup lost its reply') }
    return result
  })
  try {
    await click('.connector-enrollment > .connector-diagnostics > summary'); await click('[data-enrollment-inspect]')
    await vi.waitFor(() => expect(held).toBe(true))
    await click('.connector-enrollment > .connector-back'); await click('.connector-enrollment__history > summary'); await click('[data-enrollment-select="' + b.operationId + '"]')
    await click('.connector-enrollment > .connector-diagnostics > summary')
    expect((await actualCall('connection.enrollment.inspect', { operationId: b.operationId })).operation?.operationId).toBe(b.operationId)
    const button = dom.container.querySelector<HTMLButtonElement>('[data-enrollment-inspect]')!
    expect(button.disabled, 'An earlier result wait must not disable another original setup').toBe(false)
    await click('[data-enrollment-inspect]')
    await vi.waitFor(() => expect(calls.filter(call => call.method === 'connection.enrollment.inspect' && (call.input as { operationId: string }).operationId === b.operationId)).toHaveLength(2))
    await act(async () => { release(); await gate })
    expect(dom.container.querySelector('[data-enrollment-operation]')?.getAttribute('data-enrollment-operation')).toBe(b.operationId)
    expect(dom.container.textContent).not.toContain('Only the earlier setup lookup lost its reply')
    expect(platformCalls).toEqual(['begin', 'begin'])
  } finally { release() }
})

it('a pending platform effect keeps other setup actions and the original local lookup available', async () => {
  const a = await api.connections.call('connection.enrollment.begin', { operationId: 'effect-a', connectionId: 'effect-application-a', adapterId: 'feishu', domain: 'open.feishu.cn', label: 'Pending bot A' })
  const b = await api.connections.call('connection.enrollment.begin', { operationId: 'effect-b', connectionId: 'effect-application-b', adapterId: 'feishu', domain: 'open.feishu.cn', label: 'Ready bot B' })
  const originalFetch = globalThis.fetch
  let release!: () => void, held = false
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
    if (new URLSearchParams(String(args[1]?.body)).get('action') === 'poll' && !held) { held = true; await gate }
    return await originalFetch(...args)
  })
  await mount(); await click('.connector-enrollment__history > summary'); await click('[data-enrollment-select="' + a.operationId + '"]')
  clock = Math.max(a.challenge!.nextPollAt, b.challenge!.nextPollAt) + 1
  try {
    await click('[data-enrollment-advance]'); await vi.waitFor(() => expect(held).toBe(true))
    await click('.connector-enrollment > .connector-diagnostics > summary')
    expect(dom.container.querySelector<HTMLButtonElement>('[data-enrollment-inspect]')!.disabled, 'Read-only recovery must remain available during the original platform effect').toBe(false)
    await click('[data-enrollment-inspect]')
    await vi.waitFor(() => expect(calls.some(call => call.method === 'connection.enrollment.inspect' && (call.input as { operationId: string }).operationId === a.operationId)).toBe(true))
    await click('.connector-enrollment > .connector-back'); await click('.connector-enrollment__history > summary'); await click('[data-enrollment-select="' + b.operationId + '"]')
    expect(dom.container.querySelector<HTMLButtonElement>('[data-enrollment-advance]')!.disabled, 'Another setup must not inherit the first setup’s pending write').toBe(false)
    await click('[data-enrollment-advance]')
    await vi.waitFor(() => expect(calls.some(call => call.method === 'connection.enrollment.advance' && (call.input as { operationId: string }).operationId === b.operationId)).toBe(true))
    expect((await services.connections.enrollment!.inspect({ operationId: b.operationId })).operation?.revision).toBeGreaterThan(b.revision)
    expect(platformCalls).toEqual(['begin', 'begin', 'poll'])
    await act(async () => { release(); await gate })
    await vi.waitFor(() => expect(calls.some(call => call.method === 'connection.enrollment.advance' && (call.input as { operationId: string }).operationId === a.operationId)).toBe(true))
    expect(dom.container.querySelector('[data-enrollment-operation]')?.getAttribute('data-enrollment-operation')).toBe(b.operationId)
    expect(platformCalls).toEqual(['begin', 'begin', 'poll', 'poll'])
  } finally {
    release()
    await vi.waitFor(() => expect(calls.some(call => call.method === 'connection.enrollment.advance' && (call.input as { operationId: string }).operationId === a.operationId)).toBe(true))
  }
})


it('explicit independent creation retains both lost original requests while the setup list is unavailable', async () => {
  await mount()
  const actualCall = vi.mocked(api.connections.call).getMockImplementation()! as typeof api.connections.call
  const admitted: Array<{ operationId: string; connectionId: string }> = []
  let unavailable = false
  vi.mocked(api.connections.call).mockImplementation(async <M extends ConnectionMethod>(method: M, input: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
    if (method === 'connection.enrollment.ls' && unavailable) throw new Error('Only the setup list is temporarily unavailable')
    const result = await actualCall(method, input)
    if (method === 'connection.enrollment.begin') { admitted.push(input as { operationId: string; connectionId: string }); throw new Error('Only this Renderer creation reply was lost') }
    return result
  })
  await click('[data-enrollment-create]'); await vi.waitFor(() => expect(admitted).toHaveLength(1))
  unavailable = true
  await click('.connector-enrollment > .connector-back')
  expect(dom.container.querySelector('[data-enrollment-resume]')).not.toBeNull()
  await click('[data-enrollment-separate] > summary'); await click('[data-enrollment-start-another]')
  expect(admitted).toHaveLength(1)
  await click('[data-enrollment-create]'); await vi.waitFor(() => expect(admitted).toHaveLength(2))
  expect(admitted[0].operationId).not.toBe(admitted[1].operationId); expect(admitted[0].connectionId).not.toBe(admitted[1].connectionId)
  await click('.connector-enrollment > .connector-back'); await click('.connector-enrollment__history > summary')
  for (const target of admitted) expect(dom.container.querySelector('[data-enrollment-select="' + target.operationId + '"]'), 'Every lost original request must remain reachable').not.toBeNull()
  for (const target of admitted) {
    await click('[data-enrollment-select="' + target.operationId + '"]'); await inspectOriginal()
    await vi.waitFor(() => expect(dom.container.querySelector('[data-enrollment-code] svg')).not.toBeNull())
    expect(dom.container.querySelector('[data-enrollment-operation]')?.getAttribute('data-enrollment-operation')).toBe(target.operationId)
    expect((await services.connections.enrollment!.inspect({ operationId: target.operationId })).operation?.connectionId).toBe(target.connectionId)
    await click('.connector-enrollment > .connector-back'); await click('.connector-enrollment__history > summary')
  }
  expect(platformCalls).toEqual(['begin', 'begin'])
  expect((await services.connections.enrollment!.list({})).operations).toHaveLength(2)
})

it('a pending begin does not block an explicitly independent fresh intent through the real Host', async () => {
  await mount()
  const originalFetch = globalThis.fetch
  let release!: () => void, held = false
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
    if (new URLSearchParams(String(args[1]?.body)).get('action') === 'begin' && !held) { held = true; await gate }
    return await originalFetch(...args)
  })
  try {
    await click('[data-enrollment-create]'); await vi.waitFor(() => expect(held).toBe(true))
    const a = (await services.connections.enrollment!.list({})).operations[0]!
    await click('.connector-enrollment > .connector-back'); await click('[data-enrollment-separate] > summary'); await click('[data-enrollment-start-another]')
    const create = dom.container.querySelector<HTMLButtonElement>('[data-enrollment-create]')!
    expect(create.disabled, 'Another creation intent must not inherit the first begin wait').toBe(false)
    await act(async () => { create.click(); create.click() })
    await vi.waitFor(() => expect(calls.filter(call => call.method === 'connection.enrollment.begin'), 'The independent begin must reach the actual owner exactly once').toHaveLength(1))
    const b = (await services.connections.enrollment!.list({})).operations.find(item => item.operationId !== a.operationId)!
    expect(b?.authorization).toBe('pending')
    expect(dom.container.querySelector('[data-enrollment-operation]')?.getAttribute('data-enrollment-operation')).toBe(b.operationId)
    await act(async () => { release(); await gate })
    await vi.waitFor(() => expect(calls.filter(call => call.method === 'connection.enrollment.begin')).toHaveLength(2))
    expect(dom.container.querySelector('[data-enrollment-operation]')?.getAttribute('data-enrollment-operation')).toBe(b.operationId)
    expect(platformCalls).toEqual(['begin', 'begin'])
  } finally {
    release()
    await vi.waitFor(() => expect(calls.filter(call => call.method === 'connection.enrollment.begin')).toHaveLength(2))
  }
})
