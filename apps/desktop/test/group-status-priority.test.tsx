// @vitest-environment happy-dom
import { act } from 'react'
import { appendFile, readFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
vi.mock('../src/renderer/src/lib/reading-diagnostic-publication', () => ({ publishReadingDiagnostic: () => {} }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { openConnectionsMenu } from './helpers/connector-header-navigation'
import { feishuPayload } from '../../../packages/connectors/test/fixtures/feishu'
import { AgentConnectorDialog } from '../src/renderer/src/components/AgentConnectorDialog'
import { ConnectorDeliveryDetails } from '../src/renderer/src/components/ConnectorDeliveryDetails'
import { api } from '../src/renderer/src/lib/api'
import { groupTarget, readGroupDiagnosis } from '../src/renderer/src/lib/group-diagnosis'
import { connectorGroupSummary } from '../src/renderer/src/lib/connector-group-status'
import { useAppStore } from '../src/renderer/src/store'
import type { ConnectionResultMap, RoomBinding } from '@agentmux/core/connections'

const groupId = 'oc_priority_original', memberId = 'original-external-user'
let loseNext = false
const f = connectorJourneyFixture({ publication: true, ingress: true, platform: async request => {
  if (request.url?.endsWith('/messages')) {
    if (loseNext) { loseNext = false; throw Error('Controlled original platform response loss') }
    const transform = (request as typeof request & { transformRequest: Array<(data: unknown) => string> }).transformRequest[0]!
    const body = JSON.parse(transform(request.data))
    return { code: 0, data: { message_id: 'om_priority_' + body.uuid, chat_id: groupId, msg_type: body.msg_type } }
  }
  if (request.url?.endsWith('/members')) return { code: 0, data: { items: [{ member_id_type: 'open_id', member_id: memberId, name: 'Original group member' }], has_more: false } }
  return { code: 0, data: { name: 'Original priority group', chat_status: 'normal', chat_mode: 'group' } }
} })
const target = { executionHostId: 'local', agentSessionId: 'original-agent' }
const menu = () => document.querySelector<HTMLElement>('.connector-header-menu')!
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
const activity = () => document.querySelector<HTMLElement>('[aria-label="Group delivery"]')!
const outgoing = (element: Element) => element.querySelector<HTMLElement>('[data-direction="outgoing"]')!
const incoming = (element: Element) => element.querySelector<HTMLElement>('[data-direction="incoming"]')!
const reads = () => f.calls.filter(call => call.method === 'connection.diagnose')
const writeMethods = new Set(['connection.configure', 'connection.credential.store', 'connection.service.configure', 'connection.bind', 'connection.binding.relink', 'connection.binding.pause', 'connection.binding.resume', 'connection.binding.detach', 'connection.grant', 'connection.room.create', 'connection.room.members.add', 'connection.room.link.create', 'connection.delivery.retry'])
const writes = () => f.calls.filter(call => writeMethods.has(call.method)).length
const posts = () => f.platformCalls.filter(call => call.method?.toUpperCase() === 'POST').length
const native = (id: string, type: 'assistant' | 'user') => JSON.stringify({ sessionId: 'original-native', uuid: id, type, message: { role: type, content: [{ type: 'text', text: 'PRIVATE original ' + id }] } }) + '\n'
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
afterEach(() => { loseNext = false; if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll); else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView') })
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 8000 }) }
async function waitPublic(check: () => Promise<void>) { await vi.waitFor(check, { timeout: 8000 }) }
async function bind() {
  const result = await f.forward('connection.bind', { ...f.original.input, operationId: 'priority-original-bind', connectionId: f.config.connectionId, externalConversationId: groupId,
    scope: { input: 'all-messages', publication: 'future-shared-conversation' } })
  expect(result.state).toBe('applied'); if (result.state !== 'applied') throw Error('Original binding required')
  const binding = result.binding
  await f.forward('connection.grant', { operationId: 'priority-member-access', bindingId: binding.bindingId, expectedBindingRevision: binding.revision,
    grantId: 'priority-original-member', expectedRevision: null, actor: { application: binding.application, idType: 'open_id', userId: memberId }, state: 'active', capabilities: ['input', 'answer', 'permission'] })
  await waitPublic(async () => expect((await deliveries(binding)).deliveries.some(item => item.reference.source.kind === 'binding-operation' && item.state === 'confirmed')).toBe(true))
  return binding
}
const deliveries = (binding: RoomBinding) => f.forward('connection.delivery.ls', { connectionId: binding.connectionId, bindingId: binding.bindingId, bindingRevision: binding.revision })
const diagnose = (binding: RoomBinding) => f.forward('connection.diagnose', { ...target, bindingId: binding.bindingId, bindingRevision: binding.revision })
function original(binding: RoomBinding) {
  const session = f.session
  if (session.kind !== 'agent') throw Error('The original fixture must retain its Agent Session')
  return { channel: 'feishu', hostingTarget: f.hostingTarget, target, session, name: session.label!, connectionId: binding.connectionId, bindingId: binding.bindingId }
}
function scrollLeaf() { Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() }) }
async function button(element: Element, label: string) {
  const node = [...element.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)!
  expect(node, label).toBeDefined(); expect(node.disabled).toBe(false)
  await act(async () => node.click())
}

