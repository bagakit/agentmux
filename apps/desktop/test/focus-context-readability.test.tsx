import { chooseFocusFilter, focusFilterOptions } from './fixtures/focus-filter-menu'
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentTimelineItem, AgentTimelineSnapshot } from '@agentmux/core'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
const draws = vi.hoisted(() => ({ counts: {} as Record<string, number>, consumers: {} as Record<string, number> }))
vi.mock('../src/renderer/src/components/AgentAvatar', () => ({ AgentAvatar: ({ sessionId, size }: { sessionId: string; size: number }) => { draws.counts[sessionId] = (draws.counts[sessionId] ?? 0) + 1; const consumer = `${sessionId}:${size}`; draws.consumers[consumer] = (draws.consumers[consumer] ?? 0) + 1; return createElement('span', { 'data-avatar': sessionId, 'data-avatar-size': size }) } }))
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
const baseline = useAppStore.getState()
let root: Root, container: HTMLDivElement
function event(id: string, kind: AgentTimelineItem['kind'], content: string, status: AgentTimelineItem['status'] = 'complete'): AgentTimelineItem { return { id, agentSessionId: 'a', kind, status, source: 'native-hook', createdAt: Number(id), updatedAt: Number(id), title: kind === 'tool_call' ? content : kind, content } }
function timeline(id: string, items: AgentTimelineItem[]): AgentTimelineSnapshot { return { agentSessionId: id, revision: items.length, items } }
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); draws.counts = {}; draws.consumers = {}
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const config = await api.config.get(), { sessions } = await api.sessions.snapshot(), base = sessions[0]!
  useAppStore.setState({ config, sessions: ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ ...base, id, label: 'Codex · demo', status: { source: base.status.source, state: (['done', 'working', 'running', 'waiting', 'error'] as const)[i]!, observedAt: 1 } })), timelines: { a: timeline('a', [event('1', 'user_message', 'Repair scrolling'), event('2', 'assistant_message', 'Scrolling repaired and checked')]), b: timeline('b', [event('3', 'user_message', 'Measure frame latency')]) }, agentNames: {}, tabs: {}, providerCatalog: [], agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
  await act(async () => root.render(createElement(GlobalFocusSurface)))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(baseline, true); vi.restoreAllMocks() })
const row = (id: string) => container.querySelector<HTMLButtonElement>(`button[data-session-id="${id}"]`)!
it('shows distinguishable task names, real result content and explicit idle/unknown states in compact project groups', () => {
  expect(row('a').textContent).toContain('Repair scrolling'); expect(row('a').textContent).toContain('Scrolling repaired and checked'); expect(row('a').dataset.bucket).toBe('results')
  expect(row('b').textContent).toContain('Measure frame latency'); expect(row('b').dataset.bucket).toBe('working')
  expect(row('c').textContent).toContain('Status unknown'); expect(row('c').dataset.bucket).toBe('idle')
  expect(row('d').dataset.bucket).toBe('attention'); expect(row('e').dataset.bucket).toBe('attention'); expect(row('e').textContent).toContain('Failed')
  expect(container.querySelectorAll('.focus-context')).toHaveLength(5)
  expect(row('a').textContent).not.toContain(useAppStore.getState().sessions[0]!.workspacePath)
  expect(container.textContent).not.toContain('PMO context is isolated'); expect(container.querySelector('.global-board-toolbar__scope')).toBeNull(); expect(container.querySelector('.focus-project-lanes__header')).toBeNull(); expect(container.querySelector('.global-board-footer')).toBeNull()
})
it('invalidates a completed result on a new prompt and authoritative working state, while retaining the Run', async () => {
  const run = useAppStore.getState().sessions[0]!.control.run
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, a: timeline('a', [...state.timelines.a!.items, event('4', 'user_message', 'Now inspect loading')]) } })))
  expect(row('a').dataset.bucket).toBe('idle'); expect(row('a').textContent).toContain('Prompt · Now inspect loading')
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(s => s.id === 'a' ? { ...s, status: { ...s.status, state: 'working' } } : s) })))
  expect(row('a').dataset.bucket).toBe('working'); expect(useAppStore.getState().sessions[0]!.control.run).toBe(run)
})
it('does not redraw neighbouring task rows when one Session receives facts', async () => {
  const counts = { ...draws.counts }, consumers = { ...draws.consumers }; expect(Object.keys(counts).sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(s => s.id === 'b' ? { ...s, latestOutputBytes: s.latestOutputBytes + 10 } : s) })))
  expect(draws.counts).toEqual(counts); expect(draws.consumers).toEqual(consumers)
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, b: timeline('b', [event('3', 'user_message', 'Measure frame latency'), event('5', 'tool_call', 'Read profile')]) } })))
  // This contract concerns the actual left task rows. Recent Focus is a separate consumer;
  // its already-existing all-track repaint is retained as a full-Focus performance counterexample.
  const leftKeys = [...container.querySelectorAll<HTMLElement>('.focus-context [data-avatar]')].map(node => `${node.dataset.avatar}:${node.dataset.avatarSize}`)
  expect(leftKeys.sort()).toEqual(['a:18', 'b:18', 'c:18', 'd:18', 'e:18'])
  const leftBefore = Object.fromEntries(leftKeys.map(key => [key, consumers[key]]))
  const leftAfter = Object.fromEntries(leftKeys.map(key => [key, draws.consumers[key]]))
  expect(leftAfter).toEqual({ ...leftBefore, 'b:18': leftBefore['b:18']! + 1 })
  const relatedTrack = container.querySelector<HTMLElement>('.recent-focus [data-avatar="b"]')
  expect(relatedTrack).not.toBeNull()
  const trackKey = `${relatedTrack!.dataset.avatar}:${relatedTrack!.dataset.avatarSize}`
  expect(consumers[trackKey]).toBeGreaterThan(0)
  expect(draws.consumers[trackKey]).toBe(consumers[trackKey]! + 1)
  expect(row('b').textContent).toContain('Read profile')
})

it('keeps empty categories discoverable in the shared filter without repeating project empties', async () => {
  expect((await focusFilterOptions(container, 'state')).map(option => option.value)).toEqual(['all', 'attention', 'working', 'results', 'idle', 'disconnected'])
  await chooseFocusFilter(container, 'state', 'results')
  expect([...container.querySelectorAll<HTMLElement>('.focus-context')].map(context => context.dataset.sessionId)).toEqual(['a'])
  expect([...container.querySelectorAll<HTMLElement>('.focus-context-group')].map(group => [group.dataset.bucket, group.dataset.empty ?? 'false'])).toEqual([['attention', 'true'], ['working', 'true'], ['results', 'false'], ['idle', 'true'], ['disconnected', 'true']])
  expect(container.textContent).not.toContain('Nothing here')
})
