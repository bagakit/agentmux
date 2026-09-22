// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ScreenshotEditor } from '../src/renderer/src/components/browser-screenshot/ScreenshotEditor'
import { observeNativeOverlayRegions } from '../src/renderer/src/lib/native-overlay-regions'

const geometry = vi.hoisted(() => ({ update: undefined as undefined | (() => void), stop: vi.fn() }))
vi.mock('../src/renderer/src/lib/browser-stage-geometry', () => ({
  observeBrowserStageGeometry(stage: HTMLElement, update: () => void, active: boolean) {
    expect(stage.hasAttribute('data-native-browser-stage')).toBe(true)
    expect(active).toBe(true)
    geometry.update = update; update(); return geometry.stop
  }
}))
// Canvas rasterization has its own native proof. These tests exercise the actual editor handlers,
// body Portal, source CSS, and the one overlay collector, without starting Electron.
vi.mock('../src/renderer/src/components/browser-screenshot/canvas-render', () => ({ renderCommittedLayer() {}, renderScreenshotScene() {} }))
const browserCss = readFileSync(join(import.meta.dirname, '../src/renderer/src/styles/browser.css'), 'utf8')
const agentCss = readFileSync(join(import.meta.dirname, '../src/renderer/src/styles/agent.css'), 'utf8')
let root: Root | undefined
let overlays: ReturnType<typeof observeNativeOverlayRegions> | undefined
afterEach(async () => {
  overlays?.dispose(); overlays = undefined
  if (root) await act(async () => root!.unmount())
  root = undefined
  document.body.innerHTML = ''; document.head.innerHTML = ''
  geometry.update = undefined
  vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals()
})
function rect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON() {} }
}
function prepareCss(): void {
  expect(browserCss).toContain('.browser-screenshot-editor {')
  expect(agentCss).toContain('.surface-navigation__tooltip {')
  const style = document.createElement('style')
  style.textContent = ':root { --bg: rgb(30, 31, 32); --surface-2: rgb(40, 49, 45); --layer-dialog: 100; --layer-tooltip: 200; }\n' + browserCss + agentCss
  document.head.append(style)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
}

it('the original screenshot editor is a bounded native float; movement, markup, copy and cancel keep their real handlers', async () => {
  prepareCss()
  const container = document.createElement('div'); container.id = 'root'; document.body.append(container)
  const anchor = document.createElement('div'); anchor.dataset.nativeBrowserStage = ''; container.append(anchor)
  let stage = rect(80, 90, 400, 300)
  anchor.getBoundingClientRect = () => stage
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('browser-screenshot-editor')) return rect(Number.parseFloat(this.style.left), Number.parseFloat(this.style.top), Number.parseFloat(this.style.width), Number.parseFloat(this.style.height))
    return rect(0, 0, 400, 300)
  })
  const cancel = vi.fn(), complete = vi.fn()
  const mount = document.createElement('div'); container.append(mount)
  root = createRoot(mount)
  await act(async () => root!.render(<ScreenshotEditor anchor={anchor} image={{ mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA==', width: 400, height: 300, byteLength: 1 }} busy={false} onCancel={cancel} onComplete={complete} />))
  const editor = document.querySelector<HTMLElement>('[data-overlay-host] .browser-screenshot-editor')
  expect(editor).not.toBeNull()
  expect(anchor.isConnected).toBe(true)
  expect(container.querySelector('.browser-screenshot-editor')).toBeNull()
  expect(getComputedStyle(editor!).position).toBe('fixed')
  expect(getComputedStyle(editor!).pointerEvents).toBe('auto')
  const publish = vi.fn()
  overlays = observeNativeOverlayRegions(document.body, () => 1.25, publish)
  expect(publish.mock.calls[0]).toEqual([[{ id: 'chrome-1', bounds: { x: 100, y: 112.5, width: 500, height: 375 }, radius: 0 }], undefined])
  stage = rect(90, 120, 400, 300)
  await act(async () => { geometry.update!() })
  expect(editor!.getBoundingClientRect()).toMatchObject({ x: 90, y: 120, width: 400, height: 300 })
  const image = editor!.querySelector<HTMLImageElement>('img')!
  await act(async () => image.dispatchEvent(new Event('load')))
  const canvas = editor!.querySelector('canvas')!
  canvas.setPointerCapture = vi.fn()
  await act(async () => canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: 25, clientY: 30 })))
  await act(async () => canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 35, clientY: 40 })))
  await act(async () => canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 })))
  const buttons = [...editor!.querySelectorAll<HTMLButtonElement>('button')]
  const copy = buttons.find(button => button.textContent?.includes('Copy PNG'))!
  expect(copy.disabled).toBe(false)
  await act(async () => copy.click())
  expect(complete).toHaveBeenCalledTimes(1)
  expect(complete.mock.calls[0]![0].shapes).toEqual([expect.objectContaining({ kind: 'pen', points: [{ x: 25, y: 30 }, { x: 35, y: 40 }] })])
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  expect(cancel).toHaveBeenCalledTimes(1)
  await act(async () => root!.unmount()); root = undefined
  expect(geometry.stop).toHaveBeenCalledTimes(1)
  expect(document.querySelector('.browser-screenshot-editor')).toBeNull()
})

it('the source tooltip surface is opaque and accepted by the same collector', () => {
  prepareCss()
  document.body.innerHTML = '<div id="root"></div><div data-overlay-host><div role="tooltip" class="surface-navigation__tooltip">Actual tooltip</div></div>'
  const tooltip = document.querySelector<HTMLElement>('[role=tooltip]')!
  tooltip.getBoundingClientRect = () => rect(20, 40, 248, 38)
  const publish = vi.fn()
  overlays = observeNativeOverlayRegions(document.body, () => 1, publish)
  expect(publish.mock.calls[0]).toEqual([[{ id: 'chrome-1', bounds: { x: 20, y: 40, width: 248, height: 38 }, radius: 9 }], undefined])
})
