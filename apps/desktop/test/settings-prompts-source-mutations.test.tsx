// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { liquidProductDOM } from '../scripts/fixtures/settings-liquid-motion/product-dom'

const dom = liquidProductDOM()

describe('Prompt observation lifetime through its real Settings module', () => {
  it('releases the host resize sentinel while inactive and reconnects the same visited host', async () => {
    // happy-dom does not perform layout. Only the library's visible box is
    // supplied here; real geometry and media changes stay in the Renderer proof.
    const rect = HTMLElement.prototype.getBoundingClientRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('prompt-library__items') && !this.closest('[hidden]')) return new DOMRect(0, 0, 220, 400)
      return rect.call(this)
    })
    const targets = new Map<ResizeObserver, Set<Element>>()
    const { observe, unobserve, disconnect } = ResizeObserver.prototype
    vi.spyOn(ResizeObserver.prototype, 'observe').mockImplementation(function (this: ResizeObserver, target, options) {
      if (!targets.has(this)) targets.set(this, new Set())
      targets.get(this)!.add(target)
      observe.call(this, target, options)
    })
    vi.spyOn(ResizeObserver.prototype, 'unobserve').mockImplementation(function (this: ResizeObserver, target) {
      targets.get(this)?.delete(target)
      unobserve.call(this, target)
    })
    vi.spyOn(ResizeObserver.prototype, 'disconnect').mockImplementation(function (this: ResizeObserver) {
      targets.get(this)?.clear()
      disconnect.call(this)
    })
    await dom.mount()
    const host = dom.container.querySelector<HTMLElement>('.prompt-library__items')!
    expect(host.isConnected).toBe(true)
    expect(targets.size).toBeGreaterThan(0)
    const hostCount = () => [...targets.values()].filter(nodes => nodes.has(host)).length
    expect(hostCount()).toBe(1)
    await dom.click('[data-settings-target="general"]')
    expect(dom.container.querySelector('.prompt-library__items')).toBe(host)
    expect(host.closest('[data-settings-pane]')!.hasAttribute('hidden')).toBe(true)
    expect(hostCount(), 'Inactive Prompt releases its host resize sentinel').toBe(0)
    await dom.click('[data-settings-target="prompts"]')
    expect(dom.container.querySelector('.prompt-library__items')).toBe(host)
    expect(hostCount()).toBe(1)
  })
})
