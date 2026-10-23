// @vitest-environment happy-dom
import { act } from 'react'
import { appendFile } from 'node:fs/promises'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
vi.mock('../src/renderer/src/lib/reading-diagnostic-publication', () => ({ publishReadingDiagnostic: () => {} }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { feishuPayload } from '../../../packages/connectors/test/fixtures/feishu'
import { api } from '../src/renderer/src/lib/api'
import { invalidateConnectorTarget } from '../src/renderer/src/lib/connector-room-intent'
import { ConnectorHeaderLinks } from '../src/renderer/src/components/ConnectorHeaderLinks'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { settingsCatalog } from '../src/renderer/src/components/settings/settings-modules'
import { connectorGroupStatus } from '../src/renderer/src/lib/connector-group-status'
import type { RoomBinding } from '@agentmux/core/connections'

let lose = false
beforeEach(() => { lose = false })
const f = connectorJourneyFixture({ publication: true, ingress: true, conversationAuthority: { resolveConversationMessage: input => f.services.ingress!.recordAuthority(input) }, platform: async request => {
  if (request.url?.endsWith('/messages')) {
    if (lose) throw Error('Controlled lost platform response')
    return { code: 0, data: { message_id: 'om_header_original', chat_id: 'oc_header_status', msg_type: 'interactive' } }
  }
  if (request.url?.endsWith('/members')) return { code: 0, data: { items: [], has_more: false } }
  return { code: 0, data: { name: 'Original status group', chat_status: 'normal', chat_mode: 'group' } }
} })
const target = { executionHostId: 'local', agentSessionId: 'original-agent' }
const trigger = () => document.querySelector<HTMLElement>('[data-workbench-region-id="original-region"] .agent-region-header__connector') ?? document.querySelector<HTMLElement>('.agent-region-header__connector')!
const menu = () => document.querySelector<HTMLElement>('.connector-header-menu')!
const checked = () => menu()?.querySelector<HTMLTimeElement>('time')
const writes = () => f.calls.filter(call => /configure|\.bind$|\.relink$|\.pause$|\.grant$|\.create$|\.retry$/.test(call.method)).length
const effects = () => f.platformCalls.filter(call => call.url?.endsWith('/messages')).length
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 8000 }) }
async function open() { await act(async () => { trigger()!.focus(); trigger()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) }); await wait(() => expect(menu()).not.toBeNull()) }
async function check() { await act(async () => [...menu().querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === 'Check group status')!.click()) }
async function bind(shared = false) {
  await f.mount(); await f.journey('existing'); await f.fill('Existing group ID', 'oc_header_status')
  if (shared) {
    await act(async () => { const select = document.querySelector<HTMLElement>('[aria-label="Group sharing content"]')!; select.focus(); select.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
    await act(async () => document.querySelector<HTMLElement>('[role="menuitemradio"][data-value="future-shared-conversation"]')!.click())
  }
  await act(async () => document.querySelector<HTMLInputElement>('.agent-connector-check input')!.click())
  await f.button('Connect group'); await wait(() => expect(f.services.bindings!.listActive()).toHaveLength(1))
  const binding = f.services.bindings!.listActive()[0]!
  await f.button('Close'); await wait(() => expect(trigger()?.textContent).toContain('Original status group'))
  return binding
}
const row = (id: string, type: 'user' | 'assistant') => JSON.stringify({ sessionId: 'original-native', uuid: id, type, message: { role: type, content: [{ type: 'text', text: 'PRIVATE original ' + id }] } }) + '\n'
const speech = (binding: RoomBinding) => f.services.publication!.store.list(binding).filter(value => value.reference.source.kind !== 'binding-operation')
async function renderHeader(bindings: RoomBinding[], visible = true, version = 0) {
  await f.dom.render(<SettingsNavigation.Provider value={{ open() {}, openToolkit() {}, openHost() {}, chooseAgent() {}, openMoteLark() {}, channelPresentation: settingsCatalog.channelPresentation }}>
    <ConnectorHeaderLinks bindings={bindings} visible={visible} nameVersion={version} syncEnabled={true} issue="" checking={false} retainedSetup={false} onOpen={() => {}} onConnect={() => {}} onMenuOpen={() => {}} onSettings={() => {}} />
  </SettingsNavigation.Provider>)
}

it('the actual header diagnoses a source gap separately from older unknown platform effects without writes or replay', async () => {
  const binding = await bind(true); lose = true
  await appendFile(f.original.transcript, row('unknown-original', 'assistant'))
  await wait(() => expect(speech(binding)[0]?.state).toBe('unknown'))
  await appendFile(f.original.transcript, row('public-unconfirmed', 'user'))
  await wait(() => expect(f.services.publication!.observation(binding.bindingId, binding.revision).reason).toBe('content-unconfirmed'))
  const before = { writes: writes(), effects: effects() }
  await open(); await wait(() => expect(trigger().textContent).toContain('Needs attention'))
  await wait(() => expect(menu().textContent).toContain('Content not confirmed'))
  expect(menu().textContent).toContain('content gap')
  expect(menu().textContent).toContain('unconfirmed')
  expect(menu().textContent).toContain('original results remain unconfirmed')
  for (const section of ['Configuration', 'Sharing', 'Conversation → group', 'Platform requests', 'Group → Agent', 'Snapshot of bounded local observations']) expect(menu().textContent).toContain(section)
  expect(f.calls.filter(call => call.method === 'connection.diagnose').at(-1)?.input).toEqual({ ...target, bindingId: binding.bindingId, bindingRevision: binding.revision })
  expect(menu().textContent).not.toContain('PRIVATE')
  await check(); await wait(() => expect(checked()).not.toBeNull())
  expect({ writes: writes(), effects: effects() }).toEqual(before)
  expect(f.calls.some(call => call.method === 'connection.delivery.retry')).toBe(false)
}, 30_000)

it('an empty checked window remains a linked snapshot, and explicit Off and paused stay configuration facts', async () => {
  const binding = await bind(); await open(); await wait(() => expect(checked()).not.toBeNull())
  expect(menu().textContent).toContain('Linked · Sync on · Bot on')
  expect(menu().textContent).toContain('No events in this window')
  expect(trigger().textContent).not.toMatch(/healthy|working|disconnected/i)
  const service = await f.forward('connection.service.get', {})
  await f.forward('connection.service.configure', { operationId: 'header-explicit-off', expectedRevision: service.revision, service: { enabled: false } })
  await check(); await wait(() => expect(trigger().textContent).toContain('Sync off'))
  expect(menu().textContent).toContain('Linked · Sync off')
  const paused = await f.forward('connection.binding.pause', { operationId: 'header-explicit-pause', bindingId: binding.bindingId, expectedRevision: binding.revision })
  await renderHeader([paused.binding!]); await wait(() => expect(trigger().textContent).toContain('Sharing paused'))
  expect(trigger().getAttribute('aria-label')).toContain('oc_header_status')
}, 30_000)

it('a later failed check retains the exact group and earlier observations, with a stable completed-check time and actions', async () => {
  await bind(); await open(); await wait(() => expect(checked()).not.toBeNull())
  const first = checked()!.dateTime, count = f.calls.filter(call => call.method === 'connection.diagnose').length
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
  expect(checked()!.dateTime).toBe(first)
  expect(f.calls.filter(call => call.method === 'connection.diagnose')).toHaveLength(count)
  const original = f.forward
  vi.mocked(api.connections.call).mockImplementation(async (method, input) => { if (method === 'connection.diagnose') throw Error('PRIVATE credential path'); return original(method, input) })
  await check(); await wait(() => expect(trigger().textContent).toContain('Status unknown'))
  expect(checked()!.dateTime).not.toBe(first)
  for (const text of ['Original status group', 'Unavailable', 'Kept after this check failed', 'Connect a conversation', 'Automatic sync settings', 'Check group status']) expect(menu().textContent).toContain(text)
  expect(trigger().getAttribute('aria-disabled')).not.toBe('true')
  expect(menu().textContent).not.toContain('PRIVATE credential path')
  expect(document.querySelector<HTMLTextAreaElement>('.agent-composer textarea')?.disabled).not.toBe(true)
}, 30_000)

it('actual recorded refusal and waiting stay separate from adoption, and typed byte receipts keep their exact presentation', async () => {
  const binding = await bind(); await wait(() => expect(f.ingressTransport!.sockets).toHaveLength(1))
  const payload = feishuPayload({ message_id: 'header-no-access', chat_id: binding.externalConversationId, content: JSON.stringify({ text: 'PRIVATE incoming original' }) })
  payload.header.event_id = 'header-no-access-event'
  await f.ingressTransport!.receive(payload)
  await vi.waitFor(async () => expect((await f.forward('connection.ingress.ls', { connectionId: binding.connectionId })).ingresses.find(value => value.kind !== 'action' && value.externalMessageId === 'header-no-access')?.state).toBe('refused'), { timeout: 8000 })
  await open(); await wait(() => expect(menu().textContent).toContain('Conversation recorded · not sent; member request access missing'))
  await f.forward('connection.grant', { operationId: 'header-explicit-grant', bindingId: binding.bindingId, expectedBindingRevision: binding.revision, grantId: 'header-input', expectedRevision: null,
    actor: { application: f.config.application, idType: 'open_id', userId: 'original-external-user' }, capabilities: ['input'], state: 'active' })
  payload.event.message.message_id = 'header-byte-original'; payload.header.event_id = 'header-byte-event'
  await f.ingressTransport!.receive(payload)
  await vi.waitFor(async () => expect((await f.forward('connection.ingress.ls', { connectionId: binding.connectionId })).ingresses.some(value => value.kind !== 'action' && value.externalMessageId === 'header-byte-original' && value.state === 'claimed')).toBe(true))
  await check(); await wait(() => expect(menu().textContent).toContain('Waiting for Agent'))
  const report = await f.forward('connection.diagnose', { ...target, bindingId: binding.bindingId, bindingRevision: binding.revision })
  const group = report.groups.value!.items[0]!, incoming = group.incoming.value!, original = incoming.rows[0]!
  expect(original).toMatchObject({ recording: { state: 'recorded' }, coreStatus: 'waiting', nativeAdoption: null })
  // Pure presentation cases qualify mapping of the public typed receipt, not new native I/O.
  for (const [coreStatus, text] of [['terminal-confirmed', 'Input sent; Agent acceptance unconfirmed'], ['admitted', 'Accepted by Agent'], ['not-applied', 'Not delivered to Agent']] as const) {
    const snapshot = { report: { ...group, service: report.service, incoming: { value: { ...incoming, rows: [{ ...original, coreStatus }] }, issue: null } }, checkedAt: 1, checking: false }
    expect(connectorGroupStatus(snapshot).rows.find(([label]) => label === 'Group → Agent')?.[1]).toContain(text)
  }
  expect(menu().textContent).not.toContain('PRIVATE incoming original')
}, 30_000)

it('a late old-source and revised-target result cannot replace the checked current original group', async () => {
  const binding = await bind(); await renderHeader([binding]); await wait(() => expect(trigger().textContent).not.toContain('Checking…'))
  let release!: () => void, entered = false
  const held = new Promise<void>(resolve => { release = resolve })
  const old = vi.fn(async (...args: Parameters<typeof api.connections.call>) => { const report = await f.forward(...args); if (args[0] === 'connection.diagnose') { entered = true; await held } return report }) as typeof api.connections.call
  api.connections.call = old; await renderHeader([binding], true, 1); await wait(() => expect(entered).toBe(true))
  const paused = await f.forward('connection.binding.pause', { operationId: 'header-revised-target', bindingId: binding.bindingId, expectedRevision: binding.revision })
  api.connections.call = vi.fn(f.forward) as typeof api.connections.call
  await renderHeader([paused.binding!], true, 2); await open(); await wait(() => expect(checked()).not.toBeNull())
  const accepted = checked()!.dateTime
  expect(menu().textContent).toContain('Sharing paused')
  await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 40)) })
  expect(checked()?.dateTime).toBe(accepted)
  expect(menu().textContent).toContain('Sharing paused')
  expect(menu().textContent).not.toContain('Not checked')
}, 30_000)

