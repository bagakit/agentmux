// @vitest-environment happy-dom
import { act } from 'react'
import { appendFile } from 'node:fs/promises'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
// This concurrent telemetry publisher owns no group/receipt fact and is outside this consumer proof.
vi.mock('../src/renderer/src/lib/reading-diagnostic-publication', () => ({ publishReadingDiagnostic: () => {} }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { feishuPayload } from '../../../packages/connectors/test/fixtures/feishu'
import { api } from '../src/renderer/src/lib/api'
import { connectionDiagnosisGapKey, type RoomBinding } from '@agentmux/core/connections'
import { ConnectorDeliveryDetails } from '../src/renderer/src/components/ConnectorDeliveryDetails'

let loseDelivery = false
let heldDelivery: Promise<void> | null = null
beforeEach(() => { loseDelivery = false; heldDelivery = null })
const f = connectorJourneyFixture({ publication: true, ingress: true, platform: async request => {
  if (request.url?.endsWith('/messages')) {
    await heldDelivery
    if (loseDelivery) throw new Error('Controlled lost send response')
    const original = (request as typeof request & { transformRequest: Array<(data: unknown) => string> }).transformRequest[0]!
    expect(original).toBeTypeOf('function')
    const body = JSON.parse(original(request.data))
    expect(body.msg_type).toBeTypeOf('string'); expect(body.uuid).toBeTypeOf('string')
    return { code: 0, data: { message_id: 'om_observed_' + body.uuid, chat_id: 'oc_observed_group', msg_type: body.msg_type } }
  }
  if (request.url?.endsWith('/members')) return { code: 0, data: { items: [], has_more: false } }
  return { code: 0, data: { name: 'Observed group', chat_status: 'normal', chat_mode: 'group' } }
} })
const panel = () => document.querySelector('[aria-label="Group delivery"]')!
const speech = (binding: RoomBinding) => f.services.publication!.store.list(binding).filter(delivery => delivery.reference.source.kind !== 'binding-operation')
const messageCalls = () => f.platformCalls.filter(call => call.url?.endsWith('/messages'))
function summaryText() { const node = panel().cloneNode(true) as HTMLElement; node.querySelectorAll('details').forEach(detail => detail.remove()); return node.textContent! }
async function ready(text: string) { await vi.waitFor(async () => { await act(async () => {}); expect(panel()?.textContent).toContain(text) }, { timeout: 6000 }) }
async function bind(shared = false) {
  await f.mount(); await f.journey('existing'); await f.fill('Existing group ID', 'oc_observed_group')
  if (shared) {
    const select = document.querySelector<HTMLElement>('[aria-label="Group sharing content"]')!
    await act(async () => { select.focus(); select.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
    await act(async () => document.querySelector<HTMLElement>('[role="menuitemradio"][data-value="future-shared-conversation"]')!.click())
  }
  await act(async () => document.querySelector<HTMLInputElement>('.agent-connector-check input')!.click())
  await f.button('Connect group')
  await vi.waitFor(() => expect(f.services.publication!.observation((f.services.bindings!.listActive())[0]!.bindingId, 1).state).toBe('ready'), { timeout: 6000 })
  const binding = f.services.bindings!.listActive()[0]!
  await f.button('Close'); await f.journey('details'); await ready('No new delivery receipt recorded')
  return binding
}
async function reopen() { await f.button('Close'); await f.journey('details') }
const row = (id: string, type: 'assistant' | 'user') => JSON.stringify({ sessionId: 'original-native', uuid: id, type, message: { role: type, content: [{ type: 'text', text: 'PRIVATE outgoing ' + id }] } }) + '\n'
async function incoming(id: string, room = 'oc_observed_group') {
  await vi.waitFor(() => expect(f.ingressTransport!.sockets).toHaveLength(1))
  const payload = feishuPayload({ message_id: id, chat_id: room, content: JSON.stringify({ text: 'PRIVATE-BODY https://secret.invalid ' + f.original.root }) })
  payload.header.event_id = 'event-' + id
  await f.ingressTransport!.receive(payload)
  const list = await f.forward('connection.ingress.ls', { connectionId: f.config.connectionId })
  return list.ingresses.find(value => value.kind !== 'action' && value.externalMessageId === id)!
}

it('keeps a source-ready window without conversation effects separate from the original confirmed notice', async () => {
  const binding = await bind(), before = f.platformCalls.length, notice = f.services.publication!.store.list(binding)[0]!
  expect(notice).toMatchObject({ state: 'confirmed', reference: { source: { kind: 'binding-operation' } } })
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await ready('Source observation: ready')
  const callsBefore = f.calls.length
  await f.button('Copy group diagnosis')
  await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce())
  const report = copy.mock.calls[0]![0]
  expect(f.calls.slice(callsBefore).map(call => call.method)).toEqual(['connection.diagnose'])
  for (const value of [binding.bindingId, 'Window limit: 5', 'Delivery has next: false', 'Source read: ready', 'Unresolved effects: unrecorded', `Outgoing ${notice.operationId}: binding-notice · queue confirmed`]) expect(report).toContain(value)
  expect(report).not.toContain('Service: ready')
  expect(f.platformCalls).toHaveLength(before)
  expect(speech(binding)).toEqual([])
  expect(messageCalls()).toHaveLength(1)
  expect(f.calls.some(call => call.method === 'connection.delivery.retry')).toBe(false)
}, 30_000)

it('renders and copies a safe gap key when the original owner gap ID contains private source JSON', async () => {
  const binding = await bind(), originalGapId = JSON.stringify(['local', 'original-agent', 'native', 'fixture', 'PRIVATE source/path', 'PRIVATE record'])
  const publication = f.services.publication!, original = publication.list.bind(publication)
  vi.spyOn(publication, 'list').mockImplementation(async input => {
    const page = await original(input)
    return { ...page, coverage: { state: 'incomplete', nextContent: null, origins: [], gaps: [{ gapId: originalGapId, reason: 'source-gap', code: 'AGENT_SESSION_HISTORY_INVALID_CURSOR' }] } }
  })
  const key = connectionDiagnosisGapKey({ bindingId: binding.bindingId, bindingRevision: binding.revision, connectionId: binding.connectionId, domain: binding.application.domain, appId: binding.application.appId, externalConversationId: binding.externalConversationId, executionHostId: binding.executionHostId, agentSessionId: binding.agentSessionId }, originalGapId)
  const before = f.platformCalls.length
  await f.button('Check group activity'); await ready('Content coverage: incomplete')
  expect(panel().textContent).toContain(key)
  expect(panel().textContent).not.toMatch(/PRIVATE|source\/path/)
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await f.button('Copy group diagnosis'); await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce())
  expect(copy.mock.calls[0]![0]).toContain('Content gap ' + key)
  expect(copy.mock.calls[0]![0]).toContain('code AGENT_SESSION_HISTORY_INVALID_CURSOR')
  expect(copy.mock.calls[0]![0]).not.toMatch(/PRIVATE|source\/path|gapId/)
  expect(f.platformCalls).toHaveLength(before)
  expect(f.calls.some(call => call.method === 'connection.delivery.retry')).toBe(false)
}, 30_000)

it('shows the original no-grant incoming refusal with its frozen binding scope', async () => {
  const binding = await bind()
  await vi.waitFor(() => expect(f.ingressTransport!.sockets).toHaveLength(1))
  const original = await incoming('refused-original')
  await vi.waitFor(async () => expect((await f.forward('connection.ingress.inspect', { ingressId: original.ingressId })).ingress).toMatchObject({ state: 'refused', code: 'INGRESS_ACTOR_NOT_AUTHORIZED' }))
  expect((await f.forward('connection.ingress.ls', { connectionId: binding.connectionId, bindingId: binding.bindingId })).ingresses.map(ingress => ({ id: ingress.ingressId, state: ingress.state, code: ingress.code }))).toEqual([{ id: original.ingressId, state: 'refused', code: 'INGRESS_ACTOR_NOT_AUTHORIZED' }])
  await f.button('Close'); await f.journey('details')
  await ready('INGRESS_ACTOR_NOT_AUTHORIZED')
  expect(panel().textContent).toContain('Core input: not started')
  expect(summaryText()).toContain('Not sent to the Agent. This member has no request access.')
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await f.button('Copy group diagnosis'); await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce())
  expect(copy.mock.calls[0]![0]).toContain(original.ingressId)
  for (const secret of ['PRIVATE-BODY', 'secret.invalid', f.original.root, 'original-external-user', 'credentialRef', 'fixture-tenant-token']) expect(copy.mock.calls[0]![0]).not.toContain(secret)
}, 30_000)

it('keeps a refused old event after an explicit grant and reports the separate new Core ordered-input receipt', async () => {
  const binding = await bind(), denied = await incoming('denied-before-grant')
  await vi.waitFor(async () => expect((await f.forward('connection.ingress.inspect', { ingressId: denied.ingressId })).ingress?.state).toBe('refused'))
  expect((await f.forward('connection.grant', { operationId: 'explicit-input-grant', bindingId: binding.bindingId, expectedBindingRevision: binding.revision,
    grantId: 'observed-input-grant', expectedRevision: null, actor: { application: f.config.application, idType: 'open_id', userId: 'original-external-user' }, capabilities: ['input'], state: 'active' })).state).toBe('applied')
  const accepted = await incoming('accepted-after-grant')
  let inputId = ''
  await vi.waitFor(async () => {
    const result = await f.forward('connection.ingress.inspect', { ingressId: accepted.ingressId })
    expect(result.ingress?.state).toBe('claimed'); expect(result.inputReceipt?.status).toBe('terminal-confirmed')
    inputId = result.ingress!.input!.operationId
  }, { timeout: 6000 })
  await reopen(); await ready('Core input: terminal-confirmed')
  expect(panel().textContent).toContain('INGRESS_ACTOR_NOT_AUTHORIZED')
  expect(summaryText()).toContain('Request submitted; Agent acknowledgement is unconfirmed.')
  for (const term of ['Core input', 'ordered bytes', 'Native acceptance', 'intake connection window']) expect(summaryText()).not.toContain(term)
  expect(f.ingressTransport!.ack()).toEqual([{ code: 200 }, { code: 200 }])
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await f.button('Copy group diagnosis'); await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce())
  for (const fact of [denied.ingressId, accepted.ingressId, inputId, 'intake refused', 'Core input terminal-confirmed', 'not Native acceptance']) expect(copy.mock.calls[0]![0]).toContain(fact)
  expect((await f.forward('connection.ingress.inspect', { ingressId: denied.ingressId })).ingress?.state).toBe('refused')
}, 30_000)

