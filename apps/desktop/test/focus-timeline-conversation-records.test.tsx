import { fixtureIso as _hygiene_fixtureIso } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { projectConversationRecords } from '@agentmux/client-ui/conversation-records'
import * as conversationRecords from '@agentmux/client-ui/conversation-records'
import * as messageGeometry from '../src/renderer/src/lib/focus-message-markers'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { localDateTime } from '../src/renderer/src/lib/focus-time-window'
// The actual Global/Store/Timeline/shared Hook and public Core/FileStore/Claude
// reader are mounted. Only the unrelated PTY observation leaf is isolated.
vi.mock('../src/renderer/src/components/SessionObservationRegions', () => ({ SessionObservationRegions: () => <output data-private-terminal-leaf /> }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'

const ID = 'private-agent', NOW = Date.parse(_hygiene_fixtureIso(24148800000, "second")), HOUR = 3_600_000, DRAFT = 'Original unsubmitted draft'
const initial = useAppStore.getState()
let fixture: Awaited<ReturnType<typeof nativeHistoryFixture>>, host: HTMLDivElement, root: Root
const extraFixtures: Awaited<ReturnType<typeof nativeHistoryFixture>>[] = []
let pages: AgentSessionHistoryPage[], reads: MockInstance<typeof api.sessions.historyPage>, controls: { mock: { calls: unknown[][] } }[]
function native(id: string, role: 'user' | 'assistant', text: unknown, at: number | null = NOW - HOUR / 2) {
  return { sessionId: 'native-main', uuid: id, type: role, message: { role, content: text }, ...(at === null ? {} : { timestamp: new Date(at).toISOString() }) }
}
const original = [native('u', 'user', 'Repeated original speech'), native('a', 'assistant', [{ type: 'thinking', thinking: 'Original recorded reasoning' }, { type: 'text', text: 'Repeated original speech' }]), native('thinking', 'assistant', [{ type: 'thinking', thinking: 'Reasoning without plain text' }])]
function captured(id: string, kind: 'user_message' | 'assistant_message', more: Partial<AgentTimelineItem> = {}): AgentTimelineItem {
  const at = more.createdAt ?? NOW - HOUR / 2
  return { id, agentSessionId: ID, kind, source: 'native-hook', status: 'complete', createdAt: at, updatedAt: at, title: 'Recorded speech', content: 'Repeated original speech', ...more }
}
const overlay = () => { const node = document.getElementById('agentmux-window-overlay-host'); expect(node).not.toBeNull(); return node! }
const markers = () => [...host.querySelectorAll<HTMLButtonElement>('.recent-focus__message')]
const rawIds = () => markers().flatMap(node => JSON.parse(node.dataset.messageRawIds!) as string[])
const recordIds = () => markers().flatMap(node => JSON.parse(node.dataset.messageIds!) as string[])
const recordCount = () => markers().reduce((count, node) => count + Number(node.dataset.recordCount), 0)
async function render(extra?: ReactNode) { await act(async () => root.render(<><GlobalFocusSurface />{extra}</>)) }
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 3000, interval: 10 }) }
async function click(selector: string) { const node = host.querySelector<HTMLElement>(selector) ?? overlay().querySelector<HTMLElement>(selector); expect(node, selector).not.toBeNull(); await act(async () => node!.click()) }
async function plotRecord(id: string) {
  const marker = markers().find(node => (JSON.parse(node.dataset.messageRawIds!) as string[]).includes(id)); expect(marker).toBeDefined()
  await act(async () => marker!.click())
  if (Number(marker!.dataset.recordCount) > 1) { const item = overlay().querySelector<HTMLElement>(`[data-record-raw-id="${id}"]`); expect(item).not.toBeNull(); await act(async () => item!.click()) }
}
async function textButton(text: string) { const node = [...overlay().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text); expect(node, text).toBeDefined(); await act(async () => node!.click()) }
async function records() { await click('[aria-label="View conversation records"]'); await wait(() => expect(overlay().querySelector('[aria-label="Available conversation records"]')).not.toBeNull()) }
async function seedCaptured(items: AgentTimelineItem[]) {
  for (const item of items) await fixture.store.applyTimelineMutation({ type: 'append', agentSessionId: ID, item })
  const timeline = await fixture.client.sessionTimeline(ID)
  await act(async () => useAppStore.setState({ timelines: { [ID]: timeline } }))
}
// The original ruler observes this actual mounted scale element; this fixture
// supplies layout in HappyDOM, where border boxes otherwise report zero.
function measuredTimeline(initialWidth: number) {
  let width = initialWidth
  const observers = new Set<{ callback: ResizeObserverCallback; value: ResizeObserver }>()
  const originalBounds = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('recent-focus__time-scale') ? new DOMRect(0, 0, width, 18) : originalBounds.call(this)
  })
  vi.stubGlobal('ResizeObserver', class {
    private entry: { callback: ResizeObserverCallback; value: ResizeObserver }
    constructor(callback: ResizeObserverCallback) { this.entry = { callback, value: this as unknown as ResizeObserver }; observers.add(this.entry) }
    observe() {} disconnect() { observers.delete(this.entry) }
  })
  return async (next: number) => { width = next; await act(async () => { for (const observer of [...observers]) observer.callback([], observer.value) }) }
}

