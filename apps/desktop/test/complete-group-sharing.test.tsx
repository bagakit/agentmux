// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { recordedGroupBinding } from '../../../packages/connectors/test/fixtures/recorded-room-binding'
import { AgentConnectorDialog } from '../src/renderer/src/components/AgentConnectorDialog'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { settingsCatalog } from '../src/renderer/src/components/settings/settings-modules'
import { retainConnectorRoomIntent, useAppStore } from '../src/renderer/src/store'
import type { RoomBinding } from '@agentmux/core/connections'

const f = connectorJourneyFixture()
const wait = async (check: () => void) => vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 6000 })
async function form(binding?: RoomBinding) {
  const target = { executionHostId: 'local', agentSessionId: f.original.session.agentSessionId, regionAnchor: { regionId: 'original-region' } }
  await f.dom.render(<SettingsNavigation.Provider value={{ open() {}, openToolkit() {}, openHost() {}, openChannel() {}, openMoteLark() {}, chooseAgent() {}, channelEntries: settingsCatalog.channelEntries, channelPresentation: settingsCatalog.channelPresentation }}>
    <AgentConnectorDialog mode={binding ? 'details' : 'existing'} original={{ target, hostingTarget: f.hostingTarget, session: f.session,
      name: 'Original Agent', connectionId: f.config.connectionId, ...(binding ? { bindingId: binding.bindingId } : {}) }} onClose={() => {}} returnFocus={() => null} />
  </SettingsNavigation.Provider>)
  await wait(() => expect(f.calls.some(call => call.method === 'connection.ls' && call.result)).toBe(true))
  await wait(() => expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-busy')).toBe('false'))
}
async function recorded() {
  const input = { ...f.original.input, scope: { ...f.original.input.scope, publication: 'future-native-user-facing' as const },
    inputTarget: { kind: 'native-conversation' as const, source: f.original.input.expectedSource } }
  const result = recordedGroupBinding(f.services.database!, input, await f.original.checkpoint({ hostId: input.executionHostId, agentSessionId: input.agentSessionId }), f.config.application, { kind: 'user', id: 'original-owner' })
  expect(result.state).toBe('applied'); if (result.state !== 'applied') throw Error('Original controlled Binding was not retained')
  return { input, binding: result.binding }
}
async function inputScope(value: string) {
  const trigger = document.querySelector<HTMLElement>('[aria-label="Group input scope"]')!
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  await act(async () => document.querySelector<HTMLElement>('[role="menuitemradio"][data-value="' + value + '"]')!.click())
}

it('a new group has one complete sharing contract, a visible audience review and no reply-only draft control', async () => {
  await form(); await wait(() => expect(document.querySelector('[aria-label="Existing group ID"]')).not.toBeNull()); await f.fill('Existing group ID', 'original-group')
  expect(document.querySelector('[aria-label="Group sharing content"]')).toBeNull()
  const review = document.querySelector('[aria-label="Groups sharing this conversation"]')!
  expect(review.textContent).toContain('AgentMux App'); expect(review.textContent).toContain('Proposed group')
  expect(review.closest('details')?.open).toBe(true)
  expect(f.calls.some(call => call.method === 'connection.bind')).toBe(false)
  await act(async () => document.querySelector<HTMLInputElement>('.agent-connector-check input')!.click())
  await f.button('Connect group')
  await wait(() => expect(f.services.bindings!.listActive()).toHaveLength(1))
  expect(f.services.bindings!.listActive()[0]!.scope.publication).toBe('future-shared-conversation')
  expect(Object.values(useAppStore.getState().connectorRoomDrafts).every(draft => !('publication' in draft))).toBe(true)
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
})

it.each(['active', 'paused'] as const)('a recorded %s group completes from its original target in one explicit action without saving trigger drafts', async state => {
  const saved = await recorded()
  const actor = { application: saved.binding.application, idType: 'account_id', userId: 'original-member' }
  await f.forward('connection.grant', { operationId: 'keep-original-access', bindingId: saved.binding.bindingId, expectedBindingRevision: 1,
    grantId: 'original-grant', expectedRevision: null, actor, capabilities: ['input', 'answer', 'permission'], state: 'active' })
  if (state === 'paused') await f.forward('connection.binding.pause', { operationId: 'original-pause', bindingId: saved.binding.bindingId, expectedRevision: 1 })
  const original = f.services.bindings!.readCurrent(saved.binding.bindingId)!
  const before = (await f.forward('connection.binding.inspect', { bindingId: original.bindingId })).grants
  await form(original)
  await wait(() => expect(document.querySelector('[data-partial-sharing]')?.textContent).toContain('User messages are not connected'))
  const notice = document.querySelector('[data-partial-sharing]')!
  if (state === 'paused') {
    expect(notice.textContent).toContain('No new messages are being shared')
    expect([...document.querySelectorAll('button')].some(button => button.textContent === 'Resume sync')).toBe(false)
  }
  expect(notice.querySelector('[aria-label="Groups sharing this conversation"]')).not.toBeNull()
  expect(f.services.bindings!.readCurrent(original.bindingId)).toEqual(original)
  expect(f.calls.filter(call => call.method === 'connection.binding.relink')).toHaveLength(0)
  await inputScope('all-messages')
  await f.button(state === 'paused' ? 'Resume and share complete conversation' : 'Share complete conversation')
  await wait(() => expect(f.services.bindings!.readCurrent(original.bindingId)?.revision).toBe(original.revision + 1))
  const current = f.services.bindings!.readCurrent(original.bindingId)!
  expect(current).toMatchObject({ state: 'active', scope: { input: original.scope.input, publication: 'future-shared-conversation' }, inputTarget: original.inputTarget })
  const after = (await f.forward('connection.binding.inspect', { bindingId: original.bindingId })).grants
  expect(after.map(grant => [grant.grantId, grant.actor, grant.state, grant.capabilities])).toEqual(before.map(grant => [grant.grantId, grant.actor, grant.state, grant.capabilities]))
  expect(f.services.bindings!.readExact(original.bindingId, original.revision)).toEqual(original)
  expect(f.calls.filter(call => call.method === 'connection.binding.relink')).toHaveLength(1)
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
})

it.each(['not-dispatched', 'may-have-dispatched'] as const)('reopening a %s recorded narrow request retains inspection without dispatch or blocking explicit full sharing', async phase => {
  const saved = await recorded(), input = { ...saved.input, operationId: 'original-unresolved-request' }
  const intent = { method: 'connection.bind' as const, input, target: { executionHostId: input.executionHostId, agentSessionId: input.agentSessionId, regionAnchor: input.regionAnchor }, hostingTarget: f.hostingTarget, phase }
  await expect(retainConnectorRoomIntent(intent)).resolves.toMatchObject({ localStorageWritten: true })
  const persisted = localStorage.getItem('agentmux-workbench-v1')!
  useAppStore.setState({ connectorRoomIntents: {} }); localStorage.setItem('agentmux-workbench-v1', persisted); await useAppStore.persist.rehydrate()
  expect(useAppStore.getState().connectorRoomIntents[input.operationId]).toEqual(intent)
  await form(saved.binding)
  await wait(() => expect(f.calls.some(call => call.method === 'connection.binding.inspect' && (call.input as { operationId?: string }).operationId === input.operationId)).toBe(true))
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(phase === 'not-dispatched' ? 'Not sent. It will not be dispatched.' : 'Original result retained')
  expect([...document.querySelectorAll('button')].some(button => button.textContent === 'Continue setup')).toBe(false)
  await f.button('Share complete conversation')
  await wait(() => expect(f.services.bindings!.readCurrent(saved.binding.bindingId)?.scope.publication).toBe('future-shared-conversation'))
  expect(useAppStore.getState().connectorRoomIntents[input.operationId]).toEqual(intent)
  expect(f.calls.some(call => (call.method === 'connection.bind' || call.method === 'connection.binding.relink') && (call.input as { operationId: string }).operationId === input.operationId)).toBe(false)
})
