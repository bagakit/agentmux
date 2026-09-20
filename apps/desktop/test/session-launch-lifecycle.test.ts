import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type {
  AppConfig,
  BrowserSnapshot,
  SessionRecoveryResult,
  SessionSnapshot
} from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import {
  addWorkbenchRegion,
  createWorkbenchTab,
  initialWorkbenchRegionId,
  replaceWorkbenchRegion,
  titleWorkbenchSurface,
  workbenchSurfaces,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs.js'
import { useAppStore } from '../src/renderer/src/store.js'

import { warmLauncherId } from '../src/renderer/src/lib/warm-terminal-preview.js'

const initialState = useAppStore.getState()
const warmOwner = warmLauncherId({ tabGroupId: 'pane', regionId: initialWorkbenchRegionId('launcher-tab') })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
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
    layouts: { workspace: createWorkspaceLayout('pane', [launcher.id]) }
  })
  return launcher
}

function terminalSession(id: string): Extract<SessionSnapshot, { kind: 'terminal' }> {
  return {
    id,
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
      runId: id,
      run: { runId: id }
    }
  }
}

function agentSession(id: string): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    ...terminalSession(id),
    kind: 'agent',
    agentSessionUpdatedAt: 1,
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    providerId: 'codex',
    executorId: 'codex',
    label: 'Codex',
    control: {
      kind: 'agent',
      hostId: 'local',
      agentSessionId: id,
      run: { runId: id }
    }
  }
}

