// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import type { AgentSessionControl, AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { conversationPagePortFixture } from './helpers/conversation-page-port-fixture'
import { activityReadingProps } from './helpers/activity-reading-props'
import { createClientUiRoot } from './helpers/client-ui-render'
import { processNativeRecordIds } from './helpers/conversation-process-members'
import { fixturePath } from '../../../test/fixture-values.mjs'

vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-leaf="terminal" /> }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: () => <div data-leaf="composer" /> }))
vi.mock('../src/renderer/src/components/AgentRegionHeader', () => ({ AgentRegionHeader: () => <header data-leaf="header" /> }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))

const ID = 'private-agent', DRAFT = 'Keep the original unsent draft.'
const control: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId: ID, run: { runId: 'unchanged-private-run' } }
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private host' }], executors: {},
  workspaces: [{ id: 'ws', name: 'Private project', hostId: 'local', path: fixturePath('fixture'), kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const original = useAppStore.getState(), closes: Array<() => unknown | Promise<unknown>> = []
let host: HTMLDivElement, root: Root
const observeRuntimeControls = () => (['submitPrompt', 'write', 'resume', 'recover', 'stop'] as const).map(name => vi.spyOn(api.sessions, name))
let forbidden: ReturnType<typeof observeRuntimeControls> = []
const order = ['u-before', 'a-before', 'u-after', 'a-after']
function orderedData(provider: 'claude' | 'pi', cwd: string) {
  const values = [['u-before', 'user', 'Repeated native input.', 5000],
    ['a-before', 'assistant', [{ type: 'thinking', thinking: 'First recorded thinking.' }, { type: 'text', text: '### First recorded answer.\n\n[Review the source](https://example.test/context)' }], 4000],
    ['u-after', 'user', 'Repeated native input.', undefined],
    ['a-after', 'assistant', [{ type: 'thinking', thinking: 'Second recorded thinking.' }, { type: provider === 'claude' ? 'tool_use' : 'toolCall', id: 'call-2', name: 'Read', input: { file: 'src/second.ts' }, arguments: { file: 'src/second.ts' } }, { type: 'text', text: 'Second recorded answer.' }], 1000]] as const
  return jsonl(provider === 'claude' ? values.map(([uuid, type, content, time]) => ({ sessionId: 'native-main', uuid, type, message: { role: type, content }, ...(time === undefined ? {} : { timestamp: new Date(time).toISOString() }) }))
    : [{ type: 'session', version: 3, id: 'native-main', cwd }, ...values.map(([id, role, content, time], index) => ({ type: 'message', id, parentId: index === 0 ? null : values[index - 1]![0], message: { role, content }, ...(time === undefined ? {} : { timestamp: new Date(time).toISOString() }) }))])
}
function seed(provider: 'claude' | 'pi' = 'claude') {
  const session: Extract<SessionSnapshot, { kind: 'agent' }> = { id: ID, kind: 'agent', hostId: 'local', workspacePath: fixturePath('fixture'), label: 'Execution Agent', providerId: provider, executorId: provider,
    agentSessionUpdatedAt: 1, promptSubmissionPredecessor: null, createdAt: 1, updatedAt: 1, processState: 'running', status: { state: 'done', source: 'native-hook', observedAt: 1 }, latestOutputBytes: 0,
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' }, control }
  useAppStore.setState({ config, sessions: [session], pendingAgentLaunches: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [], viewModes: { [ID]: 'activity' }, timelines: {}, agentNames: {}, agentComposerDrafts: { [ID]: DRAFT }, agentSteerQueues: {} })
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host); seed()
  forbidden = observeRuntimeControls()
})
afterEach(async () => {
  const failures: unknown[] = []
  window.getSelection()?.removeAllRanges()
  try { await act(async () => root.unmount()) } catch (error) { failures.push(error) }
  host.remove()
  try { forbidden.forEach(call => expect(call).not.toHaveBeenCalled()) } catch (error) { failures.push(error) }
  forbidden.length = 0
  for (const close of closes.splice(0).reverse()) {
    try { await close() } catch (error) { failures.push(error) }
  }
  useAppStore.setState(original, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (failures.length) throw new AggregateError(failures, 'Original native-order fixture cleanup failed')
})
async function render(body: ReactNode) {
  await act(async () => root.render(body))
  await vi.waitFor(async () => {
    await act(async () => { await Promise.resolve() })
    const consumer = inspectConversationConsumers(control).consumers[0]
    expect(consumer?.accepted).toBeTruthy(); expect(consumer?.loading).toBe(false); expect(consumer?.inFlight).toBe(false)
  }, { timeout: 2000 })
}
function nativeIds() {
  return [...host.querySelector('.conversation-native-thread')!.children].flatMap(node =>
    node.hasAttribute('data-native-record-id') ? [node.getAttribute('data-native-record-id')!] : processNativeRecordIds(node))
}
function typedPage(items: AgentSessionHistoryPage['items']): AgentSessionHistoryPage {
  return { agentSessionId: ID, sourceHostId: 'local', source: { providerId: 'claude', nativeSessionId: 'native-main' }, items, nextCursor: null }
}
async function originalPage(page: AgentSessionHistoryPage) {
  const f = await conversationPagePortFixture(control, page.source, async () => page); closes.push(f.close)
  return f
}
for (const provider of ['claude', 'pi'] as const) it(provider + ' retains native user/assistant record order despite reversed or missing timestamps and equal bodies', async () => {
  const f = await nativeHistoryFixture(provider, cwd => orderedData(provider, cwd)); seed(provider)
  const originalSessions = await f.store.loadMetadata()
  closes.push(async () => {
    try {
      const bytes = await f.bytes(); expect(bytes.native).toEqual(f.before.native); expect(await f.store.loadMetadata()).toEqual(originalSessions)
      f.controls.forEach(call => expect(call).not.toHaveBeenCalled())
    } finally { await f.close() }
  })
  await desktopConversationReadBridge(f, closes)
  const originalRead = f.client['readSessionHistoryPage']
  const readDescriptor = Object.getOwnPropertyDescriptor(f.client, 'readSessionHistoryPage')
  const reads = vi.fn<typeof originalRead>((...args) => originalRead.call(f.client, ...args))
  f.client['readSessionHistoryPage'] = reads
  closes.push(() => {
    if (readDescriptor) Object.defineProperty(f.client, 'readSessionHistoryPage', readDescriptor)
    else Reflect.deleteProperty(f.client, 'readSessionHistoryPage')
  })
  await render(<SessionPane sessionId={ID} surfaceKind="agent" interactiveResize={false} visible linkOrigin={{ workspaceId: 'ws', tabGroupId: 'group', tabId: 'tab', regionId: 'region' }} />)
  expect(nativeIds()).toEqual(order)
  expect(host.textContent).toContain('First recorded answer.'); expect(host.textContent).toContain('Second recorded answer.')
  expect(host.querySelectorAll('[data-native-record-id="a-after"] [data-trace-kind]')).toHaveLength(2)
  expect(reads).toHaveBeenCalled(); expect(reads.mock.calls.every(([id]) => id === ID)).toBe(true)
  expect(useAppStore.getState().sessions[0]!.control).toEqual(control); expect(useAppStore.getState().agentComposerDrafts[ID]).toBe(DRAFT)
})
it('mounts source/rawID once and keeps every mixed reasoning/text/tool/resource part in source order', async () => {
  const parts: AgentSessionHistoryPage['items'][number]['contentParts'] = [{ kind: 'reasoning', text: 'Repeated thinking.' }, { kind: 'text', text: 'Visible answer.' },
    { kind: 'tool-call', name: 'Read', input: 'src/file.ts', callId: 'native-call' }, { kind: 'reasoning', text: 'Repeated thinking.' }, { kind: 'resource', resourceType: 'file', reference: 'src/file.ts' }]
  const one = { id: 'same-raw', kind: 'assistant-message' as const, contentParts: parts }, two = { ...one, id: 'distinct-raw' }
  const page = typedPage([{ id: 'u1', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Original input.' }] }, one, one,
    { id: 'u2', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Repeated native input.' }] }, two])
  await originalPage(page); await render(<ActivityView {...activityReadingProps({ control })} />)
  expect(nativeIds()).toEqual(['u1', 'same-raw', 'u2', 'distinct-raw'])
  const records = host.querySelectorAll('[data-native-record-id="same-raw"], [data-native-record-id="distinct-raw"]'); expect(records).toHaveLength(2)
  for (const record of records) expect([...record.querySelector('.log-turn__body')!.children].map(node => node.classList.contains('log-turn__text') ? 'text' : node.classList.contains('conversation-resource-file') ? 'resource' : node.getAttribute('data-trace-kind'))).toEqual(['reasoning', 'text', 'tool-call', 'reasoning', 'resource'])
  expect(host.querySelectorAll('[data-trace-kind="reasoning"]')).toHaveLength(4); expect(host.querySelectorAll('.log-turn__trace-body')).toHaveLength(0)
})
it('keeps native Continue on the exact source prefix including earlier assistant/tool/resource while excluding future input and redacted text', async () => {
  const page = typedPage([{ id: 'before', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Earlier answer.' }, { kind: 'tool-call', name: 'Read', input: 'src/earlier.ts' },
    { kind: 'tool-result', name: 'Read', output: 'Earlier tool result.' }, { kind: 'resource', resourceType: 'file', label: 'File', reference: 'src/earlier.ts' }, { kind: 'reasoning', text: 'Concealed reasoning.', redacted: true, signature: 'opaque' }] },
    { id: 'selected', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Selected input.' }] }, { id: 'later', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Future input.' }] }])
  await originalPage(page); const onContinue = vi.fn()
  await render(<ActivityView {...activityReadingProps({ control })} onContinue={onContinue} />)
  const button = host.querySelector<HTMLButtonElement>('[data-native-record-id="selected"] .log-turn__continue')!; expect(button).not.toBeNull()
  await act(async () => button.click())
  expect(onContinue).toHaveBeenCalledExactlyOnceWith('Continue this conversation from the selected point.\n\nAgent: Earlier answer.\nRead\nsrc/earlier.ts\nRead\nEarlier tool result.\nFile\nsrc/earlier.ts\n[Reasoning redacted]\n\nInput: Selected input.')
  expect(onContinue.mock.calls[0]![0]).not.toContain('Future input.'); expect(onContinue.mock.calls[0]![0]).not.toContain('Concealed reasoning.')
})
