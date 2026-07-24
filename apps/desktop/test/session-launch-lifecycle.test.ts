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
  version: 1,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  agents: {},
  workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }]
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
    tmuxSession: `agentmux-${id}`,
    kind: 'terminal',
    agentId: null,
    hostId: 'local',
    workspacePath: '/repo',
    label: 'Terminal',
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'running', source: 'tmux', observedAt: 1 },
    terminalSnapshot: ''
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
    pending.resolve(terminalSession(sessionId))
    await launch

    expect(stop).toHaveBeenCalledWith(sessionId)
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
