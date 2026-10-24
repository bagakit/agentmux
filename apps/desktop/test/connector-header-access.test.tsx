// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { api } from '../src/renderer/src/lib/api'
import type { ConnectionMethod, ConnectionParamsMap, ConnectionResultMap } from '@agentmux/core/connections'
import { retainConnectorRoomIntent, useAppStore } from '../src/renderer/src/store'
import { observeConnectorService, connectorServiceScope } from '../src/renderer/src/lib/connector-service-observation'
import { invalidateConnectorTarget } from '../src/renderer/src/lib/connector-room-intent'
import { composerSession } from './helpers/composer-dom-fixture'
import { ConnectorRoomJoinLink } from '../src/renderer/src/components/ConnectorRoomJoinLink'
import type { RoomReadWire } from '../../../packages/connectors/test/fixtures/room-discovery'

let roomRead: ((request: RoomReadWire) => Promise<unknown>) | null = null
beforeEach(() => { roomRead = null })
const f = connectorJourneyFixture({ platform: async request => {
  if (request.url?.endsWith('/chats') && request.method?.toUpperCase() === 'POST') return { code: 0, data: { chat_id: 'oc_header_created' } }
  if (request.url?.endsWith('/link')) return { code: 0, data: { share_link: 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=header-join', expire_time: String(Math.floor(Date.now() / 1000) + 300), is_permanent: false } }
  if (request.url?.endsWith('/members')) return { code: 0, data: { items: [], has_more: false } }
  if (request.url?.endsWith('/chats') || request.url?.endsWith('/chats/search')) return { code: 0, data: { items: [], has_more: false } }
  if (roomRead) return await roomRead(request)
  return { code: 0, data: { name: 'Original team', chat_status: 'normal', chat_mode: 'group' } }
} })
const target = { executionHostId: 'local', agentSessionId: 'original-agent', regionAnchor: { regionId: 'original-region' } }
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 6000 }) }
const header = () => document.querySelector<HTMLElement>('[data-workbench-region-id="original-region"] .agent-region-header')!
const trigger = () => header().querySelector<HTMLButtonElement>('[data-channel-entry="feishu"]')!
const writes = () => f.calls.filter(call => ['connection.configure', 'connection.service.configure', 'connection.room.create', 'connection.room.link.create', 'connection.bind', 'connection.binding.relink', 'connection.binding.pause', 'connection.grant'].includes(call.method))
async function close() { await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close group setup"]')!.click()) }
async function menu(reason = 'open Connections') {
  await act(async () => { trigger().focus(); trigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  await wait(() => expect(document.querySelector('.connector-header-menu'), reason).not.toBeNull())
}
async function action(label: string) {
  await menu()
  const item = [...document.querySelectorAll<HTMLElement>('.connector-header-menu [role="menuitem"]')].find(node => node.textContent?.trim() === label)
  expect(item, label).toBeDefined()
  await act(async () => item!.click())
}
async function openGroup(id = 'oc_header') {
  if (!document.querySelector('.connector-header-menu')) await menu('open original group ' + id)
  const item = [...document.querySelectorAll<HTMLElement>('.connector-header-menu__item')].find(node => node.getAttribute('aria-label')?.includes(id))
  expect(item, 'exact original connection row').toBeDefined()
  await act(async () => item!.click())
  await wait(() => expect(document.querySelector('.connector-header-menu')).toBeNull())
}

async function bind() {
  await f.mount(); await f.journey('existing'); await f.fill('Existing group ID', 'oc_header')
  await act(async () => document.querySelector<HTMLInputElement>('.agent-connector-check input')!.click())
  await f.button('Connect group'); await wait(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Connection saved'))
  await f.button('Close'); await wait(() => expect(trigger()?.getAttribute('aria-label')).toContain('Original team'))
  return (await f.services.connections.bindings!.list({})).bindings[0]!
}

it('the unbound header remains usable during the first read and unrelated host or Session intents do not become this setup', async () => {
  for (const [operationId, executionHostId, agentSessionId] of [['foreign-session-setup', 'local', 'other-agent'], ['foreign-host-setup', 'other-host', 'original-agent']]) {
    const originalTarget = { executionHostId: executionHostId!, agentSessionId: agentSessionId!, regionAnchor: { regionId: 'other-region' } }
    await retainConnectorRoomIntent({ method: 'connection.room.create', target: originalTarget, phase: 'not-dispatched', input: { ...originalTarget,
      operationId: operationId!, connectionId: f.config.connectionId, expectedConnectionRevision: 1, name: 'Other setup', members: [] } })
  }
  const pending: (() => void)[] = []
  vi.mocked(api.connections.call).mockImplementation(async (method, input) => {
    if (method === 'connection.binding.ls') await new Promise<void>(resolve => pending.push(resolve))
    return f.forward(method, input)
  })
  try {
    await f.mount(); await wait(() => expect(trigger()?.dataset.channelState).toBe('unknown'))
    expect(trigger().getAttribute('aria-busy')).toBe('true'); expect(trigger().disabled).toBe(false)
    await action('Connect a group')
    await wait(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
  } finally { await act(async () => { for (const release of pending) release() }); vi.mocked(api.connections.call).mockImplementation(f.forward) }
  await wait(() => expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value).toBe(f.config.connectionId))
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Other setup')
  await close(); await wait(() => expect(trigger()?.dataset.channelState).toBe('unbound'))
  expect(writes()).toHaveLength(0)
  expect(Object.keys(useAppStore.getState().connectorRoomIntents)).toEqual(['foreign-session-setup', 'foreign-host-setup'])
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
  await f.original.unchanged()
}, 25_000)

it('the header continues its created but unbound group with the original request through close, reopen and a failed binding read', async () => {
  await f.mount(); await wait(() => expect(trigger()?.dataset.channelState).toBe('unbound'))
  await action('Connect a group')
  await wait(() => expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value).toBe(f.config.connectionId))
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="New group"]')!.click())
  await f.fill('Group name', 'Original header setup'); await f.button('Create group')
  await wait(() => expect(f.calls.find(call => call.method === 'connection.room.create')?.result).toMatchObject({ creation: { state: 'created', externalConversationId: 'oc_header_created' } }))
  const original = f.calls.find(call => call.method === 'connection.room.create')!.input as { operationId: string }
  await close(); await wait(() => expect(trigger()?.dataset.channelState).toBe('unbound'))
  await menu(); expect(document.querySelector('.connector-header-menu')?.textContent).toContain('Open channel setup')
  const retained = [...document.querySelectorAll<HTMLElement>('.connector-header-menu [role="menuitem"]')].find(node => node.textContent === 'Open channel setup')!
  await act(async () => retained.click())
  await wait(() => expect(f.calls.some(call => call.method === 'connection.room.inspect' && (call.input as { operationId: string }).operationId === original.operationId)).toBe(true))
  await wait(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('oc_header_created'))
  await close()
  vi.mocked(api.connections.call).mockImplementation(async (method, input) => { if (method === 'connection.binding.ls') throw Error('Controlled binding observation failure'); return f.forward(method, input) })
  await act(async () => invalidateConnectorTarget(target))
  await wait(() => expect(trigger()?.dataset.channelState).toBe('unknown'))
  await action('Check bot hosting'); await wait(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
  expect(useAppStore.getState().connectorRoomIntents[original.operationId]?.input).toEqual(original)
  expect(writes().map(call => call.method)).toEqual(['connection.room.create'])
  expect(f.platformCalls.filter(call => call.method?.toUpperCase() === 'POST' && call.url?.endsWith('/chats'))).toHaveLength(1)
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
  await f.original.unchanged()
}, 25_000)

it('bound header status separates saved binding from source-qualified automatic sync without dispatching effects', async () => {
  await bind()
  expect(trigger().getAttribute('aria-label')).toContain('Original team')
  await menu()
  await wait(() => expect(document.querySelector('.connector-header-menu')?.textContent).toContain('Linked · Sync on · Bot on'))
  expect(trigger().title).not.toContain('Group connected')
  const off = await api.connections.call('connection.service.configure', { operationId: 'header-sync-off', expectedRevision: 0, service: { enabled: false } })
  const count = writes().length
  await act(async () => observeConnectorService(off.service, api.connections.call, f.hostingTarget))
  // This fixture has no publication owner: Off remains a configuration fact,
  // while the new bounded source/effect read is accurately unconfirmed.
  await wait(() => expect(trigger().getAttribute('aria-label')).toContain('Status unknown'))
  await wait(() => expect(document.querySelector('.connector-header-menu')?.textContent).toContain('Linked · Sync off · Bot on'))
  expect(document.querySelector('.connector-header-menu__item')?.getAttribute('aria-label')).toContain('oc_header')
  await act(async () => useAppStore.setState({ connectorServiceObservation: { [connectorServiceScope(f.hostingTarget)]: { source: (async () => { throw Error('Other endpoint') }) as typeof api.connections.call, generation: 1, state: { enabled: false, revision: 3 }, issue: '' } } }))
  expect(trigger().getAttribute('aria-label')).toContain('Original team')
  expect(document.querySelector('.connector-header-menu')?.textContent).toContain('Linked · Sync off · Bot on')
  expect(writes()).toHaveLength(count)
  await f.original.unchanged()
}, 25_000)

it('the actual Terminal header opens its exact original group and joining section, and only explicit link creation produces its QR', async () => {
  const binding = await bind()
  expect(trigger().getAttribute('aria-label')).toContain('Lark')
  expect(trigger().getAttribute('aria-label')).toContain('Original team')
  expect(trigger().getAttribute('title')).toContain('Original team')
  expect(trigger().querySelector('img')).not.toBeNull()
  const writes = f.platformCalls.filter(call => call.method === 'POST').length
  await openGroup()
  await wait(() => expect(document.querySelector('[aria-label="Joining this group"]')).not.toBeNull())
  const joining = document.querySelector<HTMLElement>('[aria-label="Joining this group"]')!
  expect(joining.closest('details:not([open])'), 'Joining actions are directly available').toBeNull()
  expect(joining.textContent).toContain('Create join link')
  await wait(() => expect(document.querySelector('[aria-label="Group connection status"]')).not.toBeNull())
  const overview = document.querySelector('.agent-connector-room-overview')!
  expect(overview.querySelector('summary')?.textContent).toBe('Group identity')
  expect(overview.querySelector('code')?.textContent).toBe(binding.externalConversationId)
  expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value).toBe(binding.connectionId)
  const inspection = f.calls.find(call => call.method === 'connection.binding.inspect' && (call.input as { bindingId?: string }).bindingId === binding.bindingId)!
  expect(inspection.input).toEqual({ bindingId: binding.bindingId })
  expect(inspection.result).toMatchObject({ binding: { bindingId: binding.bindingId, revision: binding.revision } })
  expect(f.platformCalls.filter(call => call.method === 'POST')).toHaveLength(writes)
  expect(f.calls.some(call => call.method === 'connection.room.link.create')).toBe(false)
  await f.button('Create join link')
  await wait(() => expect(document.querySelector('svg[role="img"] title')?.textContent).toBe('Join this group'))
  expect(f.platformCalls.filter(call => call.url?.endsWith('/link'))).toHaveLength(1)
  const originalLink = f.calls.find(call => call.method === 'connection.room.link.create')!
  expect(originalLink.input).toMatchObject({ connectionId: binding.connectionId, externalConversationId: 'oc_header' })
  await f.button('Close'); await menu()
  expect(document.querySelector('.connector-header-menu')?.textContent).toContain('Connect a group')
  expect(document.querySelector('.connector-header-menu')?.textContent).not.toContain('Open channel setup')
  const originalGroup = document.querySelector<HTMLElement>('.connector-header-menu__item')!
  await act(async () => originalGroup.click())
  await wait(() => expect(document.querySelector('svg[role="img"] title')?.textContent).toBe('Join this group'))
  expect(f.platformCalls.filter(call => call.url?.endsWith('/link'))).toHaveLength(1)
  expect(f.calls.some(call => call.method === 'connection.room.link.inspect' && (call.input as { operationId: string }).operationId === (originalLink.input as { operationId: string }).operationId)).toBe(true)
  const inspected = await f.cli(['room', 'link', 'inspect', '--operation-id', (originalLink.input as { operationId: string }).operationId])
  expect(inspected.operation).toMatchObject({ state: 'confirmed', input: { externalConversationId: 'oc_header' } })
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
  expect(f.settings).not.toHaveBeenCalled(); await f.original.unchanged()
}, 25_000)

it('the header retains the original paused group through observation failure and unrelated Sessions add no reads', async () => {
  const binding = await bind()
  await api.connections.call('connection.binding.pause', { operationId: 'pause-header-group', bindingId: binding.bindingId, expectedRevision: binding.revision })
  await act(async () => invalidateConnectorTarget(target))
  await wait(() => expect(f.calls.filter(call => call.method === 'connection.binding.ls').at(-1)?.result).toMatchObject({ bindings: [{ bindingId: binding.bindingId, revision: 2, state: 'paused' }] }))
  await menu()
  await wait(() => expect(document.querySelector('.connector-header-menu')?.textContent).toContain('Sharing paused'))
  await act(async () => document.querySelector('.connector-header-menu')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  await wait(() => expect(document.querySelector('.connector-header-menu')).toBeNull())
  expect((await f.services.connections.bindings!.list({})).bindings[0]!.state).toBe('paused')
  const count = f.calls.filter(call => call.method === 'connection.binding.ls').length
  await act(async () => useAppStore.setState(state => ({ sessions: [...state.sessions, ...Array.from({ length: 200 }, (_, index) => composerSession('unrelated-header-' + index))] })))
  expect(f.calls.filter(call => call.method === 'connection.binding.ls')).toHaveLength(count)
  vi.mocked(api.connections.call).mockImplementation(async (method, input) => { if (method === 'connection.binding.ls') throw new Error('Original audience unavailable'); return f.forward(method, input) })
  const editor = document.querySelector<HTMLElement>('[data-workbench-region-id="original-region"] [role="textbox"]')!
  await act(async () => { editor.focus(); invalidateConnectorTarget(target) })
  await wait(() => expect(trigger().getAttribute('aria-label')).toContain('Status unknown'))
  expect(trigger().getAttribute('title')).toContain('Original team'); expect(trigger().disabled).toBe(false)
  expect(document.activeElement).toBe(editor); expect(editor.getAttribute('contenteditable')).toBe('true')
  await menu('read the current binding error')
  await wait(() => expect(document.querySelector('.connector-header-menu')?.textContent).toContain('Original audience unavailable'))
  await wait(() => expect(document.querySelector('.connector-header-menu')?.textContent).toContain('Sharing paused'))
  expect(document.querySelector('.connector-header-menu')?.textContent).toContain('Check group status')
  await act(async () => document.querySelector('.connector-header-menu')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  await wait(() => { expect(document.querySelector('.connector-header-menu')).toBeNull(); expect(document.activeElement).toBe(trigger()) })
  vi.mocked(api.connections.call).mockImplementation(f.forward)
  await openGroup()
  await wait(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
  await f.button('Close'); await wait(() => expect(trigger().getAttribute('aria-label')).toContain('Original team'))
  expect((await f.services.connections.bindings!.list({})).bindings[0]!.state).toBe('paused')
  expect(f.original.create).not.toHaveBeenCalled(); await f.original.unchanged()
}, 25_000)

it('a multiple-group header selects the named original application instead of the first Binding', async () => {
  await bind()
  const first = (await f.services.connections.list()).connections[0]!.config
  await api.connections.call('connection.configure', { operationId: 'header-other-application', expectedRevision: null, connection: { ...first, connectionId: 'other-header-connection', application: { ...first.application, appId: 'other-header-app' } } })
  const other = await api.connections.call('connection.bind', { ...f.original.input, operationId: 'header-other-binding', bindingId: 'other-header-binding', connectionId: 'other-header-connection', externalConversationId: 'oc_other_header' })
  expect(other.state).toBe('applied'); await act(async () => invalidateConnectorTarget(target))
  await wait(() => expect(trigger().getAttribute('aria-label')).toContain('2 groups'))
  await menu()
  await wait(() => expect(document.querySelectorAll('.connector-header-menu__item')).toHaveLength(2))
  const item = [...document.querySelectorAll<HTMLElement>('.connector-header-menu [role="menuitem"]')].find(node => node.getAttribute('aria-label')?.includes('oc_other_header'))!
  expect(item.textContent).toContain('other-header-app')
  await act(async () => item.click())
  await wait(() => expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value).toBe('other-header-connection'))
  await wait(() => expect(document.querySelector('[aria-label="Joining this group"]')).not.toBeNull())
  await wait(() => expect(document.querySelector('[aria-label="Group connection status"]')).not.toBeNull())
  expect(document.querySelector('.agent-connector-room-overview')?.textContent).toContain('Group ID · oc_other_header')
  expect(f.calls.filter(call => call.method === 'connection.binding.inspect').map(call => call.input)).toContainEqual({ bindingId: 'other-header-binding', revision: 1 })
  expect(f.platformCalls.some(call => call.method === 'POST')).toBe(false)
  expect(f.settings).not.toHaveBeenCalled(); await f.original.unchanged()
}, 25_000)

it('same-name groups from the supported native domains remain separate platform-qualified original connections', async () => {
  await bind()
  const first = (await f.services.connections.list()).connections[0]!.config
  await api.connections.call('connection.configure', { operationId: 'header-lark-application', expectedRevision: null,
    connection: { ...first, connectionId: 'lark-header-connection', application: { domain: 'open.larksuite.com', appId: 'lark-header-app' } } })
  const linked = await api.connections.call('connection.bind', { ...f.original.input, ...target, operationId: 'header-lark-binding', bindingId: 'lark-header-binding', connectionId: 'lark-header-connection', externalConversationId: 'oc_lark_header' })
  expect(linked.state).toBe('applied')
  await act(async () => invalidateConnectorTarget(target))
  await wait(() => expect(trigger().getAttribute('aria-label')).toContain('2 groups'))
  await menu()
  await wait(() => expect([...document.querySelectorAll('.connector-header-menu__item strong')].map(node => node.textContent)).toEqual(['Original team', 'Original team']))
  const items = [...document.querySelectorAll<HTMLElement>('.connector-header-menu__item')]
  await wait(() => expect([...document.querySelectorAll<HTMLElement>('.connector-header-menu__item')].map(item => item.querySelector('small')?.textContent)).toEqual(['Status unknown · ' + first.application.appId, 'Status unknown · lark-header-app']))
  const groups = [...document.querySelectorAll<HTMLElement>('.connector-header-menu__group')]
  expect(groups[0]!.textContent).toContain('open.feishu.cn')
  expect(groups[1]!.textContent).toContain('open.larksuite.com')
  expect(groups.every(group => group.textContent?.includes('Linked · Sync on · Bot on'))).toBe(true)
  expect(items[1]!.textContent).toContain('lark-header-app')
  expect(items[0]!.getAttribute('aria-label')).toContain('oc_header')
  expect(items[1]!.getAttribute('aria-label')).toContain('oc_lark_header')
  await act(async () => items[1]!.click())
  await wait(() => expect(f.calls.filter(call => call.method === 'connection.binding.inspect').at(-1)?.input).toEqual({ bindingId: 'lark-header-binding', revision: 1 }))
  expect(f.original.create).not.toHaveBeenCalled(); await f.original.unchanged()
}, 25_000)

it('a first unavailable native name keeps the exact original group ID and a working details action', async () => {
  const binding = await api.connections.call('connection.bind', { ...f.original.input, ...target, operationId: 'header-unavailable-binding', bindingId: 'header-unavailable-binding',
    connectionId: f.config.connectionId, externalConversationId: 'oc_unavailable_header' })
  expect(binding.state).toBe('applied')
  roomRead = async () => { throw Error('Controlled native observation unavailable') }
  await f.mount()
  await menu()
  await wait(() => expect(document.querySelector('.connector-header-menu__snapshot')?.textContent).toContain('Group name unconfirmed'))
  expect(trigger().getAttribute('aria-label')).toContain('oc_unavailable_header')
  expect(trigger().disabled).toBe(false)
  await openGroup('oc_unavailable_header')
  await wait(() => expect(f.calls.filter(call => call.method === 'connection.binding.inspect').at(-1)?.input).toEqual({ bindingId: 'header-unavailable-binding', revision: 1 }))
  expect(f.calls.filter(call => call.method === 'connection.bind')).toHaveLength(1)
  expect(f.original.create).not.toHaveBeenCalled(); await f.original.unchanged()
}, 25_000)

it('the common connection menu opens automatic sync settings with its original Agent and never changes policy on navigation', async () => {
  await bind()
  const before = writes().length
  await action('Automatic sync settings')
  await wait(() => expect(document.querySelector('.connector-header-menu')).toBeNull())
  expect(f.settings).not.toHaveBeenCalled()
  await wait(() => expect(document.querySelector('[role="dialog"] [data-connector-service]')).not.toBeNull())
  expect(writes()).toHaveLength(before)
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
  await f.original.unchanged()
}, 25_000)

it('an exact metadata refresh notifies the original header while menu reads reuse the local name without a binding revision or background polling', async () => {
  const binding = await bind()
  await openGroup()
  roomRead = async () => ({ code: 0, data: { name: 'Renamed group', chat_status: 'normal', chat_mode: 'group' } })
  await f.button('Refresh group details')
  await wait(() => expect(document.querySelector('.agent-connector-room-overview')?.textContent).toContain('Renamed group'))
  await act(async () => { await api.connections.call('connection.metadata.refresh', { connectionId: binding.connectionId, expectedConnectionRevision: 1,
    subject: { kind: 'conversation', externalConversationId: binding.externalConversationId } }) })
  await f.button('Close')
  await wait(() => expect(trigger().getAttribute('aria-label')).toContain('Renamed group'))
  expect((await f.services.connections.bindings!.list({})).bindings[0]!.revision).toBe(binding.revision)
  await wait(() => expect(f.calls.map(call => !!call.result)).not.toContain(false))
  roomRead = async () => ({ code: 0, data: { name: 'Renamed again', chat_status: 'normal', chat_mode: 'group' } })
  const before = f.calls.length
  await act(async () => {})
  expect(f.calls).toHaveLength(before)
  await menu()
  expect(trigger().getAttribute('aria-label')).toContain('Renamed group')
  await act(async () => { await api.connections.call('connection.metadata.refresh', { connectionId: binding.connectionId, expectedConnectionRevision: 1,
    subject: { kind: 'conversation', externalConversationId: binding.externalConversationId } }) })
  await wait(() => expect(trigger().getAttribute('aria-label')).toContain('Renamed again'))
  expect(document.querySelector('.connector-header-menu__item strong')?.textContent).toContain('Renamed again')
  expect(f.calls.filter(call => call.method === 'connection.bind')).toHaveLength(1)
  expect(f.original.create).not.toHaveBeenCalled(); await f.original.unchanged()
}, 25_000)

it('a late original metadata get cannot replace the relinked group or its original navigation target', async () => {
  const binding = await bind(), releases: (() => void)[] = []
  roomRead = async () => ({ code: 0, data: { name: 'Current group', chat_status: 'normal', chat_mode: 'group' } })
  vi.mocked(api.connections.call).mockImplementation(async (method, input) => {
    const result = await f.forward(method, input)
    if (method === 'connection.metadata.get' && (input as ConnectionParamsMap['connection.metadata.get']).subject.kind === 'conversation' &&
      ((input as ConnectionParamsMap['connection.metadata.get']).subject as { externalConversationId: string }).externalConversationId === binding.externalConversationId)
      await new Promise<void>(resolve => releases.push(resolve))
    return result
  })
  try {
    const paused = await api.connections.call('connection.binding.pause', { operationId: 'header-delay-old-name', bindingId: binding.bindingId, expectedRevision: binding.revision })
    expect(paused.state).toBe('applied')
    await act(async () => invalidateConnectorTarget(target))
    await wait(() => expect(releases.length).toBeGreaterThan(0))
    const relink = await api.connections.call('connection.binding.relink', { ...f.original.input, ...target, operationId: 'header-current-name', bindingId: binding.bindingId,
      expectedRevision: 2, connectionId: binding.connectionId, externalConversationId: 'oc_current_header' })
    expect(relink.state).toBe('applied')
    await act(async () => invalidateConnectorTarget(target))
    await wait(() => expect(trigger().getAttribute('aria-label')).toContain('Current group'))
    await act(async () => releases.forEach(release => release()))
    await wait(() => expect(document.querySelectorAll('.conversation-sharing-notice__audience')).toHaveLength(2))
    expect([...document.querySelectorAll('.conversation-sharing-notice__destination')].map(node => node.textContent)).toEqual(['Agent replies → Current group', 'Agent replies → Current group'])
    expect(trigger().getAttribute('aria-label')).toContain('Current group')
    expect(trigger().title).toContain('Current group'); expect(trigger().title).not.toContain('Original team')
    await openGroup('oc_current_header')
    await wait(() => {
      const inspected = f.calls.filter(call => call.method === 'connection.binding.inspect').at(-1)
      expect(inspected?.input).toEqual({ bindingId: binding.bindingId })
      expect(inspected?.result).toMatchObject({ binding: { bindingId: binding.bindingId, revision: 3, externalConversationId: 'oc_current_header' } })
    })
    expect(document.querySelector('.agent-connector-room-overview')?.textContent).toContain('Current group')
    expect([...document.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === 'Connection details')?.textContent).toContain('Group · oc_current_header')
    expect(document.querySelector('.agent-connector-room-overview')?.textContent).not.toContain('Original team')
    expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
    await f.original.unchanged()
  } finally { await act(async () => releases.forEach(release => release())) }
}, 25_000)

it('an unavailable or mismatched room observation keeps the exact relationship usable and never substitutes another application name', async () => {
  await bind()
  vi.mocked(api.connections.call).mockImplementation(async <M extends ConnectionMethod>(method: M, params: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
    const result = await f.forward(method, params)
    if (method === 'connection.metadata.get') {
      const value = result as ConnectionResultMap['connection.metadata.get']
      return { ...value, connectionId: 'foreign-connection', application: { ...f.config.application, appId: 'foreign-app' },
        entry: { ...value.entry, observation: { ...value.entry.observation, profile: { name: 'Foreign group', observedAt: Date.now() } } } } as ConnectionResultMap[M]
    }
    return result
  })
  const binding = (await f.services.connections.bindings!.list({})).bindings[0]!
  await api.connections.call('connection.binding.pause', { operationId: 'header-metadata-unavailable', bindingId: binding.bindingId, expectedRevision: binding.revision })
  await act(async () => invalidateConnectorTarget(target))
  await menu()
  await wait(() => expect(document.querySelector('.connector-header-menu__snapshot')?.textContent).toContain('Group name unconfirmed'))
  expect(trigger().getAttribute('aria-label')).toContain('Original team')
  expect(trigger().disabled).toBe(false); expect(trigger().textContent).not.toContain('Foreign group')
  await openGroup()
  await wait(() => expect(f.calls.filter(call => call.method === 'connection.binding.inspect').at(-1)?.input).toEqual({ bindingId: binding.bindingId, revision: 2 }))
  expect(f.original.create).not.toHaveBeenCalled(); await f.original.unchanged()
}, 25_000)

it('an open confirmed join QR retires at its original expiry while keeping the receipt and explicit regeneration', async () => {
  vi.useFakeTimers()
  try {
    const originalOperation = { operationId: 'original-header-link', input: { operationId: 'original-header-link', connectionId: f.config.connectionId, expectedConnectionRevision: 1, externalConversationId: 'oc_header' }, application: f.config.application, authorizedBy: { kind: 'user' as const, id: 'original-user' }, state: 'confirmed' as const, link: { url: 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=retained-link', expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 1 } }
    const effect = vi.fn()
    await f.dom.render(<ConnectorRoomJoinLink submitted operation={originalOperation} pending={false} prominent canContinue={false} onCreate={effect} onInspect={effect} onContinue={effect} onRegenerate={effect} />)
    expect(document.querySelector('svg[role="img"] title')?.textContent).toBe('Join this group')
    await act(async () => vi.advanceTimersByTimeAsync(1_100))
    expect(document.querySelector('svg[role="img"]')).toBeNull()
    expect(document.body.textContent).toContain('This join link has expired')
    expect(document.body.textContent).toContain('original-header-link')
    expect([...document.querySelectorAll('button')].find(node => node.textContent === 'Generate a new join link')).toBeDefined()
    expect(effect).not.toHaveBeenCalled()
  } finally { vi.useRealTimers() }
})
