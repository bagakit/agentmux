import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { AgentLaunchResult, AppConfig, BrowserSnapshot, SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import { revealFileExplorerPath } from '../src/renderer/src/lib/file-explorer-selection.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import {
  createWorkbenchTab,
  initialWorkbenchRegionId,
  titleWorkbenchSurface
} from '../src/renderer/src/lib/workbench-tabs.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics.js'

const initialState = useAppStore.getState()

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

describe('selected worktree workspace context', () => {
  it('opens a visible Browser Tab when New Browser targets a focused non-launcher pane', async () => {
    const workspace: WorkspaceRecord = {
      id: 'browser-workspace',
      name: 'repo',
      hostId: 'local',
      path: '/repo',
      kind: 'folder'
    }
    const existingTab = createWorkbenchTab('existing-file', {
      regionId: 'existing-region',
      kind: 'file',
      workspaceId: workspace.id,
      path: 'README.md'
    })
    const config: AppConfig = {
      version: 9,
      hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
      executors: {},
      workspaces: [workspace],
      appearance: { terminalTheme: 'graphite' },
      browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
    }
    const browser: BrowserSnapshot = {
      id: 'browser-1',
      navigationId: 'navigation-1',
      profileId: 'profile:default',
      url: 'about:blank',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      viewport: 'responsive',
      error: null,
      driving: false,
      appLinkPrompt: null
    }
    useAppStore.setState({
      config,
      sessions: [],
      activeWorkspaceId: workspace.id,
      tabs: { [existingTab.id]: existingTab },
      layouts: { [workspace.id]: createWorkspaceLayout('focused-pane', [existingTab.id]) },
      mainSurface: 'workbench',
      error: null
    })
    const create = vi.spyOn(api.browser, 'create').mockResolvedValue(browser)

    await useAppStore.getState().createBrowser('focused-pane', undefined)

    const state = useAppStore.getState()
    const browserTab = Object.values(state.tabs).find((tab) => tab.id !== existingTab.id)
    expect(browserTab).toBeDefined()
    expect(state.tabs[existingTab.id]).toEqual(existingTab)
    expect(browserTab && titleWorkbenchSurface(browserTab)).toMatchObject({
      kind: 'browser',
      workspaceId: workspace.id,
      browserId: expect.any(String),
      url: 'about:blank'
    })
    expect(state.layouts[workspace.id]?.groups[0]?.tabOrder).toEqual([existingTab.id, browserTab?.id])
    expect(state.layouts[workspace.id]?.groups[0]?.activeTabId).toBe(browserTab?.id)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('preserves each Explorer view across a Workspace A to B to A revisit', async () => {
    const workspaceA = 'workspace-a'
    const workspaceB = 'workspace-b'
    const viewA = {
      selection: {
        activePath: 'src/a.ts',
        anchorPath: 'src/a.ts',
        selectedPaths: new Set(['src/a.ts', 'src/application.ts'])
      },
      expandedPaths: new Set(['src'])
    }
    const viewB = {
      selection: {
        activePath: 'lib/b.ts',
        anchorPath: 'lib/b.ts',
        selectedPaths: new Set(['lib/b.ts'])
      },
      expandedPaths: new Set(['lib'])
    }
    useAppStore.setState({
      activeWorkspaceId: workspaceA,
      layouts: {
        [workspaceA]: createWorkspaceLayout('pane-a'),
        [workspaceB]: createWorkspaceLayout('pane-b')
      },
      lastActiveFileByWorkspace: {
        [workspaceA]: 'src/a.ts',
        [workspaceB]: 'lib/b.ts'
      },
      fileExplorerStates: { [workspaceA]: viewA, [workspaceB]: viewB }
    })
    let explorerProjectionWrites = 0
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.fileExplorerStates !== previous.fileExplorerStates) explorerProjectionWrites += 1
    })

    await useAppStore.getState().selectWorkspace(workspaceB)
    await useAppStore.getState().selectWorkspace(workspaceA)
    unsubscribe()

    const revisited = useAppStore.getState().fileExplorerStates[workspaceA]!
    expect(revisited).toBe(viewA)
    expect(revealFileExplorerPath(revisited, 'src/a.ts')).toBe(revisited)
    expect(revisited.selection.selectedPaths).toEqual(new Set(['src/a.ts', 'src/application.ts']))
    expect(revisited.expandedPaths).toEqual(new Set(['src']))
    expect(explorerProjectionWrites).toBe(0)
  })

  it('collapses the project rail without changing Workspace or surface-tool owners', () => {
    const tabs = useAppStore.getState().tabs
    const layouts = useAppStore.getState().layouts
    const sessions = useAppStore.getState().sessions
    useAppStore.setState({ projectRailOpen: true, toolsOpen: true, toolDockWidth: 236 })

    useAppStore.getState().toggleProjectRail()

    expect(useAppStore.getState()).toMatchObject({
      projectRailOpen: false,
      toolsOpen: true,
      toolDockWidth: 236
    })
    expect(useAppStore.getState().tabs).toBe(tabs)
    expect(useAppStore.getState().layouts).toBe(layouts)
    expect(useAppStore.getState().sessions).toBe(sessions)

    useAppStore.getState().toggleProjectRail()
    expect(useAppStore.getState()).toMatchObject({ projectRailOpen: true, toolDockWidth: 236 })
  })

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
    const oldTabId = 'file:main-workspace:README.md'
    const oldTab = createWorkbenchTab(oldTabId, {
      regionId: initialWorkbenchRegionId(oldTabId),
      kind: 'file',
      workspaceId: main.id,
      path: 'README.md'
    })
    const oldLayout = createWorkspaceLayout('main-pane', [oldTab.id])
    const initialConfig: AppConfig = {
      version: 9,
      hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
      executors: {},
      workspaces: [main],
      appearance: { terminalTheme: 'graphite' },
      browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
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
      (tab) => titleWorkbenchSurface(tab).kind === 'launcher' && tab.workspaceId === feature.id
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
    store.setWorkspaceTool('agents')
    store.setToolDockWidth(378)
    store.setMainSurface('board')

    expect(useAppStore.getState()).toMatchObject({
      toolsOpen: true,
      workspaceTool: 'agents',
      toolDockWidth: 378,
      mainSurface: 'board'
    })

    useAppStore.getState().setMainSurface('workbench')
    expect(useAppStore.getState()).toMatchObject({
      toolsOpen: true,
      workspaceTool: 'agents',
      toolDockWidth: 378,
      mainSurface: 'workbench'
    })

    useAppStore.getState().toggleTools()
    expect(useAppStore.getState().toolsOpen).toBe(false)
  })

  it('reopens an existing background Agent after its Tab View closes', async () => {
    const workspace: WorkspaceRecord = {
      id: 'workspace', name: 'repo', hostId: 'local', path: '/repo', kind: 'folder'
    }
    const session: SessionSnapshot = {
      id: 'agent-session',
      kind: 'agent',
      providerId: 'codex',
      executorId: 'codex',
      hostId: 'local',
      workspacePath: workspace.path,
      label: 'Background review',
      createdAt: 1,
      updatedAt: 2,
      processState: 'running',
      status: { state: 'working', source: 'native-hook', observedAt: 2 },
      latestOutputBytes: 0,
      control: {
        kind: 'agent',
        hostId: 'local',
        agentSessionId: 'agent-session',
        run: { runId: 'agent-run' }
      }
    }
    useAppStore.setState({
      config: {
        version: 9,
        hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
        executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } },
        workspaces: [workspace],
        appearance: { terminalTheme: 'graphite' },
        browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
      },
      sessions: [session],
      activeWorkspaceId: workspace.id,
      tabs: {},
      layouts: { [workspace.id]: createWorkspaceLayout('pane') }
    })

    useAppStore.getState().selectSession(session.id, 'pane')
    const firstTab = Object.values(useAppStore.getState().tabs).find(
      (tab) => titleWorkbenchSurface(tab).kind === 'agent'
    )!
    expect(titleWorkbenchSurface(firstTab)).toMatchObject({ sessionId: session.id })

    await useAppStore.getState().closeTab(workspace.id, 'pane', firstTab.id, {
      keepAgentSessions: true
    })
    expect(useAppStore.getState().sessions).toEqual([session])
    expect(useAppStore.getState().tabs[firstTab.id]).toBeUndefined()

    useAppStore.getState().selectSession(session.id, 'pane')
    expect(titleWorkbenchSurface(useAppStore.getState().tabs[firstTab.id]!)).toMatchObject({
      kind: 'agent',
      sessionId: session.id
    })
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
    version: 9,
    hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
    executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } },
    workspaces: [workspace],
    appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
  }
  useAppStore.setState({
    config,
    sessions: [],
    timelines: {},
    activeWorkspaceId: workspace.id,
    tabs: {},
    layouts: { [workspace.id]: createWorkspaceLayout('pane') },
    error: null
  })
  useAppStore.getState().openLauncher('pane')
  const tabId = useAppStore.getState().layouts[workspace.id]!.groups[0]!.activeTabId!
  expect(titleWorkbenchSurface(useAppStore.getState().tabs[tabId]!).kind).toBe('launcher')
  return { workspace, tabId }
}

