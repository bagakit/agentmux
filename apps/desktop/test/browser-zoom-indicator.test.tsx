// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig, BrowserSnapshot } from '../src/shared/contracts'
import { BrowserPane } from '../src/renderer/src/components/BrowserPane'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'

vi.hoisted(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
const config: AppConfig = {
  version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }], executors: {}, workspaces: [],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
const page = {
  id: 'zoom-page', navigationId: 'zoom-document', browserId: 'zoom-page', regionId: 'zoom-region', workspaceId: 'workspace',
  kind: 'browser' as const, mode: 'normal' as const, profileId: 'profile', url: 'https://example.test/article', title: 'Article',
  loading: false, canGoBack: true, canGoForward: false, viewport: 'responsive' as const, driving: false, appLinkPrompt: null, error: null
}
async function mount(zoomFactor?: number, agent = false) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(<BrowserPane tab={{ ...page, ...(zoomFactor === undefined ? {} : { zoomFactor }),
    ...(agent ? { control: { owner: 'agent', revision: 1, activeOperationId: null, inputIsolation: 'isolated' } } : {}) }} visible />))
  return { container, cleanup: async () => { await act(async () => root.unmount()); container.remove() } }
}

describe('Browser page zoom indicator', () => {
  beforeEach(() => useAppStore.setState({ config: structuredClone(config) }))
  afterEach(() => vi.restoreAllMocks())

  it.each([undefined, 0.9, 0.90000001])('leaves the address field alone at default or unknown zoom %s', async zoom => {
    const view = await mount(zoom)
    try {
      expect(view.container.querySelector('[aria-label="Browser address"]')).not.toBeNull()
      expect(view.container.querySelector('.browser-zoom')).toBeNull()
    } finally { await view.cleanup() }
  })

  it('shows the applied percentage and resets exactly this Browser even while an Agent controls it', async () => {
    const zoom = vi.spyOn(api.browser, 'zoom').mockResolvedValue({ ...page, zoomFactor: 0.9 } as BrowserSnapshot)
    const navigate = vi.spyOn(api.browser, 'navigate')
    const view = await mount(1.1, true)
    try {
      const button = view.container.querySelector<HTMLButtonElement>('.browser-zoom')!
      expect(button.textContent?.trim()).toBe('110%')
      expect(button.getAttribute('aria-label')).toBe('Page zoom 110%. Reset this site in this Profile to 90%')
      expect(button.disabled).toBe(false)
      expect(button.type).toBe('button')
      await act(async () => button.click())
      expect(zoom).toHaveBeenCalledExactlyOnceWith('zoom-page', 'reset')
      expect(navigate).not.toHaveBeenCalled()
    } finally { await view.cleanup() }
  })

  it('keeps the page and exposes the original failure when reset cannot finish', async () => {
    const error = new Error('Drawing synchronization failed')
    vi.spyOn(api.browser, 'zoom').mockRejectedValue(error)
    const report = vi.spyOn(useAppStore.getState(), 'reportError').mockImplementation(() => {})
    const view = await mount(1.25)
    try {
      await act(async () => view.container.querySelector<HTMLButtonElement>('.browser-zoom')!.click())
      expect(report).toHaveBeenCalledExactlyOnceWith(error)
      expect(view.container.querySelector('.browser-zoom')?.textContent?.trim()).toBe('125%')
      expect(view.container.querySelector<HTMLInputElement>('[aria-label="Browser address"]')?.value).toBe(page.url)
    } finally { await view.cleanup() }
  })
})
