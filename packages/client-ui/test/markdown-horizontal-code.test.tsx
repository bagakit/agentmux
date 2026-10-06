import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MarkdownCodeBlock } from '../src/components/MarkdownCodeBlock.js'

let host: HTMLDivElement, root: Root, resizes: (() => void)[], disconnects: ReturnType<typeof vi.fn>[]
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  resizes = []; disconnects = []
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) { this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
    disconnect() {}
  })
  vi.stubGlobal('ResizeObserver', class {
    disconnect = vi.fn()
    constructor(callback: () => void) { resizes.push(callback); disconnects.push(this.disconnect) }
    observe() {}
  })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
async function render(visible = true) { await act(async () => root.render(<MarkdownCodeBlock code={'original source '.repeat(40)} visible={visible} />)) }
async function geometry(width: number, content: number, left = 0) {
  const element = host.querySelector('pre')!
  Object.defineProperties(element, { clientWidth: { configurable: true, value: width }, scrollWidth: { configurable: true, value: content }, scrollLeft: { configurable: true, writable: true, value: left } })
  await act(async () => resizes.forEach(callback => callback()))
  return element
}
it('exposes only actual overflow, clears each reached edge and keeps native scrolling and source', async () => {
  await render()
  const pre = await geometry(300, 900)
  expect(pre.tabIndex).toBe(0)
  expect(pre.dataset.scrollStart).toBeUndefined()
  expect(pre.dataset.scrollEnd).toBe('true')
  expect(pre.textContent).toBe('original source '.repeat(40))
  await act(async () => { pre.scrollLeft = 600; pre.dispatchEvent(new Event('scroll')) })
  expect(pre.dataset.scrollStart).toBe('true')
  expect(pre.dataset.scrollEnd).toBeUndefined()
  await geometry(900, 900)
  expect(pre.hasAttribute('tabindex')).toBe(false)
  expect(pre.hasAttribute('aria-label')).toBe(false)
  expect(pre.dataset.scrollStart).toBeUndefined()
  expect(pre.dataset.scrollEnd).toBeUndefined()
})
it('parks the original offscreen consumer and releases its geometry observers', async () => {
  await render()
  const pre = await geometry(300, 900)
  await render(false)
  expect(host.querySelector('pre')).toBe(pre)
  expect(pre.hasAttribute('tabindex')).toBe(false)
  expect(disconnects.every(disconnect => disconnect.mock.calls.length > 0)).toBe(true)
})
