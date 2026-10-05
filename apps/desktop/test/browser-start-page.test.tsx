import { fixtureTime as _hygiene_fixtureTime } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { BrowserStartPage } from '../src/renderer/src/components/BrowserStartPage'
import { BrowserStartPageSettings } from '../src/renderer/src/components/settings/BrowserStartPageSettings'
import { BrowserPane } from '../src/renderer/src/components/BrowserPane'
import { DEFAULT_BROWSER_START_PAGE } from '../src/shared/browser-start-page'
import type { BrowserInputHistorySnapshot } from '../src/shared/browser-input-history'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

const original = useAppStore.getState()
const target = { kind: 'browser' as const, browserId: 'original-browser', profileId: 'original-profile' }
const entries = [
  { text: 'https://docs.example.test/guide', submittedAt: _hygiene_fixtureTime(24551826003) },
  { text: 'protocol design notes', submittedAt: _hygiene_fixtureTime(24474400000) },
  { text: 'http://localhost:5173/', submittedAt: _hygiene_fixtureTime(24374400000) }
]
const snapshot = { scope: { workspaceId: 'original-workspace', profileId: target.profileId }, entries }
let host: HTMLDivElement, root: ReturnType<typeof createClientUiRoot>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(api.browser, 'listInputHistory').mockResolvedValue(snapshot)
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); useAppStore.setState(original) })
const render = async (content: Parameters<typeof root.render>[0]) => { await act(async () => { root.render(content) }) }
const click = async (selector: string) => { const button = host.querySelector<HTMLButtonElement>(selector)!; expect(button).not.toBeNull(); await act(async () => button.click()) }
const choose = vi.fn()
const page = (changes = {}) => <BrowserStartPage config={{ ...DEFAULT_BROWSER_START_PAGE, ...changes }} historyTarget={target} onChooseHistory={choose}><input aria-label="Start input" /></BrowserStartPage>

it('renders configured titles and optional images, with no image space when omitted', async () => {
  await render(page({ title: 'Local research', subtitle: 'Return to a useful question', icon: 'https://images.example.test/icon.png', backgroundImage: 'https://images.example.test/scene.jpg', showHistory: false }))
  expect(host.querySelector('h1')?.textContent).toBe('Local research')
  expect(host.querySelector('.browser-start-page__brand p')?.textContent).toBe('Return to a useful question')
  expect(host.querySelector('.browser-start-page__icon')?.getAttribute('src')).toBe('https://images.example.test/icon.png')
  expect(host.querySelector('.browser-start-page__background')?.getAttribute('src')).toBe('https://images.example.test/scene.jpg')
  expect(api.browser.listInputHistory).not.toHaveBeenCalled()
  await render(page({ title: '', subtitle: '', showHistory: false }))
  expect(host.querySelector('h1')).toBeNull(); expect(host.querySelector('.browser-start-page__brand p')).toBeNull()
  expect(host.querySelector('img')).toBeNull(); expect(host.querySelector('input')).not.toBeNull()
})

it('shows actual scoped input as album cards and preserves the exact selected text', async () => {
  await render(page())
  expect(api.browser.listInputHistory).toHaveBeenCalledWith(target)
  expect([...host.querySelectorAll('.browser-start-history__card strong')].map(node => node.textContent)).toEqual(entries.map(entry => entry.text))
  expect([...host.querySelectorAll('.browser-start-history__cover > span')].map(node => node.textContent)).toEqual(['docs.example.test', 'Search', 'localhost'])
  await click('[aria-label="Open recent input protocol design notes"]')
  expect(choose).toHaveBeenLastCalledWith('protocol design notes')
  await render(page({ showHistory: false }))
  expect(host.querySelector('.browser-start-history')).toBeNull(); expect(api.browser.listInputHistory).toHaveBeenCalledTimes(1)
})

