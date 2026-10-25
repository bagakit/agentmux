// @vitest-environment happy-dom
import { act } from 'react'
import { appendFile, readFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
vi.mock('../src/renderer/src/lib/reading-diagnostic-publication', () => ({ publishReadingDiagnostic: () => {} }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { openConnectedGroup } from './helpers/connector-header-navigation'
import { feishuPayload } from '../../../packages/connectors/test/fixtures/feishu'
import { useAppStore } from '../src/renderer/src/store'

let loseNext = false
const groupId = 'oc_activity_original'
const f = connectorJourneyFixture({ publication: true, ingress: true, platform: async request => {
  if (request.url?.endsWith('/messages')) {
    if (loseNext) { loseNext = false; throw Error('Controlled original response loss') }
    const transform = (request as typeof request & { transformRequest: Array<(data: unknown) => string> }).transformRequest[0]!
    const body = JSON.parse(transform(request.data))
    return { code: 0, data: { message_id: 'om_original_' + body.uuid, chat_id: groupId, msg_type: body.msg_type } }
  }
  if (request.url?.endsWith('/members')) return { code: 0, data: { items: [
    { member_id_type: 'open_id', member_id: 'approved-first', name: 'Approved first member' },
    { member_id_type: 'open_id', member_id: 'approved-second', name: 'Approved second member' },
    { member_id_type: 'open_id', member_id: 'original-external-user', name: 'Original request sender' }
  ], has_more: false } }
  return { code: 0, data: { name: 'Original activity group', chat_status: 'normal', chat_mode: 'group' } }
} })
const writeMethods = new Set(['connection.configure', 'connection.credential.store', 'connection.service.configure', 'connection.bind', 'connection.binding.relink', 'connection.binding.pause', 'connection.binding.resume', 'connection.binding.detach', 'connection.grant', 'connection.room.create', 'connection.room.members.add', 'connection.room.link.create', 'connection.delivery.retry'])
const writes = () => f.calls.filter(call => writeMethods.has(call.method)).length
const panel = () => document.querySelector<HTMLElement>('[aria-label="Group delivery"]')!
const oldScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
afterEach(() => { loseNext = false; if (oldScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', oldScroll); else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView') })
async function waitPublic(check: () => Promise<void>) { await vi.waitFor(check, { timeout: 8000 }) }
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 8000 }) }
const native = (id: string, type: 'assistant' | 'user') => JSON.stringify({ sessionId: 'original-native', uuid: id, type, message: { role: type, content: [{ type: 'text', text: 'Original activity ' + id }] } }) + '\n'

