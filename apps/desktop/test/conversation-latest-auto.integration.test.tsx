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
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { markProgrammaticReadingScroll } from '@agentmux/client-ui/reading-scroll'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'


const sid = 'automatic-current-session', native = 'automatic-native-source'
const control: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId: sid, run: { runId: 'healthy-original-run' } }
const initial = useAppStore.getState()
let container: HTMLDivElement, root: Root, directory: string, transcript: string, client: AgentMuxClient
let originalStore: Buffer, expectedTranscript: Buffer, stored: AgentMuxStoredAgentSession
let requests: { cursor?: string; limit?: number }[], reads: Promise<AgentSessionHistoryPage>[], observation: Parameters<AgentMuxClient['observeSessionHistory']>[1] | null
let controls: ReturnType<typeof vi.spyOn>[]
let bridgeCloses: Array<() => unknown | Promise<unknown>>
let commits: boolean[]
let extent: number, viewportHeight: number, physicalTop: number
let resizeObservers: { targets: Set<Element>; invoke: () => void }[]
function record(n: number) {
 const role = n % 2 === 0 ? 'user' : 'assistant'
 return { uuid: `original-${n}`, type: role, sessionId: native, timestamp: new Date(_hygiene_fixtureTime(-37225600000) + n * 7200000).toISOString(),
  message: { role, content: role === 'user' ? `Original input ${n}` : [{ type: 'thinking', thinking: `Original thought ${n}` }, { type: 'text', text: `Original reply ${n}` }] } }
}
function Reading({ visible = true, identity = control.run.runId, facts = stored, opened = false }: { visible?: boolean; identity?: string; facts?: AgentNativeSourceFacts; opened?: boolean }) {
 return <Profiler id="current-reading" onRender={() => commits.push(currentButton() !== null)}><ActivityView sessionId={sid} executionHostId="local" capability="complete-events" displayState="working"
  conversationReading={{ reference: control, identity, enabled: visible, opened, nativeSourceFacts: facts }} /></Profiler>
}
async function flush() { for (let i = 0; i < 8; i++) await act(async () => { await Promise.allSettled([...reads]); await new Promise(resolve => setTimeout(resolve, 15)) }) }
async function render(visible = true, identity = control.run.runId, facts: AgentNativeSourceFacts = stored, opened = false) { await act(async () => root.render(<Reading visible={visible} identity={identity} facts={facts} opened={opened} />)); await flush() }
async function publish(from: number, count = 100, makeRecord = record) {
 await appendFile(transcript, Array.from({ length: count }, (_, n) => JSON.stringify(makeRecord(from + n))).join('\n') + '\n')
 expectedTranscript = await readFile(transcript)
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
function resizeGeometry(height: number, viewport = viewportHeight) {
 extent = height; viewportHeight = viewport
 // A browser layout clamp changes its stored physical offset, independently of host scroll writes.
 physicalTop = Math.max(0, Math.min(physicalTop, extent - viewportHeight))
}
async function followAt(top: number) {
 const feed = installGeometry(); feed.scrollTop = top
 await act(async () => feed.dispatchEvent(new Event('scroll')))
}
async function resizeReadingViewport() {
 const callbacks = resizeObservers.filter(observer => observer.targets.has(viewport()))
 expect(callbacks.length, 'the actual reading observer must watch this viewport').toBeGreaterThan(0)
 await act(async () => { for (const observer of callbacks) observer.invoke() }); await flush()
}
function tailDistance() { const feed = viewport(); return feed.scrollHeight - feed.clientHeight - feed.scrollTop }
async function restoreCurrentTail() {
 const feed = viewport(); feed.scrollTop = extent - viewportHeight; markProgrammaticReadingScroll(feed)
 await act(async () => feed.dispatchEvent(new Event('scroll')))
}
async function shortenNativeTail() {
 const rows = (await readFile(transcript, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
 rows.at(-1).message.content = [{ type: 'text', text: 'Shorter actual source reply' }]
 await appendFile(transcript, JSON.stringify(rows.at(-1)) + '\n'); expectedTranscript = await readFile(transcript)
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
 await store.compareAndSwap(null, stored); await store.readCapturedHistory(sid)
 originalStore = await readFile(join(directory, 'sessions.json')); expectedTranscript = await readFile(transcript)
 client = new AgentMuxClient({ store }); const kernel = Reflect.get(client, 'kernel')
 controls = ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name).mockImplementation(() => { throw Error('Reading cannot control Runtime ' + name) }))
 bridgeCloses = []; requests = []; reads = []; observation = null; commits = []; extent = 1500; viewportHeight = 600; physicalTop = 0
 const historyPage = client.sessionHistoryPage.bind(client), observeHistory = client.observeSessionHistory.bind(client)
 vi.spyOn(client, 'sessionHistoryPage').mockImplementation((agentSessionId, options) => {
  expect(agentSessionId).toBe(sid); requests.push(options ?? {})
  const read = historyPage(agentSessionId, options); reads.push(read); return read
 })
 vi.spyOn(client, 'observeSessionHistory').mockImplementation((agentSessionId, listener, options) => { observation = listener; return observeHistory(agentSessionId, listener, options) })
 await desktopConversationReadBridge({ root: directory, client }, bridgeCloses)
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
 expect(await readFile(transcript)).toEqual(expectedTranscript)
 expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('Original unsent draft')
 } finally {
 for (const close of bridgeCloses.reverse()) await close()
 await client.dispose(); await rm(directory, { recursive: true }); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
 }
})

