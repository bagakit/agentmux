// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { openConnectionsMenu } from './helpers/connector-header-navigation'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { ConnectionMethod, ConnectionParamsMap, ConnectionResultMap } from '@agentmux/core/connections'
import type { RoomReadWire } from '../../../packages/connectors/test/fixtures/room-discovery'
import { invalidateConnectorTarget } from '../src/renderer/src/lib/connector-room-intent'
import { composerSession } from './helpers/composer-dom-fixture'

let native: (request: RoomReadWire) => Promise<unknown>
const f = connectorJourneyFixture({ platform: request => native(request) })
const channelEntries = () => [...document.querySelectorAll<HTMLButtonElement>('.agent-region-header__connector[data-channel-entry="feishu"]')]
async function closeConnectionsMenu() {
  await act(async () => document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  await vi.waitFor(() => expect(document.querySelector('.connector-header-menu')).toBeNull())
}
beforeEach(() => { native = async request => {
  if (request.url?.endsWith('/link')) return { code: 0, data: { share_link: 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=fixture-join', expire_time: String(Math.floor(Date.now() / 1000) + 300), is_permanent: false } }
  if (request.url?.endsWith('/members')) return { code: 0, data: { items: [{ member_id_type: 'open_id', member_id: 'ou_original', name: 'Original person' }], has_more: false } }
  if (request.url?.endsWith('/chats') || request.url?.endsWith('/chats/search')) return { code: 0, data: { items: [{ chat_id: 'oc_original', name: 'Team group', chat_status: 'normal' }, { chat_id: 'oc_other', name: 'Team group', chat_status: 'normal' }, { chat_id: 'oc_unnamed', chat_status: 'normal' }], has_more: false } }
  return { code: 0, data: { name: 'Team group', chat_status: 'normal', chat_mode: 'group', membership_approval: 'approval_required' } }
} })
async function ready(text: string) { await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('[role="dialog"]')?.textContent).toContain(text) }, { timeout: 6000 }) }
async function chooseGroup(id: string) {
  await vi.waitFor(async () => { await act(async () => {}); expect(f.calls.some(call => call.method === 'connection.room.ls' && call.result)).toBe(true) })
  const trigger = document.querySelector<HTMLElement>('[aria-label="Agent and group conversation"] [aria-label="Existing group"]')!
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  const item = document.querySelector<HTMLElement>('[role="menuitemradio"][data-value="' + id + '"]')
  expect(item, 'real room option from the original SDK page').not.toBeNull()
  await act(async () => item!.click())
}
async function consent() { await act(async () => document.querySelector<HTMLInputElement>('.agent-connector-check input')!.click()) }

it('an exact platform off policy remains available from the header while the global service read is pending or unavailable', async () => {
  expect((await api.connections.call('connection.bind', { ...f.original.input, connectionId: f.config.connectionId, externalConversationId: 'oc_other' })).state).toBe('applied')
  await api.connections.call('connection.service.configure', { operationId: 'visible-platform-off', adapterId: 'feishu', expectedRevision: 0, service: { enabled: false } }, f.hostingTarget)
  let reject!: (reason: Error) => void
  const pending = new Promise<never>((_resolve, fail) => { reject = fail })
  void pending.catch(() => {}) // The controlled read can outlive a disposed observer.
  vi.mocked(api.connections.call).mockImplementation(async <M extends ConnectionMethod>(method: M, params: ConnectionParamsMap[M], owner): Promise<ConnectionResultMap[M]> => {
    if (method === 'connection.service.get' && !('adapterId' in params)) return pending
    return f.forward(method, params, owner)
  })
  await f.mount()
  const offVisible = async () => vi.waitFor(async () => {
    await act(async () => {})
    const entries = channelEntries()
    expect(entries).toHaveLength(2)
    for (const entry of entries) {
      expect(entry.dataset.channelState).not.toBe('unbound')
      expect(entry.title).not.toMatch(/Checking sync|Automatic sync check unavailable/u)
      expect(entry.querySelectorAll('.agent-region-header__connector-marker')).toHaveLength(1)
    }
    expect(document.querySelector('.conversation-sharing-notice')).toBeNull()
  })
  try {
    await offVisible()
    await vi.waitFor(() => expect(vi.mocked(api.connections.call).mock.calls.some(([method, params]) => method === 'connection.service.get' && !('adapterId' in params))).toBe(true))
  }
  finally { await act(async () => reject(Error('Original global policy unavailable'))) }
  await offVisible()
  await openConnectionsMenu('original-region', 'feishu')
  await vi.waitFor(() => {
    expect([...document.querySelectorAll('.connector-header-menu [role="menuitem"]')].some(item => item.textContent === 'Channel settings')).toBe(true)
    expect(document.querySelector('[data-problem-kind="platform-off"]')?.textContent).toContain('Platform is turned off')
  })
  await closeConnectionsMenu()
  expect(document.querySelector('[role="menu"], [role="dialog"]')).toBeNull()
  await f.original.unchanged()
}, 25_000)

