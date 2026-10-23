// @vitest-environment happy-dom
import { act } from 'react'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../../../packages/core/dist/index.js'
import { createConnectionServices } from '../../../packages/connectors/src/connection-services.js'
import { registerConnectorIpc } from '../src/main/connector-ipc.js'
import { unwrapSessionInputOperationResult } from '../src/shared/session-input-result.js'
import { discordSettingsModule } from '../src/renderer/src/components/settings/modules/discord.js'
import { settingsCatalog, settingsNavGroups } from '../src/renderer/src/components/settings/settings-modules.js'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture.js'
import { ingressFixture } from '../../../packages/connectors/test/fixtures/ingress.js'
import { DiscordAdapter } from '../../../packages/connectors/src/adapters/discord/index.js'
import { discordTransport } from '../../../packages/connectors/test/fixtures/discord.js'
import { context } from '../../../packages/connectors/test/fixtures/room-binding.js'
import { feishuConfig } from '../../../packages/connectors/test/fixtures/feishu.js'

const dom = composerDOM(), cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { await dom.render(null); for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function fixture() {
  const original = await ingressFixture(true); cleanup.push(original.close)
  const wire = await discordTransport(); cleanup.push(wire.close)
  vi.stubGlobal('WebSocket', WebSocket)
  const browser = window as unknown as { happyDOM: { settings: { fetch: { disableSameOriginPolicy: boolean } } } }
  const cors = browser.happyDOM.settings.fetch.disableSameOriginPolicy
  browser.happyDOM.settings.fetch.disableSameOriginPolicy = true
  cleanup.push(() => { browser.happyDOM.settings.fetch.disableSameOriginPolicy = cors })
  let rejectCheck = false
  const adapter = new DiscordAdapter({ http: { makeRequest: async (url, init) => rejectCheck && new URL(url).pathname.endsWith('/oauth2/applications/@me')
    ? new Response(JSON.stringify({ message: 'Unauthorized', code: 0 }), { status: 401, headers: { 'content-type': 'application/json' } })
    : wire.http.makeRequest!(url, init) } })
  const services = await createConnectionServices({ directory: join(original.root, 'discord-settings'), adapters: [adapter],
    bindings: { spatial: original.spatial, checkpoint: ref => original.client.conversationCheckpoint(ref) }, ingress: { core: hostId => hostId === 'local' ? original.client : undefined } })
  cleanup.push(() => services.close())
  const server = new AgentMuxControlServer({ socketPath: join(original.root, 'discord-ui.sock'), connections: services.connections, coreClients: original.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  const handlers = new Map<string, (...args: any[]) => Promise<any>>()
  registerConnectorIpc({ handleWithEvent: (channel, handler) => { handlers.set(channel, handler) }, assertTrusted: () => {}, socketPath: server.path, secrets: services.secrets })
  const calls: Array<{ method: string; params: unknown }> = []
  vi.spyOn(api.connections, 'call').mockImplementation(async (method, params) => { calls.push({ method, params: structuredClone(params) }); return unwrapSessionInputOperationResult(await handlers.get('connections:call')!({}, method, params)) })
  const store = vi.spyOn(api.connections, 'storeCredential').mockImplementation(input => handlers.get('connections:storeCredential')!({}, input))
  vi.spyOn(api.connections, 'inspectCredential').mockImplementation(operationId => handlers.get('connections:inspectCredential')!({}, operationId))
  const external = vi.spyOn(api.ui, 'openExternal').mockResolvedValue(undefined)
  const config = await api.config.get()
  return { ...original, services, wire, calls, store, external, config, rejectCheck: () => { rejectCheck = true } }
}
async function fill(label: string, text: string) {
  const input = dom.container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
  expect(input).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function mount(f: Awaited<ReturnType<typeof fixture>>) {
  const Pane = discordSettingsModule.Pane
  await dom.render(<Pane active config={f.config} onClose={() => {}} onNavigate={() => {}} />)
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[data-enrollment-existing]')).not.toBeNull() })
}

it('the real Discord settings contribution stores the token through secure IPC and configures the original native adapter with exact application identity', async () => {
  const f = await fixture()
  const group = settingsNavGroups('').find(group => group.id === 'conversation-channels')!
  expect(group.items.map(item => item.id)).toContain('discord')
  expect(settingsCatalog.searchResults('discord').map(result => result.module.id)).toContain('discord')
  await mount(f); await dom.click('[data-enrollment-existing]')
  expect(dom.container.textContent).toContain('Bot token'); expect(dom.container.textContent).not.toContain('Credentials & Basic Info')
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Connection app secret"]')!.type).toBe('password')
  await fill('Connection app ID', '100'); await fill('Connection app secret', 'private-discord-token')
  await dom.click('[data-connection-save]')
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.textContent).toContain('Application saved.') })
  const record = (await f.services.connections.list()).connections[0]!
  expect(record.config).toMatchObject({ adapterId: 'discord', application: { domain: 'discord.com', appId: '100' } })
  expect(record.config.credentialRef).not.toBe('private-discord-token')
  expect(f.store).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ secret: 'private-discord-token' }))
  expect(JSON.stringify(f.calls)).not.toContain('private-discord-token')
  expect(dom.container.querySelector<HTMLInputElement>('input[type=password]')).toBeNull()
  expect(f.calls.some(call => call.method.startsWith('connection.setup.') || call.method.startsWith('connection.profile.'))).toBe(false)
  await vi.waitFor(() => expect(f.wire.sessions, JSON.stringify(f.wire.calls)).toHaveLength(1))
  const before = f.wire.calls.filter(call => call.path === '/oauth2/applications/@me').length
  await dom.click('[data-connection-check]')
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.textContent).toContain('Connection checked.') })
  expect(f.wire.calls.filter(call => call.path === '/oauth2/applications/@me').length).toBeGreaterThan(before)
  expect(dom.container.textContent).toContain('receiving not yet confirmed')
  f.rejectCheck()
  await dom.click('[data-connection-check]')
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[data-connection-stage=authentication]')?.getAttribute('data-state')).toBe('unavailable') })
  expect(dom.container.querySelector('[data-connection-stage=transport]')?.getAttribute('data-state')).toBe('ready')
  expect(dom.container.textContent).toContain('The credential check needs attention.')
  expect(dom.container.textContent).not.toContain('Reading Mote associations')
  const independent = (await f.services.connections.inspect({ connectionId: record.config.connectionId })).connection!.observation
  expect(independent.transport.state).toBe('ready'); expect(independent.authentication.state).toBe('ready')
  expect(await f.services.bindings!.bind({ ...f.input, connectionId: record.config.connectionId, externalConversationId: '300', scope: { ...f.input.scope, input: 'all-messages' } }, context)).toMatchObject({ state: 'applied' })
  expect(await f.services.bindings!.grant({ ...f.grant, actor: { application: record.config.application, idType: 'snowflake', userId: '400' } }, context)).toMatchObject({ state: 'applied' })
  f.wire.message('888', 'Healthy input after an independent credential check failure')
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  await act(async () => { dom.container.querySelector<HTMLDetailsElement>('[data-discord-setup]')!.open = true })
  expect(dom.container.textContent).toContain('Message Content Intent')
  expect(dom.container.textContent).toContain('Saving credentials does not confirm Gateway connection')
  await dom.click('[data-management-console]'); expect(f.external).toHaveBeenCalledWith('https://discord.com/developers/applications')
  expect(f.inner.kernel.input).toHaveBeenCalledOnce(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)