function browserSurface(regionId: string, browserId = `browser:${regionId}`) {
  return {
    id: browserId,
    navigationId: `${browserId}:navigation`,
    regionId,
    kind: 'browser' as const,
    workspaceId: 'workspace',
    browserId,
    url: 'about:blank',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    viewport: 'responsive' as const,
    profileId: 'default',
    driving: false,
    appLinkPrompt: null,
    error: null
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

describe('Session and Launcher lifecycle ownership', () => {
  it('fails initialization closed when the required Control contract is missing', async () => {
    const mutableApi = api as unknown as { control?: typeof api.control }
    const control = mutableApi.control
    const subscribeSessions = vi.spyOn(api.sessions, 'onEvent')
    const subscribeBrowsers = vi.spyOn(api.browser, 'onEvent')
    delete mutableApi.control

    try {
        await expect(useAppStore.getState().initialize()).rejects.toThrow('AgentMux Control API is unavailable')
    } finally {
      mutableApi.control = control!
    }

    expect(subscribeSessions).not.toHaveBeenCalled()
    expect(subscribeBrowsers).not.toHaveBeenCalled()
  })

  it('reattaches a running Agent Session and restores its View without recovery overlay across app restart', async () => {
    const running = agentSession('running-agent')
    const tab = createWorkbenchTab('running-view', {
      regionId: 'running-region',
      kind: 'agent',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: running.id
    })
    useAppStore.setState({
      loading: true,
      restoredWorkbench: {
        tabs: { [tab.id]: tab },
        layouts: { workspace: createWorkspaceLayout('pane', [tab.id]) }
      }
    })
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.providers, 'list').mockResolvedValue([])
    const snapshot = vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({
      sessions: [running],
      timelines: { [running.id]: { agentSessionId: running.id, revision: 0, items: [] } },
      recoveryCandidates: []
    })
    const recover = vi.spyOn(api.sessions, 'recover')

    const dispose = await useAppStore.getState().initialize()

    expect(recover).not.toHaveBeenCalled()
    expect(snapshot).toHaveBeenCalledOnce()
    const storedSession = useAppStore.getState().sessions.find((item) => item.id === running.id)
    expect(storedSession).toMatchObject({
      id: running.id,
      processState: 'running',
      status: { state: 'running' },
      control: {
        kind: 'agent',
        agentSessionId: running.id,
        run: { runId: running.id }
      }
    })
    expect(storedSession?.status.continuity).toBeUndefined()
    expect(useAppStore.getState().tabs[tab.id]?.regions['running-region']).toMatchObject({
      kind: 'agent',
      sessionId: running.id
    })
    dispose()
  })

  it('recovers a persisted Agent View whose exact Run disappeared before Desktop startup', async () => {
    const stale = agentSession('persisted-agent')
    const resumed = {
      ...stale,
      control: { ...stale.control, run: { runId: 'resumed-run' } }
    }
    const tab = createWorkbenchTab('persisted-view', {
      regionId: 'persisted-region',
      kind: 'agent',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: stale.id
    })
    useAppStore.setState({
      loading: true,
      restoredWorkbench: {
        tabs: { [tab.id]: tab },
        layouts: { workspace: createWorkspaceLayout('pane', [tab.id]) }
      }
    })
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.providers, 'list').mockResolvedValue([])
    const snapshot = vi.spyOn(api.sessions, 'snapshot')
      .mockResolvedValueOnce({
        sessions: [],
        timelines: {},
        recoveryCandidates: [{
          agentSessionId: stale.id,
          hostId: stale.hostId,
          workspacePath: stale.workspacePath,
          providerId: 'codex',
          executorId: 'codex',
          capabilities: {
            terminal: true,
            timeline: 'streaming',
            permission: 'observe',
            providerResume: true,
            replyCorrelation: 'none'
          },
          label: stale.label,
          createdAt: stale.createdAt,
          updatedAt: stale.updatedAt,
          run: { ...stale.control.run },
          semanticStatus: { state: 'done', source: 'native-hook', observedAt: Date.now(), stateEnteredAt: Date.now() }
        }]
      })
      .mockResolvedValueOnce({
        sessions: [resumed],
        timelines: { [resumed.id]: { agentSessionId: resumed.id, revision: 0, items: [] } },
        recoveryCandidates: []
      })
    const recover = vi.spyOn(api.sessions, 'recover').mockResolvedValue({
      kind: 'resumed',
      session: resumed
    })

    const dispose = await useAppStore.getState().initialize()
    try {

      expect(recover).toHaveBeenCalledWith(stale.control, stale.workspacePath)
      expect(snapshot).toHaveBeenCalledTimes(2)
      expect(useAppStore.getState().sessions).toContainEqual(resumed)
      expect(useAppStore.getState().tabs[tab.id]?.regions['persisted-region']).toMatchObject({
        kind: 'agent',
        sessionId: stale.id
      })
    } finally { dispose() }
  })

  it('stops a late successful launch without recreating its closed Tab', async () => {
    const launcher = launcherFixture()
    const pending = deferred<SessionSnapshot>()
    vi.spyOn(api.sessions, 'launchTerminal').mockImplementation(async () => await pending.promise)
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()

    const launch = useAppStore.getState().launchTerminal('pane', {
      tabId: launcher.id,
      regionId: launcher.layout.activeRegionId
    })
    const launchingTab = useAppStore.getState().tabs[launcher.id]
    const launchingSurface = launchingTab ? titleWorkbenchSurface(launchingTab) : null
    expect(launchingSurface).toMatchObject({ kind: 'terminal', phase: 'launching' })
    const sessionId = launchingSurface && (
      launchingSurface.kind === 'terminal' || launchingSurface.kind === 'agent'
    )
      ? launchingSurface.sessionId
      : ''

    await useAppStore.getState().closeTab('workspace', 'pane', launcher.id)
    const resolved = terminalSession(sessionId)
    pending.resolve(resolved)
    await launch

    expect(stop).toHaveBeenCalledWith(resolved.control)
    expect(useAppStore.getState().tabs[launcher.id]).toBeUndefined()
  })

  it('does not restore Launcher after a closed launch fails', async () => {
    const launcher = launcherFixture()
    const pending = deferred<SessionSnapshot>()
    vi.spyOn(api.sessions, 'launchTerminal').mockImplementation(async () => await pending.promise)

    const launch = useAppStore.getState().launchTerminal('pane', {
      tabId: launcher.id,
      regionId: launcher.layout.activeRegionId
    })
    await useAppStore.getState().closeTab('workspace', 'pane', launcher.id)
    pending.reject(new Error('launch failed'))

    await expect(launch).resolves.toBeUndefined()
    expect(useAppStore.getState().tabs[launcher.id]).toBeUndefined()
    expect(useAppStore.getState().error).toBeNull()
  })

  it('closes one View without stopping a Run shared by another View', async () => {
    const session = terminalSession('shared-run')
    const firstViewId = 'terminal-view-left'
    const firstView = createWorkbenchTab(firstViewId, {
      regionId: initialWorkbenchRegionId(firstViewId),
      kind: 'terminal' as const,
      phase: 'attached' as const,
      workspaceId: 'workspace',
      sessionId: session.id
    })
    const secondViewId = 'terminal-view-right'
    const secondView = createWorkbenchTab(secondViewId, {
      regionId: initialWorkbenchRegionId(secondViewId),
      kind: 'terminal',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: session.id
    })
    useAppStore.setState({
      config,
      activeWorkspaceId: 'workspace',
      sessions: [session],
      tabs: { [firstView.id]: firstView, [secondView.id]: secondView },
      layouts: { workspace: createWorkspaceLayout('pane', [firstView.id, secondView.id]) }
    })
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()

    await useAppStore.getState().closeTab('workspace', 'pane', firstView.id)

    const state = useAppStore.getState()
    expect(stop).not.toHaveBeenCalled()
    expect(state.sessions).toEqual([session])
    expect(state.tabs[firstView.id]).toBeUndefined()
    expect(state.tabs[secondView.id]).toEqual(secondView)
    expect(state.layouts.workspace?.groups[0]?.tabOrder).toEqual([secondView.id])
  })

  it('serializes concurrent closes so the final shared Terminal View stops its Run', async () => {
    const session = terminalSession('shared-run')
    const first = createWorkbenchTab('first-view', {
      regionId: 'first-region',
      kind: 'terminal',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: session.id
    })
    const second = createWorkbenchTab('second-view', {
      regionId: 'second-region',
      kind: 'terminal',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: session.id
    })
    useAppStore.setState({
      config,
      activeWorkspaceId: 'workspace',
      sessions: [session],
      tabs: { [first.id]: first, [second.id]: second },
      layouts: { workspace: createWorkspaceLayout('pane', [first.id, second.id]) }
    })
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()

    await Promise.all([
      useAppStore.getState().closeTab('workspace', 'pane', first.id),
      useAppStore.getState().closeTab('workspace', 'pane', second.id)
    ])

    expect(stop).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().layouts.workspace?.groups[0]?.tabOrder).toEqual([])
  })

  it('closes an exited Terminal View without issuing an invalid stop', async () => {
    const session = { ...terminalSession('exited-terminal'), processState: 'exited' as const }
    const tab = createWorkbenchTab('exited-view', {
      regionId: 'exited-region',
      kind: 'terminal',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: session.id
    })
    useAppStore.setState({
      config,
      activeWorkspaceId: 'workspace',
      sessions: [session],
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('pane', [tab.id]) }
    })
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()

    await useAppStore.getState().closeTab('workspace', 'pane', tab.id)

    expect(stop).not.toHaveBeenCalled()
    expect(useAppStore.getState().tabs[tab.id]).toBeUndefined()
  })

  it('releases a Terminal nested under a file-titled Tab', async () => {
    const session = terminalSession('nested-terminal')
    const tabId = 'file-view'
    const fileRegionId = 'file-region'
    const tab = addWorkbenchRegion(createWorkbenchTab(tabId, {
      regionId: fileRegionId,
      kind: 'file',
      workspaceId: 'workspace',
      path: 'README.md'
    }), fileRegionId, 'right', {
      regionId: 'terminal-region',
      kind: 'terminal',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: session.id
    })
    useAppStore.setState({
      config,
      activeWorkspaceId: 'workspace',
      sessions: [session],
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('pane', [tab.id]) }
    })
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()

    await useAppStore.getState().closeTab('workspace', 'pane', tab.id)

    expect(stop).toHaveBeenCalledWith(session.control)
    expect(useAppStore.getState().tabs[tab.id]).toBeUndefined()
  })

  it('stops a Terminal Run when its last Tab View closes', async () => {
    const session = terminalSession('terminal-run')
    const tabId = 'terminal-view'
    const tab = createWorkbenchTab(tabId, {
      regionId: initialWorkbenchRegionId(tabId),
      kind: 'terminal',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: session.id
    })
    useAppStore.setState({
      config,
      activeWorkspaceId: 'workspace',
      sessions: [session],
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('pane', [tab.id]) }
    })
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()

    await useAppStore.getState().closeTab('workspace', 'pane', tab.id)

    expect(stop).toHaveBeenCalledWith(session.control)
    expect(useAppStore.getState().tabs[tab.id]).toBeUndefined()
  })

  it('does not resurrect a Tab when the stop event removes its Session projection first', async () => {
    const session = terminalSession('terminal-run')
    const tabId = 'terminal-view'
    const tab = createWorkbenchTab(tabId, {
      regionId: initialWorkbenchRegionId(tabId),
      kind: 'terminal',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: session.id
    })
    useAppStore.setState({
      config,
      activeWorkspaceId: 'workspace',
      sessions: [session],
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('pane', [tab.id]) }
    })
    vi.spyOn(api.sessions, 'stop').mockImplementation(async () => {
      useAppStore.setState({
        sessions: [],
        tabs: {},
        layouts: { workspace: createWorkspaceLayout('pane') }
      })
    })

    await expect(useAppStore.getState().closeTab('workspace', 'pane', tab.id)).resolves.toBe(true)

    expect(useAppStore.getState().tabs[tab.id]).toBeUndefined()
    expect(useAppStore.getState().layouts.workspace?.groups[0]?.tabOrder).toEqual([])
  })

  it('does not close a new Region added while its original Run is stopping', async () => {
    const session = terminalSession('terminal-run')
    const tabId = 'terminal-view'
    const tab = createWorkbenchTab(tabId, {
      regionId: initialWorkbenchRegionId(tabId),
      kind: 'terminal',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: session.id
    })
    useAppStore.setState({
      config,
      activeWorkspaceId: 'workspace',
      sessions: [session],
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('pane', [tab.id]) },
      error: null
    })
    const pendingStop = deferred<void>()
    const stopStarted = deferred<void>()
    vi.spyOn(api.sessions, 'stop').mockImplementation(async () => {
      stopStarted.resolve()
      await pendingStop.promise
    })

    const close = useAppStore.getState().closeTab('workspace', 'pane', tab.id)
    await stopStarted.promise
    useAppStore.setState((state) => ({
      tabs: {
        ...state.tabs,
        [tab.id]: addWorkbenchRegion(
          state.tabs[tab.id]!,
          tab.layout.activeRegionId,
          'right',
          {
            regionId: 'late-region',
            kind: 'launcher',
            workspaceId: 'workspace'
          }
        )
      }
    }))
    pendingStop.resolve()

    await expect(close).resolves.toBe(false)
    expect(workbenchSurfaces(useAppStore.getState().tabs[tab.id]!)).toEqual([
      expect.objectContaining({ kind: 'launcher' })
    ])
    expect(useAppStore.getState().error).toContain('View changed while it was closing')
  })

  it('waits for every mixed-resource cleanup after one cleanup fails', async () => {
    const session = terminalSession('mixed-terminal')
    const tabId = 'mixed-view'
    const terminalRegionId = 'terminal-region'
    const tab = addWorkbenchRegion(createWorkbenchTab(tabId, {
      regionId: terminalRegionId,
      kind: 'terminal',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: session.id
    }), terminalRegionId, 'right', browserSurface('browser-region'))
    useAppStore.setState({
      config,
      activeWorkspaceId: 'workspace',
      sessions: [session],
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('pane', [tab.id]) },
      error: null
    })
    const pendingStop = deferred<void>()
    const stopStarted = deferred<void>()
    vi.spyOn(api.browser, 'close').mockRejectedValue(new Error('browser close failed'))
    vi.spyOn(api.sessions, 'stop').mockImplementation(async () => {
      stopStarted.resolve()
      await pendingStop.promise
      useAppStore.getState().applyEvent({
        type: 'core',
        hostId: session.hostId,
        event: {
          type: 'run-removed',
          run: session.control.run,
          evidence: {
            source: 'user',
            observedAt: 2,
            run: session.control.run
          }
        }
      })
    })
    let settled = false

    const close = useAppStore.getState().closeTab('workspace', 'pane', tab.id)
      .finally(() => { settled = true })
    await stopStarted.promise
    const earlyResult = await Promise.race([
      close.then(() => 'settled' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0))
    ])

    expect(earlyResult).toBe('pending')
    expect(settled).toBe(false)
    pendingStop.resolve()
    await expect(close).resolves.toBe(false)
    expect(workbenchSurfaces(useAppStore.getState().tabs[tab.id]!)).toEqual([
      expect.objectContaining({ kind: 'browser', browserId: 'browser:browser-region' })
    ])
    expect(useAppStore.getState().error).toBe('browser close failed')
  })

  it('keeps a same-id Region that attaches while its View cleanup is pending', async () => {
    const terminal = terminalSession('terminal-run')
    const agent = agentSession('pending-agent')
    const tabId = 'launching-view'
    const terminalRegionId = 'terminal-region'
    const launchingRegionId = 'launching-region'
    let tab = addWorkbenchRegion(createWorkbenchTab(tabId, {
      regionId: terminalRegionId,
      kind: 'terminal',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: terminal.id
    }), terminalRegionId, 'right', {
      regionId: launchingRegionId,
      kind: 'agent',
      phase: 'launching',
      workspaceId: 'workspace',
      sessionId: agent.id
    })
    tab = addWorkbenchRegion(tab, launchingRegionId, 'down', browserSurface('browser-region'))
    useAppStore.setState({
      config,
      activeWorkspaceId: 'workspace',
      sessions: [terminal],
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('pane', [tab.id]) },
      error: null
    })
    const pendingBrowserClose = deferred<void>()
    const browserCloseStarted = deferred<void>()
    vi.spyOn(api.browser, 'close').mockImplementation(async () => {
      browserCloseStarted.resolve()
      await pendingBrowserClose.promise
    })
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()

    const close = useAppStore.getState().closeTab('workspace', 'pane', tab.id)
    await browserCloseStarted.promise
    useAppStore.setState((state) => ({
      sessions: [...state.sessions, agent],
      tabs: {
        ...state.tabs,
        [tab.id]: replaceWorkbenchRegion(state.tabs[tab.id]!, launchingRegionId, {
          regionId: launchingRegionId,
          kind: 'agent',
          phase: 'attached',
          workspaceId: 'workspace',
          sessionId: agent.id
        })
      }
    }))
    pendingBrowserClose.resolve()

    await expect(close).resolves.toBe(false)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledWith(terminal.control)
    expect(useAppStore.getState().tabs[tab.id]?.regions[launchingRegionId]).toMatchObject({
      phase: 'attached',
      sessionId: agent.id
    })
  })

  it('fails closed when another View bypasses admission as the close plan is reserved', async () => {
    const session = terminalSession('shared-run')
    const firstTabId = 'closing-view'
    const terminalRegionId = 'closing-terminal'
    const firstTab = addWorkbenchRegion(createWorkbenchTab(firstTabId, {
      regionId: terminalRegionId,
      kind: 'terminal',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: session.id
    }), terminalRegionId, 'right', browserSurface('browser-region'))
    const secondTabId = 'attaching-view'
    const secondRegionId = 'attaching-terminal'
    const secondTab = createWorkbenchTab(secondTabId, {
      regionId: secondRegionId,
      kind: 'terminal',
      phase: 'launching',
      workspaceId: 'workspace',
      sessionId: session.id
    })
    useAppStore.setState({
      config,
      activeWorkspaceId: 'workspace',
      sessions: [session],
      tabs: { [firstTab.id]: firstTab, [secondTab.id]: secondTab },
      layouts: { workspace: createWorkspaceLayout('pane', [firstTab.id, secondTab.id]) }
    })
    vi.spyOn(api.browser, 'close').mockResolvedValue()
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (
        previous.closingWorkbenchViews[firstTab.id] ||
        !state.closingWorkbenchViews[firstTab.id]
      ) return
      unsubscribe()
      const surface = secondTab.regions[secondRegionId]
      if (surface?.kind !== 'terminal') throw new Error('Expected the reserved Terminal fixture')
      useAppStore.setState((current) => ({
        tabs: {
          ...current.tabs,
          [secondTab.id]: replaceWorkbenchRegion(current.tabs[secondTab.id]!, secondRegionId, {
            ...surface,
            phase: 'attached'
          })
        }
      }))
    })

    const close = useAppStore.getState().closeTab('workspace', 'pane', firstTab.id)

    await expect(close).resolves.toBe(false)
    expect(stop).not.toHaveBeenCalled()
    expect(useAppStore.getState().tabs[firstTab.id]?.regions[terminalRegionId]).toMatchObject({
      kind: 'terminal',
      phase: 'attached',
      sessionId: session.id
    })
    expect(useAppStore.getState().tabs[secondTab.id]?.regions[secondRegionId]).toMatchObject({
      phase: 'attached',
      sessionId: session.id
    })
    expect(useAppStore.getState().error).toContain('Session gained another View while closing')
  })

  it('dispatches Session Stop without waiting for Browser cleanup to settle', async () => {
    const session = terminalSession('mixed-terminal')
    const tab = addWorkbenchRegion(createWorkbenchTab('mixed-view', {
      regionId: 'terminal-region',
      kind: 'terminal',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: session.id
    }), 'terminal-region', 'right', browserSurface('browser-region'))
    useAppStore.setState({
      config,
      activeWorkspaceId: 'workspace',
      sessions: [session],
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('pane', [tab.id]) },
      error: null
    })
    const pendingBrowserClose = deferred<void>()
    const browserCloseStarted = deferred<void>()
    vi.spyOn(api.browser, 'close').mockImplementation(async () => {
      browserCloseStarted.resolve()
      await pendingBrowserClose.promise
      throw new Error('browser close failed')
    })
    const stopStarted = deferred<void>()
    vi.spyOn(api.sessions, 'stop').mockImplementation(async () => {
      stopStarted.resolve()
    })

    const close = useAppStore.getState().closeTab('workspace', 'pane', tab.id)
    await browserCloseStarted.promise
    await stopStarted.promise
    expect(useAppStore.getState().closingWorkbenchViews[tab.id]).toBeDefined()
    pendingBrowserClose.resolve()

    await expect(close).resolves.toBe(false)
    expect(workbenchSurfaces(useAppStore.getState().tabs[tab.id]!)).toEqual([
      expect.objectContaining({ kind: 'browser' })
    ])
  })

  it('rejects a concurrent close of the same View without duplicating cleanup', async () => {
    const session = terminalSession('terminal-run')
    const tab = addWorkbenchRegion(createWorkbenchTab('closing-view', {
      regionId: 'terminal-region',
      kind: 'terminal',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: session.id
    }), 'terminal-region', 'right', browserSurface('browser-region'))
    useAppStore.setState({
      config,
      activeWorkspaceId: 'workspace',
      sessions: [session],
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('pane', [tab.id]) }
    })
    const pendingBrowserClose = deferred<void>()
    const browserCloseStarted = deferred<void>()
    const browserClose = vi.spyOn(api.browser, 'close').mockImplementation(async () => {
      browserCloseStarted.resolve()
      await pendingBrowserClose.promise
    })
    const pendingStop = deferred<void>()
    const stopStarted = deferred<void>()
    const stop = vi.spyOn(api.sessions, 'stop').mockImplementation(async () => {
      stopStarted.resolve()
      await pendingStop.promise
    })
    const recover = vi.spyOn(api.sessions, 'recover').mockResolvedValue({
      kind: 'terminal-restarted',
      session
    })
    const refresh = vi.spyOn(api.sessions, 'refresh').mockResolvedValue(session)

    const firstClose = useAppStore.getState().closeTab('workspace', 'pane', tab.id)
    await Promise.all([browserCloseStarted.promise, stopStarted.promise])
    await expect(useAppStore.getState().closeTab('workspace', 'pane', tab.id)).resolves.toBe(false)
    await useAppStore.getState().recoverSession(session.id)
    await useAppStore.getState().refreshSession(session.id)
    await useAppStore.getState().stopSession(session.id)
    expect(browserClose).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(recover).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    pendingBrowserClose.resolve()
    pendingStop.resolve()

    await expect(firstClose).resolves.toBe(true)
    expect(useAppStore.getState().tabs[tab.id]).toBeUndefined()
  })

  it('a stop that never answers still frees the View so it can be closed again', async () => {
    // 「经常出现 session 关不掉」的端到端判据。
    //
    // 缺陷不是"停止失败了"，是停止**永远不返回**：整条链路没有客户端超时，daemon 收下停止帧却不回执时
    // 这个 await 永不结束。而重入租约在 `finally` 里释放——于是租约永久扣住，之后每一次点关闭都在入口被
    // 静默挡掉。用户看到的是「点了没反应，而且这个 Tab 现在连反应都没有了」。
    //
    // 上限本身由 session-stop-timeout.test.ts 逐条守；这里守的是它接上之后**整条关闭路的结局**：
    // 拒绝 → 保留投影 → 释放租约 → 还能再关一次。这三件事缺任何一件，用户仍然被卡住。
    const session = terminalSession('wedged-run')
    const tab = createWorkbenchTab('wedged-view', {
      regionId: 'terminal-region',
      kind: 'terminal',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: session.id
    })
    useAppStore.setState({
      config,
      activeWorkspaceId: 'workspace',
      sessions: [session],
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('pane', [tab.id]) },
      error: null
    })
    const stop = vi.spyOn(api.sessions, 'stop')
      // 第一次：上限到点后拒绝（preload 的 withStopTimeout 的实际形状）。
      .mockRejectedValueOnce(Object.assign(new Error('no response from the Runtime'), {
        code: 'SESSION_STOP_TIMEOUT'
      }))
      // 第二次：用户再点一次，这回 Runtime 答了。
      .mockResolvedValueOnce()

    await expect(useAppStore.getState().closeTab('workspace', 'pane', tab.id)).resolves.toBe(false)
    expect(
      useAppStore.getState().tabs[tab.id],
      '没等到回音就把 Tab 删了——那是在拿用户的 Agent 撒谎，Session 可能还活着'
    ).toBeDefined()
    expect(
      useAppStore.getState().closingWorkbenchViews[tab.id],
      '租约没释放——之后每一次点关闭都会被静默挡掉，这正是「连反应都没有了」'
    ).toBeUndefined()
    expect(useAppStore.getState().error, '超时没有告诉用户').not.toBeNull()

    // 再关一次：这一次必须真的走到 stop，而不是被上一次的租约挡在门外。
    await expect(useAppStore.getState().closeTab('workspace', 'pane', tab.id)).resolves.toBe(true)
    expect(stop, '第二次点击没能走到 stop——租约仍扣着').toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().tabs[tab.id]).toBeUndefined()
  })

  it('retries only the failed owner after a partial close', async () => {
    const session = terminalSession('terminal-run')
    const tab = addWorkbenchRegion(createWorkbenchTab('closing-view', {
      regionId: 'terminal-region',
      kind: 'terminal',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: session.id
    }), 'terminal-region', 'right', browserSurface('browser-region'))
    useAppStore.setState({
      config,
      activeWorkspaceId: 'workspace',
      sessions: [session],
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('pane', [tab.id]) },
      error: null
    })
    const browserClose = vi.spyOn(api.browser, 'close').mockResolvedValue()
    const stop = vi.spyOn(api.sessions, 'stop')
      .mockRejectedValueOnce(new Error('stop failed'))
      .mockResolvedValueOnce()

    await expect(useAppStore.getState().closeTab('workspace', 'pane', tab.id)).resolves.toBe(false)
    expect(workbenchSurfaces(useAppStore.getState().tabs[tab.id]!)).toEqual([
      expect.objectContaining({ kind: 'terminal' })
    ])
    await expect(useAppStore.getState().closeTab('workspace', 'pane', tab.id)).resolves.toBe(true)

    expect(browserClose).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().tabs[tab.id]).toBeUndefined()
  })

  it('keeps a canonical recovered Agent visible when the frozen old Run closes', async () => {
    const session = agentSession('agent-run')
    const recovered = {
      ...session,
      updatedAt: 2,
      control: { ...session.control, run: { runId: 'recovered-run' } }
    }
    const tab = createWorkbenchTab('agent-view', {
      regionId: 'agent-region',
      kind: 'agent',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: session.id
    })
    const neighbor = agentSession('neighbor-agent')
    const neighborTab = createWorkbenchTab('neighbor-view', { regionId: 'neighbor-region', kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: neighbor.id })
    useAppStore.setState({
      config,
      activeWorkspaceId: 'workspace',
      sessions: [session, neighbor],
      tabs: { [tab.id]: tab, [neighborTab.id]: neighborTab },
      layouts: { workspace: createWorkspaceLayout('pane', [tab.id, neighborTab.id]) },
      error: null
    })
    const pendingRecover = deferred<SessionRecoveryResult>()
    vi.spyOn(api.sessions, 'recover').mockImplementation(async () => await pendingRecover.promise)
    const pendingOldStop = deferred<void>()
    const oldStopStarted = deferred<void>()
    const stop = vi.spyOn(api.sessions, 'stop').mockImplementation(async (control) => {
      if (control.run.runId === session.control.run.runId) {
        oldStopStarted.resolve()
        await pendingOldStop.promise
        return
      }
      throw new Error('recovered Run cleanup failed')
    })

    const recover = useAppStore.getState().recoverSession(session.id)
    const close = useAppStore.getState().closeTab('workspace', 'pane', tab.id)
    await oldStopStarted.promise
    try {
      pendingRecover.resolve({ kind: 'resumed', session: recovered })
      await recover
      useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: {
        type: 'agent-session', session: {
          kind: 'agent', agentSessionId: session.id, providerId: 'codex', executorId: 'codex',
          hostId: 'local', workspacePath: '/repo', createdAt: 1, updatedAt: 2,
          run: recovered.control.run, retiredRuns: [session.control.run]
        }
      } })
      expect(useAppStore.getState().sessions[0]?.control.run.runId).toBe('recovered-run')
    } finally { pendingOldStop.resolve(); await close }

    await expect(close).resolves.toBe(false)
    expect(stop.mock.calls.map(([control]) => control)).toEqual([session.control])
    expect(useAppStore.getState().tabs[tab.id]).toEqual(tab)
    expect(useAppStore.getState().sessions.map(item => [item.id, item.control.run.runId])).toEqual([[session.id, 'recovered-run'], [neighbor.id, neighbor.control.run.runId]])
    expect(useAppStore.getState().tabs[neighborTab.id]).toBe(neighborTab)
    expect(useAppStore.getState().sessions.find(item => item.id === neighbor.id)).toBe(neighbor)
    expect(useAppStore.getState().error).toContain('View changed while it was closing')
    expect(useAppStore.getState().closingWorkbenchViews).toEqual({})
  })

  it('projects Core continuity unavailability without replacing or stopping the Session', async () => {
    const session = agentSession('agent-run')
    const tab = createWorkbenchTab('agent-view', {
      regionId: 'agent-region',
      kind: 'agent',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: session.id
    })
    useAppStore.setState({
      config,
      activeWorkspaceId: 'workspace',
      sessions: [session],
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('pane', [tab.id]) },
      error: null
    })
    vi.spyOn(api.sessions, 'recover').mockResolvedValue({
      kind: 'unavailable',
      agentSessionId: session.id,
      previousRun: session.control.run,
      reason: 'native-handle-unavailable',
      evidence: { kind: 'run-missing', observedAt: 2 }
    })
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()

    await useAppStore.getState().recoverSession(session.id)

    expect(useAppStore.getState().sessions).toEqual([
      expect.objectContaining({
        id: session.id,
        control: session.control,
        status: expect.objectContaining({
          state: 'error',
          continuity: 'unavailable',
          detail: expect.stringContaining('verified Provider handle')
        })
      })
    ])
    expect(stop).not.toHaveBeenCalled()
  })

  it('removes the Session and its View when Core reports persisted retirement', async () => {
    const session = agentSession('agent-run')
    const tab = createWorkbenchTab('agent-view', {
      regionId: 'agent-region',
      kind: 'agent',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: session.id
    })
    useAppStore.setState({
      config,
      activeWorkspaceId: 'workspace',
      sessions: [session],
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('pane', [tab.id]) },
      timelines: {
        [session.id]: { agentSessionId: session.id, revision: 0, items: [] }
      },
      error: null
    })
    vi.spyOn(api.sessions, 'recover').mockResolvedValue({
      kind: 'retired',
      agentSessionId: session.id,
      previousRun: session.control.run,
      evidence: { kind: 'user-retired', observedAt: 2 }
    })
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()

    await useAppStore.getState().recoverSession(session.id)

    expect(useAppStore.getState().sessions).toEqual([])
    expect(useAppStore.getState().tabs).toEqual({})
    expect(useAppStore.getState().timelines).toEqual({})
    expect(stop).not.toHaveBeenCalled()
  })

  it('accepts an authoritative recovered Run that arrives before its recover receipt', async () => {
    const session = agentSession('agent-run')
    const recovered = {
      ...session,
      updatedAt: 2,
      control: { ...session.control, run: { runId: 'recovered-run' } }
    }
    const tab = createWorkbenchTab('agent-view', {
      regionId: 'agent-region',
      kind: 'agent',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: session.id
    })
    useAppStore.setState({
      config,
      activeWorkspaceId: 'workspace',
      sessions: [session],
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('pane', [tab.id]) }
    })
    const pendingRecover = deferred<SessionRecoveryResult>()
    vi.spyOn(api.sessions, 'recover').mockImplementation(async () => await pendingRecover.promise)
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()

    const recover = useAppStore.getState().recoverSession(session.id)
    useAppStore.getState().applyEvent({
      type: 'core',
      hostId: session.hostId,
      event: {
        type: 'agent-session',
        session: {
          kind: 'agent',
          agentSessionId: session.id,
          providerId: session.providerId,
          executorId: session.executorId,
          hostId: session.hostId,
          workspacePath: session.workspacePath,
          run: recovered.control.run,
          retiredRuns: [session.control.run],

          createdAt: recovered.createdAt,
          updatedAt: recovered.updatedAt
        }
      }
    })
    pendingRecover.resolve({ kind: 'resumed', session: recovered })
    await recover

    expect(stop).not.toHaveBeenCalled()
    expect(useAppStore.getState().sessions[0]?.control.run).toEqual(recovered.control.run)
    expect(useAppStore.getState().tabs[tab.id]).toEqual(tab)
  })

  it('closes a shared semantic Session View across a legal Run change', async () => {
    const session = agentSession('agent-run')
    const recovered = {
      ...session,
      updatedAt: 2,
      control: { ...session.control, run: { runId: 'recovered-run' } }
    }
    const first = addWorkbenchRegion(createWorkbenchTab('first-view', {
      regionId: 'first-agent',
      kind: 'agent',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: session.id
    }), 'first-agent', 'right', browserSurface('browser-region'))
    const second = createWorkbenchTab('second-view', {
      regionId: 'second-agent',
      kind: 'agent',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: session.id
    })
    useAppStore.setState({
      config,
      activeWorkspaceId: 'workspace',
      sessions: [session],
      tabs: { [first.id]: first, [second.id]: second },
      layouts: { workspace: createWorkspaceLayout('pane', [first.id, second.id]) }
    })
    const pendingBrowserClose = deferred<void>()
    const browserCloseStarted = deferred<void>()
    vi.spyOn(api.browser, 'close').mockImplementation(async () => {
      browserCloseStarted.resolve()
      await pendingBrowserClose.promise
    })
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()

    const close = useAppStore.getState().closeTab('workspace', 'pane', first.id)
    await browserCloseStarted.promise
    useAppStore.setState({ sessions: [recovered] })
    pendingBrowserClose.resolve()

    await expect(close).resolves.toBe(true)
    expect(stop).not.toHaveBeenCalled()
    expect(useAppStore.getState().tabs[first.id]).toBeUndefined()
    expect(useAppStore.getState().tabs[second.id]).toEqual(second)
    expect(useAppStore.getState().sessions).toEqual([recovered])
  })

  it('reopens a recovered Terminal when owner-loss cleanup fails after its View closed', async () => {
    const session = terminalSession('terminal-run')
    const recovered = terminalSession('recovered-run')
    const tab = createWorkbenchTab('terminal-view', {
      regionId: 'terminal-region',
      kind: 'terminal',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: session.id
    })
    useAppStore.setState({
      config,
      activeWorkspaceId: 'workspace',
      sessions: [session],
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('pane', [tab.id]) },
      error: null
    })
    const pendingRecover = deferred<SessionRecoveryResult>()
    vi.spyOn(api.sessions, 'recover').mockImplementation(async () => await pendingRecover.promise)
    const stop = vi.spyOn(api.sessions, 'stop').mockImplementation(async (control) => {
      if (control.run.runId === recovered.control.run.runId) {
        throw new Error('recovered Run cleanup failed')
      }
      useAppStore.getState().applyEvent({
        type: 'core',
        hostId: session.hostId,
        event: {
          type: 'run-removed',
          run: session.control.run,
          evidence: { source: 'user', observedAt: 2, run: session.control.run }
        }
      })
    })

    const recover = useAppStore.getState().recoverSession(session.id)
    await expect(useAppStore.getState().closeTab('workspace', 'pane', tab.id)).resolves.toBe(true)
    pendingRecover.resolve({ kind: 'terminal-restarted', session: recovered })
    await recover

    const reopened = useAppStore.getState().tabs[`session:${recovered.id}`]
    expect(stop).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().sessions).toEqual([recovered])
    expect(reopened && titleWorkbenchSurface(reopened)).toMatchObject({
      kind: 'terminal',
      phase: 'attached',
      sessionId: recovered.id
    })
    expect(useAppStore.getState().error).toContain('cleanup failed')
  })

  it('retains operation rejection when recovered Terminal owner-loss cleanup fails', async () => {
    const session = terminalSession('terminal-run')
    const recovered = terminalSession('recovered-run')
    const tab = createWorkbenchTab('terminal-view', {
      regionId: 'terminal-region',
      kind: 'terminal',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: session.id
    })
    useAppStore.setState({
      config,
      activeWorkspaceId: 'workspace',
      sessions: [session],
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('pane', [tab.id]) },
      error: null
    })
    const pendingRecover = deferred<SessionRecoveryResult>()
    vi.spyOn(api.sessions, 'recover').mockImplementation(async () => await pendingRecover.promise)
    const stop = vi.spyOn(api.sessions, 'stop').mockImplementation(async (control) => {
      if (control.run.runId === recovered.control.run.runId) {
        throw new Error('recovered Run cleanup failed')
      }
      useAppStore.getState().applyEvent({
        type: 'core',
        hostId: session.hostId,
        event: {
          type: 'run-removed',
          run: session.control.run,
          evidence: { source: 'user', observedAt: 2, run: session.control.run }
        }
      })
    })

    const recover = useAppStore.getState().recoverSession(session.id, 'recovery-operation')
    const rejection = expect(recover).rejects.toThrow('Recovered Session owner disappeared and cleanup failed')
    await expect(useAppStore.getState().closeTab('workspace', 'pane', tab.id)).resolves.toBe(true)
    pendingRecover.resolve({ kind: 'terminal-restarted', session: recovered })
    await rejection

    const reopened = useAppStore.getState().tabs[`session:${recovered.id}`]
    expect(stop).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().sessions).toEqual([recovered])
    expect(reopened && titleWorkbenchSurface(reopened)).toMatchObject({
      kind: 'terminal',
      phase: 'attached',
      sessionId: recovered.id
    })
    expect(useAppStore.getState().error).toBeNull()
  })

  it('does not resurrect a Session from a refresh that resolves after owner removal', async () => {
    const session = terminalSession('terminal-run')
    const tab = createWorkbenchTab('terminal-view', {
      regionId: 'terminal-region',
      kind: 'terminal',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: session.id
    })
    useAppStore.setState({
      config,
      activeWorkspaceId: 'workspace',
      sessions: [session],
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('pane', [tab.id]) }
    })
    const pendingRefresh = deferred<SessionSnapshot>()
    vi.spyOn(api.sessions, 'refresh').mockImplementation(async () => await pendingRefresh.promise)
    vi.spyOn(api.sessions, 'stop').mockImplementation(async () => {
      useAppStore.getState().applyEvent({
        type: 'core',
        hostId: session.hostId,
        event: {
          type: 'run-removed',
          run: session.control.run,
          evidence: { source: 'user', observedAt: 2, run: session.control.run }
        }
      })
    })

    const refresh = useAppStore.getState().refreshSession(session.id)
    await expect(useAppStore.getState().closeTab('workspace', 'pane', tab.id)).resolves.toBe(true)
    pendingRefresh.resolve(session)
    await refresh

    expect(useAppStore.getState().sessions).toEqual([])
    expect(useAppStore.getState().tabs[tab.id]).toBeUndefined()
  })

  it('rejects View topology mutations while its close plan is active', async () => {
    const session = terminalSession('terminal-run')
    const terminalRegionId = 'terminal-region'
    const launcherRegionId = 'launcher-region'
    const tab = addWorkbenchRegion(createWorkbenchTab('closing-view', {
      regionId: terminalRegionId,
      kind: 'terminal',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: session.id
    }), terminalRegionId, 'right', {
      regionId: launcherRegionId,
      kind: 'launcher',
      workspaceId: 'workspace'
    })
    const neighbor = createWorkbenchTab('neighbor-view', {
      regionId: 'neighbor-region',
      kind: 'launcher',
      workspaceId: 'workspace'
    })
    useAppStore.setState({
      config,
      activeWorkspaceId: 'workspace',
      sessions: [session],
      tabs: { [tab.id]: tab, [neighbor.id]: neighbor },
      layouts: {
        workspace: {
          root: {
            type: 'split',
            direction: 'horizontal',
            ratio: 0.5,
            first: { type: 'leaf', groupId: 'left' },
            second: { type: 'leaf', groupId: 'right' }
          },
          groups: [
            { id: 'left', tabOrder: [tab.id], activeTabId: tab.id, recentTabIds: [tab.id] },
            {
              id: 'right',
              tabOrder: [neighbor.id],
              activeTabId: neighbor.id,
              recentTabIds: [neighbor.id]
            }
          ],
          activeGroupId: 'left'
        }
      }
    })
    const pendingStop = deferred<void>()
    const stopStarted = deferred<void>()
    vi.spyOn(api.sessions, 'stop').mockImplementation(async () => {
      stopStarted.resolve()
      await pendingStop.promise
    })

    const close = useAppStore.getState().closeTab('workspace', 'left', tab.id)
    await stopStarted.promise
    const before = useAppStore.getState()
    useAppStore.getState().splitRegion('workspace', tab.id, terminalRegionId, 'down')
    await useAppStore.getState().closeRegion('workspace', tab.id, launcherRegionId)
    useAppStore.getState().moveTab('workspace', tab.id, 'left', 'right', 0)
    useAppStore.getState().moveTabToNewGroup('workspace', tab.id, 'left', 'right', 'down')

    expect(useAppStore.getState().tabs[tab.id]).toBe(before.tabs[tab.id])
    expect(useAppStore.getState().layouts.workspace).toBe(before.layouts.workspace)
    pendingStop.resolve()
    await expect(close).resolves.toBe(true)
    expect(useAppStore.getState().tabs[tab.id]).toBeUndefined()
    expect(useAppStore.getState().layouts.workspace?.groups.flatMap((group) => group.tabOrder))
      .toEqual([neighbor.id])
  })

  it('accepts an in-flight Region close that already removed the exact Browser owner', async () => {
    const session = terminalSession('terminal-run')
    const terminalRegionId = 'terminal-region'
    const browserRegionId = 'browser-region'
    const tab = addWorkbenchRegion(createWorkbenchTab('closing-view', {
      regionId: terminalRegionId,
      kind: 'terminal',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: session.id
    }), terminalRegionId, 'right', browserSurface(browserRegionId))
    useAppStore.setState({
      config,
      activeWorkspaceId: 'workspace',
      sessions: [session],
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('pane', [tab.id]) },
      error: null
    })
    const regionCloseStarted = deferred<void>()
    const releaseRegionClose = deferred<void>()
    let browserCloseCalls = 0
    vi.spyOn(api.browser, 'close').mockImplementation(async () => {
      browserCloseCalls += 1
      if (browserCloseCalls !== 1) throw new Error('Browser is already closing')
      regionCloseStarted.resolve()
      await releaseRegionClose.promise
    })
    const pendingStop = deferred<void>()
    const stopStarted = deferred<void>()
    vi.spyOn(api.sessions, 'stop').mockImplementation(async () => {
      stopStarted.resolve()
      await pendingStop.promise
    })

    const closeRegion = useAppStore.getState().closeRegion('workspace', tab.id, browserRegionId)
    await regionCloseStarted.promise
    const closeView = useAppStore.getState().closeTab('workspace', 'pane', tab.id)
    await stopStarted.promise
    useAppStore.getState().focusRegion('workspace', tab.id, terminalRegionId)
    releaseRegionClose.resolve()
    await closeRegion
    expect(useAppStore.getState().tabs[tab.id]?.regions[browserRegionId]).toBeUndefined()
    pendingStop.resolve()

    await expect(closeView).resolves.toBe(true)
    expect(useAppStore.getState().tabs[tab.id]).toBeUndefined()
    expect(useAppStore.getState().error).toBeNull()
  })

  it('keeps the Terminal View open when stopping its Run fails', async () => {
    const session = terminalSession('terminal-run')
    const tabId = 'terminal-view'
    const tab = createWorkbenchTab(tabId, {
      regionId: initialWorkbenchRegionId(tabId),
      kind: 'terminal',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: session.id
    })
    useAppStore.setState({
      config,
      activeWorkspaceId: 'workspace',
      sessions: [session],
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('pane', [tab.id]) },
      error: null
    })
    vi.spyOn(api.sessions, 'stop').mockRejectedValue(new Error('stop failed'))

    const closed = await useAppStore.getState().closeTab('workspace', 'pane', tab.id)

    expect(closed).toBe(false)
    expect(useAppStore.getState().tabs[tab.id]).toEqual(tab)
    expect(useAppStore.getState().error).toBe('stop failed')
  })

  it('stops an Agent Run by default when its last Tab View closes', async () => {
    const session = agentSession('agent-run')
    const tabId = 'agent-view'
    const tab = createWorkbenchTab(tabId, {
      regionId: initialWorkbenchRegionId(tabId),
      kind: 'agent',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: session.id
    })
    useAppStore.setState({
      config,
      activeWorkspaceId: 'workspace',
      sessions: [session],
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('pane', [tab.id]) }
    })
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()

    await useAppStore.getState().closeTab('workspace', 'pane', tab.id)

    expect(stop).toHaveBeenCalledWith(session.control)
    expect(useAppStore.getState().tabs[tab.id]).toBeUndefined()
  })

  it('keeps an Agent Session running only when the close action explicitly requests it', async () => {
    const session = agentSession('background-agent')
    const tabId = 'agent-view'
    const tab = createWorkbenchTab(tabId, {
      regionId: initialWorkbenchRegionId(tabId),
      kind: 'agent',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: session.id
    })
    useAppStore.setState({
      config,
      activeWorkspaceId: 'workspace',
      sessions: [session],
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('pane', [tab.id]) }
    })
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()

    await useAppStore.getState().closeTab('workspace', 'pane', tab.id, {
      keepAgentSessions: true
    })

    expect(stop).not.toHaveBeenCalled()
    expect(useAppStore.getState().sessions).toEqual([session])
    expect(useAppStore.getState().tabs[tab.id]).toBeUndefined()
  })

  it('closes a Browser created after its owning Launcher Tab disappeared', async () => {
    const launcher = launcherFixture()
    const pending = deferred<BrowserSnapshot>()
    vi.spyOn(api.browser, 'create').mockImplementation(async () => await pending.promise)
    const close = vi.spyOn(api.browser, 'close').mockResolvedValue()

    const create = useAppStore.getState().createBrowser('pane', {
      tabId: launcher.id,
      regionId: launcher.layout.activeRegionId
    })
    await useAppStore.getState().closeTab('workspace', 'pane', launcher.id)
    pending.resolve({
      id: launcher.layout.activeRegionId,
      navigationId: `${launcher.layout.activeRegionId}:navigation`,
      url: 'about:blank',
      title: 'New Tab',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      viewport: 'responsive' as const,
      profileId: 'default',
      driving: false,
      appLinkPrompt: null,
      error: null
    })
    await create

    expect(close).toHaveBeenCalledWith(launcher.layout.activeRegionId)
    expect(useAppStore.getState().tabs[launcher.id]).toBeUndefined()
  })

  it('accepts queue ownership and retains delivery refusal on that entry', async () => {
    const session = { ...agentSession('agent-run'), promptSubmissionPredecessor: null }
    vi.spyOn(api.sessions, 'refresh').mockResolvedValue(session)
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.providers, 'list').mockResolvedValue([])
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [session], timelines: {}, recoveryCandidates: [] })
    const dispose = await useAppStore.getState().initialize()
    useAppStore.setState({ sessions: [session], error: null })
    vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(new Error('agent input is not ready'))
    try {

      expect(useAppStore.getState().send(session.id, 'keep this message')).toBe(true)
      await vi.waitFor(() => expect(useAppStore.getState().agentSteerQueues[session.id]).toEqual([
        expect.objectContaining({ text: 'keep this message', status: 'deferred', error: 'agent input is not ready' })
      ]))
      expect(useAppStore.getState().error).toBeNull()
    } finally { dispose() }
  })

  it('strips Electron IPC transport framing from the retained delivery reason', async () => {
    // Everything the main process throws crosses ipcRenderer.invoke, which Electron re-wraps as
    // `Error invoking remote method '<channel>': <name>: <message>` (and drops the original `.code`). The
    // user reported seeing exactly this raw string when steering codex mid-turn. The retained entry must show the
    // message the main process actually raised, not the transport envelope.
    const session = { ...agentSession('agent-run'), promptSubmissionPredecessor: null }
    vi.spyOn(api.sessions, 'refresh').mockResolvedValue(session)
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.providers, 'list').mockResolvedValue([])
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [session], timelines: {}, recoveryCandidates: [] })
    const dispose = await useAppStore.getState().initialize()
    useAppStore.setState({ sessions: [session], error: null })
    vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(new Error(
      "Error invoking remote method 'sessions:submitPrompt': AgentMuxError: " +
      'The prompt was not sent because this Run has no consumable composer readiness yet. ' +
      'The Agent Run is still running; wait for the Stop/screen readiness observation to finish, then send again. ' +
      'If it stays not ready, check the Provider readiness marker or Hook ingress. ' +
      'Diagnostic: runId=run-1 readinessId=readiness-1 readinessSource=native-stop readyThroughByte=pending reason=observation-pending'
    ))
    try {

      expect(useAppStore.getState().send(session.id, 'steer mid-turn')).toBe(true)
      await vi.waitFor(() => expect(useAppStore.getState().agentSteerQueues[session.id]?.[0]?.status).toBe('deferred'))
      expect(useAppStore.getState().error).toBeNull()
      expect(useAppStore.getState().agentSteerQueues[session.id]?.[0]?.error).toBe(
        'The prompt was not sent because this Run has no consumable composer readiness yet. ' +
        'The Agent Run is still running; wait for the Stop/screen readiness observation to finish, then send again. ' +
        'If it stays not ready, check the Provider readiness marker or Hook ingress. ' +
        'Diagnostic: runId=run-1 readinessId=readiness-1 readinessSource=native-stop readyThroughByte=pending reason=observation-pending'
      )
    } finally { dispose() }
  })
})

