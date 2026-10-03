import { fixturePath as _hygiene_fixturePath, fixtureTime as _hygiene_fixtureTime } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement, useMemo } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { agentStateEnteredAt } from '../src/renderer/src/lib/agent-state-time'
vi.mock('../src/renderer/src/components/AgentAvatar', () => ({ AgentAvatar: () => createElement('span') }))
import { FocusContextRow } from '../src/renderer/src/components/FocusContextRow'

const initial = useAppStore.getState(), now = _hygiene_fixtureTime(32774400000)
let root: Root, container: HTMLDivElement, original: SessionSnapshot
const select = vi.fn()
function Rows() {
  const projection = useMemo(createFocusProjectionSelector, [])
  return createElement('div', {}, useAppStore(projection).contexts.map(context => createElement(FocusContextRow, { key: context.id, context, selected: context.id === 'working', onSelect: select })))
}
function make(id: string, state: 'working' | 'done' | 'waiting' | 'error' | 'running', enteredAt: number | null = now - 120_000): SessionSnapshot {
  const semantic = { state: state === 'running' ? 'done' : state, source: 'native-hook' as const, observedAt: now, ...(enteredAt === null ? {} : { stateEnteredAt: enteredAt }) }
  return { ...original, id, kind: 'agent', hostId: 'local', workspacePath: _hygiene_fixturePath("private/card-state"), processState: 'running',
    status: { state, source: state === 'running' ? 'runtime' : 'native-hook', observedAt: now }, semanticStatus: state === 'running' ? undefined : semantic,
    control: { ...original.control, kind: 'agent', hostId: 'local', agentSessionId: id, run: { ...original.control.run, runId: 'run-' + id } } } as SessionSnapshot
}
const card = (id: string) => container.querySelector<HTMLButtonElement>(`button[data-session-id="${id}"]`)!
const preview = () => document.querySelector<HTMLElement>('.focus-context-hover')
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
async function focus(id: string) { await act(async () => card(id).focus()) }
async function seed(sessions: SessionSnapshot[]) { await act(async () => useAppStore.setState({ sessions })) }
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const config = await api.config.get(), snapshot = await api.sessions.snapshot(); original = snapshot.sessions.find(session => session.kind === 'agent')!
  vi.useFakeTimers(); vi.setSystemTime(now)
  const sessions = [make('working', 'working'), make('results', 'done'), make('idle', 'done'), make('unknown', 'running'), make('request', 'waiting'), make('error', 'error')]
  useAppStore.setState({ ...initial, config: { ...config, workspaces: [{ ...config.workspaces[0]!, id: 'project', hostId: 'local', path: _hygiene_fixturePath("private/card-state") }] },
    sessions, agentNames: Object.fromEntries(sessions.map(session => [session.id, 'State ' + session.id])), tabs: {}, layouts: {}, scratchTopicSnapshots: {},
    timelines: { results: { agentSessionId: 'results', revision: 1, items: [{ id: 'reply', agentSessionId: 'results', kind: 'assistant_message', title: 'Reply', status: 'complete', source: 'native-hook', content: 'A real completed reply', createdAt: now - 1000, updatedAt: now - 1000 }] } },
    agentComposerDrafts: { working: 'Original draft' } }, true)
  select.mockClear(); container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(createElement(Rows)))
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); document.getElementById('agentmux-window-overlay-host')?.remove()
  vi.useRealTimers(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('the actual card uses distinct static shapes from existing groups and preserves selection and density', () => {
  for (const id of ['working', 'results', 'idle', 'unknown', 'error']) expect(card(id).querySelector('[data-focus-state-icon]')?.getAttribute('data-focus-state-icon')).toBe(id)
  expect(card('request').querySelector('[data-focus-state-icon]')?.getAttribute('data-focus-state-icon')).toBe('attention')
  expect(card('working').getAttribute('aria-pressed')).toBe('true')
  expect(container.querySelector('.status__dot')).toBeNull()
  expect(card('working').querySelector('.focus-state-mark')?.getAttribute('aria-hidden')).toBe('true')
  expect(card('working').querySelector('.focus-context__state')?.getAttribute('title')).toBe('Working')
  expect(card('working').querySelectorAll('.focus-context__detail')).toHaveLength(1)
})

it('keyboard and pointer previews show the same admitted state age while only the open header ticks', async () => {
  const reads = [vi.spyOn(api.sessions, 'historyPage'), vi.spyOn(api.sessions, 'timeline'), vi.spyOn(api.workspaces, 'appearance')]
  const before = useAppStore.getState(); await advance(2000); expect(vi.getTimerCount()).toBe(0)
  await focus('working'); const panel = preview()!, header = panel.querySelector('header')!, inputs = panel.querySelector('.focus-context-hover__inputs')!
  expect(header.textContent).toContain('Working'); expect(header.textContent).toContain('2m'); expect(header.querySelector('[data-state-time]')?.getAttribute('data-state-time')).toBe('duration')
  const range = document.createRange(); range.selectNodeContents(inputs); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
  const count = reads[0]!.mock.calls.length; await advance(60_000)
  expect(preview()).toBe(panel); expect(panel.querySelector('.focus-context-hover__inputs')).toBe(inputs)
  expect(header.textContent).toContain('3m'); expect(reads[0]!.mock.calls.length).toBe(count)
  expect(reads.slice(1).every(read => read.mock.calls.length === 0)).toBe(true)
  expect(window.getSelection()!.getRangeAt(0).startContainer).toBe(range.startContainer)
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))); await advance(1)
  expect(preview()).toBeNull(); expect(vi.getTimerCount()).toBe(0); expect(select).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
  await act(async () => card('idle').dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 }))); await advance(180)
  expect(preview()?.querySelector('header')?.textContent).toContain('Idle'); expect(preview()?.querySelector('[data-state-time]')?.getAttribute('data-state-time')).toBe('duration')
})

