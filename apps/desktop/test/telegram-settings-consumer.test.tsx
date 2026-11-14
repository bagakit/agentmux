// @vitest-environment happy-dom
import { act } from 'react'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, AgentMuxHostedRuntimeService, connectAgentMuxRpc } from '@agentmux/core'
import { createCredentialAdministration } from '../../host/src/credential-administration.js'
import { createConnectionServices } from '../../../packages/connectors/src/connection-services.js'
import { registerConnectorIpc } from '../src/main/connector-ipc.js'
import { unwrapSessionInputOperationResult } from '../src/shared/session-input-result.js'
import { telegramSettingsModule } from '../src/renderer/src/components/settings/modules/telegram.js'
import { settingsCatalog, settingsNavGroups } from '../src/renderer/src/components/settings/settings-modules.js'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture.js'
import { useAppStore } from '../src/renderer/src/store'
import { ingressFixture } from '../../../packages/connectors/test/fixtures/ingress.js'
import { TelegramAdapter } from '../../../packages/connectors/src/adapters/telegram/index.js'
import { telegramTransport } from '../../../packages/connectors/test/fixtures/telegram.js'
import { context } from '../../../packages/connectors/test/fixtures/room-binding.js'
import { feishuConfig } from '../../../packages/connectors/test/fixtures/feishu.js'

const dom = composerDOM(), cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { await dom.render(null); for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function fixture() {
  const original = await ingressFixture(true); cleanup.push(original.close)
  const wire = await telegramTransport(); cleanup.push(wire.close); wire.pausePolls()
  const browser = window as unknown as { happyDOM: { settings: { fetch: { disableSameOriginPolicy: boolean } } } }
  const cors = browser.happyDOM.settings.fetch.disableSameOriginPolicy
  browser.happyDOM.settings.fetch.disableSameOriginPolicy = true
  cleanup.push(() => { browser.happyDOM.settings.fetch.disableSameOriginPolicy = cors })
  const adapter = new TelegramAdapter({ fetch: async (url, init) => {
    const native = new URL(String(url))
    if (native.origin !== 'https://api.telegram.org') throw Error('Unexpected Telegram native origin')
    return await fetch(wire.origin + native.pathname + native.search, init)
  } })
  const services = await createConnectionServices({ directory: join(original.root, 'telegram-settings'), adapters: [adapter],
    bindings: { spatial: original.spatial, checkpoint: ref => original.client.conversationCheckpoint(ref) }, ingress: { core: hostId => hostId === 'local' ? original.client : undefined } })
  cleanup.push(() => services.close())
  const hostingTarget = { hostId: 'local', runtimeId: 'telegram-settings-runtime' }
  const identity = { runtimeId: hostingTarget.runtimeId, ownerInstanceId: 'telegram-settings-owner', protocolVersion: 2, processId: process.pid, availability: 'connected' as const, ctxmux: original.client.runtimeIdentity() }
  const hosted = new AgentMuxHostedRuntimeService(original.client, original.store.path, () => identity)
  cleanup.push(() => hosted.dispose())
  services.connections.credential = createCredentialAdministration({ target: identity, secrets: services.secrets })
  const server = new AgentMuxControlServer({ socketPath: join(original.root, 'telegram-ui.sock'), connections: services.connections, coreClients: original.coreClients, hostedRuntime: () => hosted })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, runtimeFence: { runtimeId: identity.runtimeId, ownerInstanceId: identity.ownerInstanceId } })
  cleanup.push(() => rpc.dispose())
  const handlers = new Map<string, (...args: any[]) => Promise<any>>()
  const runtime: import('../src/main/connection-host-ipc').ConnectionHostIpc = {
    connectionHostingTarget: async () => structuredClone(hostingTarget),
    callConnectionHost: (target, method, params) => { expect(target).toEqual(hostingTarget); return rpc.call(method, params) },
    watchConnectionMetadata: (target, callbacks) => { expect(target).toEqual(hostingTarget); return rpc.subscribe('connection.metadata.watch', {}, callbacks) }
  }
  const registration = registerConnectorIpc({ handleWithEvent: (channel, handler) => { handlers.set(channel, handler) }, runtime, metadata: { publish() {}, observation() {} } })
  cleanup.push(() => registration.dispose())
  vi.spyOn(api.connections, 'hostingTarget').mockImplementation(hostId => runtime.connectionHostingTarget(hostId))
  const calls: Array<{ method: string; params: unknown; target: unknown }> = []
  vi.spyOn(api.connections, 'call').mockImplementation(async (method, params, target) => { calls.push({ method, params: structuredClone(params), target: structuredClone(target) }); return unwrapSessionInputOperationResult(await handlers.get('connections:call')!({}, method, params, target)) })
  const store = vi.spyOn(api.connections, 'storeCredential').mockImplementation((input, target) => handlers.get('connections:storeCredential')!({}, input, target))
  vi.spyOn(api.connections, 'inspectCredential').mockImplementation((operationId, target) => handlers.get('connections:inspectCredential')!({}, operationId, target))
  const external = vi.spyOn(api.ui, 'openExternal').mockResolvedValue(undefined)
  const config = composerConfig
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  window.localStorage.clear(); await useAppStore.persist.rehydrate()
  const stopStartup = await useAppStore.getState().initialize(); stopStartup()
  return { ...original, services, wire, calls, store, external, config, hostingTarget, rejectCheck: () => wire.changeBot(999) }
}
async function fill(label: string, text: string) {
  const input = dom.container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
  expect(input).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function mount(f: Awaited<ReturnType<typeof fixture>>) {
  const Pane = telegramSettingsModule.Pane
  await dom.render(<Pane active config={f.config} onClose={() => {}} onNavigate={() => {}} />)
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[data-enrollment-existing]')).not.toBeNull() })
}

it('the real Telegram settings contribution configures the native bot through secure IPC and the same Hosted RPC owner', async () => {
  const f = await fixture()
  expect(settingsNavGroups('').find(group => group.id === 'conversation-channels')!.items.map(item => item.id)).toContain('telegram')
  expect(settingsCatalog.searchResults('telegram').map(result => result.module.id)).toContain('telegram')
  await mount(f); await dom.click('[data-enrollment-existing]')
  expect(dom.container.textContent).toContain('Bot user ID'); expect(dom.container.textContent).not.toContain('Credentials & Basic Info')
  await fill('Connection app ID', '100'); await fill('Connection app secret', '100:private-telegram-token')
  await dom.click('[data-connection-save]')
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.textContent).toContain('Application saved.') }, { timeout: 5_000 })
  const record = (await f.services.connections.list()).connections[0]!
  expect(record.config).toMatchObject({ adapterId: 'telegram', application: { domain: 'telegram.org', appId: '100' } })
  expect(record.config.credentialRef).not.toBe('100:private-telegram-token')
  expect(f.store).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ secret: '100:private-telegram-token' }), f.hostingTarget)
  expect(f.calls.find(call => call.method === 'connection.configure')?.target).toEqual(f.hostingTarget)
  expect(JSON.stringify(f.calls)).not.toContain('100:private-telegram-token')
  expect(dom.container.querySelector('input[type=password]')).toBeNull()
  expect(dom.container.querySelector('[data-identity-sync]')?.textContent).not.toContain('Connected')
  f.wire.resumePolls()
  await vi.waitFor(async () => expect((await f.services.connections.inspect({ connectionId: record.config.connectionId })).connection!.observation.transport.state).toBe('ready'), { timeout: 5_000 })
  await dom.click('[data-connection-check]')
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[data-connection-stage=authentication]')?.getAttribute('data-state')).toBe('ready') }, { timeout: 5_000 })
  expect(f.wire.calls.some(call => call.method === 'getMe')).toBe(true)
  expect(dom.container.querySelector('[data-identity-sync]')?.textContent).toBe(dom.container.querySelector('[data-connection-setup-result] .connector-connection-state strong')?.textContent)
  expect(await f.services.bindings!.bind({ ...f.input, connectionId: record.config.connectionId, externalConversationId: '-300', scope: { ...f.input.scope, input: 'all-messages' } }, context)).toMatchObject({ state: 'applied' })
  expect(await f.services.bindings!.grant({ ...f.grant, actor: { application: record.config.application, idType: 'user_id', userId: '400' } }, context)).toMatchObject({ state: 'applied' })
  f.wire.message('Native Telegram input after real UI setup')
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce(), { timeout: 5_000 })
  await act(async () => { dom.container.querySelector<HTMLDetailsElement>('[data-channel-setup=telegram]')!.open = true })
  expect(dom.container.textContent).toContain('Group Privacy'); expect(dom.container.textContent).toContain('lost send receipt remains unknown')
  expect(dom.container.textContent).not.toContain('Message Content Intent')
  await dom.click('[data-management-console]'); expect(f.external).toHaveBeenCalledWith('https://t.me/BotFather')
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)