describe('universal new tab transitions', () => {
  it('opens a launcher surface in the focused pane', () => {
    const { workspace } = prepareUniversalTab()

    const state = useAppStore.getState()
    const tabId = state.layouts[workspace.id]!.groups[0]!.activeTabId!
    expect(titleWorkbenchSurface(state.tabs[tabId]!)).toMatchObject({
      kind: 'launcher', workspaceId: workspace.id
    })
  })

  it('replaces the same tab with a raw terminal session', async () => {
    const { workspace, tabId } = prepareUniversalTab()

    const launcher = useAppStore.getState().tabs[tabId]!
    await useAppStore.getState().launchTerminal('pane', {
      tabId,
      regionId: launcher.layout.activeRegionId
    })

    const state = useAppStore.getState()
    expect(state.layouts[workspace.id]?.groups[0]?.activeTabId).toBe(tabId)
    const terminalSurface = titleWorkbenchSurface(state.tabs[tabId]!)
    expect(terminalSurface).toMatchObject({ kind: 'terminal', workspaceId: workspace.id })
    const session = terminalSurface.kind === 'terminal'
      ? state.sessions.find((item) => item.id === terminalSurface.sessionId)
      : null
    expect(session).toMatchObject({ kind: 'terminal', providerId: null, workspacePath: workspace.path })
  })

  it('replaces the same tab with an agent session', async () => {
    const { workspace, tabId } = prepareUniversalTab()

    const launcher = useAppStore.getState().tabs[tabId]!
    await useAppStore.getState().launchAgent('codex', 'ship it', 'pane', {
      tabId,
      regionId: launcher.layout.activeRegionId
    })

    const state = useAppStore.getState()
    expect(state.layouts[workspace.id]?.groups[0]?.activeTabId).toBe(tabId)
    const agentSurface = titleWorkbenchSurface(state.tabs[tabId]!)
    expect(agentSurface).toMatchObject({ kind: 'agent', workspaceId: workspace.id })
    const session = agentSurface.kind === 'agent'
      ? state.sessions.find((item) => item.id === agentSurface.sessionId)
      : null
    expect(session).toMatchObject({ kind: 'agent', providerId: 'codex', workspacePath: workspace.path })
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
    let launched: Extract<SessionSnapshot, { kind: 'agent' }> | null = null
    const launch = vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async (input) => {
      const sessionId = input.agentSessionId!
      launched = {
        id: sessionId,
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
        workspacePath: featureWorkspace.path,
        label: 'Codex · feature/board',
        createdAt: 10,
        updatedAt: 10,
        processState: 'running',
        status: { state: 'working', source: 'native-hook', observedAt: 10 },
        latestOutputBytes: 0,
        control: {
          kind: 'agent',
          hostId: 'local',
          agentSessionId: sessionId,
          run: { runId: sessionId }
        }
      }
      return {
        session: launched,
        timeline: { agentSessionId: sessionId, revision: 0, items: [] }
      } satisfies AgentLaunchResult
    })

    await useAppStore.getState().launchBoardAgent(featureWorkspace.id, 'codex', 'Review the board')

    const state = useAppStore.getState()
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      executorId: 'codex',
      prompt: 'Review the board',
      workspacePath: featureWorkspace.path
    }))
    expect(state.activeWorkspaceId).toBe(featureWorkspace.id)
    expect(state.mainSurface).toBe('board')
    expect(state.sessions).toContainEqual(launched)
    expect(Object.values(state.tabs).map(titleWorkbenchSurface)).toContainEqual(expect.objectContaining({
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
    expect(Object.values(state.tabs).map(titleWorkbenchSurface)).toContainEqual(expect.objectContaining({
      kind: 'launcher',
      workspaceId: workspace.id
    }))
  })

  it('replaces and closes the same tab with a Main-owned browser resource', async () => {
    const { workspace, tabId } = prepareUniversalTab()

    const launcher = useAppStore.getState().tabs[tabId]!
    const regionId = launcher.layout.activeRegionId
    await useAppStore.getState().createBrowser('pane', { tabId, regionId })

    const opened = useAppStore.getState()
    expect(opened.layouts[workspace.id]?.groups[0]?.activeTabId).toBe(tabId)
    expect(titleWorkbenchSurface(opened.tabs[tabId]!)).toMatchObject({
      browserId: regionId,
      kind: 'browser',
      url: 'about:blank'
    })

    await opened.closeTab(workspace.id, 'pane', tabId)

    expect(useAppStore.getState().tabs[tabId]).toBeUndefined()
    expect(useAppStore.getState().layouts[workspace.id]?.groups[0]?.tabOrder).toEqual([])
  })
})

