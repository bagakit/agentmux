import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { AppConfig, BrowserSnapshot, SessionSnapshot } from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import type { LauncherWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { useAppStore } from '../src/renderer/src/store.js'

const initialState = useAppStore.getState()

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
  version: 4,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  agents: {},
  workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }
}

function launcherFixture(view: LauncherWorkbenchTab['view'] = 'picker'): LauncherWorkbenchTab {
  const launcher: LauncherWorkbenchTab = {
    id: 'launcher-tab',
    kind: 'launcher',
    workspaceId: 'workspace',
    view
  }
  useAppStore.setState({
    config,
    activeWorkspaceId: 'workspace',
    tabs: { [launcher.id]: launcher },
    layouts: { workspace: createWorkspaceLayout('pane', [launcher.id]) }
  })
  return launcher
}

function terminalSession(id: string): SessionSnapshot {
  return {
    id,
    kind: 'terminal',
    agentId: null,
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

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

describe('Session and Launcher lifecycle ownership', () => {
  it('keeps Launcher view in Store truth across consumers', () => {
    const launcher = launcherFixture()
    useAppStore.getState().setLauncherView(launcher.id, 'agent')
    expect(useAppStore.getState().tabs[launcher.id]).toMatchObject({ kind: 'launcher', view: 'agent' })
    useAppStore.getState().setLauncherView(launcher.id, 'picker')
    expect(useAppStore.getState().tabs[launcher.id]).toMatchObject({ kind: 'launcher', view: 'picker' })
  })

  it('stops a late successful launch without recreating its closed Tab', async () => {
    const launcher = launcherFixture()
    const pending = deferred<SessionSnapshot>()
    vi.spyOn(api.sessions, 'launchTerminal').mockImplementation(async () => await pending.promise)
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()

    const launch = useAppStore.getState().launchTerminal('pane', launcher.id)
    const launchingTab = useAppStore.getState().tabs[launcher.id]
    expect(launchingTab).toMatchObject({ kind: 'terminal', phase: 'launching' })
    const sessionId = launchingTab && (launchingTab.kind === 'terminal' || launchingTab.kind === 'agent')
      ? launchingTab.sessionId
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

    const launch = useAppStore.getState().launchTerminal('pane', launcher.id)
    await useAppStore.getState().closeTab('workspace', 'pane', launcher.id)
    pending.reject(new Error('launch failed'))

    await expect(launch).resolves.toBeUndefined()
    expect(useAppStore.getState().tabs[launcher.id]).toBeUndefined()
    expect(useAppStore.getState().error).toBeNull()
  })

  it('closes one View without stopping a Run shared by another View', async () => {
    const session = terminalSession('shared-run')
    const firstView = {
      id: 'terminal-view-left',
      kind: 'terminal' as const,
      phase: 'attached' as const,
      workspaceId: 'workspace',
      sessionId: session.id
    }
    const secondView = { ...firstView, id: 'terminal-view-right' }
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

  it('closes a Browser created after its owning Launcher Tab disappeared', async () => {
    const launcher = launcherFixture()
    const pending = deferred<BrowserSnapshot>()
    vi.spyOn(api.browser, 'create').mockImplementation(async () => await pending.promise)
    const close = vi.spyOn(api.browser, 'close').mockResolvedValue()

    const create = useAppStore.getState().createBrowser('pane', launcher.id)
    await useAppStore.getState().closeTab('workspace', 'pane', launcher.id)
    pending.resolve({
      id: launcher.id,
      url: 'about:blank',
      title: 'New Tab',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      error: null
    })
    await create

    expect(close).toHaveBeenCalledWith(launcher.id)
    expect(useAppStore.getState().tabs[launcher.id]).toBeUndefined()
  })
})