it('hidden headers add no diagnosis work and a multi-group projection is explicitly bounded', async () => {
  const binding = await bind(); await renderHeader([binding], false)
  const before = f.calls.filter(call => call.method === 'connection.diagnose').length
  await renderHeader([binding], false, 2)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
  expect(f.calls.filter(call => call.method === 'connection.diagnose')).toHaveLength(before)
  // Additional typed relationship rows test the UI's bound; the real owner truthfully
  // leaves their absent identities unconfirmed. They do not qualify native bindings.
  const bindings = Array.from({ length: 6 }, (_, i) => i === 0 ? binding : { ...binding, bindingId: 'unconfirmed-extra-' + i, externalConversationId: 'oc_extra_' + i })
  const reads = f.calls.filter(call => call.method === 'connection.diagnose').length
  await renderHeader(bindings); await open(); await wait(() => expect(menu().querySelectorAll('time')).toHaveLength(5))
  expect(f.calls.filter(call => call.method === 'connection.diagnose')).toHaveLength(reads + 5)
  expect(menu().textContent).toContain('Only the first 5 groups are checked here')
  expect(menu().querySelectorAll('.connector-header-menu__snapshot')[5]!.textContent).toContain('Not checked')
  expect(f.calls.filter(call => call.method === 'connection.diagnose').slice(reads).every(call => (call.input as typeof target).agentSessionId === target.agentSessionId)).toBe(true)
}, 30_000)
