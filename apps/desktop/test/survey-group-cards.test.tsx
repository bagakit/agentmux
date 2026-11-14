// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { createClientUiRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserRecoveryPreview } from '../src/shared/browser-recovery-preview'
import type { BrowserWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkbenchTab, addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import { SurveyTabPreview } from '../src/renderer/src/components/SurveyTabPreview'
import { SurveyTabColumn } from '../src/renderer/src/components/SurveyTabColumn'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

let root: Root, container: HTMLDivElement
async function render(content: ReactNode) {
  await act(async () => root.render(content))
  return { async rerender(next: ReactNode) { await act(async () => root.render(next)) } }
}
function named(name: string): HTMLButtonElement {
  const element = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === name)
  expect(element, name).toBeDefined(); return element!
}
const click = async (element: HTMLElement) => act(async () => element.click())
const focus = async (element: HTMLElement) => act(async () => element.focus())
const pointerOver = async (element: HTMLElement) => act(async () => element.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
const waitFor = vi.waitFor
const initial = useAppStore.getState()
const observers = new Set<ViewportObserver>()
class ViewportObserver {
  readonly targets = new Set<Element>()
  constructor(readonly callback: IntersectionObserverCallback) { observers.add(this) }
  observe(target: Element) { this.targets.add(target) }
  unobserve(target: Element) { this.targets.delete(target) }
  disconnect() { observers.delete(this); this.targets.clear() }
  takeRecords() { return [] }
  show() { this.callback([...this.targets].map(target => ({ target, isIntersecting: true }) as IntersectionObserverEntry), this as unknown as IntersectionObserver) }
}
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createClientUiRoot(container)
  vi.restoreAllMocks(); observers.clear(); useAppStore.setState(initial, true)
  vi.stubGlobal('IntersectionObserver', ViewportObserver)
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); observers.clear(); useAppStore.setState(initial, true) })
const browser = (patch: Partial<BrowserWorkbenchSurface> = {}): BrowserWorkbenchSurface => ({
  id: 'native-browser', browserId: 'native-browser', regionId: 'display-region', kind: 'browser', workspaceId: 'original-resource',
  mode: 'normal', profileId: 'original-profile', url: 'https://preview.example.test/original', navigationId: 'document-one', title: 'Original page',
  loading: false, canGoBack: false, canGoForward: false, viewport: 'responsive', error: null, driving: false, appLinkPrompt: null,
  ...patch
})
function preview(page = browser(), image = 'original-image'): BrowserRecoveryPreview {
  return { scope: page.mode === 'private' ? { browserId: page.browserId, workspaceId: page.workspaceId, mode: 'private', profileId: null }
    : { browserId: page.browserId, workspaceId: page.workspaceId, mode: 'normal', profileId: page.profileId! },
    url: page.url, title: page.title, navigationId: 'historical-document', capturedAt: 1,
    image: { dataUrl: 'data:image/jpeg;base64,' + btoa(image), width: 480, height: 300 } }
}
async function showCards() { await act(async () => { for (const observer of [...observers]) observer.show() }) }
const thumbnail = () => document.querySelector<HTMLImageElement>('.survey-tab-preview__image')
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

it('[survey-cards] reads only the visible original Browser and keeps optional preview work separate from page creation', async () => {
  const artwork = preview(), read = vi.spyOn(api.browser, 'getRecoveryPreview').mockResolvedValue({ status: 'available', preview: artwork })
  const create = vi.spyOn(api.browser, 'create'), navigate = vi.spyOn(api.browser, 'navigate')
  await render(<SurveyTabPreview browser={browser()} active><span>Original mark</span></SurveyTabPreview>)
  expect(read).not.toHaveBeenCalled()
  await showCards(); await waitFor(() => expect(thumbnail()?.src).toBe(artwork.image.dataUrl))
  expect(read).toHaveBeenCalledExactlyOnceWith('native-browser')
  expect(create).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled()
})