it('exposes one-click member access despite other approved members and distinct content and delivery details without effects', async () => {
  const bound = await f.forward('connection.bind', { ...f.original.input, operationId: 'activity-bind', connectionId: f.config.connectionId, externalConversationId: groupId,
    scope: { input: 'all-messages', publication: 'future-shared-conversation' } })
  expect(bound.state).toBe('applied'); if (bound.state !== 'applied') throw Error('Exact original binding required')
  const binding = bound.binding
  for (const [index, userId] of ['approved-first', 'approved-second'].entries()) await f.forward('connection.grant', { operationId: 'activity-approval-' + index,
    bindingId: binding.bindingId, expectedBindingRevision: binding.revision, grantId: 'activity-member-' + index, expectedRevision: null,
    actor: { application: binding.application, idType: 'open_id', userId }, state: 'active', capabilities: index ? ['input', 'answer'] : ['input', 'answer', 'permission'] })
  const deliveryInput = { connectionId: binding.connectionId, bindingId: binding.bindingId, bindingRevision: binding.revision }
  const deliveries = () => f.forward('connection.delivery.ls', deliveryInput)
  const speech = async () => (await deliveries()).deliveries.filter(operation => operation.reference.source.kind === 'native')
  await waitPublic(async () => expect((await deliveries()).deliveries.some(operation => operation.reference.source.kind === 'binding-operation' && operation.state === 'confirmed')).toBe(true))
  loseNext = true; await appendFile(f.original.transcript, native('old-unknown', 'assistant'))
  await waitPublic(async () => expect((await speech())[0]?.state).toBe('unknown'))
  await appendFile(f.original.transcript, [1, 2, 3, 4, 5].map(id => native('confirmed-' + id, 'assistant')).join(''))
  await waitPublic(async () => expect((await speech()).filter(operation => operation.state === 'confirmed')).toHaveLength(5))
  await appendFile(f.original.transcript, native('unqualified-source', 'user'))
  await waitPublic(async () => expect((await deliveries()).observation?.reason).toBe('content-unconfirmed'))
  await wait(() => expect(f.ingressTransport!.sockets).toHaveLength(1))
  const payload = feishuPayload({ message_id: 'activity-refused-request', chat_id: groupId, content: JSON.stringify({ text: 'Original member request' }) })
  payload.header.event_id = 'activity-refused-event'
  await f.ingressTransport!.receive(payload)
  await waitPublic(async () => expect((await f.forward('connection.ingress.ls', { connectionId: binding.connectionId })).ingresses.some(row => row.kind !== 'action' && row.externalMessageId === 'activity-refused-request' && row.code === 'INGRESS_ACTOR_NOT_AUTHORIZED')).toBe(true))
  const diagnosis = await f.forward('connection.diagnose', { executionHostId: binding.executionHostId, agentSessionId: binding.agentSessionId, bindingId: binding.bindingId, bindingRevision: binding.revision })
  expect(diagnosis.groups.value?.items[0]?.binding.value).toMatchObject({ activeInputGrants: 2, activeAnswerGrants: 2, activePermissionGrants: 1 })
  const before = { writes: writes(), posts: f.platformCalls.filter(call => call.method?.toUpperCase() === 'POST').length, original: await speech(), transcript: await readFile(f.original.transcript), store: await readFile(f.original.storePath), session: await f.original.client.readAgentSession(binding.agentSessionId) }
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  await f.mount(); await openConnectedGroup(groupId)
  await wait(() => expect(panel()?.textContent).toContain('Member request was refused'))
  const overview = panel().querySelector('.connector-traffic-summary')!
  expect(overview.textContent?.match(/Member request was refused/g)).toHaveLength(1)
  expect(overview.querySelector('[data-direction="outgoing"] strong')?.textContent).toContain('not shared yet')
  expect(overview.textContent).toContain('5 conversation updates delivered')
  expect(overview.textContent).toContain('not shared yet'); expect(overview.textContent).toContain('Earlier delivery results not confirmed')
  const memberAction = panel().querySelector<HTMLElement>('[data-direction="incoming"] button')!
  expect(memberAction?.textContent).toBe('Member access')
  await act(async () => memberAction.click())
  const members = document.querySelector<HTMLElement>('[data-connection-section="members"][aria-label="Member access"]')!
  expect(document.activeElement).toBe(members)
  await wait(() => expect(members.textContent).toContain('Original request sender'))
  for (const [label, section] of [['View content details', 'content'], ['View delivery details', 'receipts']] as const) {
    const button = [...overview.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label)!
    expect(button).toBeTruthy(); await act(async () => button.click())
    expect(panel().querySelector('details')?.open).toBe(true)
    expect(document.activeElement).toBe(panel().querySelector('[data-receipt-section="' + section + '"]'))
  }
  expect(writes()).toBe(before.writes)
  expect(f.platformCalls.filter(call => call.method?.toUpperCase() === 'POST')).toHaveLength(before.posts)
  expect(await speech()).toEqual(before.original)
  expect(useAppStore.getState().agentComposerDrafts[binding.agentSessionId]).toBe('Keep the original draft 中')
  expect(f.calls.some(call => call.method === 'connection.delivery.retry')).toBe(false)
  expect(await readFile(f.original.transcript)).toEqual(before.transcript)
  expect(await readFile(f.original.storePath)).toEqual(before.store)
  expect(await f.original.client.readAgentSession(binding.agentSessionId)).toEqual(before.session)
}, 40_000)
