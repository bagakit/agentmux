// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
vi.mock('../src/renderer/src/lib/reading-diagnostic-publication', () => ({ publishReadingDiagnostic: () => {} }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { FeishuAdapter } from '../../../packages/connectors/src/adapters/feishu/index'
import { DiscordAdapter } from '../../../packages/connectors/src/adapters/discord/index'
import { discordConfig, discordTransport } from '../../../packages/connectors/test/fixtures/discord'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { connectorRoomDraftKey, invalidateConnectorTarget, restoredConnectorRoomDrafts } from '../src/renderer/src/lib/connector-room-intent'
import { settingsCatalog } from '../src/renderer/src/components/settings/settings-modules'

let wire: Awaited<ReturnType<typeof discordTransport>>
beforeEach(async () => { wire = await discordTransport(); (window as any).happyDOM.settings.fetch.disableSameOriginPolicy = true })
const f = connectorJourneyFixture({ adapter: () => new FeishuAdapter(), platform: async request => {
  if (request.url?.endsWith('/members')) return { code: 0, data: { items: [], has_more: false } }
  return { code: 0, data: { name: 'Original Lark group', chat_status: 'normal', chat_mode: 'group' } }
}, additionalAdapters: () => [new DiscordAdapter({ http: wire.http })] })
afterEach(async () => { await wire.close(); (window as any).happyDOM.settings.fetch.disableSameOriginPolicy = false })
const target = { executionHostId: 'local', agentSessionId: 'original-agent' }
const entry = (channel: string) => document.querySelector<HTMLButtonElement>(`[data-workbench-region-id="original-region"] [data-channel-entry="${channel}"]`)!
const pane = () => document.querySelector<HTMLElement>('[role="dialog"]')!
const effects = () => f.calls.filter(call => /configure|\.bind$|\.relink$|\.pause$|\.grant$|\.create$|\.retry$/.test(call.method))
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 7000 }) }
async function menu(channel: string) { await act(async () => { entry(channel).focus(); entry(channel).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) }); await wait(() => expect(document.querySelector('.connector-header-menu')).not.toBeNull()) }
async function action(label: string) { const button = [...document.querySelectorAll<HTMLElement>('.connector-header-menu [role="menuitem"]')].find(node => node.textContent?.trim() === label)!; expect(button, label).toBeDefined(); await act(async () => button.click()) }
async function open(channel: string) { await menu(channel); await action(document.querySelector('.connector-header-menu')?.textContent?.includes('Check bot hosting') ? 'Check bot hosting' : document.querySelector('.connector-header-menu')?.textContent?.includes('Open channel setup') ? 'Open channel setup' : 'Connect a group'); await wait(() => expect(pane()).not.toBeNull()) }
async function close() { await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close group setup"]')!.click()); await wait(() => expect(pane()).toBeNull()) }
async function ready(channel: string, id: string) { await open(channel); await wait(() => expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value).toBe(id)) }
async function configureDiscord() {
  const secret = await f.services.secrets.store({ operationId: 'compact-discord-secret', secret: 'synthetic-discord-token' })
  await f.services.connections.configure({ operationId: 'compact-discord-config', expectedRevision: null, connection: { ...discordConfig, label: f.config.label, credentialRef: secret.credentialRef } })
}

it('both compiled channel entries stay compact and available when exact empty relationships and global Off are confirmed', async () => {
  const service = await f.services.connections.service!.get()
  await f.services.connections.service!.configure({ operationId: 'compact-explicit-off', expectedRevision: service.revision, service: { enabled: false } })
  await f.mount(); await wait(() => expect(entry('feishu')?.dataset.channelState).toBe('unbound'))
  expect(settingsCatalog.channelEntries.map(value => value.adapterId)).toEqual(['feishu', 'discord'])
  for (const channel of ['feishu', 'discord']) {
    expect(entry(channel).textContent).toBe(''); expect(entry(channel).dataset.channelState).toBe('unbound')
    expect(entry(channel).getAttribute('aria-label')).toContain('No group linked'); expect(entry(channel).disabled).toBe(false)
  }
  await ready('feishu', f.config.connectionId)
  expect(pane().textContent).toContain('Lark'); expect(pane().querySelector('[data-connector-service]')).not.toBeNull()
  expect(effects()).toHaveLength(0); expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
}, 25_000)

