import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '../src/shared/contracts.js'
import {
  BROWSER_TOOLBAR_ITEM_ORDER,
  withBrowserToolbarItem
} from '../src/renderer/src/lib/browser-toolbar.js'

const fixture = vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
  return {
    state: {
      applyBrowserEvent: vi.fn(),
      reportError: vi.fn(),
      setConfig: vi.fn(),
      toolsOpen: false,
      config: null as AppConfig | null
    }
  }
})

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
    { getState: () => fixture.state }
  )
}))

import { BrowserPane } from '../src/renderer/src/components/BrowserPane.js'
import { BrowserToolbarPreferences } from '../src/renderer/src/components/SurfaceToolDock.js'

const config: AppConfig = {
  version: 7,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [],
  appearance: { terminalTheme: 'graphite' },
  browser: {
    toolbar: {
      selectElement: true,
      screenshot: true,
      devTools: true,
      viewport: true,
      more: true
    }
  }
}

const tab = {
  id: 'browser-1',
  browserId: 'browser-1',
  regionId: 'region-1',
  workspaceId: 'workspace-1',
  kind: 'browser' as const,
  url: 'https://example.com/',
  title: 'Example',
  loading: false,
  canGoBack: true,
  canGoForward: true,
  viewport: 'responsive' as const,
  error: null
}

beforeEach(() => {
  fixture.state.config = structuredClone(config)
})

describe('Browser bar contract', () => {
  it('keeps external open fixed first and projects the stable tool order', () => {
    const markup = renderToStaticMarkup(<BrowserPane tab={tab} visible />)
    const labels = [
      'Open in external browser',
      'Back',
      'Forward',
      'Reload',
      'Browser address',
      'Select element — unavailable',
      'Screenshot — unavailable',
      'Open DevTools',
      'Viewport',
      'More browser tools'
    ]

    let previous = -1
    for (const label of labels) {
      const current = markup.indexOf(`aria-label="${label}"`)
      expect(current, label).toBeGreaterThan(previous)
      previous = current
    }
    expect(BROWSER_TOOLBAR_ITEM_ORDER).toEqual([
      'selectElement',
      'screenshot',
      'devTools',
      'viewport',
      'more'
    ])
  })

  it('hides configured tools without allowing external open to be configured away', () => {
    fixture.state.config = BROWSER_TOOLBAR_ITEM_ORDER.reduce(
      (current, item) => withBrowserToolbarItem(current, item, false),
      config
    )
    const markup = renderToStaticMarkup(<BrowserPane tab={tab} visible />)

    expect(markup).toContain('aria-label="Open in external browser"')
    expect(markup).not.toContain('Select element — unavailable')
    expect(markup).not.toContain('Screenshot — unavailable')
    expect(markup).not.toContain('aria-label="Open DevTools"')
    expect(markup).not.toContain('aria-label="Viewport"')
    expect(markup).not.toContain('aria-label="More browser tools"')
    expect('openExternal' in fixture.state.config.browser.toolbar).toBe(false)
  })

  it('keeps Browser Tools as the recovery surface when More is hidden', () => {
    const toolbar = { ...config.browser.toolbar, more: false }
    const markup = renderToStaticMarkup(
      <BrowserToolbarPreferences toolbar={toolbar} saving={false} onSave={async () => {}} />
    )

    expect(markup).toContain('External open is always visible.')
    expect(markup).toContain('<span>More</span>')
    expect(markup).toContain('Save Browser bar')
  })
})
