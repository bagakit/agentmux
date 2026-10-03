// @vitest-environment happy-dom
import { act } from 'react'
import { createClientUiRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BrowserPane } from '../src/renderer/src/components/BrowserPane'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import type { BrowserSnapshot } from '../src/shared/contracts'

const initial = useAppStore.getState()
let container: HTMLDivElement, root: ReturnType<typeof createClientUiRoot>
let page: BrowserSnapshot
function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const close = vi.fn()
function render(released: boolean, snapshot = page) { return act(async () => root.render(<BrowserPane tab={{ ...snapshot, kind: 'browser', browserId: snapshot.id, regionId: 'original-region', workspaceId: 'original-workspace' }} visible released={released} onRegionClose={close} />)) }
function address() { const field = container.querySelector<HTMLInputElement>('input[aria-label="Browser address"]'); expect(field).not.toBeNull(); return field! }
async function fill(value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(address(), value); address().dispatchEvent(new Event('input', { bubbles: true })) }) }
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  page = await api.browser.create('recovery-page', 'https://example.invalid/original', 'original-workspace')
  const config = await api.config.get()
  useAppStore.setState({ ...initial, config, toolsOpen: false }, true)
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container); close.mockClear()
  vi.spyOn(api.browser, 'setAnnotationMarkers').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'cancelElementSelection').mockResolvedValue(undefined)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.getElementById('agentmux-window-overlay-host')?.remove() })

it('keeps the original address and real leave controls while restore remains unconfirmed', async () => {
  const waiting = deferred<BrowserSnapshot>(), restore = vi.spyOn(api.browser, 'restore').mockReturnValue(waiting.promise)
  const external = vi.spyOn(api.ui, 'openExternal').mockResolvedValue(undefined), navigate = vi.spyOn(api.browser, 'navigate'), reload = vi.spyOn(api.browser, 'reload')
  await render(true); await render(false)
  expect(container.textContent).toContain('Restoring browser'); expect(container.textContent).toContain('Waiting for the original page connection')
  expect(address().value).toBe(page.url); expect(address().disabled).toBe(false)
  await fill('keep this human draft'); expect(address().value).toBe('keep this human draft')
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open in external browser"]')!.click())
  expect(external).toHaveBeenCalledExactlyOnceWith(page.url)
  await act(async () => address().form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(navigate).not.toHaveBeenCalled(); expect(reload).not.toHaveBeenCalled(); expect(container.textContent).toContain('Your input is kept')
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close split"]')!.click()); expect(close).toHaveBeenCalledOnce()
  expect(restore).toHaveBeenCalledExactlyOnceWith(page.id, { workspaceId: 'original-workspace', profileId: page.profileId, viewport: page.viewport })
  await act(async () => waiting.resolve(page)); expect(address().value).toBe('keep this human draft')
})
it('retains the exact failure and explicitly retries the same owner without reloading or losing a draft', async () => {
  const waiting = deferred<BrowserSnapshot>(), retried = deferred<BrowserSnapshot>()
  const restore = vi.spyOn(api.browser, 'restore').mockReturnValueOnce(waiting.promise).mockReturnValueOnce(retried.promise)
  const apply = vi.spyOn(useAppStore.getState(), 'applyBrowserEvent'), report = vi.spyOn(useAppStore.getState(), 'reportError'), reload = vi.spyOn(api.browser, 'reload')
  await render(true); await render(false); await fill('my next search')
  await act(async () => waiting.reject(new Error('Profile metadata could not be read')))
  expect(container.textContent).toContain('Browser connection needs attention'); expect(container.textContent).toContain('Profile metadata could not be read')
  expect(address().value).toBe('my next search'); expect(report).not.toHaveBeenCalled()
  const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === 'Retry connection')!
  expect(retry).toBeDefined(); await act(async () => retry.click())
  expect(restore).toHaveBeenCalledTimes(2); expect(restore.mock.calls[1]).toEqual(restore.mock.calls[0]); expect(reload).not.toHaveBeenCalled()
  await act(async () => retried.resolve({ ...page, navigationId: 'confirmed-original' }))
  expect(container.textContent).not.toContain('Browser connection needs attention'); expect(container.textContent).not.toContain('Restoring browser')
  expect(apply).toHaveBeenCalledWith({ type: 'updated', browser: { ...page, navigationId: 'confirmed-original' } }); expect(address().value).toBe('my next search')
})
it('ignores a late rejected restore after the original projection unmounts', async () => {
  const waiting = deferred<BrowserSnapshot>(), report = vi.spyOn(useAppStore.getState(), 'reportError')
  vi.spyOn(api.browser, 'restore').mockReturnValue(waiting.promise)
  await render(true); await render(false); await act(async () => root.render(null)); await act(async () => waiting.reject(new Error('Old owner attempt')))
  expect(container.childElementCount).toBe(0); expect(report).not.toHaveBeenCalled()
})
it('does not restore a present owner on unrelated normal commits', async () => {
  const restore = vi.spyOn(api.browser, 'restore')
  await render(false); await render(false, { ...page, title: 'Still the original page' }); expect(restore).not.toHaveBeenCalled(); expect(address().value).toBe(page.url)
})

