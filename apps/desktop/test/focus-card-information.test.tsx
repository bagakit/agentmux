// @vitest-environment happy-dom
import { act, createElement, memo, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentTimelineItem, AgentTimelineSnapshot } from '@agentmux/core'
import type { SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
const commits = vi.hoisted(() => ({ rows: {} as Record<string, number> }))
vi.mock('../src/renderer/src/components/FocusContextRow', async original => {
  const actual = await original<typeof import('../src/renderer/src/components/FocusContextRow')>()
  return { FocusContextRow: memo((props: Parameters<typeof actual.FocusContextRow>[0]) => createElement(Profiler, { id: props.context.id, onRender: id => { commits.rows[id] = (commits.rows[id] ?? 0) + 1 } }, createElement(actual.FocusContextRow, props))) }
})
// Card/Store/request/preview owners stay real; terminal painting and hierarchy I/O are separate qualification.
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/lib/use-focus-hierarchy', () => ({ useFocusHierarchy: () => ({ facts: { topics: {}, worktrees: [] }, errors: [] }) }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { FocusNavigationPreview } from '../src/renderer/src/components/FocusNavigationPreview'
const initial = useAppStore.getState()
let root: Root, container: HTMLDivElement, base: Extract<SessionSnapshot, { kind: 'agent' }>
const message = (kind: 'user_message' | 'assistant_message', content: string, time = 3): AgentTimelineItem => ({ id: `${kind}-${time}`, agentSessionId: 'a', kind, status: 'complete', source: 'native-hook', title: kind, content, createdAt: time, updatedAt: time })
const tool = (command = 'pnpm test'): AgentTimelineItem => ({ id: 'tool-2', agentSessionId: 'a', kind: 'tool_call', status: 'complete', source: 'native-hook', title: 'Bash', toolName: 'Bash', toolInput: JSON.stringify({ command }), createdAt: 2, updatedAt: 2 })
const timeline = (id: string, items: AgentTimelineItem[]): AgentTimelineSnapshot => ({ agentSessionId: id, revision: items.length, items })
const row = (id = 'a') => { const found = container.querySelector<HTMLButtonElement>(`.focus-context[data-session-id="${id}"]`); expect(found).not.toBeNull(); return found! }
const detail = (id = 'a') => row(id).querySelector('.focus-context__detail')!.textContent
const preview = (id = 'a') => { const found = container.querySelector(`[data-preview-session="${id}"]`); expect(found).not.toBeNull(); return found!.textContent }
async function mount() { await act(async () => root.render(createElement('div', null, createElement(GlobalFocusSurface), createElement(FocusNavigationPreview)))) }
async function updateAgent(patch: Partial<Extract<SessionSnapshot, { kind: 'agent' }>>) { await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'a' ? { ...session, ...patch } as SessionSnapshot : session) }))) }
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); commits.rows = {}
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const config = await api.config.get(), snapshot = await api.sessions.snapshot()
  const agent = snapshot.sessions.find(session => session.kind === 'agent'); expect(agent).toBeDefined(); base = agent! as typeof base
  base = { ...base, id: 'a', hostId: 'local', workspacePath: '/repo', status: { state: 'working', source: base.status.source, observedAt: 1 }, control: { ...base.control, agentSessionId: 'a' } }
  useAppStore.setState({ config: { ...config, workspaces: [{ id: 'repo', name: 'Repo', kind: 'folder', hostId: 'local', path: '/repo' }] }, sessions: [base, { ...base, id: 'b', control: { ...base.control, agentSessionId: 'b' } }], timelines: { a: timeline('a', [message('user_message', 'Repair scrolling', 1), tool(), message('assistant_message', 'Checking the profile')]) }, agentNames: { a: 'Scrolling', b: 'Loading' }, tabs: {}, providerCatalog: [], mainSurface: 'agents', agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks() })