it('Telegram library isolates its exact native adapter from Feishu and preserves the saved credential when renaming', async () => {
  const f = await fixture(), saved = await f.services.secrets.store({ operationId: 'telegram-ui-secret', secret: '100:private-existing-token' })
  await f.services.connections.configure({ operationId: 'telegram-ui-seed', expectedRevision: null, connection: { connectionId: 'exact-telegram', adapterId: 'telegram', application: { domain: 'telegram.org', appId: '100' }, label: 'Telegram team', enabled: false, credentialRef: saved.credentialRef } })
  await f.services.connections.configure({ operationId: 'feishu-ui-seed', expectedRevision: null, connection: { ...feishuConfig, enabled: false, credentialRef: saved.credentialRef } })
  await mount(f)
  expect(dom.container.querySelectorAll('[data-connection]')).toHaveLength(1); expect(dom.container.textContent).not.toContain(feishuConfig.label)
  await dom.click('[data-connection="exact-telegram"] button')
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[data-connection-check]')).not.toBeNull() }, { timeout: 5_000 })
  await dom.click('[data-connection-editor] .connector-editor-actions .small-button')
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Connection app secret"]')!.value).toBe('')
  await fill('Connection name', 'Renamed Telegram team'); await dom.click('[data-connection-save]')
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.textContent).toContain('Application saved.') }, { timeout: 5_000 })
  expect((await f.services.connections.inspect({ connectionId: 'exact-telegram' })).connection!.config).toMatchObject({ label: 'Renamed Telegram team', credentialRef: saved.credentialRef, adapterId: 'telegram', application: { domain: 'telegram.org', appId: '100' } })
  expect(f.store).not.toHaveBeenCalled(); expect(f.wire.calls).toHaveLength(0)
})