it('keeps browsing and provides a retry after history or an image cannot be read', async () => {
  vi.mocked(api.browser.listInputHistory).mockRejectedValueOnce(new Error('history disk unavailable'))
  await render(page({ icon: 'https://images.example.test/icon.png' }))
  expect(host.querySelector('input')?.disabled).toBe(false)
  expect(host.textContent).toContain('history disk unavailable')
  await click('.browser-start-page__notice button')
  expect(host.querySelectorAll('.browser-start-history__card')).toHaveLength(3)
  await act(async () => host.querySelector('img')!.dispatchEvent(new Event('error')))
  expect(host.textContent).toContain('Icon could not be loaded')
  expect(host.querySelector('input')?.disabled).toBe(false)
  await click('.browser-start-page__image-notice button')
  expect(host.querySelector('img')?.hidden).toBe(false)
})

it('discards a late history result after the Browser/Profile changes or the gallery is hidden', async () => {
  let finish!: (value: BrowserInputHistorySnapshot) => void
  vi.mocked(api.browser.listInputHistory).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await render(page())
  const next = { kind: 'browser' as const, browserId: 'second-browser', profileId: 'second-profile' }
  vi.mocked(api.browser.listInputHistory).mockResolvedValue({ scope: { workspaceId: 'second-workspace', profileId: next.profileId }, entries: [{ text: 'second scope only', submittedAt: _hygiene_fixtureTime(24551826003) }] })
  await render(<BrowserStartPage config={DEFAULT_BROWSER_START_PAGE} historyTarget={next} onChooseHistory={choose}><input /></BrowserStartPage>)
  await act(async () => finish(snapshot))
  expect([...host.querySelectorAll('.browser-start-history__card strong')].map(node => node.textContent)).toEqual(['second scope only'])
  await render(<BrowserStartPage config={DEFAULT_BROWSER_START_PAGE} visible={false} historyTarget={next} onChooseHistory={choose}><input /></BrowserStartPage>)
  expect(api.browser.listInputHistory).toHaveBeenCalledTimes(2)
  expect(host.querySelector('.browser-start-history')).toBeNull()
})

it('opts a non-Survey Browser into the same start page and navigates the original page from a history card', async () => {
  const navigate = vi.spyOn(api.browser, 'navigate').mockImplementation(async (id, url) => ({ ...tab, id, url }))
  const record = vi.spyOn(api.browser, 'recordInputHistory').mockResolvedValue({ ...snapshot, outcome: 'recorded' })
  const tab = { id: target.browserId, browserId: target.browserId, regionId: 'original-region', kind: 'browser' as const, workspaceId: 'original-workspace', profileId: target.profileId,
    navigationId: 'navigation-1', url: 'about:blank', title: '', loading: false, canGoBack: false, canGoForward: false, viewport: 'responsive' as const, driving: false, appLinkPrompt: null, error: null }
  useAppStore.setState({ browserAnnotationsByBrowserId: {}, toolsOpen: false, tabs: {}, config: null })
  await render(<BrowserPane tab={tab} visible startPage={DEFAULT_BROWSER_START_PAGE} regionSplitSurface="space" />)
  expect(host.querySelector('.browser-start-page h1')?.textContent).toBe('AMUX - Survey')
  expect(host.querySelector('[aria-label="Browser address"]')).toBeNull()
  await click('[aria-label="Open recent input protocol design notes"]')
  expect(navigate).toHaveBeenCalledWith(target.browserId, 'protocol design notes')
  expect(record).toHaveBeenCalledWith(target, 'protocol design notes')
  await render(<BrowserPane tab={{ ...tab, url: 'https://search.example.test/results' }} visible startPage={DEFAULT_BROWSER_START_PAGE} regionSplitSurface="space" />)
  expect(host.querySelector('.browser-start-page')).toBeNull()
  expect(host.querySelector('[aria-label="Browser address"]')).not.toBeNull()
  await render(<BrowserPane tab={tab} visible regionSplitSurface="survey" />)
  expect(host.querySelector('.browser-start-page')).toBeNull()
  expect(host.querySelector('[aria-label="Browser address"]')).not.toBeNull()
})

