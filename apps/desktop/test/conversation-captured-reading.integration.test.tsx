// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentMuxStoredAgentSession, type AgentSessionHistoryPage } from '@agentmux/core'
import type { AgentSessionControl, AgentTimelineItem } from '../src/shared/contracts'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { processNativeRecordIds } from './helpers/conversation-process-members'
import { useAppStore } from '../src/renderer/src/store'
import { createClientUiRoot } from './helpers/client-ui-render'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


type Provider = 'claude' | 'codex'
const sid = 'captured-reading-session', native = 'captured-reading-native'
const control: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId: sid, run: { runId: 'original-run' } }
const initial = useAppStore.getState(), draft = 'Keep the unsent reading draft.'
let host: HTMLDivElement, root: Root, directory: string, transcript: string, provider: Provider
let client: AgentMuxClient, stored: AgentMuxStoredAgentSession, originalStore: Buffer, expectedTranscript: Buffer
let requests: { cursor?: string; limit?: number }[], pending: Promise<AgentSessionHistoryPage>[]
let controls: ReturnType<typeof vi.spyOn>[], nativeVisible: boolean, capturedItems: AgentTimelineItem[], viewportWidth: number
let observation: Parameters<AgentMuxClient['observeSessionHistory']>[1] | null
let closes: Array<() => unknown | Promise<unknown>>, publishedCaptured: Map<string, string>
function record(id: string, text?: string) {
  return provider === 'claude'
    ? { uuid: id, type: 'assistant', sessionId: native, timestamp: new Date(_historyFixtureEpoch(0, 0, 1)).toISOString(), message: { role: 'assistant', content: text
      ? [{ type: 'text', text }] : [{ type: 'tool_use', id: `call-${id}`, name: 'read', input: { file: id } }] } }
    : { type: 'response_item', timestamp: new Date(_historyFixtureEpoch(0, 0, 1)).toISOString(), payload: text ? { type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text }] }
      : { type: 'function_call', id, call_id: `call-${id}`, name: 'read', arguments: JSON.stringify({ file: id }) } }
}
function captured(id: string, text: string): AgentTimelineItem {
  return { id, agentSessionId: sid, kind: 'assistant_message', source: 'native-hook', status: 'complete',
    createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1), title: 'Captured observation', content: text }
}
function Reading({ enabled = true }: { enabled?: boolean }) {
  return <ActivityView sessionId={sid} executionHostId="local" capability="complete-events" displayState="working"
    conversationReading={{ reference: control, identity: control.run.runId, enabled, nativeSourceFacts: stored }} />
}
function rect(top: number, height: number, width = viewportWidth): DOMRect {
  return { x: 0, y: top, top, bottom: top + height, left: 0, right: width, width, height, toJSON() {} }
}
function viewport() { const feed = host.querySelector<HTMLElement>('.activity-feed')!; expect(feed).not.toBeNull(); return feed }
function nativeIds() {
  return [...host.querySelectorAll<HTMLElement>('.conversation-native-thread > [data-native-record-id], .conversation-native-thread > [data-conversation-process-members]')]
    .flatMap(row => row.dataset.conversationProcessMembers ? processNativeRecordIds(row) : [row.dataset.nativeRecordId!])
}
function latest() { const action = host.querySelector<HTMLButtonElement>('[data-message-tool-control="jump-to-latest"]'); expect(action).not.toBeNull(); return action! }
async function flush() {
  for (let n = 0; n < 4; n++) await act(async () => { await Promise.allSettled([...pending]); await new Promise(resolve => setTimeout(resolve, 10)) })
}
async function render(enabled = true) {
  for (const item of capturedItems) if (publishedCaptured.get(item.id) !== JSON.stringify(item)) {
    await client['persistAndPublishTimeline']({ type: 'upsert', agentSessionId: sid, item }, { source: 'agentmux', observedAt: item.updatedAt }, 'local')
    publishedCaptured.set(item.id, JSON.stringify(item))
    // This explicit fixture source write is separate from the read-only UI actions.
    originalStore = await readFile(join(directory, 'sessions.json'))
  }
  await act(async () => root.render(<Reading enabled={enabled} />)); await flush()
}
async function wheel(nativeInView: boolean, input: 'wheel' | 'key' = 'wheel') {
  nativeVisible = nativeInView
  const feed = viewport(); feed.scrollTop = nativeInView ? 100 : 500
  const segment = host.querySelector<HTMLElement>('[data-segment-key]')!; expect(segment).not.toBeNull()
  await act(async () => input === 'wheel'
    ? segment.dispatchEvent(new WheelEvent('wheel', { deltaY: -60, bubbles: true }))
    : segment.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true })))
  await act(async () => feed.dispatchEvent(new Event('scroll')))
  await flush()
}
async function fixture(shape: Provider, width = 500) {
  provider = shape; viewportWidth = width
  directory = await mkdtemp(join(tmpdir(), 'conversation-captured-reading-')); transcript = join(directory, 'native.jsonl')
  const rows: unknown[] = Array.from({ length: 450 }, (_, i) => record(`record-${i}`, i === 449 ? 'Original current native reply.' : undefined))
  if (provider === 'codex') rows.unshift({ type: 'session_meta', payload: { id: native, cwd: directory } })
  await writeFile(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n'); expectedTranscript = await readFile(transcript)
  const store = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json'))
  stored = { kind: 'agent', agentSessionId: sid, providerId: provider, executorId: provider, hostId: 'local', workspacePath: directory,
    run: control.run, retiredRuns: [], hookBindingId: 'original-binding', hookToken: 'original-token', createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1),
    nativeHandle: { kind: 'provider', providerId: provider, sessionId: native, transcriptPath: transcript } }
  await store.compareAndSwap(null, stored); originalStore = await readFile(join(directory, 'sessions.json'))
  client = new AgentMuxClient({ store }); const kernel = Reflect.get(client, 'kernel')
  controls = ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name).mockImplementation(() => { throw Error('Reading cannot control Runtime ' + name) }))
  const historyPage = client.sessionHistoryPage.bind(client), observeHistory = client.observeSessionHistory.bind(client)
  vi.spyOn(client, 'sessionHistoryPage').mockImplementation((agentSessionId, options) => {
    expect(agentSessionId).toBe(sid); requests.push(options ?? {})
    const read = historyPage(agentSessionId, options); pending.push(read); return read
  })
  vi.spyOn(client, 'observeSessionHistory').mockImplementation((agentSessionId, listener, options) => { observation = listener; return observeHistory(agentSessionId, listener, options) })
  await desktopConversationReadBridge({ root: directory, client }, closes)
  useAppStore.setState({ sessions: [], timelines: {}, agentComposerDrafts: { [sid]: draft } })
  await render(); await vi.waitFor(async () => { await flush(); expect(nativeIds()).toHaveLength(300) }, { timeout: 10000, interval: 20 })
  expect(nativeIds().at(-1)).toBe('record-449')
  const feed = viewport(); Object.defineProperties(feed, { clientHeight: { configurable: true, value: 600 }, scrollHeight: { configurable: true, value: 2200 } })
  // Deliver the initial completed bottom scroll before simulating an upward gesture.
  feed.scrollTop = 1600; await act(async () => feed.dispatchEvent(new Event('scroll')))
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
  closes = []; publishedCaptured = new Map(); requests = []; pending = []; controls = []; nativeVisible = false; viewportWidth = 500; observation = null
  capturedItems = [captured('captured-original', 'Captured content remains readable.\n\n' + 'Original captured paragraph. '.repeat(80))]
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const feed = host.querySelector<HTMLElement>('.activity-feed'), top = feed?.scrollTop ?? 0
    if (this.matches('.activity-feed')) return rect(0, 600)
    if (this.matches('[data-native-record-id], .wf-card--observation > .wf-head')) return rect(nativeVisible ? 20 : -1000, 30)
    if (this.matches('[data-segment-key]')) return rect(400 - top, 1800)
    if (this.matches('.activity-feed__reading')) return rect(20 - top, 30)
    if (this.matches('[data-conversation-native-tail], .activity-log')) return rect(400 - top, 0)
    if (this.matches('[data-conversation-reading-tail], [data-conversation-reading-space]')) return rect(2200 - top, 0)
    return rect(-1000, 0)
  })
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges()
  try {
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every(request => request.limit !== undefined && request.limit > 0 && request.limit <= 100)).toBe(true)
    expect(controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(await readFile(join(directory, 'sessions.json'))).toEqual(originalStore)
    expect(await readFile(transcript)).toEqual(expectedTranscript)
    expect(useAppStore.getState().agentComposerDrafts[sid]).toBe(draft)
  } finally { for (const close of closes.reverse()) await close(); await client.dispose(); await rm(directory, { recursive: true }); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() }
})