it('keeps the pending request through a URL update and a new presentation callback', async () => {
  const waiting = deferred<BrowserSnapshot>(), restore = vi.spyOn(api.browser, 'restore').mockReturnValue(waiting.promise)
  const release = vi.spyOn(api.browser, 'release').mockResolvedValue(undefined)
  await render(true); await render(false)
  const confirm = vi.fn()
  await act(async () => root.render(<BrowserPane tab={{ ...page, url: page.url + '/updated', kind: 'browser', browserId: page.id, regionId: 'original-region', workspaceId: 'original-workspace' }} visible released={false} onControlConfirmation={confirm} />))
  await act(async () => waiting.resolve({ ...page, url: page.url + '/updated' }))
  expect(restore).toHaveBeenCalledTimes(1); expect(release).not.toHaveBeenCalled(); expect(container.textContent).not.toContain('Restoring browser')
  expect(confirm).toHaveBeenCalledWith('original-region', false)
})
it('does not release a late healthy Main owner merely because its Renderer unmounted', async () => {
  const waiting = deferred<BrowserSnapshot>(), release = vi.spyOn(api.browser, 'release').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'restore').mockReturnValue(waiting.promise)
  await render(true); await render(false); await act(async () => root.render(null)); await act(async () => waiting.resolve(page))
  expect(release).not.toHaveBeenCalled(); expect(container.childElementCount).toBe(0)
})
it('releases a late owner only when the latest real policy explicitly parked that same Browser', async () => {
  const waiting = deferred<BrowserSnapshot>(), release = vi.spyOn(api.browser, 'release').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'restore').mockReturnValue(waiting.promise)
  await render(true); await render(false); await render(true); await act(async () => waiting.resolve(page))
  expect(release.mock.calls).toEqual([[page.id], [page.id]]); expect(container.textContent).toContain('Browser parked')
})
it('refuses a foreign restore result without applying or releasing that page', async () => {
  vi.spyOn(api.browser, 'restore').mockResolvedValue({ ...page, id: 'foreign-browser' })
  const release = vi.spyOn(api.browser, 'release').mockResolvedValue(undefined), apply = vi.spyOn(useAppStore.getState(), 'applyBrowserEvent')
  await render(true); await render(false)
  expect(container.textContent).toContain('different page identity'); expect(apply).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled()
})

it('keeps a pending Main connection through a child render fault and local view retry', async () => {
  const waiting = deferred<BrowserSnapshot>(), retried = deferred<BrowserSnapshot>()
  const restore = vi.spyOn(api.browser, 'restore').mockReturnValueOnce(waiting.promise).mockReturnValueOnce(retried.promise)
  const release = vi.spyOn(api.browser, 'release').mockResolvedValue(undefined), reload = vi.spyOn(api.browser, 'reload')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await render(true); await render(false); await fill('draft survives both failures')
  let fault = true
  const tab = { ...page, kind: 'browser' as const, browserId: page.id, regionId: 'original-region', workspaceId: 'original-workspace' }
  Object.defineProperty(tab, 'appLinkPrompt', { get() { if (fault) throw new Error('Actual Browser child render failed'); return null } })
  await act(async () => root.render(<BrowserPane tab={tab} visible released={false} />))
  expect(container.textContent).toContain('Browser view could not display')
  fault = false
  const localRetry = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry Browser view')!
  await act(async () => localRetry.click())
  expect(container.textContent).toContain('Restoring browser'); expect(address().value).toBe('draft survives both failures')
  expect(restore).toHaveBeenCalledTimes(1); expect(release).not.toHaveBeenCalled(); expect(reload).not.toHaveBeenCalled()
  await act(async () => waiting.reject(new Error('Original Profile remains unavailable')))
  expect(container.textContent).toContain('Original Profile remains unavailable')
  const connectionRetry = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry connection')!
  expect(connectionRetry).toBeDefined(); await act(async () => connectionRetry.click())
  expect(restore).toHaveBeenCalledTimes(2); expect(restore.mock.calls[1]).toEqual(restore.mock.calls[0])
  await act(async () => retried.resolve(page))
  expect(container.textContent).not.toContain('Restoring browser'); expect(address().value).toBe('draft survives both failures')
})
