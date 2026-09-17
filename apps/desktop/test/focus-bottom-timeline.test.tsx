// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
const baseline = useAppStore.getState()
let root: Root, container: HTMLDivElement
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const config = await api.config.get(), { sessions } = await api.sessions.snapshot()
  useAppStore.setState({ config, sessions, timelines: {}, tabs: {}, agentNames: {}, agentFocus: { execution: { sessionId: sessions[1]!.id, history: [{ sessionId: sessions[0]!.id, focusedAt: 1000 }, { sessionId: sessions[1]!.id, focusedAt: 61000 }] }, pmo: { sessionId: null } } })
  await act(async () => root.render(createElement(GlobalFocusSurface)))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(baseline, true); vi.restoreAllMocks() })
it('places one bounded history after both work areas using only known focus times', () => {
  const surface = container.querySelector('.global-focus-surface')!, history = container.querySelector('.recent-focus')!, work = container.querySelector('.global-focus-layout')!
  expect(history.parentElement).toBe(surface); expect(history.previousElementSibling).toBe(work); expect(work.querySelector('.global-session-workspace')).toBeTruthy()
  const clips = [...history.querySelectorAll<HTMLButtonElement>('.recent-focus__segment')]
  expect(clips).toHaveLength(2); expect(clips[0]!.dataset).toMatchObject({ focusedAt: '1000', knownEnd: '61000' }); expect(clips[0]!.style.width).toBe('100%')
  expect(clips[1]!.dataset.focusedAt).toBe('61000'); expect(clips[1]!.hasAttribute('data-known-end')).toBe(false); expect(clips[1]!.style.left).toBe('100%'); expect(clips[1]!.style.width).toBe(''); expect(clips[1]!.getAttribute('aria-label')).toContain('next focus not recorded')
  expect(history.querySelector<HTMLElement>('.recent-focus__playhead')!.style.left).toBe('100%')
})
it('zooms, expands and collapses without changing original focus or creating another history owner', async () => {
  const before = useAppStore.getState().agentFocus, history = container.querySelector<HTMLElement>('.recent-focus')!
  const click = (label: string) => act(async () => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click())
  await click('Zoom in focus history'); expect(container.querySelector<HTMLElement>('.recent-focus__canvas')!.style.getPropertyValue('--timeline-zoom')).toBe('2')
  await click('Expand focus history'); expect(history.dataset.mode).toBe('expanded')
  await click('Collapse focus history'); expect(history.dataset.mode).toBe('collapsed'); expect(history.querySelector('.recent-focus__viewport')).toBeNull()
  await click('Show focus history'); expect(history.querySelectorAll('.recent-focus__segment')).toHaveLength(2); expect(useAppStore.getState().agentFocus).toBe(before)
  const first = history.querySelector<HTMLButtonElement>('.recent-focus__segment')!; first.focus(); expect(document.activeElement).toBe(first)
  await act(async () => first.click()); expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(useAppStore.getState().sessions[0]!.id)
})