it('automatically accepts all 60 retained and 100 appended same-source records without requiring Show latest messages', async () => {
 await render(); expect(ids()).toHaveLength(60); expect(ids().at(-1)).toBe('original-59')
 await followAt(900); const before = requests.filter(input => input.limit === 100).length
 await publish(60)
 expect(ids().at(-1), 'the latest actual native reply should be readable without clicking Current').toBe('original-159')
 expect(ids()).toEqual(Array.from({ length: 160 }, (_, n) => `original-${n}`)); expect(currentButton()).toBeNull()
 expect(requests.filter(input => input.limit === 100), 'same-source changes do not reopen a raw latest page').toHaveLength(before)
 const count = requests.length; await render(); await render()
 expect(requests).toHaveLength(count)
})
it('keeps upward reading and its original expanded body/scroll while accepting a non-destructive append', async () => {
 await render(); await followAt(900); await followAt(300)
 const body = container.querySelector<HTMLElement>('[data-native-record-id="original-1"] .log-turn__body')!
 const details = body.querySelector<HTMLDetailsElement>('details')!; await act(async () => { details.open = true })
 const before = ids(), count = requests.filter(input => input.limit === 100).length
 await publish(60)
 expect(ids()).toEqual([...before, ...Array.from({ length: 100 }, (_, n) => `original-${60+n}`)]); expect(body.isConnected).toBe(true); expect(details.open).toBe(true)
 expect(viewport().scrollTop).toBe(300); expect(currentButton()).not.toBeNull()
 expect(requests.filter(input => input.limit === 100)).toHaveLength(count)
 await followAt(900); await flush(); expect(ids().at(-1)).toBe('original-159')
})
it('a non-destructive append keeps the original noncollapsed Range without forcing follow', async () => {
 await render(); await followAt(900)
 const body = container.querySelector<HTMLElement>('[data-native-record-id="original-1"] .log-turn__body p')!
 const range = document.createRange(); range.selectNodeContents(body); const selection = window.getSelection()!; selection.addRange(range)
 expect(selection.toString()).toBe('Original reply 1')
 const count = requests.filter(input => input.limit === 100).length; await publish(60)
 expect(body.isConnected).toBe(true); expect(selection.getRangeAt(0)).toBe(range); expect(selection.toString()).toBe('Original reply 1')
 expect(ids().at(-1)).toBe('original-159'); expect(requests.filter(input => input.limit === 100)).toHaveLength(count)
 await act(async () => { selection.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) }); await flush()
 expect(ids().at(-1), 'clearing this feed selection resumes its retained current-tail intent').toBe('original-159')
 expect(requests.filter(input => input.limit === 100)).toHaveLength(count)
})
it('selection clear in the same event batch as upward scrolling cannot reuse stale follow permission', async () => {
 await render(); await followAt(900)
 const body = container.querySelector<HTMLElement>('[data-native-record-id="original-1"] .log-turn__body p')!
 const range = document.createRange(); range.selectNodeContents(body); const selection = window.getSelection()!; selection.addRange(range)
 await publish(60); const count = requests.filter(input => input.limit === 100).length
 await act(async () => { viewport().scrollTop = 300; viewport().dispatchEvent(new Event('scroll')); selection.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) }); await flush()
 expect(ids().at(-1)).toBe('original-159'); expect(body.isConnected).toBe(true); expect(viewport().scrollTop).toBe(300)
 expect(requests.filter(input => input.limit === 100), 'selection clear must read the current follow intent before effect cleanup').toHaveLength(count)
})
it('resumes the original tail on visible return after hidden native updates without a click', async () => {
 await render(); await followAt(900); await render(false)
 const count = requests.length; await publish(60); expect(requests).toHaveLength(count); expect(ids().at(-1)).toBe('original-59')
 await render(); expect(ids().at(-1), 'visible return at the retained current tail should catch up automatically').toBe('original-159')
 expect(currentButton()).toBeNull()
})
it('discards an actual delayed changes reply while hidden and resumes once through the retained view', async () => {
 await render(); await followAt(900)
 const original = vi.mocked(api.conversation.readConversationChanges).getMockImplementation()!
 let release!: () => void, held = false
 vi.mocked(api.conversation.readConversationChanges).mockImplementation(async (...args) => {
  const page = await original(...args)
  if (!held) { held = true; await new Promise<void>(resolve => { release = resolve }) }
  return page
 })
 try {
  await publish(60); await vi.waitFor(() => expect(held).toBe(true))
  await render(false); await act(async () => release()); await flush()
  expect(ids().at(-1)).toBe('original-59')
  const before = requests.length
  await render(); await vi.waitFor(async () => { await flush(); expect(ids().at(-1)).toBe('original-159') })
  expect(requests, 'resume replays the accepted view rather than opening a raw latest page').toHaveLength(before)
  const done = requests.length; await render(); expect(requests).toHaveLength(done)
 } finally { release?.() }
})
it('a genuine public changes failure retains the original frame, avoids render retries and recovers through its original Retry', async () => {
 await render(); await followAt(900)
 const original = vi.mocked(api.conversation.readConversationChanges).getMockImplementation()!
 let attempts = 0, fail = true
 vi.mocked(api.conversation.readConversationChanges).mockImplementation((...args) => {
  attempts++
  if (fail) return Promise.reject(new Error('Actual latest read unavailable'))
  return original(...args)
 })
 await publish(60)
 await vi.waitFor(async () => { await flush(); expect(container.textContent).toContain('Actual latest read unavailable') })
 expect(ids().at(-1)).toBe('original-59'); expect(attempts).toBe(1)
 await render(); await render(); expect(attempts).toBe(1)
 const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Retry conversation records')!
 expect(retry).toBeDefined(); fail = false
 await act(async () => retry.click()); await flush()
 await vi.waitFor(async () => { await flush(); expect(ids().at(-1)).toBe('original-159') })
 expect(container.textContent).not.toContain('Actual latest read unavailable')
 expect(inspectConversationConsumers({ hostId: 'local', agentSessionId: sid }).consumers[0]?.accepted?.recordCount).toBe(160)
})
it('new source facts never relabel accepted original-source records or grant another native identity', async () => {
 await render(); await followAt(900); const count = requests.filter(input => input.limit === 100).length
 const newFacts: AgentNativeSourceFacts = { nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'different-native-source' } }
 await render(true, control.run.runId, newFacts); await publish(60)
 expect(ids().at(-1)).toBe('original-159'); expect(requests.filter(input => input.limit === 100)).toHaveLength(count)
 const accepted = inspectConversationConsumers({ hostId: 'local', agentSessionId: sid }).consumers[0]!.accepted!
 expect(accepted.scope.sources.find(item => item.kind === 'native')).toMatchObject({ providerId: 'claude', nativeSessionId: native })
 expect(accepted.scope.sources.some(item => item.kind === 'native' && item.nativeSessionId === 'different-native-source')).toBe(false)
})