function healthy() { expect(useAppStore.getState().agentComposerDrafts[ID]).toBe(DRAFT); expect(useAppStore.getState().sessions[0]!.control).toEqual({ kind: 'agent', hostId: 'local', agentSessionId: ID, run: { runId: 'unchanged-private-run' } }) }
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); localStorage.clear()
  fixture = await nativeHistoryFixture('claude', jsonl(original))
  pages = []
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }], executors: { claude: { label: 'Claude', providerId: 'claude', command: 'claude', args: [], env: {}, injectAgentMuxGuide: true } }, workspaces: [{ id: 'project', name: 'Private project', hostId: 'local', path: fixture.root, kind: 'folder' }], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  const session: SessionSnapshot = { id: ID, kind: 'agent', providerId: 'claude', executorId: 'claude', hostId: 'local', workspacePath: fixture.root, label: 'Original Agent', createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, promptSubmissionPredecessor: null, processState: 'running', latestOutputBytes: 0, status: { state: 'running', source: 'run-process', observedAt: NOW }, capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' }, control: { kind: 'agent', hostId: 'local', agentSessionId: ID, run: fixture.session.run } }
  useAppStore.setState({ config, sessions: [session], timelines: {}, agentNames: {}, tabs: {}, layouts: {}, recoveryCandidates: [], workspaceFileRevisions: {}, scratchTopicSnapshots: {}, spaceObjectIcons: {}, activeWorkspaceId: 'project', mainSurface: 'agents', agentComposerDrafts: { [ID]: DRAFT }, agentFocus: { execution: { sessionId: ID, history: [] }, pmo: { sessionId: null } }, error: null })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: fixture.root })
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  reads = vi.spyOn(api.sessions, 'historyPage').mockImplementation(async (control, options) => { expect(control.hostId).toBe('local'); expect(control.agentSessionId).toBe(ID); const page = await fixture.client.sessionHistoryPage(control.agentSessionId, options); pages.push(page); return page })
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation((control, listener, options) => fixture.client.observeSessionHistory(control.agentSessionId, listener, options))
  vi.spyOn(api.sessions, 'timeline').mockImplementation(control => fixture.client.sessionTimeline(control.agentSessionId))
  controls = ['submitPrompt', 'write', 'resume', 'recover', 'stop'].map(name => vi.spyOn(api.sessions, name as 'stop'))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  expect(fixture.controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]); expect(controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0])
  await fixture.close(); for (const extra of extraFixtures.splice(0)) { expect(extra.controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]); await extra.close() } useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); document.getElementById('agentmux-window-overlay-host')?.remove()
})