describe('Scratch Topic workbench binding', () => {
  function prepareScratch() {
    const workspace: WorkspaceRecord = {
      id: SCRATCH_WORKSPACE_ID,
      name: 'Scratch',
      hostId: 'local',
      path: '/scratch',
      kind: 'folder'
    }
    useAppStore.setState({
      config: {
        version: 9,
        hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
        executors: {
          codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true }
        },
        workspaces: [workspace],
        appearance: { terminalTheme: 'graphite' },
        browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
      },
      sessions: [],
      timelines: {},
      activeWorkspaceId: workspace.id,
      tabs: {},
      layouts: { [workspace.id]: createWorkspaceLayout('scratch-pane') },
      workspaceFileRevisions: {},
      error: null
    })
    return workspace
  }

  it('creates a real Topic and a durable owner View from the empty panel action', async () => {
    const workspace = prepareScratch()
    const ensure = vi.spyOn(api.scratch, 'ensureTopic')

    const topic = await useAppStore.getState().createScratchTopic()

    const state = useAppStore.getState()
    const activeTabId = state.layouts[workspace.id]!.groups[0]!.activeTabId!
    expect(topic.id).toBe(activeTabId)
    expect(state.tabs[activeTabId]?.topicId).toBe(activeTabId)
    expect(ensure).toHaveBeenCalledWith(workspace.id, activeTabId)
    expect(state.workspaceFileRevisions[workspace.id]).toBe(1)

    const nextTopic = await useAppStore.getState().createScratchTopic()
    const nextState = useAppStore.getState()
    expect(nextTopic.id).not.toBe(topic.id)
    expect(nextState.layouts[workspace.id]!.groups[0]!.tabOrder).toHaveLength(2)
    expect(nextState.tabs[nextTopic.id]?.topicId).toBe(nextTopic.id)
  })

  it('opens a filesystem Topic by focusing its bound View or recreating a Launcher View', async () => {
    const workspace = prepareScratch()
    const firstTopic = await useAppStore.getState().createScratchTopic()
    const secondTopic = await useAppStore.getState().createScratchTopic()

    await useAppStore.getState().openScratchTopic(firstTopic.id)

    let state = useAppStore.getState()
    let activeTabId = state.layouts[workspace.id]!.groups[0]!.activeTabId!
    expect(activeTabId).toBe(firstTopic.id)
    expect(state.tabs[activeTabId]?.topicId).toBe(firstTopic.id)

    const terminalTab = createWorkbenchTab('session:plain-terminal', {
      regionId: initialWorkbenchRegionId('session:plain-terminal'),
      kind: 'terminal',
      phase: 'attached',
      workspaceId: workspace.id,
      sessionId: 'plain-terminal'
    })
    useAppStore.setState({
      tabs: { [terminalTab.id]: terminalTab },
      layouts: { [workspace.id]: createWorkspaceLayout('scratch-pane', [terminalTab.id]) }
    })
    await useAppStore.getState().openScratchTopic(secondTopic.id)

    state = useAppStore.getState()
    activeTabId = state.layouts[workspace.id]!.groups[0]!.activeTabId!
    expect(activeTabId).not.toBe(secondTopic.id)
    expect(state.tabs[activeTabId]?.topicId).toBe(secondTopic.id)
    expect(titleWorkbenchSurface(state.tabs[activeTabId]!).kind).toBe('launcher')
    expect(state.tabs[terminalTab.id]?.topicId).toBeUndefined()
    expect(state.layouts[workspace.id]!.groups[0]!.tabOrder).toContain(terminalTab.id)
  })

  it('renames a Topic title without changing its View binding and invalidates the filesystem snapshot', async () => {
    const workspace = prepareScratch()
    const topic = await useAppStore.getState().createScratchTopic()
    const activeTabId = useAppStore.getState().layouts[workspace.id]!.groups[0]!.activeTabId!
    const renameTitle = vi.spyOn(api.scratch, 'renameTitle')

    const renamed = await useAppStore.getState().renameScratchTopic(topic.id, 'Shared outcome')

    const state = useAppStore.getState()
    expect(renameTitle).toHaveBeenCalledWith(workspace.id, topic.id, 'Shared outcome')
    expect(renamed).toMatchObject({ id: topic.id, directoryPath: topic.directoryPath, title: 'Shared outcome' })
    expect(state.tabs[activeTabId]?.topicId).toBe(topic.id)
    expect(state.workspaceFileRevisions[workspace.id]).toBe(2)
  })

  it('invalidates Topic snapshots when the built-in editor saves a direct topic.md', async () => {
    const workspace = prepareScratch()
    const topic = await useAppStore.getState().createScratchTopic()
    await useAppStore.getState().openFile(topic.topicPath, 'scratch-pane')
    const tabId = `file:${workspace.id}:${topic.topicPath}`
    const write = vi.spyOn(api.files, 'write')
    useAppStore.getState().updateDocument(tabId, '# Edited in the file editor\n\nKeep the body.\n')

    await useAppStore.getState().saveDocument(tabId)

    expect(write).toHaveBeenCalledWith(workspace.id, expect.objectContaining({
      path: topic.topicPath,
      content: '# Edited in the file editor\n\nKeep the body.\n'
    }))
    expect(useAppStore.getState().workspaceFileRevisions[workspace.id]).toBe(2)
    await expect(api.scratch.readTopic(workspace.id, topic.id)).resolves.toMatchObject({
      id: topic.id,
      title: 'Edited in the file editor'
    })
  })

  it('carries the View’s bound Topic into the launch without changing ordinary launch inputs', async () => {
    const workspace = prepareScratch()
    // The owner View created here is bound to a real Topic; the launch must carry that
    // binding. A Topic is never minted from the Tab identity — see scratch-topic-agents.
    const topic = await useAppStore.getState().createScratchTopic()
    const state = useAppStore.getState()
    const tabId = state.layouts[workspace.id]!.groups[0]!.activeTabId!
    const launcher = state.tabs[tabId]!
    const launch = vi.spyOn(api.sessions, 'launchAgent')

    await useAppStore.getState().launchAgent('codex', 'work together', 'scratch-pane', {
      tabId,
      regionId: launcher.layout.activeRegionId
    })

    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      workspacePath: workspace.path,
      scratchTopicId: topic.id
    }))
    expect(useAppStore.getState().tabs[tabId]?.topicId).toBe(topic.id)
    expect(useAppStore.getState().workspaceFileRevisions[workspace.id]).toBe(2)
  })

  it('launches with no Topic from an unbound View instead of minting one from the Tab id', async () => {
    const workspace = prepareScratch()
    useAppStore.getState().openLauncher('scratch-pane')
    const state = useAppStore.getState()
    const tabId = state.layouts[workspace.id]!.groups[0]!.activeTabId!
    const launcher = state.tabs[tabId]!
    const launch = vi.spyOn(api.sessions, 'launchAgent')

    await useAppStore.getState().launchAgent('codex', 'work alone', 'scratch-pane', {
      tabId,
      regionId: launcher.layout.activeRegionId
    })

    expect(launch).toHaveBeenCalledTimes(1)
    expect(launch.mock.calls[0]![0]).not.toHaveProperty('scratchTopicId')
    expect(useAppStore.getState().tabs[tabId]?.topicId).toBeUndefined()
  })
})
