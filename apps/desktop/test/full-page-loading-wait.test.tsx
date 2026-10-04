// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FullPageLoadingSurface } from '../src/renderer/src/components/FullPageLoadingSurface'

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function render(phase: 'loading' | 'recovering' | 'failed' | 'parked') {
  await act(async () => root.render(<FullPageLoadingSurface scope="region" phase={phase}
    title="Restoring terminal" detail="Waiting for the original viewport." supplement={<p>Complete original recap</p>} />))
}

it('shows local waiting, marks a long wait without inventing completion, and stops when the phase ends', async () => {
  await render('recovering')
  expect(container.querySelector('.full-page-loading__waiting')?.textContent).toBe('Waiting0s')
  await act(async () => vi.advanceTimersByTime(16000))
  expect(container.querySelector('.full-page-loading__waiting')?.textContent).toBe('Still waiting16s')
  expect(container.textContent).toContain('Complete original recap')
  expect(container.querySelector('.full-page-loading__waiting')?.getAttribute('aria-live')).toBe('off')
  expect(container.querySelector('[aria-busy]')?.getAttribute('aria-busy')).toBe('true')
  await render('failed')
  expect(container.querySelector('.full-page-loading__waiting')).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
  await render('parked')
  expect(container.querySelector('.full-page-loading__activity')).toBeNull()
  await render('loading')
  expect(container.querySelector('.full-page-loading__elapsed')?.textContent).toBe('0s')
})

it('releases the clock while hidden and resumes honest elapsed time when shown', async () => {
  let visible = true
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => !visible)
  await render('loading')
  expect(vi.getTimerCount()).toBe(1)
  visible = false
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(vi.getTimerCount()).toBe(0)
  expect(container.querySelector('[data-waiting-visible]')?.getAttribute('data-waiting-visible')).toBe('false')
  await act(async () => vi.advanceTimersByTime(20000))
  expect(container.querySelector('.full-page-loading__elapsed')?.textContent).toBe('0s')
  visible = true
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(container.querySelector('.full-page-loading__elapsed')?.textContent).toBe('20s')
  expect(vi.getTimerCount()).toBe(1)
})

it('stops in a retained parked host even when its intersection does not change, including host moves', async () => {
  const style = document.createElement('style')
  style.textContent = '.test-retained-parking { clip-path: inset(50%); } .test-retained-parking .full-page-loading__activity { animation-play-state: paused; }'
  document.head.append(style)
  const parking = document.createElement('div')
  parking.className = 'test-retained-parking'
  document.body.append(parking)
  // happy-dom does not resolve SVG animation-play-state from stylesheets.
  // Native Electron verifies the real Workbench parking CSS separately.
  const computedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
    const original = computedStyle(element)
    if (!element.matches('.full-page-loading__activity')) return original
    return new Proxy(original, { get(target, property) {
      return property === 'animationPlayState' ? (element.closest('.test-retained-parking') ? 'paused' : 'running') : Reflect.get(target, property)
    } })
  })
  try {
    await render('loading')
    expect(vi.getTimerCount()).toBe(1)
    await act(async () => { container.className = 'test-retained-parking' })
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => vi.advanceTimersByTime(20000))
    expect(container.querySelector('.full-page-loading__elapsed')?.textContent).toBe('0s')
    await act(async () => { container.className = '' })
    expect(vi.getTimerCount()).toBe(1)
    expect(container.querySelector('.full-page-loading__elapsed')?.textContent).toBe('20s')
    await act(async () => { parking.append(container) })
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => { parking.className = '' })
    expect(window.getComputedStyle(container.querySelector('.full-page-loading__activity')!).animationPlayState).not.toBe('paused')
    expect(window.getComputedStyle(container.querySelector('.full-page-loading')!).visibility).not.toBe('hidden')
    expect(vi.getTimerCount()).toBe(1)
  } finally {
    await act(async () => { document.body.append(container); parking.remove(); style.remove() })
  }
})
