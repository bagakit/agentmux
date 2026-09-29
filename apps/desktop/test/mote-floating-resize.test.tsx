// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { requestPmoTeamsTopicFloatingClose, requestPmoTeamsTopicFloatingOpen,
  resolvePmoTeamsTopicFloatingSize, usePmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating.js'
import { createMoteApp } from './fixtures/mote-app'

// happy-dom has no layout. Supply only the available-space boundary while
// exercising the real App, Panel event handlers and floating persistence owner.
vi.mock('@floating-ui/dom', async importOriginal => {
  const actual = await importOriginal<typeof import('@floating-ui/dom')>()
  return { ...actual, computePosition: async (...args: Parameters<typeof actual.computePosition>) => {
    const [reference, floating, options] = args
    if (!floating.hasAttribute('data-pmo-teams-topic-floating')) return actual.computePosition(reference, floating, options)
    for (const middleware of options?.middleware ?? []) if (middleware && middleware.name === 'size')
      middleware.options.apply({ availableWidth: 400, availableHeight: 450 })
    return { x: 8, y: 8, placement: 'top-start', strategy: 'fixed', middlewareData: {} }
  } }
})

const key = 'agentmux.leader-topic-floating.v1'
let root: Root, container: HTMLDivElement
let update: ReturnType<typeof usePmoTeamsTopicFloatingState>[1]
function Owner() {
  const [floating, setFloating] = usePmoTeamsTopicFloatingState(); update = setFloating
  return createElement('output', null, JSON.stringify(floating))
}
const current = () => JSON.parse(container.querySelector('output')!.textContent!)
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear(); container = document.createElement('div'); document.body.append(container)
  root = createRoot(container); await act(async () => root.render(createElement(Owner)))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); localStorage.clear(); vi.restoreAllMocks() })

it('persists both dimensions through close, same target reopen and owner remount', async () => {
  await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: 'launcher:analyst', targetTabId: 'original-tab' }))
  await act(async () => update({ size: { width: 610, height: 430 }, railMode: 'avatars' }))
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ open: true, targetTopicId: 'launcher:analyst', targetTabId: 'original-tab', railMode: 'avatars', size: { width: 610, height: 430 } })
  await act(async () => requestPmoTeamsTopicFloatingClose())
  await act(async () => requestPmoTeamsTopicFloatingOpen())
  expect(current()).toMatchObject({ targetTabId: 'original-tab', railMode: 'avatars', size: { width: 610, height: 430 } })
  await act(async () => root.unmount()); root = createRoot(container)
  await act(async () => root.render(createElement(Owner)))
  expect(current()).toEqual({ open: true, preview: false, targetTopicId: 'launcher:analyst', targetTabId: 'original-tab', railMode: 'avatars', size: { width: 610, height: 430 } })
})

it('keeps small viewports within available space and preserves the large preference', () => {
  const preference = { width: 810, height: 650 }
  expect(resolvePmoTeamsTopicFloatingSize(preference, { width: 100, height: 90 }, 'cards', 320)).toEqual({ width: 100, height: 90 })
  expect(preference).toEqual({ width: 810, height: 650 })
  expect(resolvePmoTeamsTopicFloatingSize(preference, { width: 920, height: 700 }, 'cards', 980)).toEqual(preference)
  expect(resolvePmoTeamsTopicFloatingSize({ width: 1, height: 1 }, { width: 900, height: 600 }, 'cards', 980)).toEqual({ width: 404, height: 250 })
  expect(resolvePmoTeamsTopicFloatingSize({ width: 1, height: 1 }, { width: 900, height: 600 }, 'avatars', 980)).toEqual({ width: 288, height: 250 })
})

it('keeps the current size and target usable while a failed save is clearly reported', async () => {
  await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTabId: 'original-tab' }))
  const save = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
  await act(async () => update({ size: { width: 620, height: 410 } }))
  expect(current()).toMatchObject({ open: true, targetTabId: 'original-tab', size: { width: 620, height: 410 } })
  expect(current().preferenceIssue).toContain('could not be saved')
  save.mockRestore(); await act(async () => update({ size: { width: 630, height: 420 } }))
  expect(current().preferenceIssue).toBeUndefined()
  expect(JSON.parse(localStorage.getItem(key)!).size).toEqual({ width: 630, height: 420 })
})

it('reads only a complete finite positive preferred size and exposes read failures', async () => {
  await act(async () => root.unmount())
  localStorage.setItem(key, JSON.stringify({ open: true, size: { width: -1, height: 420 }, targetTabId: 'original-tab' }))
  root = createRoot(container); await act(async () => root.render(createElement(Owner)))
  expect(current()).toEqual({ open: true, preview: false, targetTabId: 'original-tab' })
  await act(async () => root.unmount()); localStorage.setItem(key, '{bad JSON')
  root = createRoot(container); await act(async () => root.render(createElement(Owner)))
  expect(current()).toMatchObject({ open: false, preview: false })
  expect(current().preferenceIssue).toContain('could not be read')
})

