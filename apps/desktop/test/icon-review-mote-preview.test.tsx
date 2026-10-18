// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { buildTheme, mountMotePreview, projectTheme, startThemeRuntime, themes } from '../scripts/icon-review/bridge.js'

let button: HTMLButtonElement, slot: HTMLSpanElement, sheet: HTMLStyleElement
let preview: ReturnType<typeof mountMotePreview> | undefined, stopTheme: () => void
let intersections: Map<Element, (visible: boolean) => void>, changes: Set<() => void>
let frames: Map<number, FrameRequestCallback>, reduced: boolean
const rect = { x: 180, y: 180, left: 180, top: 180, right: 268, bottom: 268, width: 88, height: 88, toJSON() {} }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  intersections = new Map(); changes = new Set(); frames = new Map(); reduced = false
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private listener: IntersectionObserverCallback) {}
    observe(node: Element) {
      const emit = (visible: boolean) => this.listener([{ target: node, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
      intersections.set(node, emit); emit(true)
    }
    unobserve(node: Element) { intersections.delete(node) }
    disconnect() { intersections.clear() }
  })
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ media: query,
    get matches() { return query.includes('reduced-motion') && reduced },
    addEventListener(_type: string, callback: () => void) { changes.add(callback) },
    removeEventListener(_type: string, callback: () => void) { changes.delete(callback) }
  } as MediaQueryList))
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  let sequence = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++sequence; frames.set(id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  button = document.createElement('button'); slot = document.createElement('span'); button.append(slot); document.body.append(button)
  sheet = document.createElement('style'); sheet.textContent = readFileSync('packages/client-ui/src/styles/mote-identity.css', 'utf8'); document.head.append(sheet)
  stopTheme = startThemeRuntime()
})
afterEach(async () => {
  await act(async () => { preview?.dispose(); preview = undefined })
  stopTheme(); button.remove(); sheet.remove()
  expect(intersections.size).toBe(0); expect(changes.size).toBe(0); expect(frames.size).toBe(0)
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function mount(interactive = true) {
  await act(async () => { preview = mountMotePreview(slot, { size: 88, interactive }) })
  const icon = slot.querySelector<SVGSVGElement>('svg')!
  vi.spyOn(icon, 'getBoundingClientRect').mockReturnValue(rect)
  return slot.querySelector<HTMLElement>('.mote-identity-motion')!
}
function move() {
  document.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: 285, clientY: 224 }))
  const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(10))
}
function touch(target: EventTarget, type: string) {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 17 })
  expect(target.dispatchEvent(event)).toBe(true); expect(event.defaultPrevented).toBe(false)
}

it('the workbench bridge mounts the real companion and releases its native pointer, touch and reduced-motion owner', async () => {
  const clicked = vi.fn(); button.addEventListener('click', clicked)
  const identity = await mount()
  expect(slot.querySelector('svg')?.getAttribute('data-semantic-icon')).toBe('object.mote')
  expect(slot.querySelector('.mote-companion__rig')).not.toBeNull()
  expect(slot.querySelector('svg')?.getAttribute('width')).toBe('88')
  expect(getComputedStyle(slot.querySelector('svg')!).animation).not.toContain('mote-presence')
  move(); expect(identity.dataset.moteGaze).toBe('near')
  expect(parseFloat(identity.style.getPropertyValue('--mote-gaze-x'))).toBeGreaterThan(0)
  touch(button, 'pointerdown'); expect(identity.dataset.motePress).toBe('on')
  touch(document, 'pointercancel'); expect(identity.dataset.motePress).toBeUndefined()
  button.focus(); button.click(); expect(document.activeElement).toBe(button); expect(clicked).toHaveBeenCalledOnce()
  intersections.get(identity)!(false); move()
  expect(identity.dataset.moteVisible).toBe('off'); expect(identity.dataset.moteGaze).toBe('far')
  intersections.get(identity)!(true); reduced = true; changes.forEach(change => change()); move()
  expect(identity.dataset.moteVisible).toBe('off'); expect(identity.dataset.moteGaze).toBe('far')
  reduced = false; changes.forEach(change => change()); move(); expect(identity.dataset.moteGaze).toBe('near')
  await act(async () => { preview!.dispose(); preview = undefined })
  expect(slot.children).toHaveLength(0); expect(intersections.size).toBe(0)
  move(); expect(frames.size).toBe(0)
})

it('a retained preview follows the original theme sprite and keeps explicit Mote overrides static', async () => {
  await mount()
  const svg = slot.querySelector('svg')!, rig = slot.querySelector('.mote-companion__rig')!
  expect(getComputedStyle(rig).display).toBe('inline')
  const theme = themes[0]!.id
  projectTheme(buildTheme(theme, { 'object.mote': { kind: 'glyph', glyph: 'book-open' } }), 'dark')
  expect(slot.querySelector('svg')).toBe(svg)
  expect(getComputedStyle(rig).display).toBe('none')
  expect(getComputedStyle(svg.querySelector('use')!).display).toBe('inline')
  expect(document.getElementById('agentmux-icon-object.mote')!.innerHTML).toBe(document.getElementById('agentmux-icon-space.book')!.innerHTML)
  projectTheme(buildTheme(theme, {}), 'light')
  expect(slot.querySelector('svg')).toBe(svg); expect(getComputedStyle(rig).display).toBe('inline')
})

it('the static sample stays on the semantic sprite without registering a motion consumer', async () => {
  await mount(false)
  expect(slot.querySelector('.mote-companion__rig')).toBeNull()
  expect(slot.querySelector('use')?.getAttribute('href')).toBe('#agentmux-icon-object.mote')
  expect(intersections.size).toBe(0)
  move(); expect(frames.size).toBe(0)
})