it('failed owner discovery still opens the original panel with Check and Settings recovery and never writes another owner', async () => {
  vi.mocked(api.connections.hostingTarget).mockRejectedValue(Error('A bounded long original hosting failure '.repeat(40)))
  await f.mount(); await wait(() => expect(entry('discord')?.dataset.channelState).toBe('unknown'))
  expect(document.querySelector('.agent-connections__error')).toBeNull()
  await menu('discord'); expect(document.querySelector('.connector-header-menu')?.textContent).toContain('Check bot hosting')
  await action('Channel settings'); expect(f.settings).toHaveBeenCalledWith('discord')
  await open('discord')
  await wait(() => expect(pane().textContent).toContain('Bot hosting could not be confirmed'))
  expect(pane().textContent).toContain('Discord connections'); expect(pane().textContent).toContain('Check bot hosting'); expect(pane().textContent).toContain('Channel settings')
  expect(entry('discord').textContent).toBe(''); expect(entry('discord').title.length).toBeLessThan(100)
  expect(effects()).toHaveLength(0)
  vi.mocked(api.connections.hostingTarget).mockResolvedValue(f.hostingTarget)
  await f.button('Check bot hosting'); await wait(() => expect(pane().querySelector('[aria-label="Group application"]')).not.toBeNull())
  expect(f.calls.every(call => !/configure|\.bind$|\.create$/.test(call.method))).toBe(true)
}, 25_000)

it('Lark and Discord keep both nonempty channel drafts and a prior unknown request without a second dispatch', async () => {
  await configureDiscord(); await f.mount(); await ready('feishu', f.config.connectionId)
  await f.fill('Existing group ID', 'oc_original_lark_draft')
  const key = (channel: string) => connectorRoomDraftKey(target, f.hostingTarget, channel)
  await wait(() => expect(useAppStore.getState().connectorRoomDrafts[key('feishu')]?.group).toBe('oc_original_lark_draft'))
  const lark = structuredClone(useAppStore.getState().connectorRoomDrafts[key('feishu')])
  const original = { method: 'connection.room.create' as const, target: { ...target, regionAnchor: { regionId: 'original-region' } }, hostingTarget: f.hostingTarget, phase: 'may-have-dispatched' as const,
    input: { ...target, operationId: 'compact-original-unknown', connectionId: f.config.connectionId, expectedConnectionRevision: 1, name: 'Original unknown Lark request', members: [] } }
  await act(async () => useAppStore.setState({ connectorRoomIntents: { [original.input.operationId]: original } }))
  await close(); await ready('discord', discordConfig.connectionId)
  expect(document.querySelector<HTMLInputElement>('[aria-label="Existing group ID"]')?.value).not.toBe('oc_original_lark_draft')
  await f.fill('Existing group ID', '300')
  await wait(() => expect(useAppStore.getState().connectorRoomDrafts[key('discord')]?.group).toBe('300'))
  expect(useAppStore.getState().connectorRoomDrafts[key('feishu')]).toEqual(lark)
  expect(pane().textContent).toContain('compact-original-unknown')
  await close(); await ready('feishu', f.config.connectionId)
  expect(useAppStore.getState().connectorRoomDrafts[key('feishu')]).toEqual(lark)
  expect(useAppStore.getState().connectorRoomDrafts[key('discord')]?.group).toBe('300')
  expect(useAppStore.getState().connectorRoomIntents[original.input.operationId]).toEqual(original)
  expect(effects()).toHaveLength(0)
  expect(restoredConnectorRoomDrafts(useAppStore.getState().connectorRoomDrafts)).toEqual(useAppStore.getState().connectorRoomDrafts)
}, 30_000)

