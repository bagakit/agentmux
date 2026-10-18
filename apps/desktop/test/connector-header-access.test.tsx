// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { api } from '../src/renderer/src/lib/api'
import { retainConnectorRoomIntent, useAppStore } from '../src/renderer/src/store'
import { observeConnectorService } from '../src/renderer/src/lib/connector-service-observation'
import { invalidateConnectorTarget } from '../src/renderer/src/lib/connector-room-intent'
import { composerSession } from './helpers/composer-dom-fixture'
import { ConnectorRoomJoinLink } from '../src/renderer/src/components/ConnectorRoomJoinLink'

const f = connectorJourneyFixture({ platform: async request => {
  if (request.url?.endsWith('/chats') && request.method?.toUpperCase() === 'POST') return { code: 0, data: { chat_id: 'oc_header_created' } }
  if (request.url?.endsWith('/link')) return { code: 0, data: { share_link: 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=header-join', expire_time: String(Math.floor(Date.now() / 1000) + 300), is_permanent: false } }
  if (request.url?.endsWith('/members')) return { code: 0, data: { items: [], has_more: false } }
  if (request.url?.endsWith('/chats') || request.url?.endsWith('/chats/search')) return { code: 0, data: { items: [], has_more: false } }
  return { code: 0, data: { name: 'Original team', chat_status: 'normal', chat_mode: 'group' } }
} })
const target = { executionHostId: 'local', agentSessionId: 'original-agent', regionAnchor: { regionId: 'original-region' } }
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 6000 }) }
const header = () => document.querySelector<HTMLElement>('[data-workbench-region-id="original-region"] .agent-region-header')!
const trigger = () => header().querySelector<HTMLButtonElement>('.agent-region-header__connector')!
const writes = () => f.calls.filter(call => ['connection.configure', 'connection.service.configure', 'connection.room.create', 'connection.room.link.create', 'connection.bind', 'connection.binding.relink', 'connection.binding.pause', 'connection.grant'].includes(call.method))
async function close() { await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close group setup"]')!.click()) }
async function bind() {
  await f.mount(); await f.journey('existing'); await f.fill('Existing group ID', 'oc_header')
  await act(async () => document.querySelector<HTMLInputElement>('.agent-connector-check input')!.click())
  await f.button('Connect group'); await wait(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Group saved'))
  await f.button('Close'); await wait(() => expect(trigger()?.textContent).toBe('Group connected'))
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
    await f.mount(); await wait(() => expect(trigger()?.textContent).toBe('Connect group'))
    expect(trigger().getAttribute('aria-busy')).toBe('true'); expect(trigger().disabled).toBe(false)
    await act(async () => trigger().click())
    await wait(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
  } finally { await act(async () => { for (const release of pending) release() }); vi.mocked(api.connections.call).mockImplementation(f.forward) }
  await wait(() => expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value).toBe(f.config.connectionId))
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Other setup')
  await close(); await wait(() => expect(trigger()?.textContent).toBe('Connect group'))
  expect(writes()).toHaveLength(0)
  expect(Object.keys(useAppStore.getState().connectorRoomIntents)).toEqual(['foreign-session-setup', 'foreign-host-setup'])
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
  await f.original.unchanged()
}, 25_000)

it('the header continues its created but unbound group with the original request through close, reopen and a failed binding read', async () => {
  await f.mount(); await wait(() => expect(trigger()?.textContent).toBe('Connect group'))
  await act(async () => trigger().click())
  await wait(() => expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value).toBe(f.config.connectionId))
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="New group"]')!.click())
  await f.fill('Group name', 'Original header setup'); await f.button('Create group')
  await wait(() => expect(f.calls.find(call => call.method === 'connection.room.create')?.result).toMatchObject({ creation: { state: 'created', externalConversationId: 'oc_header_created' } }))
  const original = f.calls.find(call => call.method === 'connection.room.create')!.input as { operationId: string }
  await close(); await wait(() => expect(trigger()?.textContent).toBe('Continue group setup'))
  await act(async () => trigger().click())
  await wait(() => expect(f.calls.some(call => call.method === 'connection.room.inspect' && (call.input as { operationId: string }).operationId === original.operationId)).toBe(true))
  await wait(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('oc_header_created'))
  await close()
  vi.mocked(api.connections.call).mockImplementation(async (method, input) => { if (method === 'connection.binding.ls') throw Error('Controlled binding observation failure'); return f.forward(method, input) })
  await act(async () => invalidateConnectorTarget(target))
  await wait(() => expect(trigger()?.textContent).toBe('Continue group setup · Status unknown'))
  await act(async () => trigger().click()); await wait(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
  expect(useAppStore.getState().connectorRoomIntents[original.operationId]?.input).toEqual(original)
  expect(writes().map(call => call.method)).toEqual(['connection.room.create'])
  expect(f.platformCalls.filter(call => call.method?.toUpperCase() === 'POST' && call.url?.endsWith('/chats'))).toHaveLength(1)
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
  await f.original.unchanged()
}, 25_000)