it('neighboring inputs and replies use the actual ruler width, keep original order and read each record with truthful seconds', async () => {
  const resize = measuredTimeline(864)
  await writeFile(fixture.path, '')
  await seedCaptured([
    captured('near-reply', 'assistant_message', { createdAt: NOW - 10_000, content: 'Repeated original speech' }),
    captured('near-input', 'user_message', { createdAt: NOW - 20_000, authorAgentSessionId: 'other-agent', content: 'Repeated original speech' }),
    captured('far-input', 'user_message', { createdAt: NOW - HOUR, authorHuman: true })
  ])
  await render(); await wait(() => expect(recordCount()).toBe(3))
  expect(markers()).toHaveLength(2)
  const group = markers().find(node => node.dataset.recordCount === '2')!
  expect(group).toBeDefined(); expect(group.dataset.recordKind).toBe('mixed')
  expect(JSON.parse(group.dataset.messageRawIds!)).toEqual(['near-reply', 'near-input'])
  expect(Number(group.dataset.messageAt)).toBe(NOW - 20_000); expect(Number(group.dataset.messageThrough)).toBe(NOW - 10_000)
  expect(group.getAttribute('aria-label')).toContain('from'); expect(group.getAttribute('aria-label')).toContain('through')
  expect(group.getAttribute('aria-label')).toContain(':40'); expect(group.getAttribute('aria-label')).toContain(':50')
  await act(async () => group.click())
  const list = [...overlay().querySelectorAll<HTMLElement>('[data-conversation-record-id]')]
  expect(list.map(node => node.dataset.recordRawId)).toEqual(['near-reply', 'near-input'])
  expect(overlay().textContent).toContain('from'); expect(overlay().textContent).toContain('through')
  for (const item of list) { await act(async () => item.click()); expect(overlay().querySelector('.recent-focus__message-body')!.textContent).toContain('Repeated original speech') }
  const body = overlay().querySelector<HTMLElement>('.recent-focus__message-body')!, text = body.querySelector('p')!.firstChild!, range = document.createRange()
  range.setStart(text, 0); range.setEnd(text, 8); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); body.scrollTop = 7
  const before = reads.mock.calls.length
  await resize(36_000); expect(markers()).toHaveLength(3)
  await resize(120); expect(markers()).toHaveLength(2)
  const zoom = host.querySelector<HTMLSelectElement>('[aria-label="Focus window size"]')!
  await act(async () => { zoom.value = '0.5'; zoom.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(recordCount()).toBe(2); expect(markers()).toHaveLength(1)
  await resize(5000); expect(markers()).toHaveLength(2)
  await resize(0); expect(markers()).toHaveLength(2)
  await click('[aria-label="Previous focus window"]'); expect(markers()).toHaveLength(0)
  expect(overlay().querySelector('.recent-focus__message-body')).toBe(body); expect(selection.toString()).toBe('Repeated'); expect(body.scrollTop).toBe(7)
  expect(reads.mock.calls.length).toBe(before); healthy(); selection.removeAllRanges()
})

it('the final 22px count width also merges the left neighbor and repeated native/captured raw IDs stay original', async () => {
  measuredTimeline(864)
  await writeFile(fixture.path, jsonl([native('duplicate', 'user', 'Repeated original speech', NOW - 483_333), native('native-other', 'assistant', 'Repeated original speech', NOW - 200_000)]))
  await seedCaptured([
    captured('duplicate', 'user_message', { createdAt: NOW - 183_333, authorAgentSessionId: 'other-agent' }),
    captured('reply', 'assistant_message', { createdAt: NOW - 183_333 })
  ])
  await render(); await wait(() => expect(recordCount()).toBe(4))
  expect(markers()).toHaveLength(1)
  const group = markers()[0]!
  expect(group.dataset.recordCount).toBe('4')
  expect(JSON.parse(group.dataset.messageRawIds!)).toEqual(['duplicate', 'native-other', 'duplicate', 'reply'])
  const identities = JSON.parse(group.dataset.messageIds!) as string[]
  expect(new Set(identities).size).toBe(4)
  await act(async () => group.click())
  const list = [...overlay().querySelectorAll<HTMLElement>('[data-conversation-record-id]')]
  expect(list.map(node => node.dataset.recordSource)).toEqual(['native', 'native', 'captured', 'captured'])
  expect(list.map(node => node.dataset.recordRawId)).toEqual(['duplicate', 'native-other', 'duplicate', 'reply'])
  for (const item of list) { await act(async () => item.click()); expect(overlay().querySelector('.recent-focus__message-body')!.textContent).toContain('Repeated original speech') }
  healthy()
})

it('zero width keeps exact-time records reachable and unrelated output does not rerun pixel grouping or read sources', async () => {
  const resize = measuredTimeline(0), geometry = vi.spyOn(messageGeometry, 'focusMessageMarkers')
  await writeFile(fixture.path, '')
  await seedCaptured([captured('zero-input', 'user_message', { createdAt: NOW - 20_000, authorAgentSessionId: 'other-agent' }), captured('zero-reply', 'assistant_message', { createdAt: NOW - 10_000 })])
  await render(); await wait(() => expect(recordCount()).toBe(2))
  expect(markers()).toHaveLength(2); expect(geometry.mock.calls.length).toBeGreaterThan(0)
  await records(); expect([...overlay().querySelectorAll<HTMLElement>('[data-conversation-record-id]')].map(node => node.dataset.recordRawId)).toEqual(['zero-input', 'zero-reply'])
  const before = { groups: geometry.mock.calls.length, reads: reads.mock.calls.length }
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, unrelated: { agentSessionId: 'unrelated', revision: 1, items: [captured('unrelated', 'assistant_message', { agentSessionId: 'unrelated' })] } } })))
  expect(geometry.mock.calls.length).toBe(before.groups); expect(reads.mock.calls.length).toBe(before.reads)
  await resize(864); expect(markers()).toHaveLength(1)
  const at = Number(markers()[0]!.dataset.messageAt), through = Number(markers()[0]!.dataset.messageThrough)
  await act(async () => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')) })
  const hidden = reads.mock.calls.length
  await act(async () => useAppStore.setState(state => ({ agentNames: { ...state.agentNames, unrelated: 'Unrelated hidden update' } })))
  expect(reads.mock.calls.length).toBe(hidden); expect(Number(markers()[0]!.dataset.messageAt)).toBe(at); expect(Number(markers()[0]!.dataset.messageThrough)).toBe(through)
  if (process.env.AGENTMUX_COLLISION_PREFLIGHT_FACTS) await appendFile(process.env.AGENTMUX_COLLISION_PREFLIGHT_FACTS, JSON.stringify({ groupingCalls: before.groups, unrelatedGroupingDelta: 0, unrelatedReadDelta: 0, hiddenReadDelta: 0, groupStart: at, groupEnd: through }) + '\n')
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); healthy()
})

