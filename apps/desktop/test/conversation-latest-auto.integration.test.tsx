import { fixtureTime as _hygiene_fixtureTime } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, Profiler } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { mkdtemp, writeFile, readFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentMuxStoredAgentSession, type AgentSessionHistoryPage } from '@agentmux/core'
import type { AgentSessionControl } from '../src/shared/contracts'
import type { AgentNativeSourceFacts } from '../src/shared/agent-native-source'
import { createClientUiRoot } from './helpers/client-ui-render'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'
import { markProgrammaticReadingScroll } from '@agentmux/client-ui/reading-scroll'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const sid = 'automatic-current-session', native = 'automatic-native-source'
const control: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId: sid, run: { runId: 'healthy-original-run' } }
const initial = useAppStore.getState()
let container: HTMLDivElement, root: Root, directory: string, transcript: string, client: AgentMuxClient
let originalStore: Buffer, stored: AgentMuxStoredAgentSession
let requests: { cursor?: string; limit?: number }[], reads: Promise<AgentSessionHistoryPage>[], observation: Parameters<typeof api.sessions.observeHistory>[1] | null
let controls: ReturnType<typeof vi.spyOn>[]
let commits: boolean[]
let extent: number, viewportHeight: number, physicalTop: number
let resizeObservers: { targets: Set<Element>; invoke: () => void }[]
function record(n: number) {
 const role = n % 2 === 0 ? 'user' : 'assistant'
 return { uuid: `original-${n}`, type: role, sessionId: native, timestamp: new Date(_hygiene_fixtureTime(-37225600000) + n * 7200000).toISOString(),
  message: { role, content: role === 'user' ? `Original input ${n}` : [{ type: 'thinking', thinking: `Original thought ${n}` }, { type: 'text', text: `Original reply ${n}` }] } }
}
function Reading({ visible = true, identity = control.run.runId, facts = stored, opened = false }: { visible?: boolean; identity?: string; facts?: AgentNativeSourceFacts; opened?: boolean }) {
 const read = useSessionUserMessages(control, { enabled: visible })
 return <Profiler id="current-reading" onRender={() => commits.push(currentButton() !== null)}><ActivityView sessionId={sid} executionHostId="local" items={[]} capability="complete-events" displayState="working"
  nativeHistoryPage={read.nativeHistoryPage} nativeContextItems={read.nativeContextItems} userMessages={read.messages}
  conversationReading={{ reference: control, identity, enabled: visible, opened, nativeSourceFacts: facts }} /></Profiler>
}
async function flush() { for (let i = 0; i < 8; i++) await act(async () => { await Promise.allSettled([...reads]); await new Promise(resolve => setTimeout(resolve, 15)) }) }
async function render(visible = true, identity = control.run.runId, facts: AgentNativeSourceFacts = stored, opened = false) { await act(async () => root.render(<Reading visible={visible} identity={identity} facts={facts} opened={opened} />)); await flush() }
async function publish(from: number, count = 100, makeRecord = record) {
 await appendFile(transcript, Array.from({ length: count }, (_, n) => JSON.stringify(makeRecord(from + n))).join('\n') + '\n')
 await act(async () => observation?.({ agentSessionId: sid, source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated' })); await flush()
}
function ids() { return [...container.querySelectorAll<HTMLElement>('[data-native-record-id]')].map(node => node.dataset.nativeRecordId!) }
function viewport() { const node = container.querySelector<HTMLElement>('.activity-feed')!; expect(node).not.toBeNull(); return node }
function installGeometry() {
 const feed = viewport()
 Object.defineProperties(feed, {
  scrollHeight: { configurable: true, get: () => extent },
  clientHeight: { configurable: true, get: () => viewportHeight },
  scrollTop: { configurable: true, get: () => Math.max(0, Math.min(physicalTop, extent - viewportHeight)),
   set: value => { physicalTop = Math.max(0, Math.min(Number(value), extent - viewportHeight)) } }
 })
 return feed
}
async function followAt(top: number) {
 const feed = installGeometry(); feed.scrollTop = top
 await act(async () => feed.dispatchEvent(new Event('scroll')))
}
async function resizeReadingViewport() {
 const callbacks = resizeObservers.filter(observer => observer.targets.has(viewport()))
 expect(callbacks.length, 'the actual reading observer must watch this viewport').toBeGreaterThan(0)
 await act(async () => { for (const observer of callbacks) observer.invoke() })
}
function tailDistance() { const feed = viewport(); return feed.scrollHeight - feed.clientHeight - feed.scrollTop }
async function restoreCurrentTail() {
 const feed = viewport(); feed.scrollTop = extent - viewportHeight; markProgrammaticReadingScroll(feed)
 await act(async () => feed.dispatchEvent(new Event('scroll')))
}
async function shortenNativeTail() {
 const rows = (await readFile(transcript, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
 rows.at(-1).message.content = [{ type: 'text', text: 'Shorter actual source reply' }]
 await writeFile(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
 await act(async () => observation?.({ agentSessionId: sid, source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated' })); await flush()
 expect(container.textContent).toContain('Shorter actual source reply')
}

async function collapseLastTraceAtTail() {
 await followAt(900)
 const details = container.querySelector<HTMLDetailsElement>('[data-native-record-id="original-59"] details')!
 expect(details).not.toBeNull()
 await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) }); await flush(); await followAt(900)
 const collapse = container.querySelector<HTMLButtonElement>('[aria-label="收起已展开的过程详情"]')!
 expect(collapse).not.toBeNull(); expect(collapse.getAttribute('aria-disabled')).not.toBe('true')
 await act(async () => collapse.click()); await flush()
 return details
}

function currentButton() { return container.querySelector<HTMLButtonElement>('[data-message-tool-control="jump-to-latest"]') }
function rect(top: number, height: number): DOMRect {
 return { x: 0, y: top, top, bottom: top + height, left: 0, right: 800, width: 800, height, toJSON() {} }
}
beforeEach(async () => {
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
 resizeObservers = []
 vi.stubGlobal('ResizeObserver', class {
  targets = new Set<Element>()
  constructor(callback: ResizeObserverCallback) { resizeObservers.push({ targets: this.targets, invoke: () => callback([], this as unknown as ResizeObserver) }) }
  observe(target: Element) { this.targets.add(target) }
  unobserve(target: Element) { this.targets.delete(target) }
  disconnect() { this.targets.clear() }
 })
 vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
 Element.prototype.scrollIntoView = vi.fn()
 directory = await mkdtemp(join(tmpdir(), 'conversation-latest-auto-')); transcript = join(directory, 'native.jsonl')
 await writeFile(transcript, Array.from({ length: 60 }, (_, n) => JSON.stringify(record(n))).join('\n') + '\n')
 const store = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json'))
 stored = { kind: 'agent', agentSessionId: sid, providerId: 'claude', executorId: 'claude', hostId: 'local', workspacePath: directory, run: control.run,
  retiredRuns: [], hookBindingId: 'private-binding', hookToken: 'private-token', createdAt: 1, updatedAt: 1,
  nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: native, transcriptPath: transcript } }
 await store.compareAndSwap(null, stored); originalStore = await readFile(join(directory, 'sessions.json'))
 client = new AgentMuxClient({ store }); const kernel = Reflect.get(client, 'kernel')
 controls = ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name).mockImplementation(() => { throw Error('Reading cannot control Runtime ' + name) }))
 requests = []; reads = []; observation = null; commits = []; extent = 1500; viewportHeight = 600; physicalTop = 0
 vi.spyOn(api.sessions, 'historyPage').mockImplementation((reference, options) => {
  expect(reference).toMatchObject({ hostId: 'local', agentSessionId: sid }); requests.push(options ?? {})
  const read = client.sessionHistoryPage(reference.agentSessionId, options); reads.push(read); return read
 })
 vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async (_reference, listener) => { observation = listener; return { source: { providerId: 'claude', nativeSessionId: native }, dispose() {} } })
 useAppStore.setState({ sessions: [], timelines: {}, agentComposerDrafts: { [sid]: 'Original unsent draft' } })
 container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
 vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
  const feed = container.querySelector<HTMLElement>('.activity-feed'), top = feed?.scrollTop ?? 0
  if (this.matches('.activity-feed')) return rect(0, viewportHeight)
  if (this.matches('[data-conversation-native-tail], [data-conversation-reading-tail], [data-conversation-reading-space]')) return rect(extent - top, 0)
  if (this.matches('[data-native-record-id]')) return rect([...container.querySelectorAll('[data-native-record-id]')].indexOf(this) * 25 - top, 25)
  return rect(0, 0)
 })
})
afterEach(async () => {
 try {
 await act(async () => root.unmount()); container.remove(); window.getSelection()?.removeAllRanges()
 expect(controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
 expect(requests.length).toBeGreaterThan(0); expect(requests.every(input => input.limit !== undefined && input.limit > 0 && input.limit <= 100)).toBe(true)
 expect(await readFile(join(directory, 'sessions.json'))).toEqual(originalStore)
 expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('Original unsent draft')
 } finally {
 await client.dispose(); await rm(directory, { recursive: true }); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
 }
})

it('automatically reads a same-source no-overlap current tail without requiring Show latest messages', async () => {
 await render(); expect(ids()).toHaveLength(60); expect(ids().at(-1)).toBe('original-59')
 await followAt(900); const before = requests.filter(input => input.limit === 100).length
 await publish(60)
 expect(ids().at(-1), 'the latest actual native reply should be readable without clicking Current').toBe('original-159')
 expect(ids()).toHaveLength(100); expect(currentButton()).toBeNull()
 expect(requests.filter(input => input.limit === 100)).toHaveLength(before + 1)
 const count = requests.length; await render(); await render()
 expect(requests).toHaveLength(count)
})
it('keeps upward reading and its original expanded body/scroll when recent native facts have a gap', async () => {
 await render(); await followAt(900); await followAt(300)
 const body = container.querySelector<HTMLElement>('[data-native-record-id="original-1"] .log-turn__body')!
 const details = body.querySelector<HTMLDetailsElement>('details')!; await act(async () => { details.open = true })
 const before = ids(), count = requests.filter(input => input.limit === 100).length
 await publish(60)
 expect(ids()).toEqual(before); expect(body.isConnected).toBe(true); expect(details.open).toBe(true)
 expect(viewport().scrollTop).toBe(300); expect(currentButton()).not.toBeNull()
 expect(requests.filter(input => input.limit === 100)).toHaveLength(count)
 await followAt(900); await flush(); expect(ids().at(-1)).toBe('original-159')
})
it('does not auto-replace a real noncollapsed Range even when the original follow intent is current', async () => {
 await render(); await followAt(900)
 const body = container.querySelector<HTMLElement>('[data-native-record-id="original-1"] .log-turn__body p')!
 const range = document.createRange(); range.selectNodeContents(body); const selection = window.getSelection()!; selection.addRange(range)
 expect(selection.toString()).toBe('Original reply 1')
 const count = requests.filter(input => input.limit === 100).length; await publish(60)
 expect(body.isConnected).toBe(true); expect(selection.getRangeAt(0)).toBe(range); expect(selection.toString()).toBe('Original reply 1')
 expect(ids().at(-1)).toBe('original-59'); expect(requests.filter(input => input.limit === 100)).toHaveLength(count)
 await act(async () => { selection.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) }); await flush()
 expect(ids().at(-1), 'clearing this feed selection resumes its retained current-tail intent').toBe('original-159')
 expect(requests.filter(input => input.limit === 100)).toHaveLength(count + 1)
})
it('selection clear in the same event batch as upward scrolling cannot reuse stale follow permission', async () => {
 await render(); await followAt(900)
 const body = container.querySelector<HTMLElement>('[data-native-record-id="original-1"] .log-turn__body p')!
 const range = document.createRange(); range.selectNodeContents(body); const selection = window.getSelection()!; selection.addRange(range)
 await publish(60); const count = requests.filter(input => input.limit === 100).length
 await act(async () => { viewport().scrollTop = 300; viewport().dispatchEvent(new Event('scroll')); selection.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) }); await flush()
 expect(ids().at(-1)).toBe('original-59'); expect(body.isConnected).toBe(true)
 expect(requests.filter(input => input.limit === 100), 'selection clear must read the current follow intent before effect cleanup').toHaveLength(count)
})
it('resumes the original tail on visible return after hidden native updates without a click', async () => {
 await render(); await followAt(900); await render(false)
 const count = requests.length; await publish(60); expect(requests).toHaveLength(count); expect(ids().at(-1)).toBe('original-59')
 await render(); expect(ids().at(-1), 'visible return at the retained current tail should catch up automatically').toBe('original-159')
 expect(currentButton()).toBeNull()
})
it('discards a hidden automatic reply and resumes that interrupted attempt once on visible return', async () => {
 await render(); await followAt(900)
 const original = vi.mocked(api.sessions.historyPage).getMockImplementation()!
 let release: (() => void) | undefined, held = false
 vi.mocked(api.sessions.historyPage).mockImplementation(async (reference, options) => {
  const page = await original(reference, options)
  if (options?.limit === 100 && !held) { held = true; await new Promise<void>(resolve => { release = resolve }) }
  return page
 })
 await publish(60); expect(held).toBe(true); expect(release).toBeTypeOf('function')
 await render(false); await act(async () => release!()); await flush()
 expect(ids().at(-1)).toBe('original-59')
 const before = requests.filter(input => input.limit === 100).length
 await render(); expect(ids().at(-1)).toBe('original-159'); expect(requests.filter(input => input.limit === 100)).toHaveLength(before + 1)
 const done = requests.length; await render(); expect(requests).toHaveLength(done)
})
it('retains the old window after a genuine read failure and never render-retries that request', async () => {
 await render(); await followAt(900); const original = vi.mocked(api.sessions.historyPage).getMockImplementation()!
 let attempts = 0
 vi.mocked(api.sessions.historyPage).mockImplementation((reference, options) => {
  if (options?.limit === 100) { attempts++; return Promise.reject(new Error('Actual latest read unavailable')) }
  return original(reference, options)
 })
 await publish(60); expect(ids().at(-1)).toBe('original-59'); expect(container.textContent).toContain('Actual latest read unavailable')
 expect(attempts).toBe(1); const count = requests.length; await render(); await render(); expect(requests).toHaveLength(count)
 expect(currentButton(), 'read failure uses its own Retry rather than a scroll prompt at the bottom').toBeNull()
 expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Retry')).toBe(true)
 await publish(160); expect(attempts).toBe(1); expect(ids().at(-1)).toBe('original-59')
})
it('a new native binding keeps the old conversation and never auto-reads it as the new source', async () => {
 await render(); await followAt(900); const count = requests.filter(input => input.limit === 100).length
 const newFacts: AgentNativeSourceFacts = { nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'different-native-source' } }
 await render(true, control.run.runId, newFacts); await publish(60)
 expect(ids().at(-1)).toBe('original-59'); expect(requests.filter(input => input.limit === 100)).toHaveLength(count)
 expect(container.textContent).toContain('Native source changed'); expect(currentButton()).not.toBeNull()
})

