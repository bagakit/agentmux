import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { AgentLaunchResult, AppConfig, SessionSnapshot } from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import {
  createWorkbenchTab,
  initialWorkbenchRegionId,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs.js'
import { useAppStore } from '../src/renderer/src/store.js'

// An empty display snapshot is not a terminal Core fact. Creation has succeeded:
// preserve the Region and report which display re-read failed, without stopping the Run.
const initialState = useAppStore.getState()

const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {
    codex: {
      label: 'Codex',
      providerId: 'codex',
      command: 'codex',
      args: [],
      env: {},
      injectAgentMuxGuide: true
    }
  },
  workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
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
      terminal: true,
      timeline: 'streaming',
      permission: 'observe',
      providerResume: true,
      replyCorrelation: 'none'
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

/**
 * 摆出「in-flight 事件溢出，重取快照时这个 session 已经不在了」这个真实场景。
 *
 * `sessionId` 由 `launchAgent` 内部生成、从不出参，所以溢出标记只能在 mock 拿到它的那一刻写：
 * 这也正是真实时序——事件在启动返回前就已经溢出了。
 */
function launchThatVanishesDuringResync(): { stopped: string[] } {
  const stopped: string[] = []
  vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async (input): Promise<AgentLaunchResult> => {
    const id = input.agentSessionId!
    useAppStore.setState((state) => ({
      pendingAgentLaunches: {
        ...state.pendingAgentLaunches,
        [id]: { ...state.pendingAgentLaunches[id]!, events: [], overflowed: true }
      }
    }))
    const session = agentSession(id)
    return { created: { kind: 'agent', agentSessionId: id, providerId: session.providerId,
      executorId: session.executorId, hostId: session.hostId, workspacePath: session.workspacePath,
      run: session.control.run, retiredRuns: [], createdAt: 1, updatedAt: 1 }, projectionFailures: [],
      session, timeline: { agentSessionId: id, revision: 0, items: [] } }
  })
  // 显示快照暂缺该身份，不能撤销已经接受的创建事实。
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {} } as never)
  vi.spyOn(api.sessions, 'stop').mockImplementation(async (control) => {
    stopped.push((control as { agentSessionId: string }).agentSessionId)
  })
  return { stopped }
}

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

describe('创建成功后缺失显示快照保留已确认事实', () => {
  it('empty canonical projection preserves the same attached Region and reports the missing display', async () => {
    const launcher = launcherFixture(), regionId = launcher.layout.activeRegionId
    const { stopped } = launchThatVanishesDuringResync()
    await expect(useAppStore.getState().launchAgent('codex', 'p', 'pane', { tabId: launcher.id, regionId })).resolves.toBeUndefined()
    const state = useAppStore.getState(), surface = state.tabs[launcher.id]!.regions[regionId]!
    expect(surface).toMatchObject({ kind: 'agent', phase: 'attached' })
    if (surface.kind !== 'agent') throw new Error('Missing Agent Region')
    expect(state.sessions).toEqual([expect.objectContaining({ id: surface.sessionId, processState: 'running' })])
    expect(state.pendingAgentLaunches[surface.sessionId]?.projectionFailures).toEqual([
      { step: 'session', message: 'Created Session display is not yet available.' },
      { step: 'timeline', message: 'Created Session Timeline is not yet available.' }
    ])
    expect(stopped).toEqual([])
  })
  it('the accepted request remains available in the original Region while display re-reading is unavailable', async () => {
    const launcher = launcherFixture(), regionId = launcher.layout.activeRegionId
    launchThatVanishesDuringResync()
    const prompt = '我打了很久的那段话'
    useAppStore.getState().setAgentComposerDraft(regionId, prompt)
    await useAppStore.getState().launchAgent('codex', prompt, 'pane', { tabId: launcher.id, regionId })
    const state = useAppStore.getState(), surface = state.tabs[launcher.id]!.regions[regionId]!
    if (surface.kind !== 'agent') throw new Error('Missing Agent Region')
    expect(state.pendingAgentLaunches[surface.sessionId]?.request).toEqual({ executorId: 'codex', prompt })
    expect(state.pendingAgentLaunches[surface.sessionId]?.created?.agentSessionId).toBe(surface.sessionId)
    expect(state.pendingAgentLaunches[surface.sessionId]?.overflowed).toBe(false)
  })
})