it('shows the shared recent tool instead of a later ordinary message in Global and Preview', async () => {
  const fetch = vi.spyOn(api.sessions, 'timeline'); await mount()
  expect(detail()).toBe('Bash pnpm test'); expect(preview()).toContain('Bash pnpm test')
  expect(row().textContent).not.toContain('Checking the profile'); expect(fetch).not.toHaveBeenCalled()
})
it('keeps the operation and relative file target without a second head truncation', async () => {
  await updateAgent({ workspacePath: '/repo/worktrees/scroll' })
  await act(async () => useAppStore.setState({ timelines: { a: timeline('a', [{ ...tool(), title: 'Edit', toolName: 'Edit', toolInput: JSON.stringify({ file_path: '/repo/worktrees/scroll/src/repair-scroll.ts' }) }, message('assistant_message', 'Checking')]) } })); await mount()
  expect(detail()).toBe('Edit src/repair-scroll.ts'); expect(preview()).toContain('Edit src/repair-scroll.ts')
})
it('shows the concrete permission over old activity', async () => {
  await updateAgent({ pendingInteraction: { kind: 'permission', id: 'p', title: 'Allow reading src/repair-scroll.ts?', operation: 'read' } as never }); await mount()
  expect(detail()).toBe('Allow reading src/repair-scroll.ts?'); expect(preview()).toContain('Allow reading src/repair-scroll.ts?'); expect(row().dataset.bucket).toBe('attention')
})
it('shows the actual question and selects its original Review outlet', async () => {
  await updateAgent({ pendingInteraction: { kind: 'question', id: 'q', questions: [{ id: 'release', title: 'Release', prompt: 'Ship stable or canary?', options: [{ id: 'stable', label: 'Stable' }, { id: 'canary', label: 'Canary' }] }] } as never }); await mount()
  expect(detail()).toBe('Ship stable or canary?'); expect(preview()).toContain('Ship stable or canary?')
  const control = useAppStore.getState().sessions[0]!.control
  await act(async () => row().click()); expect(useAppStore.getState().agentFocus.execution.sessionId).toBe('a')
  const review = container.querySelector<HTMLButtonElement>('.focus-toolbar__review'); expect(review).not.toBeNull()
  await act(async () => review!.click()); expect(container.querySelector('.attention-request-panel')!.textContent).toContain('Ship stable or canary?')
  expect(useAppStore.getState().sessions[0]!.control).toBe(control)
})
it('keeps failure/disconnection facts ahead of old streaming work and updates same-state detail', async () => {
  await updateAgent({ status: { ...base.status, state: 'error', detail: 'Attachment handshake failed; original Run retained' } })
  await act(async () => useAppStore.setState({ timelines: { a: timeline('a', [{ ...tool(), status: 'streaming' }]) } })); await mount()
  expect(detail()).toBe('Attachment handshake failed; original Run retained'); expect(preview()).toContain('Attachment handshake failed')
  const counts = { ...commits.rows }
  await updateAgent({ status: { ...base.status, state: 'error', detail: 'Permission channel unavailable; retry in original session' } })
  expect(detail()).toBe('Permission channel unavailable; retry in original session'); expect(preview()).toContain('Permission channel unavailable')
  expect(commits.rows).toEqual({ ...counts, a: counts.a! + 1 })
  await act(async () => row().click())
  await updateAgent({ status: { ...base.status, state: 'disconnected', detail: 'Connection lost; original session retained' } })
  expect(detail()).toBe('Connection lost; original session retained')
  expect(container.querySelector('.focus-navigation-preview__recovery')!.textContent).toContain('1 disconnected')
})
it('preserves current result content and explicitly labels later prompt/response facts', async () => {
  await updateAgent({ status: { ...base.status, state: 'done' } }); await mount()
  expect(row().dataset.bucket).toBe('results'); expect(detail()).toBe('Checking the profile')
  await act(async () => useAppStore.setState({ timelines: { a: timeline('a', [message('user_message', 'Now inspect loading', 4)]) } }))
  expect(row().dataset.bucket).toBe('idle'); expect(detail()).toBe('Prompt · Now inspect loading')
  await updateAgent({ status: { ...base.status, state: 'working' } })
  await act(async () => useAppStore.setState({ timelines: { a: timeline('a', [message('assistant_message', 'Reading the logs', 5)]) } }))
  expect(detail()).toBe('Response · Reading the logs'); expect(row().dataset.bucket).toBe('working')
})
it('keeps missing work facts honest and makes the actual activity searchable', async () => {
  await mount(); expect(detail('b')).toBe('No activity details observed'); expect(row('b').dataset.bucket).toBe('working')
  const search = container.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!; expect(search).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'pnpm test'); search.dispatchEvent(new Event('input', { bubbles: true })) })
  expect([...container.querySelectorAll<HTMLElement>('.focus-context')].map(element => element.dataset.sessionId)).toEqual(['a'])
})
it('keeps byte/observation churn free of row commits and preserves original Run controls', async () => {
  await mount(); const counts = { ...commits.rows }; expect(Object.keys(counts).sort()).toEqual(['a', 'b'])
  const controls = useAppStore.getState().sessions.map(session => session.control)
  await updateAgent({ latestOutputBytes: base.latestOutputBytes + 100, status: { ...base.status, observedAt: 500 } })
  expect(commits.rows).toEqual(counts); expect(useAppStore.getState().sessions.map(session => session.control)).toEqual(controls)
})
it('derives only the related Session for detail-only updates at both qualified input sizes', () => {
  for (const [sessionCount, projectCount] of [[14, 54], [112, 432]] as const) {
    const reads: Record<string, number> = {}
    const config = useAppStore.getState().config!
    const sessions = Array.from({ length: sessionCount }, (_, index) => ({ ...base, id: `a${index}`, status: { ...base.status, state: 'error' as const, detail: 'Original failure' } }))
    const timelines = Object.fromEntries(sessions.map(session => [session.id, new Proxy(timeline(session.id, []), { get(target, key, receiver) { if (key === 'items') reads[session.id] = (reads[session.id] ?? 0) + 1; return Reflect.get(target, key, receiver) } })]))
    const select = createFocusProjectionSelector(), input = { sessions, timelines, agentNames: {}, scratchTopicSnapshots: {}, config: { ...config, workspaces: Array.from({ length: projectCount }, (_, i) => ({ id: `w${i}`, name: `W${i}`, path: i === 0 ? '/repo' : `/other${i}`, hostId: 'local', kind: 'folder' as const })) } }
    const before = select(input); expect(before.contexts).toHaveLength(sessionCount); Object.keys(reads).forEach(id => delete reads[id])
    const updated = select({ ...input, sessions: sessions.map((s, i) => i === 0 ? { ...s, status: { ...s.status, detail: 'New failure reason' } } : s) })
    expect(updated.contexts[0]!.detail).toBe('New failure reason'); expect(updated.contexts.slice(1)).toEqual(before.contexts.slice(1)); expect(updated.laneContexts).toBe(before.laneContexts)
    expect(reads).toEqual({ a0: 2 })
  }
})
