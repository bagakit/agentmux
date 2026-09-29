// @vitest-environment happy-dom
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentMuxStoredAgentSession } from '@agentmux/core'
import * as UserMessages from '@agentmux/core/session-user-messages'
import * as Grouping from '../src/renderer/src/lib/focus-history-timeline'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore, restorePersistedUiState } from '../src/renderer/src/store'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline'
import type { AgentFocusHistoryEntry } from '../src/renderer/src/lib/agent-focus'
import type { SessionSnapshot } from '../src/shared/contracts'
import { clampFocusTimelineNameWidth } from '../src/renderer/src/lib/focus-timeline-name-width'

// PTY paint and hierarchy transport are outside this presentation-owner proof.
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/lib/use-focus-hierarchy', () => ({ useFocusHierarchy: () => ({ facts: { topics: {}, worktrees: [] }, errors: [] }) }))
const NOW = Date.parse('2026-10-03T12:00:00Z'), HOUR = 3_600_000, baseline = useAppStore.getState()
const roots: Root[] = [], hosts: HTMLElement[] = [], cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  for (const host of hosts.splice(0)) host.remove()
  for (const cleanup of cleanups.splice(0)) await cleanup()
  useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
  document.getElementById('agentmux-window-overlay-host')?.remove()
})
function agent(id: string, path: string): SessionSnapshot {
  return { kind: 'agent', id, providerId: 'claude', executorId: 'private', hostId: 'local', workspacePath: path, label: id, createdAt: 1, updatedAt: 1,
    processState: 'running', latestOutputBytes: 0, agentSessionUpdatedAt: 1,
    capabilities: { terminal: true, timeline: 'unavailable', permission: 'none', providerResume: false, replyCorrelation: 'none' }, status: { state: 'working', source: 'native-hook', observedAt: 1 },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: id + '-run' } } }
}
const entries: AgentFocusHistoryEntry[] = ['one', 'two', 'three'].map((id, i) => ({ sessionId: id, focusedAt: NOW - (i + 1) * HOUR / 2,
  identity: { name: `非空工作轨道 ${id}`, kind: 'agent', providerId: 'claude', hostId: 'local', workspacePath: i < 2 ? '/first' : '/second', project: { id: i < 2 ? 'first' : 'second', name: i < 2 ? '第一项目 · 日常工作' : '第二项目 · 已完成历史' } } }))
