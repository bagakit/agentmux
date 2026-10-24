import { processNativeRecordIds } from './helpers/conversation-process-members'
import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { fixtureTime as _hygiene_fixtureTime } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentSessionHistoryPage, type AgentSessionHistoryPageOptions, type AgentMuxStoredAgentSession } from '../../../packages/core/src/index.js'
import type { AgentSessionControl, AgentTimelineItem, AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { createClientUiRoot } from './helpers/client-ui-render'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { SessionActivityPresentation } from '../src/renderer/src/components/SessionActivityPresentation'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { conversationReadingAnchor, restoreConversationAnchor } from '../src/renderer/src/lib/session-conversation-window'
import { conversationMessageSourceKey } from '@agentmux/client-ui/conversation-message-location'

// Heavy paint/input leaves are isolated; both real callers, store, read owner and common body are mounted.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ visible }: { visible: boolean }) => <div data-terminal-visible={String(visible)} /> }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: ({ sessionId }: { sessionId: string }) => <div data-composer-draft={useAppStore.getState().agentComposerDrafts[sessionId]} /> }))
vi.mock('../src/renderer/src/components/AgentRegionHeader', () => ({ AgentRegionHeader: ({ onHistory }: { onHistory?: () => void }) => <header><button type="button" className="agent-region-header__more" onClick={onHistory}>Header history</button></header> }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
vi.mock('../src/renderer/src/components/AgentLifecycleFeedback', () => ({ AgentLifecycleFeedback: () => null }))
vi.mock('../src/renderer/src/components/StableWorkbenchView', () => ({ StableWorkbenchView: ({ children }: { children: ReactNode }) => children }))

const sid = 'unified-managed-session', native = 'unified-native-session'
const control: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId: sid, run: { runId: 'original-retained-run' } }
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private host' }], executors: {}, workspaces: [], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const initial = useAppStore.getState()
let container: HTMLDivElement, root: Root, home: string, transcript: string, client: AgentMuxClient, store: AgentMuxFileAgentSessionStore
let requests: { cursor?: string; limit?: number }[], promises: Promise<AgentSessionHistoryPage>[], controls: ReturnType<typeof vi.spyOn>[]
let recent: ReturnType<typeof useSessionUserMessages> | null
let readingSummary: ReturnType<typeof useSessionUserMessages> | null
let observation: Parameters<AgentMuxClient['observeSessionHistory']>[1] | null
let readOriginalPage: (id: string, options?: AgentSessionHistoryPageOptions, source?: AgentSessionHistoryPage['source']) => Promise<AgentSessionHistoryPage>
let nativePage: ReturnType<typeof vi.fn<AgentMuxClient['readSessionHistoryPage']>>
let closes: Array<() => unknown | Promise<unknown>>
let readingReceipts: Array<Awaited<ReturnType<typeof api.conversation.readAgentConversation>> | Awaited<ReturnType<typeof api.conversation.readConversationChanges>>>
let originalStore: readonly AgentMuxStoredAgentSession[], stored: AgentMuxStoredAgentSession
// Six-minute records let the default 24h coverage settle within the first 300-record batch; older pages remain real navigation input.
function record(n: number) {
 const type = n < 100 || n > 300 ? (n % 8 === 0 ? 'user' : n % 8 === 1 ? 'assistant' : 'assistant') : 'assistant'
 const content = n < 100 || n > 300 ? (n % 8 === 0 ? `Input ${n} · identical body` : n % 8 === 1 ? [{ type: 'thinking', thinking: `Trace ${n}` }, { type: 'text', text: `Reply ${n}` }] : [{ type: 'thinking', thinking: `Process ${n}` }]) : [{ type: 'thinking', thinking: `Process ${n}` }]
 return { uuid: `record-${String(n).padStart(3, '0')}`, type, sessionId: native, timestamp: new Date(_hygiene_fixtureTime(-37225600000) + n * 6 * 60_000).toISOString(), message: { role: type, content } }
}
function Witness({ visible = true }: { visible?: boolean }) {
 const result = useSessionUserMessages(control, { enabled: visible }); recent = result
 return <div data-shared-recent={JSON.stringify(result.nativeHistoryPage?.items.map(item => item.id) ?? [])} />
}
function Reading({ visible = true, opened = false }: { visible?: boolean; opened?: boolean }) {
 const facts = useSessionUserMessages(control, { enabled: visible })
 readingSummary = facts
 return <ActivityView sessionId={sid} executionHostId="local" capability="complete-events" nativeHistoryPage={facts.nativeHistoryPage} nativeContextItems={facts.nativeContextItems}
  conversationReading={{ reference: control, identity: control.run.runId, enabled: visible, opened }} />
}
function compose(visible = true, opened = false) { return <><Reading visible={visible} opened={opened} /><Witness /></> }
function acceptedWindow() {
 const accepted = inspectConversationConsumers(control).consumers[0]?.accepted
 expect(accepted).not.toBeNull()
 const receipt = [...readingReceipts].reverse().find(page => page.window.id === accepted?.id && page.window.revision === accepted.revision && page.window.complete)
 expect(receipt, 'The UI must identify its exact original accepted public window receipt').toBeDefined()
 return receipt!.window
}
async function publishCaptured(items: readonly AgentTimelineItem[]) {
 for (const item of items) await client['persistAndPublishTimeline']({ type: 'upsert', agentSessionId: sid, item },
  { source: 'agentmux', observedAt: item.updatedAt }, 'local')
}
async function flush({ pending = false }: { pending?: boolean } = {}) {
 for (let i = 0; i < 2; i++) await act(async () => { await Promise.allSettled([...promises]); await new Promise(resolve => setTimeout(resolve, 10)) })
 if (pending) return
 await vi.waitFor(async () => {
  await act(async () => { await Promise.allSettled([...promises]); await new Promise(resolve => setTimeout(resolve, 10)) })
  const consumers = [
   ...inspectConversationConsumers(control).consumers.filter(consumer => consumer.gates.enabled),
   ...[readingSummary, recent].flatMap(summary => summary ? [summary.conversation.inspect()] : [])
  ]
  // A healthy current reader must consume its own continuation before a read
  // baseline is sampled. Historical, held or failed readers can retain dirty
  // facts until their original explicit action; dirty alone is not active IO.
  expect(consumers.filter(consumer => consumer.loading || consumer.inFlight || consumer.watch.binding
   || consumer.dirty && !consumer.historical && !consumer.held && !consumer.error && !consumer.sourceError && !consumer.observationError)
   .map(consumer => ({ loading: consumer.loading, inFlight: consumer.inFlight, watchBinding: consumer.watch.binding,
    dirty: consumer.dirty, historical: consumer.historical, held: consumer.held, error: consumer.error?.message }))).toEqual([])
 }, { timeout: 4000, interval: 10 })
}
async function render(node: ReactNode) {
 await act(async () => root.render(node)); await flush()
 const feed = container.querySelector<HTMLElement>('.activity-feed')
 if (!feed || feed.closest('[hidden], [inert]')) return
 await vi.waitFor(async () => {
  await act(async () => { await Promise.allSettled([...promises]); await new Promise(resolve => setTimeout(resolve, 10)) })
  const all = inspectConversationConsumers(control).consumers
  expect(all.length).toBeGreaterThan(0)
  const consumers = all.filter(consumer => consumer.gates.enabled)
  expect(consumers.every(consumer => !consumer.loading && !consumer.inFlight && !consumer.watch.binding)).toBe(true)
 }, { timeout: 4000, interval: 10 })
}
async function click(label: string) {
 const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)
 expect(button, label).toBeDefined(); expect(button!.disabled, label).toBe(false)
 await act(async () => button!.click()); await flush()
}
async function wheel(deltaY = -100, scrollTop = 0) {
 const viewport = container.querySelector<HTMLElement>('.activity-feed')!
 expect(viewport).not.toBeNull(); viewport.scrollTop = scrollTop
 await act(async () => { viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY })) }); await flush()
}
function ids(): string[] {
 const thread = container.querySelector('.conversation-native-thread')!
 expect(thread).not.toBeNull()
 return [...thread.children].flatMap(node => {
  const e = node as HTMLElement
  if (e.dataset.nativeRecordId) return [e.dataset.nativeRecordId]
  if (e.dataset.conversationProcessMembers) return processNativeRecordIds(e)
  return []
 })
}
function rect(top: number, height = 20) { return { x: 0, y: top, top, bottom: top + height, left: 0, right: 300, width: 300, height, toJSON: () => ({}) } }
async function writeEdgeHistory(count: number) {
 // A wide synthetic span keeps time-range coverage separate from scroll-page demand.
 await writeFile(transcript, Array.from({ length: count }, (_, n) => JSON.stringify({ ...record(n),
  timestamp: new Date(_hygiene_fixtureTime(-37225600000) + n * 3_600_000).toISOString() })).join('\n') + '\n')
}
function viewportGeometry(viewport: HTMLElement) {
 Object.defineProperties(viewport, { clientHeight: { configurable: true, value: 200 }, scrollHeight: { configurable: true, value: 10000 } })
 viewport.getBoundingClientRect = () => rect(100, 200)
 for (const tail of viewport.querySelectorAll<HTMLElement>('[data-conversation-native-tail], [data-conversation-reading-tail]')) {
  tail.getBoundingClientRect = () => rect(100 + viewport.scrollHeight - viewport.scrollTop, 0)
 }
}
function markerGeometry(viewport: HTMLElement) {
 viewportGeometry(viewport)
 const entry = viewport.querySelector<HTMLElement>('.activity-feed__reading')!
 expect(entry).not.toBeNull()
 entry.getBoundingClientRect = () => rect(100 - viewport.scrollTop, 40)
 return entry
}
function growingEarlierReserve(viewport: HTMLElement, pixelsPerRecord = 2.5) {
 const entry = markerGeometry(viewport)
 let first = Number(ids()[0]!.slice('record-'.length))
 // Happy DOM does not lay out the prepended originals. Model their readable
 // extent from accepted source records, rather than stopping after a page count.
 entry.getBoundingClientRect = () => rect(100 - viewport.scrollTop
  - Math.max(0, first - Number(ids()[0]!.slice('record-'.length))) * pixelsPerRecord, 40)
 return { reset: () => { first = Number(ids()[0]!.slice('record-'.length)) } }
}
async function scrollTo(viewport: HTMLElement, top: number) {
 await act(async () => { viewport.scrollTop = top; viewport.dispatchEvent(new Event('scroll')) })
}
beforeEach(async () => {
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
 vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
 vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
 Element.prototype.scrollIntoView = vi.fn()
 useAppStore.setState({ config, sessions: [], timelines: {}, agentNames: {} })
 home = await mkdtemp(join(tmpdir(), 'agentmux-unified-reader-')); await mkdir(join(home, 'workspace'))
 transcript = join(home, 'conversation.jsonl')
 await writeFile(transcript, Array.from({ length: 360 }, (_, n) => JSON.stringify(record(n))).join('\n') + '\n')
 store = new AgentMuxFileAgentSessionStore(join(home, 'sessions.json'))
 stored = { kind: 'agent', agentSessionId: sid, providerId: 'claude', executorId: 'claude', hostId: 'local', workspacePath: join(home, 'workspace'), run: control.run,
  retiredRuns: [], hookBindingId: 'private-history-hook', hookToken: 'private-history-token', createdAt: 1, updatedAt: 1,
  nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: native, transcriptPath: transcript } }
 await store.compareAndSwap(null, stored); originalStore = await store.loadMetadata()
 client = new AgentMuxClient({ store })
 const originalPageOwner = client['readSessionHistoryPage']
 readOriginalPage = (id, options = {}, source) => originalPageOwner.call(client, id, options, source)
 closes = [() => { client['readSessionHistoryPage'] = originalPageOwner }]
 const bridge = await desktopConversationReadBridge({ root: home, client }, closes)
 readingReceipts = []
 vi.mocked(api.conversation.readAgentConversation).mockImplementation(async (...args) => {
  const page = await bridge.readAgentConversation(...args); readingReceipts.push(page); return page
 })
 vi.mocked(api.conversation.readConversationChanges).mockImplementation(async (...args) => {
  const page = await bridge.readConversationChanges(...args); readingReceipts.push(page); return page
 })
 const kernel = Reflect.get(client, 'kernel')
 controls = ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'].map(key => vi.spyOn(kernel, key).mockImplementation(() => { throw new Error(`Forbidden Runtime operation ${key}`) }))
 requests = []; promises = []; recent = null; readingSummary = null; observation = null
 nativePage = vi.fn((agentSessionId, options, originalSource) => {
  expect(agentSessionId).toBe(sid)
  requests.push(options); const request = originalPageOwner.call(client, agentSessionId, options, originalSource)
  promises.push(request); return request
 })
 client['readSessionHistoryPage'] = nativePage
 vi.spyOn(api.sessions, 'timeline').mockImplementation(reference => client.sessionTimeline(reference.agentSessionId))
 vi.spyOn(api.sessions, 'historySources').mockImplementation(async () => ({ sources: await client.sessionHistorySources(), warnings: [] }))
 const observers = new Set<Parameters<AgentMuxClient['observeSessionHistory']>[1]>()
 observation = event => { for (const listener of observers) listener(event) }
 vi.spyOn(client, 'observeSessionHistory').mockImplementation(async (agentSessionId, listener) => {
  observers.add(listener)
  return { agentSessionId, source: { providerId: 'claude', nativeSessionId: native }, dispose() { observers.delete(listener) } }
 })
 container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => {
 try {
  await act(async () => root.unmount()); container.remove()
  expect(controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
  expect(await store.loadMetadata()).toEqual(originalStore)
 } finally {
  try { for (const close of closes.reverse()) await close() }
  finally {
   try { await client.dispose() }
   finally {
    await rm(home, { recursive: true }); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
    window.getSelection()?.removeAllRanges()
   }
  }
 }
})

describe('One Activity reading surface over public original-sequence windows', () => {
 it('keeps Earlier before one accepted native and captured sequence without deleting original sources', async () => {
  await writeEdgeHistory(1200)
  const captured: AgentTimelineItem[] = [
   { id: 'captured-edge-input', agentSessionId: sid, kind: 'user_message', source: 'user', authorHuman: true,
    title: 'Original captured input', content: 'Captured original input remains complete.', status: 'complete',
    createdAt: _newTailFixtureEpoch(0, 0, 1), updatedAt: _newTailFixtureEpoch(0, 0, 1) },
   { id: 'captured-edge-reply', agentSessionId: sid, kind: 'assistant_message', source: 'native-hook', authorAgentSessionId: sid,
    title: 'Original captured reply', content: 'Captured original reply remains complete.', status: 'complete',
    createdAt: _newTailFixtureEpoch(0, 0, 2), updatedAt: _newTailFixtureEpoch(0, 0, 2) }
  ]
  await publishCaptured(captured); await render(compose())
  const feed = container.querySelector<HTMLElement>('.activity-feed')!, entry = feed.querySelector<HTMLElement>('.activity-feed__reading')!
  const thread = feed.querySelector<HTMLElement>('.conversation-native-thread')!
  const submission = thread.querySelector<HTMLElement>('[data-submission-id="captured-edge-input"]')!
  expect(submission).not.toBeNull()
  await act(async () => {
   const details = submission.querySelector<HTMLDetailsElement>('.message-disclosure')!
   details.open = true; details.dispatchEvent(new Event('toggle'))
  })
  const capturedCards = captured.map(item => [...thread.querySelectorAll<HTMLElement>('.log-turn')].find(card => card.textContent?.includes(item.content!))!)
  expect(entry).not.toBeNull(); expect(thread).not.toBeNull()
  for (const card of capturedCards) {
   expect(card).toBeDefined(); expect(Boolean(entry.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
   expect(card.dataset.compact).not.toBe('true')
  }
  const nativeBody = thread.querySelector('[data-native-record-id="record-1193"] .log-turn__body')!
  expect(nativeBody).not.toBeNull()
  await click('Earlier')
  expect(feed.querySelector('.conversation-native-thread')).toBe(thread)
  expect(nativeBody.isConnected).toBe(true); expect(submission.isConnected).toBe(true)
  expect(capturedCards.every(card => card.isConnected)).toBe(true)
  for (const item of captured) expect(thread.textContent).toContain(item.content)
  const original = await client.sessionTimeline(sid)
  expect(original.items).toEqual(captured)
 })
 it('loads the original earlier cursor on upward scroll with inline loading and preserves the actual body, Range, anchor and draft', async () => {
  await writeEdgeHistory(1200)
  useAppStore.setState({ agentComposerDrafts: { [sid]: 'ORIGINAL UNSENT DRAFT' } })
  await render(<>{compose()}<textarea aria-label="Original reading draft" defaultValue="Original unsent text" /></>)
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!, entry = markerGeometry(viewport)
  const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="Original reading draft"]')!
  const originalIds = ids(), anchorId = originalIds.find(id => Number(id.slice('record-'.length)) % 8 === 1)!
  const body = viewport.querySelector<HTMLElement>(`[data-native-record-id="${anchorId}"] .log-turn__body`)!, row = body.closest<HTMLElement>('[data-native-record-id]')!
  const trace = body.querySelector<HTMLDetailsElement>('[data-trace-kind="reasoning"]')!
  trace.open = true
  row.getBoundingClientRect = () => rect(100 + 30 + (ids().length - originalIds.length) * 2.5 - viewport.scrollTop)
  const text = [...body.querySelectorAll('p')].find(node => node.textContent === `Reply ${Number(anchorId.slice('record-'.length))}`)!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 5); window.getSelection()!.addRange(range)
  await scrollTo(viewport, 700)
  const before = ids(), start = requests.length, page = await promises[requests.map((request, index) => request.limit === 100 ? index : -1).reduce((last, index) => Math.max(last, index), -1)]!
  let release!: (page: AgentSessionHistoryPage) => void
  nativePage.mockImplementationOnce((_reference, options) => {
   requests.push(options ?? {}); return new Promise(resolve => { release = resolve })
  })
  await scrollTo(viewport, 20)
  await vi.waitFor(() => { expect(requests).toHaveLength(start + 1); expect(requests[start]!.cursor).toBe(page.nextCursor) })
  const status = entry.querySelector<HTMLElement>('[role="status"]')!
  expect(status).not.toBeNull(); expect(status.getAttribute('aria-live')).toBe('polite'); expect(status.textContent).toBe('Loading earlier…')
  expect(status.closest('button')?.querySelector('svg[data-semantic-icon="status.loading"]')).not.toBeNull()
  expect(viewport.hasAttribute('aria-busy')).toBe(false); expect(ids()).toEqual(before)
  expect(body.isConnected).toBe(true); expect(trace.open).toBe(true); expect(window.getSelection()!.getRangeAt(0)).toBe(range)
  await scrollTo(viewport, 10); expect(requests).toHaveLength(start + 1)
  await act(async () => release(await readOriginalPage(sid, { limit: 100, cursor: page.nextCursor! }))); await flush()
  expect(ids()).toHaveLength(before.length + 300); expect(requests).toHaveLength(start + 3)
  expect(row.querySelector('.log-turn__body')).toBe(body); expect(trace.open).toBe(true)
  expect(window.getSelection()!.getRangeAt(0)).toBe(range); expect(window.getSelection()!.toString()).toBe('Reply')
  expect(conversationReadingAnchor(viewport)).toEqual({ kind: 'record', id: anchorId, offset: 20 })
  expect(container.querySelector('[aria-label="Original reading draft"]')).toBe(editor); expect(editor.value).toBe('Original unsent text'); expect(editor.disabled).toBe(false)
  expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('ORIGINAL UNSENT DRAFT')
  expect(entry.querySelector('[role="status"]')).toBeNull()
 })
 it('continues a short visible earlier edge after the cursor advances without unbounded pulling and retries the original failed cursor', async () => {
  await writeEdgeHistory(2400)
  await render(compose())
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!, reserve = growingEarlierReserve(viewport)
  await scrollTo(viewport, 700)
  const originalCount = ids().length, start = requests.length, firstPage = await promises[requests.map((request, index) => request.limit === 100 ? index : -1).reduce((last, index) => Math.max(last, index), -1)]!
  let release!: (page: AgentSessionHistoryPage) => void
  nativePage.mockImplementationOnce((_reference, options) => {
   requests.push(options ?? {}); return new Promise(resolve => { release = resolve })
  })
  await scrollTo(viewport, 20); await scrollTo(viewport, 10)
  await vi.waitFor(() => { expect(requests).toHaveLength(start + 1); expect(requests[start]!.cursor).toBe(firstPage.nextCursor) })
  await act(async () => release(await readOriginalPage(sid, { limit: 100, cursor: firstPage.nextCursor! }))); await flush()
  expect(ids()).toHaveLength(originalCount + 300); expect(requests).toHaveLength(start + 3)
  const retained = ids(), cursor = (await promises.at(-1)!).nextCursor!, stable = requests.length
  // A passive notification of the known layout restoration cannot pull another batch.
  await act(async () => viewport.dispatchEvent(new Event('scroll'))); await flush()
  expect(requests).toHaveLength(stable)
  const anchorId = retained.find(id => Number(id.slice('record-'.length)) % 8 === 0)!
  const anchorRow = viewport.querySelector<HTMLElement>(`[data-native-record-id="${anchorId}"]`)!
  expect(anchorRow).not.toBeNull()
  anchorRow.getBoundingClientRect = () => rect(100 + 20 + ([...viewport.querySelectorAll('.activity-feed__read-notice')]
   .some(notice => notice.textContent?.includes('Original scroll page unavailable')) ? 40 : 0) - viewport.scrollTop)
  nativePage.mockImplementationOnce(async (_reference, options) => {
   requests.push(options ?? {}); throw new Error('Original scroll page unavailable')
  })
  // The edge remains visible: a new upward movement, rather than leaving an arbitrary zone,
  // may continue after the first cursor has genuinely advanced.
  reserve.reset(); await scrollTo(viewport, 0); await flush()
  expect(requests).toHaveLength(stable + 1); expect(requests.at(-1)!.cursor).toBe(cursor)
  expect(ids()).toEqual(retained); expect(container.textContent).toContain('Original scroll page unavailable')
  expect(conversationReadingAnchor(viewport), 'The known read-error notice cannot move the original visible record').toEqual({ kind: 'record', id: anchorId, offset: 20 })
  await flush(); expect(requests).toHaveLength(stable + 1)
  await click('Retry reading')
  expect(requests[stable + 1]!.cursor).toBe(cursor); expect(ids()).toHaveLength(originalCount + 400)
  const ended = requests.length; await flush(); expect(requests).toHaveLength(ended)
 })
 it.each(['footnote', 'ruler'] as const)('keeps actual %s navigation out of page demand and retains that reading position when live records append', async navigation => {
  await writeFile(transcript, Array.from({ length: 1200 }, (_, n) => JSON.stringify({ ...record(n),
   timestamp: new Date(_hygiene_fixtureTime(-37225600000) + n * 3_600_000).toISOString(),
   ...(n === 1193 ? { message: { role: 'assistant', content: [{ type: 'text', text: 'Read the original note[^scope].\n\n[^scope]: Original local footnote.' }] } } : {})
  })).join('\n') + '\n')
  await render(compose())
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!; markerGeometry(viewport)
  await scrollTo(viewport, 700)
  const start = requests.length, pageReads = requests.filter(request => request.cursor !== undefined).length
  // Home selects the start of the default 24-hour ruler range. These originals
  // are one hour apart, so its exact target is 24 records before the latest.
  const rulerStartId = `record-${1199 - 24}`, publicStart = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  const targets: Element[] = []
  vi.mocked(Element.prototype.scrollIntoView).mockImplementation(function (this: Element) {
   targets.push(this)
   const owner = this.closest<HTMLElement>('[data-workbench-reading-scroll]')
   expect(owner).toBe(viewport)
   owner!.scrollTop = 20
  })
  if (navigation === 'footnote') {
   const footnote = viewport.querySelector<HTMLButtonElement>('[aria-label="Read footnote 1"]')!
   expect(footnote).not.toBeNull(); await act(async () => footnote.click())
  } else {
   const slider = viewport.querySelector<HTMLElement>('[role="slider"]')!
   expect(slider).not.toBeNull()
   await act(async () => slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))); await flush()
  }
  expect(targets.length).toBeGreaterThan(0); expect(viewport.scrollTop).toBe(20)
  if (navigation === 'footnote') expect(targets.at(-1)!.hasAttribute('data-md-footnote')).toBe(true)
  else {
   const target = targets.at(-1)! as HTMLElement
   expect(target.dataset.nativeRecordId ?? target.dataset.deferredProcessId).toBe(rulerStartId)
   expect(target.dataset.messageSourceKey).toBe(conversationMessageSourceKey(sid,
    { kind: 'native', providerId: 'claude', nativeSessionId: native, recordId: rulerStartId }))
   // A ruler seek may reveal this exact deferred body. It must never borrow the
   // action as a demand for another source page or a different original record.
   const detailReads = vi.mocked(api.conversation.readAgentConversation).mock.calls.slice(publicStart)
   expect(detailReads.length).toBeGreaterThan(0)
   expect(detailReads.every(([input]) => input.anchor?.record.source.recordId === rulerStartId && !input.cursor)).toBe(true)
   expect(viewport.querySelector(`[data-native-record-id="${rulerStartId}"] .log-turn__body`)).not.toBeNull()
  }
  await act(async () => viewport.dispatchEvent(new Event('scroll'))); await flush()
  if (navigation === 'footnote') expect(requests).toHaveLength(start)
  expect(requests.filter(request => request.cursor !== undefined)).toHaveLength(pageReads)
  expect(container.querySelector('.activity-feed__jump')).not.toBeNull()
  await appendFile(transcript, JSON.stringify({ ...record(1200), timestamp: new Date(_hygiene_fixtureTime(-37225600000) + 1200 * 3_600_000).toISOString() }) + '\n')
  await act(async () => observation?.({ source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated', agentSessionId: sid }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)) }); await flush()
  expect(recent!.nativeHistoryPage!.items.at(-1)!.id).toBe('record-1200')
  expect(ids().at(-1)).toBe('record-1200'); expect(viewport.scrollTop).toBe(20)
  expect(requests.filter(request => request.cursor !== undefined)).toHaveLength(pageReads)
 })
 it('keeps latest and following at the displayed captured tail, while native paging retains its original boundary', async () => {
  await writeEdgeHistory(1200)
  const captured: AgentTimelineItem[] = [{ id: 'captured-tail-input', agentSessionId: sid, kind: 'user_message', source: 'user',
   title: 'Original captured input', content: 'Complete captured original. '.repeat(500), status: 'complete', createdAt: _newTailFixtureEpoch(0, 0, 1), updatedAt: _newTailFixtureEpoch(0, 0, 1) }]
  await publishCaptured(captured)
  await render(compose())
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!; markerGeometry(viewport)
  let readingBottom = 5000
  Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => readingBottom })
  const tail = viewport.querySelector<HTMLElement>('[data-conversation-native-tail]')!
  expect(tail).not.toBeNull(); let nativeBottom = 1800
  tail.getBoundingClientRect = () => rect(100 + nativeBottom - viewport.scrollTop, 0)
  const capturedOwner = viewport.querySelector<HTMLElement>('[data-submission-id="captured-tail-input"]')!
  expect(capturedOwner).not.toBeNull()
  await act(async () => {
   const disclosure = capturedOwner.querySelector<HTMLDetailsElement>('.message-disclosure')!
   disclosure.open = true; disclosure.dispatchEvent(new Event('toggle'))
  })
  const show = [...capturedOwner.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '显示正文')
  if (show) await act(async () => show.click())
  const original = capturedOwner.querySelector('.log-turn__body')!
  expect(original).not.toBeNull()
  const readingTail = viewport.querySelector<HTMLElement>('[data-conversation-reading-tail]')!
  readingTail.getBoundingClientRect = () => rect(100 + readingBottom - viewport.scrollTop, 0)
  await scrollTo(viewport, readingBottom - viewport.clientHeight)
  await scrollTo(viewport, 1000)
  const jump = container.querySelector<HTMLButtonElement>('[data-message-tool-control="jump-to-latest"]')!
  expect(jump).not.toBeNull(); await act(async () => jump.click()); await flush()
  expect(viewport.scrollTop).toBe(readingBottom - viewport.clientHeight)
  expect(viewport.querySelector('.activity-feed__observations')).toBeNull(); expect(original.isConnected).toBe(true); expect(original.textContent?.trim() === captured[0]!.content!.trim(), 'The complete captured original stays readable').toBe(true)
  await act(async () => viewport.dispatchEvent(new Event('scroll')))
  nativeBottom = 1900; readingBottom = 5100
  await appendFile(transcript, JSON.stringify({ ...record(1200), timestamp: new Date(_hygiene_fixtureTime(-37225600000) + 1200 * 3_600_000).toISOString() }) + '\n')
  await act(async () => observation?.({ source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated', agentSessionId: sid }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)) }); await flush()
  expect(ids().at(-1)).toBe('record-1200'); expect(viewport.scrollTop).toBe(readingBottom - viewport.clientHeight)
  expect(original.isConnected).toBe(true); expect(viewport.querySelector('.activity-feed__observations')).toBeNull()
  await act(async () => viewport.dispatchEvent(new Event('scroll')))
  const segment = original.closest<HTMLElement>('[data-segment-key]')!
  expect(segment).not.toBeNull()
  const actualNativeBottom = () => nativeBottom + (viewport.querySelector('[data-native-record-id="record-1201"]') ? 100 : 0)
  const currentNoticeHeight = () => viewport.querySelector('.activity-feed__newer-edge') ? 40 : 0
  tail.getBoundingClientRect = () => rect(100 + actualNativeBottom() - viewport.scrollTop, 0)
  const nativeOriginal = viewport.querySelector<HTMLElement>('[data-native-record-id="record-1200"]')!
  nativeOriginal.getBoundingClientRect = () => rect(100 + nativeBottom - 30 - viewport.scrollTop, 60)
  segment.getBoundingClientRect = () => rect(100 + actualNativeBottom() + currentNoticeHeight() + 30 - viewport.scrollTop, 3000)
  // The user selects a visible captured body while an older native row is still above it.
  // A selection, without a wheel target on that body, must qualify its own reading anchor.
  await scrollTo(viewport, 1850)
  const offset = segment.getBoundingClientRect().top - viewport.getBoundingClientRect().top
  const text = document.createTreeWalker(original, NodeFilter.SHOW_TEXT).nextNode()!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 8); window.getSelection()!.addRange(range)
  await appendFile(transcript, JSON.stringify({ ...record(1201), timestamp: new Date(_hygiene_fixtureTime(-37225600000) + 1201 * 3_600_000).toISOString() }) + '\n')
  await act(async () => observation?.({ source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated', agentSessionId: sid }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)) }); await flush()
  expect(ids().at(-1)).toBe('record-1201'); expect(segment.getBoundingClientRect().top - viewport.getBoundingClientRect().top).toBe(offset)
  expect(original.isConnected).toBe(true); expect(window.getSelection()!.getRangeAt(0)).toBe(range)
  expect(window.getSelection()!.toString()).toBe('Complete'); expect(viewport.scrollTop).toBe(1950)
 })
 it.each(['scroll', 'Home'] as const)('reads the original Newer token after %s returns to the unified historical tail and keeps captured originals accessible', async returning => {
  await writeEdgeHistory(2400)
  const captured: AgentTimelineItem[] = [{ id: 'captured-newer-input', agentSessionId: sid, kind: 'user_message', source: 'user',
   title: 'Original captured input', content: 'Captured tail stays available. '.repeat(500), status: 'complete', createdAt: _newTailFixtureEpoch(0, 0, 1), updatedAt: _newTailFixtureEpoch(0, 0, 1) }]
  await publishCaptured(captured)
  await render(compose())
  expect(container.querySelector('[data-submission-id="captured-newer-input"]')).not.toBeNull()
  // All sources share the Core window budget. A captured tail may leave this
  // frame with the newer native side; its durable source is not deleted.
  for (let n = 0; n < 12 && ids().at(-1) === 'record-2399'; n++) await click('Earlier')
  const originalWindow = acceptedWindow()
  expect(originalWindow.navigation.newer).toBeTypeOf('string'); expect(originalWindow.outside.newer).not.toBeNull()
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!; markerGeometry(viewport)
  Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 5000 })
  const tail = viewport.querySelector<HTMLElement>('[data-conversation-native-tail]')!
  const readingTail = viewport.querySelector<HTMLElement>('[data-conversation-reading-tail]')!
  const nativeBottom = 1800, readingBottom = 5000
  // The common reading tail includes captured originals. A native edge by
  // itself cannot qualify newer paging before the user reaches that common end.
  expect(tail).not.toBeNull(); expect(readingTail).not.toBeNull()
  tail.getBoundingClientRect = () => rect(100 + nativeBottom - viewport.scrollTop, 0)
  readingTail.getBoundingClientRect = () => rect(100 + readingBottom - viewport.scrollTop, 0)
  const nativeGroup = [...viewport.querySelectorAll<HTMLElement>('.wf-card--observation > .wf-head[aria-expanded="false"]')].at(-1)!
  expect(nativeGroup).toBeDefined()
  nativeGroup.getBoundingClientRect = () => rect(100 + (returning === 'Home' ? -200 : 1730) - viewport.scrollTop, 40)
  const last = Number(ids().at(-1)!.slice('record-'.length)); expect(last).toBeLessThan(2399)
  const auxiliary = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  await scrollTo(viewport, 1900); await scrollTo(viewport, 2000); await flush()
  expect(vi.mocked(api.conversation.readAgentConversation)).toHaveBeenCalledTimes(auxiliary)
  if (returning === 'Home') {
   // Home at an already clamped top has no scroll event to clear the previous auxiliary target.
   // Its real earlier demand is allowed to settle before testing the reverse
   // token. That page adds readable height; the old tail is not a visible anchor.
   const first = Number(ids()[0]!.slice('record-'.length)), entry = viewport.querySelector<HTMLElement>('.activity-feed__reading')!
   entry.getBoundingClientRect = () => rect(100 - viewport.scrollTop - (first - Number(ids()[0]!.slice('record-'.length))) * 7, 40)
   await act(async () => { viewport.scrollTop = 0; viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })) }); await flush()
  } else await scrollTo(viewport, 1700)
  const newer = acceptedWindow().navigation.newer
  expect(newer).toBeTypeOf('string')
  const start = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  const completedBefore = readingReceipts.filter(page => page.window.complete).length
  if (returning === 'Home') await act(async () => {
   // Complete the user's return to the common tail before the next key demand.
   viewport.scrollTop = 4750; viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
  })
  else await scrollTo(viewport, 4750)
  await flush()
  const navigation = vi.mocked(api.conversation.readAgentConversation).mock.calls.slice(start)
  expect(navigation.length).toBeGreaterThan(0)
  const completed = readingReceipts.filter(page => page.window.complete).length - completedBefore
  expect(completed).toBeGreaterThan(0); expect(completed).toBeLessThanOrEqual(12)
  expect(acceptedWindow().navigation.newer, 'This compressed source reaches its original newer end within the finite demand').toBeNull()
  expect(navigation[0]![0].cursor).toBe(newer)
  expect(Number(ids().at(-1)!.slice('record-'.length))).toBeGreaterThan(last)
  const restored = viewport.querySelector<HTMLElement>('[data-submission-id="captured-newer-input"]')!
  expect(restored).not.toBeNull()
  await act(async () => {
   const disclosure = restored.querySelector<HTMLDetailsElement>('.message-disclosure')!
   disclosure.open = true; disclosure.dispatchEvent(new Event('toggle'))
  })
  const show = [...restored.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '显示正文')
  if (show) await act(async () => show.click())
  expect(restored.querySelector('.log-turn__body')?.textContent?.trim()).toBe(captured[0]!.content!.trim())
  expect((await client.sessionTimeline(sid)).items).toEqual(captured)
  const ended = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  await flush(); expect(vi.mocked(api.conversation.readAgentConversation)).toHaveBeenCalledTimes(ended)
 })
 it('does not turn a viewport-height clamp into earlier intent, while the next real upward movement still reads', async () => {
  await writeEdgeHistory(1200)
  await render(compose())
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!, entry = viewport.querySelector<HTMLElement>('.activity-feed__reading')!
  let height = 500
  Object.defineProperties(viewport, { clientHeight: { configurable: true, get: () => height }, scrollHeight: { configurable: true, value: 2000 } })
  viewport.getBoundingClientRect = () => rect(100, height); entry.getBoundingClientRect = () => rect(100 - viewport.scrollTop, 40)
  const tail = viewport.querySelector<HTMLElement>('[data-conversation-native-tail]')!
  expect(tail).not.toBeNull(); tail.getBoundingClientRect = () => rect(100 + 2000 - viewport.scrollTop, 0)
  await scrollTo(viewport, 1500)
  const before = ids(), start = requests.length
  height = 1000
  await scrollTo(viewport, 1000); await flush()
  expect(ids()).toEqual(before); expect(requests).toHaveLength(start)
  // Each completed 100-record source page supplies one 1000px viewport.
  entry.getBoundingClientRect = () => rect(100 - viewport.scrollTop - (ids().length - before.length) * 10, 40)
  await scrollTo(viewport, 900); await flush()
  expect(requests).toHaveLength(start + 3); expect(ids()).toHaveLength(before.length + 300)
 })
 it('retained-head layout resize keeps the active older anchor while current facts stay live', async () => {
  const subscriptions: { target: Element; callback: ResizeObserverCallback }[] = []
  vi.stubGlobal('ResizeObserver', class {
   constructor(private callback: ResizeObserverCallback) {}
   observe(target: Element) { subscriptions.push({ target, callback: this.callback }) }
   unobserve() {} disconnect() {}
  })
  await render(compose())
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!
  Object.defineProperties(viewport, { scrollHeight: { configurable: true, value: 1500 }, clientHeight: { configurable: true, value: 600 } })
  viewport.getBoundingClientRect = () => rect(0, 600)
  const row = container.querySelector<HTMLElement>('[data-native-record-id="record-353"]')!
  let rowTop = 20; row.getBoundingClientRect = () => rect(rowTop)
  viewport.scrollTop = 900; await act(async () => viewport.dispatchEvent(new Event('scroll')))
  await click('Earlier')
  viewport.scrollTop = 400; await act(async () => viewport.dispatchEvent(new Event('scroll')))
  const retained = container.querySelector<HTMLElement>('[data-native-record-id="record-353"]')!
  expect(retained).toBe(row)
  rowTop = 120
  await act(async () => {
   for (const subscription of subscriptions.filter(item => item.target.classList.contains('conversation-native-thread'))) {
    subscription.callback([], {} as ResizeObserver)
   }
  })
  expect(viewport.scrollTop, 'layout growth above the active historical anchor should preserve its 20px viewport offset').toBe(500)
 })

 it('keeps same-source latest append live after a tiny upward prefetch while still at the bottom', async () => {
  await render(compose())
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!
  Object.defineProperties(viewport, { scrollHeight: { configurable: true, value: 1500 }, clientHeight: { configurable: true, value: 600 } })
  viewport.scrollTop = 900
  await act(async () => viewport.dispatchEvent(new Event('scroll')))
  const requestsBefore = requests.length
  await wheel(-1, 899)
  expect(requests.length).toBeGreaterThan(requestsBefore)
  expect(ids()).toHaveLength(360)
  await appendFile(transcript, JSON.stringify(record(360)) + '\n')
  await act(async () => observation?.({ source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated', agentSessionId: sid }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)) }); await flush()
  expect(recent!.nativeHistoryPage!.items.at(-1)!.id).toBe('record-360')
  expect(ids().at(-1)).toBe('record-360')
  expect(container.querySelector('.activity-feed__latest-held')).toBeNull()
 })
 it('keeps an anchored same-source body and Range connected when retained-head live records append', async () => {
  await render(compose()); await click('Earlier')
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!
  Object.defineProperties(viewport, { scrollHeight: { configurable: true, value: 1500 }, clientHeight: { configurable: true, value: 600 } })
  viewport.scrollTop = 900; await act(async () => viewport.dispatchEvent(new Event('scroll')))
  viewport.scrollTop = 400; await act(async () => viewport.dispatchEvent(new Event('scroll')))
  const body = container.querySelector<HTMLElement>('[data-native-record-id="record-353"] .log-turn__body')!
  const text = [...body.querySelectorAll('p')].find(node => node.textContent === 'Reply 353')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 5); window.getSelection()!.addRange(range)
  const oldTop = viewport.scrollTop
  await appendFile(transcript, JSON.stringify(record(360)) + '\n')
  await act(async () => observation?.({ source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated', agentSessionId: sid }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)) }); await flush()
  expect(ids().at(-1)).toBe('record-360')
  expect(body.isConnected).toBe(true); expect(window.getSelection()!.getRangeAt(0)).toBe(range)
  expect(viewport.scrollTop).toBe(oldTop)
 })

 it('keeps selected current-head bodies connected while displaying newly committed original records without a stale-current banner', async () => {
  await render(compose()); await click('Earlier')
  const body = container.querySelector<HTMLElement>('[data-native-record-id="record-353"] .log-turn__body')!
  const text = [...body.querySelectorAll('p')].find(node => node.textContent === 'Reply 353')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 5); window.getSelection()!.addRange(range)
  const before = ids(), count = requests.length, changes = vi.mocked(api.conversation.readConversationChanges).mock.calls.length
  const divider = container.querySelector('.activity-feed__history-divider')
  expect(container.querySelector('.activity-feed__latest-held')).toBeNull()
  await appendFile(transcript, JSON.stringify(record(360)) + '\n')
  await act(async () => observation?.({ source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated', agentSessionId: sid })); await flush()
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)) }); await flush()
  expect(recent!.nativeHistoryPage!.items.at(-1)!.id).toBe('record-360')
  expect(ids()).toEqual([...before, 'record-360']); expect(container.textContent).toContain('Input 360')
  expect(body.isConnected).toBe(true); expect(window.getSelection()!.getRangeAt(0)).toBe(range)
  expect(container.querySelector('.activity-feed__latest-held')).toBeNull()
  expect(requests).toHaveLength(count)
  expect(vi.mocked(api.conversation.readConversationChanges).mock.calls.length).toBeGreaterThan(changes)
  // Already-current accepted originals advance through deltas. No redundant
  // current-page action or native page reread is needed while this tail remains.
  expect(container.querySelector('[data-message-tool-control="jump-to-latest"]')).toBeNull()
  expect(ids().at(-1)).toBe('record-360'); expect(container.querySelector('.activity-feed__history-divider')).toBe(divider)
  expect(body.isConnected).toBe(true); expect(window.getSelection()!.getRangeAt(0)).toBe(range); expect(requests).toHaveLength(count)
 })
 it('retains an original body after a source rewrite and explicitly recovers its same raw identity', async () => {
  useAppStore.setState({ agentComposerDrafts: { [sid]: 'Original source-recovery draft' } })
  await render(compose()); const before = ids(), accepted = acceptedWindow()
  expect(accepted.navigation.newer).toBeNull()
  const original = container.querySelector('[data-native-record-id="record-353"] .log-turn__body')!
  const failedReadStart = vi.mocked(api.conversation.readConversationChanges).mock.calls.length
  await writeFile(transcript, Array.from({ length: 360 }, (_, n) => JSON.stringify(n === 359
   ? { ...record(n), message: { role: 'assistant', content: [{ type: 'text', text: 'Updated native reply 359' }] } } : record(n))).join('\n') + '\n')
  await act(async () => observation?.({ source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated', agentSessionId: sid })); await flush()
  await vi.waitFor(async () => {
   await flush()
   const consumer = inspectConversationConsumers(control).consumers[0]
   expect(consumer?.error?.code).toBe('AGENT_CONVERSATION_SOURCE_READ_UNAVAILABLE')
   expect(consumer?.accepted?.coverage.flatMap(source => source.gaps.map(gap => gap.code))).toContain('AGENT_SESSION_HISTORY_SOURCE_CHANGED')
  })
  expect(ids()).toEqual(before); expect(original.isConnected).toBe(true)
  expect(container.textContent).toContain('Conversation reading interrupted')
  expect(container.textContent).not.toContain('Updated native reply 359')
  const count = requests.length
  await act(async () => document.dispatchEvent(new Event('selectionchange'))); await render(compose())
  expect(requests).toHaveLength(count); expect(original.isConnected).toBe(true)
  const publicReads = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  const publicChanges = vi.mocked(api.conversation.readConversationChanges).mock.calls.length
  const originalChanges = async (start: number) => Promise.all(vi.mocked(api.conversation.readConversationChanges).mock.calls.slice(start).map(async ([input], offset) => {
   const result = vi.mocked(api.conversation.readConversationChanges).mock.results[start + offset]
   if (result?.type !== 'return') throw new Error('The original public changes call must return its response Promise')
   return { input, page: await result.value }
  }))
  const changedPages = (await originalChanges(failedReadStart)).filter(({ page }) => page.window.id === accepted.id)
  const lastLogicalRead = changedPages.reduce((last, { input }, index) => input.cursor ? last : index, -1)
  expect(lastLogicalRead).toBeGreaterThanOrEqual(0)
  const failedPages = changedPages.slice(lastLogicalRead)
  const failedChange = failedPages[0]!.input
  expect(failedChange).toMatchObject({ hostId: 'local', agentSessionId: sid, checkpoint: accepted.checkpoint })
  const failedFrame = acceptedWindow()
  expect(failedFrame.id).toBe(accepted.id)
  const current = container.querySelector<HTMLButtonElement>('[data-message-tool-control="jump-to-latest"]')!
  expect(current, 'A failed loaded-tail cut needs its own explicit current action').not.toBeNull()
  expect(current.textContent).toBe('读取当前记录')
  await click('Retry reading')
  expect(vi.mocked(api.conversation.readAgentConversation), 'Retry must repeat the original public operation instead of reading latest').toHaveBeenCalledTimes(publicReads)
  const retries = (await originalChanges(publicChanges)).filter(({ page }) => page.window.id === accepted.id)
  expect(retries).toHaveLength(failedPages.length)
  expect(retries[0]!.input).toEqual({ ...failedChange, view: failedFrame.view })
  for (const [index, { input: retry }] of retries.entries()) {
   expect(retry).toMatchObject({ hostId: 'local', agentSessionId: sid, checkpoint: failedChange.checkpoint, view: failedFrame.view })
   if (index > 0) expect(retry.cursor).toBeTypeOf('string')
  }
  const retryPages = retries.map(({ page }) => page)
  expect(retryPages.filter(page => page.window.complete)).toHaveLength(1)
  expect(retryPages.at(-1)!.window.complete).toBe(true)
  expect(retryPages.every(page => page.window.id === failedFrame.id)).toBe(true)
  expect(ids()).toEqual(before); expect(original.isConnected).toBe(true)
  expect(inspectConversationConsumers(control).consumers[0]?.error?.code).toBe('AGENT_CONVERSATION_SOURCE_READ_UNAVAILABLE')
  expect(container.textContent).not.toContain('Updated native reply 359')
  await click('读取当前记录')
  expect(vi.mocked(api.conversation.readAgentConversation).mock.calls.length, 'Explicit current must request a new public cut').toBeGreaterThan(publicReads)
  const latest = vi.mocked(api.conversation.readAgentConversation).mock.calls[publicReads]![0]
  expect(latest).toMatchObject({ hostId: 'local', agentSessionId: sid })
  expect(latest.cursor).toBeUndefined(); expect(latest.view).toBeUndefined(); expect(latest.nativeSource).toBeUndefined()
  expect(ids().at(-1)).toBe('record-359')
  expect(container.textContent).toContain('Updated native reply 359')
  expect(inspectConversationConsumers(control).consumers[0]?.error).toBeNull()
  expect(original.isConnected).toBe(true)
  expect(acceptedWindow().id).not.toBe(accepted.id)
  expect(acceptedWindow().checkpoint).not.toEqual(accepted.checkpoint)
  expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('Original source-recovery draft')
  expect(container.querySelector('.activity-feed__latest-held')).toBeNull()
 })
 it.each(['selection', 'focus'] as const)('keeps an explicit current recovery behind the original %s admission after a source rewrite', async protection => {
  await render(compose()); const before = ids(), accepted = acceptedWindow()
  const body = container.querySelector<HTMLElement>('[data-native-record-id="record-353"] .log-turn__body')!
  const text = [...body.querySelectorAll('p')].find(node => node.textContent === 'Reply 353')!.firstChild!
  await writeFile(transcript, Array.from({ length: 360 }, (_, n) => JSON.stringify(n === 353
   ? { ...record(n), message: { role: 'assistant', content: 'Changed protected original 353' } } : record(n))).join('\n') + '\n')
  await act(async () => observation?.({ source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated', agentSessionId: sid })); await flush()
  await vi.waitFor(async () => {
   await flush()
   const consumer = inspectConversationConsumers(control).consumers[0]
   expect(consumer?.error?.code).toBe('AGENT_CONVERSATION_SOURCE_READ_UNAVAILABLE')
   expect(consumer?.accepted?.coverage.flatMap(source => source.gaps.map(gap => gap.code))).toContain('AGENT_SESSION_HISTORY_SOURCE_CHANGED')
  })
  expect(ids()).toEqual(before); expect(container.textContent).toContain('Conversation reading interrupted')
  const range = document.createRange(); range.selectNodeContents(text)
  const focused = body.closest<HTMLElement>('[data-native-record-id]')!.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!
  expect(focused).not.toBeNull()
  const current = container.querySelector<HTMLButtonElement>('[data-message-tool-control="jump-to-latest"]')!
  expect(current, 'Explicit recovery must remain reachable before presentation admission').not.toBeNull()
  await act(async () => {
   if (protection === 'selection') window.getSelection()!.addRange(range)
   else focused.focus()
   current.click()
  })
  await vi.waitFor(async () => {
   await flush({ pending: true })
   expect(inspectConversationConsumers(control).consumers[0]).toMatchObject({ held: true, loading: false, inFlight: false })
  })
  expect(ids()).toEqual(before); expect(body.isConnected).toBe(true); expect(text.isConnected).toBe(true)
  expect(body.textContent).toContain('Reply 353')
  expect(acceptedWindow().id).toBe(accepted.id)
  if (protection === 'selection') expect(window.getSelection()!.getRangeAt(0)).toBe(range)
  else expect(document.activeElement).toBe(focused)
  await act(async () => {
   window.getSelection()!.removeAllRanges(); focused.blur(); document.dispatchEvent(new Event('selectionchange'))
  }); await flush()
  expect(container.textContent).toContain('Changed protected original 353')
  expect(inspectConversationConsumers(control).consumers[0]?.error).toBeNull()
  expect(acceptedWindow().id).not.toBe(accepted.id)
 })
 it('does not execute a failed-cut current action while its original Activity consumer is hidden', async () => {
  await render(compose()); const before = ids()
  await writeFile(transcript, Array.from({ length: 360 }, (_, n) => JSON.stringify(n === 359
   ? { ...record(n), message: { role: 'assistant', content: 'Hidden source-recovery original 359' } } : record(n))).join('\n') + '\n')
  await act(async () => observation?.({ source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated', agentSessionId: sid })); await flush()
  await vi.waitFor(async () => {
   await flush()
   const consumer = inspectConversationConsumers(control).consumers[0]
   expect(consumer?.error?.code).toBe('AGENT_CONVERSATION_SOURCE_READ_UNAVAILABLE')
   expect(consumer?.accepted?.coverage.flatMap(source => source.gaps.map(gap => gap.code))).toContain('AGENT_SESSION_HISTORY_SOURCE_CHANGED')
  })
  expect(container.textContent).toContain('Conversation reading interrupted')
  await render(compose(false))
  const current = container.querySelector<HTMLButtonElement>('[data-message-tool-control="jump-to-latest"]')!
  expect(current).not.toBeNull(); expect(current.disabled).toBe(true)
  const reads = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  const changes = vi.mocked(api.conversation.readConversationChanges).mock.calls.length
  await act(async () => current.click()); await flush()
  expect(ids()).toEqual(before)
  expect(vi.mocked(api.conversation.readAgentConversation)).toHaveBeenCalledTimes(reads)
  expect(vi.mocked(api.conversation.readConversationChanges)).toHaveBeenCalledTimes(changes)
  expect(container.textContent).not.toContain('Hidden source-recovery original 359')
  await render(compose())
  await click('读取当前记录')
  expect(container.textContent).toContain('Hidden source-recovery original 359')
 })
 it('keeps a protected historical selection on Latest until its original Range is cleared', async () => {
  await writeFile(transcript, Array.from({ length: 1400 }, (_, n) => JSON.stringify(record(n))).join('\n') + '\n')
  await render(compose())
  expect(ids()).toHaveLength(300)
  for (let n = 0; n < 10 && !acceptedWindow().navigation.newer; n++) await click('Earlier')
  expect(ids()).toHaveLength(1200)
  expect(acceptedWindow().navigation.newer).toBeTypeOf('string')
  const group = container.querySelector<HTMLElement>('[data-conversation-process-members]')!, label = group.querySelector<HTMLElement>('.wf-head .wf-observation__recorded')!
  const text = label.firstChild!, quote = label.textContent
  const range = document.createRange(); range.selectNodeContents(label); window.getSelection()!.addRange(range)
  const before = ids(), currentButton = container.querySelector<HTMLButtonElement>('[data-message-tool-control="jump-to-latest"]')!
  expect(currentButton).not.toBeNull()
  await click('滚动到最新')
  expect(inspectConversationConsumers(control).consumers[0]).toMatchObject({ held: true, loading: false, inFlight: false })
  expect(ids()).toEqual(before); expect(group.isConnected).toBe(true); expect(window.getSelection()!.getRangeAt(0)).toBe(range)
  expect(label.firstChild).toBe(text); expect(window.getSelection()!.toString()).toBe(quote)
  expect(inspectConversationConsumers(control).consumers[0]?.held).toBe(true)
  window.getSelection()!.removeAllRanges()
  await act(async () => document.dispatchEvent(new Event('selectionchange'))); await flush()
  expect(ids()).toEqual(Array.from({ length: 300 }, (_, n) => `record-${1100 + n}`))
  expect(acceptedWindow().navigation.newer).toBeNull()
 })
 it('cancels a superseded pending older page after explicit Current and rejects its late original result', async () => {
  await writeFile(transcript, Array.from({ length: 1400 }, (_, n) => JSON.stringify(record(n))).join('\n') + '\n')
  await render(compose())
  expect(ids()).toHaveLength(300)
  for (let n = 0; n < 10 && !acceptedWindow().navigation.newer; n++) await click('Earlier')
  expect(ids()).toHaveLength(1200)
  expect(acceptedWindow().navigation.newer).toBeTypeOf('string')
  let release!: (page: AgentSessionHistoryPage) => void
  let requested: AgentSessionHistoryPageOptions | undefined
  nativePage.mockImplementationOnce((_reference, options) => {
   requested = options; requests.push(options ?? {}); return new Promise(resolve => { release = resolve })
  })
  const olderCursor = acceptedWindow().navigation.older
  expect(olderCursor).toBeTypeOf('string')
  const readStart = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  const earlier = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Earlier')!
  await act(async () => { earlier.focus(); earlier.click() })
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  expect(requested?.cursor).toBeTypeOf('string')
  const late = await readOriginalPage(sid, requested)
  const pendingRead = vi.mocked(api.conversation.readAgentConversation).mock.calls[readStart]!
  expect(pendingRead[0].cursor).toBe(olderCursor)
  expect(pendingRead[1]?.signal?.aborted).toBe(false)
  expect(container.querySelector<HTMLButtonElement>('button[data-message-tool-control="jump-to-latest"]')!.disabled).toBe(false)
  const count = requests.length, currentStart = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  await act(async () => container.querySelector<HTMLButtonElement>('button[data-message-tool-control="jump-to-latest"]')!.click())
  expect(pendingRead[1]?.signal?.aborted).toBe(true)
  await vi.waitFor(() => {
   const latest = vi.mocked(api.conversation.readAgentConversation).mock.calls[currentStart]?.[0]
   expect(latest).toMatchObject({ hostId: 'local', agentSessionId: sid })
   expect(latest?.cursor).toBeUndefined()
  })
  // The original provider read may finish after its UI request is cancelled.
  // Release that actual result before awaiting the independent current frame.
  await act(async () => release(late)); await flush()
  expect(ids()).toEqual(Array.from({ length: 300 }, (_, n) => `record-${1100 + n}`))
  expect(acceptedWindow().navigation.newer).toBeNull()
  expect(requests).toHaveLength(count + 3); expect(container.querySelector('[data-conversation-reading]')?.getAttribute('data-conversation-reading')).toBe('current')
 })
 it('does not replace the accepted original source with foreign or missing context props and disables Earlier while hidden', async () => {
  const current = await readOriginalPage(sid)
  const surface = (page: AgentSessionHistoryPage | null, enabled = true) => <ActivityView sessionId={sid} capability="complete-events" nativeHistoryPage={page}
   conversationReading={{ reference: control, identity: control.run.runId, enabled }} />
  await render(surface(current)); const before = ids(), accepted = acceptedWindow(), count = requests.length
  expect(before).toHaveLength(300)
  const publicReads = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  for (const page of [null, { ...current, items: [] }, { ...current, agentSessionId: 'foreign-agent' },
   { ...current, source: { ...current.source, providerId: 'foreign-provider' } }, { ...current, source: { ...current.source, nativeSessionId: 'foreign-native' } }]) {
   await render(surface(page)); expect(ids()).toEqual(before)
   expect(acceptedWindow()).toEqual(accepted)
   expect(container.textContent, JSON.stringify({source:page?.source,session:page?.agentSessionId,count:page?.items.length,entry:container.querySelector('[data-conversation-current-entry]')?.textContent})).not.toContain('Current records updated')
  }
  await render(surface(current, false))
  const earlier = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Earlier')!
  expect(earlier).toBeDefined(); expect(earlier.disabled).toBe(true)
  await act(async () => earlier.click()); await flush()
  expect(ids()).toEqual(before); expect(requests).toHaveLength(count)
  expect(vi.mocked(api.conversation.readAgentConversation)).toHaveBeenCalledTimes(publicReads)
 })

 it('seeds normal unopened Activity with300 raw and keeps distinct same-body appended records live', async () => {
  await render(compose())
  expect(ids()).toEqual(Array.from({ length: 300 }, (_, n) => `record-${String(60 + n).padStart(3, '0')}`))
  expect(container.querySelector('[data-conversation-reading]')?.getAttribute('data-conversation-reading')).toBe('current')
  const body = container.querySelector<HTMLElement>('[data-native-record-id="record-353"] .log-turn__body')!
  const localReads = requests.filter(request => request.limit === 100).length
  const activityWindow = acceptedWindow().id
  const ownChangeCalls = () => {
   const views = new Set(readingReceipts.flatMap(page => page.window.id === activityWindow && page.window.view ? [page.window.view] : []))
   return vi.mocked(api.conversation.readConversationChanges).mock.calls.filter(([input]) => input.view !== undefined && views.has(input.view))
  }
  const ownChanges = () => ownChangeCalls().filter(([input]) => !input.cursor).length
  const beforeBurst = ownChanges(), beforeWire = ownChangeCalls().length
  const appended = [360, 361].map(n => ({ ...record(n), type: 'user', message: { role: 'user', content: 'Same actual body, two native UUIDs' } }))
  await appendFile(transcript, appended.map(row => JSON.stringify(row)).join('\n') + '\n')
  await act(async () => {
   for (let event = 0; event < 3; event++) observation?.({ agentSessionId: sid, source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated' })
  }); await flush()
  expect(ownChanges() - beforeBurst, 'One relevant invalidation burst coalesces into one change read for this original Activity window').toBe(1)
  const burst = ownChangeCalls().slice(beforeWire)
  // A full replacement window spans four 100-item transport pages. Its
  // continuation pages do not start another source changes transaction.
  expect(burst).toHaveLength(4)
  expect(burst.slice(1).every(([input]) => Boolean(input.cursor))).toBe(true)
  for (const [input] of burst) {
   expect(input.view).toBe(burst[0]![0].view)
   expect(input.checkpoint).toEqual(burst[0]![0].checkpoint)
  }
  expect(body.isConnected).toBe(true); expect(body.textContent).toContain('Reply 353')
  expect(ids().slice(-2)).toEqual(['record-360', 'record-361'])
  expect([...container.querySelectorAll('.conversation-native-thread .log-turn__body')].filter(node => node.textContent === 'Same actual body, two native UUIDs')).toHaveLength(2)
  expect(requests.filter(request => request.limit === 100)).toHaveLength(localReads)
  expect(container.querySelector('.activity-feed__newer-edge')).toBeNull()
 })
 it('slides beyond1200 then replays adjacent visited pages and catches up from its original cut after a live gap', async () => {
  await writeFile(transcript, Array.from({ length: 1600 }, (_, n) => JSON.stringify(record(n))).join('\n') + '\n')
  await render(compose())
  expect(ids()).toHaveLength(300)
  await appendFile(transcript, JSON.stringify(record(1600)) + '\n')
  await act(async () => observation?.({ agentSessionId: sid, source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated' })); await flush()
  expect(ids().at(-1)).toBe('record-1600')
  const historyCut = ids()[0]!
 const originalHead = ids().slice(-101), shared = recent!.nativeHistoryPage
  expect(originalHead[0]).toBe('record-1500')
  // Each explicit navigation admits one original 100-record page. Continue far
  // enough to exercise the actual 1,200-record window rather than the old batch.
  for (let n = 0; n < 10; n++) await click('Earlier')
  expect(ids().length).toBeLessThanOrEqual(1200); expect(ids()).not.toContain('record-1500')
  expect(ids()).toContain(historyCut)
  const boundary = container.querySelector<HTMLElement>('.activity-feed__history-divider')!.parentElement!
  const next = boundary.nextElementSibling as HTMLElement
  expect(next.dataset.nativeRecordId ?? processNativeRecordIds(next)[0]).toBe(historyCut)
  const previous = boundary.previousElementSibling as HTMLElement
  const previousId = previous.dataset.nativeRecordId ?? processNativeRecordIds(previous).at(-1)
  expect(previousId).toBe(`record-${Number(historyCut.slice('record-'.length)) - 1}`)
  expect(boundary.textContent).toBe(`以上是历史消息（${new Date(record(Number(historyCut.slice('record-'.length)) - 1).timestamp).toLocaleString()}）`)
  for (let n = 0; ids().includes(historyCut) && n < 3; n++) await click('Earlier')
  expect(ids()).not.toContain(historyCut)
  expect(container.querySelector('.activity-feed__history-divider')).toBeNull()
  expect([...container.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Newer')).toBe(true)
  expect(recent!.nativeHistoryPage).toBe(shared)
  const nullReads = requests.filter(request => request.limit === 100 && !request.cursor).length
  await appendFile(transcript, Array.from({ length: 130 }, (_, n) => JSON.stringify(record(1601 + n))).join('\n') + '\n')
  await act(async () => observation?.({ agentSessionId: sid, source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated' })); await flush()
  let visitedNewer = 0
  while (!ids().includes('record-1600') && visitedNewer < 10) {
   const cursor = acceptedWindow().navigation.newer
   expect(cursor).toBeTruthy()
   const reads = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
   await click('Newer'); visitedNewer++
   expect(vi.mocked(api.conversation.readAgentConversation).mock.calls[reads]?.[0].cursor).toBe(cursor)
  }
  expect(visitedNewer).toBeGreaterThan(0)
  const after = ids(), head = after.indexOf(originalHead[0]!)
  expect(head).toBeGreaterThanOrEqual(0); expect(after.slice(head, head + originalHead.length)).toEqual(originalHead)
  const ordinals = after.map(id => Number(id.slice('record-'.length)))
  expect(ordinals).toEqual(Array.from({ length: ordinals.length }, (_, n) => ordinals[0]! + n))
  expect(after.at(-1)).toBe('record-1730'); expect(after.length).toBeLessThanOrEqual(1200)
  expect(requests.filter(request => request.limit === 100 && !request.cursor)).toHaveLength(nullReads)
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!
  markerGeometry(viewport); await scrollTo(viewport, 5000)
  const reads = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  await click('滚动到最新'); expect(ids()).toEqual(after)
  expect(vi.mocked(api.conversation.readAgentConversation)).toHaveBeenCalledTimes(reads)
  if (process.env.AGENTMUX_SLIDING_SCENE_PAGES) await writeFile(process.env.AGENTMUX_SLIDING_SCENE_PAGES, JSON.stringify({ provenance: 'Controlled native Claude JSONL -> real public Core/FileStore; original API request and response in order, no user App/vendor writer', receipts: await Promise.all(promises.map(async (response, index) => ({ request: requests[index], response: await response }))) }, null, 2) + '\n')
 })


 it('returns to an appended loaded tail without creating a false gap or another read', async () => {
  await render(compose())
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!
  markerGeometry(viewport); await scrollTo(viewport, 9800); await scrollTo(viewport, 500)
  const before = ids(), body = viewport.querySelector<HTMLElement>('[data-native-record-id="record-353"] .log-turn__body')!
  const reads = requests.length
  await appendFile(transcript, Array.from({ length: 301 }, (_, n) => JSON.stringify(record(360 + n))).join('\n') + '\n')
  await act(async () => observation?.({ agentSessionId: sid, source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated' })); await flush()
  await vi.waitFor(async () => {
   await flush()
   expect(ids()).toEqual([...before, ...Array.from({ length: 301 }, (_, n) => `record-${360+n}`)])
   expect(readingSummary).not.toBeNull(); expect(recent).not.toBeNull()
   const consumers = [...inspectConversationConsumers(control).consumers.filter(consumer => consumer.gates.enabled),
    readingSummary!.conversation.inspect(), recent!.conversation.inspect()]
   expect(consumers).toHaveLength(3)
   for (const consumer of consumers) expect(consumer).toMatchObject({ historical: false, dirty: false, inFlight: false, loading: false, error: null,
    watch: { binding: false } })
  }, { timeout: 4000, interval: 10 })
  expect(body.isConnected).toBe(true); expect(viewport.scrollTop).toBe(500)
  expect(requests).toHaveLength(reads)
  const latest = container.querySelectorAll<HTMLButtonElement>('[data-message-tool-control="jump-to-latest"]')
  expect(latest).toHaveLength(1)
  expect([...container.querySelectorAll('button')].some(button => ['Current', 'Show latest messages', 'Jump to latest'].includes(button.textContent?.trim() ?? ''))).toBe(false)
  const changes = vi.mocked(api.conversation.readConversationChanges).mock.calls.length
  const pages = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  await act(async () => latest[0]!.click()); await flush()
  expect(viewport.scrollTop).toBe(9800)
  expect(ids().at(-1)).toBe('record-660'); expect(body.isConnected).toBe(true)
  expect(requests).toHaveLength(reads)
  expect(vi.mocked(api.conversation.readConversationChanges).mock.calls).toHaveLength(changes)
  expect(vi.mocked(api.conversation.readAgentConversation).mock.calls).toHaveLength(pages)
 })

 it('retains a failed public changes read without selection or render retry polling', async () => {
  await render(compose())
  const before = ids(), body = container.querySelector('[data-native-record-id="record-353"] .log-turn__body')!
  const original = vi.mocked(api.conversation.readConversationChanges).getMockImplementation()!
  vi.mocked(api.conversation.readConversationChanges).mockRejectedValue(new Error('Original current source read unavailable'))
  const reads = vi.mocked(api.conversation.readConversationChanges).mock.calls.length
  await appendFile(transcript, JSON.stringify(record(360)) + '\n')
  await act(async () => observation?.({ agentSessionId: sid, source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated' })); await flush()
  expect(vi.mocked(api.conversation.readConversationChanges).mock.calls.length).toBeGreaterThan(reads)
  expect(ids()).toEqual(before); expect(body.isConnected).toBe(true)
  expect(container.querySelector('.activity-feed__reading-service')).not.toBeNull()
  expect(container.textContent).toContain('Original current source read unavailable')
  const failed = vi.mocked(api.conversation.readConversationChanges).mock.calls.length
  await act(async () => document.dispatchEvent(new Event('selectionchange'))); await render(compose())
  expect(vi.mocked(api.conversation.readConversationChanges).mock.calls).toHaveLength(failed)
  expect(ids()).toEqual(before); expect(body.isConnected).toBe(true)
  vi.mocked(api.conversation.readConversationChanges).mockImplementation(original)
  await click('Retry reading')
  expect(ids().at(-1)).toBe('record-360'); expect(body.isConnected).toBe(true)
  expect(container.textContent).not.toContain('Original current source read unavailable')
 })
 it('keeps a genuine read failure and Retry when a later same-source update is held by the original Range', async () => {
  await writeFile(transcript, Array.from({ length: 1260 }, (_, n) => JSON.stringify(record(n))).join('\n') + '\n')
  await render(compose()); for (let batch = 0; batch < 9; batch++) await click('Earlier')
  const original = vi.mocked(api.conversation.readAgentConversation).getMockImplementation()!
  const cursor = acceptedWindow().navigation.older!
  expect(cursor).toBeTruthy()
  let failed = 0
  vi.mocked(api.conversation.readAgentConversation).mockImplementation(input => {
   if (input.cursor === cursor) { failed++; return Promise.reject(new Error('Original background source read unavailable')) }
   return original(input)
  })
  await click('Earlier')
  expect(failed).toBe(1); expect(container.textContent).toContain('Original background source read unavailable')
  const body = container.querySelector<HTMLElement>('[data-native-record-id="record-065"] .log-turn__body')!
  const range = document.createRange(); range.selectNodeContents(body.querySelector('p')!); window.getSelection()!.addRange(range)
  const before = ids()
  // A legal append crosses the actual current-window budget. Rewriting a
  // native prefix would instead invalidate its checkpoint before admission.
  await appendFile(transcript, Array.from({ length: 30 }, (_, n) => JSON.stringify(record(1260 + n))).join('\n') + '\n')
  await act(async () => observation?.({ agentSessionId: sid, source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated' })); await flush()
  expect(ids()).toEqual(before); expect(body.isConnected).toBe(true); expect(window.getSelection()!.getRangeAt(0)).toBe(range)
  expect(inspectConversationConsumers(control).consumers[0]?.held).toBe(true); expect(container.textContent).toContain('Original background source read unavailable')
  expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Retry reading')).toBe(true)
  await act(async () => { window.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) }); await flush(); await render(compose())
  expect(failed).toBe(1); expect(container.textContent).toContain('Original background source read unavailable')
 })

 it('keeps a latest action for a held-only current window and uses a real current read after the Range is cleared', async () => {
  await render(compose())
  const group = [...container.querySelectorAll<HTMLElement>('[data-conversation-process-members]')]
   .find(node => processNativeRecordIds(node).includes('record-359'))!, label = group.querySelector<HTMLElement>('.log-fold__steps')!
  const range = document.createRange(); range.selectNodeContents(label); window.getSelection()!.addRange(range)
  const before = ids(), originalCount = label.textContent
  await appendFile(transcript, JSON.stringify({ ...record(360), type: 'assistant',
   message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'A genuinely appended process member' }] } }) + '\n')
  await act(async () => observation?.({ agentSessionId: sid, source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated' })); await flush()
  expect(ids()).toEqual(before); expect(group.isConnected).toBe(true); expect(window.getSelection()!.getRangeAt(0)).toBe(range)
  expect(label.textContent).toBe(originalCount)
  expect(inspectConversationConsumers(control).consumers[0]?.held).toBe(true)
  expect(container.querySelectorAll('button[data-message-tool-control="jump-to-latest"]'), 'A held-only current frame keeps its explicit current action').toHaveLength(1)
  window.getSelection()!.removeAllRanges()
  const readStart = vi.mocked(api.conversation.readAgentConversation).mock.calls.length; await click('滚动到最新')
  expect(vi.mocked(api.conversation.readAgentConversation).mock.calls.slice(readStart)
   .some(([input]) => !input.cursor && !input.view && !input.anchor)).toBe(true)
  expect(ids().at(-1)).toBe('record-360'); expect(inspectConversationConsumers(control).consumers[0]?.held).toBe(false)
 })

 it('bounds a continuously updated current head, preserves a protected Range without polling, and automatically resumes when that protection clears', async () => {
  await writeFile(transcript, Array.from({ length: 1200 }, (_, n) => JSON.stringify(record(n))).join('\n') + '\n')
  await render(compose()); for (let batch = 0; batch < 9; batch++) await click('Earlier')
  const body = container.querySelector<HTMLElement>('[data-native-record-id="record-009"] .log-turn__body')!
  const range = document.createRange(); range.selectNodeContents(body.querySelector('p')!); window.getSelection()!.addRange(range)
  const publish = async (first: number, count = 30) => {
   await appendFile(transcript, Array.from({ length: count }, (_, n) => JSON.stringify(record(first + n))).join('\n') + '\n')
   await act(async () => observation?.({ agentSessionId: sid, source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated' })); await flush()
  }
  await publish(1200)
  expect(body.isConnected).toBe(true); expect(window.getSelection()!.getRangeAt(0)).toBe(range)
  expect(inspectConversationConsumers(control).consumers[0]?.held).toBe(true)
  const activityWindow = acceptedWindow().id
  const ownChanges = () => {
   const views = new Set(readingReceipts.flatMap(page => page.window.id === activityWindow && page.window.view ? [page.window.view] : []))
   return vi.mocked(api.conversation.readConversationChanges).mock.calls.filter(([input]) => input.view !== undefined && views.has(input.view)).length
  }
  const attempted = ownChanges()
  await publish(1230); await publish(1260)
  expect(ownChanges()).toBe(attempted)
  expect(body.isConnected).toBe(true); expect(window.getSelection()!.toString()).toBe('Reply 9')
  await act(async () => { window.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) }); await flush()
  await vi.waitFor(async () => { await flush(); expect(ids().at(-1)).toBe('record-1289') })
  expect(ids()).toHaveLength(1200)
  const afterResume = vi.mocked(api.conversation.readConversationChanges).mock.calls.length
  await act(async () => document.dispatchEvent(new Event('selectionchange'))); await render(compose())
  expect(vi.mocked(api.conversation.readConversationChanges).mock.calls).toHaveLength(afterResume)
  expect(inspectConversationConsumers(control).consumers[0]?.held).toBe(false)
  await publish(1290)
  expect(ids()).toHaveLength(1200); expect(ids().at(-1)).toBe('record-1319')
  const cursor = acceptedWindow().navigation.older
  expect(cursor).toBeTruthy()
  const reads = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  await click('Earlier')
  expect(vi.mocked(api.conversation.readAgentConversation).mock.calls[reads]?.[0].cursor).toBe(cursor)
  expect(ids().length).toBeLessThanOrEqual(1200)
  expect(container.textContent).not.toContain('byte budget')
 })
 it('keeps the displayed current window when a real current change finishes hidden, then resumes the same following tail once visible', async () => {
  await render(compose())
  const before = ids(), original = vi.mocked(api.conversation.readConversationChanges).getMockImplementation()!
  const view = acceptedWindow().view!
  expect(view).toBeTruthy()
  let release: (() => Promise<void>) | undefined
  vi.mocked(api.conversation.readConversationChanges).mockImplementation(input => {
   if (input.view === view && !release) return new Promise(resolve => { release = async () => resolve(await original(input)) })
   return original(input)
  })
  await appendFile(transcript, Array.from({ length: 30 }, (_, n) => JSON.stringify(record(360 + n))).join('\n') + '\n')
  await act(async () => observation?.({ agentSessionId: sid, source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated' }))
  await vi.waitFor(async () => { await flush({ pending: true }); expect(release).toBeTypeOf('function') })
  await render(compose(false)); await act(async () => release!()); await flush()
  expect(ids()).toEqual(before)
  const hidden = inspectConversationConsumers(control).consumers[0]!
  expect(hidden.gates.enabled).toBe(false); expect(hidden.loading).toBe(false)
  const reads = vi.mocked(api.conversation.readConversationChanges).mock.calls.length
  await render(compose(false))
  expect(vi.mocked(api.conversation.readConversationChanges).mock.calls).toHaveLength(reads)
  await render(compose()); await flush()
  await vi.waitFor(async () => { await flush(); expect(ids().at(-1)).toBe('record-389') })
  expect(ids()).toEqual([...before, ...Array.from({ length: 30 }, (_, n) => `record-${360+n}`)])
  const resumed = vi.mocked(api.conversation.readConversationChanges).mock.calls.length
  await act(async () => document.dispatchEvent(new Event('selectionchange'))); await render(compose())
  expect(vi.mocked(api.conversation.readConversationChanges).mock.calls).toHaveLength(resumed)
 })
 it('protects an expanded real body and Range before newer navigation trims the old side, then presents that same adjacent frame', async () => {
  await writeFile(transcript, Array.from({ length: 2400 }, (_, n) => JSON.stringify(record(n))).join('\n') + '\n')
  await render(compose()); for (let n = 0; n < 12; n++) await click('Earlier')
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!, body = viewport.querySelector<HTMLElement>('[data-native-record-id="record-921"] .log-turn__body')!
  const row = body.closest<HTMLElement>('[data-native-record-id]')!, trace = body.querySelector<HTMLDetailsElement>('[data-trace-kind="reasoning"]')!
  trace.open = true; const range = document.createRange(); range.selectNodeContents(body.querySelector('p')!); window.getSelection()!.addRange(range)
  viewport.getBoundingClientRect = () => rect(0, 200); row.getBoundingClientRect = () => rect(10)
  const before = ids(), input = acceptedWindow().navigation.newer
  expect(input).toBeTruthy()
  const start = vi.mocked(api.conversation.readAgentConversation).mock.calls.length; await click('Newer')
  expect(ids()).toEqual(before); expect(body.isConnected).toBe(true); expect(trace.open).toBe(true); expect(window.getSelection()!.getRangeAt(0)).toBe(range)
  expect(vi.mocked(api.conversation.readAgentConversation).mock.calls[start]?.[0].cursor).toBe(input)
  window.getSelection()!.removeAllRanges(); row.getBoundingClientRect = () => rect(-200)
  const retained = viewport.querySelector<HTMLElement>('[data-native-record-id="record-1601"]')!; retained.getBoundingClientRect = () => rect(10)
  const retry = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  await act(async () => document.dispatchEvent(new Event('selectionchange'))); await flush()
  expect(vi.mocked(api.conversation.readAgentConversation)).toHaveBeenCalledTimes(retry)
  expect(ids()[0]).toBe('record-1000'); expect(ids().at(-1)).toBe('record-2199'); expect(retained.isConnected).toBe(true)
 })
 it('prefetches only on a real directional edge entry and keeps ruler and editable keys from reading pages', async () => {
  await render(compose()); const viewport = container.querySelector<HTMLElement>('.activity-feed')!, slider = container.querySelector<HTMLElement>('[role="slider"]')!
  const before = requests.length
  await act(async () => slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })))
  const input = document.createElement('input'); viewport.append(input)
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })))
  expect(requests).toHaveLength(before)
  await act(async () => viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true, cancelable: true }))); await flush()
  expect(ids()).toHaveLength(360); expect(requests).toHaveLength(before + 1)
  const ended = requests.length; await wheel(); await wheel(100)
  expect(requests).toHaveLength(ended)
 })
 it('consumes one large wheel intent without letting later anchor or layout scrolls issue another batch', async () => {
  const measurements: { target: Element; callback: ResizeObserverCallback }[] = []
  vi.stubGlobal('ResizeObserver', class {
   constructor(private callback: ResizeObserverCallback) {}
   observe(target: Element) { measurements.push({ target, callback: this.callback }) }
   unobserve() {} disconnect() {}
  })
  await writeEdgeHistory(2400)
  await render(compose())
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!
  const reserve = growingEarlierReserve(viewport)
  const first = Number(ids()[0]!.slice('record-'.length)), before = requests.length
  await wheel(-200000, 0)
  expect(requests).toHaveLength(before + 3); expect(ids()[0]).toBe(`record-${first - 300}`)
  // Consume the actual prepend restoration, then establish an original visible anchor.
  await act(async () => viewport.dispatchEvent(new Event('scroll')))
  const row = container.querySelector<HTMLElement>('[data-native-record-id="record-2393"]')!
  let offset = 5010; row.getBoundingClientRect = () => rect(100 + offset - viewport.scrollTop)
  await scrollTo(viewport, 5000)
  offset = 30
  const active = measurements.filter(item => item.target.classList.contains('conversation-native-thread'))
  expect(active.length).toBeGreaterThan(0)
  await act(async () => { for (const measure of active) measure.callback([], {} as ResizeObserver) })
  expect(viewport.scrollTop).toBe(20)
  await act(async () => viewport.dispatchEvent(new Event('scroll'))); await flush()
  expect(requests).toHaveLength(before + 3); expect(ids()[0]).toBe(`record-${first - 300}`)
  // A genuinely new wheel can leave and re-enter the edge for the next batch.
  await wheel(-100, 5000); expect(requests).toHaveLength(before + 3)
  // A single large input crosses into the prefetch edge without a second event.
  reserve.reset()
  await wheel(-200000, 5000)
  // A synthetic wheel has no browser default scrolling. Complete the actual
  // physical edge movement before expecting layout feedback to spend demand.
  await scrollTo(viewport, 0); await flush()
  expect(requests).toHaveLength(before + 6); expect(ids()[0]).toBe(`record-${first - 600}`)
 })
 it('places an inline history boundary at the actual wider displayed context without remounting its expanded process or nonempty Range', async () => {
  const current = await readOriginalPage(sid, { limit: 30 })
  const context = await readOriginalPage(sid, { limit: 100 })
  const olderContext = await readOriginalPage(sid, { limit: 100, cursor: context.nextCursor! })
  const contextItems = [...olderContext.items, ...context.items]
  expect(current.items[0]!.id).toBe('record-330'); expect(contextItems[0]!.id).toBe('record-160')
  await render(<ActivityView sessionId={sid} capability="complete-events" nativeHistoryPage={current} nativeContextItems={contextItems}
   conversationReading={{ reference: control, identity: control.run.runId, enabled: true }} />)
  const thread = container.querySelector('.conversation-native-thread')!, viewport = container.querySelector<HTMLElement>('.activity-feed')!
  const parent = [...thread.querySelectorAll<HTMLElement>('[data-conversation-process-members]')].find(node => processNativeRecordIds(node).includes('record-250'))!
  const head = parent.querySelector<HTMLButtonElement>('.wf-head')!
  await act(async () => head.click())
  const deferred = parent.querySelector<HTMLElement>('[data-deferred-process-id="record-250"]')!
  expect(deferred).not.toBeNull()
  expect(deferred.querySelector('.log-turn__body')).toBeNull()
  const step = deferred.querySelector<HTMLButtonElement>('[data-observation-step-id="record-250"]')!
  const detailReadStart = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  await act(async () => step.click()); await flush()
  await vi.waitFor(() => expect(deferred.querySelector('[data-native-record-id="record-250"] .log-turn__body')).not.toBeNull())
  const detailReads = vi.mocked(api.conversation.readAgentConversation).mock.calls.slice(detailReadStart)
  expect(detailReads.length).toBeGreaterThan(0)
  expect(detailReads.every(([input]) => input.anchor?.record.source.recordId === 'record-250' && !input.cursor)).toBe(true)
  const row = deferred.querySelector<HTMLElement>('[data-native-record-id="record-250"]')!
  const body = row.querySelector<HTMLElement>('.log-turn__body')!
  const trace = body.querySelector<HTMLDetailsElement>('[data-trace-kind="reasoning"]')!
  await act(async () => { trace.open = true; trace.dispatchEvent(new Event('toggle')) })
  const text = [...body.querySelectorAll('p')].find(node => node.textContent === 'Process 250')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 7); window.getSelection()!.addRange(range)
  expect(window.getSelection()!.toString()).toBe('Process')
  viewport.getBoundingClientRect = () => rect(100, 200); row.getBoundingClientRect = () => rect(110)
  const preserved = () => {
   expect(container.querySelector('.conversation-native-thread')).toBe(thread)
   expect(row.closest('[data-conversation-process-members]')).toBe(parent); expect(parent.isConnected).toBe(true)
   expect(row.querySelector('.log-turn__body')).toBe(body); expect(body.isConnected).toBe(true)
   expect(head.getAttribute('aria-expanded')).toBe('true'); expect(step.getAttribute('aria-expanded')).toBe('true'); expect(trace.open).toBe(true)
   expect(window.getSelection()!.getRangeAt(0)).toBe(range); expect(window.getSelection()!.toString()).toBe('Process')
   expect(conversationReadingAnchor(viewport)).toEqual({ kind: 'record', id: 'record-250', offset: 10 })
  }
  expect(thread.querySelector('[role="separator"]')).toBeNull()
  await click('Earlier'); expect(ids()[0]).toBe('record-000'); preserved()
  const divider = thread.querySelector<HTMLElement>('.activity-feed__history-divider')!
  expect(divider).not.toBeNull()
  const marker = divider.parentElement!
  expect(marker.dataset.conversationLayoutKey).toBe(JSON.stringify(['anchor', 'history-boundary']))
  expect(marker.parentElement).toBe(thread); expect(marker.previousElementSibling).not.toBeNull()
  expect(processNativeRecordIds(marker.previousElementSibling!).at(-1)).toBe('record-059')
  expect(marker.nextElementSibling).not.toBeNull()
  const previous = await readOriginalPage(sid, { limit: 1, cursor: (await readOriginalPage(sid, { limit: 100, cursor: olderContext.nextCursor! })).nextCursor! })
  expect(previous.items[0]!.id).toBe('record-059')
  expect(divider.textContent).toBe(`以上是历史消息（${new Date(previous.items[0]!.startedAt!).toLocaleString()}）`)
  expect(viewport.querySelector('.activity-feed__reading')).toBeNull()
  viewportGeometry(viewport); await scrollTo(viewport, 500)
  const beforeReturn = ids(), acceptedBeforeReturn = acceptedWindow(), readsBeforeReturn = requests.length
  await click('滚动到最新'); preserved()
  expect(inspectConversationConsumers(control).consumers[0]?.held).toBe(false)
  expect(ids()).toEqual(beforeReturn); expect(ids()).toHaveLength(360); expect(ids().at(-1)).toBe('record-359')
  expect(acceptedWindow()).toBe(acceptedBeforeReturn); expect(requests).toHaveLength(readsBeforeReturn)
  expect(thread.querySelector('[role="separator"]')).toBe(divider)
 })
 it('keeps an old-only window honest without a trailing divider after the current cut is evicted, and does not invent a cut on an initial read', async () => {
  await writeFile(transcript, Array.from({ length: 2400 }, (_, n) => JSON.stringify(record(n))).join('\n') + '\n')
  const current = await readOriginalPage(sid, { limit: 30 })
  await render(<ActivityView sessionId={sid} capability="complete-events" nativeHistoryPage={current}
   conversationReading={{ reference: control, identity: control.run.runId, enabled: true }} />)
  expect(container.querySelector('.activity-feed__history-divider')).toBeNull()
  await click('Earlier')
  let divider = container.querySelector<HTMLElement>('.activity-feed__history-divider')!
  expect(divider.parentElement?.nextElementSibling).not.toBeNull()
  for (let n = 0; n < 12; n++) await click('Earlier')
  expect(ids()).toHaveLength(1200); expect(ids()).not.toContain('record-2100')
  expect(container.querySelector('.activity-feed__history-divider')).toBeNull()
  expect([...container.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Newer')).toBe(true)
  expect(ids().at(-1)).toBe('record-1999')
  await click('滚动到最新'); expect(ids().at(-1)).toBe('record-2399'); expect(container.querySelector('.activity-feed__history-divider')).toBeNull()
  await act(async () => root.unmount()); root = createClientUiRoot(container)
  await render(<ActivityView sessionId={sid} capability="complete-events"
   conversationReading={{ reference: control, identity: 'retired-without-current-context', enabled: true, opened: true }} />)
  expect(ids().length).toBeGreaterThan(0); expect(container.querySelector('.activity-feed__history-divider')).toBeNull()
 })
 it('reads from the current Conversation on the first upward wheel, continues original pages and stops at their end', async () => {
  await seed(); await render(pane())
  expect(container.querySelector('[data-conversation-reading]')?.getAttribute('data-conversation-reading')).toBe('current')
  const current = ids(), visited = new Set(current)
  expect(current.at(-1)).toBe('record-359'); const before = requests.length
  await wheel()
  expect(requests.length).toBeGreaterThan(before); expect(ids()[0]).toBe('record-000')
  ids().forEach(id => visited.add(id))
  expect(new Set(ids()).size).toBe(360)
  expect(visited.size).toBe(360)
  const ended = requests.length; await wheel(); await wheel()
  expect(requests).toHaveLength(ended); expect(requests.every(read => read.limit === 30 || read.limit === 100)).toBe(true)
  expect(useAppStore.getState().sessions[0]!.control).toEqual(control)
  expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('ORIGINAL UNSENT DRAFT')
 })
 it('does not read on downward or non-top wheel, hidden surfaces, or a second wheel during the same pending page', async () => {
  await writeFile(transcript, Array.from({ length: 1200 }, (_, n) => JSON.stringify(record(n))).join('\n') + '\n')
  await render(compose()); const before = requests.length
  const activeViewport = container.querySelector<HTMLElement>('.activity-feed')!
  markerGeometry(activeViewport)
  await wheel(100); await wheel(-100, 1501)
  expect(requests).toHaveLength(before)
  await render(compose(false)); await wheel()
  expect(requests).toHaveLength(before); await render(compose())
  let release!: (page: AgentSessionHistoryPage) => void
  const page = await promises[requests.map((request, index) => request.limit === 100 ? index : -1).reduce((last, index) => Math.max(last, index), -1)]!, pending = new Promise<AgentSessionHistoryPage>(resolve => { release = resolve })
  nativePage.mockImplementationOnce((_reference, options) => { requests.push(options ?? {}); return pending })
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!; growingEarlierReserve(viewport); viewport.scrollTop = 0
  await act(async () => {
   viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }))
   viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }))
  })
  await vi.waitFor(() => expect(requests).toHaveLength(before + 1))
  expect(requests).toHaveLength(before + 1); expect(requests.at(-1)!.cursor).toBe(page.nextCursor)
  await act(async () => release(await readOriginalPage(sid, { limit: 100, cursor: page.nextCursor! }))); await flush()
  expect(ids()).toHaveLength(600); expect(requests).toHaveLength(before + 3)
 })
 it('preserves the current original body, expanded trace, Range and visible anchor through the first wheel prepend', async () => {
  await render(compose())
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!, body = viewport.querySelector<HTMLElement>('[data-native-record-id="record-353"] .log-turn__body')!
  expect(body).not.toBeNull(); const row = body.closest<HTMLElement>('[data-native-record-id]')!
  markerGeometry(viewport)
  viewport.getBoundingClientRect = () => rect(100, 200); row.getBoundingClientRect = () => rect(110)
  const trace = body.querySelector<HTMLDetailsElement>('[data-trace-kind="reasoning"]')!
  trace.open = true; const text = [...body.querySelectorAll('p')].find(node => node.textContent === 'Reply 353')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 5); window.getSelection()!.addRange(range)
  await wheel()
  expect(ids()).toHaveLength(360); expect(body.isConnected).toBe(true); expect(trace.open).toBe(true)
  expect(window.getSelection()!.getRangeAt(0)).toBe(range); expect(window.getSelection()!.toString()).toBe('Reply')
  expect(conversationReadingAnchor(viewport)).toEqual({ kind: 'record', id: 'record-353', offset: 10 })
  expect(viewport.scrollTop).toBe(0)
 })
 it('retains the current records and opaque cursor after a first-wheel read failure, then explicitly retries that original page', async () => {
  await render(compose()); const before = ids(), page = await promises[requests.map((request, index) => request.limit === 100 ? index : -1).reduce((last, index) => Math.max(last, index), -1)]!, count = requests.length
  nativePage.mockImplementationOnce(async (_reference, options) => { requests.push(options ?? {}); throw new Error('Private read unavailable') })
  await wheel()
  expect(ids()).toEqual(before); expect(requests.at(-1)!.cursor).toBe(page.nextCursor)
  expect(container.textContent).toContain('Private read unavailable'); await flush(); expect(requests).toHaveLength(count + 1)
  await click('Retry reading'); expect(ids()).toHaveLength(360)
  expect(requests[count + 1]!.cursor).toBe(page.nextCursor)
 })
 it('uses the same wheel navigation with actual public indexed stdio history and its opaque cursor', async () => {
  const script = join(home, 'indexed-history.mjs'), log = join(home, 'indexed-requests.jsonl')
  await writeFile(script, `import{appendFileSync}from'node:fs';import{createInterface}from'node:readline';
const records=Array.from({length:120},(_,n)=>({turnId:'turn-'+n,item:{type:n%2?'agentMessage':'userMessage',id:'indexed-'+n,...(n%2?{text:'Reply '+n}:{content:[{type:'text',text:'Input '+n}]})}}));
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);appendFileSync(${JSON.stringify(log)},line+'\\n');const send=result=>process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');if(r.method==='initialize')send({userAgent:'private-indexed-reader'});else if(r.method==='thread/read')send({thread:{id:${JSON.stringify(native)},historyMode:'paginated',turns:[]}});else if(r.method==='thread/items/list'){const end=r.params.cursor?Number(r.params.cursor):records.length,start=Math.max(0,end-r.params.limit);send({data:records.slice(start,end).reverse(),nextCursor:start?String(start):null})}});`)
  const next = { ...stored, providerId: 'codex', executorId: 'codex', nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: native }, updatedAt: 2 }
  await store.compareAndSwap(stored, next); stored = next; originalStore = await store.loadMetadata()
  const observers = new Set<Parameters<AgentMuxClient['observeSessionHistory']>[1]>()
  observation = event => { for (const listener of observers) listener(event) }
  vi.mocked(client.observeSessionHistory).mockImplementation(async (agentSessionId, listener) => {
   observers.add(listener)
   return { agentSessionId, source: { providerId: next.nativeHandle.providerId, nativeSessionId: next.nativeHandle.sessionId },
    dispose() { observers.delete(listener) } }
  })
  nativePage.mockImplementation((reference, options, originalSource) => {
   expect(reference).toBe(sid); requests.push(options ?? {})
   const promise = readOriginalPage(sid, { ...options, commandOverride: process.execPath, args: [script] }, originalSource); promises.push(promise); return promise
  })
  const current = await readOriginalPage(sid, { limit: 30, commandOverride: process.execPath, args: [script] })
  expect(current.source).toEqual({ providerId: 'codex', nativeSessionId: native }); expect(current.nextCursor).not.toBeNull()
  await render(<ActivityView sessionId={sid} capability="complete-events" nativeHistoryPage={current}
   conversationReading={{ reference: control, identity: control.run.runId, enabled: true }} />)
  await wheel(); expect(ids()).toEqual(Array.from({ length: 120 }, (_, n) => `indexed-${n}`))
  const ended = requests.length; await wheel(); expect(ids()).toHaveLength(120); expect(requests).toHaveLength(ended)
  const count = requests.length; await wheel(); expect(requests).toHaveLength(count)
  const actual = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(request => request.method === 'thread/items/list')
  expect(actual.map(request => request.params)).toEqual([{ threadId: native, sortDirection: 'desc', limit: 30 }, { threadId: native, sortDirection: 'desc', limit: 100 }, { threadId: native, sortDirection: 'desc', limit: 100, cursor: '20' }])
 })
 it('continues beyond 290 records and a 201-process burst without losing raw pages or moving shared recent facts', async () => {
  await render(compose())
  const seedReads = requests.length, cursor = acceptedWindow().navigation.older
  const publicReads = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  const recentOriginalIds = () => [...recent!.conversation.snapshot!.units].reverse().flatMap(unit =>
   unit.records.flatMap(record => record.reference?.source.kind === 'native' ? [record.reference.source.recordId] : []))
  expect(recent!.conversation.snapshot).not.toBeNull()
  const currentIds = recentOriginalIds(), currentCompleteIds = recent!.nativeHistoryPage!.items.map(item => item.id)
  expect(currentIds.length).toBeGreaterThan(0); expect(currentIds.at(-1)).toBe('record-359')
  expect(currentCompleteIds.length).toBeGreaterThan(0)
  await click('Earlier')
  expect(ids()).toEqual(Array.from({ length: 360 }, (_, n) => `record-${String(n).padStart(3, '0')}`))
  expect(new Set(ids()).size).toBe(360)
  expect(recentOriginalIds()).toEqual(currentIds)
  expect(recent!.nativeHistoryPage!.items.map(item => item.id)).toEqual(currentCompleteIds)
  expect(container.querySelectorAll('.activity-feed')).toHaveLength(1)
  expect(container.querySelector('.activity-feed__history-divider')?.textContent).toContain('以上是历史消息')
  expect(requests.slice(seedReads)).toHaveLength(1)
  expect(requests[seedReads]!.limit).toBe(100)
  expect(vi.mocked(api.conversation.readAgentConversation).mock.calls[publicReads]?.[0].cursor).toBe(cursor)
 })
 it('allows explicit deep-window latest navigation without a Range, while original records retain their source identity', async () => {
  await writeEdgeHistory(2400)
  await render(compose()); for (let n = 0; n < 12; n++) await click('Earlier')
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!
  viewport.getBoundingClientRect = () => rect(0, 200)
  const group = viewport.querySelector<HTMLElement>('[data-conversation-process-members]')!
  group.getBoundingClientRect = () => rect(10, 40)
  group.querySelector<HTMLElement>('.wf-head')!.getBoundingClientRect = () => rect(10)
  expect(conversationReadingAnchor(viewport)?.kind).toBe('group')
  await click('滚动到最新')
  expect(ids().at(-1)).toBe('record-2399')
  expect(container.querySelector('[data-conversation-reading]')?.getAttribute('data-conversation-reading')).toBe('current')
 })
 it('keeps current native and captured contributions separate from an older bounded window while both remain durably reachable', async () => {
  await writeFile(transcript, Array.from({ length: 2400 }, (_, n) => JSON.stringify(record(n))).join('\n') + '\n')
  const at = Date.parse(record(2350).timestamp)
  const item: AgentTimelineItem = { id: 'accepted-independent-input', agentSessionId: sid,
   kind: 'user_message', source: 'user', sourceChannel: 'message-tool', title: 'Accepted input', status: 'complete', content: 'Independent Message Tool input', createdAt: at, updatedAt: at }
  await publishCaptured([item])
  const Reader = () => { const facts = useSessionUserMessages(control, { enabled: true }); recent = facts
   return <ActivityView sessionId={sid} nativeHistoryPage={facts.nativeHistoryPage} nativeContextItems={facts.nativeContextItems} capability="complete-events"
    conversationReading={{ reference: control, identity: control.run.runId, enabled: true }} /> }
  await render(<Reader />)
  const showSubmission = async () => {
   const submission = container.querySelector<HTMLElement>('[data-submission-id="accepted-independent-input"]')!
   expect(submission).not.toBeNull()
   const details = submission.querySelector<HTMLDetailsElement>('.message-disclosure')!
   await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
   expect(submission.querySelector('.log-turn__body')?.textContent).toContain(item.content)
  }
  await showSubmission()
  expect(container.textContent).toContain('Input 2392'); for (let batch = 0; batch < 12; batch++) await click('Earlier')
  expect(ids()).not.toContain('record-2392'); expect(container.textContent).not.toContain('Input 2392')
  expect(container.querySelector('[data-submission-id="accepted-independent-input"]')).toBeNull()
  expect((await client.sessionTimeline(sid)).items.find(original => original.id === item.id)).toEqual(item)
  expect(recent!.messages.find(message => message.rawId === 'record-2392')?.content).toContain('Input 2392')
  await click('滚动到最新'); expect(container.textContent).toContain('Input 2392'); await showSubmission()
 })
 it('protects the real visible current anchor on the very first Earlier entry without advancing past an unread page', async () => {
  const latest = await readOriginalPage(sid, { limit: 100 })
  const older = await readOriginalPage(sid, { limit: 100, cursor: latest.nextCursor! })
  const current = { ...latest, items: [...older.items, ...latest.items], nextCursor: older.nextCursor }
  await render(<ActivityView sessionId={sid} capability="complete-events" nativeHistoryPage={current}
   conversationReading={{ reference: control, identity: control.run.runId, enabled: true }} />)
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!, before = ids()
  const first = viewport.querySelector<HTMLElement>('[data-conversation-process-members] .wf-head')!
  expect(before).toHaveLength(300); expect(before.includes('record-359')).toBe(true)
  viewport.getBoundingClientRect = () => rect(0, 200); first.getBoundingClientRect = () => rect(10)
  await click('Earlier')
  expect(ids()).toHaveLength(360); expect(ids()[0]).toBe('record-000')
  expect(first.isConnected).toBe(true)
  expect(requests[3]!.cursor).toBe((await promises[2]!).nextCursor)
  expect(requests).toHaveLength(4)

 })
 it('keeps a real visible raw anchor when Earlier would remove it, then presents that same page after deliberate reading', async () => {
  await writeFile(transcript, Array.from({ length: 2400 }, (_, n) => JSON.stringify(record(n))).join('\n') + '\n')
  await render(compose()); for (let batch = 0; batch < 9; batch++) await click('Earlier')
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!, original = ids()
  const tail = viewport.querySelector<HTMLElement>('[data-native-record-id="record-2353"]')!
  expect(original).toHaveLength(1200); expect(original[0]).toBe('record-1200')
  markerGeometry(viewport); viewport.getBoundingClientRect = () => rect(0, 200); tail.getBoundingClientRect = () => rect(10)
  const cursor = acceptedWindow().navigation.older, reads = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  await click('Earlier'); expect(ids()).toEqual(original); expect(tail.isConnected).toBe(true)
  expect(inspectConversationConsumers(control).consumers[0]?.held).toBe(true)
  expect(vi.mocked(api.conversation.readAgentConversation).mock.calls[reads]?.[0].cursor).toBe(cursor)
  const retained = viewport.querySelector<HTMLElement>('[data-native-record-id="record-1601"]')!
  tail.getBoundingClientRect = () => rect(-200); retained.getBoundingClientRect = () => rect(10)
  const resumed = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  await scrollTo(viewport, 10); await flush()
  expect(ids()).toHaveLength(1200); expect(ids()[0]).toBe('record-1100'); expect(ids().at(-1)).toBe('record-2299')
  expect(retained.isConnected).toBe(true); expect(tail.isConnected).toBe(false)
  expect(vi.mocked(api.conversation.readAgentConversation)).toHaveBeenCalledTimes(resumed)
 })
 it('keeps selected Workflow record-count text and the actual cursor until selection clears, then presents the earlier frame', async () => {
  await writeFile(transcript, Array.from({ length: 1260 }, (_, n) => JSON.stringify(record(n))).join('\n') + '\n')
  await render(compose()); await click('Earlier')
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!, head = viewport.querySelector<HTMLElement>('[data-conversation-process-members] .wf-head')!
  const count = head.querySelector<HTMLElement>('.log-fold__steps')!
  expect(count.textContent).toBe('4 条已加载记录')
  const range = document.createRange(); range.setStart(count.firstChild!, 0); range.setEnd(count.firstChild!, 1)
  window.getSelection()!.addRange(range)
  const before = ids(), cursor = acceptedWindow().navigation.older, reads = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  expect(before).toHaveLength(400); expect(before[0]).toBe('record-860')
  await click('Earlier')
  expect(ids()).toEqual(before); expect(head.isConnected).toBe(true); expect(range.startContainer.isConnected).toBe(true)
  expect(window.getSelection()!.getRangeAt(0)).toBe(range); expect(range.toString()).toBe('4')
  expect(inspectConversationConsumers(control).consumers[0]?.held).toBe(true)
  expect(vi.mocked(api.conversation.readAgentConversation).mock.calls[reads]?.[0].cursor).toBe(cursor)
  const resumed = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  await act(async () => { window.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) }); await flush()
  expect(ids()[0]).toBe('record-760'); expect(ids()).toHaveLength(500); expect(head.isConnected).toBe(true)
  expect(count.textContent).toBe('6 条已加载记录')
  expect(vi.mocked(api.conversation.readAgentConversation)).toHaveBeenCalledTimes(resumed)
 })
 it('uses the public native source namespace, not a repeated raw ID, to protect a selected node through explicit source refresh', async () => {
  await render(<ActivityView sessionId={sid} capability="complete-events"
   conversationReading={{ reference: control, identity: control.run.runId, enabled: true, opened: true }} />)
  const node = container.querySelector<HTMLElement>('[data-native-record-id="record-353"] .log-turn__body')!
  const text = [...node.querySelectorAll('p')].find(p => p.textContent === 'Reply 353')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 5); window.getSelection()!.addRange(range)
  const nextNative = 'public-new-source-same-raw-ids', nextTranscript = join(home, 'new-source.jsonl')
  await writeFile(nextTranscript, Array.from({ length: 360 }, (_, n) => JSON.stringify({ ...record(n), sessionId: nextNative })).join('\n') + '\n')
  const next = { ...stored, updatedAt: 2, nativeHandle: { kind: 'provider' as const, providerId: 'claude', sessionId: nextNative, transcriptPath: nextTranscript } }
  await store.compareAndSwap(stored, next); stored = next; originalStore = await store.loadMetadata()
  const actualNewPage = await readOriginalPage(sid)
  expect(actualNewPage.source.nativeSessionId).toBe(nextNative); expect(actualNewPage.items.at(-1)!.id).toBe('record-359')
  await act(async () => observation?.({ agentSessionId: sid, source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated' })); await flush()
  await click('读取当前记录')
  expect(node.isConnected).toBe(true); expect(window.getSelection()!.toString()).toBe('Reply')
  expect(container.querySelector('[data-native-source]')?.getAttribute('data-native-source')).toBe(JSON.stringify(['claude', native]))
  await act(async () => { window.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) }); await flush()
  expect(node.isConnected).toBe(false)
  expect(container.querySelector('[data-native-source]')?.getAttribute('data-native-source')).toBe(JSON.stringify(['claude', nextNative]))
 })
 it('keeps selected overlap bodies and trace disclosures through prepend and observation append', async () => {
  await writeFile(transcript, Array.from({ length: 2400 }, (_, n) => JSON.stringify(record(n))).join('\n') + '\n')
  await render(compose()); await click('Earlier')
  const body = container.querySelector<HTMLElement>('[data-native-record-id="record-2361"] .log-turn__body')!
  expect(body.textContent).toContain('Reply 2361')
  const text = [...body.querySelectorAll('p')].find(p => p.textContent === 'Reply 2361')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 5); window.getSelection()!.addRange(range)
  const trace = body.querySelector<HTMLDetailsElement>('[data-trace-kind="reasoning"]')!
  await act(async () => { trace.open = true; trace.dispatchEvent(new Event('toggle')) })
  expect(trace.textContent).toContain('Trace 2361')
  for (let batch = 0; batch < 8; batch++) await click('Earlier')
  expect(ids()).toHaveLength(1200); expect(body.isConnected).toBe(true)
  expect(body.querySelector('[data-trace-kind="reasoning"]')).toBe(trace); expect(trace.open).toBe(true)
  const cursor = acceptedWindow().navigation.older, reads = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  await click('Earlier')
  expect(vi.mocked(api.conversation.readAgentConversation).mock.calls[reads]?.[0].cursor).toBe(cursor)
  expect(inspectConversationConsumers(control).consumers[0]?.held).toBe(true)
  expect(body.isConnected).toBe(true); expect(window.getSelection()!.getRangeAt(0)).toBe(range)
  await appendFile(transcript, JSON.stringify(record(2400)) + '\n')
  await act(async () => observation?.({ source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated', agentSessionId: sid })); await flush()
  expect(ids()).toContain('record-2361'); expect(window.getSelection()!.toString()).toBe('Reply'); expect(trace.open).toBe(true)
  const resumed = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  await act(async () => { window.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) }); await flush()
  expect(ids()).toHaveLength(1200); expect(ids()[0]).toBe('record-1100'); expect(ids().at(-1)).toBe('record-2299')
  expect(vi.mocked(api.conversation.readAgentConversation)).toHaveBeenCalledTimes(resumed)
 })
 it('does not start a hidden read or commit a hidden late page, while another visible recent consumer remains usable', async () => {
  await writeFile(transcript, Array.from({ length: 1200 }, (_, n) => JSON.stringify(record(n))).join('\n') + '\n')
  await render(compose()); await click('Earlier')
  const before = ids(), cursor = acceptedWindow().navigation.older!, original = vi.mocked(api.conversation.readAgentConversation).getMockImplementation()!
  let release: (() => void) | undefined
  vi.mocked(api.conversation.readAgentConversation).mockImplementation(async (...args) => {
   const page = await original(...args)
   if (args[0].cursor === cursor && !release) return new Promise(resolve => { release = () => resolve(page) })
   return page
  })
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Earlier')!
  const start = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  await act(async () => button.click())
  await vi.waitFor(async () => { await act(async () => { await Promise.resolve() }); expect(release).toBeTypeOf('function') })
  const pending = vi.mocked(api.conversation.readAgentConversation).mock.calls[start]!
  expect(pending[0].cursor).toBe(cursor); expect(button.querySelector('[role="status"]')?.textContent).toBe('Loading earlier…')
  await render(compose(false)); expect(pending[1]?.signal?.aborted).toBe(true)
  await act(async () => release!()); await flush()
  expect(ids()).toEqual(before)
  const reads = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  expect(button.disabled).toBe(true); await act(async () => button.click()); await flush()
  expect(vi.mocked(api.conversation.readAgentConversation)).toHaveBeenCalledTimes(reads)
  expect(recent!.messages.length).toBeGreaterThan(0)
 })
 it('keeps a legitimate290-raw recent page through initial300 and original older100-page reading with the original body and Range', async () => {
  await writeFile(transcript, Array.from({ length: 380 }, (_, n) => JSON.stringify(n >= 90 && n < 290
   ? { ...record(n), type: 'user', message: { role: 'user', content: `Original maximum input ${n}` } }
   : { ...record(n), type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: `Original maximum process ${n}` }] } })).join('\n') + '\n')
  const tail = await readOriginalPage(sid, { limit: 100 })
  const middle = await readOriginalPage(sid, { limit: 100, cursor: tail.nextCursor! })
  const front = await readOriginalPage(sid, { limit: 90, cursor: middle.nextCursor! })
  const current = { ...front, items: [...front.items, ...middle.items, ...tail.items] }
  expect(current.items).toHaveLength(290)
  expect(current.items.filter(item => item.kind === 'activity')).toHaveLength(90)
  expect(current.items.filter(item => item.kind === 'user-message')).toHaveLength(200)
  await render(<ActivityView sessionId={sid} capability="complete-events" nativeHistoryPage={current}
   conversationReading={{ reference: control, identity: control.run.runId, enabled: true }} />)
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!, row = viewport.querySelector<HTMLElement>('[data-native-record-id="record-289"]')!
  const body = row.querySelector<HTMLElement>('.log-turn__body')!, paragraph = body.querySelector('p')!
  viewport.getBoundingClientRect = () => rect(0, 200); row.getBoundingClientRect = () => rect(10)
  const range = document.createRange(); range.selectNodeContents(paragraph); window.getSelection()!.addRange(range)
  expect(container.querySelector('.activity-feed__reading button')?.textContent?.trim()).toBe('Earlier')
  expect([...container.querySelectorAll('button')].filter(button => ['Earlier', 'Read earlier records'].includes(button.textContent?.trim() ?? ''))).toHaveLength(1)
  await click('Earlier')
  expect(ids()).toEqual(Array.from({ length: 380 }, (_, n) => `record-${String(n).padStart(3, '0')}`))
  expect(requests).toHaveLength(4); expect(requests.every(read => read.limit === 100)).toBe(true)
  expect(requests[0]!.cursor).toBeUndefined()
  expect(requests[1]!.cursor).toBe((await promises[0]!).nextCursor)
  expect(requests[2]!.cursor).toBe((await promises[1]!).nextCursor); expect(requests[3]!.cursor).toBe((await promises[2]!).nextCursor)
  if (process.env.AGENTMUX_EARLIER_SCENE_PAGE) await writeFile(process.env.AGENTMUX_EARLIER_SCENE_PAGE, JSON.stringify({ provenance: 'Controlled native Claude syntax -> real FileStore/public Core SDK pages; no vendor writer or installed user session', current, earlierPages: await Promise.all(promises), requests }, null, 2) + '\n')
  expect(body.isConnected).toBe(true); expect(row.querySelector('.log-turn__body')).toBe(body)
  expect(window.getSelection()!.getRangeAt(0)).toBe(range); expect(window.getSelection()!.toString()).toBe('Original maximum input 289')
  expect(conversationReadingAnchor(viewport)).toEqual({ kind: 'record', id: 'record-289', offset: 10 })
  expect(container.querySelector('.conversation-ruler__unread-edge')).toBeNull()
 })
 it('shows actual inline earlier loading without a second demand, keeps the old cursor on page2 failure and explicitly retries', async () => {
  await writeEdgeHistory(1200)
  await render(compose()); const before = ids(), oldBody = container.querySelector('[data-native-record-id="record-1193"] .log-turn__body')!, page = await promises[requests.map((request, index) => request.limit === 100 ? index : -1).reduce((last, index) => Math.max(last, index), -1)]!, start = requests.length
  growingEarlierReserve(container.querySelector<HTMLElement>('.activity-feed')!)
  const countText = container.querySelector('.activity-ruler__count')!.textContent
  expect(countText).toMatch(/^\d+ records$/)
  const earlier = container.querySelector<HTMLButtonElement>('.activity-feed__reading button')!, slider = container.querySelector<HTMLElement>('[role="slider"]')!
  expect(container.querySelector('.conversation-ruler__unread-edge')).not.toBeNull()
  const reads = requests.length
  await act(async () => { earlier.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); slider.focus(); slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
  expect(requests).toHaveLength(reads); expect(container.querySelector('.activity-ruler__readout')).not.toBeNull()
  let release!: (page: AgentSessionHistoryPage) => void
  const pending = new Promise<AgentSessionHistoryPage>(resolve => { release = resolve })
  nativePage.mockImplementationOnce((_reference, options) => { requests.push(options ?? {}); return pending })
   .mockImplementationOnce(async (_reference, options) => { requests.push(options ?? {}); throw new Error('Original second page unavailable') })
  await act(async () => { earlier.focus(); container.querySelector('.activity-feed')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 })) })
  expect(container.querySelector('.activity-ruler__readout')).toBeNull()
  const status = earlier.querySelector<HTMLElement>('[role="status"]')!
  expect(status).not.toBeNull(); expect(status.getAttribute('role')).toBe('status'); expect(status.getAttribute('aria-live')).toBe('polite')
  expect(status.textContent).toBe('Loading earlier…'); expect(earlier.querySelector('svg[data-semantic-icon="status.loading"]')).not.toBeNull()
  expect(container.querySelector('.activity-feed')?.hasAttribute('aria-busy')).toBe(false)
  expect(status.closest('.activity-feed__loading-layer')).toBeNull()
  expect(status.closest('.activity-feed__reading')).not.toBeNull()
  expect(container.querySelector('.activity-ruler__count')!.textContent).toBe(countText)
  expect(container.querySelector('.activity-ruler__count [role="status"], .activity-ruler__count svg')).toBeNull()
  expect(container.querySelector('.conversation-ruler__earlier')).toBeNull()

  expect(earlier.isConnected).toBe(true); expect(earlier.disabled).toBe(true); expect(slider.getAttribute('aria-disabled')).toBeNull(); expect(oldBody.isConnected).toBe(true)
  await act(async () => { earlier.click(); container.querySelector('.activity-feed')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 })) })
  await vi.waitFor(() => expect(requests).toHaveLength(start + 1))
  expect(requests).toHaveLength(start + 1)
  await act(async () => release(await readOriginalPage(sid, { limit: 100, cursor: page.nextCursor! }))); await flush()
  expect(ids()).toEqual(Array.from({ length: 200 }, (_, n) => `record-${1000 + n}`)); expect(requests).toHaveLength(start + 2); expect(oldBody.isConnected).toBe(true)
  expect(container.querySelector('.activity-ruler__count[data-loading]')).toBeNull(); expect(container.textContent).toContain('Original second page unavailable')
  const failedCursor = requests[start + 1]!.cursor, retryStart = requests.length; await click('Retry reading')
  expect(requests[retryStart]!.cursor).toBe(failedCursor); expect(requests).toHaveLength(retryStart + 1); expect(ids()).toHaveLength(before.length + 200)
 })
 it('keeps unknown and reversed native times honest while the unread edge and overview never issue reads', async () => {
  // Keep an actual unread page beyond the default 24h coverage, while times remain reversed and partly unknown.
  await writeFile(transcript, Array.from({ length: 390 }, (_, n) => {
   const original = { ...record(n), type: 'user', timestamp: new Date(_hygiene_fixtureTime(-37225600000) + (390 - n) * 6 * 60_000).toISOString(), message: { role: 'user', content: `Original reverse record ${n}` } }
   if (n % 3 === 0) Reflect.deleteProperty(original, 'timestamp')
   return JSON.stringify(original)
  }).join('\n') + '\n')
  const current = await readOriginalPage(sid, { limit: 30 })
  await render(<ActivityView sessionId={sid} capability="complete-events" nativeHistoryPage={current}
   conversationReading={{ reference: control, identity: control.run.runId, enabled: true }} />)
  const before = ids(), reads = requests.length, edge = container.querySelector('.conversation-ruler__unread-edge')!
  expect(edge).not.toBeNull(); expect(edge.getAttribute('style')).toBeNull(); expect(edge.getAttribute('aria-hidden')).toBe('true')
  expect(container.querySelector('.conversation-ruler__unread-edge')?.getAttribute('style')).toBeNull()
  const overview = container.querySelector<HTMLButtonElement>('button[aria-label^="History window:"]')!
  expect(overview).not.toBeNull(); await act(async () => overview.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })))
  const sameRange = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(item => item.textContent === '24h reading window')
  expect(sameRange).toBeDefined(); await act(async () => sameRange!.click())
  const slider = container.querySelector<HTMLElement>('[role="slider"]')!
  await act(async () => { slider.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 20 })); slider.focus(); slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })
  expect(ids()).toEqual(before); expect(requests).toHaveLength(reads)
  expect(container.textContent).toContain('Original reverse record 300'); expect(container.textContent).toContain('Original reverse record 389')
  expect(container.querySelectorAll('[role="slider"]')).toHaveLength(1)
 })
 it('leaves no empty history toolbar when the actual current source is exhausted and has no reading actions', async () => {
  await writeFile(transcript, [record(352), record(353)].map(row => JSON.stringify(row)).join('\n') + '\n')
  await render(compose())
  expect(ids()).toEqual(['record-352', 'record-353'])
  expect(container.querySelector('.activity-feed__reading')).toBeNull()
  expect(container.querySelector('.activity-feed__reading-status')).toBeNull()
  expect(container.querySelector('.activity-ruler__count')!.textContent).toBe('2 records')
  expect(requests).toHaveLength(3) // The Activity and two input-summary consumers each own one current source cut.
 })
 it('keeps a no-record first read visible in the public loading surface without an invented zero-count slider', async () => {
  let release!: (page: AgentSessionHistoryPage) => void
  const pending = new Promise<AgentSessionHistoryPage>(resolve => { release = resolve })
  nativePage.mockImplementationOnce((_reference, options) => { requests.push(options ?? {}); return pending })
  await act(async () => root.render(<ActivityView sessionId={sid} capability="complete-events"
   conversationReading={{ reference: control, identity: control.run.runId, enabled: true, opened: true }} />))
  expect(container.querySelector('[role="slider"]')).toBeNull()
  const status = container.querySelector('.activity-feed__empty-reading')!
  expect(status.textContent).toContain('Reading conversation…'); expect(status.querySelector('.full-page-loading__light')).not.toBeNull()
  expect(status.getAttribute('role')).toBe('status'); expect(status.getAttribute('aria-live')).toBe('polite')
  expect(container.querySelector('.activity-feed__loading-layer')).toBeNull()
  expect(container.textContent).not.toContain('No structured activity yet'); expect(container.textContent).not.toContain('No inputs in the recent conversation window')
  await vi.waitFor(() => expect(requests).toHaveLength(1)); expect(requests[0]).toMatchObject({ limit: 100 }); expect(requests[0]!.cursor).toBeUndefined()
  await act(async () => release(await readOriginalPage(sid, { limit: 100 }))); await flush()
  expect(ids()).toHaveLength(300); expect(requests).toHaveLength(3)
  expect(container.querySelector('[role="slider"]')).not.toBeNull(); expect(container.querySelector('.activity-feed__empty-reading')).toBeNull()
 })
 it('keeps current loading in one retained ruler slot, while Earlier owns its original inline status', async () => {
  await render(compose(true, true))
  const slot = container.querySelector<HTMLElement>('.activity-ruler__pending')!, count = container.querySelector<HTMLElement>('.activity-ruler__count')!
  expect(slot).not.toBeNull(); expect(slot.textContent).toBe(''); expect(slot.getAttribute('role')).toBeNull()
  const body = container.querySelector<HTMLElement>('[data-native-record-id="record-353"] .log-turn__body')!, text = body.querySelector('p')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 5); window.getSelection()!.addRange(range)
  const originalCount = count.textContent, view = acceptedWindow().view, changes = vi.mocked(api.conversation.readConversationChanges).getMockImplementation()!
  let releaseChanges: (() => Promise<void>) | undefined
  vi.mocked(api.conversation.readConversationChanges).mockImplementation((...args) => args[0].view === view && !releaseChanges
   ? new Promise(resolve => { releaseChanges = async () => resolve(await changes(...args)) }) : changes(...args))
  const retained = () => { expect(body.isConnected).toBe(true); expect(window.getSelection()!.getRangeAt(0)).toBe(range); expect(range.toString()).toBe('Reply') }
  await appendFile(transcript, JSON.stringify(record(360)) + '\n')
  await act(async () => observation?.({ agentSessionId: sid, source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated' }))
  await vi.waitFor(async () => { await act(async () => { await Promise.resolve() }); expect(releaseChanges).toBeTypeOf('function') })
  expect(slot.getAttribute('role')).toBe('status'); expect(slot.getAttribute('aria-live')).toBe('polite'); expect(slot.textContent).toBe('Reading records…')
  expect(slot.querySelector('svg[data-semantic-icon="status.loading"]')).not.toBeNull()
  expect(container.querySelectorAll('.activity-ruler__pending[role="status"]')).toHaveLength(1)
  expect(count.textContent).toBe(originalCount); expect(count.querySelector('svg, [role="status"]')).toBeNull()
  expect(container.querySelector('.activity-feed__loading-layer, .activity-feed__empty-reading')).toBeNull(); retained()
  await act(async () => releaseChanges!()); await flush()
  expect(ids().at(-1)).toBe('record-360'); retained(); expect(container.querySelector('.activity-ruler__pending')).toBe(slot)
  expect(slot.textContent).toBe(''); expect(slot.getAttribute('role')).toBeNull()
  const cursor = acceptedWindow().navigation.older, original = vi.mocked(api.conversation.readAgentConversation).getMockImplementation()!
  let releaseEarlier: (() => Promise<void>) | undefined
  vi.mocked(api.conversation.readAgentConversation).mockImplementation((...args) => args[0].cursor === cursor
   ? new Promise(resolve => { releaseEarlier = async () => resolve(await original(...args)) }) : original(...args))
  const earlier = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Earlier')!
  await act(async () => earlier.click())
  await vi.waitFor(async () => { await act(async () => { await Promise.resolve() }); expect(releaseEarlier).toBeTypeOf('function') })
  const reads = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  expect(earlier.getAttribute('aria-busy')).toBe('true'); expect(earlier.querySelector('[role="status"]')?.textContent).toBe('Loading earlier…')
  expect(slot.getAttribute('role')).toBeNull(); expect(slot.textContent).toBe(''); expect(slot.querySelector('svg')).toBeNull()
  expect(container.querySelector('.activity-feed__loading-layer, .activity-feed__empty-reading')).toBeNull(); retained()
  await act(async () => { earlier.click(); container.querySelector('.activity-feed')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 })) })
  expect(vi.mocked(api.conversation.readAgentConversation)).toHaveBeenCalledTimes(reads)
  await act(async () => releaseEarlier!()); await flush()
  expect(ids()).toHaveLength(361); expect(ids()[0]).toBe('record-000'); retained()
  expect(slot.getAttribute('role')).toBeNull(); expect(slot.textContent).toBe(''); expect(earlier.isConnected).toBe(false)
  expect(container.querySelector('.activity-feed__reading [aria-busy="true"]')).toBeNull()
 })
 it('keeps local-only pending and a genuine first read failure honest until explicit Retry returns an actual empty source', async () => {
  let reject!: (error: Error) => void
  nativePage.mockImplementationOnce((_reference, options) => { requests.push(options ?? {}); return new Promise((_resolve, failure) => { reject = failure }) })
  await act(async () => root.render(<ActivityView sessionId={sid} capability="complete-events"
   conversationReading={{ reference: control, identity: control.run.runId, enabled: true, opened: true }} />))
  expect(container.querySelector('.activity-feed__empty-reading[role="status"]')).not.toBeNull()
  expect(container.querySelector('[role="slider"]')).toBeNull(); await vi.waitFor(() => expect(requests).toHaveLength(1)); expect(requests[0]).toMatchObject({ limit: 100 }); expect(requests[0]!.cursor).toBeUndefined()
  expect(container.textContent).not.toContain('No structured activity yet'); expect(container.textContent).not.toContain('No inputs in the recent conversation window')
  await act(async () => reject(new Error('Original first conversation read unavailable'))); await flush()
  expect(container.querySelector('.activity-feed__empty-reading')?.getAttribute('data-loading-phase')).toBe('failed'); expect(container.textContent).toContain('Original first conversation read unavailable')
  expect(container.textContent).not.toContain('No structured activity yet'); expect(container.textContent).not.toContain('No inputs in the recent conversation window')
  expect(container.querySelector('[role="slider"]')).toBeNull(); expect(requests).toHaveLength(1)
  await writeFile(transcript, ''); await click('Retry reading')
  expect(requests).toHaveLength(2); expect(requests.every(request => request.limit === 100 && request.cursor === undefined)).toBe(true); expect(container.querySelector('[role="slider"]')).toBeNull()
  expect(container.querySelector('.activity-feed__empty-reading')).toBeNull(); expect(container.textContent).not.toContain('Original first conversation read unavailable')
  expect(container.textContent).toContain('No structured activity yet. Terminal remains available.')
 })
 it('keeps a selected folded Process title before explicit latest would evict the group', async () => {
  await writeEdgeHistory(2400)
  await render(compose()); for (let batch = 0; batch < 12; batch++) await click('Earlier')
  const group = container.querySelector<HTMLElement>('[data-conversation-process-members]')!
  const label = group.querySelector<HTMLElement>('.wf-head .wf-observation__recorded')!
  expect(label.textContent).toBe('执行过程')
  const range = document.createRange(); range.selectNodeContents(label); window.getSelection()!.addRange(range)
  const before = ids(); await click('滚动到最新')
  expect(ids()).toEqual(before); expect(group.isConnected).toBe(true); expect(window.getSelection()!.getRangeAt(0)).toBe(range)
  expect(inspectConversationConsumers(control).consumers[0]?.held).toBe(true)
  const reads = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  await act(async () => { window.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) }); await flush()
  expect(ids().at(-1)).toBe('record-2399'); expect(group.isConnected).toBe(false)
  expect(vi.mocked(api.conversation.readAgentConversation)).toHaveBeenCalledTimes(reads)
 })
 it('restores a retained folded group using its observation identity when prepend changes its raw-member list', async () => {
  await render(compose()); await click('Earlier')
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!, group = viewport.querySelector<HTMLElement>('[data-conversation-process-members]')!
  viewport.getBoundingClientRect = () => rect(100, 200)
  const head = group.querySelector<HTMLElement>('.wf-head')!; group.getBoundingClientRect = () => rect(110, 40); head.getBoundingClientRect = () => rect(110)
  const anchor = conversationReadingAnchor(viewport)!; expect(anchor.kind).toBe('group')
  group.dataset.conversationProcessMembers = JSON.stringify([{ id: 'new-member', sources: [] }, ...JSON.parse(group.dataset.conversationProcessMembers!)])
  group.getBoundingClientRect = () => rect(140, 40); head.getBoundingClientRect = () => rect(140)
  viewport.scrollTop = 200; restoreConversationAnchor(viewport, anchor)
  expect(viewport.scrollTop).toBe(230)
 })
})

function liveSession(): Extract<SessionSnapshot, { kind: 'agent' }> {
 return { id: sid, kind: 'agent', hostId: 'local', workspacePath: stored.workspacePath, label: 'Original Agent', providerId: 'claude', executorId: 'claude',
  agentSessionUpdatedAt: 1, promptSubmissionPredecessor: null, createdAt: 1, updatedAt: 1, processState: 'running',
  status: { state: 'running', source: 'run-process', observedAt: 1 }, latestOutputBytes: 0,
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' }, control }
}
async function seed(mode: 'activity' | 'terminal' = 'activity') {
 useAppStore.setState({ config: { ...config, workspaces: [{ id: 'ws', name: 'Private project', hostId: 'local', path: stored.workspacePath, kind: 'folder' }] }, sessions: [liveSession()],
  pendingAgentLaunches: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [], viewModes: { [sid]: mode },
  timelines: { [sid]: await client.sessionTimeline(sid) }, agentNames: {}, agentComposerDrafts: { [sid]: 'ORIGINAL UNSENT DRAFT' }, agentSteerQueues: {} })
}
function pane(visible = true) {
 return <SessionPane sessionId={sid} surfaceKind="agent" interactiveResize={false} visible={visible}
  linkOrigin={{ workspaceId: 'ws', tabGroupId: 'group', tabId: 'tab', regionId: 'region' }} />
}
async function retired() {
 const reservation = { kind: 'stop' as const, reservationId: 'controlled-retire', ownerId: 'private-fixture', ownerPid: process.pid,
  agentSessionId: sid, operationId: 'retire', expiresAt: Date.now() + 60000, expectedRun: control.run,
  stopOperation: { daemonInstance: 'private-not-connected', operationKey: 'retire', runId: control.run.runId } }
 await store.reserveLifecycle(reservation); await store.commitLifecycle(reservation, null)
 originalStore = await store.loadMetadata()
}

describe('Real caller ownership and healthy retained identities', () => {
 it('opens from Terminal in the same Activity, returns by body Escape and preserves original Terminal and draft', async () => {
  await seed('terminal'); await render(pane())
  const terminal = container.querySelector('[data-terminal-visible]')!
  expect(terminal.getAttribute('data-terminal-visible')).toBe('true'); expect(container.querySelector('.activity-feed')).toBeNull()
  await click('Header history')
  const feed = container.querySelector<HTMLElement>('.activity-feed')!
  expect(feed).not.toBeNull(); expect(ids()).toHaveLength(300)
  expect(feed.closest('.agent-body')?.getAttribute('data-observation-surface')).toBe('workflow')
  expect(terminal.isConnected).toBe(true); expect(terminal.getAttribute('data-terminal-visible')).toBe('false')
  const bodyControl = container.querySelector<HTMLElement>('[data-native-record-id="record-353"] button')!
  expect(bodyControl).not.toBeNull()
  await act(async () => { bodyControl.focus(); bodyControl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  await flush()
  expect(feed.isConnected).toBe(true); expect(feed.closest('[hidden]')).not.toBeNull()
  expect(terminal.getAttribute('data-terminal-visible')).toBe('true')
  expect(feed.closest('.agent-body')?.hasAttribute('data-observation-surface')).toBe(false)
  expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('ORIGINAL UNSENT DRAFT')
  expect(useAppStore.getState().sessions[0]!.control).toEqual(control)
  expect(container.querySelectorAll('.activity-feed')).toHaveLength(1)
 })
 it('preserves a later deliberate focus inside the retained Activity after Return rather than reclaiming it for Header', async () => {
  await seed(); await render(pane()); await click('Header history')
  const returnButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Return')!
  const bodyControl = container.querySelector<HTMLButtonElement>('[data-native-record-id="record-353"] button')!
  expect(bodyControl).not.toBeNull(); expect(bodyControl.isConnected).toBe(true)
  const frames: FrameRequestCallback[] = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length })
  await act(async () => { returnButton.focus(); returnButton.click() })
  expect(frames.length).toBeGreaterThan(0)
  bodyControl.focus(); expect(document.activeElement).toBe(bodyControl)
  await act(async () => { for (const frame of frames) frame(performance.now()) })
  expect(document.activeElement).toBe(bodyControl)
  expect(bodyControl.isConnected).toBe(true)
  expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('ORIGINAL UNSENT DRAFT')
 })
 it('keeps original bodies and expanded trace across Header entry, hidden cache and return to the same Activity', async () => {
  await seed(); await render(pane())
  const body = container.querySelector<HTMLElement>('[data-native-record-id="record-353"] .log-turn__body')!
  const trace = body.querySelector<HTMLDetailsElement>('[data-trace-kind="reasoning"]')!
  await act(async () => { trace.open = true; trace.dispatchEvent(new Event('toggle')) })
  const text = [...body.querySelectorAll('p')].find(p => p.textContent === 'Reply 353')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 5); window.getSelection()!.addRange(range)
  const feed = container.querySelector('.activity-feed')!
  await click('Header history')
  expect(container.querySelector('.activity-feed')).toBe(feed); expect(body.isConnected).toBe(true); expect(trace.open).toBe(true)
  expect(window.getSelection()!.toString()).toBe('Reply')
  await render(pane(false))
  const before = requests.length
  const hiddenEarlier = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Earlier')!
  expect(hiddenEarlier.disabled).toBe(true)
  await act(async () => hiddenEarlier.click()); await flush() // Native disabled control cannot demand a page.
  expect(requests).toHaveLength(before); expect(body.isConnected).toBe(true); expect(window.getSelection()!.toString()).toBe('Reply')
  await render(pane()); await click('Return')
  expect(container.querySelector('.activity-feed')).toBe(feed); expect(body.isConnected).toBe(true); expect(trace.open).toBe(true)
  expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('ORIGINAL UNSENT DRAFT')
 })
 it('passes a live hidden gate through the primary cached ReactElement and rejects its late original page', async () => {
  await writeFile(transcript, Array.from({ length: 1200 }, (_, n) => JSON.stringify(record(n))).join('\n') + '\n')
  await seed(); await render(pane()); await click('Earlier')
  const feed = container.querySelector('.activity-feed')!, before = ids()
  let release!: (page: AgentSessionHistoryPage) => void
  let requested: AgentSessionHistoryPageOptions | undefined
  nativePage.mockImplementationOnce((_reference, options) => {
   requested = options; requests.push(options ?? {})
   return new Promise(resolve => { release = resolve })
  })
  const earlier = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Earlier')!
  await act(async () => { earlier.focus(); earlier.click() })
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  expect(requested?.cursor).toBeTypeOf('string')
  const originalEarlierPage = await readOriginalPage(sid, requested)
  expect(originalEarlierPage.items.some(item => !before.includes(item.id))).toBe(true)
  await render(pane(false))
  await act(async () => release(originalEarlierPage))
  await flush(); expect(container.querySelector('.activity-feed')).toBe(feed); expect(ids()).toEqual(before)
  const count = requests.length; await act(async () => { earlier.focus(); earlier.click() }); await flush(); expect(requests).toHaveLength(count)
 })
 it('passes visible eligibility through the secondary cached ReactElement without redirecting its local earlier window', async () => {
  await writeFile(transcript, Array.from({ length: 1200 }, (_, n) => JSON.stringify(record(n))).join('\n') + '\n')
  await seed(); const page = await readOriginalPage(sid)
  const stage = (visible: boolean) => <SessionActivityPresentation target={{ hostId: 'private-stage', active: true, visible,
    reference: { displayWorkspaceId: 'ws', groupId: 'group', tabId: 'tab', regionId: 'region' } }} regionId="region" sourceKey="original-source"
   sessionId={sid} name="Original Agent" executorLabel="Claude" executionHost={{ configured: true, id: 'local', cwd: stored.workspacePath, label: 'Private host', kind: 'local' }}
   activity={{ sessionId: sid, executionHostId: 'local', nativeHistoryPage: page, capability: 'complete-events',
    conversationReading: { reference: control, identity: control.run.runId, enabled: true } }}
   eligible readOnly={false} resourceOrigin={{ workspaceId: 'ws', tabId: 'tab', regionId: 'region' }}
   renderFrame={content => content} selectRegion={() => {}} />
  await render(stage(true)); const originalWindow = ids()
  expect(originalWindow).toHaveLength(300)
  await click('Earlier')
  await vi.waitFor(() => expect(ids()).toHaveLength(originalWindow.length + 100))
  expect(ids().slice(-originalWindow.length)).toEqual(originalWindow)
  expect(ids()[0]).toBe('record-800'); expect(ids().at(-1)).toBe('record-1199')
  let release!: (page: AgentSessionHistoryPage) => void
  let requested: AgentSessionHistoryPageOptions | undefined
  nativePage.mockImplementationOnce((_reference, options) => {
   requested = options; requests.push(options ?? {})
   return new Promise(resolve => { release = resolve })
  })
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Earlier')!
  await act(async () => button.click())
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  expect(requested?.cursor).toBeTypeOf('string')
  const before = ids(), originalEarlierPage = await readOriginalPage(sid, requested)
  expect(originalEarlierPage.items.some(item => !before.includes(item.id))).toBe(true)
  await render(stage(false))
  await act(async () => release(originalEarlierPage)); await flush()
  expect(ids()).toEqual(before); const count = requests.length
  await act(async () => button.click()); await flush(); expect(requests).toHaveLength(count)
  await render(stage(true)); expect(ids()).toEqual(before)
  expect(container.textContent).not.toContain('original Session work surface. This presentation keeps')
 })
 it('keeps the idle-over-day pending recovery surface readable inline through the same Activity without starting a Run', async () => {
  await seed('terminal')
  const original = liveSession()
  const { DEFAULT_AGENT_CONTINUITY_POLICY } = await import('@agentmux/core')
  // Core owns the idle admission. This caller consumes its typed projection;
  // semantic display state alone does not authorize an inline recovery decision.
  useAppStore.setState({ sessions: [{ ...original, processState: 'exited',
   semanticStatus: { state: 'done', source: 'native-hook', observedAt: 1, stateEnteredAt: 1 },
   continuity: { operationId: 'original-startup-admission', agentSessionId: sid, trigger: 'startup',
    policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY }, previousRun: control.run, admittedAt: 1, observedAt: 1, rechecks: 0,
    kind: 'pending', reason: 'idle-window-expired', evidence: { kind: 'agent-session-store' } } }] })
  const recover = vi.spyOn(useAppStore.getState(), 'recoverSession')
  await render(pane())
  const feed = container.querySelector<HTMLElement>('.activity-feed')!
  expect(feed).not.toBeNull(); expect(ids()).toHaveLength(300); expect(container.textContent).toContain('Input 352')
  expect(feed.closest('.agent-body')?.getAttribute('data-observation-surface')).toBe('workflow')
  expect(feed.closest('[hidden]')).toBeNull(); expect(feed.closest('[inert]')).toBeNull()
  expect(container.querySelector('.activity-feed__reading')).not.toBeNull()
  expect(recover).not.toHaveBeenCalled(); expect(useAppStore.getState().sessions[0]!.control).toEqual(control)
  expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('ORIGINAL UNSENT DRAFT')
 })
 it('reads a real retired Session through the same Activity with only a Host/Session reference and keeps captured/native sources', async () => {
  await store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: { id: 'captured-tool-input', agentSessionId: sid, kind: 'user_message', source: 'user', sourceChannel: 'message-tool',
   title: 'Original accepted input', status: 'complete', content: 'Captured Message Tool original', createdAt: 1, updatedAt: 1 } })
  await seed(); await retired(); useAppStore.setState({ sessions: [] })
  await render(pane()); await flush()
  expect(container.querySelectorAll('.activity-feed')).toHaveLength(1); expect(ids()).toHaveLength(300)
  expect(container.textContent).toContain('Captured Message Tool original'); expect(container.textContent).toContain('Input 352')
  expect(requests.every(request => request.limit === 30 || request.limit === 100)).toBe(true)
  expect((await store.load()).length).toBe(0); expect((await store.loadRetiredAgentSessions()).length).toBe(1)
 })
 it('does not read for unrelated Store updates while an actual old window remains readable', async () => {
  await render(compose()); await click('Earlier'); const page = ids(), count = requests.length
  for (let n = 0; n < 20; n++) await act(async () => useAppStore.setState({ timelines: { unrelated: { agentSessionId: 'unrelated', revision: n, items: [] } } }))
  await flush(); expect(requests).toHaveLength(count); expect(ids()).toEqual(page)
 })
})
