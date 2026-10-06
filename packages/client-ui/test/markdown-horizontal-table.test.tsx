import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMarkdown } from '../src/components/AgentMarkdown.js'

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
const content = '| Name | Link | Detail |\n| --- | --- | --- |\n| Original | [Open](https://example.com/original) | Complete original cell |'
const open = vi.fn()
async function render(visible = true) { await act(async () => root.render(<AgentMarkdown content={content} visible={visible} openHttpLink={open} />)) }
it('adds native access only to an overflowing original table and retains every cell and link', async () => {
  await render()
  const scroller = host.querySelector<HTMLDivElement>('.md-table-scroll')!, table = scroller.querySelector('table')!
  Object.defineProperties(scroller, { clientWidth: { configurable: true, value: 300 }, scrollWidth: { configurable: true, value: 900 } })
  await act(async () => resizes.forEach(callback => callback()))
  expect(scroller.tabIndex).toBe(0); expect(scroller.dataset.scrollEnd).toBe('true')
  expect(table.querySelectorAll('td')).toHaveLength(3)
  expect(table.querySelectorAll('td')[2]!.textContent).toBe('Complete original cell')
  const link = table.querySelector<HTMLButtonElement>('button')!
  expect(link).not.toBeNull()
  await act(async () => link.click())
  expect(open).toHaveBeenCalledWith('https://example.com/original', expect.any(Object))
  await act(async () => { scroller.scrollLeft = 600; scroller.dispatchEvent(new Event('scroll')) })
  expect(scroller.dataset.scrollStart).toBe('true'); expect(scroller.dataset.scrollEnd).toBeUndefined()
  Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 300 })
  await act(async () => resizes.forEach(callback => callback()))
  expect(scroller.hasAttribute('tabindex')).toBe(false)
  expect(scroller.hasAttribute('aria-label')).toBe(false)
  await render(false)
  expect(host.querySelector('table')).toBe(table)
  expect(host.querySelector('table button')).toBe(link)
  expect(disconnects.every(disconnect => disconnect.mock.calls.length > 0)).toBe(true)
})
