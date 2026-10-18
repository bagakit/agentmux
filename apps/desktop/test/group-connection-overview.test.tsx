// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { api } from '../src/renderer/src/lib/api'

let nativeName: string, roomDenied: boolean
const f = connectorJourneyFixture({ platform: async request => {
  if (request.url?.includes('/application/v6/applications/')) return { code: 99991672 }
  if (request.url?.endsWith('/bot/v3/info')) return { code: 0, bot: { open_id: 'native-bot', app_name: 'Group bot' } }
  if (request.url?.endsWith('/chats') && request.method?.toUpperCase() === 'POST') return { code: 0, data: { chat_id: 'oc_overview' } }
  if (request.url?.endsWith('/members')) return { code: 0, data: { items: [{ member_id_type: 'open_id', member_id: 'member-overview', name: 'Group member' }], has_more: false } }
  if (request.url?.endsWith('/chats') || request.url?.endsWith('/chats/search')) return { code: 0, data: { items: [], has_more: false } }
  return roomDenied ? { code: 99991672 } : { code: 0, data: { name: nativeName, chat_status: 'normal', chat_mode: 'group', membership_approval: 'approval_required' } }
} })
beforeEach(() => { nativeName = 'Current platform group'; roomDenied = false })
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 6000 }) }
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
function unfolded(element: Element | null) {
  expect(element).not.toBeNull()
  for (let parent = element?.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) expect(parent.open).toBe(true)
}
async function create() {
  await f.mount(); await f.journey('create'); await f.fill('Group name', 'Requested creation name'); await f.button('Create group')
  await wait(() => expect(dialog().textContent).toContain('Group created. Connect it to this Agent.'))
}

it('a created group shows current platform metadata and direct joining and member sections before sharing is saved', async () => {
  await create()
  await wait(() => expect(dialog().querySelector('.agent-connector-group')?.textContent).toBe(nativeName))
  expect(dialog().textContent).toContain('Approval required to join')
  expect(dialog().textContent).toContain('oc_overview')
  unfolded(dialog().querySelector('[aria-label="Joining this group"] button'))
  unfolded(dialog().querySelector('[aria-label="People in this group"]'))
  expect(dialog().querySelector('[aria-label="People in this group"]')?.textContent).toContain('Group member')
  const before = f.platformCalls.filter(call => call.method?.toUpperCase() === 'POST').length
  nativeName = 'Renamed platform group'; await f.button('Refresh group details')
  await wait(() => expect(dialog().querySelector('.agent-connector-group')?.textContent).toBe(nativeName))
  expect(f.platformCalls.filter(call => call.method?.toUpperCase() === 'POST')).toHaveLength(before)
  expect(f.calls.some(call => call.method === 'connection.bind' || call.method === 'connection.room.link.create' || call.method === 'connection.grant')).toBe(false)
  expect(dialog().querySelector('[aria-label="Group connection status"]')).toBeNull()
  expect(dialog().textContent).not.toContain('Group linked')
  await f.original.unchanged()
}, 25_000)

it('an unavailable current name is explicit beside the original requested name and remains directly refreshable', async () => {
  roomDenied = true; await create()
  await wait(() => expect(dialog().textContent).toContain('This bot cannot read the group details'))
  expect(dialog().querySelector('.agent-connector-group')?.textContent).toBe('Group name not confirmed')
  expect(dialog().textContent).toContain('Requested name · Requested creation name')
  const refresh = [...dialog().querySelectorAll('button')].find(button => button.textContent?.trim() === 'Refresh group details')!
  unfolded(refresh); expect(refresh.disabled).toBe(false)
  roomDenied = false; await f.button('Refresh group details')
  await wait(() => expect(dialog().querySelector('.agent-connector-group')?.textContent).toBe(nativeName))
  expect(f.platformCalls.filter(call => call.url?.endsWith('/chats') && call.method?.toUpperCase() === 'POST')).toHaveLength(1)
  await f.original.unchanged()
}, 25_000)