it('a late actual changes reply cannot overwrite a newly established reading identity', async () => {
 await render(); await followAt(900)
 const original = vi.mocked(api.conversation.readConversationChanges).getMockImplementation()!
 let release!: () => void, held = false
 vi.mocked(api.conversation.readConversationChanges).mockImplementation(async (...args) => {
  const page = await original(...args)
  if (!held) { held = true; await new Promise<void>(resolve => { release = resolve }) }
  return page
 })
 try {
  await publish(60, 2); await vi.waitFor(() => expect(held).toBe(true))
  await appendFile(transcript, Array.from({ length: 2 }, (_, n) => JSON.stringify(record(62 + n))).join('\n') + '\n')
  expectedTranscript = await readFile(transcript)
  await render(true, 'new-reading-identity')
  await vi.waitFor(async () => { await flush(); expect(ids().at(-1)).toBe('original-63') })
  const accepted = ids(), frame = inspectConversationConsumers({ hostId: 'local', agentSessionId: sid }).consumers[0]!.accepted!
  await act(async () => release()); await flush()
  expect(ids()).toEqual(accepted)
  expect(inspectConversationConsumers({ hostId: 'local', agentSessionId: sid }).consumers[0]!.accepted!.id).toBe(frame.id)
  expect(inspectConversationConsumers({ hostId: 'local', agentSessionId: sid }).consumers[0]!.readingIdentity).toBe('new-reading-identity')
 } finally { release?.() }
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
 const updated = record(59); updated.message.content = [{ type: 'text', text: 'The same original reply grows in place.' }]
 await appendFile(transcript, JSON.stringify(updated) + '\n'); expectedTranscript = await readFile(transcript)
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
 await writeFile(transcript, Array.from({ length: 150 }, (_, n) => JSON.stringify(record(n))).join('\n') + '\n'); expectedTranscript = await readFile(transcript)
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
 resizeGeometry(900); await act(async () => viewport().dispatchEvent(new Event('scroll')))
 expect(tailDistance()).toBe(0); expect(currentButton()).toBeNull()
})

