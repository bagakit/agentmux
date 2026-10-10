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
import { api } from '../src/renderer/src/lib/api'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'
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
let observation: Parameters<typeof api.sessions.observeHistory>[1] | null
function record(id: string, text?: string) {
  return provider === 'claude'
    ? { uuid: id, type: 'assistant', sessionId: native, message: { role: 'assistant', content: text
      ? [{ type: 'text', text }] : [{ type: 'tool_use', id: `call-${id}`, name: 'read', input: { file: id } }] } }
    : { type: 'response_item', payload: text ? { type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text }] }
      : { type: 'function_call', id, call_id: `call-${id}`, name: 'read', arguments: JSON.stringify({ file: id }) } }
}
function captured(id: string, text: string): AgentTimelineItem {
  return { id, agentSessionId: sid, kind: 'assistant_message', source: 'native-hook', status: 'complete',
    createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1), title: 'Captured observation', content: text }
}
function Reading({ enabled = true }: { enabled?: boolean }) {
  const read = useSessionUserMessages(control, { enabled })
  return <ActivityView sessionId={sid} executionHostId="local" items={capturedItems} capability="complete-events" displayState="working"
    nativeHistoryPage={read.nativeHistoryPage} nativeContextItems={read.nativeContextItems} userMessages={read.messages}
    conversationReading={{ reference: control, identity: control.run.runId, enabled, nativeSourceFacts: stored }} />
}
function rect(top: number, height: number, width = viewportWidth): DOMRect {
  return { x: 0, y: top, top, bottom: top + height, left: 0, right: width, width, height, toJSON() {} }
}
function viewport() { const feed = host.querySelector<HTMLElement>('.activity-feed')!; expect(feed).not.toBeNull(); return feed }
function nativeIds() {
  return [...host.querySelectorAll<HTMLElement>('.conversation-native-thread > [data-native-record-id], .conversation-native-thread > [data-native-record-ids]')]
    .flatMap(row => row.dataset.nativeRecordIds ? JSON.parse(row.dataset.nativeRecordIds) as string[] : [row.dataset.nativeRecordId!])
}
function latest() { const action = host.querySelector<HTMLButtonElement>('[data-message-tool-control="jump-to-latest"]'); expect(action).not.toBeNull(); return action! }
async function flush() {
  for (let n = 0; n < 4; n++) await act(async () => { await Promise.allSettled([...pending]); await new Promise(resolve => setTimeout(resolve, 10)) })
}
async function render(enabled = true) { await act(async () => root.render(<Reading enabled={enabled} />)); await flush() }
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
  vi.spyOn(api.sessions, 'historyPage').mockImplementation((reference, options) => {
    expect(reference).toMatchObject({ hostId: 'local', agentSessionId: sid }); requests.push(options ?? {})
    const read = client.sessionHistoryPage(reference.agentSessionId, options); pending.push(read); return read
  })
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async (_reference, listener) => { observation = listener; return { source: { providerId: provider, nativeSessionId: native }, dispose() {} } })
  useAppStore.setState({ sessions: [], timelines: {}, agentComposerDrafts: { [sid]: draft } })
  await render(); expect(nativeIds()).toHaveLength(300); expect(nativeIds().at(-1)).toBe('record-449')
  const feed = viewport(); Object.defineProperties(feed, { clientHeight: { configurable: true, value: 600 }, scrollHeight: { configurable: true, value: 2200 } })
  // Deliver the initial completed bottom scroll before simulating an upward gesture.
  feed.scrollTop = 1600; await act(async () => feed.dispatchEvent(new Event('scroll')))
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
  requests = []; pending = []; controls = []; nativeVisible = false; viewportWidth = 500; observation = null
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
  } finally { await client.dispose(); await rm(directory, { recursive: true }); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() }
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
  expect(nativeIds()).toEqual(before); expect(host.textContent).toContain('New captured observation.')
  expect(viewport().scrollTop, 'Captured reading does not force follow when a later observation arrives').toBe(500)
  await act(async () => useAppStore.setState({ timelines: { unrelated: { agentSessionId: 'unrelated', revision: 1, items: [] } } }))
  await render(); expect(requests).toHaveLength(count)
  await wheel(true)
  expect(requests.filter(request => request.cursor).length).toBeGreaterThan(cursors)
  expect(nativeIds()).toHaveLength(450); expect(nativeIds().at(-1)).toBe('record-449')
  expect(host.querySelector('[data-native-record-id="record-449"]')).toBe(row)
  await appendFile(transcript, JSON.stringify(record('current-appended', 'Latest original native answer.')) + '\n'); expectedTranscript = await readFile(transcript)
  await act(async () => observation?.({ agentSessionId: sid, source: { providerId: provider, nativeSessionId: native }, kind: 'invalidated' })); await flush()
  for (let attempt = 0; attempt < 20 && nativeIds().at(-1) !== 'current-appended'; attempt++) await flush()
  expect(nativeIds().at(-1), 'the original observed source is adopted before the scroll action').toBe('current-appended')
  const beforeReturn = requests.length
  await act(async () => latest().click()); await flush()
  expect(requests, 'return to the already updated current source only scrolls').toHaveLength(beforeReturn)
  expect(nativeIds().at(-1), 'source observation adopts the original current tail before navigation').toBe('current-appended')
  expect(host.textContent).toContain('Latest original native answer.'); expect(host.textContent).toContain('New captured observation.')
})

it('keeps a selected native record during current append and adds no paging demand while hidden', async () => {
  await fixture('claude'); await wheel(true)
  const selected = host.querySelector('.conversation-native-thread [data-native-record-ids]')!
  const head = selected.querySelector<HTMLElement>('.wf-head')!; expect(head).not.toBeNull()
  const range = document.createRange(); range.selectNodeContents(head); window.getSelection()!.addRange(range)
  await appendFile(transcript, JSON.stringify(record('current-appended', 'Latest original native answer.')) + '\n'); expectedTranscript = await readFile(transcript)
  await act(async () => observation?.({ agentSessionId: sid, source: { providerId: provider, nativeSessionId: native }, kind: 'invalidated' })); await flush()
  const before = nativeIds(); await act(async () => latest().click()); await flush()
  expect(nativeIds().slice(0, before.length)).toEqual(before)
  expect(selected.isConnected).toBe(true); expect(window.getSelection()!.getRangeAt(0)).toBe(range)
  expect(nativeIds().at(-1)).toBe('current-appended'); window.getSelection()!.removeAllRanges()
  await render(false); const count = requests.length
  await wheel(false); await wheel(true); expect(requests).toHaveLength(count)
})
