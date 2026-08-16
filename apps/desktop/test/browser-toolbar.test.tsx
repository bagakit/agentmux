// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
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
      saveBrowserBookmark: vi.fn(async () => 'Example.webloc'),
      openFile: vi.fn(async () => {}),
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
  version: 9,
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
      saveBookmark: true,
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
  // BrowserSnapshot 的必填位。这份替身早先只被当结构字面量用，缺它不报；T-004 的用例把它 spread
  // 进标注了 BrowserWorkbenchSurface 的位置，缺席才显形——缺的一直是这份替身，不是那几条用例。
  profileId: 'profile-1',
  url: 'https://example.com/',
  title: 'Example',
  loading: false,
  canGoBack: true,
  canGoForward: true,
  viewport: 'responsive' as const,
  driving: false,
  appLinkPrompt: null,
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
      timeline: 'complete-events',
      permission: 'observe',
      providerResume: true,
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
      'Save this page as a bookmark',
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
      'saveBookmark',
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
    expect(markup).not.toContain('aria-label="Save this page as a bookmark"')
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

  // T-004「查看源码」按钮。它是**上下文按钮**（只在从书签开的 Browser 上出现），不进 toolbar 配置——
  // 普通网页没有源可看。二进制 plist 那一档按用户原话「按钮灰掉，hover 告知」（§2.7）。
  it('普通网页（非书签来历）不显示查看源码按钮', () => {
    const markup = renderToStaticMarkup(<BrowserPane tab={tab} visible />)
    expect(markup).not.toContain('aria-label="View bookmark source"')
  })

  it('文本书签：查看源码按钮在场且可用，hover 说明看的是这份书签的源码', () => {
    const fromText = { ...tab, bookmarkOrigin: { path: 'links/Example.webloc', binary: false } }
    const markup = renderToStaticMarkup(<BrowserPane tab={fromText} visible />)
    expect(markup).toContain('aria-label="View bookmark source"')
    // `renderToStaticMarkup` 会把 `'` 转义成 `&#x27;`，所以断言要写成属性在产物里的真实样子。
    // 照着源码里的原文写（`View this bookmark's source`）会红，而红的是断言不是按钮。
    expect(markup).toContain('title="View this bookmark&#x27;s source"')
    // 可用：这个按钮没有 disabled 属性。renderToStaticMarkup 只在 disabled=true 时才输出该属性。
    const button = markup.slice(markup.indexOf('aria-label="View bookmark source"'))
    expect(button.slice(0, button.indexOf('>'))).not.toContain('disabled')
  })

  it('二进制书签：查看源码按钮在场但灰掉，hover 只说清为什么这一个不行（不弹框不 toast 不警告条）', () => {
    const fromBinary = { ...tab, bookmarkOrigin: { path: 'links/Binary.webloc', binary: true } }
    const markup = renderToStaticMarkup(<BrowserPane tab={fromBinary} visible />)
    expect(markup).toContain('aria-label="View bookmark source"')
    const button = markup.slice(markup.indexOf('aria-label="View bookmark source"'))
    expect(button.slice(0, button.indexOf('>'))).toContain('disabled')
    expect(markup).toContain("This bookmark is a binary file")
    // 极简表达：没有对话框/toast/警告条这些更重的形态混进来。
    expect(markup).not.toContain('role="alert"')
    expect(markup).not.toContain('role="dialog"')
  })

  // 承重的接线：点按钮真的调 openFile(path, …, openAsText=true)——回到文本路径看源码。
  // 本仓栽过「onClick 那行被删也没人变红」的跟头（activity-view-wiring），所以这条真挂真点。
  it('点文本书签的查看源码按钮：以 openAsText=true 调 openFile 打开那份书签文件', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const fromText = { ...tab, bookmarkOrigin: { path: 'links/Example.webloc', binary: false } }
    await act(async () => {
      root.render(<BrowserPane tab={fromText} visible />)
    })

    const button = container.querySelector('button[aria-label="View bookmark source"]')
    expect(button).not.toBeNull()
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(fixture.state.openFile).toHaveBeenCalledWith(
      'links/Example.webloc',
      undefined,
      undefined,
      'workspace-1',
      true
    )

    await act(async () => root.unmount())
    container.remove()
  })
})
