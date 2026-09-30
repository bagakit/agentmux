// @vitest-environment happy-dom
import { act, createElement, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
vi.mock('../src/renderer/src/components/PmoTeamsTopicEntry', () => ({ PmoTeamsTopicEntry: () => createElement('button', null, 'PMO') }))
import { SurfaceSwitch } from '../src/renderer/src/components/TopRowChrome'
const baseline = useAppStore.getState()
let root: Root, container: HTMLDivElement
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const { sessions } = await api.sessions.snapshot(), config = await api.config.get(), base = sessions[0]!
  useAppStore.setState({ config, mainSurface: 'workbench', sessions: ['working', 'starting', 'running', 'waiting', 'error', 'done'].map((state, i) => ({ ...base, id: `s${i}`, status: { ...base.status, state: state as typeof base.status.state } })) })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(baseline, true); vi.restoreAllMocks() })
it('folds real work and combined attention counts into exactly one Focus navigation target', async () => {
  await act(async () => root.render(createElement(SurfaceSwitch)))
  const focus = container.querySelector<HTMLButtonElement>('.surface-navigation__focus')!
  expect(focus).toBeTruthy(); expect(focus.querySelector('[data-focus-count="working"]')!.textContent).toBe('2'); expect(focus.querySelector('[data-focus-count="attention"]')!.textContent).toBe('2')
  expect(focus.getAttribute('aria-label')).toContain('2 working, 1 requests, 1 failed'); expect(focus.querySelector('button')).toBeNull(); expect(container.querySelectorAll('[data-focus-count="working"]')).toHaveLength(1)
  await act(async () => focus.click()); expect(useAppStore.getState().mainSurface).toBe('agents'); expect(focus.getAttribute('aria-current')).toBe('page')
})
it('does not redraw navigation for bytes from a Session when its relevant facts are unchanged', async () => {
  const commits = vi.fn()
  await act(async () => root.render(createElement(Profiler, { id: 'navigation', onRender: commits }, createElement(SurfaceSwitch))))
  const before = commits.mock.calls.length; expect(before).toBeGreaterThan(0)
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(s => ({ ...s, latestOutputBytes: s.latestOutputBytes + 128 })) })))
  expect(commits.mock.calls.length).toBe(before)
})
it('keeps typed requests visible before their display status catches up and hides zero badges', async () => {
  await act(async () => useAppStore.setState(state => ({ sessions: [{ ...state.sessions[2]!, pendingInteraction: { kind: 'question', id: 'pending' } as never }] })))
  await act(async () => root.render(createElement(SurfaceSwitch)))
  expect(container.querySelector('[data-focus-count="working"]')).toBeNull(); expect(container.querySelector('[data-focus-count="attention"]')!.textContent).toBe('1')
  await act(async () => useAppStore.setState({ sessions: [] }))
  expect(container.querySelectorAll('[data-focus-count]')).toHaveLength(0); expect(container.querySelector('.surface-navigation__focus')).toBeTruthy()
})
