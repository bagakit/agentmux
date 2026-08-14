// @vitest-environment happy-dom
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
// The App mounts SessionPane→TerminalView for placed sessions; a displaced Agent has no Region so it
// never renders one, but the mount case seeds an empty snapshot and no placed Region either. Stub the
// canvas terminal for safety, exactly as the sibling service-window mount test does.
vi.mock('../src/renderer/src/components/TerminalView.js', () => ({ TerminalView: () => null }))

import {
  AGENTMUX_CONTROL_SCHEMA_VERSION,
  type AgentMuxControlRequest
} from '@agentmux/core'
import type { AgentLaunchResult, AppConfig, RuntimeSnapshot, SessionSnapshot } from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import {
  createWorkbenchTab,
  removeWorkbenchRegion,
  workbenchSurfaces,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { App } from '../src/renderer/src/App.js'
import { DisplacedAgentNotice } from '../src/renderer/src/components/DisplacedAgentNotice.js'

// ---------------------------------------------------------------------------
// T-005 第二半：已健康启动的 Agent 遇布局失败仍可发现且有持续告示。
//
// 第一半（848faeb5）把两条异步 open 路径的**回执落点**收敛到 resolveSpatialCommit。这一半接线的是
// 另一个用户可见面：启动竞态里那一格被关掉/回收时，Agent 进程是好的——绝不能停它（旧代码在 owner
// 闸失败处 cleanup 掉了一个完好的 Run），而要：把它留在 session 列表里保持可发现，记下这次错位，
// 由一块**锚在窗口上、任何布局操作都搬不动**的持续告示提供「找回」入口。
//
// 判据不 hand-set store：真的把一次错位从 executeConrol 这条路上跑出来（在途窗口里关掉那一格），
// 再对**真实渲染**（happy-dom + act，effect 真跑）的告示断言。selectDisplacedAgentNotices 按当前
// sessions+tabs 重判，所以点「找回」后自愈消失也一并验。
// ---------------------------------------------------------------------------

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const initialState = useAppStore.getState()

const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } },
  workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
}

function agent(id: string, label = id): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    id, kind: 'agent', providerId: 'codex', executorId: 'codex',
    capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    hostId: 'local', workspacePath: '/repo', label, createdAt: 1, updatedAt: 1,
    processState: 'running', status: { state: 'running', source: 'run-process', observedAt: 1 }, latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  }
}
function launch(session: Extract<SessionSnapshot, { kind: 'agent' }>): AgentLaunchResult {
  return { session, timeline: { agentSessionId: session.id, revision: 0, items: [] } }
}
function fixture(): WorkbenchTab {
  const caller = agent('caller')
  const tab = createWorkbenchTab('tab-caller', { regionId: 'region-caller', kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: caller.id })
  useAppStore.setState({
    config, sessions: [caller], activeWorkspaceId: 'workspace', mainSurface: 'workbench',
    tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout('group', [tab.id]) },
    pendingAgentLaunches: {}, displacedAgentSessionIds: [], error: null
  })
  return tab
}
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
function request<T extends AgentMuxControlRequest>(value: DistributiveOmit<T, 'schemaVersion' | 'requestId'>): T {
  return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: `request-${value.operation}`, ...value } as T
}