it('a TTL-expired observed group name stays readable without claiming a failed refresh or forcing another native request', async () => {
  const bind = await api.connections.call('connection.bind', { ...f.original.input, connectionId: f.config.connectionId, externalConversationId: 'oc_other' })
  expect(bind.state).toBe('applied')
  const subject = { kind: 'conversation' as const, externalConversationId: 'oc_other' }
  const fresh = await api.connections.call('connection.metadata.refresh', { connectionId: f.config.connectionId, expectedConnectionRevision: 1, subject })
  expect(fresh.entry.observation).toMatchObject({ state: 'observed', freshness: 'current', profile: { name: 'Team group' } })
  const realNow = Date.now, clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 6 * 60_000)
  try {
    expect((await api.connections.call('connection.metadata.get', { connectionId: f.config.connectionId, subject })).entry.observation).toMatchObject({ state: 'observed', freshness: 'stale' })
    const reads = f.platformCalls.length, refreshes = f.calls.filter(call => call.method === 'connection.metadata.refresh').length
    await f.mount()
    await vi.waitFor(async () => {
      await act(async () => {})
      const entries = channelEntries()
      expect(entries).toHaveLength(2)
      for (const entry of entries) {
        expect(entry.title).toContain('Team group')
        expect(entry.title).not.toMatch(/name.*unconfirmed|name.*unavailable|refresh unconfirmed/u)
      }
    })
    expect(f.platformCalls).toHaveLength(reads)
    expect(f.calls.filter(call => call.method === 'connection.metadata.refresh')).toHaveLength(refreshes)
    native = async () => { throw Error('Original metadata source unavailable') }
    const failed = await api.connections.call('connection.metadata.refresh', { connectionId: f.config.connectionId, expectedConnectionRevision: 1, subject })
    expect(failed.entry.observation).toMatchObject({ state: 'unavailable', freshness: 'stale', profile: { name: 'Team group' } })
    await openConnectionsMenu('original-region', 'feishu')
    await vi.waitFor(async () => {
      await act(async () => {})
      const group = document.querySelector('.connector-header-menu__group')!
      expect(group.querySelector('strong')?.textContent).toBe('Team group')
      expect(group.querySelector('.connector-header-menu__diagnostics')?.textContent).toContain('Group name update unavailable')
      for (const entry of channelEntries()) expect(entry.title).toContain('Team group')
    })
    await closeConnectionsMenu()
    await f.original.unchanged()
  } finally { clock.mockRestore() }
}, 25_000)

