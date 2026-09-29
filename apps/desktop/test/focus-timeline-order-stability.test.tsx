// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentMuxStoredAgentSession } from '@agentmux/core'
import * as UserMessages from '@agentmux/core/session-user-messages'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { EMPTY_AGENT_FOCUS, type AgentFocusHistoryEntry } from '../src/renderer/src/lib/agent-focus'
import type { FocusContext } from '../src/renderer/src/lib/focus-context'
import type { FocusProjectLane } from '../src/renderer/src/lib/focus-project-lanes'
import { createFocusTimelineOrder, extendFocusTimelineOrder, focusTimelineOrderCandidates } from '../src/renderer/src/lib/focus-history-timeline'

const NOW = Date.parse('2026-10-04T12:00:00Z'), HOUR = 3_600_000
const baseline = useAppStore.getState(), roots: Root[] = [], nodes: HTMLElement[] = [], cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  for (const node of nodes.splice(0)) node.remove()
  for (const cleanup of cleanups.splice(0)) await cleanup()
  useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
  document.getElementById('agentmux-window-overlay-host')?.remove()
})
const key = (project: string, id?: string) => id === undefined ? JSON.stringify(['private', project]) : JSON.stringify([JSON.stringify(['private', project]), id])
function entry(id: string, hours: number, project = 'alpha', name = id): AgentFocusHistoryEntry {
  return { sessionId: id, focusedAt: NOW - hours * HOUR, identity: { name, kind: 'agent', providerId: 'claude', hostId: 'private', workspacePath: '/private/history', project: { id: project, name: project === 'alpha' ? 'Alpha' : 'Beta' } } }
}
const visits = () => [entry('a', 7.5, 'alpha', 'Zeta'), entry('d', 5.5, 'beta', 'Solo'), entry('b', 3.5, 'alpha', 'Alpha'), entry('d', 1.5, 'beta', 'Solo'), entry('a', .8, 'alpha', 'Zeta'), entry('c', .4, 'alpha', 'Alpha')]
function context(id: string, name: string, activityAt: number | null): FocusContext {
  return { id, name, lastActivityAt: activityAt, detail: 'Existing task observation', state: 'running', stateLabel: 'Idle', processState: 'running', bucket: 'idle', kind: 'agent', providerId: 'claude', hostId: 'private', topicId: null, workspaceId: id === 'd' ? 'beta' : 'alpha', workspaceName: id === 'd' ? 'Beta' : 'Alpha', workspacePath: '/private/history', liveAgent: true, actionable: false, runId: `observed-${id}`, workingEnteredAt: null, workspace: undefined }
}
function lanes(contexts: readonly FocusContext[]): FocusProjectLane[] {
  return ['alpha', 'beta'].map(id => ({ id, workspaceId: id, projectId: id, projectWorkspaceId: id, name: id === 'alpha' ? 'Alpha' : 'Beta', path: '/private/history', labels: [id === 'alpha' ? 'Alpha' : 'Beta'], topicId: null, recovery: null, summary: null, activeAgentIds: [], contextIds: contexts.filter(c => c.workspaceId === id).map(c => c.id) }))
}

/** Real private FileStore/Provider Reader; only the existing desktop transport is isolated.
 * Display Contexts are typed fixture observations, not proof of real healthy Runs. */