it('reports the exact confirmed platform message and original content gap separately without retrying', async () => {
  const binding = await bind(true), messagesBefore = messageCalls().length
  await appendFile(f.original.transcript, row('observed-reply', 'assistant'))
  await vi.waitFor(() => expect(speech(binding)[0]?.state).toBe('confirmed'), { timeout: 6000 })
  const effect = speech(binding)[0]!
  await appendFile(f.original.transcript, row('observed-gap', 'user'))
  await vi.waitFor(() => expect(f.services.publication!.observation(binding.bindingId, binding.revision).reason).toBe('content-unconfirmed'), { timeout: 6000 })
  await reopen(); await ready('Delivery confirmed in this window'); await ready('Some content has not synced')
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await f.button('Copy group diagnosis'); await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce())
  for (const fact of [effect.operationId, 'platform receipt confirmed', effect.mapping!.messageId, 'Content coverage: incomplete', 'Content gap']) expect(copy.mock.calls[0]![0]).toContain(fact)
  expect(copy.mock.calls[0]![0]).not.toContain('PRIVATE outgoing')
  expect(f.calls.some(call => call.method === 'connection.delivery.retry')).toBe(false)
  expect(messageCalls()).toHaveLength(messagesBefore + 1)
}, 30_000)

it('keeps an unknown original send separate from service pause and performs no resend while checking or copying', async () => {
  const binding = await bind(), messagesBefore = messageCalls().length; loseDelivery = true
  await appendFile(f.original.transcript, row('unknown-reply', 'assistant'))
  await vi.waitFor(() => expect(speech(binding)[0]?.state).toBe('unknown'), { timeout: 6000 })
  await reopen(); await ready('Delivery not confirmed.')
  const service = await f.forward('connection.service.get', {})
  await f.forward('connection.service.configure', { operationId: 'pause-observation', expectedRevision: service.revision, service: { enabled: false } })
  await f.button('Check group activity'); await ready('Automatic service is paused.'); await ready('Delivery not confirmed.')
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await f.button('Check group activity'); await f.button('Copy group diagnosis'); await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce())
  expect(copy.mock.calls[0]![0]).toContain('Automatic service: off')
  expect(copy.mock.calls[0]![0]).toContain('platform receipt unknown')
  expect(copy.mock.calls[0]![0]).toContain(`Outgoing ${speech(binding)[0]!.operationId}: conversation · queue ${speech(binding)[0]!.state} · platform receipt ${speech(binding)[0]!.receipt?.state ?? 'unrecorded'} · message unrecorded`)
  expect(messageCalls()).toHaveLength(messagesBefore + 1)
  expect(f.calls.some(call => call.method === 'connection.delivery.retry')).toBe(false)
}, 30_000)

