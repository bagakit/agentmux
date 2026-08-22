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
      // BrowserPane 的停止/历史/回放全经协议（T-008 收口）。替身缺这一格的话，点按钮会抛
      // TypeError 而栈指向生产文件——看起来像组件回归，其实是替身没覆盖到那个 slice。
      executeControl: vi.fn(async (request: { operation: string }) => {
        if (request.operation === 'browser.history') return { operation: 'browser.history', operations: [] }
        if (request.operation === 'browser.stop') return { operation: 'browser.stop', runOperation: null }
        throw new Error(`unexpected control operation in fixture: ${request.operation}`)
      }),
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
import { api } from '../src/renderer/src/lib/api.js'
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

  it('shows one accessible operation rail while an Agent operates the page', () => {
    const markup = renderToStaticMarkup(<BrowserPane tab={{ ...tab, driving: true }} visible />)
    expect(markup).toContain('Agent control active')
    expect(markup).toContain('Activity details are loading')
    expect(markup).toContain('role="status"')
    expect(markup).not.toContain('browser-control-status')
    expect(renderToStaticMarkup(<BrowserPane tab={tab} visible />)).not.toContain('Agent control active')
  })

  /**
   * 停止走**协议**，不走 `api.browser.stopOperation`（T-008 收口）。
   *
   * 这里断言两件事，缺一件这条就放过一半缺陷：**经协议**（不是又一份 IPC 语义），且**按 operationId
   * 寻址**（不是 browserId）——后者是协议比旧 IPC 强的地方，一条操作的寿命长于这张 Tab。
   */
  it('rail 的接管与停止都经协议按 operationId 取消，不各自维护一份 IPC 语义', async () => {
    fixture.state.executeControl.mockClear()
    // 旧那条第二套语义**整个入口已被删掉**（contracts/preload/ipc/manager 四处），所以这里不 spy——
    // spyOn 一个不存在的方法会抛。判它不在场比判它没被调用更强：不在场的入口无法被将来悄悄接回去。
    expect('stopOperation' in api.browser, 'api.browser.stopOperation 又回来了——第二套语义复活').toBe(false)
    const activeTab = {
      ...tab,
      driving: true,
      activity: {
        control: 'agent' as const,
        operation: {
          id: 'operation-1',
          browserId: tab.browserId,
          operator: { id: 'agent-1', name: 'Navigator', providerId: 'codex' },
          startedAt: 1,
          phase: 'running' as const,
          summary: 'Inspect page',
          url: tab.url,
          steps: []
        }
      }
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => root.render(<BrowserPane tab={activeTab} visible />))
    expect(container.textContent).toContain('Take control')
    const takeControlButton = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Take control'))
    expect(takeControlButton).not.toBeUndefined()
    await act(async () => takeControlButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const stop = container.querySelector('button[aria-label="Stop browser operation"]')
    expect(stop).not.toBeNull()
    await act(async () => stop!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    // 两次点击（Take control 与 Stop）各发一条协议请求，且都按 operationId。钉死整份参数而不是
    // 只判"被调过"：只判次数会放过"发的是别的 operation"或"寻址回到了 browserId"。
    const sent = fixture.state.executeControl.mock.calls.map(([request]) => request as Record<string, unknown>)
    expect(sent.map((request) => request.operation), '停止没经协议，或发的不是 browser.stop')
      .toEqual(['browser.stop', 'browser.stop'])
    expect(sent.map((request) => request.operationId), '协议请求没按 operationId 寻址')
      .toEqual(['operation-1', 'operation-1'])
    // 另一半：**旧那条 IPC 语义一次都没被走**。只断言协议被调过会放过"两条都走了"。
    await act(async () => root.unmount())
    container.remove()
  })

  it('rail 打开历史时经协议按 browserId 取，不各自维护一份 IPC 语义', async () => {
    fixture.state.executeControl.mockClear()
    const listOperationHistory = vi.spyOn(api.browser, 'listOperationHistory')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => root.render(<BrowserPane tab={tab} visible />))
    const openHistory = container.querySelector('button[aria-label="Open browser activity timeline"]')
    expect(openHistory).not.toBeNull()
    await act(async () => openHistory!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(fixture.state.executeControl.mock.calls.map(([request]) => (request as Record<string, unknown>).operation),
      '历史没经协议').toEqual(['browser.history'])
    expect((fixture.state.executeControl.mock.calls[0]![0] as Record<string, unknown>).browserId,
      '过滤没交给协议——在客户端再滤一遍就是把同一条规则写两处').toBe(tab.browserId)
    expect(listOperationHistory, '还在走 api.browser.listOperationHistory（第二套语义仍在）').not.toHaveBeenCalled()
    expect(container.textContent).toContain('Recent operations')
    expect(container.textContent).toContain('No recorded Browser operations yet.')
    await act(async () => root.unmount())
    container.remove()
    listOperationHistory.mockRestore()
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
