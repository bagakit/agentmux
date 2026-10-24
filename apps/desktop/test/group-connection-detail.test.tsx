// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
vi.mock('../src/renderer/src/lib/reading-diagnostic-publication', () => ({ publishReadingDiagnostic: vi.fn() }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { openConnectedGroup } from './helpers/connector-header-navigation'
import { connectorRoomDraftKey } from '../src/renderer/src/lib/connector-room-intent'
import { useAppStore } from '../src/renderer/src/store'
import type { ConnectionParamsMap } from '@agentmux/core/connections'

const groupId = 'oc_detail_original', memberId = 'detail-original-member'
const f = connectorJourneyFixture({ platform: async request => {
  if (request.url?.includes('/application/v6/applications/')) return { code: 99991672 }
  if (request.url?.endsWith('/members')) return { code: 0, data: { items: [{ member_id_type: 'open_id', member_id: memberId, name: 'Original group member' }], has_more: false } }
  if (request.url?.endsWith('/chats') || request.url?.endsWith('/chats/search')) return { code: 0, data: { items: [], has_more: false } }
  return { code: 0, data: { name: 'Original detail group', chat_status: 'normal', chat_mode: 'group' } }
} })
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
const writeMethods = new Set(['connection.configure', 'connection.credential.store', 'connection.service.configure', 'connection.bind', 'connection.binding.relink', 'connection.binding.pause', 'connection.binding.resume', 'connection.binding.detach', 'connection.grant', 'connection.room.create', 'connection.room.members.add', 'connection.room.link.create', 'connection.delivery.retry'])
const writes = () => f.calls.filter(call => writeMethods.has(call.method))
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 8000 }) }
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
afterEach(() => {
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
})

it('navigates original detail sections and explicitly grants only the selected member through the original owner', async () => {
  const bound = await f.forward('connection.bind', { ...f.original.input, operationId: 'detail-original-binding', connectionId: f.config.connectionId, externalConversationId: groupId })
  expect(bound.state).toBe('applied')
  if (bound.state !== 'applied') return
  const binding = bound.binding
  const draftKey = connectorRoomDraftKey(binding, f.hostingTarget, 'discord')
  const retainedDraft = { connectionId: 'retained-discord-bot', bindingId: null, bindingRevision: null, mode: 'create' as const, name: 'Keep this other channel draft', group: '', members: 'original-invitation', memberType: 'user_id', scope: 'all-messages' as const, publication: 'future-shared-conversation' as const, actorId: '', actorType: '' }
  useAppStore.setState({ connectorRoomDrafts: { [draftKey]: retainedDraft } })
  const before = writes().slice(), scroll = vi.fn()
  // Layout scrolling is a DOM leaf; the real navigation still chooses and focuses its section.
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scroll })
  await f.mount(); await openConnectedGroup(groupId)
  await wait(() => expect(dialog().querySelector('.agent-connector-group')?.textContent).toBe('Original detail group'))
  const navigation = dialog().querySelector<HTMLElement>('[aria-label="Group connection sections"]')!
  expect(navigation, 'original detail section navigation is reachable').not.toBeNull()
  for (const label of ['Sharing', 'Join group', 'Members']) {
    const button = [...navigation.querySelectorAll<HTMLButtonElement>('button')].find(node => node.querySelector('span')?.textContent?.trim() === label)!
    expect(button, label).toBeDefined()
    expect(button.disabled).toBe(false)
    await act(async () => button.click())
  }
  const members = dialog().querySelector<HTMLElement>('[data-connection-section="members"][aria-label="Member access"]')!
  expect(document.activeElement, 'Members navigation focuses the original section').toBe(members)
  expect(scroll.mock.calls.length).toBeGreaterThanOrEqual(3)
  await wait(() => expect(members.querySelector('.agent-connector-person')?.textContent).toContain('Original group member'))
  const choose = members.querySelector<HTMLButtonElement>('.agent-connector-person button')!
  await act(async () => choose.click())
  const send = [...members.querySelectorAll('label')].find(node => node.textContent?.trim() === 'Send requests')!.querySelector<HTMLInputElement>('input')!
  expect(send.checked).toBe(false)
  await act(async () => send.click())
  expect(writes(), 'open, section navigation, member selection and local capability choice perform no effect').toEqual(before)
  expect(f.platformCalls.filter(call => call.method?.toUpperCase() === 'POST')).toEqual([])
  expect(useAppStore.getState().agentComposerDrafts[binding.agentSessionId]).toBe('Keep the original draft \u4e2d')
  expect(useAppStore.getState().connectorRoomDrafts[draftKey]).toEqual(retainedDraft)
  await f.button('Approve this member')
  await wait(() => expect(f.calls.filter(call => call.method === 'connection.grant' && call.result)).toHaveLength(1))
  const request = f.calls.find(call => call.method === 'connection.grant')!
  const input = request.input as ConnectionParamsMap['connection.grant']
  expect(input).toEqual({ operationId: expect.any(String), bindingId: binding.bindingId, expectedBindingRevision: binding.revision, grantId: expect.any(String), expectedRevision: null,
    actor: { application: binding.application, idType: 'open_id', userId: memberId }, capabilities: ['input'], state: 'active' })
  expect(request.result).toMatchObject({ state: 'applied', operationId: input.operationId, grant: { grantId: input.grantId, actor: input.actor, capabilities: ['input'], state: 'active', revision: 1 } })
  const inspection = await f.forward('connection.binding.inspect', { operationId: input.operationId })
  expect(inspection.operation).toEqual(request.result)
  const cli = await f.cli(['binding', 'inspect', '--binding', binding.bindingId])
  expect(cli.grants).toHaveLength(1)
  expect(cli.grants[0]).toMatchObject({ grantId: input.grantId, actor: input.actor, capabilities: ['input'], state: 'active', revision: 1 })
  expect(writes().slice(before.length).map(call => call.method)).toEqual(['connection.grant'])
  expect(f.platformCalls.filter(call => call.method?.toUpperCase() === 'POST')).toEqual([])
  const memberNavigation = [...navigation.querySelectorAll('button')].find(node => node.querySelector('span')?.textContent === 'Members')!
  expect(memberNavigation.querySelector('small')?.textContent).toBe('1 approved')
  expect(useAppStore.getState().agentComposerDrafts[binding.agentSessionId]).toBe('Keep the original draft \u4e2d')
  expect(useAppStore.getState().connectorRoomDrafts[draftKey]).toEqual(retainedDraft)
  expect(useAppStore.getState().connectorRoomIntents[input.operationId]).toBeUndefined()
  await f.original.unchanged()
}, 30_000)