it('prioritizes a real content gap over four confirmed conversation updates and one notice in the header and dialog', async () => {
  const binding = await bind()
  await appendFile(f.original.transcript, [1, 2, 3, 4].map(id => native('confirmed-' + id, 'assistant')).join(''))
  await waitPublic(async () => expect((await deliveries(binding)).deliveries.filter(item => item.reference.source.kind === 'native' && item.state === 'confirmed')).toHaveLength(4))
  await appendFile(f.original.transcript, [1, 2].map(id => native('unqualified-' + id, 'user')).join(''))
  await waitPublic(async () => {
    const group = (await diagnose(binding)).groups.value!.items[0]!
    expect(group.outgoing.value?.coverage?.gaps).toHaveLength(2)
    expect(group.outgoing.value?.deliveries).toHaveLength(5)
  })
  await wait(() => expect(f.ingressTransport!.sockets).toHaveLength(1))
  await f.ingressTransport!.receive({ schema: '2.0', header: { app_id: binding.application.appId, event_type: 'card.action.trigger', event_id: 'priority-unbound-action' },
    event: { operator: { open_id: memberId }, context: { open_chat_id: groupId, open_message_id: 'om_original_action' }, action: { value: { actionRef: 'unknown-original-reference' } } } })
  await waitPublic(async () => expect((await diagnose(binding)).groups.value!.items[0]!.incoming.value?.rows[0]).toMatchObject({ scope: 'group-event', state: 'refused', code: 'INGRESS_ACTION_UNSUPPORTED', inputOperationId: null }))
  const before = { writes: writes(), posts: posts(), transcript: await readFile(f.original.transcript) }
  scrollLeaf(); await f.mount(); await openConnectionsMenu()
  await wait(() => expect(outgoing(menu())?.querySelector('strong')?.textContent).toContain('not shared yet'))
  expect(incoming(menu()).querySelector('strong')?.textContent).toBe('Action not supported')
  expect(menu().textContent).not.toMatch(/Question answer|all input.*broken|PRIVATE original/i)
  const group = [...menu().querySelectorAll<HTMLElement>('.connector-header-menu__item')].find(node => node.title.split(' · ').includes(groupId))!
  const beforeDialogReads = reads().length
  await act(async () => group.click())
  await wait(() => expect(outgoing(activity())?.querySelector('strong')?.textContent).toContain('not shared yet'))
  expect(reads(), 'the dialog retains its one existing diagnosis owner').toHaveLength(beforeDialogReads + 1)
  const direction = outgoing(activity())
  expect(direction.textContent).toMatch(/4 conversation updates delivered/)
  expect(direction.textContent).toMatch(/1 connection notice delivered/)
  expect(direction.textContent).not.toMatch(/5 (?:recent |conversation )?updates delivered/)
  expect(direction.querySelector('button')?.textContent).toBe('View content details')
  expect(incoming(activity()).textContent).toContain('group action')
  expect(incoming(activity()).textContent).not.toContain('Question')
  const configuration = dialog().querySelector('[aria-label="Group connection status"]')!
  expect(activity().compareDocumentPosition(configuration) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(configuration.querySelector('.agent-connector-saved')?.textContent).toMatch(/^Configured:/)
  await button(direction, 'View content details')
  expect(document.activeElement).toBe(activity().querySelector('[data-receipt-section="content"]'))
  await button(incoming(activity()), 'View event details')
  expect(document.activeElement).toBe(activity().querySelector('[data-receipt-section="incoming"]'))
  expect({ writes: writes(), posts: posts() }).toEqual({ writes: before.writes, posts: before.posts })
  expect(await readFile(f.original.transcript)).toEqual(before.transcript)
  expect(useAppStore.getState().agentComposerDrafts[binding.agentSessionId]).toBe('Keep the original draft 中')
  // Typed display contrast only: it does not claim a real Question was adopted.
  const projection = await readGroupDiagnosis(f.forward, groupTarget(binding))
  const event = projection.incoming.value!.rows[0]!
  expect(connectorGroupSummary(projection).incoming.detail).toContain('group event')
  const claimed = structuredClone(projection)
  claimed.incoming.value!.rows = [{ ...event, scope: 'current-binding', state: 'claimed', code: null, codeRecorded: false,
    bindingId: binding.bindingId, bindingRevision: binding.revision, targetConnectionId: binding.connectionId,
    inputOperationId: 'original-action-input', coreStatus: 'admitted', coreObservation: 'observed' }]
  const adopted = connectorGroupSummary(claimed).incoming
  expect(adopted.value).toBe('Accepted by Agent')
  expect(adopted.detail).toContain('original Agent input receipt')
  expect(adopted.detail).not.toMatch(/no Agent input|no.*submission/i)
}, 35_000)

it('opens the original settings section directly and keeps local member edits across disclosure navigation without writes or new diagnosis readers', async () => {
  const binding = await bind(), before = { writes: writes(), posts: posts(), reads: reads().length }
  scrollLeaf()
  await f.dom.render(<AgentConnectorDialog original={original(binding)} mode="details" initialSection="members" onClose={() => {}} returnFocus={() => null} />)
  const members = () => dialog()?.querySelector<HTMLElement>('[data-connection-section="members"][aria-label="Member access"]')!
  await wait(() => expect(document.activeElement).toBe(members()))
  await wait(() => expect(members().querySelector('[data-member-row] strong')?.textContent).toBe('Original group member'))
  await wait(() => expect(activity().querySelector('time')).not.toBeNull())
  const disclosure = members().closest('details')!
  expect(disclosure?.open).toBe(true)
  const send = () => members().querySelector<HTMLInputElement>('[aria-label="Send requests for Original group member"]')!
  expect(send().checked).toBe(true)
  await act(async () => send().click())
  expect(send().checked).toBe(false)
  const navigation = dialog().querySelector('[aria-label="Group connection sections"]')!
  expect(navigation.querySelector('nav'), 'each setting has one entry rather than duplicate navigation').toBeNull()
  await act(async () => disclosure.querySelector('summary')!.click())
  expect(disclosure.open).toBe(false)
  for (const section of ['sharing', 'joining', 'members'] as const) {
    const action = navigation.querySelector<HTMLElement>('[data-connection-panel="' + section + '"] > summary')!
    expect(action, 'original ' + section + ' disclosure is directly reachable').not.toBeNull()
    await act(async () => { action.focus(); action.click() })
    const destination = dialog().querySelector<HTMLElement>('[data-connection-section="' + section + '"]')!
    expect(document.activeElement, 'local disclosure retains keyboard focus on its own control').toBe(action)
    expect(destination.closest('details')?.open).toBe(true)
  }
  expect(send().checked, 'folding settings retains the original unsaved member choice').toBe(false)
  expect(reads()).toHaveLength(before.reads + 1)
  expect({ writes: writes(), posts: posts() }).toEqual({ writes: before.writes, posts: before.posts })
  expect(useAppStore.getState().agentComposerDrafts[binding.agentSessionId]).toBe('Keep the original draft 中')
}, 30_000)

it('keeps a notice-only empty window distinct from conversation success and retains exact earlier unknown receipts after a failed check', async () => {
  const binding = await bind(); scrollLeaf()
  await f.dom.render(<ConnectorDeliveryDetails binding={binding} hostingTarget={f.hostingTarget} />)
  await wait(() => expect(activity().querySelector('time')).not.toBeNull())
  expect(outgoing(activity()).textContent).toMatch(/1 connection notice delivered/)
  expect(outgoing(activity()).textContent).not.toMatch(/conversation updates? delivered/)
  expect(incoming(activity()).textContent).toContain('No events in this window')
  loseNext = true; await appendFile(f.original.transcript, native('unknown-result', 'assistant'))
  await waitPublic(async () => expect((await deliveries(binding)).deliveries.some(item => item.reference.source.kind === 'native' && item.state === 'unknown')).toBe(true))
  await button(activity(), 'Check group activity')
  await wait(() => expect(outgoing(activity()).querySelector('strong')?.textContent).toContain('not confirmed'))
  const before = { writes: writes(), posts: posts() }, forward = f.forward
  // Fail the public transport read; retained facts still come from the real prior owner result.
  vi.mocked(api.connections.call).mockImplementation(async (method, input, host) => { if (method === 'connection.diagnose') throw Error('Private read detail'); return forward(method, input, host) })
  await button(activity(), 'Check group activity')
  await wait(() => expect(activity().querySelector('.connector-traffic-summary__retained')?.textContent).toContain('latest check is incomplete'))
  expect(outgoing(activity()).querySelector('strong')?.textContent).toContain('not confirmed')
  expect(activity().textContent).not.toContain('Private read detail')
  expect({ writes: writes(), posts: posts() }).toEqual(before)
}, 30_000)

it('does not promote an earlier binding refusal into the current Agent input status', async () => {
  const binding = await bind(); await wait(() => expect(f.ingressTransport!.sockets).toHaveLength(1))
  const payload = feishuPayload({ message_id: 'priority-prior-message', chat_id: groupId, content: JSON.stringify({ text: 'Original refused request' }) })
  payload.header.event_id = 'priority-prior-event'; payload.event.sender.sender_id.open_id = 'unapproved-original-member'
  await f.ingressTransport!.receive(payload)
  await waitPublic(async () => expect((await diagnose(binding)).groups.value!.items[0]!.incoming.value?.rows[0]).toMatchObject({ scope: 'current-binding', state: 'refused', code: 'INGRESS_ACTOR_NOT_AUTHORIZED' }))
  const paused = await f.forward('connection.binding.pause', { operationId: 'priority-original-pause', bindingId: binding.bindingId, expectedRevision: binding.revision })
  if (paused.state !== 'applied' || !paused.binding) throw Error('The original pause must be applied')
  const resumed = await f.forward('connection.binding.resume', { operationId: 'priority-original-resume', bindingId: binding.bindingId, expectedRevision: paused.binding.revision })
  if (resumed.state !== 'applied' || !resumed.binding) throw Error('The original resume must be applied')
  const current = resumed.binding
  expect((await diagnose(current)).groups.value!.items[0]!.incoming.value?.rows[0]).toMatchObject({ scope: 'other-binding', state: 'refused' })
  const before = { writes: writes(), posts: posts() }
  await f.dom.render(<ConnectorDeliveryDetails binding={current} hostingTarget={f.hostingTarget} />)
  await wait(() => expect(incoming(activity())?.querySelector('strong')?.textContent).toBe('Earlier connection receipt'))
  expect(incoming(activity()).textContent).toContain('does not confirm the current')
  expect(incoming(activity()).textContent).not.toContain('Member request was refused')
  expect(activity().querySelector('[data-problem-kind="request-refused"]')).toBeNull()
  expect({ writes: writes(), posts: posts() }).toEqual(before)
}, 30_000)

it('keeps an explicitly unsupported joining contribution visible in the original disclosure without issuing a link request', async () => {
  const binding = await bind(), before = { writes: writes(), posts: posts() }, forward = f.forward
  // A public presentation leaf supplies an explicitly unsupported contribution.
  // All binding, diagnosis and member reads still reach the original Host owner.
  vi.mocked(api.connections.call).mockImplementation(async (method, input, host) => {
    const result = await forward(method, input, host)
    if (method !== 'connection.ls') return result
    const records = result as ConnectionResultMap['connection.ls']
    return { ...records, connections: records.connections.map(record => {
      if (record.config.connectionId !== binding.connectionId) return record
      if (!record.capabilities) throw Error('The original platform contribution must be observed')
      return { ...record, capabilities: { ...record.capabilities, roomLink: false } }
    }) }
  })
  scrollLeaf()
  await f.dom.render(<AgentConnectorDialog original={original(binding)} mode="details" initialSection="joining" onClose={() => {}} returnFocus={() => null} />)
  const disclosure = () => dialog()?.querySelector<HTMLDetailsElement>('[data-connection-panel="joining"]')!
  await wait(() => expect(disclosure()?.querySelector('summary')?.textContent).toContain('Not supported'))
  expect(disclosure().open).toBe(true)
  expect(disclosure().querySelector('summary')?.textContent).not.toContain('Link & code')
  expect(disclosure().textContent).toContain('Joining links are unavailable')
  expect(document.activeElement).toBe(disclosure().querySelector('[data-connection-section="joining"]'))
  expect({ writes: writes(), posts: posts() }).toEqual(before)
  expect(f.calls.some(call => call.method === 'connection.room.link.create')).toBe(false)
}, 30_000)
