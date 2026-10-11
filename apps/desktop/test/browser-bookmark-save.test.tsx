// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import type { AppConfig } from '../src/shared/contracts'

const fixture = vi.hoisted(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  return { state: {
    applyBrowserEvent: vi.fn(), reportError: vi.fn(),
    executeControl: vi.fn(async () => ({ operation: 'browser.history', operations: [] })),
    saveBrowserBookmark: vi.fn(async () => 'Example.webloc'), openFile: vi.fn(async () => true),
    browserAnnotationsByBrowserId: {}, noticeReadReceipts: {}, addBrowserAnnotation: vi.fn(),
    toolsOpen: false, config: null as AppConfig | null
  } }
})
vi.mock('../src/renderer/src/store', () => ({ useAppStore: Object.assign(
  (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state), { getState: () => fixture.state, setState: vi.fn() }
) }))

import { BrowserPane } from '../src/renderer/src/components/BrowserPane'
import { api } from '../src/renderer/src/lib/api'

const tab = {
  browserId: 'original-browser', regionId: 'original-region', workspaceId: 'original-workspace',
  kind: 'browser' as const, mode: 'normal' as const, navigationId: 'original-navigation', profileId: 'original-profile',
  url: 'https://example.invalid/original', title: 'Original page', loading: false, canGoBack: true,
  canGoForward: true, viewport: 'responsive' as const, driving: false, appLinkPrompt: null, error: null
}
beforeEach(() => {
  vi.clearAllMocks()
  fixture.state.saveBrowserBookmark.mockReset().mockResolvedValue('Example.webloc')
  fixture.state.config = { version: 9, hosts: [], executors: {}, workspaces: [], appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
})
afterEach(() => vi.restoreAllMocks())

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function mount() {
  const container = document.createElement('div'), root = createRoot(container)
  document.body.append(container)
  await act(async () => root.render(<BrowserPane tab={tab} visible />))
  return { container, root, async dispose() { await act(async () => root.unmount()); container.remove() } }
}
const button = (container: HTMLElement, label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
const textButton = (container: HTMLElement, text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!

it('keeps real navigation and page controls available while an original bookmark write waits, and prevents duplicate submission', async () => {
  const write = deferred<string>()
  fixture.state.saveBrowserBookmark.mockImplementationOnce(() => write.promise)
  const back = vi.spyOn(api.browser, 'back').mockResolvedValue({ ...tab, id: tab.browserId })
  const reload = vi.spyOn(api.browser, 'reload').mockResolvedValue({ ...tab, id: tab.browserId })
  const f = await mount()
  try {
    await act(async () => { const save = button(f.container, 'Save this page as a bookmark'); save.click(); save.click() })
    expect(fixture.state.saveBrowserBookmark).toHaveBeenCalledExactlyOnceWith(tab.workspaceId, tab.url, tab.title)
    expect(f.container.querySelector('[role="status"]')?.textContent).toContain('Saving bookmark')
    expect(button(f.container, 'Save this page as a bookmark').disabled).toBe(true)
    for (const label of ['Back', 'Forward', 'Reload', 'Viewport', 'Open DevTools', 'Screenshot']) expect(button(f.container, label).disabled, label).toBe(false)
    await act(async () => button(f.container, 'Back').click())
    await act(async () => button(f.container, 'Reload').click())
    expect(back).toHaveBeenCalledExactlyOnceWith(tab.browserId)
    expect(reload).toHaveBeenCalledExactlyOnceWith(tab.browserId)
    await act(async () => write.resolve('Original page.webloc'))
    expect(f.container.querySelector('.browser-bookmark-result')?.textContent).toContain('SavedOriginal page.webloc')
    await act(async () => textButton(f.container, 'Open bookmark').click())
    expect(fixture.state.openFile).toHaveBeenCalledExactlyOnceWith('Original page.webloc', undefined, undefined, tab.workspaceId)
  } finally { write.resolve('Original page.webloc'); await f.dispose() }
})

it.each(['saved', 'error', 'unknown'] as const)('keeps a late %s receipt attached to its original navigation and workspace', async outcome => {
  const write = deferred<string>()
  fixture.state.saveBrowserBookmark.mockImplementationOnce(() => write.promise)
  const f = await mount(), next = { ...tab, workspaceId: 'later-workspace', navigationId: 'later-navigation', url: 'https://example.invalid/later', title: 'Later page' }
  try {
    await act(async () => button(f.container, 'Save this page as a bookmark').click())
    await act(async () => f.root.render(<BrowserPane tab={next} visible />))
    expect(f.container.textContent).not.toContain('Saving bookmark')
    expect(button(f.container, 'Save this page as a bookmark').disabled).toBe(false)
    await act(async () => button(f.container, 'Save this page as a bookmark').click())
    expect(fixture.state.saveBrowserBookmark).toHaveBeenLastCalledWith(next.workspaceId, next.url, next.title)
    await act(async () => outcome === 'saved' ? write.resolve('Earlier.webloc') : write.reject(Object.assign(new Error('earlier write'), { status: outcome, path: 'Earlier.webloc' })))
    expect(f.container.textContent).toContain('Example.webloc')
    expect(f.container.textContent).not.toContain('Earlier.webloc')
    expect(f.container.textContent).not.toContain('earlier write')
    expect(fixture.state.reportError).not.toHaveBeenCalled()
  } finally { write.resolve('Earlier.webloc'); await f.dispose() }
})

it('shows a confirmed file failure locally and retries only after the person selects Retry', async () => {
  fixture.state.saveBrowserBookmark.mockRejectedValueOnce(Object.assign(new Error('permission denied'), { status: 'error', code: 'EACCES', path: 'Original page.webloc' }))
  const f = await mount()
  try {
    await act(async () => button(f.container, 'Save this page as a bookmark').click())
    expect(f.container.querySelector('[role="alert"]')?.textContent).toContain('Bookmark could not be saved: permission denied')
    expect(button(f.container, 'Back').disabled).toBe(false)
    expect(fixture.state.saveBrowserBookmark).toHaveBeenCalledTimes(1)
    await act(async () => textButton(f.container, 'Retry bookmark save').click())
    expect(fixture.state.saveBrowserBookmark).toHaveBeenCalledTimes(2)
    expect(f.container.querySelector('[role="alert"]')).toBeNull()
    expect(f.container.textContent).toContain('Example.webloc')
  } finally { await f.dispose() }
})

it('retains an unknown candidate while checking it and requires an explicit new copy intent before another write', async () => {
  fixture.state.saveBrowserBookmark.mockRejectedValueOnce(Object.assign(new Error('receipt unavailable'), { status: 'unknown', code: 'UNCONFIRMED', path: 'Original page.webloc' }))
  const f = await mount()
  try {
    await act(async () => button(f.container, 'Save this page as a bookmark').click())
    const original = f.container.querySelector('[role="alert"]')!
    expect(original.textContent).toContain('Bookmark save not confirmed: Original page.webloc')
    expect(f.container.querySelector('[aria-label="Save this page as a bookmark"]')).toBeNull()
    expect(textButton(f.container, 'Retry bookmark save')).toBeUndefined()
    expect(button(f.container, 'Back').disabled).toBe(false)
    await act(async () => textButton(f.container, 'Check bookmark').click())
    expect(fixture.state.openFile).toHaveBeenCalledExactlyOnceWith('Original page.webloc', undefined, undefined, tab.workspaceId)
    expect(fixture.state.saveBrowserBookmark).toHaveBeenCalledTimes(1)
    await act(async () => textButton(f.container, 'Save another copy').click())
    expect(fixture.state.saveBrowserBookmark).toHaveBeenCalledTimes(2)
    expect(f.container.querySelector('[role="alert"]')).toBe(original)
    expect(original.textContent).toContain('Original page.webloc')
    expect(f.container.querySelector('[role="status"]')?.textContent).toContain('Example.webloc')
  } finally { await f.dispose() }
})