it('newly observed other-Agent input is visible before the slow UI now clock ticks', async () => {
  await render(); await wait(() => expect(rawIds()).toEqual(['u', 'a']))
  const before = Number(host.querySelector<HTMLElement>('.recent-focus__playhead')!.dataset.now)
  expect(before).toBe(NOW)
  // Only Date is fake in the original fixture. No interval advancement, no
  // 30-second sleep and no Now button: use the real incoming fact boundary.
  vi.setSystemTime(NOW + 1000)
  const observedAt = Date.now(), rawId = 'fresh-other-agent-input'
  await seedCaptured([captured(rawId, 'user_message', { createdAt: observedAt, updatedAt: observedAt, authorAgentSessionId: 'other-agent', content: 'Actual retained incoming input after the UI clock tick' })])
  const canonical = projectConversationRecords({ agentSessionId: ID, executionHostId: 'local', timeline: await fixture.client.sessionTimeline(ID) })
  expect(canonical.find(item => item.rawId === rawId)?.speaker).toEqual({ role: 'agent', id: 'other-agent' })
  expect(canonical.find(item => item.rawId === rawId)?.recordedAt).toBe(observedAt)
  expect(Number(host.querySelector<HTMLElement>('.recent-focus__playhead')!.dataset.now)).toBe(before)
  await records()
  const original = overlay().querySelector<HTMLElement>(`[data-record-raw-id="${rawId}"]`)
  expect(original).not.toBeNull(); expect(original!.dataset.recordKind).toBe('user-message')
  expect(original!.textContent).toContain('Actual retained incoming input after the UI clock tick')
  healthy()
  const evidence = { uiNow: before, actualWallNow: Date.now(), recordedAt: observedAt, rawId, canonical: canonical.map(item => ({ rawId: item.rawId, kind: item.kind, speaker: item.speaker, recordedAt: item.recordedAt })), actualReaderHasOriginal: !!original, actualMarkerRawIds: rawIds(), uiClockUnadvanced: Number(host.querySelector<HTMLElement>('.recent-focus__playhead')!.dataset.now) === before, kernelControls: fixture.controls.map(spy => spy.mock.calls.length), clientControls: controls.map(spy => spy.mock.calls.length), nativePagesRead: pages.length }
  if (process.env.AGENTMUX_INCOMING_PREFLIGHT_FACTS) await appendFile(process.env.AGENTMUX_INCOMING_PREFLIGHT_FACTS, JSON.stringify(evidence) + '\n')
  // Desired behavior. Exact Main currently excludes this already-observed,
  // actually past record using the older UI clock. An AssertionError here is
  // the mounted product counterexample; collection/import errors are not.
  expect(rawIds(), 'Retained incoming record must be visible before the next 30-second UI clock tick').toContain(rawId)
})

it('an already-read source without a current Context admits its new input using the same current-time boundary', async () => {
  vi.spyOn(api.sessions, 'historySources').mockImplementation(() => fixture.client.sessionHistorySources())
  await render(); await wait(() => expect(rawIds()).toEqual(['u', 'a']))
  await writeFile(fixture.path, '')
  vi.setSystemTime(NOW + 1000)
  await seedCaptured([captured('readonly-fresh', 'user_message', { createdAt: Date.now(), authorAgentSessionId: 'other-agent', content: 'Original already-read input without a current Context' })])
  await act(async () => useAppStore.setState({ sessions: [] }))
  await records()
  await wait(() => expect(overlay().querySelector('[data-record-raw-id="readonly-fresh"]')).not.toBeNull())
  expect(Number(host.querySelector<HTMLElement>('.recent-focus__playhead')!.dataset.now)).toBe(NOW)
  const track = host.querySelector('[data-focus-timeline-id="private-agent"][data-history-only="true"]')
  expect(track, 'An already-read in-range source remains visible without a current Context').not.toBeNull()
  expect([...track!.querySelectorAll<HTMLElement>('.recent-focus__message')].flatMap(node => JSON.parse(node.dataset.messageRawIds!))).toContain('readonly-fresh')
  expect(reads.mock.calls.length).toBeLessThanOrEqual(2)
  expect(useAppStore.getState().agentComposerDrafts[ID]).toBe(DRAFT)
})