it.each(['browser', 'workspace', 'profile', 'mode', 'url'] as const)('[survey-cards] rejects %s mismatch without rendering another environment', async field => {
  const artwork = preview()
  if (field === 'browser') artwork.scope.browserId = 'other-browser'
  if (field === 'workspace') artwork.scope.workspaceId = 'other-resource'
  if (field === 'profile' && artwork.scope.mode === 'normal') artwork.scope.profileId = 'other-profile'
  if (field === 'mode') artwork.scope = { ...artwork.scope, mode: 'private', profileId: null }
  if (field === 'url') artwork.url = 'https://preview.example.test/other'
  const read = vi.spyOn(api.browser, 'getRecoveryPreview').mockResolvedValue({ status: 'available', preview: artwork })
  await render(<SurveyTabPreview browser={browser()} active><span>Original mark</span></SurveyTabPreview>)
  await showCards(); await waitFor(() => expect(read).toHaveBeenCalledOnce())
  expect(thumbnail()).toBeNull(); expect(document.querySelector('.survey-tab-preview__placeholder')).not.toBeNull()
})

it('[survey-cards] inactive and non-browser cards do not read historical artwork', async () => {
  const read = vi.spyOn(api.browser, 'getRecoveryPreview').mockResolvedValue({ status: 'missing' })
  const view = await render(<SurveyTabPreview browser={browser()} active={false}><span>Retained mark</span></SurveyTabPreview>)
  await showCards(); expect(read).not.toHaveBeenCalled()
  await view.rerender(<SurveyTabPreview browser={null} active><span>File mark</span></SurveyTabPreview>)
  await showCards(); expect(read).not.toHaveBeenCalled()
  expect(document.querySelector('.survey-tab-preview__placeholder')).not.toBeNull()
})

it('[survey-cards] an unconfirmed normal Profile is not replaced with an assumed environment', async () => {
  const read = vi.spyOn(api.browser, 'getRecoveryPreview').mockResolvedValue({ status: 'available', preview: preview() })
  await render(<SurveyTabPreview browser={browser({ profileId: null })} active><span>Retained mark</span></SurveyTabPreview>)
  await showCards(); expect(read).not.toHaveBeenCalled(); expect(thumbnail()).toBeNull()
})

it('[survey-cards] navigation generation withdraws the previous image before the new read settles', async () => {
  const first = preview(), next = deferred<Awaited<ReturnType<typeof api.browser.getRecoveryPreview>>>()
  const read = vi.spyOn(api.browser, 'getRecoveryPreview').mockResolvedValueOnce({ status: 'available', preview: first }).mockReturnValueOnce(next.promise)
  const view = await render(<SurveyTabPreview browser={browser()} active><span>Mark</span></SurveyTabPreview>)
  await showCards(); await waitFor(() => expect(thumbnail()?.src).toBe(first.image.dataUrl))
  // Same URL and environment, a different original document generation.
  const reloaded = browser({ navigationId: 'document-two' })
  await view.rerender(<SurveyTabPreview browser={reloaded} active><span>Mark</span></SurveyTabPreview>)
  expect(thumbnail()).toBeNull(); await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  await act(async () => { next.resolve({ status: 'missing' }) }); expect(thumbnail()).toBeNull()
})

it('[survey-cards] a late original read cannot erase the newer document image', async () => {
  const first = deferred<Awaited<ReturnType<typeof api.browser.getRecoveryPreview>>>()
  const nextPage = browser({ navigationId: 'document-two', url: 'https://preview.example.test/new-document' }), nextImage = preview(nextPage, 'new-image')
  const read = vi.spyOn(api.browser, 'getRecoveryPreview').mockReturnValueOnce(first.promise).mockResolvedValueOnce({ status: 'available', preview: nextImage })
  const view = await render(<SurveyTabPreview browser={browser()} active><span>Mark</span></SurveyTabPreview>)
  await showCards(); await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  await view.rerender(<SurveyTabPreview browser={nextPage} active><span>Mark</span></SurveyTabPreview>)
  await waitFor(() => expect(thumbnail()?.src).toBe(nextImage.image.dataUrl))
  await act(async () => { first.resolve({ status: 'available', preview: preview() }) })
  expect(thumbnail()?.src).toBe(nextImage.image.dataUrl)
})

it('[survey-cards] private artwork stays within the exact temporary Browser scope', async () => {
  const page = browser({ mode: 'private', profileId: null }), image = preview(page)
  const read = vi.spyOn(api.browser, 'getRecoveryPreview').mockResolvedValue({ status: 'available', preview: image })
  await render(<SurveyTabPreview browser={page} active><span>Private mark</span></SurveyTabPreview>)
  await showCards(); await waitFor(() => expect(thumbnail()?.src).toBe(image.image.dataUrl))
  expect(read).toHaveBeenCalledExactlyOnceWith(page.browserId)
})

