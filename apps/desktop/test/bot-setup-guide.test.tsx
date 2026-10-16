// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BotSetupGuide } from '../src/renderer/src/components/settings/BotSetupGuide'

let container: HTMLDivElement, root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('pauses local motion when offscreen or the document is hidden and releases its visibility consumer', async () => {
  let notify!: IntersectionObserverCallback
  const observe = vi.fn(), disconnect = vi.fn()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { notify = callback }
    observe = observe
    disconnect = disconnect
  })
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  await act(async () => root.render(<BotSetupGuide stage="scan" />))
  const figure = container.querySelector('figure')!
  const intersect = (isIntersecting: boolean) => notify([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver)
  expect(figure.dataset.motion).toBe('off')
  expect(observe).toHaveBeenCalledWith(figure)
  await act(async () => intersect(true))
  expect(figure.dataset.motion).toBe('on')
  hidden.mockReturnValue(true)
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(figure.dataset.motion).toBe('off')
  hidden.mockReturnValue(false)
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(figure.dataset.motion).toBe('on')
  await act(async () => intersect(false))
  expect(figure.dataset.motion).toBe('off')
  await act(async () => root.render(null))
  expect(disconnect).toHaveBeenCalledOnce()
})

it('explains the supplied stage without introducing actions, live status or a second sign-in code', async () => {
  await act(async () => root.render(<BotSetupGuide stage="scan" />))
  expect(container.querySelector('figcaption')?.textContent).toContain('confirm with your management account')
  expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  expect(container.querySelector('svg')?.getAttribute('focusable')).toBe('false')
  expect(container.querySelector('button, input, [role="status"], [aria-live], [data-confirmation-code]')).toBeNull()
  await act(async () => root.render(<BotSetupGuide stage="attention" />))
  expect(container.querySelector('figcaption')?.textContent).toContain('original setup')
  expect(container.querySelector('figure')?.dataset.botSetupGuide).toBe('attention')
})
