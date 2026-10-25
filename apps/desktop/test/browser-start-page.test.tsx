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
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import type { BrowserRecoveryPreview } from '../src/shared/browser-recovery-preview'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'

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
  expect([...host.querySelectorAll('.browser-start-history__domain')].map(node => node.textContent)).toEqual(['docs.example.test', 'Search', 'localhost'])
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
  expect(host.querySelector('[aria-label="Browser address"]')).not.toBeNull()
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
  await act(async () => { const input = host.querySelector<HTMLInputElement>('[aria-label="Search or enter a web address"]')!; input.focus(); input.click() })
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
  await act(async () => { input.focus(); input.click() })
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

it('shows a useful first twelve and expands the real history without another read', async () => {
  const more = Array.from({ length: 18 }, (_, index) => ({ text: `https://source-${index}.example.test/notes`, submittedAt: entries[0]!.submittedAt }))
  vi.mocked(api.browser.listInputHistory).mockResolvedValue({ ...snapshot, entries: more })
  await render(page())
  expect(host.querySelectorAll('.browser-start-history__card')).toHaveLength(12)
  await click('.browser-start-history__more')
  expect(host.querySelectorAll('.browser-start-history__card')).toHaveLength(18)
  await click('[aria-label="Open recent input https://source-17.example.test/notes"]')
  expect(choose).toHaveBeenLastCalledWith(more[17]!.text)
  await click('.browser-start-history__more')
  expect(host.querySelectorAll('.browser-start-history__card')).toHaveLength(12)
  expect(api.browser.listInputHistory).toHaveBeenCalledTimes(1)
})

it('uses the saved first-view count without hiding the rest of the original history', async () => {
  const history = Array.from({ length: 24 }, (_, index) => ({ text: `query ${index}`, submittedAt: entries[0]!.submittedAt }))
  vi.mocked(api.browser.listInputHistory).mockResolvedValue({ ...snapshot, entries: history })
  await render(page({ historyLimit: 6 }))
  expect(host.querySelectorAll('.browser-start-history__card')).toHaveLength(6)
  await click('.browser-start-history__more')
  expect(host.querySelectorAll('.browser-start-history__card')).toHaveLength(24)
  await click('.browser-start-history__more')
  await render(page({ historyLimit: 18 }))
  expect(host.querySelectorAll('.browser-start-history__card')).toHaveLength(18)
  expect(api.browser.listInputHistory).toHaveBeenCalledTimes(1)
  await render(page({ historyLimit: 50 }))
  expect(host.querySelectorAll('.browser-start-history__card')).toHaveLength(24)
  expect(host.querySelector('.browser-start-history__more')).toBeNull()
})

it('opens the original Survey settings and honors the decorative effect switch', async () => {
  const open = vi.fn()
  const navigation = { open, openToolkit: vi.fn(), openHost: vi.fn(), openChannel: vi.fn(), channelEntries: [], channelPresentation: () => null, openMoteLark: vi.fn(), chooseAgent: vi.fn() }
  const navigate = vi.spyOn(api.browser, 'navigate')
  await render(<SettingsNavigation.Provider value={navigation}>{page()}</SettingsNavigation.Provider>)
  expect(host.querySelector('[data-start-atmosphere]')).not.toBeNull()
  await click('.browser-start-page__customize')
  expect(open).toHaveBeenCalledExactlyOnceWith('survey', undefined, 'start-title')
  expect(navigate).not.toHaveBeenCalled()
  await render(<SettingsNavigation.Provider value={navigation}>{page({ interactiveBackground: false })}</SettingsNavigation.Provider>)
  expect(host.querySelector('[data-start-atmosphere]')).toBeNull()
  expect(host.querySelectorAll('.browser-start-history__card')).toHaveLength(3)
  expect(host.querySelector('input')?.disabled).toBe(false)
})