it('the original Agent menu selects an actual default-Host SDK room, confirms the exact audience and grants only an explicitly chosen real member', async () => {
  await f.mount(); await f.journey('existing')
  await chooseGroup('oc_other'); await ready('Original person')
  expect(document.querySelector('[aria-label="Agent and group conversation"] [aria-label="Existing group"]')?.getAttribute('data-value')).toBe('oc_other')
  expect(f.calls.filter(call => call.method === 'connection.bind' || call.method === 'connection.grant')).toHaveLength(0)
  expect(f.platformCalls.some(call => call.url?.endsWith('/chats/oc_other/members'))).toBe(true)
  await consent(); await f.button('Connect group'); await ready('Connection saved')
  const binding = (await f.services.connections.bindings!.list({})).bindings[0]!
  expect(binding).toMatchObject({ connectionId: f.config.connectionId, externalConversationId: 'oc_other', scope: { publication: 'future-shared-conversation' } })
  const row = document.querySelector<HTMLElement>(`[data-member-row='["open_id","ou_original"]']`)!
  expect(row?.textContent).toContain('Original person')
  expect(f.calls.filter(call => call.method === 'connection.grant')).toHaveLength(0)
  await act(async () => { const source = row.querySelector('select')!; source.value = 'room'; source.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => row.querySelector<HTMLInputElement>('[aria-label="Send requests for Original person"]')!.click())
  await f.button('Save for this group')
  await vi.waitFor(async () => { await act(async () => {}); expect(row.dataset.memberState).toBe('saved'); expect(f.calls.some(call => call.method === 'connection.grant' && call.result)).toBe(true) })
  const receipt = await f.cli(['binding', 'inspect', '--binding', binding.bindingId])
  expect(receipt.grants).toMatchObject([{ actor: { application: f.config.application, idType: 'open_id', userId: 'ou_original' }, capabilities: ['input'] }])
  expect(f.platformCalls.some(call => call.method === 'POST')).toBe(false)
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
  await f.original.unchanged()
}, 25_000)


it('the shared header retains its exact default-Host group and healthy input through a later name observation failure', async () => {
  const originalNative = native; let failed = false
  native = async request => {
    if (request.url?.endsWith('/chats/oc_other')) {
      if (failed) throw new Error('Controlled name read unavailable')
      return { code: 0, data: { name: 'Design review', chat_status: 'normal', chat_mode: 'group' } }
    }
    return await originalNative(request)
  }
  await f.mount(); const editor = document.querySelector<HTMLElement>('[data-workbench-region-id="original-region"] [role="textbox"]')!
  await f.journey('existing'); await chooseGroup('oc_other'); await consent(); await f.button('Connect group'); await ready('Connection saved'); await f.button('Close')
  await vi.waitFor(async () => { await act(async () => {}); expect(channelEntries()).toHaveLength(2); for (const entry of channelEntries()) expect(entry.title).toContain('Design review') })
  const binding = (await f.services.connections.bindings!.list({})).bindings[0]!, counts = f.calls.length
  await act(async () => useAppStore.setState(state => ({ sessions: [...state.sessions, ...Array.from({ length: 250 }, (_, index) => composerSession('unrelated-name-' + index))] })))
  await act(async () => {}); expect(f.calls).toHaveLength(counts)
  failed = true
  await api.connections.call('connection.metadata.refresh', { connectionId: f.config.connectionId, expectedConnectionRevision: 1, subject: { kind: 'conversation', externalConversationId: 'oc_other' } })
  await api.connections.call('connection.binding.pause', { operationId: 'pause-named-audience', bindingId: binding.bindingId, expectedRevision: binding.revision })
  await act(async () => { editor.focus(); invalidateConnectorTarget(binding) })
  await vi.waitFor(async () => { await act(async () => {}); for (const entry of channelEntries()) { expect(entry.title).toContain('Design review') } })
  expect(document.querySelector('[data-workbench-region-id="original-region"] [role="textbox"]')).toBe(editor); expect(document.activeElement).toBe(editor)
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
  expect(f.calls.filter(call => call.method === 'connection.room.get').every(call => (call.input as { externalConversationId: string }).externalConversationId === 'oc_other')).toBe(true)
  await openConnectionsMenu('original-region', 'feishu')
  await vi.waitFor(() => {
    expect(document.querySelector('[data-connection-action="resume"]')?.textContent).toContain('Resume group sync')
    expect(document.querySelector('.connector-header-menu__diagnostics')?.textContent).toContain('Group name update unavailable')
    expect(document.querySelector('[data-problem-kind="sharing-paused"]')?.textContent).toContain('Group sharing is paused')
  })
  const originalGroup = [...document.querySelectorAll<HTMLElement>('.connector-header-menu__item')].find(node => node.title.split(' · ').includes('oc_other'))!
  expect(originalGroup).toBeDefined()
  await act(async () => originalGroup.click())
  await ready('Join this group'); expect(document.querySelector('.agent-connector-identity [data-executor-id]')?.getAttribute('data-executor-id')).toBe(f.session.kind === 'agent' ? f.session.executorId : null)
  expect((await f.cli(['binding', 'inspect', '--binding', binding.bindingId])).binding).toMatchObject({ externalConversationId: 'oc_other', state: 'paused' })
  await f.original.unchanged()
}, 25_000)

it('search and pagination use the exact application and native cursor while unnamed groups retain their original identity', async () => {
  native = async request => {
    if (request.url?.endsWith('/chats/search')) return { code: 0, data: { items: [{ chat_id: 'oc_unnamed', chat_status: 'normal' }], has_more: request.params?.page_token !== 'original-next', page_token: 'original-next' } }
    return { code: 0, data: { items: [], has_more: false } }
  }
  await f.mount(); await f.journey('existing'); await ready('No groups found')
  await f.fill('Search groups', 'Exact search'); await f.button('Search'); await ready('More groups')
  await f.button('More groups')
  await vi.waitFor(async () => { await act(async () => {}); expect(f.platformCalls.filter(call => call.url?.endsWith('/chats/search'))).toHaveLength(2) })
  const calls = f.platformCalls.filter(call => call.url?.endsWith('/chats/search'))
  expect(calls.map(call => call.params)).toMatchObject([{ query: 'Exact search', page_size: 20 }, { query: 'Exact search', page_size: 20, page_token: 'original-next' }])
  await chooseGroup('oc_unnamed')
  expect(document.querySelector('[aria-label="Agent and group conversation"] [aria-label="Existing group"]')?.getAttribute('data-value')).toBe('oc_unnamed')
  expect(document.querySelector('[aria-label="Agent and group conversation"] [aria-label="Existing group"]')?.textContent).toContain('oc_unnamed')
  expect(f.calls.filter(call => call.method === 'connection.room.search').every(call => (call.input as { connectionId: string; expectedConnectionRevision: number }).connectionId === f.config.connectionId && (call.input as { expectedConnectionRevision: number }).expectedConnectionRevision === 1)).toBe(true)
  expect(f.calls.some(call => call.method === 'connection.bind')).toBe(false)
  await f.original.unchanged()
}, 25_000)

it('an unavailable directory preserves the explicit exact-ID path and healthy original input without inventing members', async () => {
  native = async () => { throw new Error('Controlled unavailable transport') }
  await f.mount(); await f.journey('existing'); await ready('Groups could not be read')
  await f.fill('Existing group ID', 'oc_exact'); await ready('Group members are not confirmed')
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Original person')
  expect(f.calls.some(call => call.method === 'connection.grant' || call.method === 'connection.room.link.create')).toBe(false)
  await consent(); await f.button('Connect group'); await ready('Connection saved')
  expect((await f.services.connections.bindings!.list({})).bindings[0]?.externalConversationId).toBe('oc_exact')
  await f.original.unchanged()
}, 25_000)

it('returning to the same exact group starts a new reading occurrence and ignores its earlier late member page', async () => {
  const originalNative = native; let originalReads = 0, release!: (value: unknown) => void
  const late = new Promise<unknown>(resolve => { release = resolve })
  native = async request => {
    if (request.url?.endsWith('/oc_original/members')) {
      if (++originalReads === 1) return await late
      return { code: 0, data: { items: [{ member_id_type: 'open_id', member_id: 'ou_current', name: 'Current person' }], has_more: false } }
    }
    return await originalNative(request)
  }
  await f.mount(); await f.journey('existing'); await chooseGroup('oc_original')
  await vi.waitFor(() => expect(originalReads).toBe(1))
  await chooseGroup('oc_other'); await ready('Original person')
  await chooseGroup('oc_original'); await ready('Current person')
  release({ code: 0, data: { items: [{ member_id_type: 'open_id', member_id: 'ou_old', name: 'Earlier person' }], has_more: false } })
  await vi.waitFor(async () => { await act(async () => {}); expect(f.calls.filter(call => call.method === 'connection.room.members' && call.result && (call.input as { externalConversationId: string }).externalConversationId === 'oc_original')).toHaveLength(2) })
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Current person')
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Earlier person')
  expect(f.calls.some(call => call.method === 'connection.grant')).toBe(false); await f.original.unchanged()
}, 25_000)

it('an explicit join link freezes the original intent before the SDK effect and remains distinct from membership, Binding and chat permission', async () => {
  const originalNative = native
  let claimed = false
  native = async request => {
    if (request.url?.endsWith('/link')) {
      const intent = Object.values(useAppStore.getState().connectorRoomIntents).find(value => value.method === 'connection.room.link.create')!
      expect(intent, 'original durable link intent exists before the SDK effect').toBeDefined()
      expect(intent.phase).toBe('may-have-dispatched')
      expect(JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state.connectorRoomIntents[intent.input.operationId]).toEqual(intent)
      const row = f.services.database!.prepare('SELECT operation_json FROM connection_room_link_operation WHERE operation_id=?').get(intent.input.operationId)
      claimed = JSON.parse(String(row!.operation_json)).state === 'dispatching'
      expect(claimed).toBe(true)
      expect(request.data).toEqual({ validity_period: 'week' })
    }
    return await originalNative(request)
  }
  const open = vi.spyOn(api.ui, 'openExternal').mockResolvedValue(undefined), copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await f.mount(); await f.journey('existing'); await chooseGroup('oc_other')
  expect(f.platformCalls.some(call => call.url?.endsWith('/link'))).toBe(false)
  await f.button('Create join link'); await ready('Join link ready')
  expect(claimed).toBe(true); expect(open).not.toHaveBeenCalled(); expect(copy).not.toHaveBeenCalled()
  const intent = Object.values(useAppStore.getState().connectorRoomIntents).find(value => value.method === 'connection.room.link.create')!
  expect(intent, 'original link intent exists').toBeDefined()
  const receipt = (await f.cli(['room', 'link', 'inspect', '--operation-id', intent.input.operationId])).operation
  expect(receipt).toMatchObject({ state: 'confirmed', input: { operationId: intent.input.operationId, connectionId: f.config.connectionId, expectedConnectionRevision: 1, externalConversationId: 'oc_other' } })
  expect(f.calls.some(call => call.method === 'connection.bind' || call.method === 'connection.grant')).toBe(false)
  expect((await f.services.connections.bindings!.list({})).bindings).toHaveLength(0)
  await f.button('Copy join link'); await ready('Join link copied'); expect(copy).toHaveBeenCalledWith(receipt.link.url)
  await f.button('Open join link'); await ready('Membership and Agent access still need confirmation'); expect(open).toHaveBeenCalledWith(receipt.link.url)
  await f.button('Check link status'); await ready('Join link ready')
  expect(f.platformCalls.filter(call => call.url?.endsWith('/link'))).toHaveLength(1)
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中'); await f.original.unchanged()
}, 25_000)

it('a lost join-link response and persisted Dialog remount inspect the same original effect without claiming people joined', async () => {
  vi.mocked(api.connections.call).mockImplementation(async (method, input) => { const value = await f.forward(method, input); if (method === 'connection.room.link.create') throw new Error('Original response was lost'); return value })
  await f.mount(); await f.journey('existing'); await chooseGroup('oc_other'); await f.button('Create join link'); await ready('Setup is not confirmed')
  const intent = Object.values(useAppStore.getState().connectorRoomIntents).find(value => value.method === 'connection.room.link.create')!, persisted = localStorage.getItem('agentmux-workbench-v1')!
  expect(intent, 'submitted link intent exists before remount').toBeDefined()
  await f.dom.render(null); useAppStore.setState({ connectorRoomIntents: {} }); localStorage.setItem('agentmux-workbench-v1', persisted); await useAppStore.persist.rehydrate()
  expect(useAppStore.getState().connectorRoomIntents[intent.input.operationId]).toEqual(intent)
  await f.mount(); await f.journey('existing'); await ready('Join link ready')
  expect(document.querySelector('[aria-label="Agent and group conversation"] [aria-label="Existing group"]')?.getAttribute('data-value')).toBe('oc_other')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Your own membership is not verified here')
  await f.button('Check link status'); await ready('Join link ready')
  expect(f.calls.filter(call => call.method === 'connection.room.link.create')).toHaveLength(1)
  expect(f.calls.filter(call => call.method === 'connection.room.link.inspect').every(call => (call.input as { operationId: string }).operationId === intent.input.operationId)).toBe(true)
  expect(f.platformCalls.filter(call => call.url?.endsWith('/link'))).toHaveLength(1)
  expect((await f.services.connections.bindings!.list({})).bindings).toHaveLength(0); await f.original.unchanged()
}, 25_000)

it('an unknown original link stays inspect-only after closing, reopening and explicit checking', async () => {
  const originalNative = native
  native = async request => { if (request.url?.endsWith('/link')) throw new Error('Controlled unknown link outcome'); return await originalNative(request) }
  await f.mount(); await f.journey('existing'); await chooseGroup('oc_original'); await f.button('Create join link')
  await vi.waitFor(async () => { await act(async () => {}); expect((f.calls.find(call => call.method === 'connection.room.link.create')?.result as { state?: string })?.state).toBe('unknown'); expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-busy')).toBe('false') })
  const intent = Object.values(useAppStore.getState().connectorRoomIntents).find(value => value.method === 'connection.room.link.create')!
  expect(intent, 'unknown original link correlation remains').toBeDefined()
  const reads = f.calls.filter(call => call.method === 'connection.room.link.inspect').length
  await f.button('Close'); await f.journey('existing')
  await vi.waitFor(async () => { await act(async () => {}); expect(f.calls.filter(call => call.method === 'connection.room.link.inspect' && call.result).length).toBeGreaterThan(reads); expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-busy')).toBe('false') })
  // Exercise any accidentally offered new effect before asserting the correct presentation.
  const fresh = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === 'Create join link')
  if (fresh) { await act(async () => fresh.click()); await vi.waitFor(() => expect(f.calls.filter(call => call.method === 'connection.room.link.create').length).toBeGreaterThan(1)) }
  expect(f.calls.filter(call => call.method === 'connection.room.link.create')).toHaveLength(1)
  expect(f.platformCalls.filter(call => call.url?.endsWith('/link'))).toHaveLength(1)
  expect([...document.querySelectorAll('button')].some(button => button.textContent === 'Save and continue')).toBe(false)
  await f.button('Check link status'); await ready('Join link result not confirmed')
  expect((await f.cli(['room', 'link', 'inspect', '--operation-id', intent.input.operationId])).operation.state).toBe('unknown')
  expect(f.calls.filter(call => call.method === 'connection.room.link.inspect').every(call => (call.input as { operationId: string }).operationId === intent.input.operationId)).toBe(true)
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Join link ready'); await f.original.unchanged()
}, 25_000)

it('a positively unsent link intent survives a save failure and explicitly continues with the same original request', async () => {
  await f.mount(); await f.journey('existing'); await chooseGroup('oc_other')
  const storage = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('Controlled original storage write failure') })
  await f.button('Create join link'); await ready('No request was sent')
  const intent = Object.values(useAppStore.getState().connectorRoomIntents).find(value => value.method === 'connection.room.link.create')!
  expect(intent, 'exact unsent intent is kept').toBeDefined(); expect(intent.phase).toBe('not-dispatched')
  expect(f.calls.some(call => call.method === 'connection.room.link.create')).toBe(false)
  expect(f.platformCalls.some(call => call.url?.endsWith('/link'))).toBe(false)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Join link has not been sent')
  storage.mockRestore()
  await f.button('Save and continue'); await vi.waitFor(() => expect(f.calls.filter(call => call.method === 'connection.room.link.create')).toHaveLength(1)); await ready('Join link ready')
  const [effect] = f.calls.filter(call => call.method === 'connection.room.link.create')
  expect(effect?.input).toEqual(intent.input)
  expect(f.platformCalls.filter(call => call.url?.endsWith('/link'))).toHaveLength(1)
  expect((await f.cli(['room', 'link', 'inspect', '--operation-id', intent.input.operationId])).operation.state).toBe('confirmed')
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中'); await f.original.unchanged()
}, 25_000)

it('a known refused link can be explicitly regenerated after repair using the current revision while its old receipt stays inspectable', async () => {
  const originalNative = native; let attempts = 0
  native = async request => request.url?.endsWith('/link') && ++attempts === 1 ? { code: 232064, msg: 'Controlled pre-effect permission refusal' } : await originalNative(request)
  await f.mount(); await f.journey('existing'); await chooseGroup('oc_other'); await f.button('Create join link'); await ready('Join link could not be created'); await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('[role=dialog]')?.getAttribute('aria-busy')).toBe('false') })
  const original = Object.values(useAppStore.getState().connectorRoomIntents).find(value => value.method === 'connection.room.link.create')!
  expect(original, 'known refused original intent remains').toBeDefined()
  expect((await f.cli(['room', 'link', 'inspect', '--operation-id', original.input.operationId])).operation.state).toBe('refused')
  await f.button('Close')
  const credential = await f.services.secrets.store({ operationId: 'repair-original-link-credential', secret: 'controlled-replacement-credential' })
  await f.services.connections.configure({ operationId: 'repair-original-link-connection', expectedRevision: 1, connection: { ...f.config, credentialRef: credential.credentialRef } })
  await f.journey('existing'); await ready('Join link could not be created'); await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('[role=dialog]')?.getAttribute('aria-busy')).toBe('false') })
  await f.button('Generate a new join link')
  await vi.waitFor(() => expect(f.calls.filter(call => call.method === 'connection.room.link.create')).toHaveLength(2))
  const effects = f.calls.filter(call => call.method === 'connection.room.link.create'), latest = effects[1]!.input as { operationId: string }
  expect(latest.operationId).not.toBe(original.input.operationId)
  expect(useAppStore.getState().connectorRoomIntents[latest.operationId]).toMatchObject({ replacesOperationId: original.input.operationId })
  expect(latest).toMatchObject({ connectionId: f.config.connectionId, expectedConnectionRevision: 2, externalConversationId: 'oc_other' }); await ready('Join link ready')
  expect((await f.cli(['room', 'link', 'inspect', '--operation-id', original.input.operationId])).operation.state).toBe('refused')
  expect((await f.cli(['room', 'link', 'inspect', '--operation-id', latest.operationId])).operation.state).toBe('confirmed')
  expect(f.platformCalls.filter(call => call.url?.endsWith('/link'))).toHaveLength(2)
  expect(Object.keys(useAppStore.getState().connectorRoomIntents)).toContain(original.input.operationId)
  await f.original.unchanged()
}, 25_000)