it.each([{ provider: 'claude', width: 360 }, { provider: 'claude', width: 1100 },
  { provider: 'codex', width: 360 }, { provider: 'codex', width: 1100 }] as const)('$provider captured-only reading at width $width does not borrow the native Earlier cursor, while visible native content still pages normally', async shape => {
  await fixture(shape.provider, shape.width)
  const before = nativeIds(), count = requests.length, cursors = requests.filter(request => request.cursor).length
  const process = host.querySelector<HTMLButtonElement>('.wf-card--observation > .wf-head')!
  expect(process).not.toBeNull(); await act(async () => process.click()); expect(process.getAttribute('aria-expanded')).toBe('true')
  const row = host.querySelector('[data-native-record-id="record-449"]')!, body = row.querySelector('.log-turn__body p')!.firstChild!
  const range = document.createRange(); range.selectNodeContents(body); window.getSelection()!.addRange(range)
  await wheel(false)
  expect(requests, 'Captured-only wheel must not issue an original-sequence cursor read').toHaveLength(count)
  expect(nativeIds()).toEqual(before); expect(body.isConnected).toBe(true); expect(window.getSelection()!.getRangeAt(0)).toBe(range)
  expect(process.isConnected).toBe(true); expect(process.getAttribute('aria-expanded')).toBe('true')
  window.getSelection()!.removeAllRanges()
  await wheel(false, 'key'); expect(requests).toHaveLength(count)
  capturedItems = [...capturedItems, captured('captured-new', 'New captured observation.')]; await render()
  expect(nativeIds()).toEqual(before)
  expect(host.textContent, 'A historical accepted window does not invent the later captured record').not.toContain('New captured observation.')
  expect(viewport().scrollTop, 'Captured reading does not force follow when a later observation arrives').toBe(500)
  await act(async () => useAppStore.setState({ timelines: { unrelated: { agentSessionId: 'unrelated', revision: 1, items: [] } } }))
  await render(); expect(requests).toHaveLength(count)
  await act(async () => latest().click()); await flush()
  await vi.waitFor(async () => { await flush(); expect(host.textContent).toContain('New captured observation.') }, { timeout: 10000, interval: 20 })
  await wheel(true)
  expect(requests.filter(request => request.cursor).length).toBeGreaterThan(cursors)
  await vi.waitFor(async () => { await flush(); expect(nativeIds()).toHaveLength(450) }, { timeout: 10000, interval: 20 }); expect(nativeIds().at(-1)).toBe('record-449')
  expect(host.querySelector('[data-native-record-id="record-449"]')).toBe(row)
  await appendFile(transcript, JSON.stringify(record('current-appended', 'Latest original native answer.')) + '\n'); expectedTranscript = await readFile(transcript)
  await act(async () => observation?.({ agentSessionId: sid, source: { providerId: provider, nativeSessionId: native }, kind: 'invalidated' })); await flush()
  await act(async () => latest().click()); await flush()
  await vi.waitFor(async () => { await flush(); expect(nativeIds().at(-1)).toBe('current-appended') }, { timeout: 10000, interval: 20 })
  // The first Current accepts the original current source; returning to that loaded tail is scroll-only.
  const beforeReturn = requests.length
  const feed = viewport(); feed.scrollTop = 500; await act(async () => feed.dispatchEvent(new Event('scroll')))
  await act(async () => latest().click()); await flush()
  expect(requests, 'a second return to the accepted current source only scrolls').toHaveLength(beforeReturn)
  expect(nativeIds().at(-1)).toBe('current-appended')
  expect(host.textContent).toContain('Latest original native answer.'); expect(host.textContent).toContain('New captured observation.')
})

