// @vitest-environment happy-dom
import { act } from 'react'
import { appendFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
// Independent reading telemetry is outside this group journey; its publisher does not own input or delivery facts.
vi.mock('../src/renderer/src/lib/reading-diagnostic-publication', () => ({ publishReadingDiagnostic: vi.fn() }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { feishuPayload } from '../../../packages/connectors/test/fixtures/feishu'
import { feishuPublicationHttp } from '../../../packages/connectors/test/fixtures/feishu-publication'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

let remote: Awaited<ReturnType<typeof feishuPublicationHttp>>
beforeEach(async () => { remote = await feishuPublicationHttp() })
const f = connectorJourneyFixture({ publication: true, ingress: true, platform: async request => {
  if (request.url?.endsWith('/members')) return { code: 0, data: { items: [{ member_id_type: 'open_id', member_id: 'original-external-user', name: 'Chosen member' }], has_more: false } }
  if (request.url?.endsWith('/link')) return { code: 0, data: { share_link: 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=controlled-join', is_permanent: false, expire_time: String(Math.floor(Date.now() / 1000) + 300) } }
  if (request.url?.endsWith('/chats') && request.method?.toUpperCase() === 'POST') return { code: 0, data: { chat_id: 'oc_first_use' } }
  if (request.url?.includes('/im/v1/messages')) return await remote.http.request(request)
  return { code: 0, data: { name: 'First-use group', chat_status: 'normal', chat_mode: 'group' } }
} })
afterEach(async () => { await remote?.close() })
const activity = () => document.querySelector('[aria-label="Group delivery"]')!
async function ready(text: string) { await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('[role="dialog"]')?.textContent).toContain(text) }, { timeout: 6000 }) }
async function createAndBind() {
  await f.mount(); await f.menu('Create group chat'); await f.button('Create group'); await ready('Group created')
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-busy')).toBe('false'))
  await act(async () => document.querySelector<HTMLInputElement>('.agent-connector-check input')!.click())
  await f.button('Connect group'); await ready('Group saved')
  return (await f.forward('connection.binding.ls', { agentSessionId: f.session.id })).bindings[0]!
}
async function incoming(eventId: string, messageId: string) {
  await vi.waitFor(() => expect(f.ingressTransport!.sockets).toHaveLength(1))
  const payload = feishuPayload({ chat_id: 'oc_first_use', message_id: messageId, content: JSON.stringify({ text: 'Private first-use request' }) })
  payload.header.event_id = eventId
  await f.ingressTransport!.receive(payload)
  const page = await f.forward('connection.ingress.ls', { connectionId: f.config.connectionId })
  const row = page.ingresses.find(item => item.kind !== 'action' && item.externalMessageId === messageId)!
  expect(row).toBeDefined()
  return row
}

it('joins original menu creation, explicit member authority, original Core input and a newly eligible native reply with its exact platform receipt', async () => {
  const open = vi.spyOn(api.ui, 'openExternal').mockResolvedValue(undefined)
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const binding = await createAndBind()
  expect(binding).toMatchObject({ connectionId: f.config.connectionId, externalConversationId: 'oc_first_use', state: 'active', revision: 1 })
  expect((await f.forward('connection.binding.inspect', { bindingId: binding.bindingId })).grants).toEqual([])
  expect(remote.messageCalls()).toEqual([])
  await f.button('Create join link'); await f.button('Open join link')
  expect(open).toHaveBeenCalledOnce()
  expect((await f.forward('connection.binding.inspect', { bindingId: binding.bindingId })).grants).toEqual([])
  const refused = await incoming('first-use-before-grant', 'first-use-unapproved')
  await vi.waitFor(async () => expect((await f.forward('connection.ingress.inspect', { ingressId: refused.ingressId })).ingress).toMatchObject({ state: 'refused', code: 'INGRESS_ACTOR_NOT_AUTHORIZED' }))
  await f.button('Check group and members'); await ready('Chosen member'); await f.button('Choose')
  await act(async () => [...document.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(node => node.closest('label')?.textContent === 'Send requests')!.click())
  await f.button('Approve this member'); await ready('1 member approved')
  const accepted = await incoming('first-use-after-grant', 'first-use-approved')
  let inputOperationId = ''
  await vi.waitFor(async () => {
    const original = await f.forward('connection.ingress.inspect', { ingressId: accepted.ingressId })
    expect(original.ingress).toMatchObject({ state: 'claimed', input: { agentSessionId: f.session.id, author: { bindingId: binding.bindingId, bindingRevision: 1 } } })
    expect(original.inputReceipt?.status).toBe('terminal-confirmed')
    inputOperationId = original.ingress!.input!.operationId
  }, { timeout: 6000 })
  expect((await f.forward('connection.ingress.inspect', { ingressId: refused.ingressId })).ingress).toMatchObject({ state: 'refused', code: 'INGRESS_ACTOR_NOT_AUTHORIZED' })
  expect(remote.messageCalls()).toEqual([])
  await appendFile(f.original.transcript, JSON.stringify({ sessionId: 'original-native', uuid: 'first-use-new-reply', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Newly eligible original answer' }] } }) + '\n')
  await vi.waitFor(async () => {
    const page = await f.forward('connection.delivery.ls', { bindingId: binding.bindingId, bindingRevision: 1, connectionId: binding.connectionId })
    expect(page.deliveries).toHaveLength(1)
    expect(page.deliveries[0]).toMatchObject({ state: 'confirmed', bindingId: binding.bindingId, bindingRevision: 1, target: { externalConversationId: 'oc_first_use' }, reference: { source: { kind: 'native', recordId: 'first-use-new-reply' } }, receipt: { state: 'confirmed', mapping: { messageId: 'platform-message-1' } } })
  }, { timeout: 6000 })
  expect(remote.records.get('platform-message-1')).toMatchObject({ body: { content: expect.stringContaining('Newly eligible original answer') } })
  await f.button('Close'); await f.menu('Shared group details'); await f.button('Check group activity')
  await ready('Delivery confirmed in this window')
  expect(activity().textContent).not.toContain('Service: ready')
  await f.button('Copy group diagnosis'); await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce())
  const report = copy.mock.calls[0]![0]
  for (const value of [binding.bindingId, refused.ingressId, accepted.ingressId, inputOperationId, 'platform-message-1', 'INGRESS_ACTOR_NOT_AUTHORIZED', 'terminal-confirmed']) expect(report).toContain(value)
  for (const value of ['Private first-use request', 'Newly eligible original answer', 'original-external-user', 'controlled-join', 'credentialRef']) expect(report).not.toContain(value)
  expect(f.calls.filter(call => call.method === 'connection.room.create')).toHaveLength(1)
  expect(f.calls.filter(call => call.method === 'connection.bind')).toHaveLength(1)
  expect(f.calls.filter(call => call.method === 'connection.grant')).toHaveLength(1)
  expect(remote.messageCalls().filter(call => call.method === 'POST')).toHaveLength(1)
  const service = await f.forward('connection.service.get', {})
  await f.forward('connection.service.configure', { operationId: 'first-use-pause-automatic-service', expectedRevision: service.revision, service: { enabled: false } })
  await f.button('Check group activity'); await ready('Automatic service is paused.')
  expect((await f.forward('connection.binding.inspect', { bindingId: binding.bindingId })).binding).toEqual(binding)
  await f.button('Copy group diagnosis'); await vi.waitFor(() => expect(copy).toHaveBeenCalledTimes(2))
  expect(copy.mock.calls[1]![0]).toContain('Automatic service: off')
  expect(copy.mock.calls[1]![0]).toContain('platform-message-1')
  expect(remote.messageCalls().filter(call => call.method === 'POST')).toHaveLength(1)
  expect(useAppStore.getState().agentComposerDrafts[f.session.id]).toBe('Keep the original draft 中')
}, 40_000)
