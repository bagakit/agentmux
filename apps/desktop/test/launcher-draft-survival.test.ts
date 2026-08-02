import { afterEach, describe, expect, it, vi } from 'vitest'

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
      terminal: true, timeline: 'streaming', permission: 'observe',
      providerResume: true, replyCorrelation: 'none'
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

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

// ---------------------------------------------------------------------------
// 用户报告："有时链接报错 Timed out ... 退回到初始页, 之前输入过的东西没缓存"。
// 根因：launcher 的输入原本只活在 NewTabSurface 的组件 state 里，而启动那一刻 region 立即被换成
// pending agent surface，组件随即卸载；启动失败翻回 launcher（reduceSessionLaunchFailed 沿用同一个
// regionId）重挂的是一个 useState('') 为空的新实例，于是输入丢失。修法：草稿存进 store，按 regionId
// 归属（跨卸载存活），且只在启动成功后清；失败绝不清。
// 决定性两条：启动失败草稿仍在 / 启动成功草稿被清（否则文本会串到下一个新标签页）。
// ---------------------------------------------------------------------------
describe('Launcher prompt survives a failed launch', () => {
  it('keeps the draft keyed by regionId when the launch throws for any reason', async () => {
    const launcher = launcherFixture()
    const regionId = launcher.layout.activeRegionId
    // 组件按 regionId 写草稿；这里直接落到 store，模拟用户已经输入完毕。
    useAppStore.getState().setAgentComposerDraft(regionId, 'the outcome I typed')
    // 任意失败都要保草稿——这里用握手超时那类 launch 失败复现用户场景。
    vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(
      new Error('Timed out waiting for the Provider terminal capability query.')
    )

    await expect(
      useAppStore.getState().launchAgent('codex', 'the outcome I typed', 'pane', {
        tabId: launcher.id,
        regionId
      })
    ).rejects.toThrow('Timed out waiting for the Provider terminal capability query.')

    // region 翻回 launcher（沿用同一 regionId），草稿原封不动留在同一个键上供重试。
    expect(useAppStore.getState().tabs[launcher.id]?.regions[regionId]).toMatchObject({
      kind: 'launcher'
    })
    expect(useAppStore.getState().agentComposerDrafts[regionId]).toBe('the outcome I typed')
  })

  it('clears the draft only after the launch attaches successfully', async () => {
    const launcher = launcherFixture()
    const regionId = launcher.layout.activeRegionId
    useAppStore.getState().setAgentComposerDraft(regionId, 'launch me for real')
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async (input) =>
      launchResult(agentSession(input.agentSessionId!))
    )

    await useAppStore.getState().launchAgent('codex', 'launch me for real', 'pane', {
      tabId: launcher.id,
      regionId
    })

    // region 变成 attached agent，草稿已无归属，必须清掉——否则会串到下一个新标签页。
    expect(useAppStore.getState().tabs[launcher.id]?.regions[regionId]).toMatchObject({
      kind: 'agent',
      phase: 'attached'
    })
    expect(useAppStore.getState().agentComposerDrafts[regionId]).toBeUndefined()
  })
})