it('keeps a selected native record during current append and adds no paging demand while hidden', async () => {
  await fixture('claude'); await wheel(true)
  const selected = host.querySelector('.conversation-native-thread [data-conversation-process-members]')!
  const head = selected.querySelector<HTMLElement>('.wf-head')!; expect(head).not.toBeNull()
  const range = document.createRange(); range.selectNodeContents(head); window.getSelection()!.addRange(range)
  await appendFile(transcript, JSON.stringify(record('current-appended', 'Latest original native answer.')) + '\n'); expectedTranscript = await readFile(transcript)
  await act(async () => observation?.({ agentSessionId: sid, source: { providerId: provider, nativeSessionId: native }, kind: 'invalidated' })); await flush()
  const before = nativeIds(); await act(async () => latest().click()); await flush()
  expect(nativeIds()).toEqual(expect.arrayContaining(before))
  expect(selected.isConnected).toBe(true); expect(head).toBe(selected.querySelector('.wf-head')); expect(window.getSelection()!.getRangeAt(0)).toBe(range)
  expect(range.startContainer.isConnected).toBe(true)
  await act(async () => { window.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) }); await flush()
  if (host.querySelector('[data-message-tool-control="jump-to-latest"]')) await act(async () => latest().click())
  await vi.waitFor(async () => { await flush(); expect(nativeIds().at(-1)).toBe('current-appended') }, { timeout: 10000, interval: 20 })
  await render(false); const count = requests.length
  await wheel(false); await wheel(true); expect(requests).toHaveLength(count)
})