it('does not read a directly hidden Browser and removes cleared history from the gallery', async () => {
  const tab = { id: target.browserId, browserId: target.browserId, regionId: 'original-region', kind: 'browser' as const, workspaceId: 'original-workspace', profileId: target.profileId,
    navigationId: 'navigation-1', url: 'about:blank', title: '', loading: false, canGoBack: false, canGoForward: false, viewport: 'responsive' as const, driving: false, appLinkPrompt: null, error: null }
  useAppStore.setState({ browserAnnotationsByBrowserId: {}, toolsOpen: false, tabs: {}, config: null })
  await render(<BrowserPane tab={tab} visible={false} startPage={DEFAULT_BROWSER_START_PAGE} />)
  expect(api.browser.listInputHistory).not.toHaveBeenCalled()
  await render(<BrowserPane tab={tab} visible startPage={DEFAULT_BROWSER_START_PAGE} />)
  expect(host.querySelectorAll('.browser-start-history__card')).toHaveLength(3)
  await act(async () => host.querySelector<HTMLInputElement>('[aria-label="Search or enter a web address"]')!.focus())
  const clear = document.querySelector<HTMLButtonElement>('.browser-address-history header button')!
  expect(clear.textContent).toBe('Clear')
  vi.spyOn(api.browser, 'clearInputHistory').mockImplementation(async (selectedTarget, scope) => {
    expect(selectedTarget).toEqual(target); expect(scope).toEqual(snapshot.scope)
    const empty = { ...snapshot, entries: [] }; vi.mocked(api.browser.listInputHistory).mockResolvedValue(empty); return empty
  })
  await act(async () => clear.click())
  expect(host.querySelector('.browser-start-history')).toBeNull()
  expect(document.querySelector('.browser-address-history')?.textContent).toContain('No saved input yet.')
  expect(host.querySelector('input')?.disabled).toBe(false)
})

it('saves configured fields and retains the draft when its original save fails', async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error('configuration disk unavailable')).mockResolvedValue(undefined)
  await render(<BrowserStartPageSettings onSave={save} onOpen={vi.fn()} />)
  const title = host.querySelector<HTMLInputElement>('[aria-label="Start page title"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, 'My research'); title.dispatchEvent(new Event('input', { bubbles: true })) })
  await click('[data-settings-save-bar] button')
  expect(host.textContent).toContain('configuration disk unavailable'); expect(title.value).toBe('My research')
  await click('[data-settings-save-bar] button')
  expect(save).toHaveBeenLastCalledWith({ ...DEFAULT_BROWSER_START_PAGE, title: 'My research' }, DEFAULT_BROWSER_START_PAGE)
})

it('invalidates cleared cards even when the popup is dismissed and the gallery reread fails', async () => {
  const tab = { id: target.browserId, browserId: target.browserId, regionId: 'original-region', kind: 'browser' as const, workspaceId: 'original-workspace', profileId: target.profileId,
    navigationId: 'navigation-1', url: 'about:blank', title: '', loading: false, canGoBack: false, canGoForward: false, viewport: 'responsive' as const, driving: false, appLinkPrompt: null, error: null }
  useAppStore.setState({ browserAnnotationsByBrowserId: {}, toolsOpen: false, tabs: {}, config: null })
  await render(<BrowserPane tab={tab} visible startPage={DEFAULT_BROWSER_START_PAGE} />)
  const input = host.querySelector<HTMLInputElement>('[aria-label="Search or enter a web address"]')!
  await act(async () => input.focus())
  let finish!: (value: BrowserInputHistorySnapshot) => void
  vi.spyOn(api.browser, 'clearInputHistory').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const clear = document.querySelector<HTMLButtonElement>('.browser-address-history header button')!
  await act(async () => clear.click())
  await act(async () => input.blur())
  expect(document.querySelector('.browser-address-history')).toBeNull()
  vi.mocked(api.browser.listInputHistory).mockRejectedValueOnce(new Error('post-delete read unavailable'))
  await act(async () => finish({ ...snapshot, entries: [] }))
  expect(host.querySelectorAll('.browser-start-history__card')).toHaveLength(0)
  expect(host.textContent).toContain('post-delete read unavailable'); expect(input.disabled).toBe(false)
  vi.mocked(api.browser.listInputHistory).mockResolvedValue({ ...snapshot, entries: [] })
  await click('.browser-start-page__notice button')
  expect(host.querySelector('.browser-start-history')).toBeNull()
})
