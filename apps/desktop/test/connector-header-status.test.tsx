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
import { ConnectorDeliveryDetails } from '../src/renderer/src/components/ConnectorDeliveryDetails'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { settingsCatalog } from '../src/renderer/src/components/settings/settings-modules'
import { connectorGroupDiagnostics, connectorGroupSummary } from '../src/renderer/src/lib/connector-group-status'
import { useAppStore } from '../src/renderer/src/store'
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
async function check() { await act(async () => [...menu().querySelectorAll<HTMLElement>('button')].find(node => node.textContent === 'Refresh observations')!.click()) }
async function bind(shared?: boolean) {
  await f.mount(); await f.journey('existing'); await f.fill('Existing group ID', 'oc_header_status')
  if (shared !== undefined) {
    await act(async () => { const select = document.querySelector<HTMLElement>('[aria-label="Group sharing content"]')!; select.focus(); select.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
    await act(async () => document.querySelector<HTMLElement>(`[role="menuitemradio"][data-value="${shared ? 'future-shared-conversation' : 'future-native-user-facing'}"]`)!.click())
  }
  await act(async () => document.querySelector<HTMLInputElement>('.agent-connector-check input')!.click())
  await f.button('Connect group'); await wait(() => expect(f.services.bindings!.listActive()).toHaveLength(1))
  const binding = f.services.bindings!.listActive()[0]!
  await f.button('Close'); await wait(() => expect(trigger()?.getAttribute('aria-label')).toContain('Original status group'))
  return binding
}
const row = (id: string, type: 'user' | 'assistant') => JSON.stringify({ sessionId: 'original-native', uuid: id, type, message: { role: type, content: [{ type: 'text', text: 'PRIVATE original ' + id }] } }) + '\n'
const speech = (binding: RoomBinding) => f.services.publication!.store.list(binding).filter(value => value.reference.source.kind !== 'binding-operation')
async function renderHeader(bindings: RoomBinding[], visible = true, version = 0) {
  await f.dom.render(<SettingsNavigation.Provider value={{ open() {}, openToolkit() {}, openHost() {}, openChannel() {}, chooseAgent() {}, openMoteLark() {}, channelPresentation: settingsCatalog.channelPresentation, channelEntries: settingsCatalog.channelEntries }}>
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
  await open(); await wait(() => expect(trigger().getAttribute('aria-label')).toContain('content gap'))
  await wait(() => expect(menu().textContent).toContain('Content not confirmed'))
  expect(menu().textContent).toContain('content gap')
  expect(menu().textContent).toContain('unconfirmed')
  expect(menu().textContent).toContain('original results remain unconfirmed')
  const kinds = [...menu().querySelectorAll<HTMLElement>('[data-problem-kind]')].map(node => node.dataset.problemKind)
  expect(kinds).toContain('content-gap'); expect(kinds).toContain('outgoing-unconfirmed')
  expect(menu().querySelector('.connector-traffic-summary__tile[aria-label="Conversation → group"]')?.textContent).toContain('not confirmed')
  expect(menu().textContent).not.toContain('Needs attention')
  for (const section of ['Configuration', 'Sharing', 'Conversation → group', 'Platform requests', 'Group → Agent', 'Snapshot of bounded local observations']) expect(menu().textContent).toContain(section)
  expect(f.calls.filter(call => call.method === 'connection.diagnose').at(-1)?.input).toEqual({ ...target, bindingId: binding.bindingId, bindingRevision: binding.revision })
  expect(menu().textContent).not.toContain('PRIVATE')
  await check(); await wait(() => expect(checked()).not.toBeNull())
  expect({ writes: writes(), effects: effects() }).toEqual(before)
  expect(f.calls.some(call => call.method === 'connection.delivery.retry')).toBe(false)
}, 30_000)

it('an empty checked window remains a linked snapshot, and explicit Off and paused stay configuration facts', async () => {
  const binding = await bind(); await open(); await wait(() => expect(checked()).not.toBeNull())
  expect(menu().textContent).toContain('Linked · Sync on · Platform on · Bot on')
  expect(menu().textContent).toContain('No events in this window')
  expect(trigger().getAttribute('aria-label')).not.toMatch(/healthy|working|disconnected/i)
  const service = await f.forward('connection.service.get', {})
  await f.forward('connection.service.configure', { operationId: 'header-explicit-off', expectedRevision: service.revision, service: { enabled: false } })
  await check(); await wait(() => expect(trigger().getAttribute('aria-label')).toContain('Automatic sync is off'))
  expect(menu().textContent).toContain('Linked · Sync off')
  const paused = await f.forward('connection.binding.pause', { operationId: 'header-explicit-pause', bindingId: binding.bindingId, expectedRevision: binding.revision })
  await renderHeader([paused.binding!]); await wait(() => expect(trigger().getAttribute('aria-label')).toContain('Group sharing is paused'))
  await open(); expect(menu().querySelector('.connector-header-menu__item')?.getAttribute('aria-label')).toContain('oc_header_status')
}, 30_000)

it('a later failed check retains the exact group and earlier observations, with a stable completed-check time and actions', async () => {
  await bind(); await open(); await wait(() => expect(checked()).not.toBeNull())
  await wait(() => {
    expect([...menu().querySelectorAll('summary')].some(node => node.textContent?.includes('Checking…'))).toBe(false)
    expect(f.calls.filter(call => call.method === 'connection.diagnose').every(call => call.result)).toBe(true)
  })
  const first = checked()!.dateTime
  const original = f.forward
  vi.mocked(api.connections.call).mockImplementation(async (method, input) => { if (method === 'connection.diagnose') throw Error('PRIVATE credential path'); return original(method, input) })
  await check(); await wait(() => expect(trigger().getAttribute('aria-label')).toContain('unread'))
  expect(checked()!.dateTime).not.toBe(first)
  for (const text of ['Original status group', 'Unavailable', 'Kept after this check failed', 'Connect a group', 'Channel settings', 'Refresh observations']) expect(menu().textContent).toContain(text)
  expect(trigger().getAttribute('aria-disabled')).not.toBe('true')
  expect(menu().textContent).not.toContain('PRIVATE credential path')
  const input = document.querySelector<HTMLElement>('[data-workbench-region-id="original-region"] [role="textbox"]')
  expect(input, 'original visible Agent input is retained').not.toBeNull()
  expect(input!.getAttribute('contenteditable')).toBe('true')
  expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
}, 30_000)

it('actual recorded refusal and waiting stay separate from adoption, and typed byte receipts keep their exact presentation', async () => {
  const binding = await bind(); await wait(() => expect(f.ingressTransport!.sockets).toHaveLength(1))
  await f.forward('connection.grant', { operationId: 'header-other-person-grant', bindingId: binding.bindingId, expectedBindingRevision: binding.revision, grantId: 'other-member-input', expectedRevision: null,
    actor: { application: f.config.application, idType: 'open_id', userId: 'other-external-user' }, capabilities: ['input'], state: 'active' })
  const payload = feishuPayload({ message_id: 'header-no-access', chat_id: binding.externalConversationId, content: JSON.stringify({ text: 'PRIVATE incoming original' }) })
  payload.header.event_id = 'header-no-access-event'
  await f.ingressTransport!.receive(payload)
  await vi.waitFor(async () => expect((await f.forward('connection.ingress.ls', { connectionId: binding.connectionId })).ingresses.find(value => value.kind !== 'action' && value.externalMessageId === 'header-no-access')?.state).toBe('refused'), { timeout: 8000 })
  await open(); await wait(() => expect(menu().textContent).toContain('Member request was refused'))
  expect(menu().querySelector('[data-problem-kind="request-refused"]')).not.toBeNull()
  expect(menu().querySelector('[data-connection-action="members"]')).toBeNull()
  await f.forward('connection.grant', { operationId: 'header-explicit-grant', bindingId: binding.bindingId, expectedBindingRevision: binding.revision, grantId: 'header-input', expectedRevision: null,
    actor: { application: f.config.application, idType: 'open_id', userId: 'original-external-user' }, capabilities: ['input'], state: 'active' })
  // This case qualifies a real durable Runtime-unavailable wait, not a transient pre-dispatch read.
  const runtime = (f.original.client as unknown as { kernel: { isConnected(): boolean; input: ReturnType<typeof vi.fn> } }).kernel
  vi.spyOn(runtime, 'isConnected').mockReturnValue(false)
  const byteWrites = runtime.input.mock.calls.length
  payload.event.message.message_id = 'header-byte-original'; payload.header.event_id = 'header-byte-event'
  await f.ingressTransport!.receive(payload)
  let originalIngressId = ''
  await vi.waitFor(async () => {
    const original = (await f.forward('connection.ingress.ls', { connectionId: binding.connectionId })).ingresses.find(value => value.kind !== 'action' && value.externalMessageId === 'header-byte-original')
    expect(original?.state).toBe('claimed'); originalIngressId = original!.ingressId
    const saved = await f.forward('connection.diagnose', { ...target, bindingId: binding.bindingId, bindingRevision: binding.revision })
    expect(saved.groups.value?.items[0]?.incoming.value?.rows.find(row => row.ingressId === originalIngressId)).toMatchObject({ coreStatus: 'waiting', waiting: { phase: 'runtime', reason: 'runtime-unavailable', wake: 'runtime-restored' } })
  }, { timeout: 8000 })
  const checkStart = f.calls.length
  await check(); await wait(() => expect(menu().textContent).toContain('Waiting for Agent'))
  // This is the original completed Check snapshot, not a later observation of a progressing input.
  expect(menu().querySelector('[data-problem-kind="agent-waiting"]')).not.toBeNull()
  expect(menu().querySelector('[data-problem-kind="member-access"]')).toBeNull()
  const report = f.calls.slice(checkStart).find(call => call.method === 'connection.diagnose' &&
    (call.input as { bindingId?: string }).bindingId === binding.bindingId)?.result as import('@agentmux/core/connections').ConnectionDiagnosis
  expect(report).toBeDefined()
  const currentReceipt = await f.original.client.inspectAgentInput({ kind: 'message-control', originalControlOperationId: report.groups.value!.items[0]!.incoming.value!.rows.find(row => row.ingressId === originalIngressId)!.inputOperationId! })
  expect(currentReceipt).toMatchObject({ status: 'waiting', control: { state: 'enabled', waiting: { phase: 'runtime', reason: 'runtime-unavailable' } }, admission: null })
  expect(runtime.input.mock.calls).toHaveLength(byteWrites)
  const group = report.groups.value!.items[0]!, incoming = group.incoming.value!, original = incoming.rows.find(row => row.ingressId === originalIngressId)!
  expect(original, JSON.stringify(original)).toMatchObject({ recording: { state: 'recorded' }, coreStatus: 'waiting' })
  // The strict public contract records no native adoption, or an observed unknown; neither confirms acceptance.
  expect([null, 'unknown'], JSON.stringify(original)).toContain(original.nativeAdoption)
  expect(menu().textContent).not.toContain('Accepted by Agent')
  // Pure presentation cases qualify mapping of the public typed receipt, not new native I/O.
  for (const [coreStatus, text] of [['terminal-confirmed', 'Input sent; Agent acceptance unconfirmed'], ['admitted', 'Accepted by Agent'], ['not-applied', 'Not delivered to Agent']] as const) {
    const snapshot = { report: { ...group, service: report.service, incoming: { value: { ...incoming, rows: [{ ...original, coreStatus }] }, issue: null } }, checkedAt: 1, checking: false }
    expect(connectorGroupDiagnostics(snapshot).rows.find(([label]) => label === 'Group → Agent')?.[1]).toContain(text)
    const summary = connectorGroupSummary(snapshot.report)
    expect(summary.incoming.value).toBe(coreStatus === 'terminal-confirmed' ? 'Sent to Agent · awaiting confirmation' : text)
    expect(summary.problems.some(problem => problem.kind === 'agent-unconfirmed')).toBe(coreStatus === 'terminal-confirmed')
  }
  expect(menu().textContent).not.toContain('PRIVATE incoming original')
}, 30_000)

it('a late old-source and revised-target result cannot replace the checked current original group', async () => {
  const binding = await bind(); await renderHeader([binding]); await wait(() => expect(trigger().getAttribute('aria-label')).not.toContain('Checking…'))
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

it('application access observation stays separate from a healthy source and saved local rights through the public header and detail readers', async () => {
  const binding = await bind()
  await f.forward('connection.grant', { operationId: 'access-observation-local', bindingId: binding.bindingId, expectedBindingRevision: binding.revision,
    grantId: 'access-observation-member', expectedRevision: null, actor: { application: binding.application, idType: 'open_id', userId: 'original-external-user' }, state: 'active', capabilities: ['input', 'permission'] })
  const read = f.services.bindings!.effectiveGrants.bind(f.services.bindings!)
  // The original access reader has a partial application observation. The original
  // source reader, saved local grants and platform receipts remain independently real.
  vi.spyOn(f.services.bindings!, 'effectiveGrants').mockImplementation((...args) => ({ ...read(...args), issue: 'application-unconfirmed' }))
  f.services.publication!.refresh()
  await wait(() => expect(f.services.publication!.observation(binding.bindingId, binding.revision).reason).toBe('access-unconfirmed'))
  const before = { writes: writes(), effects: effects() }
  await open(); await check()
  await wait(() => expect(menu().querySelector('[data-problem-kind="access-unconfirmed"]')?.textContent ?? '').toContain('Member access check unavailable'))
  expect(menu().querySelector('[data-problem-kind="source-unconfirmed"]')).toBeNull()
  expect(menu().querySelector('[data-problem-kind="member-access"]')).toBeNull()
  expect(menu().textContent).toContain('Read confirmed')
  expect(menu().textContent).toContain('Application permissions could not be checked; saved decisions are kept')
  await f.dom.render(<ConnectorDeliveryDetails binding={binding} hostingTarget={f.hostingTarget} />)
  await wait(() => expect(document.querySelector('[aria-label="Group delivery"]')?.textContent).toContain('Member access check unavailable'))
  const details = document.querySelector('[aria-label="Group delivery"] details')!
  expect(details.textContent).toContain('Application permissions could not be checked; saved decisions are kept')
  expect(details.textContent).not.toContain('Source observation: unavailable')
  const report = await f.forward('connection.diagnose', { ...target, bindingId: binding.bindingId, bindingRevision: binding.revision })
  expect(report.groups.value!.items[0]!.binding.value).toMatchObject({ activeInputGrants: 1, activePermissionGrants: 1 })
  expect(report.groups.value!.items[0]!.outgoing.value?.sourceObservation?.state).toBe('ready')
  expect({ writes: writes(), effects: effects() }).toEqual(before)
}, 30_000)

it('recent confirmed deliveries stay neutral while an older unconfirmed original remains visible', async () => {
  const binding = await bind(true); lose = true
  await appendFile(f.original.transcript, row('older-unknown', 'assistant'))
  await wait(() => expect(speech(binding)[0]?.state).toBe('unknown'))
  lose = false
  await appendFile(f.original.transcript, Array.from({ length: 5 }, (_, index) => row('recent-confirmed-' + index, 'assistant')).join(''))
  await wait(() => expect(speech(binding).filter(value => value.state === 'confirmed')).toHaveLength(5))
  const before = effects()
  await open(); await wait(() => expect(checked()).not.toBeNull())
  const outgoing = menu().querySelector('[data-direction="outgoing"]')!
  expect(outgoing?.getAttribute('data-tone')).toBe('neutral')
  expect(outgoing?.textContent).toContain('5')
  expect(menu().querySelector('[data-problem-kind="outgoing-unconfirmed"]')).not.toBeNull()
  expect(menu().textContent).not.toContain('All messages delivered')
  expect(effects()).toBe(before)
}, 30_000)

it('one explicit header action resumes the exact paused group through the original form and public operation', async () => {
  const binding = await bind()
  const paused = await f.forward('connection.binding.pause', { operationId: 'header-one-click-pause', bindingId: binding.bindingId, expectedRevision: binding.revision })
  await act(async () => invalidateConnectorTarget(target))
  await open(); await wait(() => expect(menu().querySelector('[data-connection-action="resume"]')).not.toBeNull())
  const before = f.calls.filter(call => call.method === 'connection.binding.resume').length
  await act(async () => menu().querySelector<HTMLElement>('[data-connection-action="resume"]')!.click())
  await wait(() => expect(f.services.bindings!.listActive().find(value => value.bindingId === binding.bindingId)?.state).toBe('active'))
  const sent = f.calls.filter(call => call.method === 'connection.binding.resume').slice(before)
  expect(sent).toHaveLength(1)
  expect(sent[0]!.input).toMatchObject({ bindingId: binding.bindingId, expectedRevision: paused.binding!.revision })
  expect(sent[0]!.result).toMatchObject({ state: 'applied', binding: { bindingId: binding.bindingId, state: 'active' } })
  await f.button('Close'); await open(); await wait(() => expect(checked()).not.toBeNull())
  expect(f.calls.filter(call => call.method === 'connection.binding.resume')).toHaveLength(before + 1)
  expect(f.calls.filter(call => /connection\.grant|connection\.service\.configure/.test(call.method))).toHaveLength(0)
}, 30_000)

it('an open popover observes recovery automatically and closes without polling or replaying writes', async () => {
  const binding = await bind()
  let unavailable = true, entered = 0, inFlight = 0, maximum = 0, release!: () => void
  let held: Promise<void> | null = null
  vi.mocked(api.connections.call).mockImplementation(async (method, input, owner) => {
    if (method !== 'connection.diagnose') return f.forward(method, input, owner)
    entered++; maximum = Math.max(maximum, ++inFlight)
    try { if (held) await held; if (unavailable) throw Error('Temporary observation unavailable'); return await f.forward(method, input, owner) }
    finally { inFlight-- }
  })
  await open(); await wait(() => expect(menu().textContent).toContain('Unavailable'))
  unavailable = false
  held = new Promise(resolve => { release = resolve })
  // No click or focus event: the open surface observes its original owner again.
  await wait(() => expect(inFlight).toBe(1))
  await act(async () => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus')) })
  expect(maximum).toBe(1)
  await act(async () => { release(); held = null })
  await wait(() => { expect(menu().textContent).toContain('Linked'); expect(menu().textContent).not.toContain('Kept after this check failed') })
  // The refresh only reads the existing owner; it does not change paused policies or send again.
  expect(f.calls.filter(call => call.method === 'connection.binding.resume' || call.method === 'connection.delivery.retry')).toHaveLength(0)
  await act(async () => menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await wait(() => expect(menu()).toBeNull())
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  const closed = entered
  await act(async () => window.dispatchEvent(new Event('focus')))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
  expect(entered).toBe(closed)
  expect(f.services.bindings!.listActive().find(value => value.bindingId === binding.bindingId)?.state).toBe('active')
}, 30_000)

it('opening a retained setup on another Host never carries the first group resume action', async () => {
  const binding = await bind()
  const paused = await f.forward('connection.binding.pause', { operationId: 'retarget-initial-pause', bindingId: binding.bindingId, expectedRevision: binding.revision })
  await act(async () => invalidateConnectorTarget(target))
  await open(); await wait(() => expect(menu().querySelector('[data-connection-action="resume"]')).not.toBeNull())
  await act(async () => menu().querySelector<HTMLElement>('[data-connection-action="resume"]')!.click())
  await wait(() => expect(f.services.bindings!.listActive().find(value => value.bindingId === binding.bindingId)?.state).toBe('active'))
  const otherHost = { hostId: 'other-host', runtimeId: 'other-runtime' }
  let foreignReads = 0, foreignWrites = 0
  vi.mocked(api.connections.call).mockImplementation(async (method, input, owner) => {
    if (owner?.hostId === otherHost.hostId) {
      if (method === 'connection.binding.resume') { foreignWrites++; throw Error('Unexpected cross-owner resume') }
      if (method === 'connection.binding.ls') { foreignReads++; return { bindings: [paused.binding!] } }
      if (method === 'connection.binding.inspect' && 'bindingId' in input)
        return { ...await f.forward(method, input, f.hostingTarget), binding: paused.binding!, current: paused.binding! }
      return f.forward(method, input, f.hostingTarget)
    }
    return f.forward(method, input, owner)
  })
  const prior = { method: 'connection.binding.pause' as const, target, hostingTarget: otherHost, phase: 'may-have-dispatched' as const,
    input: { operationId: 'retarget-original-unknown', bindingId: binding.bindingId, expectedRevision: binding.revision } }
  await act(async () => useAppStore.setState(state => ({ connectorRoomIntents: { ...state.connectorRoomIntents, [prior.input.operationId]: prior } })))
  await f.button('Open original setup')
  await wait(() => { expect(foreignReads).toBeGreaterThan(0); expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Sharing paused') })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  expect(foreignWrites).toBe(0)
  expect(useAppStore.getState().connectorRoomIntents[prior.input.operationId]).toEqual(prior)
  expect(f.services.bindings!.listActive().find(value => value.bindingId === binding.bindingId)?.state).toBe('active')
}, 30_000)

it('opening a later platform reads that platform and closing starts no new group checks', async () => {
  const binding = await bind()
  const bindings = Array.from({ length: 6 }, (_, i) => i === 5 ? { ...binding, bindingId: 'original-discord-binding', externalConversationId: '123456789012345678', application: { domain: 'discord.com', appId: '234567890123456789' } } : { ...binding, bindingId: i ? 'earlier-lark-' + i : binding.bindingId })
  await renderHeader(bindings)
  await wait(() => expect(f.calls.filter(call => call.method === 'connection.diagnose' && (call.input as { bindingId: string }).bindingId === 'earlier-lark-4').length).toBeGreaterThan(0))
  const discord = document.querySelector<HTMLElement>('[data-channel-entry="discord"]')!
  await act(async () => { discord.focus(); discord.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  await wait(() => expect(f.calls.filter(call => call.method === 'connection.diagnose' && (call.input as { bindingId: string }).bindingId === 'original-discord-binding').length).toBeGreaterThan(0))
  await wait(() => expect(menu()?.querySelector('time')).not.toBeNull())
  const before = f.calls.filter(call => call.method === 'connection.diagnose').length
  await act(async () => menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await wait(() => expect(menu()).toBeNull())
  await act(async () => { window.dispatchEvent(new Event('focus')); await new Promise(resolve => setTimeout(resolve, 50)) })
  expect(f.calls.filter(call => call.method === 'connection.diagnose')).toHaveLength(before)
}, 30_000)

it('a disabled platform action opens the exact bot settings on its original Host', async () => {
  const binding = await bind()
  await f.forward('connection.grant', { operationId: 'settings-origin-member', bindingId: binding.bindingId, expectedBindingRevision: binding.revision,
    grantId: 'settings-origin-access', expectedRevision: null, actor: { application: f.config.application, idType: 'open_id', userId: 'original-external-user' }, capabilities: ['input'], state: 'active' })
  const policy = await f.forward('connection.service.get', { adapterId: f.config.adapterId })
  await f.forward('connection.service.configure', { operationId: 'settings-origin-off', adapterId: f.config.adapterId, expectedRevision: policy.revision, service: { enabled: false } })
  await act(async () => invalidateConnectorTarget(target))
  await open(); await wait(() => expect(menu().querySelector('[data-connection-action="channel-settings"]')).not.toBeNull())
  await act(async () => menu().querySelector<HTMLElement>('[data-connection-action="channel-settings"]')!.click())
  expect(f.settings).toHaveBeenCalledWith({ sessionId: f.session.id, hostId: target.executionHostId, agentSessionId: target.agentSessionId, hostingTarget: f.hostingTarget,
    connection: { connectionId: binding.connectionId, adapterId: f.config.adapterId, application: binding.application } })
  expect((await f.forward('connection.service.get', { adapterId: f.config.adapterId })).enabled).toBe(false)
}, 30_000)


it('the actual header explains an unsupported message without blaming member access or losing delivered replies', async () => {
  const binding = await bind(false); await wait(() => expect(f.ingressTransport!.sockets).toHaveLength(1))
  await f.forward('connection.grant', { operationId: 'header-supported-member', bindingId: binding.bindingId, expectedBindingRevision: binding.revision, grantId: 'supported-member-input', expectedRevision: null,
    actor: { application: f.config.application, idType: 'open_id', userId: 'original-external-user' }, capabilities: ['input', 'answer', 'permission'], state: 'active' })
  await appendFile(f.original.transcript, row('supported-original-reply', 'assistant'))
  await wait(() => expect(speech(binding).at(-1)?.state).toBe('confirmed'))
  const originalReply = speech(binding).at(-1)!, originalEffects = effects()
  const payload = feishuPayload({ message_id: 'header-unsupported-image', chat_id: binding.externalConversationId, message_type: 'image', content: JSON.stringify({ image_key: 'PRIVATE original image' }) })
  payload.header.event_id = 'header-unsupported-image-event'
  await f.ingressTransport!.receive(payload)
  await vi.waitFor(async () => {
    const report = await f.forward('connection.diagnose', { ...target, bindingId: binding.bindingId, bindingRevision: binding.revision })
    const group = report.groups.value!.items[0]!
    expect(group.binding.value).toMatchObject({ activeInputGrants: 1, activeAnswerGrants: 1, activePermissionGrants: 1 })
    expect(group.incoming.value?.rows[0]).toMatchObject({ state: 'refused', code: 'INGRESS_CONTENT_UNSUPPORTED', inputOperationId: null, recording: { state: 'refused' } })
  }, { timeout: 8000 })
  await open(); await wait(() => expect(menu().textContent).toContain('Message type not supported'))
  const incoming = menu().querySelector('[data-direction="incoming"]')!
  expect(incoming.textContent).toContain('Message type not supported')
  expect(menu().querySelector('[data-direction="outgoing"]')!.textContent).toMatch(/delivered/)
  expect(menu().querySelector('[data-problem-kind="recording-unconfirmed"]')).toBeNull()
  expect(menu().querySelector('[data-problem-kind="member-access"]')).toBeNull()
  expect(menu().querySelector('[data-connection-action="members"]')).toBeNull()
  expect(menu().textContent).toContain('Try a text message')
  expect(menu().textContent).toContain('Message not recorded')
  expect(menu().textContent).not.toContain('PRIVATE original image')
  expect(menu().querySelector('.connector-header-menu__item small')?.getAttribute('title')).toContain('User and Agent-to-Agent messages are not shared')
  expect(speech(binding).find(value => value.operationId === originalReply.operationId)).toEqual(originalReply)
  expect(effects()).toBe(originalEffects)
  const before = writes(); await check(); await wait(() => expect(menu().textContent).toContain('Message type not supported'))
  expect(writes()).toBe(before)
}, 30_000)