let mounted: { root: Root; element: HTMLElement } | null = null
afterEach(async () => {
  if (mounted) {
    const { root, element } = mounted
    mounted = null
    await act(async () => { root.unmount() })
    element.remove()
  }
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

async function mount(node: ReactElement): Promise<HTMLElement> {
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  mounted = { root, element }
  await act(async () => { root.render(node) })
  return element
}

/**
 * 把一次真实错位从 executeControl open.agent 跑出来：launch 在途时关掉那格 pending Region，再放行 launch。
 * 返回启动出来的 agentSessionId。
 */
async function driveDisplacementThroughStore(): Promise<string> {
  const tab = fixture()
  let release!: (value: AgentLaunchResult) => void
  let launchedId = ''
  vi.spyOn(api.sessions, 'launchAgent').mockImplementation((input) => {
    launchedId = input.agentSessionId!
    return new Promise((resolve) => { release = resolve })
  })
  vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)

  const opening = useAppStore.getState().executeControl(request({
    operation: 'open.agent',
    content: { kind: 'new-agent', executorId: 'codex', prompt: 'write' },
    destination: { kind: 'split', direction: 'right', region: { kind: 'region', regionId: 'region-caller' } }
  }))
  await vi.waitFor(() => { if (!launchedId) throw new Error('launchAgent not called yet') })

  // 在途窗口里关掉那一格（用户把它关了，或它的 id 被回收）。
  const planned = useAppStore.getState().tabs[tab.id]!
  const pendingRegionId = workbenchSurfaces(planned).find((s) => s.regionId !== 'region-caller')!.regionId
  const detached = removeWorkbenchRegion(planned, pendingRegionId)!
  useAppStore.setState((state) => ({ tabs: { ...state.tabs, [tab.id]: detached } }))

  release(launch(agent(launchedId, 'Builder')))
  // 落点没了：回执必须失败（没有可交回的落点），但 Run 不停。
  await expect(opening).rejects.toMatchObject({ code: 'CONTROL_OWNER_LOST' })
  return launchedId
}

describe('T-005 第二半：真实错位 → 记账 + 可发现 + 持续告示 + 找回自愈', () => {
  it('错位记进 store 且 Agent 仍在 session 列表里可被发现（进程没被停）', async () => {
    const stop = vi.spyOn(api.sessions, 'stop')
    const id = await driveDisplacementThroughStore()
    const state = useAppStore.getState()
    // 记账：删掉 store 里那句 displacedAgentSessionIds 追加，这条红。
    expect(state.displacedAgentSessionIds, '错位没有记进 store——告示无从产出').toContain(id)
    // 可发现：Agent 还在 session 列表里（旧代码会 cleanup 停掉它）。
    expect(state.sessions.some((s) => s.id === id), '健康的 Agent 被停掉了，不再可发现').toBe(true)
    // 进程没被停：把 owner 闸失败处改回 cleanup(...) 会调 stop，这条红。
    expect(stop, '错位路径停掉了一个完好的 Run').not.toHaveBeenCalled()
  })

  it('告示从选择器渲染出来（真实 render），点「找回」落到那个 session，随后自愈消失', async () => {
    const id = await driveDisplacementThroughStore()
    const selectSession = vi.spyOn(useAppStore.getState(), 'selectSession')

    const element = await mount(<DisplacedAgentNotice />)

    // 告示在场，且说的是这个 Agent、进程还在跑（文案来自 displacedAgentStepOutcome，经选择器过滤）。
    const notice = element.querySelector('.service-window')
    expect(notice, '错位告示没有渲染出来——选择器返回空或组件没接上').not.toBeNull()
    expect(notice?.textContent).toContain('Builder')
    expect(notice?.textContent).toContain('still running')

    // 点「找回」：只凭 session id 重新解析落点（selectSession），绝不复用失效的 plan.regionId/旧 tabId。
    const action = element.querySelector<HTMLButtonElement>('.displaced-agent-notice__action')!
    expect(action, '没有找回入口——告示不可操作').not.toBeNull()
    await act(async () => { action.click() })

    // 落到了那个 session：selectSession 被以这个 id 调用，且真的给它建/激活了一格。
    expect(selectSession, '点击没有落到那个 session').toHaveBeenCalledWith(id)
    const placed = Object.values(useAppStore.getState().tabs).some((tab) =>
      workbenchSurfaces(tab).some((s) => (s.kind === 'agent' || s.kind === 'terminal') && s.sessionId === id))
    expect(placed, 'selectSession 没有把这个 session 安放到任何一格').toBe(true)

    // 自愈：重新拿回一格后，选择器把它从告示里去掉，DOM 上不再有服务窗。
    expect(element.querySelector('.service-window'), '重新安放后告示没有自愈消失').toBeNull()
  })
})

describe('T-005 第二半：告示真的挂在窗口上（不在会消失的 Region/Tab 里）', () => {
  function emptySnapshot(): RuntimeSnapshot { return { sessions: [], timelines: {}, recoveryCandidates: [] } }

  it('App 主壳里挂出了错位告示——删掉 App.tsx 那行渲染，这条红', async () => {
    vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
    vi.spyOn(api.providers, 'list').mockResolvedValue([])
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue(emptySnapshot())

    const element = await mount(<App />)
    for (let attempt = 0; attempt < 50 && useAppStore.getState().loading; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    }
    expect(useAppStore.getState().loading, 'App 仍停在启动屏，告示断言不可观测').toBe(false)

    // 一个健康、错位、没有落点的 Agent：session 在场（可发现），但没有任何 Region 承载它。
    await act(async () => {
      useAppStore.setState((state) => ({
        sessions: [...state.sessions, agent('displaced-1', 'Runner')],
        displacedAgentSessionIds: [...state.displacedAgentSessionIds, 'displaced-1']
      }))
    })

    const mainShell = element.querySelector('main.main-shell')
    expect(mainShell, '主壳没挂出来').not.toBeNull()
    // 告示必须落在 main-shell 的 notices 区里——那是任何布局操作都搬不动、也毁不掉的锚点。
    expect(mainShell?.querySelector('.displaced-agent-notice'), '错位告示没有挂在窗口锚点上').not.toBeNull()
    expect(mainShell?.textContent).toContain('Runner')
  })
})
