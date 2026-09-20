// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { restorePersistedUiState, useAppStore } from '../src/renderer/src/store'
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
const baseline = useAppStore.getState()
let root: Root, container: HTMLDivElement, resizeCallback: () => void, available = 800, headerHeight = 28
const observed: Element[] = []
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resizeCallback = callback } observe(target: Element) { observed.push(target) } disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const height = this.classList.contains('recent-focus__header') ? headerHeight : available
    return { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: height, width: 1200, height, toJSON() {} }
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const config = await api.config.get(), { sessions } = await api.sessions.snapshot()
  useAppStore.setState({ config, sessions, timelines: {}, tabs: {}, agentNames: {}, focusTimelineHeight: 96, agentFocus: { execution: { sessionId: sessions[0]!.id, history: [{ sessionId: sessions[0]!.id, focusedAt: Date.now() - 60_000 }] }, pmo: { sessionId: null } } })
  await act(async () => root.render(createElement(GlobalFocusSurface)))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); available = 800; headerHeight = 28; observed.length = 0 })
const handle = () => container.querySelector<HTMLElement>('[aria-label="Resize Focus timeline"]')!
const timeline = () => container.querySelector<HTMLElement>('.recent-focus')!
const key = (value: string) => act(async () => handle().dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })))
it('keeps one complete track below a wrapping header without rewriting the saved height and restores wide geometry', async () => {
  const focus = useAppStore.getState().agentFocus, save = vi.spyOn(useAppStore.getState(), 'setFocusTimelineHeight')
  expect(timeline().style.height).toBe('96px')
  expect(observed).toContain(container.querySelector('.recent-focus__header'))
  headerHeight = 60; await act(async () => resizeCallback())
  expect(timeline().style.height).toBe('103px'); expect(handle().getAttribute('aria-valuemin')).toBe('103')
  expect(useAppStore.getState().focusTimelineHeight).toBe(96); expect(save).not.toHaveBeenCalled()
  headerHeight = 28; await act(async () => resizeCallback())
  expect(timeline().style.height).toBe('96px'); expect(useAppStore.getState().agentFocus).toBe(focus)
  headerHeight = 60; available = 200; await act(async () => resizeCallback())
  expect(timeline().style.height).toBe('82px'); expect(useAppStore.getState().focusTimelineHeight).toBe(96)
})
it('drags upward to grow, saves once at pointer-up, and keeps the main workspace usable', async () => {
  const save = vi.spyOn(useAppStore.getState(), 'setFocusTimelineHeight')
  expect(handle().getAttribute('aria-orientation')).toBe('horizontal'); expect(timeline().style.height).toBe('96px')
  await act(async () => handle().dispatchEvent(new PointerEvent('pointerdown', { clientY: 500, button: 0, bubbles: true })))
  await act(async () => window.dispatchEvent(new PointerEvent('pointermove', { clientY: 388 })))
  expect(timeline().style.height).toBe('208px'); expect(useAppStore.getState().focusTimelineHeight).toBe(96); expect(save).not.toHaveBeenCalled()
  await act(async () => window.dispatchEvent(new PointerEvent('pointerup')))
  expect(useAppStore.getState().focusTimelineHeight).toBe(208); expect(save).toHaveBeenCalledTimes(1)
  expect(document.body.style.cursor).toBe(''); expect(document.body.style.userSelect).toBe('')
  await key('End'); expect(timeline().style.height).toBe('382px')
  available = 400; await act(async () => resizeCallback())
  expect(timeline().style.height).toBe('182px'); expect(useAppStore.getState().focusTimelineHeight).toBe(382)
  available = 800; await act(async () => resizeCallback())
  expect(timeline().style.height).toBe('382px')
})
it('keyboard resizing, collapse, and persisted restoration retain height and original focus', async () => {
  const before = useAppStore.getState().agentFocus
  await key('ArrowUp'); await key('ArrowUp'); expect(timeline().style.height).toBe('128px')
  const click = (label: string) => act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click())
  await click('Collapse focus history'); expect(timeline().style.height).toBe('28px'); expect(container.querySelector('[aria-label="Resize Focus timeline"]')).toBeNull()
  await click('Show focus history'); expect(timeline().style.height).toBe('128px')
  const saved = useAppStore.persist.getOptions().partialize!(useAppStore.getState())
  expect(saved.focusTimelineHeight).toBe(128)
  await act(async () => root.unmount()); root = createRoot(container)
  await act(async () => { useAppStore.setState({ focusTimelineHeight: 96 }); useAppStore.setState(restorePersistedUiState(useAppStore.getState().config!, saved)); root.render(createElement(GlobalFocusSurface)) })
  expect(timeline().style.height).toBe('128px'); expect(useAppStore.getState().agentFocus).toBe(before)
  expect(timeline().querySelectorAll('.recent-focus__segment')).toHaveLength(1)
  await key('Home'); expect(timeline().style.height).toBe('72px')
  await key('ArrowDown'); expect(timeline().style.height).toBe('72px')
})