it('an unscoped original draft stays explicit and is not seeded or overwritten by the Discord entry', async () => {
  await configureDiscord(); await f.mount(); await ready('feishu', f.config.connectionId); await f.fill('Existing group ID', 'oc_earlier_draft')
  const key = connectorRoomDraftKey(target, f.hostingTarget)
  await wait(() => expect(useAppStore.getState().connectorRoomDrafts[connectorRoomDraftKey(target, f.hostingTarget, 'feishu')]?.group).toBe('oc_earlier_draft'))
  await act(async () => useAppStore.setState(state => ({ connectorRoomDrafts: { ...state.connectorRoomDrafts, [key]: structuredClone(state.connectorRoomDrafts[connectorRoomDraftKey(target, f.hostingTarget, 'feishu')]!) } })))
  const saved = structuredClone(useAppStore.getState().connectorRoomDrafts[key]); await close(); await ready('discord', discordConfig.connectionId)
  expect(document.querySelector<HTMLInputElement>('[aria-label="Existing group ID"]')?.value).not.toBe(saved.group)
  expect(useAppStore.getState().connectorRoomDrafts[key]).toEqual(saved)
  const continued = [...pane().querySelectorAll<HTMLElement>('button')].find(node => node.textContent === 'Continue earlier draft')!
  expect(continued).toBeDefined(); await act(async () => continued.click())
  await wait(() => expect(document.querySelector<HTMLInputElement>('[aria-label="Existing group ID"]')?.value).toBe('oc_earlier_draft'))
  expect(effects()).toHaveLength(0)
}, 30_000)

it('each bound entry opens its exact group without adopting or overwriting a different original draft', async () => {
  await configureDiscord(); await f.mount(); await ready('feishu', f.config.connectionId); await f.fill('Existing group ID', 'oc_saved_original_lark')
  const key = connectorRoomDraftKey(target, f.hostingTarget)
  await wait(() => expect(useAppStore.getState().connectorRoomDrafts[connectorRoomDraftKey(target, f.hostingTarget, 'feishu')]?.group).toBe('oc_saved_original_lark'))
  await act(async () => useAppStore.setState(state => ({ connectorRoomDrafts: { ...state.connectorRoomDrafts, [key]: structuredClone(state.connectorRoomDrafts[connectorRoomDraftKey(target, f.hostingTarget, 'feishu')]!) } })))
  const saved = structuredClone(useAppStore.getState().connectorRoomDrafts[key]); await close()
  const native = f.session.nativeHandle!
  if (native.kind !== 'provider') throw Error('Expected original provider identity')
  for (const [connectionId, group] of [[f.config.connectionId, 'oc_bound_lark'], [discordConfig.connectionId, '300']]) {
    const result = await f.forward('connection.bind', { ...target, regionAnchor: { regionId: 'original-region' }, operationId: 'compact-bind-' + connectionId, bindingId: 'compact-binding-' + connectionId, connectionId: connectionId!, expectedConnectionRevision: 1, externalConversationId: group!,
      scope: { publication: 'future-native-user-facing', input: 'mentions-and-replies' }, expectedSource: { providerId: native.providerId, nativeSessionId: native.sessionId } })
    expect(result.state, JSON.stringify(result)).toBe('applied')
  }
  await act(async () => invalidateConnectorTarget(target))
  await wait(() => { expect(entry('discord').title).toContain('Original channel'); expect(entry('feishu').title).toContain('Original Lark group') })
  await menu('discord')
  const original = document.querySelector<HTMLElement>('.connector-header-menu__item')!
  expect(original.getAttribute('aria-label')).toContain(discordConfig.connectionId)
  await act(async () => original.click())
  await wait(() => expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value).toBe(discordConfig.connectionId))
  await wait(() => expect(pane().textContent).toContain('Group saved'))
  expect(pane().textContent).toContain('300'); expect(useAppStore.getState().connectorRoomDrafts[key]).toEqual(saved)
  await close()
  const originalInput = { operationId: 'compact-original-binding-only', bindingId: 'compact-binding-' + f.config.connectionId, expectedRevision: 1 }
  await act(async () => useAppStore.setState({ connectorRoomIntents: { [originalInput.operationId]: { method: 'connection.binding.pause', input: originalInput, target, hostingTarget: f.hostingTarget, phase: 'may-have-dispatched' } } }))
  await open('discord'); await f.button('Open original setup')
  await wait(() => expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value).toBe(f.config.connectionId))
  await wait(() => expect(pane().textContent).toContain('Group saved'))
  expect(useAppStore.getState().connectorRoomIntents[originalInput.operationId]?.input).toEqual(originalInput)
  expect(effects().map(call => call.method)).toEqual(['connection.bind', 'connection.bind'])
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
}, 30_000)