it('a confirmed link is explicitly replaced without a clock inference and its new unknown head remains inspect-only after remount', async () => {
  await f.mount(); await f.journey('existing'); await chooseGroup('oc_other'); await f.button('Create join link'); await ready('Join link ready'); await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('[role=dialog]')?.getAttribute('aria-busy')).toBe('false') })
  const original = Object.values(useAppStore.getState().connectorRoomIntents).find(value => value.method === 'connection.room.link.create')!
  expect(document.querySelector('[aria-label="Joining this group"]')).not.toBeNull()
  expect(document.querySelector('[aria-label="Joining this group"]')!.closest('details:not([open])')).toBeNull()
  const originalNative = native
  native = async request => { if (request.url?.endsWith('/link')) throw new Error('Controlled replacement outcome unknown'); return await originalNative(request) }
  await f.button('Generate a new join link')
  await vi.waitFor(async () => { await act(async () => {}); expect(f.calls.filter(call => call.method === 'connection.room.link.create')).toHaveLength(2); expect((f.calls.filter(call => call.method === 'connection.room.link.create')[1]!.result as { state?: string })?.state).toBe('unknown'); expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-busy')).toBe('false') })
  const latest = f.calls.filter(call => call.method === 'connection.room.link.create')[1]!.input as { operationId: string }
  expect(document.querySelector('[aria-label="Joining this group"]')).not.toBeNull()
  expect(document.querySelector('[aria-label="Joining this group"]')!.closest('details:not([open])'), 'changing the original operation keeps joining actions visible').toBeNull()
  expect(latest.operationId).not.toBe(original.input.operationId)
  expect(useAppStore.getState().connectorRoomIntents[latest.operationId]).toMatchObject({ replacesOperationId: original.input.operationId })
  const persisted = localStorage.getItem('agentmux-workbench-v1')!
  await f.dom.render(null); useAppStore.setState({ connectorRoomIntents: {} }); localStorage.setItem('agentmux-workbench-v1', persisted); await useAppStore.persist.rehydrate()
  expect(useAppStore.getState().connectorRoomIntents[latest.operationId]).toMatchObject({ replacesOperationId: original.input.operationId })
  const reads = f.calls.filter(call => call.method === 'connection.room.link.inspect' && (call.input as { operationId: string }).operationId === latest.operationId).length
  await f.mount(); await f.journey('existing')
  await vi.waitFor(async () => { await act(async () => {}); expect(f.calls.filter(call => call.method === 'connection.room.link.inspect' && call.result && (call.input as { operationId: string }).operationId === latest.operationId).length).toBeGreaterThan(reads) })
  const fresh = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === 'Generate a new join link')
  if (fresh) { await act(async () => fresh.click()); await vi.waitFor(() => expect(f.calls.filter(call => call.method === 'connection.room.link.create').length).toBeGreaterThan(2)) }
  expect(f.calls.filter(call => call.method === 'connection.room.link.create')).toHaveLength(2)
  await ready('Join link result not confirmed')
  expect([...document.querySelectorAll('button')].some(button => button.textContent === 'Generate a new join link' || button.textContent === 'Create join link' || button.textContent === 'Save and continue')).toBe(false)
  await f.button('Check link status'); await ready('Join link result not confirmed'); await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('[role=dialog]')?.getAttribute('aria-busy')).toBe('false') })
  const previous = [...document.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === 'Previous join link receipt')!
  expect(previous, 'original link receipt remains reachable').toBeDefined()
  await act(async () => { previous.querySelector('summary')!.click(); previous.querySelector<HTMLButtonElement>('button')!.click() })
  await vi.waitFor(() => expect(f.calls.filter(call => call.method === 'connection.room.link.inspect').at(-1)?.input).toEqual({ operationId: original.input.operationId }))
  await vi.waitFor(async () => { await act(async () => {}); expect(previous.textContent).toContain('Result · confirmed'); expect(previous.textContent).toContain('Valid until'); expect(previous.textContent).toContain('https://applink.feishu.cn/') })
  expect(f.platformCalls.filter(call => call.url?.endsWith('/link'))).toHaveLength(2)
  expect((await f.cli(['room', 'link', 'inspect', '--operation-id', original.input.operationId])).operation.state).toBe('confirmed')
  expect((await f.cli(['room', 'link', 'inspect', '--operation-id', latest.operationId])).operation.state).toBe('unknown')
  await f.original.unchanged()
}, 25_000)
