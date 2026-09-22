// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AppConfig } from '../src/shared/contracts.js'

const fixture = vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  return { state: {
    applyBrowserEvent: vi.fn(), reportError: vi.fn(), setWorkspaceTool: vi.fn(),
    executeControl: vi.fn(async (_request: { operation: string; browserId?: string }) => ({ operation: 'browser.history', operations: [] })),
    saveBrowserBookmark: vi.fn(async () => 'Page.webloc'), openFile: vi.fn(async () => {}),
    browserAnnotationsByBrowserId: {}, addBrowserAnnotation: vi.fn(), toolsOpen: false,
    config: null as AppConfig | null
  } }
})
vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: Object.assign((selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
    { getState: () => fixture.state })
}))
import { BrowserPane } from '../src/renderer/src/components/BrowserPane.js'
import { api } from '../src/renderer/src/lib/api.js'

const config: AppConfig = {
  version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }], executors: {}, workspaces: [],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: {
    selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true
  } }
}
const tab = {
  id: 'browser-1', navigationId: 'navigation-1', browserId: 'browser-1', regionId: 'region-1',
  workspaceId: 'workspace-1', profileId: 'profile-1', kind: 'browser' as const,
  url: 'https://example.com/', title: 'Example', loading: false, canGoBack: true, canGoForward: true,
  viewport: 'responsive' as const, driving: false, appLinkPrompt: null, error: null
}

beforeEach(() => {
  fixture.state.config = structuredClone(config)
  vi.clearAllMocks()
})

async function openMore(container: HTMLElement): Promise<HTMLElement> {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="More browser tools"]')!
  expect(trigger).not.toBeNull()
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!
  expect(menu).not.toBeNull()
  return menu
}

it('overflow reaches navigation, bookmark, DevTools, viewport and demonstration through their product handlers', async () => {
  fixture.state.config!.browser.toolbar.more = false
  const back = vi.spyOn(api.browser, 'back').mockResolvedValue(tab)
  const devtools = vi.spyOn(api.browser, 'openDevTools').mockResolvedValue(undefined)
  const viewport = vi.spyOn(api.browser, 'setViewport').mockResolvedValue(tab)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<BrowserPane tab={tab} visible />))
    for (const [label, verify] of [
      ['Back', () => expect(back).toHaveBeenCalledWith(tab.browserId)],
      ['Open DevTools', () => expect(devtools).toHaveBeenCalledWith(tab.browserId)],
      ['Save this page as a bookmark', () => expect(fixture.state.saveBrowserBookmark).toHaveBeenCalledWith(tab.workspaceId, tab.url, tab.title)]
    ] as const) {
      const menu = await openMore(container)
      const item = menu.querySelector(`[role="menuitem"][aria-label="${label}"]`)
      expect(item).not.toBeNull()
      await act(async () => item!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      verify()
    }
    let menu = await openMore(container)
    const mobile = [...menu.querySelectorAll('[role="menuitemradio"]')].find(item => item.textContent?.includes('Mobile'))
    expect(mobile).not.toBeUndefined()
    await act(async () => mobile!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(viewport).toHaveBeenCalledWith(tab.browserId, 'mobile')
    menu = await openMore(container)
    const demonstration = menu.querySelector('[aria-label="Open human demonstration draft"]')
    expect(demonstration).not.toBeNull()
    await act(async () => demonstration!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(fixture.state.executeControl.mock.calls).toHaveLength(1)
    expect(fixture.state.executeControl.mock.calls[0]![0]).toMatchObject({ operation: 'browser.history', browserId: tab.browserId })
    expect(container.querySelector('[aria-label="Human demonstration draft"]')).not.toBeNull()
  } finally { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() }
})

it('overflow preserves disabled page/navigation actions and configured tool exclusions', async () => {
  fixture.state.config!.browser.toolbar.screenshot = false
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<BrowserPane tab={{ ...tab, url: 'about:blank', canGoBack: false, canGoForward: false }} visible />))
    const menu = await openMore(container)
    const disabled = [...menu.querySelectorAll('[data-disabled]')].map(item => item.getAttribute('aria-label'))
    expect(disabled).toEqual(['Back', 'Forward', 'Select element', 'Open DevTools', 'Save this page as a bookmark'])
    expect(menu.querySelector('[aria-label="Screenshot"]')).toBeNull()
  } finally { await act(async () => root.unmount()); container.remove() }
})

// This Source-only oracle reads actual product declarations and markup. It does not claim
// Chromium geometry; the complete layout fixture remains independently runnable by Root.
it('links actual toolbar classes to nonempty narrow-pane rules and the sole style entry', async () => {
  fixture.state.config!.browser.toolbar.more = false
  const container = document.createElement('div')
  container.innerHTML = renderToStaticMarkup(<BrowserPane tab={tab} visible />)
  expect(container.querySelector('[aria-label="More browser tools"]')?.className).toBe('browser-toolbar__more--optional')
  const secondary = [...container.querySelectorAll('.browser-toolbar > .browser-toolbar__secondary')]
  expect(secondary.map(element => element.getAttribute('aria-label'))).toEqual(['Select element', 'Screenshot', 'Open DevTools', 'Viewport', 'Save this page as a bookmark'])
  expect([...container.querySelectorAll('.browser-toolbar__navigation')].map(element => element.getAttribute('aria-label'))).toEqual(['Back', 'Forward'])
  expect(container.querySelector('.browser-toolbar__reload')?.getAttribute('aria-label')).toBe('Reload')
  const index = await readFile('apps/desktop/src/renderer/src/styles/index.css', 'utf8')
  const imports = [...index.matchAll(/@import '\.\/([^']+)';/g)]
  expect(imports.length).toBeGreaterThan(0)
  expect(imports.filter(match => match[1] === 'browser.css')).toHaveLength(1)
  const source = await readFile('apps/desktop/src/renderer/src/styles/browser.css', 'utf8')
  const scope = source.indexOf('@container browser-pane (max-width: 620px)')
  const end = source.indexOf('.browser-menu {', scope)
  expect(scope).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(scope)
  const narrow = source.slice(scope, end)
  expect(narrow).toContain('.browser-toolbar > .browser-toolbar__secondary { display: none; }')
  expect(narrow).toContain('.browser-toolbar > .browser-toolbar__more--optional { display: inline-flex; }')
  expect(narrow).toContain('.browser-toolbar > .browser-toolbar__navigation { display: none; }')
  expect(narrow).toContain('.browser-toolbar > .browser-toolbar__reload { display: none; }')
  expect(source).toContain('{ padding-right: var(--region-close-clearance); }')
  expect(source).toContain('flex: 0 0 min(clamp(248px, 26%, 340px), 50%);')
  expect(source).toContain('.browser-trace-rail .browser-rsi-history__actions { flex: none; }')
  expect(source).toContain('.browser-trace-rail :is(.browser-rsi-timeline__header, .browser-rsi-replay__header, .browser-rsi-history__header) { padding-right: var(--sp-6); }')
})