it('waiting uses the same semantic entry fact and zero is a valid start', async () => {
  await focus('request'); expect(preview()?.querySelector('header')?.textContent).toContain('Waiting 2m')
  const zero = make('zero', 'done', 0); expect(agentStateEnteredAt(zero, now)).toBe(0)
  await seed([zero]); await focus('zero'); expect(preview()?.querySelector('[data-state-time]')?.getAttribute('data-state-time')).toBe('duration')
  expect(preview()?.querySelector('header')?.textContent).toContain('500000h')
})

it('missing, future, stale and mismatched control facts cannot claim a state duration', async () => {
  const missing = make('missing', 'working', null), future = make('future', 'done', now + 1)
  const stale = make('stale', 'working', now - 120_000); stale.status.observedAt = now - 500_000; if (stale.kind === 'agent' && stale.semanticStatus) stale.semanticStatus.observedAt = now - 500_000
  const wrong = make('wrong', 'done'); wrong.control.hostId = 'other-host'
  for (const session of [missing, future, stale, wrong]) {
    expect(agentStateEnteredAt(session, now)).toBeUndefined(); await seed([session]); await focus(session.id)
    expect(preview()?.querySelector('[data-state-time]')?.getAttribute('data-state-time')).not.toBe('duration')
  }
  await seed([make('unknown', 'running')]); await focus('unknown')
  expect(preview()?.querySelector('[data-state-time]')?.getAttribute('data-state-time')).toBe('unknown')
  expect(preview()?.querySelector('header')?.textContent).toContain('Activity time unknown')
})

it('known activity is an explicit fallback and identity changes remove the old clock', async () => {
  const missing = make('missing', 'working', null)
  await act(async () => useAppStore.setState({ timelines: { missing: { agentSessionId: 'missing', revision: 1, items: [{ id: 'known', agentSessionId: 'missing', kind: 'user_message', title: 'Input', status: 'complete', source: 'native-hook', content: 'Known input', createdAt: now - 90_000, updatedAt: now - 90_000 }] } } }))
  await seed([missing]); await focus('missing')
  expect(preview()?.querySelector('header')?.textContent).toContain('Last active 1m ago')
  expect(preview()?.querySelector('[data-state-time]')?.getAttribute('data-state-time')).toBe('last-active')
  const replacement = make('missing', 'working'); replacement.control.run.runId = 'replacement-run'; await seed([replacement]); await advance(200)
  expect(preview()).toBeNull(); expect(vi.getTimerCount()).toBe(0)
})