it('input and reply shapes stay distinct while a same-time mixed group is neutral and reads every original record', async () => {
  measuredTimeline(864)
  await writeFile(fixture.path, '')
  await seedCaptured([
    captured('input-alone', 'user_message', { createdAt: NOW - 2 * HOUR, authorAgentSessionId: 'other-agent' }),
    captured('reply-alone', 'assistant_message', { createdAt: NOW - HOUR }),
    captured('group-agent', 'user_message', { createdAt: NOW - HOUR / 4, authorAgentSessionId: 'other-agent' }),
    captured('group-human', 'user_message', { createdAt: NOW - HOUR / 4, authorHuman: true }),
    captured('group-unknown', 'user_message', { createdAt: NOW - HOUR / 4 }),
    captured('group-reply', 'assistant_message', { createdAt: NOW - HOUR / 4 })
  ])
  await render(); await wait(() => expect(recordCount()).toBe(6))
  const shapeScene = process.env.AGENTMUX_INCOMING_SHAPE_SCENE
  if (shapeScene) {
    if (!isAbsolute(shapeScene)) throw new Error('AGENTMUX_INCOMING_SHAPE_SCENE must be an absolute path')
    await writeFile(shapeScene, JSON.stringify({ now: NOW, config: useAppStore.getState().config, sessions: useAppStore.getState().sessions, agentFocus: useAppStore.getState().agentFocus, agentComposerDrafts: useAppStore.getState().agentComposerDrafts, nativePage: pages[0], timeline: await fixture.client.sessionTimeline(ID), boundary: 'Actual public Core/FileStore captured records from the owning mounted shape case. Original recorded times, author IDs, distinct records and contents retained; private transport does not claim a Native Writer or Runtime.' }, null, 2) + '\n')
  }
  const input = markers().find(node => node.dataset.messageRawId === 'input-alone')!, reply = markers().find(node => node.dataset.messageRawId === 'reply-alone')!
  const style = document.createElement('style')
  style.textContent = await readFile(resolve(import.meta.dirname, '../src/renderer/src/styles/focus.css'), 'utf8')
  document.head.append(style)
  try {
    expect(getComputedStyle(input).borderRadius).toBe('6px')
    expect(getComputedStyle(reply).borderRadius).toBe('6px')
    expect(input.querySelector('.lucide-arrow-down-left')).not.toBeNull()
    expect(reply.querySelector('.lucide-arrow-up-right')).not.toBeNull()
  } finally { style.remove() }
  const group = markers().find(node => node.dataset.recordCount === '4')!
  expect(group.dataset.recordKind).toBe('mixed'); expect(group.dataset.messageAuthor).toBeUndefined()
  expect(group.querySelector('.recent-focus__message-count')!.textContent).toBe('4'); expect(group.querySelector('.recent-focus__message-direction')!.textContent).toBe('↕')
  expect(group.getAttribute('aria-label')).toContain('3 inputs and 1 replies')
  await act(async () => group.click())
  const list = [...overlay().querySelectorAll<HTMLElement>('[data-conversation-record-id]')]
  expect(list.map(node => node.dataset.recordRawId)).toEqual(['group-agent', 'group-human', 'group-unknown', 'group-reply'])
  expect(list.map(node => node.dataset.messageAuthor)).toEqual(['agent', 'human', 'unknown', 'agent'])
  expect(list.map(node => node.dataset.recordKind)).toEqual(['user-message', 'user-message', 'user-message', 'assistant-message'])
  for (const node of list) { await act(async () => node.click()); expect(overlay().querySelector('.recent-focus__message-body')!.textContent).toContain('Repeated original speech') }
  healthy()
})

it('unrelated output does not reproject records or read history and the slow UI clock stays unchanged', async () => {
  await render(); await wait(() => expect(rawIds()).toEqual(['u', 'a']))
  const projector = vi.spyOn(conversationRecords, 'projectConversationRecords'), realClock = Date.now, stacks: string[] = []
  vi.spyOn(Date, 'now').mockImplementation(() => { stacks.push(new Error().stack!); return realClock() })
  const before = { projections: projector.mock.calls.length, reads: reads.mock.calls.length, now: host.querySelector<HTMLElement>('.recent-focus__playhead')!.dataset.now }
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, unrelated: { agentSessionId: 'unrelated', revision: 1, items: [captured('unrelated-output', 'assistant_message', { agentSessionId: 'unrelated' })] } } })))
  expect(projector.mock.calls.length).toBe(before.projections)
  if (process.env.AGENTMUX_INCOMING_PREFLIGHT_FACTS) await appendFile(process.env.AGENTMUX_INCOMING_PREFLIGHT_FACTS, JSON.stringify({ costClockStacks: stacks }) + '\n')
  // The unchanged Focus Context Store selector reads Date.now once on a Store
  // notification. Neither Timeline message derivation may run for that output.
  expect(stacks.filter(stack => stack.includes('/components/RecentFocusTimeline.tsx'))).toHaveLength(0)
  expect(reads.mock.calls.length).toBe(before.reads)
  expect(host.querySelector<HTMLElement>('.recent-focus__playhead')!.dataset.now).toBe(before.now)
  healthy()
})