it('a late automatic page cannot overwrite a newly established reading identity', async () => {
 await render(); await followAt(900)
 const original = vi.mocked(api.sessions.historyPage).getMockImplementation()!
 let release: (() => void) | undefined, held = false
 vi.mocked(api.sessions.historyPage).mockImplementation(async (reference, options) => {
  const page = await original(reference, options)
  if (options?.limit === 100 && !held) { held = true; await new Promise<void>(resolve => { release = resolve }) }
  return page
 })
 await publish(60); expect(held).toBe(true)
 await appendFile(transcript, Array.from({ length: 100 }, (_, n) => JSON.stringify(record(160 + n))).join('\n') + '\n')
 await render(true, 'new-reading-identity'); expect(ids().at(-1)).toBe('original-259')
 await act(async () => release!()); await flush(); expect(ids().at(-1)).toBe('original-259')
 expect(ids()).not.toContain('original-159')
})


it('an opened current window at the bottom stays quiet, and returning to its loaded tail only scrolls', async () => {
 await render(true, control.run.runId, stored, true); await followAt(900)
 expect(currentButton()).toBeNull()
 await followAt(300)
 const button = currentButton()!; expect(button).not.toBeNull()
 expect(button.textContent?.trim()).toBe('滚动到最新'); expect(button.getAttribute('aria-label')).toBe('滚动到最新')
 const before = requests.length
 await act(async () => button.click()); await flush()
 expect(viewport().scrollTop).toBe(900); expect(requests).toHaveLength(before)
 expect(currentButton()).toBeNull()
})

