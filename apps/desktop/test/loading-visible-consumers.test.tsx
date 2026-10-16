// @vitest-environment happy-dom
import { fixturePath as _tailFixturePath } from "../../../test/fixture-values.mjs"
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { composerConfig } from './helpers/composer-dom-fixture'
import { FullPageLoadingSurface } from '../src/renderer/src/components/FullPageLoadingSurface'
import { SessionConnectingSurface } from '../src/renderer/src/components/SessionConnectingSurface'
import { EditorPane } from '../src/renderer/src/components/EditorPane'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'

const baseline = useAppStore.getState()
let root: Root, container: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
  useAppStore.setState({ config: composerConfig, documents: {}, documentIssues: {}, tabs: {}, layouts: {} })
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  useAppStore.setState(baseline, true); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const render = (node: ReactNode) => act(async () => root.render(node))
const stage = (visible?: boolean) => <FullPageLoadingSurface scope="region" phase="loading" title="Original wait" detail="Original work is retained" {...(visible === undefined ? {} : { visible })} />
function styleProbe() {
  const style = vi.spyOn(window, 'getComputedStyle')
  return () => style.mock.calls.filter(([node]) => node.matches('.full-page-loading, .full-page-loading__activity'))
}

it('25 actual connecting callers hidden by their existing visible fact do zero loading CSS reads and timers', async () => {
  const reads = styleProbe(), attach = vi.spyOn(api.sessions, 'attach'), recover = vi.spyOn(api.sessions, 'recover')
  await render(Array.from({ length: 25 }, (_, index) => <SessionConnectingSurface key={index} phase="connect" surfaceKind="terminal" visible={false} />))
  expect(container.querySelectorAll('.full-page-loading')).toHaveLength(25)
  await act(async () => { container.className = 'retained-owner-change' })
  expect(reads(), 'Hidden connecting loading CSS reads').toHaveLength(0); expect(vi.getTimerCount()).toBe(0)
  expect(container.querySelectorAll('[data-icon-animation="wait"]')).toHaveLength(0)
  expect(attach).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
})

it('the actual hidden Editor caller forwards visible without reading a file or loading styles', async () => {
  const reads = styleProbe(), attach = vi.spyOn(useAppStore.getState(), 'attachPersistedFileDocument')
  await render(<EditorPane tabId="original-tab" visible={false} surface={{ kind: 'file', regionId: 'original-file', workspaceId: 'workspace', path: _tailFixturePath("private/retained-file.txt") }} />)
  expect(container.querySelectorAll('.full-page-loading')).toHaveLength(1)
  expect(reads(), 'Hidden Editor loading CSS reads').toHaveLength(0); expect(attach).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
})

it('one shown caller keeps animation/clock and reveal keeps the original elapsed origin', async () => {
  const waiting = (visible: boolean) => <SessionConnectingSurface phase="connect" surfaceKind="terminal" visible={visible} />
  await render(waiting(true)); expect(vi.getTimerCount()).toBe(1)
  expect(container.querySelector('[data-icon-animation="wait"]')).not.toBeNull()
  await act(async () => vi.advanceTimersByTime(10_000))
  expect(container.querySelector('.full-page-loading__elapsed')?.textContent).toBe('10s')
  await render(waiting(false)); expect(vi.getTimerCount()).toBe(0)
  await act(async () => vi.advanceTimersByTime(20_000))
  expect(container.querySelector('.full-page-loading__elapsed')?.textContent).toBe('10s')
  await render(waiting(true)); expect(vi.getTimerCount()).toBe(1)
  expect(container.querySelector('.full-page-loading__elapsed')?.textContent, 'Original waiting origin after reveal').toBe('30s')
})

it('IO, document hidden and disconnected facts short circuit CSS while default app startup keeps its original path', async () => {
  let deliver: IntersectionObserverCallback = () => {}
  vi.stubGlobal('IntersectionObserver', class { constructor(callback: IntersectionObserverCallback) { deliver = callback } observe() {} disconnect() {} })
  const reads = styleProbe()
  await render(<FullPageLoadingSurface scope="app" phase="loading" title="Startup" detail="Original startup" />)
  expect(reads().length).toBeGreaterThan(0); expect(vi.getTimerCount()).toBe(1)
  const seen = reads().length
  await act(async () => deliver([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver))
  expect(reads()).toHaveLength(seen); expect(vi.getTimerCount()).toBe(0)
  await act(async () => { container.className = 'changed-outside-viewport' })
  expect(reads()).toHaveLength(seen)
  await act(async () => deliver([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
  expect(vi.getTimerCount()).toBe(1)
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  const shownReads = reads().length
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(reads()).toHaveLength(shownReads); expect(vi.getTimerCount()).toBe(0)
  await act(async () => container.remove())
  hidden.mockReturnValue(false)
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(reads()).toHaveLength(shownReads)
})

it('default callers retain parking CSS observation; an explicit hidden caller stays stopped across host documents', async () => {
  const native = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(node => {
    const style = native(node)
    return node.matches('.full-page-loading__activity') ? new Proxy(style, { get(target, key) {
      return key === 'animationPlayState' && node.closest('.test-parking') ? 'paused' : Reflect.get(target, key)
    } }) : style
  })
  await render(stage()); expect(vi.getTimerCount()).toBe(1)
  await act(async () => { container.className = 'test-parking' }); expect(vi.getTimerCount()).toBe(0)
  await act(async () => { container.className = '' }); expect(vi.getTimerCount()).toBe(1)
  await render(stage(false)); expect(vi.getTimerCount()).toBe(0)
  const frame = document.createElement('iframe'); document.body.append(frame)
  try {
    await act(async () => frame.contentDocument!.body.append(frame.contentDocument!.adoptNode(container)))
    expect(container.ownerDocument).toBe(frame.contentDocument); expect(vi.getTimerCount()).toBe(0)
    await act(async () => vi.advanceTimersByTime(20_000))
    expect(container.querySelector('.full-page-loading__elapsed')?.textContent).toBe('0s')
  } finally { await act(async () => { container.remove(); frame.remove() }) }
})