async function fixture(initialEntries = visits(), initialContexts: readonly FocusContext[] = []) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.spyOn(Date, 'now').mockReturnValue(NOW)
  const directory = await mkdtemp(join(tmpdir(), 'focus-order-')), transcript = join(directory, 'native.jsonl')
  await writeFile(transcript, Array.from({ length: 130 }, (_, i) => JSON.stringify({ sessionId: 'native-order', uuid: `record-${i}`, type: 'user', message: { role: 'user', content: `Original native task ${i}` }, timestamp: new Date(NOW - HOUR).toISOString() })).join('\n') + '\n')
  const store = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json'))
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'archive-order', providerId: 'claude', executorId: 'private', hostId: 'private', workspacePath: directory, run: { runId: 'never-started' }, retiredRuns: [], hookBindingId: 'private', hookToken: 'private', createdAt: 1, updatedAt: 1, nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'native-order', transcriptPath: transcript } }
  await store.compareAndSwap(null, session)
  await store.applyTimelineMutation({ type: 'append', agentSessionId: session.agentSessionId, item: { id: 'captured', agentSessionId: session.agentSessionId, kind: 'user_message', source: 'user', status: 'complete', createdAt: NOW - HOUR, updatedAt: NOW - HOUR, title: 'Input', content: 'Original captured task' } })
  const reservation = { kind: 'stop' as const, reservationId: 'retire', ownerId: 'private', ownerPid: process.pid, agentSessionId: session.agentSessionId, expectedRun: session.run, operationId: 'retire', expiresAt: NOW + 60_000, stopOperation: { daemonInstance: 'no-runtime', operationKey: 'not-a-stop', runId: session.run.runId } }
  await store.reserveLifecycle(reservation); await store.commitLifecycle(reservation, null)
  const client = new AgentMuxClient({ store }), pending = new Set<Promise<unknown>>()
  const read = <T,>(promise: Promise<T>) => { pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise }
  cleanups.push(async () => { await Promise.allSettled([...pending]); expect(pending.size).toBe(0); await client.dispose(); await rm(directory, { recursive: true, force: true }) })
  const control = vi.spyOn(client, 'connect').mockRejectedValue(new Error('No Runtime permitted'))
  const catalog = vi.spyOn(api.sessions, 'historySources').mockImplementation(() => read(client.sessionHistorySources()))
  const page = vi.spyOn(api.sessions, 'historyPage').mockImplementation((reference, options) => read(client.sessionHistoryPage(reference.agentSessionId, options)))
  const timeline = vi.spyOn(api.sessions, 'timeline').mockImplementation(reference => read(client.sessionTimeline(reference.agentSessionId)))
  const projector = vi.spyOn(UserMessages, 'projectSessionUserMessages')
  useAppStore.setState({ config: null, sessions: [], timelines: {}, tabs: {}, layouts: {}, focusTimelineRuler: { mode: 'daily', timeZone: 'UTC', intervalMinutes: 120, phaseMinutes: 1380 }, agentFocus: EMPTY_AGENT_FOCUS, agentComposerDrafts: { original: 'Keep my draft' } })
  const node = document.createElement('div'); document.body.append(node); nodes.push(node)
  const root = createRoot(node); roots.push(root)
  const onSelect = vi.fn()
  const render = async (entries: readonly AgentFocusHistoryEntry[], contexts: readonly FocusContext[] = []) => act(async () => root.render(createElement(RecentFocusTimeline, { entries, contexts, lanes: lanes(contexts), currentSessionId: null, onSelect })))
  await render(initialEntries, initialContexts)
  const scale = node.querySelector<HTMLElement>('.recent-focus__time-scale')!; expect(scale).not.toBeNull()
  vi.spyOn(scale, 'getBoundingClientRect').mockReturnValue(new DOMRect(112, 28, 400, 18))
  const projectOrder = () => [...node.querySelectorAll<HTMLElement>('[data-timeline-project]')].filter(p => !p.hidden).map(p => p.dataset.timelineProject)
  const trackOrder = (project = 'alpha') => [...node.querySelectorAll<HTMLElement>(`[data-timeline-project='${key(project)}'] [data-focus-timeline-id]`)].map(p => p.dataset.focusTimelineId)
  const wheel = async (deltaX: number, shift = false) => { const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: shift ? 0 : deltaX, deltaY: shift ? deltaX : 0, deltaMode: 0 }); for (const modifier of ['shiftKey', 'ctrlKey', 'metaKey']) Object.defineProperty(event, modifier, { value: modifier === 'shiftKey' && shift }); await act(async () => scale.dispatchEvent(event)); expect(event.defaultPrevented).toBe(true) }
  const click = async (label: string) => act(async () => { const button = node.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!; expect(button).not.toBeNull(); button.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true })); button.click() })
  const wait = async (check: () => void) => { for (let i = 0; i < 100; i++) { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }); try { check(); return } catch (error) { if (i === 99) throw error } } }
  const counts = () => [catalog.mock.calls.length, page.mock.calls.length, timeline.mock.calls.length, projector.mock.calls.length]
  const choose = async () => { await click('View input records'); await wait(() => expect(document.querySelector('[aria-label="Input records Context"] option[value="archive-order"]')).not.toBeNull()); await act(async () => { const select = document.querySelector<HTMLSelectElement>('[aria-label="Input records Context"]')!; select.value = session.agentSessionId; select.dispatchEvent(new Event('change', { bubbles: true })) }) }
  const inputs = () => [...document.querySelectorAll<HTMLButtonElement>('[data-input-message-id]')]
  const unchanged = () => { expect(onSelect.mock.calls).toEqual([]); expect(control.mock.calls).toEqual([]); expect(useAppStore.getState().agentComposerDrafts).toEqual({ original: 'Keep my draft' }); expect(useAppStore.getState().agentFocus).toEqual(EMPTY_AGENT_FOCUS) }
  return { node, root, render, projectOrder, trackOrder, wheel, click, wait, counts, choose, inputs, page, unchanged }
}