it('the actual current Global page and shared ConversationView both retain user and assistant speech with original parts while keeping reasoning activity distinct', async () => {
  measuredTimeline(864)
  await render(); await wait(() => expect(pages.length).toBeGreaterThan(0))
  expect(pages[0]!.items.map(item => [item.id, item.kind])).toEqual([['u', 'user-message'], ['a', 'assistant-message'], ['thinking', 'activity']])
  expect(rawIds()).toEqual(['u', 'a'])
  const visualInput = process.env.AGENTMUX_FOCUS_CONVERSATION_VISUAL_INPUT
  if (visualInput) {
    if (!isAbsolute(visualInput)) throw new Error('AGENTMUX_FOCUS_CONVERSATION_VISUAL_INPUT must be an absolute path')
    await writeFile(visualInput, JSON.stringify({ now: NOW, config: useAppStore.getState().config, sessions: useAppStore.getState().sessions, agentFocus: useAppStore.getState().agentFocus, agentComposerDrafts: useAppStore.getState().agentComposerDrafts, nativePage: pages[0], timeline: await fixture.client.sessionTimeline(ID), boundary: 'Actual public Core/FileStore/Claude page from the first owning mounted case. Equal recorded timestamps remain equal; typed transport is not a Native Writer or Runtime claim.' }, null, 2) + '\n')
  }
  await render(<div data-shared-conversation><ConversationView page={pages[0]!} sessionId={ID} /></div>)
  expect([...host.querySelectorAll('[data-shared-conversation] [data-native-record-id]')].map(node => node.getAttribute('data-native-record-id'))).toEqual(['u', 'a', 'thinking'])
  expect(host.querySelector('[data-native-record-id="thinking"]')!.textContent).toContain('Reasoning')
  // Typed public-page contract: a non-text reply remains a reply; Claude's
  // activity record above is not relabelled to manufacture that fact.
  const nonText = { ...pages[0]!.items[1]!, id: 'non-text-reply', contentParts: [{ kind: 'reasoning' as const, text: 'Typed non-text reply' }], startedAt: Number.MAX_VALUE }
  const described = projectConversationRecords({ agentSessionId: ID, executionHostId: 'local', historyPage: { ...pages[0]!, items: [nonText] } })[0]!
  expect(described.kind).toBe('assistant-message'); expect(described.input).toBeUndefined(); expect(described.contentParts).toBe(nonText.contentParts); expect(described.original.item).toBe(nonText); expect(described.recordedAt).toBeUndefined()
  await render(<div data-shared-conversation><ConversationView page={{ ...pages[0]!, items: [nonText] }} sessionId={ID} /></div>)
  expect(host.querySelector('[data-native-record-id="non-text-reply"]')!.textContent).toContain('Reasoning')
  expect(markers()).toHaveLength(1); expect(markers()[0]!.dataset.recordCount).toBe('2'); expect(markers()[0]!.getAttribute('aria-label')).toContain('1 inputs and 1 replies')
  await act(async () => markers()[0]!.click())
  expect([...overlay().querySelectorAll<HTMLElement>('[data-conversation-record-id]')].map(node => [node.dataset.recordRawId, node.dataset.recordKind])).toEqual([['u', 'user-message'], ['a', 'assistant-message']])
  expect(overlay().textContent).not.toContain('Refresh source')
  await plotRecord('a')
  expect(overlay().querySelector('.recent-focus__message-body')!.textContent).toContain('Reasoning')
  healthy()
})

it('historical native and FileStore captured user/reply facts keep equal bodies and cross-source raw IDs separate', async () => {
  await seedCaptured([captured('u', 'user_message', { authorHuman: true }), captured('a', 'assistant_message')])
  await render(); await wait(() => expect(recordCount()).toBe(4))
  expect(new Set(recordIds()).size).toBe(4)
  await records(); await textButton('Read earlier records')
  await wait(() => expect(overlay().querySelectorAll('[data-conversation-record-id]')).toHaveLength(4))
  const list = [...overlay().querySelectorAll<HTMLElement>('[data-conversation-record-id]')]
  expect(list.filter(node => node.dataset.recordKind === 'assistant-message')).toHaveLength(2)
  expect(list.filter(node => node.dataset.recordSource === 'captured')).toHaveLength(2)
  expect(reads.mock.calls.length).toBeLessThanOrEqual(2); healthy()
})