it('Discord library excludes other platforms and edits its original identity while keeping the saved token private', async () => {
  const f = await fixture(), credential = await f.services.secrets.store({ operationId: 'discord-ui-credential', secret: 'private-original-token' })
  await f.services.connections.configure({ operationId: 'discord-ui-seed', expectedRevision: null, connection: { connectionId: 'exact-discord', adapterId: 'discord', application: { domain: 'discord.com', appId: '100' }, label: 'Saved Discord team', enabled: false, credentialRef: credential.credentialRef } })
  await f.services.connections.configure({ operationId: 'lark-ui-seed', expectedRevision: null, connection: { ...feishuConfig, enabled: false, credentialRef: credential.credentialRef } })
  await mount(f)
  expect(dom.container.querySelectorAll('[data-connection]')).toHaveLength(1)
  expect(dom.container.textContent).not.toContain(feishuConfig.label)
  await dom.click('[data-connection="exact-discord"] button')
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[data-connection-check]')).not.toBeNull() })
  await dom.click('[data-connection-editor] .connector-editor-actions .small-button')
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Connection app secret"]')!.value).toBe('')
  await fill('Connection name', 'Renamed Discord team'); await dom.click('[data-connection-save]')
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.textContent).toContain('Application saved.') })
  const edited = (await f.services.connections.inspect({ connectionId: 'exact-discord' })).connection!
  expect(edited.revision).toBe(2); expect(edited.config).toMatchObject({ connectionId: 'exact-discord', adapterId: 'discord', application: { domain: 'discord.com', appId: '100' }, label: 'Renamed Discord team', enabled: false, credentialRef: credential.credentialRef })
  expect(f.store).not.toHaveBeenCalled(); expect(f.wire.sessions).toHaveLength(0)
  expect(JSON.stringify(f.calls)).not.toContain('private-original-token')
})