it('keeps toolbar and central drafts synchronized and submits through the original Browser', async () => {
  const tab = { id: target.browserId, browserId: target.browserId, regionId: 'original-region', kind: 'browser' as const, workspaceId: snapshot.scope.workspaceId, profileId: target.profileId,
    navigationId: 'navigation-1', url: 'about:blank', title: '', loading: false, canGoBack: false, canGoForward: false, viewport: 'responsive' as const, driving: false, appLinkPrompt: null, error: null }
  const navigate = vi.spyOn(api.browser, 'navigate').mockImplementation(async (id, url) => ({ ...tab, id, url }))
  const record = vi.spyOn(api.browser, 'recordInputHistory').mockResolvedValue({ ...snapshot, outcome: 'recorded' })
  useAppStore.setState({ browserAnnotationsByBrowserId: {}, toolsOpen: false, tabs: {}, config: null })
  await render(<BrowserPane tab={tab} visible startPage={DEFAULT_BROWSER_START_PAGE} />)
  const top = host.querySelector<HTMLInputElement>('[aria-label="Browser address"]')!
  const center = host.querySelector<HTMLInputElement>('[aria-label="Search or enter a web address"]')!
  expect(top).not.toBeNull(); expect(center).not.toBeNull()
  const input = async (node: HTMLInputElement, text: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, text)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await input(top, 'https://reference.example.test/guide')
  expect(center.value).toBe(top.value)
  await input(center, 'shared draft search')
  expect(top.value).toBe('shared draft search')
  await click('[aria-label="Search or open page"]')
  expect(navigate).toHaveBeenLastCalledWith(target.browserId, 'shared draft search')
  expect(record).toHaveBeenLastCalledWith(target, 'shared draft search')
  await input(top, 'http://localhost:5173/guide')
  await act(async () => top.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(navigate).toHaveBeenLastCalledWith(target.browserId, 'http://localhost:5173/guide')
  expect(navigate).toHaveBeenCalledTimes(2)
})

function installPreviewCandidate() {
  const browserId = 'source-browser'
  const region = { id: browserId, browserId, regionId: 'source-region', kind: 'browser' as const, workspaceId: snapshot.scope.workspaceId, profileId: target.profileId, mode: 'normal' as const,
    navigationId: 'source-navigation', url: entries[0]!.text, title: 'Reference guide', loading: false, canGoBack: false, canGoForward: false, viewport: 'responsive' as const, driving: false, appLinkPrompt: null, error: null }
  useAppStore.setState({ tabs: { source: createWorkbenchTab('source', region) } })
  const preview: BrowserRecoveryPreview = { scope: { browserId, workspaceId: snapshot.scope.workspaceId, profileId: target.profileId, mode: 'normal' },
    url: region.url, title: region.title, navigationId: region.navigationId, capturedAt: entries[0]!.submittedAt, image: { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', width: 480, height: 300 } }
  return { preview, region }
}

it('uses only the exact existing preview, with a readable fallback after a broken image', async () => {
  const { preview } = installPreviewCandidate()
  const read = vi.spyOn(api.browser, 'getRecoveryPreview').mockResolvedValue({ status: 'available', preview })
  const navigate = vi.spyOn(api.browser, 'navigate')
  await render(page())
  expect(read).toHaveBeenCalledExactlyOnceWith(preview.scope.browserId)
  const img = host.querySelector<HTMLImageElement>('.browser-start-history__cover img')!
  expect(img?.getAttribute('src')).toBe(preview.image.dataUrl)
  expect(host.querySelector('.browser-start-history__card strong')?.textContent).toBe('Reference guide')
  await act(async () => img.dispatchEvent(new Event('error')))
  expect(host.querySelector('.browser-start-history__cover img')).toBeNull()
  expect(host.textContent).toContain('Preview unavailable')
  expect(navigate).not.toHaveBeenCalled()
  await click(`[aria-label="Open recent input ${entries[0]!.text}"]`)
  expect(choose).toHaveBeenLastCalledWith(entries[0]!.text)
})

it.each(['profile', 'workspace', 'url', 'browser', 'private'] as const)('never shows a preview from a different %s', async mismatch => {
  const { preview } = installPreviewCandidate()
  if (mismatch === 'profile') preview.scope = { ...preview.scope, mode: 'normal', profileId: 'other-profile' }
  if (mismatch === 'workspace') preview.scope.workspaceId = 'other-workspace'
  if (mismatch === 'url') preview.url = 'https://docs.example.test/different-page'
  if (mismatch === 'browser') preview.scope.browserId = 'other-browser'
  if (mismatch === 'private') preview.scope = { ...preview.scope, mode: 'private', profileId: null }
  vi.spyOn(api.browser, 'getRecoveryPreview').mockResolvedValue({ status: 'available', preview })
  await render(page())
  expect(host.querySelectorAll('.browser-start-history__card')).toHaveLength(3)
  expect(host.querySelector('.browser-start-history__cover img')).toBeNull()
  await click(`[aria-label="Open recent input ${entries[0]!.text}"]`)
  expect(choose).toHaveBeenLastCalledWith(entries[0]!.text)
})

it('drops late previews after history is cleared and does not read hidden or private history previews', async () => {
  const { preview } = installPreviewCandidate()
  let finish!: (value: { status: 'available'; preview: BrowserRecoveryPreview }) => void
  const read = vi.spyOn(api.browser, 'getRecoveryPreview').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await render(page())
  expect(read).toHaveBeenCalledTimes(1)
  vi.mocked(api.browser.listInputHistory).mockResolvedValue({ ...snapshot, entries: [] })
  await render(<BrowserStartPage config={DEFAULT_BROWSER_START_PAGE} historyTarget={target} historyRevision={1} onChooseHistory={choose}><input /></BrowserStartPage>)
  await act(async () => finish({ status: 'available', preview }))
  expect(host.querySelectorAll('.browser-start-history__card')).toHaveLength(0)
  await render(<BrowserStartPage config={DEFAULT_BROWSER_START_PAGE} visible={false} historyTarget={target} onChooseHistory={choose}><input /></BrowserStartPage>)
  expect(read).toHaveBeenCalledTimes(1)
  vi.mocked(api.browser.listInputHistory).mockResolvedValue({ scope: { ...snapshot.scope, profileId: null }, entries })
  await render(page())
  expect(host.querySelectorAll('.browser-start-history__card')).toHaveLength(3)
  expect(read).toHaveBeenCalledTimes(1)
})