it('bound header status separates saved binding from source-qualified automatic sync without dispatching effects', async () => {
  await bind()
  expect(trigger().textContent).toBe('Group connected')
  const off = await api.connections.call('connection.service.configure', { operationId: 'header-sync-off', expectedRevision: 0, service: { enabled: false } })
  const count = writes().length
  await act(async () => observeConnectorService(off.service))
  expect(trigger().textContent).toBe('Sync off')
  expect(trigger().title).toContain('Group binding is saved locally.')
  expect(trigger().title).toContain('Automatic chat sync is off.')
  await act(async () => useAppStore.setState({ connectorServiceObservation: { source: (async () => { throw Error('Other endpoint') }) as typeof api.connections.call, generation: 1, state: { enabled: false, revision: 3 }, issue: '' } }))
  expect(trigger().textContent).toBe('Group connected')
  expect(trigger().title).toContain('Automatic chat sync is not confirmed.')
  expect(writes()).toHaveLength(count)
  await f.original.unchanged()
}, 25_000)

it('the actual Terminal header opens its exact original group and joining section, and only explicit link creation produces its QR', async () => {
  const binding = await bind()
  expect(trigger().getAttribute('aria-label')).toContain('Feishu group and joining details')
  expect(trigger().getAttribute('title')).toContain('oc_header')
  expect(trigger().querySelector('img')).not.toBeNull()
  const writes = f.platformCalls.filter(call => call.method === 'POST').length
  await act(async () => trigger().click())
  await wait(() => expect(document.querySelector('[aria-label="Joining this group"]')).not.toBeNull())
  const joining = document.querySelector<HTMLElement>('[aria-label="Joining this group"]')!
  expect(joining.closest('details:not([open])'), 'Joining actions are directly available').toBeNull()
  expect(joining.textContent).toContain('Create join link')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Join with your chat account')
  expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value).toBe(binding.connectionId)
  expect(f.calls.filter(call => call.method === 'connection.binding.inspect').at(-1)?.input).toEqual({ bindingId: binding.bindingId, revision: binding.revision })
  expect(f.platformCalls.filter(call => call.method === 'POST')).toHaveLength(writes)
  expect(f.calls.some(call => call.method === 'connection.room.link.create')).toBe(false)
  await f.button('Create join link')
  await wait(() => expect(document.querySelector('svg[role="img"] title')?.textContent).toBe('Join this group'))
  expect(f.platformCalls.filter(call => call.url?.endsWith('/link'))).toHaveLength(1)
  const originalLink = f.calls.find(call => call.method === 'connection.room.link.create')!
  expect(originalLink.input).toMatchObject({ connectionId: binding.connectionId, externalConversationId: 'oc_header' })
  await f.button('Close'); await act(async () => trigger().click())
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
  await wait(() => expect(trigger().textContent).toBe('Sharing paused'))
  const count = f.calls.filter(call => call.method === 'connection.binding.ls').length
  await act(async () => useAppStore.setState(state => ({ sessions: [...state.sessions, ...Array.from({ length: 200 }, (_, index) => composerSession('unrelated-header-' + index))] })))
  expect(f.calls.filter(call => call.method === 'connection.binding.ls')).toHaveLength(count)
  vi.mocked(api.connections.call).mockImplementation(async (method, input) => { if (method === 'connection.binding.ls') throw new Error('Original audience unavailable'); return f.forward(method, input) })
  const editor = document.querySelector<HTMLElement>('[data-workbench-region-id="original-region"] [role="textbox"]')!
  await act(async () => { editor.focus(); invalidateConnectorTarget(target) })
  await wait(() => expect(trigger().textContent).toBe('Status unknown'))
  expect(trigger().getAttribute('title')).toContain('oc_header'); expect(trigger().disabled).toBe(false)
  expect(document.activeElement).toBe(editor); expect(editor.getAttribute('contenteditable')).toBe('true')
  vi.mocked(api.connections.call).mockImplementation(f.forward)
  await act(async () => trigger().click())
  await wait(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
  await f.button('Close'); await wait(() => expect(trigger().textContent).toBe('Sharing paused'))
  expect(f.original.create).not.toHaveBeenCalled(); await f.original.unchanged()
}, 25_000)

it('a multiple-group header selects the named original application instead of the first Binding', async () => {
  await bind()
  const first = (await f.services.connections.list()).connections[0]!.config
  await api.connections.call('connection.configure', { operationId: 'header-other-application', expectedRevision: null, connection: { ...first, connectionId: 'other-header-connection', application: { ...first.application, appId: 'other-header-app' } } })
  const other = await api.connections.call('connection.bind', { ...f.original.input, operationId: 'header-other-binding', bindingId: 'other-header-binding', connectionId: 'other-header-connection', externalConversationId: 'oc_other_header' })
  expect(other.state).toBe('applied'); await act(async () => invalidateConnectorTarget(target))
  await wait(() => expect(trigger().textContent).toBe('2 groups'))
  await act(async () => { trigger().focus(); trigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  await wait(() => expect(document.querySelectorAll('.connector-header-menu [role="menuitem"]')).toHaveLength(2))
  const item = [...document.querySelectorAll<HTMLElement>('.connector-header-menu [role="menuitem"]')].find(node => node.textContent?.includes('oc_other_header'))!
  expect(item.textContent).toContain('other-header-app')
  await act(async () => item.click())
  await wait(() => expect(document.querySelector<HTMLElement>('[aria-label="Group application"]')?.dataset.value).toBe('other-header-connection'))
  await wait(() => expect(document.querySelector('[aria-label="Joining this group"]')).not.toBeNull())
  expect(f.calls.filter(call => call.method === 'connection.binding.inspect').at(-1)?.input).toEqual({ bindingId: 'other-header-binding', revision: 1 })
  expect(f.platformCalls.some(call => call.method === 'POST')).toBe(false)
  expect(f.settings).not.toHaveBeenCalled(); await f.original.unchanged()
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