it.each(['pointercancel', 'blur', 'Escape'])('the real Panel keeps one gesture owner and restores body styles after %s', async termination => {
  await act(async () => root.unmount()); root = createRoot(container)
  const app = createMoteApp()
  try {
    await app.mount(); await app.hover()
    await act(async () => requestPmoTeamsTopicFloatingOpen())
    const handle = app.panel().querySelector<HTMLElement>('[aria-label="Resize Mote window"]')!
    expect(handle).not.toBeNull()
    const captured = new Set<number>()
    handle.setPointerCapture = vi.fn(id => { captured.add(id) })
    handle.hasPointerCapture = id => captured.has(id)
    handle.releasePointerCapture = vi.fn(id => { captured.delete(id) })
    document.body.style.cursor = 'crosshair'; document.body.style.userSelect = 'text'
    const dispatch = async (type: string, pointerId: number) => act(async () => handle.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerType: 'touch', pointerId, button: 0, clientX: 80, clientY: 80
    })))
    await act(async () => update({ size: { width: 810, height: 650 } }))
    const unclampedPreference = localStorage.getItem(key)
    await dispatch('pointerdown', 7); await dispatch('pointerup', 7)
    expect(localStorage.getItem(key)).toBe(unclampedPreference)
    expect(JSON.parse(unclampedPreference!).size).toEqual({ width: 810, height: 650 })
    vi.mocked(handle.setPointerCapture).mockClear()
    await dispatch('pointerdown', 7)
    const before = localStorage.getItem(key)
    await dispatch('pointerdown', 9); await dispatch('pointercancel', 9)
    expect(handle.setPointerCapture).toHaveBeenCalledTimes(1)
    expect(app.panel().dataset.moteResizing).toBe('true')
    const arrow = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
    await act(async () => handle.dispatchEvent(arrow))
    expect(arrow.defaultPrevented).toBe(true); expect(localStorage.getItem(key)).toBe(before)
    if (termination === 'blur') await act(async () => window.dispatchEvent(new Event('blur')))
    else if (termination === 'Escape') {
      const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      await act(async () => handle.dispatchEvent(escape)); expect(escape.defaultPrevented).toBe(true)
    } else await dispatch('pointercancel', 7)
    expect(app.panel().dataset.moteResizing).toBe('false')
    expect(app.panel().dataset.motePresentation).toBe('pinned')
    expect(document.body.style.cursor).toBe('crosshair'); expect(document.body.style.userSelect).toBe('text')
    expect(captured.size).toBe(0); expect(localStorage.getItem(key)).toBe(before)
  } finally { await app.dispose(); document.body.style.cursor = ''; document.body.style.userSelect = '' }
})

it.each([
  [0, 0, { width: 810, height: 650 }],
  [-20, 0, { width: 380, height: 650 }],
  [0, 20, { width: 810, height: 430 }],
  [-20, 20, { width: 380, height: 430 }]
])('real Panel commits only explicitly changed axes for delta %s/%s', async (dx, dy, expected) => {
  await act(async () => root.unmount()); root = createRoot(container)
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 420 })
  const app = createMoteApp()
  try {
    await app.mount(); await app.hover(); await act(async () => requestPmoTeamsTopicFloatingOpen())
    await act(async () => update({ size: { width: 810, height: 650 } }))
    const panel = app.panel(), handle = panel.querySelector<HTMLElement>('[aria-label="Resize Mote window"]')!
    expect(handle).not.toBeNull()
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({ x:8, y:8, width:400, height:450, top:8, left:8, right:408, bottom:458, toJSON() {} })
    const captured = new Set<number>()
    handle.setPointerCapture = id => { captured.add(id) }; handle.hasPointerCapture = id => captured.has(id)
    handle.releasePointerCapture = id => { captured.delete(id) }
    for (const [type, x, y] of [['pointerdown', 80, 80], ['pointermove', 80 + Number(dx), 80 + Number(dy)], ['pointerup', 80 + Number(dx), 80 + Number(dy)]] as const)
      await act(async () => handle.dispatchEvent(new PointerEvent(type, { bubbles:true, cancelable:true, pointerId:7, pointerType:'mouse', button:0, clientX:x, clientY:y })))
    expect(JSON.parse(localStorage.getItem(key)!).size).toEqual(expected)
    expect(captured.size).toBe(0)
  } finally { await app.dispose() }
})
