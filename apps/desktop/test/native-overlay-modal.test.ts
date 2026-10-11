// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { observeNativeOverlayRegions } from '../src/renderer/src/lib/native-overlay-regions'
import { opaqueComputedColor } from '../src/renderer/src/lib/overlay-paint-order'

let dispose: (() => void) | undefined
let frame: FrameRequestCallback | undefined
beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div><div data-overlay-host></div>'
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frame = callback; return 1 })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
})
afterEach(() => { dispose?.(); dispose = undefined; frame = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals() })
function floating(parent: Element, role: string, z: number, width = 140): HTMLElement {
  const node = document.createElement('div')
  node.setAttribute('role', role); node.setAttribute('data-state', 'open')
  node.textContent = role === 'presentation' ? '' : 'Original content'
  node.style.cssText = `position:fixed;z-index:${z};background-color:rgb(20,30,40);border-radius:0`
  node.getBoundingClientRect = () => new DOMRect(10, 10, width, 80)
  parent.append(node); return node
}
function modal(id: string) {
  const scope = document.createElement('div'); scope.id = id
  scope.setAttribute('data-overlay-modal-scope', id); scope.style.cssText = 'position:fixed;z-index:320;isolation:isolate'
  document.querySelector('[data-overlay-host]')!.append(scope)
  const scrim = floating(scope, 'presentation', 0), content = floating(scope, 'dialog', 1)
  for (const [node, part] of [[scrim, 'scrim'], [content, 'content']] as const) {
    node.setAttribute('data-overlay-modal-id', id); node.setAttribute('data-overlay-modal-part', part)
  }
  scrim.style.backgroundColor = 'rgba(0,0,0,.4)'
  return { scope, scrim, content }
}
function collect() {
  const publish = vi.fn()
  dispose = observeNativeOverlayRegions(document.body, () => 1, publish).dispose
  return publish
}
it('publishes the actual required pair and keeps accessory failure independent', () => {
  const { scope } = modal('actual-modal')
  const tooltip = floating(scope, 'tooltip', 140); tooltip.style.opacity = '.5'
  const publish = collect(), regions = publish.mock.calls.at(-1)![0]
  expect(regions.map((r: any) => r.modal)).toEqual([{ id: 'actual-modal', part: 'scrim' }, { id: 'actual-modal', part: 'content' }])
  expect(publish.mock.calls.at(-1)![1]).toContain('transparency')
})
it('does not leave a scrim when content is unsupported, and addresses the original presentation', () => {
  const { scope, content } = modal('retained-presentation'), failed = vi.fn()
  scope.addEventListener('agentmux:modal-presentation-failed', failed)
  content.style.backgroundColor = 'rgba(20,30,40,.96)'
  const publish = collect()
  expect(publish.mock.calls.at(-1)![0]).toEqual([])
  expect(failed).toHaveBeenCalledTimes(1)
  expect((failed.mock.calls[0]![0] as CustomEvent).detail.message).toContain('transparency')
})
it('budgets required surfaces together rather than admitting only the first member', () => {
  for (let i = 0; i < 7; i++) floating(document.querySelector('[data-overlay-host]')!, 'tooltip', 140)
  const { scope } = modal('over-budget-modal'), failed = vi.fn()
  scope.addEventListener('agentmux:modal-presentation-failed', failed)
  const regions = collect().mock.calls.at(-1)![0]
  expect(regions).toHaveLength(7)
  expect(regions.every((region: any) => region.modal === undefined)).toBe(true)
  expect(failed).toHaveBeenCalledTimes(1)
})
it('keeps a modal content descriptor when only its scrim intersects native pixels', () => {
  const { content, scrim } = modal('left-content')
  content.getBoundingClientRect = () => new DOMRect(10, 10, 100, 80)
  scrim.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600)
  const publish = vi.fn()
  dispose = observeNativeOverlayRegions(document.body, () => 1, publish, undefined,
    { revision: 1, bounds: [{ x: 400, y: 0, width: 400, height: 600 }] }).dispose
  expect(publish.mock.calls.at(-1)![0].map((region: any) => region.modal.part)).toEqual(['scrim', 'content'])
})
it('orders parent accessories above their content but below the later window modal', () => {
  const first = modal('first'), tip = floating(first.scope, 'tooltip', 140)
  // A slot can precede the retained content host in DOM; authored paint order still owns.
  first.scope.prepend(tip)
  const second = modal('second')
  const regions = collect().mock.calls.at(-1)![0]
  expect(regions.map((region: any) => region.modal?.id ?? 'accessory')).toEqual(['first', 'first', 'accessory', 'second', 'second'])
  expect(tip.isConnected && second.content.isConnected).toBe(true)
})
it('moves a reopened native top layer above its former sibling', () => {
  const first = floating(document.getElementById('root')!, 'menu', 180), second = floating(document.getElementById('root')!, 'menu', 180)
  first.setAttribute('popover', 'manual'); second.setAttribute('popover', 'manual')
  first.getBoundingClientRect = () => new DOMRect(10, 10, 101, 80)
  second.getBoundingClientRect = () => new DOMRect(10, 10, 102, 80)
  const publish = collect()
  const open = (node: Element) => { const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' }); node.dispatchEvent(event); const pending = frame; frame = undefined; pending?.(0) }
  open(first); open(second); open(first)
  expect(publish.mock.calls.at(-1)![0].map((region: any) => region.bounds.width)).toEqual([102, 101])
})
it.each(['rgb(1, 2, 3)', 'color(srgb .1 .2 .3)', 'color(display-p3 .1 .2 .3 / 1)', 'rgb(1 2 3 / 100%)'])('accepts browser-normalized opaque computed colour %s', value => {
  expect(opaqueComputedColor(value)).toBe(true)
})
it.each(['transparent', 'rgba(1, 2, 3, .96)', 'color(srgb .1 .2 .3 / .96)', 'rgb(1 2 3 / 96%)'])('retains the unsupported transparency boundary for %s', value => {
  expect(opaqueComputedColor(value)).toBe(false)
})