describe('Warm terminal pool', () => {
  it('promotes a prewarmed terminal into the Launcher without a second spawn', async () => {
    const launcher = launcherFixture()
    const warm = terminalSession('warm-run')
    const launchTerminal = vi.spyOn(api.sessions, 'launchTerminal').mockResolvedValue(warm)
    vi.spyOn(api.sessions, 'refresh').mockResolvedValue(warm)

    useAppStore.getState().prewarmTerminal('workspace', warmOwner)
    expect(launchTerminal).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().sessions).toEqual([])

    await useAppStore.getState().promoteWarmTerminal('pane', {
      tabId: launcher.id,
      regionId: launcher.layout.activeRegionId
    })

    const state = useAppStore.getState()
    const surface = titleWorkbenchSurface(state.tabs[launcher.id]!)
    expect(surface).toMatchObject({ kind: 'terminal', phase: 'attached', sessionId: 'warm-run' })
    expect(state.sessions).toEqual([warm])
    expect(state.unclaimedTerminalSessionIds).toEqual([])
    expect(launchTerminal).toHaveBeenCalledTimes(1)
  })

  it('reuses the same warm terminal when the workspace and cwd are unchanged', () => {
    launcherFixture()
    const launchTerminal = vi.spyOn(api.sessions, 'launchTerminal').mockResolvedValue(terminalSession('warm'))

    useAppStore.getState().prewarmTerminal('workspace', warmOwner)
    useAppStore.getState().prewarmTerminal('workspace', warmOwner)

    expect(launchTerminal).toHaveBeenCalledTimes(1)
  })

  it('retires a replaced workspace shell without losing ownership of its late result', async () => {
    launcherFixture()
    const first = deferred<SessionSnapshot>()
    const firstSession = terminalSession('first-workspace-run')
    const secondSession = {
      ...terminalSession('second-workspace-run'),
      workspacePath: '/other'
    }
    useAppStore.setState({
      config: {
        ...config,
        workspaces: [
          ...config.workspaces,
          { id: 'other', name: 'Other', hostId: 'local', path: '/other', kind: 'folder' }
        ]
      }
    })
    vi.spyOn(api.sessions, 'launchTerminal').mockImplementation(async (input) => (
      input.workspacePath === '/repo' ? await first.promise : secondSession
    ))
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()

    useAppStore.getState().prewarmTerminal('workspace', warmOwner)
    useAppStore.getState().prewarmTerminal('other', warmOwner)
    first.resolve(firstSession)

    await vi.waitFor(() => expect(stop).toHaveBeenCalledWith(firstSession.control))
    await vi.waitFor(() => {
      expect(useAppStore.getState().warmTerminal?.session).toEqual(secondSession)
      expect(useAppStore.getState().unclaimedTerminalSessionIds).toEqual(['second-workspace-run'])
    })
  })

  it('tracks a resolved inline terminal until the user claims it', async () => {
    launcherFixture()
    const warm = terminalSession('warm-run')
    vi.spyOn(api.sessions, 'launchTerminal').mockResolvedValue(warm)

    useAppStore.getState().prewarmTerminal('workspace', warmOwner)
    expect(useAppStore.getState().warmTerminal?.session).toBeNull()

    await useAppStore.getState().warmTerminal?.ready
    await Promise.resolve()

    expect(useAppStore.getState().warmTerminal?.session).toEqual(warm)
    expect(useAppStore.getState().sessions).toEqual([])
    expect(useAppStore.getState().unclaimedTerminalSessionIds).toEqual(['warm-run'])
  })

  it('falls back to a fresh launch when nothing was prewarmed', async () => {
    const launcher = launcherFixture()
    const fresh = terminalSession('fresh-run')
    const launchTerminal = vi.spyOn(api.sessions, 'launchTerminal').mockResolvedValue(fresh)

    await useAppStore.getState().promoteWarmTerminal('pane', {
      tabId: launcher.id,
      regionId: launcher.layout.activeRegionId
    })

    const surface = titleWorkbenchSurface(useAppStore.getState().tabs[launcher.id]!)
    expect(surface).toMatchObject({ kind: 'terminal', sessionId: 'fresh-run' })
    expect(launchTerminal).toHaveBeenCalledTimes(1)
  })

  it('falls back to a fresh launch when the prewarm spawn failed', async () => {
    const launcher = launcherFixture()
    const fresh = terminalSession('fresh-run')
    let call = 0
    const launchTerminal = vi.spyOn(api.sessions, 'launchTerminal').mockImplementation(async () => {
      call += 1
      if (call === 1) throw new Error('warm spawn failed')
      return fresh
    })

    useAppStore.getState().prewarmTerminal('workspace', warmOwner)
    await useAppStore.getState().promoteWarmTerminal('pane', {
      tabId: launcher.id,
      regionId: launcher.layout.activeRegionId
    })

    const surface = titleWorkbenchSurface(useAppStore.getState().tabs[launcher.id]!)
    expect(surface).toMatchObject({ kind: 'terminal', sessionId: 'fresh-run' })
    expect(useAppStore.getState().sessions).toEqual([fresh])
    expect(launchTerminal).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().error).toBeNull()
  })

  it('stops the promoted PTY if the Launcher Region vanished mid-warm', async () => {
    const launcher = launcherFixture()
    const pending = deferred<SessionSnapshot>()
    vi.spyOn(api.sessions, 'launchTerminal').mockImplementation(async () => await pending.promise)
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()

    useAppStore.getState().prewarmTerminal('workspace', warmOwner)
    const promote = useAppStore.getState().promoteWarmTerminal('pane', {
      tabId: launcher.id,
      regionId: launcher.layout.activeRegionId
    })
    await useAppStore.getState().closeTab('workspace', 'pane', launcher.id)
    const warm = terminalSession('warm-run')
    pending.resolve(warm)
    await promote

    expect(stop).toHaveBeenCalledWith(warm.control)
    expect(useAppStore.getState().tabs[launcher.id]).toBeUndefined()
    expect(useAppStore.getState().sessions).toEqual([])
    expect(useAppStore.getState().unclaimedTerminalSessionIds).toEqual([])
  })

  it('stops a warm Terminal that resolves while its Launcher View is closing', async () => {
    const launcher = launcherFixture()
    const tab = addWorkbenchRegion(
      launcher,
      launcher.layout.activeRegionId,
      'right',
      browserSurface('browser-region')
    )
    useAppStore.setState({ tabs: { [tab.id]: tab } })
    const pendingWarm = deferred<SessionSnapshot>()
    const pendingBrowserClose = deferred<void>()
    const browserCloseStarted = deferred<void>()
    vi.spyOn(api.sessions, 'launchTerminal').mockImplementation(async () => await pendingWarm.promise)
    vi.spyOn(api.browser, 'close').mockImplementation(async () => {
      browserCloseStarted.resolve()
      await pendingBrowserClose.promise
    })
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()

    useAppStore.getState().prewarmTerminal('workspace', warmOwner)
    const promote = useAppStore.getState().promoteWarmTerminal('pane', {
      tabId: tab.id,
      regionId: launcher.layout.activeRegionId
    })
    const close = useAppStore.getState().closeTab('workspace', 'pane', tab.id)
    await browserCloseStarted.promise
    const warm = terminalSession('warm-run')
    pendingWarm.resolve(warm)
    await promote

    try {
      expect(stop).toHaveBeenCalledWith(warm.control)
      expect(useAppStore.getState().tabs[tab.id]?.regions[launcher.layout.activeRegionId])
        .toMatchObject({ kind: 'terminal', phase: 'launching' })
    } finally { pendingBrowserClose.resolve(); await close }
    await expect(close).resolves.toBe(true)
    expect(useAppStore.getState().tabs[tab.id]).toBeUndefined()
    expect(useAppStore.getState().closingWorkbenchViews).toEqual({})
    expect(useAppStore.getState().warmTerminal).toBeNull()
    expect(useAppStore.getState().unclaimedTerminalSessionIds).toEqual([])
    expect(stop.mock.calls.map(([control]) => control)).toEqual([warm.control])
    expect(useAppStore.getState().layouts.workspace!.groups.flatMap(group => group.tabOrder)).not.toContain(tab.id)
  })

  it('cleans only known unclaimed terminals without expanding Runtime Sessions into Views', async () => {
    const warm = terminalSession('warm-run')
    const visible = agentSession('visible-run')
    useAppStore.setState({
      loading: true,
      restoredWorkbench: null,
      unclaimedTerminalSessionIds: [warm.id]
    })
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({
      sessions: [warm, visible],
      timelines: {},
      recoveryCandidates: []
    })
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()

    const dispose = await useAppStore.getState().initialize()

    const state = useAppStore.getState()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledWith(warm.control)
    expect(state.sessions).toEqual([visible])
    expect(state.unclaimedTerminalSessionIds).toEqual([])
    expect(state.tabs['session:warm-run']).toBeUndefined()
    expect(state.tabs['session:visible-run']).toBeUndefined()
    dispose()
  })

  it('keeps a failed warm-terminal cleanup hidden and recorded for the next startup', async () => {
    const warm = terminalSession('warm-run')
    const visible = agentSession('visible-run')
    useAppStore.setState({
      loading: true,
      restoredWorkbench: null,
      unclaimedTerminalSessionIds: [warm.id]
    })
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({
      sessions: [warm, visible],
      timelines: {},
      recoveryCandidates: []
    })
    vi.spyOn(api.sessions, 'stop').mockRejectedValue(new Error('owner unavailable'))

    const dispose = await useAppStore.getState().initialize()

    const state = useAppStore.getState()
    expect(state.sessions).toEqual([visible])
    expect(state.unclaimedTerminalSessionIds).toEqual([warm.id])
    expect(state.tabs['session:warm-run']).toBeUndefined()
    expect(state.tabs['session:visible-run']).toBeUndefined()
    expect(state.error).toBeNull()
    dispose()
  })
})