it('shows an in-flight original request without claiming no request or a platform acknowledgement', async () => {
  const binding = await bind(); let release!: () => void
  heldDelivery = new Promise(resolve => { release = resolve })
  try {
    await appendFile(f.original.transcript, row('held-reply', 'assistant'))
    await vi.waitFor(() => expect(speech(binding)[0]?.state).toBe('dispatching'), { timeout: 6000 })
    await reopen(); await ready('An outgoing request is recorded. Its platform receipt is not confirmed.')
    const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
    await f.button('Copy group diagnosis'); await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce())
    expect(copy.mock.calls[0]![0]).toContain('queue dispatching · platform receipt unrecorded')
    expect(copy.mock.calls[0]![0]).toContain(`Outgoing ${speech(binding)[0]!.operationId}: conversation · queue ${speech(binding)[0]!.state} · platform receipt ${speech(binding)[0]!.receipt?.state ?? 'unrecorded'} · message unrecorded`)
    expect(panel().textContent).not.toContain('No delivery in this reading window.')
  } finally { release(); heldDelivery = null }
}, 30_000)

it('reads newest exact-group intake across the original cursor instead of an early unrelated connection window', async () => {
  const binding = await bind(), received = []
  for (let index = 0; index < 7; index++) {
    received.push(await incoming('group-window-' + index))
    await incoming('other-group-' + index, 'oc_other_group')
  }
  await reopen(); await ready('Group window: 5 records, newest first · has next: true')
  const readCalls = () => f.calls.filter(call => call.method === 'connection.diagnose')
  expect(readCalls().at(-1)?.input).toEqual({ executionHostId: binding.executionHostId, agentSessionId: binding.agentSessionId, bindingId: binding.bindingId, bindingRevision: binding.revision })
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await f.button('Copy group diagnosis'); await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce())
  expect(copy.mock.calls[0]![0]).toContain(received[6]!.ingressId)
  expect(copy.mock.calls[0]![0]).not.toContain(received[0]!.ingressId)
  expect(copy.mock.calls[0]![0]).toContain('before: latest · records 5 · has next true')
  expect(copy.mock.calls[0]![0]).not.toContain('oc_other_group')
  await f.button('Earlier intake'); await ready('Group window: 2 records, newest first · has next: false')
  expect(readCalls().at(-1)?.input).toMatchObject({ beforeIngressId: received[2]!.ingressId, bindingId: binding.bindingId })
  expect(panel().textContent).toContain(received[0]!.ingressId)
  expect(panel().textContent).not.toContain(received[6]!.ingressId)
}, 30_000)