it('[survey-cards] the real Tab card uses its title surface and keeps select and close separate', async () => {
  const page = browser(), image = preview(page), onSelect = vi.fn(), onClose = vi.fn()
  const read = vi.spyOn(api.browser, 'getRecoveryPreview').mockResolvedValue({ status: 'available', preview: image })
  const tab = createWorkbenchTab('original-tab', page)
  await render(<SurveyTabColumn tab={tab} selected active onSelect={onSelect} onClose={onClose} />)
  await showCards(); await waitFor(() => expect(thumbnail()?.src).toBe(image.image.dataUrl))
  const button = named('Show survey tab: Original page')
  expect(button.getAttribute('aria-current')).toBe('true')
  await click(named('Close survey tab: Original page'))
  expect(onClose).toHaveBeenCalledExactlyOnceWith('Original page'); expect(onSelect).not.toHaveBeenCalled()
  await click(button); expect(onSelect).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledExactlyOnceWith(page.browserId)
})

it('[survey-cards] a mixed Tab with a File title does not borrow an arbitrary Browser preview', async () => {
  const read = vi.spyOn(api.browser, 'getRecoveryPreview').mockResolvedValue({ status: 'available', preview: preview() })
  let tab = createWorkbenchTab('mixed-tab', { kind: 'file', regionId: 'file-region', workspaceId: 'original-resource', path: 'notes.md' })
  tab = addWorkbenchRegion(tab, 'file-region', 'right', browser())
  tab = { ...tab, layout: { ...tab.layout, activeRegionId: 'file-region' } }
  await render(<SurveyTabColumn tab={tab} selected active onSelect={() => {}} onClose={() => {}} />)
  await showCards(); expect(read).not.toHaveBeenCalled(); expect(thumbnail()).toBeNull()
  expect(document.querySelector('.survey-tab-column__other-marks')).not.toBeNull()
})

it('[survey-cards] only a genuinely overflowing title is prepared for hover and keyboard reading', async () => {
  const tab = createWorkbenchTab('original-tab', browser({ title: 'Long original research title' }))
  await render(<SurveyTabColumn tab={tab} selected={false} active={false} onSelect={() => {}} onClose={() => {}} />)
  const button = named('Show survey tab: Long original research title'), label = button.querySelector<HTMLElement>('.survey-tab-label')!, text = label.firstElementChild!
  Object.defineProperty(label, 'clientWidth', { configurable: true, value: 72 })
  Object.defineProperty(text, 'scrollWidth', { configurable: true, value: 200 })
  await pointerOver(button); expect(label.style.getPropertyValue('--survey-title-travel')).toBe('-128px')
  Object.defineProperty(text, 'scrollWidth', { configurable: true, value: 60 })
  await focus(button); expect(label.style.getPropertyValue('--survey-title-travel')).toBe('0px')
  expect(button.title).toContain('Long original research title')
})

it('[survey-cards] an unavailable thumbnail never removes the original Tab actions', async () => {
  const onSelect = vi.fn(), onClose = vi.fn()
  const read = vi.spyOn(api.browser, 'getRecoveryPreview').mockRejectedValue(new Error('Private image read unavailable'))
  const tab = createWorkbenchTab('original-tab', browser())
  await render(<SurveyTabColumn tab={tab} selected={false} active onSelect={onSelect} onClose={onClose} />)
  await showCards(); await waitFor(() => expect(read).toHaveBeenCalledOnce())
  expect(thumbnail()).toBeNull()
  await click(named('Show survey tab: Original page')); expect(onSelect).toHaveBeenCalledOnce()
  await click(named('Close survey tab: Original page')); expect(onClose).toHaveBeenCalledOnce()
})

it('[survey-cards] an unreadable image falls back without retrying or changing the Tab', async () => {
  const image = preview(), onSelect = vi.fn(), onClose = vi.fn()
  const read = vi.spyOn(api.browser, 'getRecoveryPreview').mockResolvedValue({ status: 'available', preview: image })
  const tab = createWorkbenchTab('image-tab', browser())
  await render(<SurveyTabColumn tab={tab} selected active onSelect={onSelect} onClose={onClose} />)
  await showCards(); await waitFor(() => expect(thumbnail()?.src).toBe(image.image.dataUrl))
  await act(async () => thumbnail()!.dispatchEvent(new Event('error')))
  expect(thumbnail()).toBeNull(); expect(document.querySelector('.survey-tab-preview__placeholder')).not.toBeNull()
  expect(read).toHaveBeenCalledOnce(); expect(onSelect).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled()
})
