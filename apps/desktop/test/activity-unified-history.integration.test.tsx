import { fixtureTime as _hygiene_fixtureTime } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentSessionHistoryPage, type AgentSessionHistoryPageOptions, type AgentMuxStoredAgentSession } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import type { AgentSessionControl, AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { createClientUiRoot } from './helpers/client-ui-render'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { SessionActivityPresentation } from '../src/renderer/src/components/SessionActivityPresentation'
import { protectsConversationWindow, conversationReadingAnchor, restoreConversationAnchor } from '../src/renderer/src/lib/session-conversation-window'

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
let observation: Parameters<typeof api.sessions.observeHistory>[1] | null
let originalStore: Buffer, stored: AgentMuxStoredAgentSession
function record(n: number) {
 const type = n < 100 || n > 300 ? (n % 8 === 0 ? 'user' : n % 8 === 1 ? 'assistant' : 'assistant') : 'assistant'
 const content = n < 100 || n > 300 ? (n % 8 === 0 ? `Input ${n} · identical body` : n % 8 === 1 ? [{ type: 'thinking', thinking: `Trace ${n}` }, { type: 'text', text: `Reply ${n}` }] : [{ type: 'thinking', thinking: `Process ${n}` }]) : [{ type: 'thinking', thinking: `Process ${n}` }]
 return { uuid: `record-${String(n).padStart(3, '0')}`, type, sessionId: native, timestamp: new Date(_hygiene_fixtureTime(-37225600000) + n * 1000).toISOString(), message: { role: type, content } }
}
function Witness({ visible = true }: { visible?: boolean }) {
 const result = useSessionUserMessages(control, { enabled: visible }); recent = result
 return <div data-shared-recent={JSON.stringify(result.nativeHistoryPage?.items.map(item => item.id) ?? [])} />
}
function Reading({ visible = true, opened = false }: { visible?: boolean; opened?: boolean }) {
 const facts = useSessionUserMessages(control, { enabled: visible })
 return <ActivityView sessionId={sid} executionHostId="local" items={[]} capability="complete-events" nativeHistoryPage={facts.nativeHistoryPage} nativeContextItems={facts.nativeContextItems}
  userMessages={facts.messages} userMessageRead={{ loading: facts.loading, error: facts.error, hasMore: facts.hasMore, windowIncomplete: facts.windowIncomplete, onRetry: facts.refresh, onReadEarlier: () => {} }}
  conversationReading={{ reference: control, identity: control.run.runId, enabled: visible, opened }} />
}
function compose(visible = true, opened = false) { return <><Reading visible={visible} opened={opened} /><Witness /></> }
async function flush() { for (let i = 0; i < 5; i++) await act(async () => { await Promise.allSettled([...promises]); await new Promise(resolve => setTimeout(resolve, 10)) }) }
async function render(node: ReactNode) { await act(async () => root.render(node)); await flush() }
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
  if (e.dataset.nativeRecordIds) return JSON.parse(e.dataset.nativeRecordIds) as string[]
  return []
 })
}
function rect(top: number, height = 20) { return { x: 0, y: top, top, bottom: top + height, left: 0, right: 300, width: 300, height, toJSON: () => ({}) } }
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
 await store.compareAndSwap(null, stored); originalStore = await readFile(join(home, 'sessions.json'))
 client = new AgentMuxClient({ store })
 const kernel = Reflect.get(client, 'kernel')
 controls = ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'].map(key => vi.spyOn(kernel, key).mockImplementation(() => { throw new Error(`Forbidden Runtime operation ${key}`) }))
 requests = []; promises = []; recent = null; observation = null
 vi.spyOn(api.sessions, 'historyPage').mockImplementation((reference, options) => {
  expect(reference.agentSessionId).toBe(sid); expect(reference.hostId).toBe('local')
  requests.push(options ?? {}); const request = client.sessionHistoryPage(reference.agentSessionId, options); promises.push(request); return request
 })
 vi.spyOn(api.sessions, 'timeline').mockImplementation(reference => client.sessionTimeline(reference.agentSessionId))
 vi.spyOn(api.sessions, 'historySources').mockImplementation(() => client.sessionHistorySources())
 vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async (_reference, listener) => {
  observation = listener
  // Controlled observer transport; records and cursor are actual public Core/Claude/FileStore facts.
  return { source: { providerId: 'claude', nativeSessionId: native }, dispose() {} }
 })
 container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => {
 await act(async () => root.unmount()); container.remove()
 expect(controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
 expect(await readFile(join(home, 'sessions.json'))).toEqual(originalStore)
 await client.dispose(); await rm(home, { recursive: true }); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
 window.getSelection()?.removeAllRanges()
})

