import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_ACTIONS,
  DESKTOP_ACTION_ATTRIBUTE,
  DESKTOP_SESSION_ATTRIBUTE
} from '../src/shared/desktop-actions.js'

// NewTabSurface 经 lib/api 在模块加载时判断宿主。先立起这个全局，否则下面对组件模块的静态 import
// 会撞未定义的 __AGENTMUX_WEB_PREVIEW__（仅由 vite define 注入，root vitest.config.ts 不注入）。
vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

const fixture = vi.hoisted(() => {
  const session = {
    id: 'warm-run',
    kind: 'terminal',
    providerId: null,
    hostId: 'local',
    workspacePath: '/repo',
    label: 'Terminal',
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: {
      kind: 'terminal',
      hostId: 'local',
      runId: 'warm-run',
      run: { runId: 'warm-run' }
    }
  }
  const ready = Promise.resolve(session)
  return {
    session,
    ready,
    state: {
      config: {
        version: 9,
        hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
        executors: {},
        workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
        appearance: { terminalTheme: 'graphite' },
        browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
      },
      activeWorkspaceId: 'workspace',
      providerCatalog: [],
      tabs: {},
      hostChecks: {},
      executorDetections: {},
      detectExecutors: vi.fn(async () => {}),
      launchAgent: vi.fn(async () => {}),
      // Resume 快捷方式（6c36a3d7）新读的三格。真实 store 恒把 recoveryCandidates 初始化成 []，
      // 组件对它取 `.length`；这份手搭的最小 mock 建在那之前，缺了就在渲染期炸空指针。
      recoveryCandidates: [],
      recoverSession: vi.fn(async () => {}),
      createNote: vi.fn(async () => {}),
      promoteWarmTerminal: vi.fn(async () => {}),
      prewarmTerminal: vi.fn(),
      // 归属键：这个 fixture 挂的是 `{ tabGroupId: 'group' }`（没有 regionId，即空分组占位那条路径），
      // 所以 warmLauncherId 算出 `group:group`。归属不匹配时不给 live preview——见下面第三条。
      warmTerminal: { key: 'local\0/repo', ownerLauncherId: 'group:group', ready, session },
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
  fixture.state.warmTerminal = {
    key: 'local\0/repo',
    ownerLauncherId: 'group:group',
    ready: fixture.ready,
    session: fixture.session
  }
})

describe('New Tab resource action contract', () => {
  it('exposes the ready reusable Terminal identity and Browser action without label guessing', () => {
    const markup = renderToStaticMarkup(createElement(NewTabSurface, { tabGroupId: 'group' }))

    expect(markup).toContain(`${DESKTOP_ACTION_ATTRIBUTE}="${DESKTOP_ACTIONS.claimReusableTerminal}"`)
    expect(markup).toContain(`${DESKTOP_SESSION_ATTRIBUTE}="${fixture.session.id}"`)
    expect(markup).toContain('aria-label="Open reusable Terminal in tab"')
    expect(markup).toContain(`${DESKTOP_ACTION_ATTRIBUTE}="${DESKTOP_ACTIONS.openBrowser}"`)
    expect(markup).toContain('aria-label="Open Browser"')
  })

  it('does not advertise a ready Session identity while the reusable Terminal is pending', () => {
    fixture.state.warmTerminal = {
      key: 'local\0/repo',
      ownerLauncherId: 'group:group',
      ready: fixture.ready,
      session: null
    }

    const markup = renderToStaticMarkup(createElement(NewTabSurface, { tabGroupId: 'group' }))

    expect(markup).toContain(`${DESKTOP_ACTION_ATTRIBUTE}="${DESKTOP_ACTIONS.claimReusableTerminal}"`)
    expect(markup).not.toContain(DESKTOP_SESSION_ATTRIBUTE)
    expect(markup).toContain('aria-label="Open Terminal"')
    // aria-label 在 pending 与冷卡片两态逐字相同，所以上一条分不开这两态——`pending` 整体退化成
    // 常量 false 时它照旧通过。真正的判别器是这句副标题。
    expect(markup, 'shell 还没起好却画成了冷卡片——用户会以为没有热终端').toContain(
      'Warming a reusable host shell'
    )
  })

  it('does not advertise the warm Session when the slot belongs to a sibling launcher', () => {
    // 归属在别的挂载点上（分屏里的同胞，或另一个 group 的空占位）。key 逐字相同，只判 key 的旧写法
    // 会让两个 TerminalView 挂到同一个 run 上，各自 fit 同一个 PTY。此时这个 launcher 必须退回冷
    // 卡片——而不是 pending：shell 已经起好了，只是不归它。
    fixture.state.warmTerminal = {
      key: 'local\0/repo',
      ownerLauncherId: 'region:someone-else',
      ready: fixture.ready,
      session: fixture.session
    }

    const markup = renderToStaticMarkup(createElement(NewTabSurface, { tabGroupId: 'group' }))

    expect(
      markup,
      '同胞 launcher 也挂上了 warm session——两个 view 会对着同一个 PTY 轮流 resize'
    ).not.toContain(DESKTOP_SESSION_ATTRIBUTE)
    expect(markup).toContain(`${DESKTOP_ACTION_ATTRIBUTE}="${DESKTOP_ACTIONS.claimReusableTerminal}"`)
    // 冷卡片而不是「正在预热」：pending 的文案会骗人说 shell 还没起好。aria-label 在两态相同
    // （都是 "Open Terminal"），真正分开两态的是这句副标题，所以判据落在它上面。
    expect(markup, '归属不匹配被画成了 pending——shell 已经起好了').toContain(
      'Host shell in a recoverable core session'
    )
    expect(markup, '同上，这是 pending 的文案').not.toContain('Warming a reusable host shell')
  })
})