async function fixture(global = true, emptyCatalogue = true) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.spyOn(Date, 'now').mockReturnValue(NOW)
  if (emptyCatalogue) vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  useAppStore.setState({ focusTimelineNameWidth: 112, focusTimelineHeight: 168, sessions: [agent('one', '/first'), agent('two', '/first'), agent('three', '/second')],
    config: null, timelines: {}, tabs: {}, layouts: {}, agentComposerDrafts: { one: 'Original unsent draft' },
    agentFocus: { execution: { sessionId: null, history: entries }, pmo: { sessionId: null } } })
  const host = document.createElement('div'); document.body.append(host); hosts.push(host)
  const root = createRoot(host); roots.push(root)
  await act(async () => root.render(global ? createElement(GlobalFocusSurface) : createElement(RecentFocusTimeline, { contexts: [], entries, currentSessionId: null, onSelect: vi.fn() })))
  const timeline = host.querySelector<HTMLElement>('.recent-focus')!, handle = host.querySelector<HTMLElement>('[aria-label="Resize timeline names"]')!
  expect(timeline).not.toBeNull(); expect(handle).not.toBeNull()
  const key = (key: string) => act(async () => handle.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key })))
  const down = (x: number) => act(async () => {
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: x }))
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: x }))
  })
  const move = (x: number) => act(async () => { window.dispatchEvent(new MouseEvent('mousemove', { clientX: x })); await new Promise(requestAnimationFrame) })
  const up = () => act(async () => window.dispatchEvent(new MouseEvent('mouseup')))
  return { host, root, timeline, handle, key, down, move, up }
}
it('the actual Global supplies two projects, three nonempty tracks and one keyboard-accessible name separator', async () => {
  const h = await fixture()
  const projects = [...h.host.querySelectorAll('[data-timeline-project]')]
  expect(projects.length).toBeGreaterThanOrEqual(2)
  expect([...h.host.querySelectorAll('.recent-focus__segment')].map(node => node.closest<HTMLElement>('.recent-focus__track')!.dataset.focusTimelineId).sort()).toEqual(['one', 'three', 'two'])
  expect(h.host.querySelectorAll('[aria-label="Resize timeline names"]')).toHaveLength(1)
  expect(h.handle.getAttribute('aria-orientation')).toBe('vertical'); expect(h.handle.tabIndex).toBe(0)
  expect(h.timeline.style.getPropertyValue('--focus-name-width')).toBe('112px')
  expect(h.handle.getAttribute('aria-valuemin')).toBe('96'); expect(h.handle.getAttribute('aria-valuemax')).toBe('320')
  expect(h.host.querySelector('[aria-label="Resize Focus timeline"]')?.getAttribute('aria-orientation')).toBe('horizontal')
})
it('uses the existing DOM draft owner, saves once at release, makes unchanged operations zero-write and cleans an unfinished drag', async () => {
  const h = await fixture(), widths: number[] = []; let publications = 0
  const stop = useAppStore.subscribe((state, previous) => { publications++; if (state.focusTimelineNameWidth !== previous.focusTimelineNameWidth) widths.push(state.focusTimelineNameWidth) })
  try {
    await h.down(112); await h.move(244)
    expect(h.timeline.style.getPropertyValue('--focus-name-width')).toBe('244px'); expect(h.handle.getAttribute('aria-valuenow')).toBe('244')
    expect(useAppStore.getState().focusTimelineNameWidth).toBe(112); expect(widths).toEqual([])
    expect(document.body.style.cursor).toBe('col-resize'); expect(document.body.style.userSelect).toBe('none')
    await h.up(); expect(widths).toEqual([244]); expect(document.body.style.cursor).toBe(''); expect(document.body.style.userSelect).toBe('')
    const beforeNoop = publications
    await h.down(244); await h.up(); await act(async () => useAppStore.getState().setFocusTimelineNameWidth(244)); expect(widths).toEqual([244]); expect(publications).toBe(beforeNoop)
    await h.down(244); await h.move(290)
    expect(document.querySelector('[style*="2147483647"]')).not.toBeNull()
    await act(async () => h.root.unmount()); roots.splice(roots.indexOf(h.root), 1)
    expect(document.querySelector('[style*="2147483647"]')).toBeNull(); expect(document.body.style.cursor).toBe(''); expect(document.body.style.userSelect).toBe('')
    expect(widths).toEqual([244])
  } finally { stop() }
})
it('keyboard bounds and the original durable partialize/restore chain preserve width independently from height and window', async () => {
  const h = await fixture(), before = [h.timeline.dataset.windowStart, h.timeline.dataset.windowEnd, useAppStore.getState().focusTimelineHeight]
  for (const [key, width] of [['ArrowRight', 128], ['Home', 96], ['ArrowLeft', 96], ['End', 320], ['ArrowRight', 320]] as const) {
    await h.key(key); expect(useAppStore.getState().focusTimelineNameWidth).toBe(width); expect(h.handle.getAttribute('aria-valuenow')).toBe(String(width))
  }
  const config = await api.config.get()
  const persisted = useAppStore.persist.getOptions().partialize!(useAppStore.getState())
  expect(persisted.focusTimelineNameWidth).toBe(320)
  expect(restorePersistedUiState(config, persisted).focusTimelineNameWidth).toBe(320)
  expect(restorePersistedUiState(config, { workbenchSpaceSelection: null }).focusTimelineNameWidth).toBe(112)
  expect([NaN, -1, 999, '200'].map(clampFocusTimelineNameWidth)).toEqual([112, 96, 320, 112])
  expect([h.timeline.dataset.windowStart, h.timeline.dataset.windowEnd, useAppStore.getState().focusTimelineHeight]).toEqual(before)
})
it('narrow actual geometry only limits the rendered column and an unchanged gesture never overwrites the saved wider preference', async () => {
  let width = 320
  const observers = new Set<() => void>()
  vi.stubGlobal('ResizeObserver', class { constructor(private update: () => void) { observers.add(update) } observe() {} disconnect() { observers.delete(this.update) } })
  const original = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const rectangle = (size: number) => ({ x: 0, y: 0, left: 0, right: size, top: 0, bottom: 168, width: size, height: 168, toJSON() {} })
    if (this.classList.contains('recent-focus')) return rectangle(width)
    const name = Number.parseFloat(this.closest<HTMLElement>('.recent-focus')?.style.getPropertyValue('--focus-name-width') ?? '112')
    if (this.classList.contains('recent-focus__gutter') && this.parentElement?.classList.contains('recent-focus__ruler')) return rectangle(name)
    if (this.classList.contains('recent-focus__time-scale')) return rectangle(width - name - 24)
    return original.call(this)
  })
  const h = await fixture()
  await act(async () => useAppStore.getState().setFocusTimelineNameWidth(320))
  expect(h.timeline.style.getPropertyValue('--focus-name-width')).toBe('136px'); expect(h.handle.getAttribute('aria-valuemax')).toBe('136')
  expect(h.host.querySelector('.recent-focus__time-scale')!.getBoundingClientRect().width).toBe(160)
  await h.down(136); await h.up(); await h.key('ArrowRight'); expect(useAppStore.getState().focusTimelineNameWidth).toBe(320)
  width = 800; await act(async () => { for (const update of observers) update() })
  expect(h.timeline.style.getPropertyValue('--focus-name-width')).toBe('320px'); expect(useAppStore.getState().focusTimelineNameWidth).toBe(320)
})
it('200 draft/keyboard width updates preserve actual native/captured records, body DOM, Range and scroll with zero new read or projection work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'focus-name-width-')), path = join(directory, 'native.jsonl')
  await writeFile(path, Array.from({ length: 130 }, (_, i) => JSON.stringify({ sessionId: 'native-width', uuid: `record-${i}`, type: 'user', message: { role: 'user', content: `Original native width task ${i}` }, timestamp: new Date(NOW - HOUR).toISOString() })).join('\n') + '\n')
  const store = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json'))
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'archived-width', providerId: 'claude', executorId: 'private', hostId: 'private', workspacePath: directory, run: { runId: 'never-started' }, retiredRuns: [], hookBindingId: 'private', hookToken: 'private', createdAt: 1, updatedAt: 1, nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'native-width', transcriptPath: path } }
  await store.compareAndSwap(null, session)
  await store.applyTimelineMutation({ type: 'append', agentSessionId: session.agentSessionId, item: { id: 'captured', agentSessionId: session.agentSessionId, kind: 'user_message', source: 'user', status: 'complete', createdAt: NOW - HOUR, updatedAt: NOW - HOUR, title: 'Input', content: 'Original captured width task' } })
  const client = new AgentMuxClient({ store }), pending = new Set<Promise<unknown>>()
  const read = <T,>(promise: Promise<T>) => { pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise }
  cleanups.push(async () => { await Promise.allSettled([...pending]); expect(pending.size).toBe(0); await client.dispose(); await rm(directory, { recursive: true, force: true }) })
  const connect = vi.spyOn(client, 'connect').mockRejectedValue(new Error('No Runtime permitted'))
  const catalog = vi.spyOn(api.sessions, 'historySources').mockImplementation(() => read(client.sessionHistorySources()))
  const page = vi.spyOn(api.sessions, 'historyPage').mockImplementation((reference, options) => read(client.sessionHistoryPage(reference.agentSessionId, options)))
  const timeline = vi.spyOn(api.sessions, 'timeline').mockImplementation(reference => read(client.sessionTimeline(reference.agentSessionId)))
  const project = vi.spyOn(UserMessages, 'projectSessionUserMessages'), group = vi.spyOn(Grouping, 'groupFocusTimeline')
  const h = await fixture(true, false)
  const wait = async (check: () => void) => { for (let i = 0; i < 100; i++) { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }); try { check(); return } catch (error) { if (i === 99) throw error } } }
  await act(async () => h.host.querySelector<HTMLButtonElement>('[aria-label="View input records"]')!.click())
  await wait(() => expect(document.querySelector('[aria-label="Input records Context"] option[value="archived-width"]')).not.toBeNull())
  await act(async () => { const select = document.querySelector<HTMLSelectElement>('[aria-label="Input records Context"]')!; select.value = session.agentSessionId; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await wait(() => expect(document.querySelectorAll('[data-input-message-id]')).toHaveLength(91))
  expect(page.mock.calls.map(call => call[1]?.limit)).toEqual([30, 30, 30])
  const records = [...document.querySelectorAll<HTMLElement>('[data-input-message-id]')]; expect(records.some(node => node.textContent?.includes('Original captured width task'))).toBe(true)
  await act(async () => records[0]!.click())
  const body = document.querySelector('[data-input-preview-id]')!; expect(body.textContent).toContain('Original native width task')
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT); let text: Node | null
  while ((text = walker.nextNode()) && !text.textContent?.includes('Original native width task')) {}
  expect(text).not.toBeNull(); const range = document.createRange(); range.selectNodeContents(text!)
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); const selected = selection.toString(); expect(selected.length).toBeGreaterThan(0)
  const viewport = h.host.querySelector<HTMLElement>('.recent-focus__viewport')!; viewport.scrollTop = 48; viewport.scrollLeft = 12
  const before = [catalog.mock.calls.length, page.mock.calls.length, timeline.mock.calls.length, project.mock.calls.length, group.mock.calls.length]
  expect(before.slice(0, 3)).toEqual([1, 3, 1]); expect(before[3]).toBeGreaterThan(0); expect(before[4]).toBeGreaterThan(0)
  const original = useAppStore.getState(); await h.down(112)
  for (let i = 0; i < 100; i++) await h.move(i % 2 ? 144 : 128)
  await h.up()
  for (let i = 0; i < 100; i++) await h.key(i % 2 ? 'ArrowRight' : 'ArrowLeft')
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => ({ ...session, latestOutputBytes: 30, status: { ...session.status, observedAt: 2 } })) })))
  expect([catalog.mock.calls.length, page.mock.calls.length, timeline.mock.calls.length, project.mock.calls.length, group.mock.calls.length]).toEqual(before)
  expect(document.querySelectorAll('[data-input-message-id]')).toHaveLength(91); expect(document.querySelector('[data-input-preview-id]')).toBe(body); expect(selection.toString()).toBe(selected)
  expect([viewport.scrollTop, viewport.scrollLeft]).toEqual([48, 12]); expect(useAppStore.getState().agentComposerDrafts).toBe(original.agentComposerDrafts); expect(useAppStore.getState().agentFocus).toBe(original.agentFocus); expect(connect.mock.calls).toEqual([])
})
