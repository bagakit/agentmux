// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { AgentConnectorDialog } from '../src/renderer/src/components/AgentConnectorDialog'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { settingsCatalog } from '../src/renderer/src/components/settings/settings-modules'
import { composerSession } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'

const f = connectorJourneyFixture({ additionalAdapters: () => [{ adapterId: 'discord', test: async () => ({ authentication: { state: 'unknown', reason: 'not-tested' }, transport: { state: 'unknown', reason: 'not-started' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } }) }] })
const wait = async (check: () => void) => vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 6000 })
it('the exact reply-only Binding stays partial until explicit original save, with App and every channel visible at confirmation', async () => {
  const original = await f.forward('connection.bind', f.original.input)
  expect(original.state).toBe('applied'); if (original.state !== 'applied') throw Error('Original binding not saved')
  const actor = { application: original.binding.application, idType: 'account_id', userId: 'original-member' }
  await f.forward('connection.grant', { operationId: 'keep-original-access', bindingId: original.binding.bindingId, expectedBindingRevision: 1,
    grantId: 'saved-member', expectedRevision: null, actor, state: 'active', capabilities: ['input'] })
  const secret = await f.services.secrets.store({ operationId: 'second-platform-secret', secret: 'synthetic-discord-secret' })
  await f.forward('connection.configure', { operationId: 'second-platform', expectedRevision: null, connection: { connectionId: 'discord-bot', adapterId: 'discord', application: { domain: 'discord.com', appId: '100' }, label: 'Other Discord audience', enabled: true, credentialRef: secret.credentialRef } })
  const second = await f.forward('connection.bind', { ...f.original.input, operationId: 'second-audience', bindingId: 'discord-audience', connectionId: 'discord-bot', externalConversationId: '300', scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } })
  expect(second.state).toBe('applied')
  const before = (await f.forward('connection.binding.inspect', { bindingId: original.binding.bindingId })).grants
  const target = { executionHostId: 'local', agentSessionId: original.binding.agentSessionId, regionAnchor: { regionId: 'original-region' } }
  await f.dom.render(<SettingsNavigation.Provider value={{ open() {}, openToolkit() {}, openHost() {}, openChannel() {}, openMoteLark() {}, chooseAgent() {}, channelEntries: settingsCatalog.channelEntries, channelPresentation: settingsCatalog.channelPresentation }}>
    <AgentConnectorDialog mode="details" original={{ channel: 'sample', target, hostingTarget: f.hostingTarget, session: { ...composerSession(original.binding.agentSessionId, 'claude'), nativeHandle: f.original.session.nativeHandle! }, name: 'Original Agent', connectionId: original.binding.connectionId, bindingId: original.binding.bindingId }} onClose={() => {}} returnFocus={() => null} />
  </SettingsNavigation.Provider>)
  await wait(() => expect(document.querySelector('[data-partial-sharing]')?.textContent).toContain('App and group user messages are not shared'))
  const current = () => f.services.bindings!.readCurrent(original.binding.bindingId)!
  expect(current().scope.publication).toBe('future-native-user-facing')
  const writes = () => f.calls.filter(call => call.method === 'connection.binding.relink').length
  expect(writes()).toBe(0)
  await f.button('Review whole conversation')
  const audiences = document.querySelector('[aria-label="Groups sharing this conversation"]')!
  expect(audiences.textContent).toContain('App · this Agent’s conversation')
  expect(audiences.textContent).toContain('original-group')
  expect(audiences.textContent).toContain('Other Discord audience')
  expect(audiences.textContent).toContain('300')
  expect(audiences.textContent).toContain('Their members’ messages can be seen in App and the other groups')
  expect(current().scope.publication).toBe('future-native-user-facing'); expect(writes()).toBe(0)
  const confirm = document.querySelector<HTMLInputElement>('.agent-connector-check input')!
  expect(confirm.checked).toBe(false)
  await act(async () => confirm.click()); await f.button('Save sharing')
  await wait(() => expect(current().revision).toBe(2))
  expect(current()).toMatchObject({ bindingId: original.binding.bindingId, scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } })
  expect(writes()).toBe(1)
  const saved = (await f.forward('connection.binding.inspect', { bindingId: original.binding.bindingId })).grants
  expect(saved.map(grant => [grant.grantId, grant.actor, grant.capabilities, grant.state])).toEqual(before.map(grant => [grant.grantId, grant.actor, grant.capabilities, grant.state]))
  expect(f.services.bindings!.readCurrent('discord-audience')!.revision).toBe(1)
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
  expect(f.calls.find(call => call.method === 'connection.binding.relink')?.input).toMatchObject({ expectedRevision: 1, bindingId: original.binding.bindingId, externalConversationId: 'original-group' })
}, 25_000)