describe('One Activity reading surface over public original-sequence windows', () => {
 it('makes updated original current records reachable from the historical window edge without replacing its selected body', async () => {
  await render(compose()); await click('Earlier')
  const body = container.querySelector<HTMLElement>('[data-native-record-id="record-353"] .log-turn__body')!
  const text = [...body.querySelectorAll('p')].find(node => node.textContent === 'Reply 353')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 5); window.getSelection()!.addRange(range)
  const before = ids(), count = requests.length
  expect(container.querySelector('[data-conversation-current-entry]')).not.toBeNull()
  expect(container.querySelector('[data-conversation-current-entry]')!.textContent).not.toContain('Current records updated')
  await appendFile(transcript, JSON.stringify(record(360)) + '\n')
  await act(async () => observation?.({ source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated', agentSessionId: sid })); await flush()
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)) }); await flush()
  expect(recent!.nativeHistoryPage!.items.at(-1)!.id).toBe('record-360')
  expect(ids()).toEqual(before); expect(body.isConnected).toBe(true); expect(window.getSelection()!.getRangeAt(0)).toBe(range)
  const entry = container.querySelector<HTMLElement>('[data-conversation-current-entry]')!
  expect(entry).not.toBeNull(); expect(entry.textContent).toContain('Current records updated')
  expect(entry.previousElementSibling?.className).toBe('conversation-native-thread')
  const reads = requests.length; expect(reads).toBeGreaterThan(count)
  await click('Show latest messages')
  expect(ids().at(-1)).toBe('record-360'); expect(container.textContent).toContain('Input 360')
  expect(container.querySelector('[data-conversation-current-entry]')).toBeNull(); expect(container.querySelector('.activity-feed__history-divider')).toBeNull()
  expect(body.isConnected).toBe(true); expect(window.getSelection()!.getRangeAt(0)).toBe(range); expect(requests).toHaveLength(reads)
 })
 it('notices changed current facts under the same raw identity without inventing a new-message count', async () => {
  await render(compose()); await click('Earlier'); const before = ids()
  await writeFile(transcript, Array.from({ length: 360 }, (_, n) => JSON.stringify(n === 359
   ? { ...record(n), message: { role: 'assistant', content: [{ type: 'text', text: 'Updated native reply 359' }] } } : record(n))).join('\n') + '\n')
  await act(async () => observation?.({ source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated', agentSessionId: sid }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)) }); await flush()
  expect(ids()).toEqual(before); expect(container.textContent).not.toContain('Updated native reply 359')
  expect(container.querySelector('[data-conversation-current-entry]')!.textContent).toContain('Current records updated')
  await click('Show latest messages'); expect(container.textContent).toContain('Updated native reply 359')
 })
 it('keeps a protected historical selection on Latest and cancels a superseded pending older page after selection is cleared', async () => {
  await render(compose()); for (let n = 0; n < 4; n++) await click('Earlier')
  const group = container.querySelector<HTMLElement>('[data-native-record-ids]')!, label = group.querySelector<HTMLElement>('.wf-head .wf-observation__recorded')!
  const range = document.createRange(); range.selectNodeContents(label); window.getSelection()!.addRange(range)
  const before = ids(); await click('Show latest messages')
  expect(ids()).toEqual(before); expect(group.isConnected).toBe(true); expect(window.getSelection()!.getRangeAt(0)).toBe(range)
  expect(container.querySelector('[data-conversation-current-entry]')!.textContent).toContain('current window is kept to preserve selected content')
  window.getSelection()!.removeAllRanges()
  // A fresh long transcript permits one more genuinely pending original earlier read.
  await writeFile(transcript, Array.from({ length: 720 }, (_, n) => JSON.stringify(record(n))).join('\n') + '\n')
  await act(async () => observation?.({ source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated', agentSessionId: sid })); await flush()
  await click('Show latest messages'); await click('Earlier')
  const page = recent!.nativeHistoryPage!
  let release!: (page: AgentSessionHistoryPage) => void
  vi.mocked(api.sessions.historyPage).mockImplementationOnce((_reference, options) => {
   requests.push(options ?? {}); return new Promise(resolve => { release = resolve })
  })
  const earlier = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Earlier')!
  await act(async () => earlier.click())
  expect(container.querySelector<HTMLButtonElement>('[data-conversation-current-entry] button')!.disabled).toBe(false)
  const count = requests.length; await click('Show latest messages'); const current = ids()
  expect(current.at(-1)).toBe('record-719')
  await act(async () => release(await client.sessionHistoryPage(sid, { limit: 30, cursor: page.nextCursor! }))); await flush()
  expect(ids()).toEqual(current); expect(requests).toHaveLength(count); expect(container.querySelector('[data-conversation-reading]')?.getAttribute('data-conversation-reading')).toBe('current')
 })
 it('does not label a foreign or missing current source as an update and disables the historical Latest action while hidden', async () => {
  const current = await client.sessionHistoryPage(sid)
  const surface = (page: AgentSessionHistoryPage | null, enabled = true) => <ActivityView sessionId={sid} items={[]} capability="complete-events" nativeHistoryPage={page}
   conversationReading={{ reference: control, identity: control.run.runId, enabled }} />
  await render(surface(current)); await click('Earlier'); const before = ids(), count = requests.length
  for (const page of [null, { ...current, items: [] }, { ...current, agentSessionId: 'foreign-agent' },
   { ...current, source: { ...current.source, providerId: 'foreign-provider' } }, { ...current, source: { ...current.source, nativeSessionId: 'foreign-native' } }]) {
   await render(surface(page)); expect(ids()).toEqual(before)
   expect(container.querySelector('[data-conversation-current-entry]')).not.toBeNull()
   expect(container.querySelector('[data-conversation-current-entry]')!.textContent).not.toContain('Current records updated')
  }
  await render(surface(current, false))
  const latest = container.querySelector<HTMLButtonElement>('[data-conversation-current-entry] button')!
  expect(latest.disabled).toBe(true); await act(async () => latest.click()); await flush()
  expect(ids()).toEqual(before); expect(requests).toHaveLength(count)
 })
 it('places an inline history boundary at the actual wider displayed context without remounting its expanded process or nonempty Range', async () => {
  const current = await client.sessionHistoryPage(sid, { limit: 30 })
  const context = await client.sessionHistoryPage(sid, { limit: 100 })
  const olderContext = await client.sessionHistoryPage(sid, { limit: 100, cursor: context.nextCursor! })
  const contextItems = [...olderContext.items, ...context.items]
  expect(current.items[0]!.id).toBe('record-330'); expect(contextItems[0]!.id).toBe('record-160')
  await render(<ActivityView sessionId={sid} items={[]} capability="complete-events" nativeHistoryPage={current} nativeContextItems={contextItems}
   conversationReading={{ reference: control, identity: control.run.runId, enabled: true }} />)
  const thread = container.querySelector('.conversation-native-thread')!, viewport = container.querySelector<HTMLElement>('.activity-feed')!
  const parent = [...thread.querySelectorAll<HTMLElement>('[data-native-record-ids]')].find(node => JSON.parse(node.dataset.nativeRecordIds!).includes('record-250'))!
  const head = parent.querySelector<HTMLButtonElement>('.wf-head')!
  await act(async () => head.click())
  const row = parent.querySelector<HTMLElement>('[data-native-record-id="record-250"]')!
  const step = row.querySelector<HTMLButtonElement>('[data-observation-step-id="record-250"]')!
  await act(async () => step.click())
  const body = row.querySelector<HTMLElement>('.log-turn__body')!
  const trace = body.querySelector<HTMLDetailsElement>('[data-trace-kind="reasoning"]')!
  await act(async () => { trace.open = true; trace.dispatchEvent(new Event('toggle')) })
  const text = [...body.querySelectorAll('p')].find(node => node.textContent === 'Process 250')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 7); window.getSelection()!.addRange(range)
  expect(window.getSelection()!.toString()).toBe('Process')
  viewport.getBoundingClientRect = () => rect(100, 200); row.getBoundingClientRect = () => rect(110)
  const preserved = () => {
   expect(container.querySelector('.conversation-native-thread')).toBe(thread)
   expect(row.closest('[data-native-record-ids]')).toBe(parent); expect(parent.isConnected).toBe(true)
   expect(row.querySelector('.log-turn__body')).toBe(body); expect(body.isConnected).toBe(true)
   expect(head.getAttribute('aria-expanded')).toBe('true'); expect(step.getAttribute('aria-expanded')).toBe('true'); expect(trace.open).toBe(true)
   expect(window.getSelection()!.getRangeAt(0)).toBe(range); expect(window.getSelection()!.toString()).toBe('Process')
   expect(conversationReadingAnchor(viewport)).toEqual({ kind: 'record', id: 'record-250', offset: 10 })
  }
  expect(thread.querySelector('[role="separator"]')).toBeNull()
  await click('Earlier'); expect(ids()[0]).toBe('record-240'); preserved()
  expect(thread.querySelector('[role="separator"]')).toBeNull() // The actual displayed origin has not been reached.
  await click('Earlier'); expect(ids()[0]).toBe('record-150'); preserved()
  const divider = thread.querySelector<HTMLElement>('.activity-feed__history-divider')!
  expect(divider).not.toBeNull(); expect(divider.parentElement).toBe(thread)
  expect(divider.previousElementSibling).not.toBeNull()
  expect(JSON.parse((divider.previousElementSibling as HTMLElement).dataset.nativeRecordIds!)).toEqual(Array.from({ length: 10 }, (_, n) => `record-${150 + n}`))
  expect(divider.nextElementSibling).toBe(parent)
  const previous = await client.sessionHistoryPage(sid, { limit: 1, cursor: olderContext.nextCursor! })
  expect(previous.items[0]!.id).toBe('record-159')
  expect(divider.textContent).toBe(`以上是历史消息（${new Date(previous.items[0]!.startedAt!).toLocaleString()}）`)
  await click('Earlier'); expect(ids()[0]).toBe('record-060'); preserved()
  expect(thread.querySelector('.activity-feed__history-divider')).toBe(divider); expect(divider.nextElementSibling).toBe(parent)
  await click('Current'); preserved(); expect(thread.querySelector('[role="separator"]')).toBeNull()
 })
 it('marks only a confirmed old-only loaded tail after the current cut is evicted, and does not invent a cut on an initial read', async () => {
  await writeFile(transcript, Array.from({ length: 720 }, (_, n) => JSON.stringify(record(n))).join('\n') + '\n')
  const current = await client.sessionHistoryPage(sid, { limit: 30 })
  await render(<ActivityView sessionId={sid} items={[]} capability="complete-events" nativeHistoryPage={current}
   conversationReading={{ reference: control, identity: control.run.runId, enabled: true }} />)
  expect(container.querySelector('.activity-feed__history-divider')).toBeNull()
  await click('Earlier')
  let divider = container.querySelector<HTMLElement>('.activity-feed__history-divider')!
  expect(divider.nextElementSibling).not.toBeNull()
  for (let n = 0; n < 4; n++) await click('Earlier')
  expect(ids()).toHaveLength(400); expect(ids()).not.toContain('record-690')
  divider = container.querySelector<HTMLElement>('.activity-feed__history-divider')!
  expect(divider.parentElement?.className).toBe('conversation-native-thread'); expect(divider.nextElementSibling).toBeNull()
  expect(ids().at(-1)).toBe('record-639')
  expect(divider.textContent).toBe(`以上是历史消息（${new Date(record(639).timestamp).toLocaleString()}）`)
  await click('Current'); expect(ids().at(-1)).toBe('record-719'); expect(container.querySelector('.activity-feed__history-divider')).toBeNull()
  await act(async () => root.unmount()); root = createClientUiRoot(container)
  await render(<ActivityView sessionId={sid} items={[]} capability="complete-events"
   conversationReading={{ reference: control, identity: 'retired-without-current-context', enabled: true, opened: true }} />)
  expect(ids().length).toBeGreaterThan(0); expect(container.querySelector('.activity-feed__history-divider')).toBeNull()
 })
 it('reads from the current Conversation on the first upward wheel, continues original pages and stops at their end', async () => {
  await seed(); await render(pane())
  expect(container.querySelector('[data-conversation-reading]')?.getAttribute('data-conversation-reading')).toBe('current')
  const current = ids(), visited = new Set(current)
  expect(current.at(-1)).toBe('record-359'); const before = requests.length
  await wheel()
  expect(requests.length).toBeGreaterThan(before); expect(ids()[0]).toBe('record-240')
  ids().forEach(id => visited.add(id))
  for (let page = 0; page < 3; page++) {
   await wheel(); const actual = ids()
   const start = Math.max(0, 150 - page * 90)
   expect(actual).toEqual(Array.from({ length: 360 - start }, (_, n) => `record-${String(n + start).padStart(3, '0')}`))
   expect(new Set(actual).size).toBe(actual.length); actual.forEach(id => visited.add(id))
  }
  expect(visited.size).toBe(360)
  const ended = requests.length; await wheel(); await wheel()
  expect(requests).toHaveLength(ended); expect(requests.every(read => read.limit === 30)).toBe(true)
  expect(useAppStore.getState().sessions[0]!.control).toEqual(control)
  expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('ORIGINAL UNSENT DRAFT')
 })
 it('does not read on downward or non-top wheel, hidden surfaces, or a second wheel during the same pending page', async () => {
  await render(compose()); const before = requests.length
  await wheel(100); await wheel(-100, 81)
  expect(requests).toHaveLength(before)
  await render(compose(false)); await wheel()
  expect(requests).toHaveLength(before); await render(compose())
  let release!: (page: AgentSessionHistoryPage) => void
  const page = recent!.nativeHistoryPage!, pending = new Promise<AgentSessionHistoryPage>(resolve => { release = resolve })
  vi.mocked(api.sessions.historyPage).mockImplementationOnce((_reference, options) => { requests.push(options ?? {}); return pending })
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!; viewport.scrollTop = 0
  await act(async () => {
   viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }))
   viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }))
  })
  expect(requests).toHaveLength(before + 1); expect(requests.at(-1)!.cursor).toBe(page.nextCursor)
  await act(async () => release(await client.sessionHistoryPage(sid, { limit: 30, cursor: page.nextCursor! }))); await flush()
  expect(ids()).toHaveLength(120); expect(requests).toHaveLength(before + 3)
 })
 it('preserves the current original body, expanded trace, Range and visible anchor through the first wheel prepend', async () => {
  await render(compose())
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!, body = viewport.querySelector<HTMLElement>('[data-native-record-id="record-353"] .log-turn__body')!
  expect(body).not.toBeNull(); const row = body.closest<HTMLElement>('[data-native-record-id]')!
  viewport.getBoundingClientRect = () => rect(100, 200); row.getBoundingClientRect = () => rect(110)
  const trace = body.querySelector<HTMLDetailsElement>('[data-trace-kind="reasoning"]')!
  trace.open = true; const text = [...body.querySelectorAll('p')].find(node => node.textContent === 'Reply 353')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 5); window.getSelection()!.addRange(range)
  await wheel()
  expect(ids()).toHaveLength(120); expect(body.isConnected).toBe(true); expect(trace.open).toBe(true)
  expect(window.getSelection()!.getRangeAt(0)).toBe(range); expect(window.getSelection()!.toString()).toBe('Reply')
  expect(conversationReadingAnchor(viewport)).toEqual({ kind: 'record', id: 'record-353', offset: 10 })
  expect(viewport.scrollTop).toBe(0)
 })
 it('retains the current records and opaque cursor after a first-wheel read failure, then explicitly retries that original page', async () => {
  await render(compose()); const before = ids(), page = recent!.nativeHistoryPage!, count = requests.length
  vi.mocked(api.sessions.historyPage).mockImplementationOnce(async (_reference, options) => { requests.push(options ?? {}); throw new Error('Private read unavailable') })
  await wheel()
  expect(ids()).toEqual(before); expect(requests.at(-1)!.cursor).toBe(page.nextCursor)
  expect(container.textContent).toContain('Private read unavailable'); await flush(); expect(requests).toHaveLength(count + 1)
  await click('Retry'); expect(ids()).toHaveLength(120)
  expect(requests[count + 1]!.cursor).toBe(page.nextCursor)
 })
 it('uses the same wheel navigation with actual public indexed stdio history and its opaque cursor', async () => {
  const script = join(home, 'indexed-history.mjs'), log = join(home, 'indexed-requests.jsonl')
  await writeFile(script, `import{appendFileSync}from'node:fs';import{createInterface}from'node:readline';
const records=Array.from({length:120},(_,n)=>({turnId:'turn-'+n,item:{type:n%2?'agentMessage':'userMessage',id:'indexed-'+n,...(n%2?{text:'Reply '+n}:{content:[{type:'text',text:'Input '+n}]})}}));
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);appendFileSync(${JSON.stringify(log)},line+'\\n');const send=result=>process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');if(r.method==='initialize')send({userAgent:'private-indexed-reader'});else if(r.method==='thread/read')send({thread:{id:${JSON.stringify(native)},historyMode:'paginated',turns:[]}});else if(r.method==='thread/items/list'){const end=r.params.cursor?Number(r.params.cursor):records.length,start=Math.max(0,end-r.params.limit);send({data:records.slice(start,end).reverse(),nextCursor:start?String(start):null})}});`)
  const next = { ...stored, providerId: 'codex', executorId: 'codex', nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: native }, updatedAt: 2 }
  await store.compareAndSwap(stored, next); stored = next; originalStore = await readFile(join(home, 'sessions.json'))
  vi.mocked(api.sessions.historyPage).mockImplementation((reference, options) => {
   expect(reference.agentSessionId).toBe(sid); requests.push(options ?? {})
   const promise = client.sessionHistoryPage(sid, { ...options, commandOverride: process.execPath, args: [script] }); promises.push(promise); return promise
  })
  const current = await client.sessionHistoryPage(sid, { limit: 30, commandOverride: process.execPath, args: [script] })
  expect(current.source).toEqual({ providerId: 'codex', nativeSessionId: native }); expect(current.nextCursor).not.toBeNull()
  await render(<ActivityView sessionId={sid} items={[]} capability="complete-events" nativeHistoryPage={current}
   conversationReading={{ reference: control, identity: control.run.runId, enabled: true }} />)
  await wheel(); expect(ids()).toEqual(Array.from({ length: 120 }, (_, n) => `indexed-${n}`))
  const ended = requests.length; await wheel(); expect(ids()).toHaveLength(120); expect(requests).toHaveLength(ended)
  const count = requests.length; await wheel(); expect(requests).toHaveLength(count)
  const actual = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(request => request.method === 'thread/items/list')
  expect(actual.map(request => request.params)).toEqual([undefined, '90', '60', '30'].map(cursor => ({ threadId: native, sortDirection: 'desc', limit: 30, ...(cursor ? { cursor } : {}) })))
 })
 it('continues beyond 290 records and a 201-process burst without losing raw pages or moving shared recent facts', async () => {
  await render(compose())
  const currentIds = recent!.nativeHistoryPage!.items.map(item => item.id)
  expect(currentIds.length).toBeGreaterThan(0); expect(currentIds.at(-1)).toBe('record-359')
  await click('Earlier')
  expect(ids()).toHaveLength(120)
  expect(ids()).toEqual(Array.from({ length: 120 }, (_, n) => `record-${String(n + 240).padStart(3, '0')}`))
  const visited = new Set(ids())
  for (let page = 0; page < 3; page++) {
   await click('Earlier')
   const actual = ids(); expect(actual.length).toBeLessThanOrEqual(400)
   const start = Math.max(0, 150 - page * 90)
   expect(actual[0]).toBe(`record-${String(start).padStart(3, '0')}`)
   expect(actual).toEqual(Array.from({ length: 360 - start }, (_, n) => `record-${String(n + start).padStart(3, '0')}`))
   actual.forEach(id => visited.add(id))
   expect(recent!.nativeHistoryPage!.items.map(item => item.id)).toEqual(currentIds)
  }
  expect(visited.size).toBe(360)
  expect(container.querySelectorAll('.activity-feed')).toHaveLength(1)
  expect(container.querySelector('.activity-feed__history-divider')?.textContent).toContain('以上是历史消息')
  expect(requests.every(options => options.limit === 30)).toBe(true)
 })
 it('allows explicit deep-window Current navigation without a Range, while original records retain their source identity', async () => {
  await render(compose()); await click('Earlier'); await click('Earlier'); await click('Earlier'); await click('Earlier')
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!
  viewport.getBoundingClientRect = () => rect(0, 200)
  const group = viewport.querySelector<HTMLElement>('[data-native-record-ids]')!
  group.querySelector<HTMLElement>('.wf-head')!.getBoundingClientRect = () => rect(10)
  expect(conversationReadingAnchor(viewport)?.kind).toBe('group')
  await click('Current')
  expect(ids().at(-1)).toBe('record-359')
  expect(container.querySelector('[data-conversation-reading]')?.getAttribute('data-conversation-reading')).toBe('current')
 })
 it('keeps same-source recent native input out of a historical raw window, while captured input and Current remain reachable', async () => {
  await writeFile(transcript, Array.from({ length: 720 }, (_, n) => JSON.stringify(record(n))).join('\n') + '\n')
  await store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: { id: 'accepted-independent-input', agentSessionId: sid,
   kind: 'user_message', source: 'user', sourceChannel: 'message-tool', title: 'Accepted input', status: 'complete', content: 'Independent Message Tool input', createdAt: 1, updatedAt: 1 } })
  const timeline = await client.sessionTimeline(sid)
  const Reader = () => { const facts = useSessionUserMessages(control, { enabled: true }); recent = facts
   return <ActivityView sessionId={sid} items={timeline.items} userMessages={facts.messages} nativeHistoryPage={facts.nativeHistoryPage} nativeContextItems={facts.nativeContextItems} capability="complete-events"
    userMessageRead={{ loading: facts.loading, error: facts.error, hasMore: facts.hasMore, windowIncomplete: facts.windowIncomplete, onRetry: facts.refresh, onReadEarlier() {} }}
    conversationReading={{ reference: control, identity: control.run.runId, enabled: true }} /> }
  await render(<Reader />)
  expect(container.textContent).toContain('Input 712'); for (let batch = 0; batch < 5; batch++) await click('Earlier')
  expect(ids()).not.toContain('record-712'); expect(container.textContent).not.toContain('Input 712')
  expect(container.textContent).toContain('Independent Message Tool input')
  expect(recent!.messages.find(message => message.rawId === 'record-712')?.content).toContain('Input 712')
  await click('Current'); expect(container.textContent).toContain('Input 712'); expect(container.textContent).toContain('Independent Message Tool input')
 })
 it('keeps the displayed original page and its actual cursor when legal public pages exceed the local reading memory budget together', async () => {
  await writeFile(transcript, Array.from({ length: 90 }, (_, n) => JSON.stringify({ ...record(n), type: 'assistant',
   message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Original process '.repeat(4400) }] } })).join('\n') + '\n')
  const current = await client.sessionHistoryPage(sid, { limit: 30 })
  expect(current.items).toHaveLength(30); expect(current.nextCursor).not.toBeNull()
  await render(<ActivityView sessionId={sid} items={[]} capability="complete-events" nativeHistoryPage={current}
   userMessageRead={{ loading: false, error: null, hasMore: true, onRetry() {}, onReadEarlier() {} }}
   conversationReading={{ reference: control, identity: control.run.runId, enabled: true }} />)
  const before = ids(), head = container.querySelector<HTMLElement>('[data-native-record-ids] .wf-head')!
  await click('Earlier')
  expect(ids()).toEqual(before); expect(head.isConnected).toBe(true)
  expect(container.querySelector('.activity-feed__read-notice')?.textContent).toContain('byte budget')
  expect(requests).toHaveLength(2); expect(requests[0]!.cursor).toBe(current.nextCursor)
  expect(requests.every(read => read.limit === 30)).toBe(true)
 })
 it('keeps every original adjacent raw record when a real shared observation projection has clipped older process facts', async () => {
  await render(compose())
  for (let batch = 0; batch < 6; batch++) {
   const n = 360 + batch * 30
   await appendFile(transcript, Array.from({ length: 30 }, (_, offset) => JSON.stringify({ ...record(n + offset), type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: `Observed process ${n + offset}` }] } })).join('\n') + '\n')
   await act(async () => observation?.({ agentSessionId: sid, source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated' })); await flush()
  }
  expect(recent!.windowIncomplete).toBe(true)
  const current = ids(); expect(current.length).toBeGreaterThan(0)
  expect(container.textContent).toContain('Reply 353'); expect(container.textContent).toContain('Input 352')
  expect(recent!.nativeContextItems.find(item => item.id === 'record-353')?.contentParts).toBeDefined()
  expect(recent!.messages.find(message => message.rawId === 'record-352')?.content).toContain('Input 352')
  const original = recent!.nativeHistoryPage!, rawIds = original.items.map(item => Number(item.id.slice('record-'.length)))
  expect(rawIds).toEqual(Array.from({ length: rawIds.length }, (_, n) => rawIds[0]! + n))
  await click('Earlier')
  const actual = ids(), ordinals = actual.map(id => Number(id.slice('record-'.length)))
  expect(actual.length).toBeLessThanOrEqual(400)
  if (process.env.AGENTMUX_UNIFIED_GAP_OBSERVATIONS) await writeFile(process.env.AGENTMUX_UNIFIED_GAP_OBSERVATIONS, JSON.stringify({ windowIncomplete: recent!.windowIncomplete, recentIds: recent!.nativeHistoryPage!.items.map(item => item.id), currentIds: current, resultingIds: actual, ordinals, gaps: ordinals.flatMap((n, index) => index && n !== ordinals[index - 1]! + 1 ? [{ before: ordinals[index - 1], after: n }] : []), requests, controls: controls.map(spy => spy.mock.calls.length) }, null, 2))
  expect(ordinals).toEqual(Array.from({ length: ordinals.length }, (_, n) => ordinals[0]! + n))
  expect(ordinals[0]).toBeLessThan(rawIds[0]!)
  if (process.env.AGENTMUX_UNIFIED_RECENT_FACTS) await writeFile(process.env.AGENTMUX_UNIFIED_RECENT_FACTS, JSON.stringify({ before: original, after: recent!.nativeHistoryPage }))
  expect(recent!.nativeHistoryPage).toStrictEqual(original)
  await click('Current'); expect(container.textContent).toContain('Reply 353'); expect(container.textContent).toContain('Input 352')
 })
 it('enters an original earlier window from an unselected context-only anchor, while selected context and real raw anchors keep their protection', async () => {
  await render(compose())
  for (let batch = 0; batch < 6; batch++) {
   const n = 360 + batch * 30
   await appendFile(transcript, Array.from({ length: 30 }, (_, offset) => JSON.stringify({ ...record(n + offset), type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: `Observed process ${n + offset}` }] } })).join('\n') + '\n')
   const reads = requests.length
   await act(async () => observation?.({ agentSessionId: sid, source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated' }))
   await vi.waitFor(async () => {
    await act(async () => { await Promise.allSettled([...promises]) })
    expect(requests.length).toBeGreaterThan(reads); expect(recent!.loading).toBe(false)
    expect(recent!.nativeHistoryPage!.items.at(-1)!.id).toBe(`record-${n + 29}`)
   }, { interval: 10, timeout: 2000 })
  }
  const original = recent!.nativeHistoryPage!, viewport = container.querySelector<HTMLElement>('.activity-feed')!
  const old = viewport.querySelector<HTMLElement>('[data-native-record-id="record-353"]')!
  expect(original.items[0]!.id).toBe('record-450'); expect(old).not.toBeNull(); expect(original.items.some(item => item.id === 'record-353')).toBe(false)
  viewport.getBoundingClientRect = () => rect(0, 200); old.getBoundingClientRect = () => rect(10)
  const text = [...old.querySelectorAll('p')].find(p => p.textContent === 'Reply 353')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 5); window.getSelection()!.addRange(range)
  const before = ids(), count = requests.length; await click('Earlier')
  expect(ids()).toEqual(before); expect(old.isConnected).toBe(true); expect(window.getSelection()!.toString()).toBe('Reply')
  expect(recent!.nativeHistoryPage).toBe(original)
  window.getSelection()!.removeAllRanges(); await click('Earlier')
  expect(ids()).toEqual(Array.from({ length: 180 }, (_, n) => `record-${360 + n}`))
  expect(requests[count]!.cursor).toBe(original.nextCursor); expect(requests[count + 3]!.cursor).toBe(original.nextCursor)
  expect(requests.slice(count)).toHaveLength(6)
  expect(recent!.nativeHistoryPage).toBe(original); expect(recent!.nativeContextItems.some(item => item.id === 'record-353')).toBe(true)
 })
 it('preserves observed native input when no page exists or the actual public page has a different source', async () => {
  const originalPage = await client.sessionHistoryPage(sid)
  const messages = projectSessionUserMessages({ agentSessionId: sid, historyPage: originalPage })
  expect(messages.find(message => message.rawId === 'record-352')?.content).toContain('Input 352')
  await render(<ActivityView sessionId={sid} items={[]} userMessages={messages} capability="complete-events" />)
  expect(container.textContent).toContain('Input 352')
  const nextNative = 'different-public-native', nextTranscript = join(home, 'different-source.jsonl')
  await writeFile(nextTranscript, Array.from({ length: 360 }, (_, n) => JSON.stringify({ ...record(n), sessionId: nextNative, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Different original process' }] } })).join('\n') + '\n')
  const next = { ...stored, updatedAt: 2, nativeHandle: { kind: 'provider' as const, providerId: 'claude', sessionId: nextNative, transcriptPath: nextTranscript } }
  await store.compareAndSwap(stored, next); stored = next; originalStore = await readFile(join(home, 'sessions.json'))
  await render(<ActivityView sessionId={sid} items={[]} userMessages={messages} capability="complete-events"
   conversationReading={{ reference: control, identity: control.run.runId, enabled: true, opened: true }} />)
  expect(container.querySelector('[data-native-source]')?.getAttribute('data-native-source')).toBe(JSON.stringify(['claude', nextNative]))
  expect(container.textContent).toContain('Input 352')
 })
 it('protects the real visible current anchor on the very first Earlier entry without advancing past an unread page', async () => {
  const latest = await client.sessionHistoryPage(sid, { limit: 100 })
  const older = await client.sessionHistoryPage(sid, { limit: 100, cursor: latest.nextCursor! })
  const current = { ...latest, items: [...older.items, ...latest.items], nextCursor: older.nextCursor }
  await render(<ActivityView sessionId={sid} items={[]} capability="complete-events" nativeHistoryPage={current}
   userMessageRead={{ loading: false, error: null, hasMore: current.nextCursor !== null, onRetry() {}, onReadEarlier() {} }}
   conversationReading={{ reference: control, identity: control.run.runId, enabled: true }} />)
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!, before = ids()
  const first = viewport.querySelector<HTMLElement>('[data-native-record-ids] .wf-head')!
  expect(before).toHaveLength(200); expect(before.includes('record-359')).toBe(true)
  viewport.getBoundingClientRect = () => rect(0, 200); first.getBoundingClientRect = () => rect(10)
  await click('Earlier')
  expect(ids()).toHaveLength(290); expect(ids()[0]).toBe('record-070')
  expect(first.isConnected).toBe(true)
  expect(requests[0]!.cursor).toBe(current.nextCursor)
  expect(requests).toHaveLength(3)

 })
 it('keeps a real visible raw anchor when Earlier would remove it, then advances the same cursor after deliberate upward reading', async () => {
  await writeFile(transcript, Array.from({ length: 720 }, (_, n) => JSON.stringify(record(n))).join('\n') + '\n')
  const current = await client.sessionHistoryPage(sid, { limit: 90 })
  await render(<ActivityView sessionId={sid} items={[]} capability="complete-events" nativeHistoryPage={current}
   userMessageRead={{ loading: false, error: null, hasMore: true, onRetry() {}, onReadEarlier() {} }}
   conversationReading={{ reference: control, identity: control.run.runId, enabled: true }} />)
  for (let batch = 0; batch < 3; batch++) await click('Earlier')
  const acceptedCursor = (await promises.at(-1)!).nextCursor, rejectedStart = requests.length
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!, original = ids()
  const tail = viewport.querySelector<HTMLElement>('[data-native-record-id="record-713"]')!
  viewport.getBoundingClientRect = () => rect(0, 200); tail.getBoundingClientRect = () => rect(10)
  await click('Earlier'); expect(ids()).toEqual(original); expect(tail.isConnected).toBe(true)
  expect(requests[rejectedStart]!.cursor).toBe(acceptedCursor)
  const retained = viewport.querySelector<HTMLElement>('[data-native-record-id="record-369"]')!
  tail.getBoundingClientRect = () => rect(-200); retained.getBoundingClientRect = () => rect(10)
  viewport.scrollTop = 10; await act(async () => viewport.dispatchEvent(new Event('scroll')))
  const retryStart = requests.length
  await click('Earlier'); expect(ids()).toHaveLength(400); expect(ids()[0]).toBe('record-270')
  expect(retained.isConnected).toBe(true); expect(requests[retryStart]!.cursor).toBe(acceptedCursor)
 })
 it('keeps selected Workflow step-count text and the actual cursor until selection clears, then reads genuinely earlier records', async () => {
  const current = await client.sessionHistoryPage(sid, { limit: 90 })
  await render(<ActivityView sessionId={sid} items={[]} capability="complete-events" nativeHistoryPage={current}
   userMessageRead={{ loading: false, error: null, hasMore: true, onRetry() {}, onReadEarlier() {} }}
   conversationReading={{ reference: control, identity: control.run.runId, enabled: true }} />)
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!
  const head = viewport.querySelector<HTMLElement>('[data-native-record-ids] .wf-head')!
  const count = head.querySelector<HTMLElement>('.log-fold__steps')!
  expect(count.textContent).toBe('34 步')
  const range = document.createRange(); range.setStart(count.firstChild!, 0); range.setEnd(count.firstChild!, 2)
  window.getSelection()!.addRange(range); viewport.getBoundingClientRect = () => rect(0, 200); head.getBoundingClientRect = () => rect(10)
  const before = ids(); await click('Earlier')
  expect(ids()).toEqual(before); expect(head.isConnected).toBe(true); expect(range.startContainer.isConnected).toBe(true)
  expect(window.getSelection()!.toString()).toBe('34')
  window.getSelection()!.removeAllRanges(); await click('Earlier')
  expect(ids()[0]).toBe('record-180'); expect(ids()).toHaveLength(180); expect(head.isConnected).toBe(true)
  expect(requests).toHaveLength(6); expect(requests[0]!.cursor).toBe(current.nextCursor); expect(requests[3]!.cursor).toBe(current.nextCursor)
 })
 it('uses the public native source namespace, not a repeated raw ID, to protect a selected node through explicit source refresh', async () => {
  await render(<ActivityView sessionId={sid} items={[]} capability="complete-events"
   conversationReading={{ reference: control, identity: control.run.runId, enabled: true, opened: true }} />)
  const node = container.querySelector<HTMLElement>('[data-native-record-id="record-353"] .log-turn__body')!
  const text = [...node.querySelectorAll('p')].find(p => p.textContent === 'Reply 353')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 5); window.getSelection()!.addRange(range)
  const nextNative = 'public-new-source-same-raw-ids', nextTranscript = join(home, 'new-source.jsonl')
  await writeFile(nextTranscript, Array.from({ length: 360 }, (_, n) => JSON.stringify({ ...record(n), sessionId: nextNative })).join('\n') + '\n')
  const next = { ...stored, updatedAt: 2, nativeHandle: { kind: 'provider' as const, providerId: 'claude', sessionId: nextNative, transcriptPath: nextTranscript } }
  await store.compareAndSwap(stored, next); stored = next; originalStore = await readFile(join(home, 'sessions.json'))
  const actualNewPage = await client.sessionHistoryPage(sid)
  expect(actualNewPage.source.nativeSessionId).toBe(nextNative); expect(actualNewPage.items.at(-1)!.id).toBe('record-359')
  await click('Current')
  expect(node.isConnected).toBe(true); expect(window.getSelection()!.toString()).toBe('Reply')
  expect(container.querySelector('[data-native-source]')?.getAttribute('data-native-source')).toBe(JSON.stringify(['claude', native]))
  window.getSelection()!.removeAllRanges(); await click('Current')
  expect(node.isConnected).toBe(false)
  expect(container.querySelector('[data-native-source]')?.getAttribute('data-native-source')).toBe(JSON.stringify(['claude', nextNative]))
 })
 it('keeps selected overlap bodies and trace disclosures through prepend and observation append', async () => {
  await writeFile(transcript, Array.from({ length: 720 }, (_, n) => JSON.stringify(record(n))).join('\n') + '\n')
  await render(compose())
  await click('Earlier')
  const body = container.querySelector<HTMLElement>('[data-native-record-id="record-681"] .log-turn__body')!
  expect(body.textContent).toContain('Reply 681')
  const text = [...body.querySelectorAll('p')].find(p => p.textContent === 'Reply 681')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 5); window.getSelection()!.addRange(range)
  const trace = body.querySelector<HTMLDetailsElement>('[data-trace-kind="reasoning"]')!
  await act(async () => { trace.open = true; trace.dispatchEvent(new Event('toggle')) })
  expect(trace.textContent).toContain('Trace 681')
  await click('Earlier')
  expect(body.isConnected).toBe(true); expect(window.getSelection()!.toString()).toBe('Reply')
  expect(body.querySelector('[data-trace-kind="reasoning"]')).toBe(trace); expect(trace.open).toBe(true)
  await click('Earlier'); await click('Earlier')
  const rejectedStart = requests.length; await click('Earlier')
  // This read would discard selected record681 in the newest page; cursor remains at the accepted window.
  const lastCursor = requests[rejectedStart]?.cursor
  expect(container.textContent).toContain('records and cursor are kept')
  expect(body.isConnected).toBe(true)
  await appendFile(transcript, JSON.stringify(record(720)) + '\n')
  await act(async () => observation?.({ source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated', agentSessionId: sid }))
  await flush()
  expect(ids()).toContain('record-681'); expect(window.getSelection()!.toString()).toBe('Reply')
  window.getSelection()!.removeAllRanges(); const retryStart = requests.length; await click('Earlier')
  expect(requests[retryStart]?.cursor).toBe(lastCursor)
 })
 it('does not start a hidden read or commit a hidden late page, while another visible recent consumer remains usable', async () => {
  await render(compose()); await click('Earlier')
  const before = ids(), originalRead = api.sessions.historyPage
  let release!: (page: AgentSessionHistoryPage) => void
  const pending = new Promise<AgentSessionHistoryPage>(resolve => { release = resolve })
  vi.mocked(api.sessions.historyPage).mockImplementationOnce(() => pending)
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Earlier')!
  await act(async () => button.click())
  await render(compose(false))
  const actual = await client.sessionHistoryPage(sid, requests.at(-1))
  await act(async () => release(actual)); await flush()
  expect(ids()).toEqual(before)
  const reads = requests.length
  await act(async () => button.click()); await flush(); expect(requests).toHaveLength(reads)
  expect(recent!.messages.length).toBeGreaterThan(0)
  expect(originalRead).toBeDefined()
 })
 it('keeps a legitimate290-raw recent page plus3 public30-raw pages with the original body and Range', async () => {
  await writeFile(transcript, Array.from({ length: 380 }, (_, n) => JSON.stringify(n >= 90 && n < 290
   ? { ...record(n), type: 'user', message: { role: 'user', content: `Original maximum input ${n}` } }
   : { ...record(n), type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: `Original maximum process ${n}` }] } })).join('\n') + '\n')
  const tail = await client.sessionHistoryPage(sid, { limit: 100 })
  const middle = await client.sessionHistoryPage(sid, { limit: 100, cursor: tail.nextCursor! })
  const front = await client.sessionHistoryPage(sid, { limit: 90, cursor: middle.nextCursor! })
  const current = { ...front, items: [...front.items, ...middle.items, ...tail.items] }
  expect(current.items).toHaveLength(290)
  expect(current.items.filter(item => item.kind === 'activity')).toHaveLength(90)
  expect(current.items.filter(item => item.kind === 'user-message')).toHaveLength(200)
  await render(<ActivityView sessionId={sid} items={[]} capability="complete-events" nativeHistoryPage={current}
   conversationReading={{ reference: control, identity: control.run.runId, enabled: true }} />)
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!, row = viewport.querySelector<HTMLElement>('[data-native-record-id="record-289"]')!
  const body = row.querySelector<HTMLElement>('.log-turn__body')!, paragraph = body.querySelector('p')!
  viewport.getBoundingClientRect = () => rect(0, 200); row.getBoundingClientRect = () => rect(10)
  const range = document.createRange(); range.selectNodeContents(paragraph); window.getSelection()!.addRange(range)
  expect(container.querySelectorAll('.conversation-ruler__earlier[data-available]')).toHaveLength(1)
  expect([...container.querySelectorAll('button')].filter(button => ['Earlier', 'Read earlier records'].includes(button.textContent?.trim() ?? ''))).toHaveLength(1)
  await click('Earlier')
  expect(ids()).toEqual(Array.from({ length: 380 }, (_, n) => `record-${String(n).padStart(3, '0')}`))
  expect(requests).toHaveLength(3); expect(requests.every(read => read.limit === 30)).toBe(true)
  expect(requests[0]!.cursor).toBe(current.nextCursor)
  expect(requests[1]!.cursor).toBe((await promises[0]!).nextCursor)
  expect(requests[2]!.cursor).toBe((await promises[1]!).nextCursor)
  if (process.env.AGENTMUX_EARLIER_SCENE_PAGE) await writeFile(process.env.AGENTMUX_EARLIER_SCENE_PAGE, JSON.stringify({ provenance: 'Controlled native Claude syntax -> real FileStore/public Core SDK pages; no vendor writer or installed user session', current, earlierPages: await Promise.all(promises), requests }, null, 2) + '\n')
  expect(body.isConnected).toBe(true); expect(row.querySelector('.log-turn__body')).toBe(body)
  expect(window.getSelection()!.getRangeAt(0)).toBe(range); expect(window.getSelection()!.toString()).toBe('Original maximum input 289')
  expect(conversationReadingAnchor(viewport)).toEqual({ kind: 'record', id: 'record-289', offset: 10 })
  expect(container.querySelector('.conversation-ruler__unread-edge')).toBeNull()
 })
 it('shows actual sticky batch loading without a second demand, keeps the old cursor on page2 failure and explicitly retries', async () => {
  await render(compose()); const before = ids(), oldBody = container.querySelector('[data-native-record-id="record-353"] .log-turn__body')!, page = recent!.nativeHistoryPage!, start = requests.length
  const earlier = container.querySelector<HTMLButtonElement>('.conversation-ruler__earlier')!, slider = container.querySelector<HTMLElement>('[role="slider"]')!
  expect(container.querySelector('.conversation-ruler__unread-edge')).not.toBeNull()
  const reads = requests.length
  await act(async () => { earlier.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); slider.focus(); slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
  expect(requests).toHaveLength(reads); expect(container.querySelector('.activity-ruler__readout')).not.toBeNull()
  let release!: (page: AgentSessionHistoryPage) => void
  const pending = new Promise<AgentSessionHistoryPage>(resolve => { release = resolve })
  vi.mocked(api.sessions.historyPage).mockImplementationOnce((_reference, options) => { requests.push(options ?? {}); return pending })
   .mockImplementationOnce(async (_reference, options) => { requests.push(options ?? {}); throw new Error('Original second page unavailable') })
  await act(async () => earlier.click())
  expect(container.querySelector('.activity-ruler__readout')).toBeNull()
  const status = container.querySelector<HTMLElement>('.activity-ruler__count[data-loading]')!
  expect(status).not.toBeNull(); expect(status.textContent).toContain('Reading'); expect(status.getAttribute('role')).toBe('status'); expect(status.getAttribute('aria-live')).toBe('polite')
  expect(status.querySelector('svg.wf-streaming-glyph')).not.toBeNull(); expect(container.querySelector('.activity-feed')?.hasAttribute('aria-busy')).toBe(false)
  expect(earlier.disabled).toBe(true); expect(slider.getAttribute('aria-disabled')).toBeNull(); expect(oldBody.isConnected).toBe(true)
  await act(async () => { earlier.click(); container.querySelector('.activity-feed')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 })) })
  expect(requests).toHaveLength(start + 1)
  await act(async () => release(await client.sessionHistoryPage(sid, { limit: 30, cursor: page.nextCursor! }))); await flush()
  expect(ids()).toEqual(before); expect(requests).toHaveLength(start + 2); expect(oldBody.isConnected).toBe(true)
  expect(container.querySelector('.activity-ruler__count[data-loading]')).toBeNull(); expect(container.textContent).toContain('Original second page unavailable')
  const retryStart = requests.length; await click('Retry')
  expect(requests[retryStart]!.cursor).toBe(page.nextCursor); expect(requests).toHaveLength(retryStart + 3); expect(ids()).toHaveLength(120)
 })
 it('keeps unknown and reversed native times honest while the unread edge and overview never issue reads', async () => {
  await writeFile(transcript, Array.from({ length: 90 }, (_, n) => {
   const original = { ...record(n), type: 'user', timestamp: new Date(_hygiene_fixtureTime(-37225600000) + (90 - n) * 1000).toISOString(), message: { role: 'user', content: `Original reverse record ${n}` } }
   if (n % 3 === 0) Reflect.deleteProperty(original, 'timestamp')
   return JSON.stringify(original)
  }).join('\n') + '\n')
  const current = await client.sessionHistoryPage(sid, { limit: 30 })
  await render(<ActivityView sessionId={sid} items={[]} capability="complete-events" nativeHistoryPage={current}
   conversationReading={{ reference: control, identity: control.run.runId, enabled: true }} />)
  const before = ids(), reads = requests.length, edge = container.querySelector('.conversation-ruler__unread-edge')!
  expect(edge).not.toBeNull(); expect(edge.getAttribute('style')).toBeNull(); expect(edge.getAttribute('aria-hidden')).toBe('true')
  expect(container.querySelector('.conversation-ruler__earlier')?.getAttribute('title')).toContain('no time width')
  const overview = container.querySelector<HTMLButtonElement>('button[aria-label^="History window:"]')!
  expect(overview).not.toBeNull(); await act(async () => overview.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })))
  const all = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(item => item.textContent === 'All loaded records')
  expect(all).toBeDefined(); await act(async () => all!.click())
  const slider = container.querySelector<HTMLElement>('[role="slider"]')!
  await act(async () => { slider.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 20 })); slider.focus(); slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })
  expect(ids()).toEqual(before); expect(requests).toHaveLength(reads)
  expect(container.textContent).toContain('Original reverse record 60'); expect(container.textContent).toContain('Original reverse record 89')
  expect(container.querySelectorAll('[role="slider"]')).toHaveLength(1)
 })
 it('keeps a no-record first read visible with the public SVG and no invented zero-count slider', async () => {
  let release!: (page: AgentSessionHistoryPage) => void
  const pending = new Promise<AgentSessionHistoryPage>(resolve => { release = resolve })
  vi.mocked(api.sessions.historyPage).mockImplementationOnce((_reference, options) => { requests.push(options ?? {}); return pending })
  await act(async () => root.render(<ActivityView sessionId={sid} items={[]} capability="complete-events"
   conversationReading={{ reference: control, identity: control.run.runId, enabled: true, opened: true }} />))
  expect(container.querySelector('[role="slider"]')).toBeNull()
  const status = container.querySelector('.activity-feed__reading-status')!
  expect(status.textContent).toContain('Reading records'); expect(status.querySelector('svg.wf-streaming-glyph')).not.toBeNull()
  expect(requests).toEqual([{ limit: 30 }])
  await act(async () => release(await client.sessionHistoryPage(sid, { limit: 30 }))); await flush()
  expect(ids()).toHaveLength(90); expect(requests).toHaveLength(3)
  expect(container.querySelector('[role="slider"]')).not.toBeNull(); expect(container.querySelector('.activity-feed__reading-status')).toBeNull()
 })
 it('protects a connected Range crossing a middle-page record with neither endpoint inside it', async () => {
  await render(compose()); await click('Earlier')
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!
  const before = document.createTextNode('start'), after = document.createTextNode('end')
  const middle = document.createElement('div'); middle.dataset.nativeRecordId = 'evicted-middle'; middle.textContent = 'middle page'
  viewport.append(before, middle, after)
  const range = document.createRange(); range.setStart(before, 1); range.setEnd(after, 1)
  window.getSelection()!.addRange(range)
  expect(protectsConversationWindow(viewport, recent!.nativeHistoryPage!, false)).toBe(true)
 })
 it('keeps the window when the standard Range intersection cannot be established', async () => {
  await render(compose()); await click('Earlier')
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!
  const row = document.createElement('div'); row.dataset.nativeRecordId = 'protected-unknown'; row.textContent = 'Selected record'; viewport.append(row)
  const range = document.createRange(); range.selectNodeContents(row); window.getSelection()!.addRange(range)
  vi.spyOn(range, 'intersectsNode').mockImplementation(() => { throw new DOMException('Intersection unavailable') })
  expect(protectsConversationWindow(viewport, recent!.nativeHistoryPage!, false)).toBe(true)
 })
 it('keeps a selected folded Process title before explicit Current would evict the group', async () => {
  await render(compose()); await click('Earlier'); await click('Earlier'); await click('Earlier'); await click('Earlier')
  const group = container.querySelector<HTMLElement>('[data-native-record-ids]')!
  const label = group.querySelector<HTMLElement>('.wf-head .wf-observation__recorded')!
  expect(label.textContent).toBe('执行过程')
  const range = document.createRange(); range.selectNodeContents(label); window.getSelection()!.addRange(range)
  const before = ids(); await click('Current')
  expect(ids()).toEqual(before); expect(group.isConnected).toBe(true); expect(window.getSelection()!.toString()).toBe('执行过程')
  window.getSelection()!.removeAllRanges(); await click('Current'); expect(ids().at(-1)).toBe('record-359')
 })
 it('restores a retained folded group using its observation identity when prepend changes its raw-member list', async () => {
  await render(compose()); await click('Earlier'); await click('Earlier'); await click('Earlier')
  const viewport = container.querySelector<HTMLElement>('.activity-feed')!, group = viewport.querySelector<HTMLElement>('[data-native-record-ids]')!
  viewport.getBoundingClientRect = () => rect(100, 200)
  const head = group.querySelector<HTMLElement>('.wf-head')!; head.getBoundingClientRect = () => rect(110)
  const anchor = conversationReadingAnchor(viewport)!; expect(anchor.kind).toBe('group')
  group.dataset.nativeRecordIds = JSON.stringify(['new-member', ...JSON.parse(group.dataset.nativeRecordIds!)])
  head.getBoundingClientRect = () => rect(140)
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
 originalStore = await readFile(join(home, 'sessions.json'))
}

describe('Real caller ownership and healthy retained identities', () => {
 it('opens from Terminal in the same Activity, returns by body Escape and preserves original Terminal and draft', async () => {
  await seed('terminal'); await render(pane())
  const terminal = container.querySelector('[data-terminal-visible]')!
  expect(terminal.getAttribute('data-terminal-visible')).toBe('true'); expect(container.querySelector('.activity-feed')).toBeNull()
  await click('Header history')
  const feed = container.querySelector<HTMLElement>('.activity-feed')!
  expect(feed).not.toBeNull(); expect(ids()).toHaveLength(90)
  expect(feed.closest('.agent-body')?.getAttribute('data-observation-surface')).toBe('workflow')
  expect(terminal.isConnected).toBe(true); expect(terminal.getAttribute('data-terminal-visible')).toBe('false')
  const bodyControl = container.querySelector<HTMLElement>('[data-native-record-id="record-353"] button')!
  expect(bodyControl).not.toBeNull()
  await act(async () => { bodyControl.focus(); bodyControl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  await flush()
  expect(feed.isConnected).toBe(true); expect(feed.parentElement?.hidden).toBe(true)
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
  await seed(); await render(pane()); await click('Earlier')
  const feed = container.querySelector('.activity-feed')!, before = ids()
  let release!: (page: AgentSessionHistoryPage) => void
  vi.mocked(api.sessions.historyPage).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const earlier = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Earlier')!
  await act(async () => earlier.click()); await render(pane(false))
  await act(async () => release(await client.sessionHistoryPage(sid)))
  await flush(); expect(container.querySelector('.activity-feed')).toBe(feed); expect(ids()).toEqual(before)
  const count = requests.length; await act(async () => earlier.click()); await flush(); expect(requests).toHaveLength(count)
 })
 it('passes visible eligibility through the secondary cached ReactElement without redirecting its local earlier window', async () => {
  await seed(); const page = await client.sessionHistoryPage(sid)
  const stage = (visible: boolean) => <SessionActivityPresentation target={{ hostId: 'private-stage', active: true, visible,
    reference: { displayWorkspaceId: 'ws', groupId: 'group', tabId: 'tab', regionId: 'region' } }} regionId="region" sourceKey="original-source"
   sessionId={sid} name="Original Agent" executorLabel="Claude" executionHost={{ configured: true, id: 'local', cwd: stored.workspacePath, label: 'Private host', kind: 'local' }}
   activity={{ sessionId: sid, items: [], nativeHistoryPage: page, capability: 'complete-events',
    conversationReading: { reference: control, identity: control.run.runId, enabled: true },
    userMessageRead: { loading: false, error: null, hasMore: true, onRetry() {}, onReadEarlier() {} } }}
   eligible readOnly={false} resourceOrigin={{ workspaceId: 'ws', tabId: 'tab', regionId: 'region' }}
   renderFrame={content => content} selectRegion={() => {}} />
  await render(stage(true)); await click('Earlier'); expect(ids()).toHaveLength(120)
  let release!: (page: AgentSessionHistoryPage) => void
  vi.mocked(api.sessions.historyPage).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Earlier')!
  await act(async () => button.click()); await render(stage(false)); const before = ids()
  await act(async () => release(await client.sessionHistoryPage(sid))); await flush()
  expect(ids()).toEqual(before); const count = requests.length
  await act(async () => button.click()); await flush(); expect(requests).toHaveLength(count)
  await render(stage(true)); expect(ids()).toEqual(before)
  expect(container.textContent).not.toContain('original Session work surface. This presentation keeps')
 })
 it('keeps the idle-over-day pending recovery surface readable inline through the same Activity without starting a Run', async () => {
  await seed('terminal')
  const original = liveSession()
  useAppStore.setState({ sessions: [{ ...original, processState: 'exited', semanticStatus: { state: 'done', source: 'native-hook', observedAt: 1, stateEnteredAt: 1 } }] })
  const recover = vi.spyOn(useAppStore.getState(), 'recoverSession')
  await render(pane())
  const feed = container.querySelector<HTMLElement>('.activity-feed')!
  expect(feed).not.toBeNull(); expect(ids()).toHaveLength(90); expect(container.textContent).toContain('Input 352')
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
  expect(container.querySelectorAll('.activity-feed')).toHaveLength(1); expect(ids()).toHaveLength(90)
  expect(container.textContent).toContain('Captured Message Tool original'); expect(container.textContent).toContain('Input 352')
  expect(requests.every(request => request.limit === 30)).toBe(true)
  expect((await store.load()).length).toBe(0); expect((await store.loadRetiredAgentSessions()).length).toBe(1)
 })
 it('does not read for unrelated Store updates while an actual old window remains readable', async () => {
  await render(compose()); await click('Earlier'); const page = ids(), count = requests.length
  for (let n = 0; n < 20; n++) await act(async () => useAppStore.setState({ timelines: { unrelated: { agentSessionId: 'unrelated', revision: n, items: [] } } }))
  await flush(); expect(requests).toHaveLength(count); expect(ids()).toEqual(page)
 })
})
