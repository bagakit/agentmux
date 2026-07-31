import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts.js'
import type { BrowserAnnotation } from '../src/renderer/src/lib/browser-annotations.js'
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
      browserAnnotationsByBrowserId: {},
      addBrowserAnnotation: vi.fn(),
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

import {
  browserCaptureMatchesIdentity,
  BrowserPane
} from '../src/renderer/src/components/BrowserPane.js'
import { BrowserToolbarPreferences } from '../src/renderer/src/components/SurfaceToolDock.js'
import { BrowserAnnotationsPanel } from '../src/renderer/src/components/SurfaceToolDock.js'

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
  navigationId: 'navigation-1',
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

const annotation: BrowserAnnotation = {
  id: 'annotation-1',
  workspaceId: 'workspace-1',
  browserId: 'browser-1',
  navigationId: 'navigation-1',
  note: 'Check this control',
  selection: {
    browserId: 'browser-1',
    navigationId: 'navigation-1',
    pageTitle: 'Example',
    pageUrl: 'https://example.com/',
    tagName: 'button',
    role: 'button',
    accessibleName: 'Open settings',
    selector: 'button.settings',
    text: 'Settings',
    nearbyText: [],
    attributes: {},
    html: '<button>Settings</button>',
    rectViewport: { x: 1, y: 2, width: 3, height: 4 },
    rectPage: { x: 1, y: 2, width: 3, height: 4 },
    isFixed: false
  }
}

function agentSession(
  id: string,
  status: Extract<SessionSnapshot, { kind: 'agent' }>['status']
): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    id,
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true,
      hookEvents: true,
      timeline: 'complete-events',
      permission: 'observe',
      providerResume: true,
      acp: false,
      replyCorrelation: 'none'
    },
    hostId: 'local',
    workspacePath: '/repo',
    label: id,
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status,
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  }
}

beforeEach(() => {
  fixture.state.config = structuredClone(config)
})

describe('Browser bar contract', () => {
  it('rejects a capture returned for a Browser identity that is no longer current', () => {
    expect(browserCaptureMatchesIdentity(
      { browserId: 'browser-a', navigationId: 'navigation-a' },
      { id: 'browser-b', navigationId: 'navigation-b' }
    )).toBe(false)
    expect(browserCaptureMatchesIdentity(
      { browserId: 'browser-b', navigationId: 'navigation-a' },
      { id: 'browser-b', navigationId: 'navigation-b' }
    )).toBe(false)
    expect(browserCaptureMatchesIdentity(
      { browserId: 'browser-b', navigationId: 'navigation-b' },
      { id: 'browser-b', navigationId: 'navigation-b' }
    )).toBe(true)
  })

  it('keeps external open fixed first and projects the stable tool order', () => {
    const markup = renderToStaticMarkup(<BrowserPane tab={tab} visible />)
    const labels = [
      'Open in external browser',
      'Back',
      'Forward',
      'Reload',
      'Browser address',
      'Select element',
      'Screenshot',
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
    expect(markup).not.toContain('aria-label="Select element"')
    expect(markup).not.toContain('aria-label="Screenshot"')
    expect(markup).not.toContain('aria-label="Open DevTools"')
    expect(markup).not.toContain('aria-label="Viewport"')
    expect(markup).not.toContain('aria-label="More browser tools"')
    expect('openExternal' in fixture.state.config.browser.toolbar).toBe(false)
  })

  it('renders an explicit release state without pretending a hidden Browser still owns WebContents', () => {
    const markup = renderToStaticMarkup(<BrowserPane tab={tab} visible={false} released />)
    expect(markup).toContain('Browser parked')
    expect(markup).toContain('restore the browser')
    expect(markup).not.toContain('Browser address')
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

  it('projects current and stale annotations and only eligible Agent targets', () => {
    const markup = renderToStaticMarkup(
      <BrowserAnnotationsPanel
        annotations={[
          annotation,
          {
            ...annotation,
            id: 'annotation-2',
            navigationId: 'navigation-old',
            selection: { ...annotation.selection, navigationId: 'navigation-old' }
          }
        ]}
        currentNavigationByBrowserId={{ 'browser-1': 'navigation-1' }}
        agentSessions={[
          agentSession('ready-agent', { state: 'working', source: 'native-hook', observedAt: 1 }),
          agentSession('offline-agent', { state: 'disconnected', source: 'run-process', observedAt: 1 })
        ]}
        onDelete={() => {}}
        onClear={() => {}}
        onAddToComposer={() => {}}
      />
    )

    expect(markup).toContain('Check this control')
    expect(markup).toContain('Page changed · annotation is stale')
    expect(markup).toContain('value="ready-agent"')
    expect(markup).not.toContain('value="offline-agent"')
    expect(markup).toContain('Add to Composer')
  })
})
