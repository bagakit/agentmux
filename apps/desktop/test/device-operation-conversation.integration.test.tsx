import { fixtureIso as _hygiene_fixtureIso } from '../scripts/lib/fixture-values.mjs'
// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentPromptCondition, AgentMuxFileAgentSessionStore, type AgentTimelineItem } from '@agentmux/core'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service'
import { hostedTestOwner, hostedTestFence } from '../../../packages/core/test/helpers/hosted-runtime-port'
import { DeviceAuthority } from '../../host/src/device-authority'
import { reactionPublicClientFixture } from './helpers/reaction-public-client-fixture'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { activityReadingProps } from './helpers/activity-reading-props'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'
import { conversationMessageSourceKey } from '@agentmux/client-ui/conversation-message-location'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import type { AgentSessionControl } from '../src/shared/contracts'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-leaf="terminal" /> }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: () => <div data-leaf="composer" /> }))
vi.mock('../src/renderer/src/components/AgentRegionHeader', () => ({ AgentRegionHeader: () => <div data-leaf="header" /> }))
vi.mock('../src/renderer/src/components/SessionConnectingSurface', () => ({ SessionConnectingSurface: () => null }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
vi.mock('../src/renderer/src/components/AgentLifecycleFeedback', () => ({ AgentLifecycleFeedback: () => null }))
vi.mock('@agentmux/client-ui/components/AgentInteractionCard', () => ({ AgentInteractionCard: () => null }))
vi.mock('../src/renderer/src/components/OpenDestinationBar', () => ({ OpenDestinationPopover: () => null }))
import { SessionPane } from '../src/renderer/src/components/SessionPane'

const ID = 'private-agent', BODY = 'writeAgent · 已提交'
const initial = useAppStore.getState()
const closes: Array<() => unknown | Promise<unknown>> = []
const originals: Awaited<ReturnType<typeof nativeHistoryFixture>>[] = []
let container: HTMLDivElement, root: Root
const diagnostics = (id: string): AgentTimelineItem => ({ id, agentSessionId: ID, kind: 'system_message', source: 'agentmux',
  status: 'complete', title: '设备操作', content: BODY, createdAt: 1, updatedAt: 1 })
const realSystem = (): AgentTimelineItem => ({ ...diagnostics('original-system'), content: 'Original system remains readable.' })
const sourceFor = (authority: DeviceAuthority) => authority.operationSource({ kind: 'device', id: authority.hostId + ':' + authority.devices()[0]!.deviceId })!
async function device(path: string) {
  const authority = await DeviceAuthority.open(path)
  await authority.authorizeKey(Buffer.alloc(32, 4).toString('base64'))
  await authority.hello(authority.devices()[0]!.deviceId, 'Tablet')
  return authority
}
async function hosted() {
  const flow = await reactionPublicClientFixture(ID, 'run-' + ID)
  closes.push(async () => { await flow.settle(); await flow.close() })
  const authority = await device(join(dirname(flow.store.path), 'devices.json'))
  const service = new AgentMuxHostedRuntimeService(flow.client, flow.store.path, () => hostedTestOwner(flow.client))
  closes.push(() => service.dispose())
  const subscription = await service.subscribe('runtime.events', { fence: hostedTestFence, consumerId: 'reading-device' }, () => {})
  closes.push(() => subscription.dispose()); await subscription.start?.()
  const context = { sourceDevice: sourceFor(authority), recordDeviceOperation: authority.recordOperation.bind(authority) }
  const invoke = (method: string, args: unknown[], originalContext = context) => service.call('runtime.invoke', {
    fence: hostedTestFence, consumerId: 'reading-device', invocation: { method, args }
  }, originalContext)
  return { flow, authority, context, invoke }
}
async function nativeReading(withNative = true) {
  const f = await nativeHistoryFixture('claude', withNative ? jsonl([
    { sessionId: 'native-main', uuid: 'device-operation:native-opaque', type: 'user', message: { role: 'user', content: BODY }, timestamp: _hygiene_fixtureIso(24138000000, 'second') },
    { sessionId: 'native-main', uuid: 'native-answer', type: 'assistant', message: { role: 'assistant', content: 'The actual native reply remains readable.' }, timestamp: _hygiene_fixtureIso(24138001000, 'second') }
  ]) : '', { agentSessionId: ID })
  originals.push(f); closes.push(f.close)
  const authority = await device(join(f.root, 'devices.json'))
  const reads = vi.spyOn(f.client, 'sessionHistoryPage')
  await desktopConversationReadBridge(f, closes)
  const reference: AgentSessionControl = { kind: 'agent', hostId: f.session.hostId, agentSessionId: f.session.agentSessionId, run: f.session.run }
  return { ...f, authority, sourceDevice: sourceFor(authority), reads, reference }
}
type Reading = Awaited<ReturnType<typeof nativeReading>>
async function seed(f: Reading, items: readonly AgentTimelineItem[]) {
  for (const item of items) await f.client['persistAndPublishTimeline']({ type: 'upsert', agentSessionId: ID, item },
    { source: 'agentmux', observedAt: item.updatedAt }, f.reference.hostId)
  return f.client.sessionTimeline(ID)
}
async function ready(f: Reading) {
  await vi.waitFor(async () => {
    await act(async () => { await Promise.resolve() })
    const consumers = inspectConversationConsumers(f.reference).consumers
    expect(consumers.length).toBeGreaterThan(0)
    expect(consumers.every(value => value.accepted && !value.loading && !value.inFlight && !value.watch.binding && !value.dirty)).toBe(true)
  })
}
async function renderReading(f: Reading) {
  await act(async () => root.render(<ActivityView {...activityReadingProps({ control: f.reference })} />))
  await ready(f)
}
function card(id: string) {
  const key = conversationMessageSourceKey(ID, { kind: 'captured', recordId: id })
  const found = [...container.querySelectorAll<HTMLElement>('.log-turn')].filter(node => node.dataset.messageSourceKey === key)
  expect(found, id).toHaveLength(1); return found[0]!
}
async function expandSystem(node: HTMLElement) {
  expect(node.dataset.speakerRole).toBe('system')
  const button = node.querySelector<HTMLButtonElement>('.log-turn__system-toggle')!
  expect(button).not.toBeNull(); await act(async () => button.click())
  expect(node.querySelector('.log-turn__body')).not.toBeNull()
}
async function copy(node: ParentNode, text: string) {
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const button = node.querySelector<HTMLButtonElement>('[title="Copy message"]')!
  expect(button).not.toBeNull(); await act(async () => button.click()); expect(clipboard).toHaveBeenLastCalledWith(text)
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => {
  window.getSelection()?.removeAllRanges(); await act(async () => root.unmount()); container.remove()
  try { for (const native of originals) expect(native.controls.map(value => value.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]) }
  finally {
    for (const close of closes.splice(0).reverse()) await close()
    originals.splice(0); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
  }
})

describe('Device operations remain Host audit facts outside conversation', () => {
  it('preserves real Hosted input provenance and durable Host operation audit without chat duplication', async () => {
    const { flow, authority, context, invoke } = await hosted()
    const condition = agentPromptCondition(flow.client.agentSession(ID)), source = context.sourceDevice
    await invoke('submitAgentPrompt', [{ agentSessionId: ID, operationId: 'prompt-operation', prompt: 'A normal user request.', ...condition, authorHuman: true, sourceChannel: 'message-tool' }])
    await invoke('writeAgent', [{ agentSessionId: ID, expectedRun: { runId: 'run-' + ID }, data: 'x', source: 'user' }])
    const reloaded = new AgentMuxFileAgentSessionStore(flow.store.path), timeline = await reloaded.loadTimeline(ID)
    const prompt = timeline.items.find(item => item.kind === 'user_message')!
    expect(prompt, 'Nonempty actual accepted durable prompt').toBeDefined(); expect(prompt.content).toBe('A normal user request.')
    expect(prompt.sourceDevice).toEqual(source); expect(prompt.sourceChannel).toBe('message-tool')
    expect(flow.writes).toHaveLength(2); expect(flow.writes[1]).toBe('x')
    expect(timeline.items.filter(item => item.id.startsWith('device-operation:'))).toEqual([])
    const reopened = await DeviceAuthority.open(join(dirname(flow.store.path), 'devices.json'))
    expect(reopened.devices()[0]!.operations).toHaveLength(2)
    expect(reopened.devices()[0]!.operations!.map(operation => [operation.method, operation.result])).toEqual([['submitAgentPrompt', 'confirmed'], ['writeAgent', 'confirmed']])
  })
  it('keeps successful healthy input when Host audit saving is unconfirmed and rejects wire provenance independently', async () => {
    const { flow, context, invoke } = await hosted()
    const originalContext = { ...context, recordDeviceOperation: async () => { throw new Error('Controlled Host audit save failure') } }
    await invoke('writeAgent', [{ agentSessionId: ID, expectedRun: { runId: 'run-' + ID }, data: 'x', source: 'user' }], originalContext)
    expect(flow.writes).toEqual(['x']); expect(flow.client.agentSession(ID).run.runId).toBe('run-' + ID)
    await expect(invoke('writeAgent', [{ agentSessionId: ID, expectedRun: { runId: 'run-' + ID }, data: 'evil', source: 'user', sourceDevice: { hostId: 'forged', deviceId: 'forged', name: 'Forged' } }])).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    expect(flow.writes).toEqual(['x']); expect((await flow.client.sessionTimeline(ID)).items).toEqual([])
  })
})

describe('Original recorded device-like IDs use the same current conversation reader', () => {
  it('retains original system, user and process records without filtering their IDs or rewriting durable bytes', async () => {
    const f = await nativeReading()
    const legacy = diagnostics('device-operation:legacy')
    const user: AgentTimelineItem = { ...diagnostics('device-operation:user'), kind: 'user_message', source: 'user', authorHuman: true }
    const agent: AgentTimelineItem = { ...diagnostics('agent-input'), kind: 'user_message', source: 'user', authorAgentSessionId: 'sender-agent' }
    const otherSource: AgentTimelineItem = { ...diagnostics('device-operation:foreign'), source: 'native-hook' }
    const process: AgentTimelineItem = { ...diagnostics('device-operation:process'), kind: 'lifecycle', source: 'native-hook' }
    const items = [legacy, user, agent, otherSource, realSystem(), process], timeline = await seed(f, items)
    const originalBytes = await f.bytes()
    expect(originalBytes.store.subarray(0, 16).toString()).toBe('SQLite format 3\0')
    await renderReading(f)
    for (const id of [legacy.id, realSystem().id]) {
      const node = card(id); await expandSystem(node); expect(node.querySelector('.log-turn__body')?.textContent).toBe(items.find(item => item.id === id)!.content)
    }
    for (const item of [user, agent]) {
      const submission = [...container.querySelectorAll<HTMLElement>('[data-submission-id]')].find(node => node.dataset.submissionId === item.id)!
      expect(submission).toBeDefined()
      const summary = submission.querySelector<HTMLElement>('.message-disclosure > summary')!
      expect(summary).not.toBeNull(); await act(async () => summary.click())
    }
    expect(card(user.id).dataset.speakerRole).toBe('human'); expect(card(agent.id).dataset.speakerRelation).toBe('other-agent')
    expect(card(otherSource.id)).not.toBeNull()
    for (const toggle of container.querySelectorAll<HTMLButtonElement>('.wf-head[aria-expanded="false"]')) await act(async () => toggle.click())
    const row = container.querySelector<HTMLButtonElement>('[data-observation-step-id="device-operation:process"]')!
    expect(row).not.toBeNull(); expect(row.hasAttribute('data-speaker-role')).toBe(false)
    await act(async () => row.click()); expect(row.parentElement?.querySelector('pre')?.textContent).toBe(BODY)
    await copy(card(legacy.id), BODY)
    expect((await f.client.sessionTimeline(ID)).items).toEqual(timeline.items)
    expect(await f.bytes()).toEqual(originalBytes)
  })
  it('keeps an original system-only captured window readable and copyable rather than pretending it is empty', async () => {
    const f = await nativeReading(false), original = diagnostics('device-operation:only')
    await seed(f, [original]); await renderReading(f)
    const node = card(original.id); await expandSystem(node)
    expect(node.querySelector('.log-turn__body')?.textContent).toBe(BODY)
    expect(container.textContent).not.toContain('No structured activity yet')
    await copy(node, BODY)
    expect((await f.client.sessionTimeline(ID)).items).toEqual([original])
  })
  it('keeps actual SessionPane opaque native IDs, recorded Message Tool provenance, body Range and hidden Return without unrelated IO', async () => {
    const f = await nativeReading()
    // Controlled persisted reading input. The preceding Hosted cases separately prove actual write/audit provenance.
    const message: AgentTimelineItem = { ...diagnostics('recorded-message-tool'), kind: 'user_message', source: 'user', title: 'Original input',
      content: 'Original Message Tool body.', authorHuman: true, sourceChannel: 'message-tool', sourceDevice: f.sourceDevice, publicContent: 'confirmed' }
    const timeline = await seed(f, [message, diagnostics('device-operation:legacy'), realSystem()])
    const session = { ...composerSession(ID, 'claude'), workspacePath: f.root, control: f.reference }
    useAppStore.setState({ config: { ...composerConfig, executors: { ...composerConfig.executors,
      claude: { label: 'Claude', providerId: 'claude', command: 'claude', args: [], env: {}, injectAgentMuxGuide: true } },
      workspaces: composerConfig.workspaces.map(workspace => ({ ...workspace, path: f.root })) }, sessions: [session], viewModes: { [ID]: 'activity' },
      timelines: { [ID]: timeline }, agentComposerDrafts: { [ID]: 'Original unsent draft.' }, pendingAgentLaunches: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [] })
    const pane = (visible = true) => <SessionPane sessionId={ID} visible={visible} interactiveResize={false} surfaceKind="agent"
      linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' }} />
    await act(async () => root.render(pane())); await ready(f)
    expect(container.querySelector('[data-native-record-id="native-answer"]')).not.toBeNull()
    expect(container.querySelector('[data-native-record-id="device-operation:native-opaque"]')).not.toBeNull()
    expect(card('device-operation:legacy').dataset.speakerRole).toBe('system')
    const submission = container.querySelector<HTMLDetailsElement>('[data-submission-id="recorded-message-tool"] .message-disclosure')
    expect(submission).not.toBeNull()
    await act(async () => { submission!.open = true; submission!.dispatchEvent(new Event('toggle')) })
    const input = card(message.id)
    await act(async () => input.querySelector<HTMLButtonElement>('[aria-label="Message details"]')!.click())
    expect(input.textContent).toContain('Message Tool'); expect(input.textContent).toContain('Tablet'); expect(input.textContent).toContain(f.sourceDevice.hostId)
    await copy(input, message.content!)
    const body = container.querySelector('[data-native-record-id="device-operation:native-opaque"] .log-turn__body p')!, text = body.firstChild!, range = document.createRange()
    range.setStart(text, 0); range.setEnd(text, 5); window.getSelection()!.addRange(range); expect(window.getSelection()!.toString()).toBe('write')
    await act(async () => root.render(pane(false)))
    const count = [f.reads.mock.calls.length, vi.mocked(api.conversation.readAgentConversation).mock.calls.length, vi.mocked(api.conversation.readConversationChanges).mock.calls.length]
    await act(async () => useAppStore.setState(state => ({ agentNames: { ...state.agentNames, 'unrelated-agent': 'Unrelated rename' } })))
    expect([f.reads.mock.calls.length, vi.mocked(api.conversation.readAgentConversation).mock.calls.length, vi.mocked(api.conversation.readConversationChanges).mock.calls.length]).toEqual(count)
    expect(body.isConnected).toBe(true); expect(window.getSelection()!.getRangeAt(0)).toBe(range); expect(window.getSelection()!.toString()).toBe('write')
    await act(async () => root.render(pane())); await ready(f)
    expect(container.querySelector('[data-native-record-id="device-operation:native-opaque"] .log-turn__body p')).toBe(body)
    expect(window.getSelection()!.getRangeAt(0)).toBe(range); expect(range.startContainer).toBe(text)
    expect(useAppStore.getState().agentComposerDrafts[ID]).toBe('Original unsent draft.'); expect(session.control.run).toEqual(f.session.run)
  })
})