it.each([{ name: 'content shrink', extent: 900, viewport: 600 }, { name: 'viewport growth', extent: 1500, viewport: 1200 }])
 ('hides the affordance after $name clamps an upward reader to the tail during native restoration', async shape => {
 await render(); await followAt(900); await followAt(600); expect(currentButton()).not.toBeNull()
 resizeGeometry(shape.extent, shape.viewport); await shortenNativeTail()
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
 resizeGeometry(900); await resizeReadingViewport()
 expect(viewport().scrollTop).toBe(300); expect(tailDistance()).toBe(0); expect(currentButton()).toBeNull(); expect(requests).toHaveLength(before); expect(ids()).toEqual(originalIds)
 resizeGeometry(1500); await resizeReadingViewport()
 expect(viewport().scrollTop).toBe(300); expect(tailDistance()).toBeGreaterThan(64); expect(currentButton()).not.toBeNull()
 expect(requests).toHaveLength(before)
 await publish(60, 2)
 expect(ids().at(-1)).toBe('original-61'); expect(viewport().scrollTop, 'geometry updates do not resume the original detached follow intent').toBe(300)
 expect(currentButton()).not.toBeNull()
})

it('a detached loaded tail accepts the complete append without silently granting follow', async () => {
 await render(); await collapseLastTraceAtTail()
 expect(tailDistance()).toBe(0); expect(currentButton()).toBeNull()
 const before = requests.length
 // The source now occupies additional layout, independently of the fixed source sequence.
 resizeGeometry(2000)
 await publish(60)
 expect(ids()).toEqual(Array.from({ length: 160 }, (_, n) => `original-${n}`))
 expect(viewport().scrollTop).toBe(900); expect(tailDistance()).toBe(500)
 expect(currentButton()).not.toBeNull(); expect(requests).toHaveLength(before)
 await followAt(1400); await flush()
 expect(currentButton()).toBeNull(); expect(requests).toHaveLength(before)
})

it.each(['same display text', 'foreign source', 'duplicate original position'] as const)('a real %s public read failure retains the original frame and explicit Retry without granting range-bound permission', async failure => {
 await render(); await followAt(900)
 const before = inspectConversationConsumers({ hostId: 'local', agentSessionId: sid }).consumers[0]!.accepted!
 const body = container.querySelector('[data-native-record-id="original-59"]')!
 const original = vi.mocked(api.conversation.readConversationChanges).getMockImplementation()!
 const rangeNotice = 'The requested time range exceeds this bounded reading window. Loaded records are kept; scroll earlier to continue.'
 let failing = true, attempts = 0
 vi.mocked(api.conversation.readConversationChanges).mockImplementation(async (...args) => {
  attempts++
  if (failing && failure === 'same display text') throw new Error(rangeNotice)
  const page = await original(...args)
  if (!failing) return page
  if (failure === 'foreign source') return { ...page, sourceHostId: 'foreign-original-host' }
  expect(page.items.length).toBeGreaterThan(0)
  return { ...page, items: [...page.items, page.items[0]!], window: { ...page.window, itemCount: page.window.itemCount + 1 } }
 })
 await publish(60, 2)
 await vi.waitFor(async () => { await flush(); expect(inspectConversationConsumers({ hostId: 'local', agentSessionId: sid }).consumers[0]?.error).not.toBeNull() })
 const failed = inspectConversationConsumers({ hostId: 'local', agentSessionId: sid }).consumers[0]!
 expect(failed.accepted).toMatchObject({ id: before.id, revision: before.revision, recordCount: 60 })
 expect(ids().at(-1)).toBe('original-59'); expect(body.isConnected).toBe(true)
 if (failure === 'same display text') expect(container.textContent).toContain(rangeNotice)
 await render(); await render(); expect(attempts).toBe(1)
 const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Retry conversation records')!
 expect(retry).toBeDefined(); failing = false
 await act(async () => retry.click())
 await vi.waitFor(async () => { await flush(); expect(ids().at(-1)).toBe('original-61') })
 expect(inspectConversationConsumers({ hostId: 'local', agentSessionId: sid }).consumers[0]!.error).toBeNull()
})