it('retains earlier facts on an unavailable local read and copies explicit partial sections without raw errors', async () => {
  await bind(); await ready('Source observation: ready')
  vi.spyOn(f.services.ingress!, 'listAudience').mockRejectedValue(new Error('PRIVATE exception https://secret.invalid ' + f.original.root))
  await f.button('Check group activity'); await ready('Incoming observation unconfirmed; earlier observed facts are kept.')
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await f.button('Copy group diagnosis'); await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce())
  expect(copy.mock.calls[0]![0]).toContain('Ingress read: read-unavailable')
  expect(copy.mock.calls[0]![0]).toContain('Lane observation: ready')
  for (const secret of ['PRIVATE exception', 'secret.invalid', f.original.root]) expect(copy.mock.calls[0]![0]).not.toContain(secret)
  expect(f.calls.some(call => call.method === 'connection.delivery.retry')).toBe(false)
}, 30_000)

it.each(['cancel', 'leave', 'retarget'] as const)('does not copy a held original window after %s', async ending => {
  const binding = await bind()
  let entered = false, release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  vi.mocked(api.connections.call).mockImplementation(async (method, input) => {
    const original = await f.forward(method, input)
    if (method === 'connection.diagnose') { entered = true; await held }
    return original
  })
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await f.button('Copy group diagnosis'); await vi.waitFor(() => expect(entered).toBe(true))
  if (ending === 'cancel') await f.button('Cancel copy')
  else if (ending === 'leave') await f.button('Close')
  else await f.dom.render(<ConnectorDeliveryDetails binding={{ ...binding, externalConversationId: 'oc_another_exact_target' }} />)
  await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 20)) })
  expect(copy).not.toHaveBeenCalled()
  expect(f.calls.some(call => call.method === 'connection.delivery.retry')).toBe(false)
}, 30_000)
