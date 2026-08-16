import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

// NewTabSurface 经 lib/api 在模块加载时判断宿主。先立起这个全局，否则下面对组件模块的静态 import
// 会撞未定义的 __AGENTMUX_WEB_PREVIEW__（仅由 vite define 注入，root vitest.config.ts 不注入）。
vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

// 证明"读"的一侧也按 regionId 取草稿：重挂的 NewTabSurface 会立刻显示上次输入，而不是空白。
// 键取错（按 tabId、sessionId 或干脆用组件本地 state）这条就渲染不出那段文本。
// 组件的 useAppStore(selector) 在 renderToStaticMarkup 下不会订阅真实 store，所以按仓库既有约定
// （见 new-tab-resource-contract.test.ts）mock store，喂一份含目标草稿的最小 state。
const fixture = vi.hoisted(() => {
  const regionId = 'region:launcher-tab'
  return {
    regionId,
    state: {
      config: {
        version: 9,
        hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
        executors: {
          codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true }
        },
        workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
        appearance: { terminalTheme: 'graphite' },
        browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
      },
      activeWorkspaceId: 'workspace',
      providerCatalog: [],
      // 组件按 regionId 读草稿；喂进这段文本，断言它出现在渲染结果里。
      agentComposerDrafts: { [regionId]: 'remembered across remount' },
      setAgentComposerDraft: vi.fn(),
      // 两格名字与 prompt 同一机制（按 regionId 存 store，见 launcher-name-draft.ts）；这份 mock
      // 是手搭的最小 state，所以它也要在场，否则组件读整张表时拿到 undefined。
      launcherNameDrafts: {},
      setLauncherNameDraft: vi.fn(),
      tabs: { 'launcher-tab': { workspaceId: 'workspace' } },
      hostChecks: {},
      executorDetections: {},
      detectExecutors: vi.fn(async () => {}),
      launchAgent: vi.fn(async () => {}),
      promoteWarmTerminal: vi.fn(async () => {}),
      prewarmTerminal: vi.fn(),
      warmTerminal: null,
      // 组件无条件读这两项（NewTabSurface 顶部）；带 regionId 会渲染到 Resume 按钮那段，
      // 缺省表里它们必须在场，否则 recoveryCandidates.length 撞 undefined。默认与 store 一致（空表）。
      recoveryCandidates: [],
      recoverSession: vi.fn(async () => {}),
      createBrowser: vi.fn(async () => {})
    }
  }
})

vi.mock('../src/renderer/src/store.js', () => ({
  executorDetectionKey: (hostId: string, executorId: string) => `${hostId}\0${executorId}`,
  warmTerminalKey: (hostId: string, workspacePath: string) => `${hostId}\0${workspacePath}`,
  useAppStore: (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state)
}))

vi.mock('../src/renderer/src/components/TerminalView.js', () => ({ TerminalView: () => null }))

import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface.js'

afterEach(() => {
  fixture.state.agentComposerDrafts = { [fixture.regionId]: 'remembered across remount' }
})

describe('Launcher textarea is bound to the store draft', () => {
  it('renders the draft stored under its regionId, not a fresh empty field', () => {
    const markup = renderToStaticMarkup(
      createElement(NewTabSurface, { tabGroupId: 'pane', tabId: 'launcher-tab', regionId: fixture.regionId })
    )

    // textarea 的受控值由 SSR 渲染成 <textarea>…</textarea> 的子节点。
    expect(markup).toContain('remembered across remount')
  })

  it('shows an empty field when the region has no stored draft', () => {
    // 反面：没有草稿时不该凭空造出内容，证明上一条命中的确来自 store 而非硬编码。
    fixture.state.agentComposerDrafts = {}

    const markup = renderToStaticMarkup(
      createElement(NewTabSurface, { tabGroupId: 'pane', tabId: 'launcher-tab', regionId: fixture.regionId })
    )

    expect(markup).not.toContain('remembered across remount')
  })
})
