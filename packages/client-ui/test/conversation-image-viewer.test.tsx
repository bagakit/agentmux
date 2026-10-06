import { fixturePath } from '../../../test/fixture-values.mjs'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { ConversationImage } from '../src/components/ConversationImage.js'
import { AgentMarkdown } from '../src/components/AgentMarkdown.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const path = fixturePath('.agentmux/pasted/diagram.png')
const dataUrl = 'data:image/png;base64,image-fixture'
const reader = vi.fn(async () => ({ dataUrl }))
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null,
  renderProjectLabel: () => null, renderIcon: () => null }
let width: number, height: number, resize: () => void
const mounts: { root: Root; host: HTMLElement }[] = []
beforeEach(() => {
  width = 600; height = 400; reader.mockClear()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe() {} disconnect() {}
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function () { return this.classList.contains('md-conversation-image__viewport') ? width : 0 })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function () { return this.classList.contains('md-conversation-image__viewport') ? height : 0 })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () { return new DOMRect(0, 0, this.classList.contains('md-conversation-image__viewport') ? width : 0, height) })
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(1200)
  vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(800)
})
afterEach(async () => {
  for (const { root, host } of mounts.splice(0)) { await act(async () => root.unmount()); host.remove() }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function mount(content: ReactNode) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); mounts.push({ root, host })
  await act(async () => root.render(<ClientUiProvider platform={platform}>{content}</ClientUiProvider>))
  return host
}
async function click(element: Element) { await act(async () => (element as HTMLElement).click()) }
const full = () => document.querySelector<HTMLImageElement>('.md-conversation-image__full')!
const viewport = () => document.querySelector<HTMLDivElement>('.md-conversation-image__viewport')!
const button = (label: string) => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
function transform() {
  expect(full()).not.toBeNull()
  const numbers = full().style.transform.match(/-?[\d.]+/g)!.map(Number)
  expect(numbers).toHaveLength(3)
  return { x: numbers[0]!, y: numbers[1]!, scale: numbers[2]! }
}
async function open() {
  const host = await mount(<AgentMarkdown content={`Inspect @${path}`} readPastedImage={reader} />)
  const trigger = host.querySelector<HTMLButtonElement>('.md-conversation-image')!
  expect(trigger).not.toBeNull()
  await act(async () => trigger.focus())
  await click(trigger)
  expect(full().src).toBe(dataUrl)
  expect(full().style.width).toBe('600px')
  expect(button('Zoom in').disabled).toBe(false)
  return { host, trigger }
}
async function wheel(deltaY: number, options: WheelEventInit = {}) {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, ...options })
  // happy-dom's WheelEvent extends UIEvent, so supply the real browser's MouseEvent fields.
  for (const key of ['ctrlKey', 'metaKey', 'clientX', 'clientY'] as const) Object.defineProperty(event, key, { value: options[key] ?? (key.endsWith('Key') ? false : 0) })
  await act(async () => viewport().dispatchEvent(event))
  return event
}
async function pointer(type: string, clientX: number, clientY: number, pointerId = 1) {
  await act(async () => viewport().dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId, button: 0, clientX, clientY })))
}

it('zooms the actual Markdown image at the wheel anchor and leaves an ordinary fitted scroll alone', async () => {
  await open()
  await wheel(60)
  expect(transform()).toEqual({ x: 0, y: 0, scale: 1 })
  const event = await wheel(-200 * Math.log(2), { ctrlKey: true, clientX: 400, clientY: 240 })
  expect(event.defaultPrevented).toBe(true)
  expect(transform()).toEqual({ x: -100, y: -40, scale: 2 })
  expect(reader).toHaveBeenCalledExactlyOnceWith(path)
})

it('keeps native pixel detail reachable and constrains wheel pan to the current image edges', async () => {
  await open()
  await wheel(-1_000, { metaKey: true })
  expect(transform().scale).toBe(4)
  await wheel(-10_000, { deltaX: 10_000 })
  expect(transform()).toEqual({ x: -900, y: 600, scale: 4 })
  await click(button('Fit image'))
  expect(transform()).toEqual({ x: 0, y: 0, scale: 1 })
  expect(button('Zoom out').disabled).toBe(true)
})

it('does not turn a small pointer motion into a pan and releases capture on cancellation', async () => {
  await open()
  await wheel(-200 * Math.log(2), { ctrlKey: true, clientX: 300, clientY: 200 })
  const capture = vi.fn(), release = vi.fn()
  viewport().setPointerCapture = capture; viewport().releasePointerCapture = release; viewport().hasPointerCapture = () => true
  await pointer('pointerdown', 300, 200)
  expect(capture).toHaveBeenCalledExactlyOnceWith(1)
  await pointer('pointermove', 302, 201)
  expect(transform()).toEqual({ x: 0, y: 0, scale: 2 })
  await pointer('pointermove', 800, 700, 2)
  expect(transform()).toEqual({ x: 0, y: 0, scale: 2 })
  await pointer('pointermove', 10_000, 10_000)
  expect(transform()).toEqual({ x: 300, y: 200, scale: 2 })
  await pointer('pointercancel', 10_000, 10_000)
  expect(release).toHaveBeenCalledExactlyOnceWith(1)
  await pointer('pointermove', 100, 100)
  expect(transform()).toEqual({ x: 300, y: 200, scale: 2 })
})

it('reclamps a resized viewport without rereading bytes and supports keyboard fit and Radix dismissal', async () => {
  const { trigger } = await open()
  await wheel(-200 * Math.log(2), { ctrlKey: true, clientX: 0, clientY: 0 })
  expect(transform()).toEqual({ x: 300, y: 200, scale: 2 })
  width = 300; height = 200
  await act(async () => resize())
  expect(full().style.width).toBe('300px')
  expect(transform()).toEqual({ x: 150, y: 100, scale: 2 })
  await act(async () => viewport().dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true, cancelable: true })))
  expect(transform()).toEqual({ x: 0, y: 0, scale: 1 })
  await click(button('Zoom in'))
  expect(transform().scale).toBe(1.25)
  await click(button('Close image'))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(document.activeElement).toBe(trigger)
  expect(reader).toHaveBeenCalledTimes(1)
})

it('keeps the original decode-failure owner instead of leaving broken viewing controls', async () => {
  const host = await mount(<ConversationImage path={path} text={`@${path}`} readImage={reader} />)
  await click(host.querySelector('.md-conversation-image')!)
  await act(async () => full().dispatchEvent(new Event('error')))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(host.querySelector('.md-conversation-image__reference')?.textContent).toBe(`@${path}`)
  expect(host.querySelector('[aria-label="Retry image"]')).not.toBeNull()
})

it('ends an active drag before another zoom or resize changes its coordinate baseline', async () => {
  await open()
  await wheel(-200 * Math.log(2), { ctrlKey: true, clientX: 300, clientY: 200 })
  await pointer('pointerdown', 300, 200)
  await pointer('pointermove', 350, 250)
  expect(transform()).toEqual({ x: 50, y: 50, scale: 2 })
  await click(button('Zoom in'))
  const zoomed = transform()
  expect(zoomed.scale).toBe(2.5)
  await pointer('pointermove', 360, 260)
  expect(transform()).toEqual(zoomed)
  await pointer('pointerdown', 300, 200)
  width = 300; height = 200
  await act(async () => resize())
  const resized = transform()
  await pointer('pointermove', 400, 300)
  expect(transform()).toEqual(resized)
})
