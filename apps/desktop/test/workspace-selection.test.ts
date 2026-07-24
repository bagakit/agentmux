import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { AppConfig, SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import type { FileWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { useAppStore } from '../src/renderer/src/store.js'

const initialState = useAppStore.getState()

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

describe('selected worktree workspace context', () => {
  it('keeps existing tabs bound while new tabs use the selected worktree', () => {
    const main: WorkspaceRecord = {
      id: 'main-workspace',
      name: 'repo',
      hostId: 'local',
      path: '/repo',
      kind: 'folder'
    }
    const feature: WorkspaceRecord = {
      id: 'feature-workspace',
      name: 'feature/worktree-context',
      hostId: 'local',
      path: '/repo.worktrees/feature-worktree-context',
      kind: 'worktree',
      repoPath: '/repo',
      branch: 'feature/worktree-context'
    }
    const oldTab: FileWorkbenchTab = {
      id: 'file:main-workspace:README.md',
      kind: 'file',
      workspaceId: main.id,
      path: 'README.md'
    }
    const oldLayout = createWorkspaceLayout('main-pane', [oldTab.id])
    const initialConfig: AppConfig = {
      version: 2,
      hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
      agents: {},
      workspaces: [main]
    }
    const selectedConfig: AppConfig = {
      ...initialConfig,
      workspaces: [main, feature]
    }

    useAppStore.setState({
      config: initialConfig,
      sessions: [],
      activeWorkspaceId: main.id,
      tabs: { [oldTab.id]: oldTab },
      layouts: { [main.id]: oldLayout },
      mainSurface: 'board',
      error: 'stale error'
    })

    useAppStore.getState().activateWorkspaceSelection({
      config: selectedConfig,
      workspace: feature
    })

    const selected = useAppStore.getState()
    expect(selected.config).toBe(selectedConfig)
    expect(selected.activeWorkspaceId).toBe(feature.id)
    expect(selected.mainSurface).toBe('workbench')
    expect(selected.error).toBeNull()
    expect(selected.tabs[oldTab.id]).toEqual(oldTab)
    expect(selected.layouts[main.id]).toBe(oldLayout)
    expect(selected.layouts[feature.id]?.groups[0]?.tabOrder).toEqual([])

    selected.openLauncher()

    const withLauncher = useAppStore.getState()
    const launcher = Object.values(withLauncher.tabs).find(
      (tab) => tab.kind === 'launcher' && tab.workspaceId === feature.id
    )
    expect(launcher).toBeDefined()
    expect(withLauncher.layouts[feature.id]?.groups[0]?.activeTabId).toBe(launcher?.id)
    expect(withLauncher.tabs[oldTab.id]?.workspaceId).toBe(main.id)
    expect(withLauncher.layouts[main.id]).toBe(oldLayout)
  })

  it('shares tool dock open and width while Workspace keeps its own tool selection', () => {
    useAppStore.setState({
      toolsOpen: true,
      workspaceTool: 'files-branches',
      toolDockWidth: 300,
      mainSurface: 'workbench'
    })

    const store = useAppStore.getState()
    store.setWorkspaceTool('terminal-shortcuts')
    store.setToolDockWidth(378)
    store.setMainSurface('board')

    expect(useAppStore.getState()).toMatchObject({
      toolsOpen: true,
      workspaceTool: 'terminal-shortcuts',
      toolDockWidth: 378,
      mainSurface: 'board'
    })

    useAppStore.getState().setMainSurface('workbench')
    expect(useAppStore.getState()).toMatchObject({
      toolsOpen: true,
      workspaceTool: 'terminal-shortcuts',
      toolDockWidth: 378,
      mainSurface: 'workbench'
    })

    useAppStore.getState().toggleTools()
    expect(useAppStore.getState().toolsOpen).toBe(false)
  })
})

function prepareUniversalTab(): { workspace: WorkspaceRecord; tabId: string } {
  const workspace: WorkspaceRecord = {
    id: `workspace-${crypto.randomUUID()}`,
    name: 'repo',
    hostId: 'local',
    path: '/repo',
    kind: 'folder'
  }
  const config: AppConfig = {
    version: 2,
    hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
    agents: { codex: { command: 'codex', args: [], env: {} } },
    workspaces: [workspace]
  }
  useAppStore.setState({
    config,
    sessions: [],
    activities: {},
    activeWorkspaceId: workspace.id,
    tabs: {},
    layouts: { [workspace.id]: createWorkspaceLayout('pane') },
    error: null
  })
  useAppStore.getState().openLauncher('pane')
  const tabId = useAppStore.getState().layouts[workspace.id]!.groups[0]!.activeTabId!
  expect(useAppStore.getState().tabs[tabId]?.kind).toBe('launcher')
  return { workspace, tabId }
}

describe('universal new tab transitions', () => {
  it('opens Agent Launch as a launcher view in the focused pane', () => {
    const { workspace } = prepareUniversalTab()
    useAppStore.getState().openLauncher('pane', 'agent')

    const state = useAppStore.getState()
    const tabId = state.layouts[workspace.id]!.groups[0]!.activeTabId!
    expect(state.tabs[tabId]).toMatchObject({
      kind: 'launcher',
      workspaceId: workspace.id,
      view: 'agent'
    })
  })

  it('replaces the same tab with a raw terminal session', async () => {
    const { workspace, tabId } = prepareUniversalTab()

    await useAppStore.getState().launchTerminal('pane', tabId)

    const state = useAppStore.getState()
    expect(state.layouts[workspace.id]?.groups[0]?.activeTabId).toBe(tabId)
    expect(state.tabs[tabId]).toMatchObject({ id: tabId, kind: 'terminal', workspaceId: workspace.id })
    const terminalTab = state.tabs[tabId]
    const session = terminalTab?.kind === 'terminal'
      ? state.sessions.find((item) => item.id === terminalTab.sessionId)
      : null
    expect(session).toMatchObject({ kind: 'terminal', agentId: null, workspacePath: workspace.path })
  })

  it('replaces the same tab with an agent session', async () => {
    const { workspace, tabId } = prepareUniversalTab()

    await useAppStore.getState().launchAgent('codex', 'ship it', 'pane', tabId)

    const state = useAppStore.getState()
    expect(state.layouts[workspace.id]?.groups[0]?.activeTabId).toBe(tabId)
    expect(state.tabs[tabId]).toMatchObject({ id: tabId, kind: 'agent', workspaceId: workspace.id })
    const agentTab = state.tabs[tabId]
    const session = agentTab?.kind === 'agent'
      ? state.sessions.find((item) => item.id === agentTab.sessionId)
      : null
    expect(session).toMatchObject({ kind: 'agent', agentId: 'codex', workspacePath: workspace.path })
  })

  it('starts a Board discussion in the selected Branch workspace and keeps Board visible', async () => {
    const { workspace: mainWorkspace } = prepareUniversalTab()
    const featureWorkspace: WorkspaceRecord = {
      id: 'feature-board',
      name: 'feature/board',
      hostId: 'local',
      path: '/repo.worktrees/feature-board',
      kind: 'worktree',
      repoPath: mainWorkspace.path,
      branch: 'feature/board'
    }
    useAppStore.setState((state) => ({
      config: { ...state.config!, workspaces: [mainWorkspace, featureWorkspace] },
      mainSurface: 'board'
    }))
    let launched: SessionSnapshot | null = null
    const launch = vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async (input) => {
      const sessionId = input.semanticSessionId!
      launched = {
        id: sessionId,
        kind: 'agent',
        agentId: 'codex',
        hostId: 'local',
        workspacePath: featureWorkspace.path,
        label: 'Codex · feature/board',
        createdAt: 10,
        updatedAt: 10,
        processState: 'running',
        status: { state: 'working', source: 'native-hook', observedAt: 10 },
        latestSequence: 0,
        control: {
          kind: 'agent',
          hostId: 'local',
          semanticSessionId: sessionId,
          daemonSession: { sessionId, incarnationId: `${sessionId}-incarnation` }
        }
      }
      return launched
    })

    await useAppStore.getState().launchBoardAgent(featureWorkspace.id, 'codex', 'Review the board')

    const state = useAppStore.getState()
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'codex',
      prompt: 'Review the board',
      workspacePath: featureWorkspace.path
    }))
    expect(state.activeWorkspaceId).toBe(featureWorkspace.id)
    expect(state.mainSurface).toBe('board')
    expect(state.sessions).toContainEqual(launched)
    expect(Object.values(state.tabs)).toContainEqual(expect.objectContaining({
      kind: 'agent',
      phase: 'attached',
      workspaceId: featureWorkspace.id,
      sessionId: launched!.id
    }))
  })

  it('keeps Board visible and leaves only the existing Launcher recovery path when discussion launch fails', async () => {
    const { workspace } = prepareUniversalTab()
    useAppStore.setState({ mainSurface: 'board', sessions: [], error: null })
    vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(new Error('provider failed'))

    await expect(
      useAppStore.getState().launchBoardAgent(workspace.id, 'codex', 'Discuss failure')
    ).rejects.toThrow('provider failed')

    const state = useAppStore.getState()
    expect(state.mainSurface).toBe('board')
    expect(state.sessions).toEqual([])
    expect(Object.values(state.tabs)).toContainEqual(expect.objectContaining({
      kind: 'launcher',
      view: 'agent',
      workspaceId: workspace.id
    }))
  })

  it('replaces and closes the same tab with a Main-owned browser resource', async () => {
    const { workspace, tabId } = prepareUniversalTab()

    await useAppStore.getState().createBrowser('pane', tabId)

    const opened = useAppStore.getState()
    expect(opened.layouts[workspace.id]?.groups[0]?.activeTabId).toBe(tabId)
    expect(opened.tabs[tabId]).toMatchObject({ id: tabId, browserId: tabId, kind: 'browser', url: 'about:blank' })

    await opened.closeTab(workspace.id, 'pane', tabId)

    expect(useAppStore.getState().tabs[tabId]).toBeUndefined()
    expect(useAppStore.getState().layouts[workspace.id]?.groups[0]?.tabOrder).toEqual([])
  })
})