it('seeds activity from actual Context task facts, never historical visits, and keeps unknown projects name/key ordered', () => {
  const entries = [entry('a', 0, 'alpha', 'Zeta'), entry('d', 20, 'beta', 'Solo')]
  const contexts = [context('a', 'Zeta', NOW - 20_000), context('d', 'Solo', NOW - 100)]
  const candidates = focusTimelineOrderCandidates(contexts, lanes(contexts), entries)
  expect(candidates.map(p => [p.key, p.activityAt])).toEqual([[key('alpha'), NOW - 20_000], [key('beta'), NOW - 100]])
  expect([...createFocusTimelineOrder(candidates).projects.keys()]).toEqual([key('beta'), key('alpha')])
  const unknownActivity = focusTimelineOrderCandidates([], [], entries)
  expect(unknownActivity.map(p => p.activityAt)).toEqual([null, null])
  expect([...createFocusTimelineOrder(unknownActivity).projects.keys()]).toEqual([key('alpha'), key('beta')])
})
it('extends only new keys, keeps old name/activity ranks and bounds ranks by current retained candidates', () => {
  const contexts = [context('a', 'Zeta', NOW - 20_000), context('d', 'Solo', NOW - 100)]
  const original = createFocusTimelineOrder(focusTimelineOrderCandidates(contexts, lanes(contexts), visits()))
  const changed = [context('a', 'AAA renamed', NOW), context('d', 'ZZZ renamed', null)]
  const same = extendFocusTimelineOrder(original, focusTimelineOrderCandidates(changed, lanes(changed), visits()))
  expect(same).toBe(original); expect([...same.projects.keys()]).toEqual([key('beta'), key('alpha')])
  const added = extendFocusTimelineOrder(same, focusTimelineOrderCandidates(changed, lanes(changed), [...visits(), entry('new', .1, 'gamma', 'A newly observed')]))
  expect([...added.projects.keys()]).toEqual([key('beta'), key('alpha'), key('gamma')])
  const removed = extendFocusTimelineOrder(added, focusTimelineOrderCandidates([], [], [entry('new', .1, 'gamma', 'A newly observed')]))
  expect([...removed.projects.keys()]).toEqual([key('gamma')]); expect([...removed.tracks.keys()]).toEqual([key('gamma', 'new')])
})
it('keeps the same nonempty project population ordered while real horizontal pan changes its first visible segment', async () => {
  const h = await fixture(), before = h.projectOrder(); expect(before).toEqual([key('alpha'), key('beta')])
  const counts = h.counts(); await h.wheel(-100)
  expect(h.projectOrder()).toEqual(before); expect(h.counts()).toEqual(counts); h.unchanged()
})
it('name-orders three actual Agent tracks and preserves two distinct same-name IDs through pan', async () => {
  const h = await fixture(), before = h.trackOrder(); expect(before).toEqual(['b', 'c', 'a'])
  await h.wheel(-100); expect(h.trackOrder()).toEqual(before); h.unchanged()
})
it('keeps established ranks during new activity/name observations and appends new tracks until a genuine re-entry', async () => {
  const originalContexts = [context('a', 'Zeta', NOW - 20_000), context('b', 'Alpha', null), context('c', 'Alpha', null), context('d', 'Solo', NOW - 100)]
  const h = await fixture(visits(), originalContexts)
  expect(h.projectOrder()).toEqual([key('beta'), key('alpha')]); expect(h.trackOrder()).toEqual(['b', 'c', 'a'])
  const changed = [context('a', 'AAA renamed', NOW), context('b', 'ZZZ renamed', null), context('c', 'Alpha', null), context('d', 'Solo', null), context('new', 'A new context', NOW)]
  await h.render(visits(), changed)
  expect(h.projectOrder()).toEqual([key('beta'), key('alpha')]); expect(h.trackOrder()).toEqual(['b', 'c', 'a', 'new'])
  await act(async () => h.root.unmount()); roots.splice(roots.indexOf(h.root), 1)
  const next = await fixture(visits(), changed)
  expect(next.projectOrder()).toEqual([key('alpha'), key('beta')]); expect(next.trackOrder()).toEqual(['new', 'a', 'c', 'b']); next.unchanged()
})
it('restores a temporarily invisible historical project to its original rank without empty rows', async () => {
  const h = await fixture(), original = h.projectOrder(); expect(original).toEqual([key('alpha'), key('beta')])
  await h.click('Next focus window'); expect(h.projectOrder()).toEqual([])
  await h.click('Previous focus window'); expect(h.projectOrder()).toEqual(original); h.unchanged()
})
it('does not acquire a timeline track merely by discovering retained metadata', async () => {
  const h = await fixture([]); await h.wait(() => expect(h.counts()[0]).toBe(1))
  expect(h.projectOrder()).toEqual([]); expect(h.inputs()).toEqual([])
  expect(h.counts().slice(0, 3)).toEqual([1, 0, 0]); h.unchanged()
})
it('keeps a truly read ninety-raw snapshot, body Range and scrolling across two hundred pan/zoom updates', async () => {
  const h = await fixture([...visits(), entry('archive-order', 1.2, 'alpha', 'Archived input')]); await h.choose(); await h.wait(() => expect(h.inputs()).toHaveLength(91))
  expect(h.page.mock.calls.map(call => call[1]?.limit)).toEqual([30, 30, 30])
  await act(async () => h.inputs()[0]!.click())
  const body = document.querySelector<HTMLElement>('[data-input-preview-id]')!; expect(body.textContent).toContain('Original native task')
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT); let text: Node | null
  while ((text = walker.nextNode()) && !text.textContent?.includes('Original native task')) {}
  expect(text).not.toBeNull(); const range = document.createRange(); range.selectNodeContents(text!)
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  const selected = selection.toString(); expect(selected.length).toBeGreaterThan(0)
  const viewport = h.node.querySelector<HTMLElement>('.recent-focus__viewport')!; viewport.scrollTop = 17; viewport.scrollLeft = 9
  const counts = h.counts(), ids = h.inputs().map(i => i.dataset.inputMessageId), before = h.projectOrder()
  expect(counts.slice(0, 3)).toEqual([1, 3, 1]); expect(counts[3]).toBeGreaterThan(0); expect(ids).toHaveLength(91)
  for (let i = 0; i < 100; i++) { await h.wheel(i % 2 ? -10 : 10, i % 3 === 0); await h.click(i % 10 === 9 ? 'Return to current focus window' : i % 2 ? 'Zoom in Focus timeline' : 'Zoom out Focus timeline') }
  await act(async () => useAppStore.setState({ timelines: { unrelated: { agentSessionId: 'unrelated', revision: 1, items: [{ id: 'bytes', agentSessionId: 'unrelated', kind: 'tool_call', source: 'native-hook', status: 'complete', createdAt: NOW, updatedAt: NOW, title: 'Unrelated output' }] } } }))
  expect(h.projectOrder()).toEqual(before); expect(h.counts()).toEqual(counts); expect(h.inputs().map(i => i.dataset.inputMessageId)).toEqual(ids)
  expect(document.querySelector('[data-input-preview-id]')).toBe(body); expect(selection.toString()).toBe(selected)
  expect([viewport.scrollTop, viewport.scrollLeft]).toEqual([17, 9]); h.unchanged()
})