it('unknown, human and Agent-authored inputs remain distinct from the recipient reply and exact native source identity', async () => {
  await seedCaptured([captured('human', 'user_message', { authorHuman: true }), captured('agent-input', 'user_message', { authorAgentSessionId: 'other-agent' }), captured('unknown', 'user_message')])
  await render(); await wait(() => expect(recordCount()).toBe(5))
  await records()
  const item = (id: string) => overlay().querySelector<HTMLElement>(`[data-conversation-record-id][data-record-raw-id="${id}"]`)!
  expect(item('u').dataset.messageAuthor).toBe('unknown'); expect(item('human').dataset.messageAuthor).toBe('human')
  expect(item('agent-input').getAttribute('aria-label')!).toContain('other-agent'); expect(item('a').getAttribute('aria-label')!).toContain(ID); expect(item('unknown').getAttribute('aria-label')!).toContain('not recorded')
  const ids = recordIds(); expect(ids.every(id => id.includes('local') && id.includes(ID))).toBe(true)
  await plotRecord('a'); expect(overlay().querySelector('[data-input-source] .log-turn')).toBeNull()
  expect(overlay().querySelector('.recent-focus__message-body')!.textContent).toContain('Repeated original speech')
  await records(); await textButton('Read earlier records')
  await wait(() => expect(overlay().querySelector('[data-record-raw-id="u"][data-record-source="native"]')).not.toBeNull())
  const pinned = overlay().querySelector<HTMLElement>('[data-record-raw-id="u"][data-record-source="native"]')!; await act(async () => pinned.click())
  const pinnedBody = overlay().querySelector('.recent-focus__message-body')
  expect(pinnedBody!.querySelector('[data-recorded-identity="true"]')).not.toBeNull()
  expect(pinnedBody!.textContent).toContain('Author unknown')
  expect(pinnedBody!.querySelector('[data-message-speaker="human"]')).toBeNull()
  // Two private public Core/FileStore services model exact Desktop Host routing;
  // there is no SSH connection, Runtime operation or fabricated user DTO.
  const other = await nativeHistoryFixture('claude', jsonl(Array.from({ length: 90 }, (_, index) => native(index === 89 ? 'u' : 'remote-' + index, 'user', 'Other Host input ' + index))))
  extraFixtures.push(other)
  for (const item of useAppStore.getState().timelines[ID]!.items) await other.store.applyTimelineMutation({ type: 'append', agentSessionId: ID, item })
  reads.mockImplementation(async (control, options) => { expect(control.hostId).toBe('other'); const page = await other.client.sessionHistoryPage(control.agentSessionId, options); pages.push(page); return page })
  vi.spyOn(api.sessions, 'timeline').mockImplementation(control => other.client.sessionTimeline(control.agentSessionId))
  const state = useAppStore.getState(), session = state.sessions[0]!
  if (session.kind !== 'agent') throw new Error('Fixture requires the original Agent')
  await act(async () => useAppStore.setState({
    config: { ...state.config!, hosts: [...state.config!.hosts, { id: 'other', kind: 'ssh', label: 'Private logical Host', hostname: 'unused.invalid' }], workspaces: state.config!.workspaces.map(workspace => ({ ...workspace, hostId: 'other' })) },
    sessions: [{ ...session, hostId: 'other', control: { ...session.control, hostId: 'other' } }]
  }))
  await wait(() => expect(overlay().querySelectorAll('[data-conversation-record-id][data-record-source="native"]')).toHaveLength(89))
  expect(overlay().querySelector('[data-record-raw-id="u"][data-record-source="native"]')).toBeNull()
  expect(overlay().querySelector('.recent-focus__message-body')).toBe(pinnedBody)
  expect([...overlay().querySelectorAll<HTMLElement>('[data-conversation-record-id]')].map(node => JSON.parse(node.dataset.conversationRecordId!)[0])).toEqual(Array.from({ length: 92 }, () => 'other'))
  expect(new Set(recordIds().map(id => JSON.parse(id)).filter(identity => identity.at(-1) === 'human').map(identity => identity[0]))).toEqual(new Set(['local', 'other']))
  const returnButton = [...overlay().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Return to Context')!; expect(returnButton.disabled).toBe(true)
  expect(useAppStore.getState().agentComposerDrafts[ID]).toBe(DRAFT)

})

it('zero and missing time remain original facts; only real in-range speech receives a position', async () => {
  await writeFile(fixture.path, jsonl([native('zero', 'assistant', 'Epoch record', 0), native('untimed', 'assistant', 'Untimed reply', null), native('old', 'assistant', 'Older reply', NOW - 8 * HOUR), native('future', 'assistant', 'Future reply', NOW + HOUR), native('now', 'user', 'In-range input')]))
  await render(); await wait(() => expect(rawIds()).toEqual(['now']))
  await records(); expect(overlay().textContent).toContain('Time unknown')
  const untimed = overlay().querySelector<HTMLElement>('[data-conversation-record-id][data-record-raw-id="untimed"]')!; expect(untimed).not.toBeNull(); await act(async () => untimed.click())
  expect(overlay().querySelector('.recent-focus__message-body')!.textContent).toContain('Untimed reply')
  const input = host.querySelector<HTMLInputElement>('[aria-label="Focus history date and time"]')!; expect(input).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, localDateTime(HOUR)); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(rawIds()).toEqual(['zero']); expect(markers()[0]!.dataset.messageAt).toBe('0'); healthy()
})