it('ordinary same-tail, overlapping and non-overlapping updates never flash a latest control in any commit', async () => {
 await render(); await followAt(900); commits = []
 const updated = record(_historyFixtureEpoch(0, 0, 59)); updated.message.content = [{ type: 'text', text: 'The same original reply grows in place.' }]
 const lines = (await readFile(transcript, 'utf8')).trimEnd().split('\n'); lines[lines.length - 1] = JSON.stringify(updated)
 await writeFile(transcript, lines.join('\n') + '\n')
 await act(async () => observation?.({ agentSessionId: sid, source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated' })); await flush()
 expect(container.textContent).toContain('The same original reply grows in place.')
 await publish(60, 2); expect(ids().at(-1)).toBe('original-61')
 await publish(62); expect(ids().at(-1)).toBe('original-161')
 expect(commits.length).toBeGreaterThan(3)
 expect(commits, 'every actual React commit stays free of a false scroll prompt while following').not.toContain(true)
 expect(currentButton()).toBeNull()
})

it('off-tail updates keep the same scroll control and reading position until explicit navigation', async () => {
 await render(); await followAt(900); await followAt(300)
 const button = currentButton(); expect(button).not.toBeNull(); commits = []
 await publish(60, 2); await publish(62, 2)
 expect(currentButton()).toBe(button); expect(viewport().scrollTop).toBe(300)
 expect(commits.length).toBeGreaterThan(0); expect(commits).not.toContain(false)
 const before = requests.length
 await act(async () => button!.click()); await flush()
 expect(requests, 'all current records are already loaded, so return needs no read').toHaveLength(before)
 expect(viewport().scrollTop).toBe(900); expect(currentButton()).toBeNull()
})


it('retaining earlier records does not turn a return to the loaded current tail into a refresh', async () => {
 await writeFile(transcript, Array.from({ length: 150 }, (_, n) => JSON.stringify(record(n))).join('\n') + '\n')
 await render(); await followAt(900)
 const earlier = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Earlier')!
 expect(earlier).toBeDefined(); await act(async () => earlier.click()); await flush()
 expect(ids()).toHaveLength(150); expect(ids().at(-1)).toBe('original-149')
 await followAt(300); const button = currentButton(); expect(button).not.toBeNull()
 const before = requests.length
 await act(async () => button!.click()); await flush()
 expect(requests, 'the retained earlier boundary is navigation history, not a reason to refetch current').toHaveLength(before)
 expect(ids()).toHaveLength(150); expect(viewport().scrollTop).toBe(900); expect(currentButton()).toBeNull()
})


it('hides the affordance when collapsing an expanded trace finishes at the loaded current tail', async () => {
 await render(); const details = await collapseLastTraceAtTail()
 expect(tailDistance()).toBe(0); expect(details.open).toBe(false); expect(currentButton()).toBeNull()
})

it('a plain browser layout clamp hides the affordance through its ordinary scroll event', async () => {
 await render(); await followAt(900); await followAt(600); expect(currentButton()).not.toBeNull()
 extent = 900; await act(async () => viewport().dispatchEvent(new Event('scroll')))
 expect(tailDistance()).toBe(0); expect(currentButton()).toBeNull()
})

it.each([{ name: 'content shrink', extent: 900, viewport: 600 }, { name: 'viewport growth', extent: 1500, viewport: 1200 }])
 ('hides the affordance after $name clamps an upward reader to the tail during native restoration', async shape => {
 await render(); await followAt(900); await followAt(600); expect(currentButton()).not.toBeNull()
 extent = shape.extent; viewportHeight = shape.viewport; await shortenNativeTail()
 await act(async () => viewport().dispatchEvent(new Event('scroll')))
 expect(tailDistance()).toBe(0); expect(currentButton()).toBeNull()
})

it('hides the affordance after programmatic restoration reaches the loaded current tail', async () => {
 await render(); await followAt(900); await followAt(300); expect(currentButton()).not.toBeNull()
 const before = requests.length; await restoreCurrentTail()
 expect(tailDistance()).toBe(0); expect(requests).toHaveLength(before); expect(currentButton()).toBeNull()
})

it('actual ResizeObserver callbacks hide at the tail without scroll or page changes and never grant follow after growth', async () => {
 await render(); await followAt(900); await followAt(600); expect(currentButton()).not.toBeNull()
 const originalIds = ids(), before = requests.length
 extent = 900; await resizeReadingViewport()
 expect(tailDistance()).toBe(0); expect(currentButton()).toBeNull(); expect(requests).toHaveLength(before); expect(ids()).toEqual(originalIds)
 extent = 1500; await resizeReadingViewport()
 expect(viewport().scrollTop).toBe(600); expect(tailDistance()).toBeGreaterThan(64); expect(currentButton()).not.toBeNull()
 expect(requests).toHaveLength(before)
 await publish(60, 2)
 expect(ids().at(-1)).toBe('original-61'); expect(viewport().scrollTop, 'geometry updates do not resume the original detached follow intent').toBe(600)
 expect(currentButton()).not.toBeNull()
})

it('keeps the return path for a real no-overlap gap at a detached loaded tail and resumes only on a user return', async () => {
 await render(); await collapseLastTraceAtTail()
 expect(tailDistance()).toBe(0); expect(currentButton()).toBeNull()
 const before = requests.filter(input => input.limit === 100).length
 await publish(60)
 expect(ids().at(-1)).toBe('original-59'); expect(tailDistance()).toBe(0)
 expect(currentButton(), 'the actual current source is now outside this retained loaded window').not.toBeNull()
 expect(requests.filter(input => input.limit === 100)).toHaveLength(before)
 await followAt(700); await followAt(900); await flush()
 expect(ids().at(-1)).toBe('original-159'); expect(currentButton()).toBeNull()
 expect(requests.filter(input => input.limit === 100)).toHaveLength(before + 1)
})

const coverageNotice = 'The requested time range exceeds this bounded reading window. Loaded records are kept; scroll earlier to continue.'
function denseRecord(n: number) { return { ...record(n), timestamp: new Date(_hygiene_fixtureTime(0) + n * 1000).toISOString() } }
async function denseHistory() {
 await writeFile(transcript, Array.from({ length: 1300 }, (_, n) => JSON.stringify(denseRecord(n))).join('\n') + '\n')
 await render()
 await vi.waitFor(async () => { await flush(); expect(container.textContent).toContain(coverageNotice) }, { timeout: 8000, interval: 25 })
 expect(ids().at(-1)).toBe('original-1299')
 await followAt(900)
}

it('an older coverage record bound keeps the independent current tail connected without a button or repeated reads', async () => {
 await denseHistory(); const before = requests.filter(input => input.limit === 100).length
 expect(before).toBe(12)
 await publish(1300, 100, denseRecord)
 expect(ids().at(-1)).toBe('original-1399'); expect(currentButton()).toBeNull()
 await vi.waitFor(async () => { await flush(); expect(requests.filter(input => input.limit === 100)).toHaveLength(before + 12) }, { timeout: 8000, interval: 25 })
 expect(container.textContent).toContain(coverageNotice)
 const count = requests.length; await render(); await render()
 expect(requests).toHaveLength(count)
})

it.each(['upward reading', 'selection'] as const)('coverage bounds preserve %s before permitting a current-tail replacement', async protection => {
 await denseHistory()
 extent = 30000; await followAt(extent - viewportHeight)
 const body = container.querySelector<HTMLElement>('[data-native-record-id="original-1299"] .log-turn__body p')!
 expect(body).not.toBeNull()
 if (protection === 'selection') {
  const range = document.createRange(); range.selectNodeContents(body); window.getSelection()!.addRange(range)
 } else await followAt(extent - viewportHeight - 200)
 const before = requests.filter(input => input.limit === 100).length
 await publish(1300, 100, denseRecord)
 expect(ids().at(-1)).toBe('original-1299'); expect(body.isConnected).toBe(true)
 expect(requests.filter(input => input.limit === 100)).toHaveLength(before)
 if (protection === 'selection') await act(async () => { window.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) })
 else await followAt(extent - viewportHeight)
 await flush(); expect(ids().at(-1)).toBe('original-1399')
})

it.each(['same display text', 'source change', 'position change'] as const)('a real %s failure during older coverage retains Retry and cannot borrow range-bound permission', async failure => {
 const original = vi.mocked(api.sessions.historyPage).getMockImplementation()!
 let head: AgentSessionHistoryPage | undefined
 vi.mocked(api.sessions.historyPage).mockImplementation(async (reference, options) => {
  const page = await original(reference, options)
  if (options?.limit !== 100) return page
  head ??= page
  if (requests.filter(input => input.limit === 100).length !== 4) return page
  if (failure === 'same display text') throw new Error(coverageNotice)
  if (failure === 'source change') return { ...page, source: { ...page.source, nativeSessionId: 'different-original-source' } }
  return { ...page, items: [head.items.at(-1)!, ...page.items.slice(1)] }
 })
 await writeFile(transcript, Array.from({ length: 1300 }, (_, n) => JSON.stringify(denseRecord(n))).join('\n') + '\n')
 await render(); await followAt(900)
 expect(container.textContent).toContain(failure === 'same display text' ? coverageNotice : failure === 'source change' ? 'Native source changed' : 'original page range changed')
 const before = requests.filter(input => input.limit === 100).length
 expect(before).toBe(4)
 await publish(1300, 100, denseRecord)
 expect(ids().at(-1)).toBe('original-1299')
 expect(requests.filter(input => input.limit === 100)).toHaveLength(before)
 expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Retry')).toBe(true)
})
