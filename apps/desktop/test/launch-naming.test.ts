import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { AgentLaunchResult, AppConfig, SessionSnapshot } from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import {
  createWorkbenchTab,
  initialWorkbenchRegionId,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs.js'
import { useAppStore } from '../src/renderer/src/store.js'

const initialState = useAppStore.getState()

const newTabSurfaceSource = readFileSync(
  new URL('../src/renderer/src/components/NewTabSurface.tsx', import.meta.url),
  'utf8'
)

const config: AppConfig = {
  version: 7,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {
    codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true }
  },
  workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
}

function launcherFixture(): WorkbenchTab {
  const tabId = 'launcher-tab'
  const launcher = createWorkbenchTab(tabId, {
    regionId: initialWorkbenchRegionId(tabId),
    kind: 'launcher',
    workspaceId: 'workspace'
  })
  useAppStore.setState({
    config,
    activeWorkspaceId: 'workspace',
    tabs: { [launcher.id]: launcher },
    layouts: { workspace: createWorkspaceLayout('pane', [launcher.id]) },
    pendingAgentLaunches: {},
    agentComposerDrafts: {},
    agentNames: {},
    error: null
  })
  return launcher
}

function agentSession(id: string): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    id,
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true, hookEvents: true, timeline: 'streaming', permission: 'observe',
      providerResume: true, acp: false, replyCorrelation: 'none'
    },
    hostId: 'local',
    workspacePath: '/repo',
    label: 'Codex',
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  }
}

function launchResult(session: Extract<SessionSnapshot, { kind: 'agent' }>): AgentLaunchResult {
  return { session, timeline: { agentSessionId: session.id, revision: 0, items: [] } }
}

function mockLaunch(): void {
  vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async (input) =>
    launchResult(agentSession(input.agentSessionId!))
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

// ---------------------------------------------------------------------------
// T-005 验收 6：启动对话框提供 Agent 名与 Tab 名两个输入；都留空时走派生链，不阻塞启动。
//
// 为什么名字由 store 写而不由组件写：sessionId 与 tabId 都在 launchAgent 内部生成、从不出参
// （store.ts 的 crypto.randomUUID / newLauncherTab），组件手上没有可用来调 renameAgent/renameTab
// 的键。所以启动对话框把名字当参数交给 store，store 在挂上之后落地。
//
// 本仓没有能跑 useEffect、能派发 DOM 事件的测试环境（renderToStaticMarkup），因此承重断言落在
// store 这个接缝上——它才是"名字真的落地了"的地方；输入框的存在用源码断言补充。
// ---------------------------------------------------------------------------
describe('启动时命名：两个可选输入，落地在 store', () => {
  it('把启动时填的两个名字写进各自的字段', async () => {
    const launcher = launcherFixture()
    const regionId = launcher.layout.activeRegionId
    mockLaunch()

    await useAppStore.getState().launchAgent(
      'codex',
      'do the thing',
      'pane',
      { tabId: launcher.id, regionId },
      undefined,
      { agentName: '调查员', tabName: '登录排查' }
    )

    const attached = useAppStore.getState().tabs[launcher.id]!
    const surface = attached.regions[regionId]!
    expect(surface).toMatchObject({ kind: 'agent', phase: 'attached' })
    const sessionId = (surface as { sessionId: string }).sessionId
    expect(useAppStore.getState().agentNames[sessionId]).toBe('调查员')
    expect(attached.name).toBe('登录排查')
  })

  it('两个都留空时一个字都不写，显示名交还派生链——且启动不被阻塞', async () => {
    const launcher = launcherFixture()
    const regionId = launcher.layout.activeRegionId
    mockLaunch()

    // 不传 names，等价于用户两个框都没填。
    await useAppStore.getState().launchAgent('codex', 'do the thing', 'pane', {
      tabId: launcher.id,
      regionId
    })

    const attached = useAppStore.getState().tabs[launcher.id]!
    const sessionId = (attached.regions[regionId] as { sessionId: string }).sessionId
    // 空即不写：agentNames 里没有这个键，Tab 也没有 name 字段——两者都落到派生链，
    // 而不是被写成一个空串占位（空串会冒充成"用户手改过"，让自动策略永久停手）。
    expect(sessionId in useAppStore.getState().agentNames).toBe(false)
    expect(attached.name).toBeUndefined()
  })

  it('启动失败不留孤儿名字', async () => {
    const launcher = launcherFixture()
    const regionId = launcher.layout.activeRegionId
    vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(new Error('launch failed'))

    await expect(
      useAppStore.getState().launchAgent(
        'codex',
        'do the thing',
        'pane',
        { tabId: launcher.id, regionId },
        undefined,
        { agentName: '不该留下', tabName: '也不该留下' }
      )
    ).rejects.toThrow('launch failed')

    // 名字与草稿同一时机落地（都在挂上之后）。失败路径若也写名字，会留下一个指向已消失
    // session 的孤儿键，且 Tab 会顶着一个用户以为属于某个 Agent 的名字。
    expect(Object.keys(useAppStore.getState().agentNames)).toHaveLength(0)
    expect(useAppStore.getState().tabs[launcher.id]?.name).toBeUndefined()
  })

  it('空白名字不被当成"用户手改过"', async () => {
    const launcher = launcherFixture()
    const regionId = launcher.layout.activeRegionId
    mockLaunch()

    await useAppStore.getState().launchAgent(
      'codex',
      'do the thing',
      'pane',
      { tabId: launcher.id, regionId },
      undefined,
      { agentName: '   ', tabName: '  ' }
    )

    const attached = useAppStore.getState().tabs[launcher.id]!
    const sessionId = (attached.regions[regionId] as { sessionId: string }).sessionId
    expect(sessionId in useAppStore.getState().agentNames).toBe(false)
    expect(attached.name).toBeUndefined()
  })

  it('启动对话框上真的有这两个输入，且不参与 Launch 的禁用判断', () => {
    // 源码断言只作补充：证明这两个可选输入确实接到了这条已被上面证明过的 store 通路上。
    expect(newTabSurfaceSource).toContain('aria-label="Agent name"')
    expect(newTabSurfaceSource).toContain('aria-label="Tab name"')
    expect(newTabSurfaceSource).toContain(
      '{ agentName: agentName.trim() || undefined, tabName: tabName.trim() || undefined }'
    )
    // 留空不得阻塞启动：Launch 按钮的 disabled 条件里不许出现名字。
    // 按钮上点名，不按 "disabled={!workspace" 这个前缀点名——那个前缀在这份源码里命中六处，
    // 取第一处等于断言了一个跟名字无关的控件，加个名字门禁也不会红。
    const launchButton = newTabSurfaceSource.slice(
      newTabSurfaceSource.indexOf('className="primary-button"'),
      newTabSurfaceSource.indexOf('Launch agent')
    )
    // 只截 disabled 那一段：onClick 里出现 agentName 是正常的（那才是把名字送出去的地方）。
    const disabledClause = launchButton.slice(
      launchButton.indexOf('disabled={'),
      launchButton.indexOf('onClick')
    )
    expect(disabledClause).toContain('disabled={')
    expect(disabledClause).not.toContain('agentName')
    expect(disabledClause).not.toContain('tabName')
  })
})
