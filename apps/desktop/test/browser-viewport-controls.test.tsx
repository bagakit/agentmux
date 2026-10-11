// @vitest-environment happy-dom
import { act } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import type { AppConfig, BrowserSnapshot } from '../src/shared/contracts'
import type { BrowserViewport } from '../src/shared/browser-viewport'
import type { BrowserWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'

const fixture = vi.hoisted(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  return { state: { applyBrowserEvent: vi.fn(), reportError: vi.fn(),
    executeControl: vi.fn(async () => ({ operation: 'browser.history', operations: [] })),
    saveBrowserBookmark: vi.fn(async () => 'Page.webloc'), openFile: vi.fn(async () => true),
    browserAnnotationsByBrowserId: {}, noticeReadReceipts: {}, addBrowserAnnotation: vi.fn(),
    toolsOpen: false, config: null as AppConfig | null } }
})
vi.mock('../src/renderer/src/store', () => ({ useAppStore: Object.assign(
  (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
  { getState: () => fixture.state, setState: vi.fn() }
) }))

import { BrowserPane } from '../src/renderer/src/components/BrowserPane'
import { api } from '../src/renderer/src/lib/api'

const tab = {
  id: 'viewport-browser', browserId: 'viewport-browser', regionId: 'viewport-region', workspaceId: 'viewport-workspace',
  kind: 'browser' as const, mode: 'normal' as const, navigationId: 'original-navigation', profileId: 'original-profile',
  url: 'https://example.invalid/original', title: 'Original page', loading: false, canGoBack: true,
  canGoForward: true, viewport: 'responsive' as BrowserViewport, driving: false, appLinkPrompt: null, error: null
}
const disposals: Array<() => Promise<void>> = []
const settle: Array<() => void> = []
const visibility = new WeakMap<HTMLElement, (visible: boolean, laterFocus?: HTMLElement) => Promise<void>>()
beforeEach(() => {
  vi.clearAllMocks()
  fixture.state.applyBrowserEvent.mockReset()
  fixture.state.config = { version: 9, hosts: [], executors: {}, workspaces: [], appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
})
afterEach(async () => {
  for (const close of disposals.splice(0).reverse()) await close()
  for (const complete of settle.splice(0)) await act(async () => complete())
  vi.restoreAllMocks()
})
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function mount(viewport: BrowserViewport = 'responsive') {
  const container = document.createElement('div'), root = createRoot(container)
  let current: BrowserWorkbenchSurface = { ...tab, viewport }
  let alive = true, visible = true
  document.body.append(container)
  fixture.state.applyBrowserEvent.mockImplementation((event: { type: string; browser: BrowserSnapshot }) => {
    if (!alive || event.type !== 'updated' || event.browser.id !== tab.browserId) return
    current = { ...current, ...event.browser }
    root.render(<BrowserPane tab={current} visible={visible} />)
  })
  await act(async () => root.render(<BrowserPane tab={current} visible />))
  visibility.set(container, async (value, laterFocus) => { visible = value; await act(async () => {
    flushSync(() => root.render(<BrowserPane tab={current} visible={visible} />))
    laterFocus?.focus()
  }) })
  disposals.push(async () => { alive = false; await act(async () => root.unmount()); container.remove() })
  return container
}
const tool = (container: HTMLElement, label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
const menuItems = (role: string) => [...document.querySelectorAll<HTMLElement>(`.browser-menu [role="${role}"]`)]
const item = (label: string, role = 'menuitemradio') => menuItems(role).find(node => node.querySelector('span:nth-child(2)')?.textContent === label || node.textContent?.trim() === label)
const textButton = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)!
async function key(target: HTMLElement, value: string, extra: KeyboardEventInit = {}) {
  let event!: KeyboardEvent
  await act(async () => { target.focus(); event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra }); target.dispatchEvent(event) })
  return event
}
async function click(target: HTMLElement) {
  expect(target, 'the actual rendered control must exist').toBeDefined()
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }))
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
  })
}
async function openMenu(container: HTMLElement, entry: 'direct' | 'more') {
  await key(tool(container, entry === 'direct' ? 'Viewport' : 'More browser tools'), 'ArrowDown')
  if (entry === 'more') {
    expect(menuItems('menuitemradio').find(node => node.textContent?.includes('iPhone'))).toBeUndefined()
    const sub = menuItems('menuitem').find(node => node.textContent?.includes('Viewport'))!
    expect(sub?.getAttribute('aria-haspopup')).toBe('menu')
    expect(sub?.getAttribute('data-state')).toBe('closed')
    await key(sub, 'ArrowRight')
    expect(sub.getAttribute('data-state')).toBe('open')
  }
  expect(item('iPhone 16'), 'the real options must open from this entry').toBeDefined()
}
async function openCustom(container: HTMLElement, entry: 'direct' | 'more' = 'direct') {
  await openMenu(container, entry)
  await click(item('Custom size…', 'menuitem')!)
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
  expect(dialog?.textContent).toContain('Custom viewport')
  return dialog
}
async function input(dialog: HTMLElement, label: string, value: string) {
  const field = [...dialog.querySelectorAll<HTMLInputElement>('input')].find(node => node.labels?.[0]?.textContent?.startsWith(label))!
  expect(field).toBeDefined()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return field
}
async function submit(dialog: HTMLElement) {
  await act(async () => dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}

describe('the actual Browser viewport entries and original page command', () => {
  it.each(['direct', 'more'] as const)('uses the same grouped options through the %s entry and publishes only the Main reply', async entry => {
    const request = deferred<BrowserSnapshot>(), viewport = { width: 393, height: 852, screenPosition: 'mobile' as const }
    settle.push(() => request.resolve({ ...tab, viewport }))
    const apply = vi.spyOn(api.browser, 'setViewport').mockImplementationOnce(() => request.promise)
    const container = await mount()
    await openMenu(container, entry)
    const groups = [...document.querySelectorAll<HTMLElement>('.browser-viewport-menu [role="group"][aria-label]')].map(node => node.getAttribute('aria-label'))
    expect(groups).toEqual(['Common sizes', 'Phones', 'Tablets', 'Desktop screens'])
    expect(item('Responsive')?.getAttribute('aria-checked')).toBe('true')
    await click(item('iPhone 16')!)
    expect(apply).toHaveBeenCalledExactlyOnceWith(tab.browserId, viewport)
    expect(fixture.state.applyBrowserEvent).not.toHaveBeenCalled()
    expect(document.querySelector('.browser-menu')).toBeNull()
    await act(async () => request.resolve({ ...tab, viewport }))
    expect(fixture.state.applyBrowserEvent).toHaveBeenCalledExactlyOnceWith({ type: 'updated', browser: { ...tab, viewport } })
    await openMenu(container, entry)
    expect(item('iPhone 16')?.getAttribute('aria-checked')).toBe('true')
    expect(item('Portrait')?.getAttribute('aria-checked')).toBe('true')
  })

  it('rotates actual applied dimensions by keyboard and returns to Responsive from the submenu', async () => {
    const initial = { width: 412, height: 915, screenPosition: 'mobile' as const }
    const apply = vi.spyOn(api.browser, 'setViewport').mockImplementation(async (_id, viewport) => ({ ...tab, viewport }))
    const container = await mount(initial)
    await openMenu(container, 'more')
    expect(item('Pixel 7')?.getAttribute('aria-checked')).toBe('true')
    expect(item('Portrait')?.getAttribute('aria-checked')).toBe('true')
    await key(item('Landscape')!, 'Enter')
    expect(apply).toHaveBeenCalledExactlyOnceWith(tab.browserId, { width: 915, height: 412, screenPosition: 'mobile' })
    await openMenu(container, 'direct')
    expect(item('Pixel 7')?.getAttribute('aria-checked')).toBe('true')
    expect(item('Landscape')?.getAttribute('aria-checked')).toBe('true')
    await key(item('Responsive')!, 'Enter')
    expect(apply).toHaveBeenLastCalledWith(tab.browserId, 'responsive')
    await openMenu(container, 'more')
    expect(item('Portrait')?.hasAttribute('data-disabled')).toBe(true)
    expect(item('Landscape')?.hasAttribute('data-disabled')).toBe(true)
  })

  it('validates custom dimensions in the real dialog, retains a native error and retries without changing the page target', async () => {
    const apply = vi.spyOn(api.browser, 'setViewport').mockRejectedValueOnce(new Error('Native size rejected')).mockImplementation(async (_id, viewport) => ({ ...tab, viewport }))
    const container = await mount(), dialog = await openCustom(container, 'more')
    const width = await input(dialog, 'Width', '0')
    await submit(dialog)
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('positive whole numbers')
    expect(apply).not.toHaveBeenCalled()
    await input(dialog, 'Width', '1600')
    await input(dialog, 'Height', '1000')
    await submit(dialog)
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('Native size rejected')
    expect(fixture.state.applyBrowserEvent).not.toHaveBeenCalled()
    expect(document.activeElement === width || dialog.contains(document.activeElement)).toBe(true)
    expect(textButton('Cancel').disabled).toBe(false)
    await submit(dialog)
    expect(apply.mock.calls).toEqual([[tab.browserId, { width: 1600, height: 1000, screenPosition: 'desktop' }], [tab.browserId, { width: 1600, height: 1000, screenPosition: 'desktop' }]])
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(fixture.state.applyBrowserEvent).toHaveBeenCalledExactlyOnceWith({ type: 'updated', browser: { ...tab, viewport: { width: 1600, height: 1000, screenPosition: 'desktop' } } })
  })

  it('keeps Cancel usable during application and a late old completion cannot close a later dialog', async () => {
    const request = deferred<BrowserSnapshot>(), viewport = { width: 1280, height: 800, screenPosition: 'desktop' as const }
    settle.push(() => request.resolve({ ...tab, viewport }))
    const apply = vi.spyOn(api.browser, 'setViewport').mockImplementationOnce(() => request.promise)
    const container = await mount(), first = await openCustom(container)
    await submit(first)
    expect(apply).toHaveBeenCalledExactlyOnceWith(tab.browserId, viewport)
    expect(textButton('Close').disabled).toBe(false)
    expect(textButton('Applying…').disabled).toBe(true)
    await click(textButton('Close'))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    const later = await openCustom(container, 'more')
    await input(later, 'Width', '1440')
    await act(async () => request.resolve({ ...tab, viewport }))
    expect(document.querySelector('[role="dialog"]')).toBe(later)
    expect(later.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('1440')
    await click(textButton('Cancel'))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('preserves IME ownership of Enter and Escape, then permits normal Escape cancellation', async () => {
    const apply = vi.spyOn(api.browser, 'setViewport')
    const container = await mount(), dialog = await openCustom(container)
    const width = dialog.querySelector<HTMLInputElement>('input[type="number"]')!
    expect(document.activeElement).toBe(width)
    const enter = await key(width, 'Enter', { isComposing: true })
    expect(enter.defaultPrevented).toBe(true)
    expect(apply).not.toHaveBeenCalled()
    await key(width, 'Escape', { isComposing: true })
    expect(document.querySelector('[role="dialog"]')).toBe(dialog)
    await key(width, 'Escape')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(apply).not.toHaveBeenCalled()
  })

  it('a retained hidden Browser cannot leave its viewport dialog over the newly selected work surface', async () => {
    const container = await mount()
    await openCustom(container)
    await visibility.get(container)!(false)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await visibility.get(container)!(true)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('hiding a pending viewport dialog preserves later input focus and its late completion cannot reopen it', async () => {
    const request = deferred<BrowserSnapshot>(), viewport = { width: 1280, height: 800, screenPosition: 'desktop' as const }
    settle.push(() => request.resolve({ ...tab, viewport }))
    vi.spyOn(api.browser, 'setViewport').mockImplementationOnce(() => request.promise)
    const container = await mount(), dialog = await openCustom(container)
    await submit(dialog)
    const later = document.createElement('input')
    document.body.append(later)
    disposals.push(async () => later.remove())
    await visibility.get(container)!(false, later)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(later)
    await act(async () => request.resolve({ ...tab, viewport }))
    expect(document.activeElement).toBe(later)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await visibility.get(container)!(true)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(later)
  })
})