it('same-source pending refresh and hidden late completion preserve the pinned reply DOM, Range and original draft without reading another source', async () => {
  await render(); await wait(() => expect(rawIds()).toEqual(['u', 'a']))
  await records()
  const selected = overlay().querySelector<HTMLElement>('[data-conversation-record-id][data-record-raw-id="a"]')!; expect(selected).not.toBeNull(); await act(async () => selected.click())
  const body = overlay().querySelector<HTMLElement>('.recent-focus__message-body')!, text = body.querySelector('p')!.firstChild!; const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 8); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  await appendFile(fixture.path, jsonl([native('b', 'assistant', 'Appended reply')]))
  await wait(() => expect([...overlay().querySelectorAll<HTMLElement>('[data-conversation-record-id]')].map(node => node.dataset.recordRawId)).toEqual(['u', 'a', 'b']))
  expect(overlay().querySelector('.recent-focus__message-body')).toBe(body); expect(selection.toString()).toBe('Repeated')
  const oldReads = reads.mock.calls.length
  await act(async () => useAppStore.setState({ timelines: { unrelated: { agentSessionId: 'unrelated', revision: 1, items: [captured('unrelated', 'assistant_message', { agentSessionId: 'unrelated' })] } } }))
  expect(reads.mock.calls).toHaveLength(oldReads); expect(overlay().querySelector('.recent-focus__message-body')).toBe(body); expect(selection.toString()).toBe('Repeated')
  let release!: (page: AgentSessionHistoryPage) => void
  reads.mockImplementationOnce(() => new Promise<AgentSessionHistoryPage>(resolve => { release = resolve }))
  await textButton('Refresh source'); await wait(() => expect(release).toBeDefined())
  await act(async () => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')) })
  const count = reads.mock.calls.length; await act(async () => release(pages[0]!)); expect(reads.mock.calls).toHaveLength(count)
  expect(overlay().querySelector('.recent-focus__message-body')).toBe(body); expect(selection.toString()).toBe('Repeated'); healthy()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); selection.removeAllRanges()
})

it('raw capacity and service failures preserve observed replies and healthy control, with no extra unrelated IO', async () => {
  await writeFile(fixture.path, jsonl(Array.from({ length: 120 }, (_, index) => native('row-' + index, index % 2 ? 'assistant' : 'user', 'Bounded speech ' + index))))
  await render(); await wait(() => expect(markers().length).toBeGreaterThan(0)); expect(markers().length).toBeLessThanOrEqual(90)
  for (let batch = 0; batch < 4; batch++) {
    await appendFile(fixture.path, jsonl(Array.from({ length: 20 }, (_, index) => native(`append-${batch}-${index}`, index % 2 ? 'assistant' : 'user', 'Appended original speech'))))
    await wait(() => expect(rawIds()).toContain(`append-${batch}-19`))
  }
  expect(recordCount()).toBe(90)
  await records(); expect(overlay().textContent).toContain('Some latest conversation records are outside this bounded window'); const list = overlay().querySelectorAll('[data-conversation-record-id]'); expect(list.length).toBeGreaterThan(0); expect(list.length).toBeLessThanOrEqual(90)
  const before = reads.mock.calls.length
  reads.mockRejectedValueOnce(new Error('Observed history service unavailable'))
  await textButton('Refresh source'); await wait(() => expect(overlay().textContent).toContain('Observed history service unavailable'))
  expect(overlay().querySelectorAll('[data-conversation-record-id]')).toHaveLength(list.length); expect(useAppStore.getState().sessions[0]!.processState).toBe('running')
  await act(async () => useAppStore.setState({ agentNames: { unrelated: 'Changed unrelated name' } })); expect(reads.mock.calls).toHaveLength(before + 1); healthy()
})
