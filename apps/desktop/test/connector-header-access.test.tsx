// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { invalidateConnectorTarget } from '../src/renderer/src/lib/connector-room-intent'
import { composerSession } from './helpers/composer-dom-fixture'
import { ConnectorRoomJoinLink } from '../src/renderer/src/components/ConnectorRoomJoinLink'

const f = connectorJourneyFixture({ platform: async request => {
  if (request.url?.endsWith('/link')) return { code: 0, data: { share_link: 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=header-join', expire_time: String(Math.floor(Date.now() / 1000) + 300), is_permanent: false } }
  if (request.url?.endsWith('/members')) return { code: 0, data: { items: [], has_more: false } }
  if (request.url?.endsWith('/chats') || request.url?.endsWith('/chats/search')) return { code: 0, data: { items: [], has_more: false } }
  return { code: 0, data: { name: 'Original team', chat_status: 'normal', chat_mode: 'group' } }
} })
const target = { executionHostId: 'local', agentSessionId: 'original-agent', regionAnchor: { regionId: 'original-region' } }
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 6000 }) }
const header = () => document.querySelector<HTMLElement>('[data-workbench-region-id="original-region"] .agent-region-header')!
const trigger = () => header().querySelector<HTMLButtonElement>('.agent-region-header__connector')!
async function bind() {
  await f.mount(); await f.journey('existing'); await f.fill('Existing group ID', 'oc_header')
  await act(async () => document.querySelector<HTMLInputElement>('.agent-connector-check input')!.click())
  await f.button('Connect group'); await wait(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Group saved'))
  await f.button('Close'); await wait(() => expect(trigger()?.textContent).toBe('Sharing on'))
  return (await f.services.connections.bindings!.list({})).bindings[0]!
}

it('the actual Terminal header opens its exact original group and joining section, and only explicit link creation produces its QR', async () => {
  const binding = await bind()
  expect(trigger().getAttribute('aria-label')).toContain('Feishu group and joining details')
  expect(trigger().getAttribute('title')).toContain('oc_header')
  expect(trigger().querySelector('img')).not.toBeNull()
  const writes = f.platformCalls.filter(call => call.method === 'POST').length
  await act(async () => trigger().click())
  await wait(() => expect(document.querySelector<HTMLDetailsElement>('details[aria-label="Joining this group"]')?.open).toBe(true))
  const joining = document.querySelector<HTMLDetailsElement>('details[aria-label="Joining this group"]')!
  const access = [...document.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === 'Manage member access')!
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Join with your chat account')
  expect(access.open, 'Joining is primary; member authorization stays available on demand').toBe(false)
  expect(joining.compareDocumentPosition(access) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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
  await wait(() => expect(document.querySelector<HTMLDetailsElement>('details[aria-label="Joining this group"]')?.open).toBe(true))
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