it('saved sharing enables automatic sync in place through the original owner while keeping member and group authority separate', async () => {
  const service = await api.connections.call('connection.service.get', {})
  await api.connections.call('connection.service.configure', { operationId: 'overview-service-off', expectedRevision: service.revision, service: { enabled: false } })
  await create()
  const consent = dialog().querySelector<HTMLInputElement>('[aria-label="Sharing options"] input[type="checkbox"]')!
  await act(async () => consent.click()); await f.button('Connect group')
  await wait(() => expect(dialog().querySelector('[data-connector-service-state]')?.textContent).toBe('Off'))
  await wait(() => expect(dialog().textContent).toContain('Sharing saved locally'))
  unfolded(dialog().querySelector('[aria-label="Joining this group"] button'))
  unfolded(dialog().querySelector('[aria-label="Sharing options"]'))
  unfolded(dialog().querySelector('[aria-label="Member access"]'))
  await wait(() => expect(dialog().textContent).toContain('No members approved to use this Agent'))
  expect(dialog().textContent).toContain('select your account above, enable Send requests and save member access')
  expect(f.calls.some(call => call.method === 'connection.grant' || call.method === 'connection.room.link.create')).toBe(false)
  const originalDialog = dialog(), originalBinding = (await api.connections.call('connection.binding.ls', { executionHostId: 'local', agentSessionId: 'original-agent' })).bindings[0]!
  expect(f.calls.filter(call => call.method === 'connection.service.configure')).toHaveLength(1)
  const before = f.calls.length
  await act(async () => dialog().querySelector<HTMLInputElement>('[aria-label="Enable external chat sync"]')!.click())
  await f.button('Save changes')
  await wait(() => expect(dialog().querySelector('[data-connector-service-state]')?.textContent).toBe('On'))
  const save = f.calls.slice(before).find(call => call.method === 'connection.service.configure')!
  expect(save.input).toEqual({ operationId: expect.any(String), expectedRevision: service.revision + 1, service: { enabled: true } })
  expect(save.result).toMatchObject({ operationId: (save.input as { operationId: string }).operationId, status: 'configured', service: { enabled: true, revision: service.revision + 2 } })
  expect((await api.connections.call('connection.service.inspect', { operationId: (save.input as { operationId: string }).operationId })).operation).toEqual(save.result)
  expect(f.calls.slice(before).filter(call => ['connection.service.configure', 'connection.configure', 'connection.bind', 'connection.binding.relink', 'connection.grant', 'connection.room.create', 'connection.room.link.create'].includes(call.method)).map(call => call.method)).toEqual(['connection.service.configure'])
  expect((await api.connections.call('connection.binding.ls', { executionHostId: 'local', agentSessionId: 'original-agent' })).bindings).toEqual([originalBinding])
  expect(dialog()).toBe(originalDialog)
  expect(f.settings).not.toHaveBeenCalled()
  expect(dialog().textContent).toContain('No members approved to use this Agent')
  expect(dialog().textContent).toContain('Controls automatic messages for all your external bots')
  expect(dialog().textContent).not.toContain('messages delivered')
  await f.original.unchanged()
}, 25_000)

it('visible sharing controls still require fresh confirmation before updating the original binding', async () => {
  await create()
  await act(async () => dialog().querySelector<HTMLInputElement>('[aria-label="Sharing options"] input[type="checkbox"]')!.click())
  await f.button('Connect group'); await wait(() => expect(dialog().textContent).toContain('Group saved'))
  const original = (await api.connections.call('connection.binding.ls', { executionHostId: 'local', agentSessionId: 'original-agent' })).bindings[0]!
  await wait(() => expect(dialog().querySelector<HTMLButtonElement>('[aria-label="Group input scope"]')?.disabled).toBe(false))
  await act(async () => { const trigger = dialog().querySelector<HTMLButtonElement>('[aria-label="Group input scope"]')!; trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  await wait(() => expect(document.querySelectorAll('[role="menuitemradio"]').length).toBeGreaterThan(0))
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(item => item.textContent?.includes('Every group message'))!.click())
  await wait(() => expect([...dialog().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save sharing')?.disabled).toBe(true))
  expect(f.calls.some(call => call.method === 'connection.binding.relink')).toBe(false)
  await act(async () => dialog().querySelector<HTMLInputElement>('[aria-label="Sharing options"] input[type="checkbox"]')!.click())
  await f.button('Save sharing')
  await wait(() => expect(f.calls.filter(call => call.method === 'connection.binding.relink').at(-1)?.result).toMatchObject({ state: 'applied' }))
  const saved = (await api.connections.call('connection.binding.ls', { executionHostId: 'local', agentSessionId: 'original-agent' })).bindings[0]!
  expect(saved).toMatchObject({ bindingId: original.bindingId, externalConversationId: original.externalConversationId, scope: { input: 'all-messages' } })
  expect(saved.revision).toBeGreaterThan(original.revision)
  expect(f.calls.some(call => call.method === 'connection.grant' || call.method === 'connection.room.link.create')).toBe(false)
  await f.original.unchanged()
}, 25_000)

it('a retained creation name cannot label another group after the original binding is relinked', async () => {
  await create()
  await act(async () => dialog().querySelector<HTMLInputElement>('[aria-label="Sharing options"] input[type="checkbox"]')!.click())
  await f.button('Connect group'); await wait(() => expect(dialog().textContent).toContain('Group saved'))
  const binding = (await api.connections.call('connection.binding.ls', { executionHostId: 'local', agentSessionId: 'original-agent' })).bindings[0]!
  roomDenied = true
  const native = f.original.session.nativeHandle!
  if (native.kind !== 'provider') throw Error('The fixture requires its original Provider source')
  const relink = await api.connections.call('connection.binding.relink', { executionHostId: 'local', agentSessionId: 'original-agent', regionAnchor: { regionId: 'original-region' },
    operationId: 'overview-external-relink', bindingId: binding.bindingId, expectedRevision: binding.revision, connectionId: binding.connectionId,
    expectedConnectionRevision: 1, externalConversationId: 'oc_other_overview', scope: binding.scope,
    expectedSource: { providerId: native.providerId, nativeSessionId: native.sessionId } })
  expect(relink.state).toBe('applied')
  await f.button('Refresh')
  await wait(() => expect(dialog().querySelector('.agent-connector-room-overview')?.textContent).toContain('oc_other_overview'))
  await wait(() => expect(dialog().textContent).toContain('This bot cannot read the group details'))
  expect(dialog().querySelector('.agent-connector-room-overview')?.textContent).not.toContain('Requested creation name')
  expect(f.platformCalls.filter(call => call.url?.endsWith('/chats') && call.method?.toUpperCase() === 'POST')).toHaveLength(1)
  await f.original.unchanged()
}, 25_000)
