import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { AppConfig, AgentSessionRecoveryCandidate } from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import { createWorkbenchTab, initialWorkbenchRegionId } from '../src/renderer/src/lib/workbench-tabs.js'
import { restorePersistedUiState, useAppStore } from '../src/renderer/src/store.js'

const initialState = useAppStore.getState()

const config: AppConfig = {
  version: 7,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [
    { id: 'workspace-a', name: 'A', hostId: 'local', path: '/repo/a', kind: 'folder' },
    { id: 'workspace-b', name: 'B', hostId: 'local', path: '/repo/b', kind: 'folder' }
  ],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

describe('Renderer persistence boundary', () => {
  it('round-trips the active surface and tool presentation fields with Workbench state', () => {
    useAppStore.setState({
      activeWorkspaceId: 'workspace-b',
      mainSurface: 'board',
      projectRailOpen: false,
      toolsOpen: false,
      workspaceTool: 'agents',
      toolDockWidth: 372
    })

    const partialize = useAppStore.persist.getOptions().partialize
    expect(partialize).toBeTypeOf('function')
    const persisted = partialize!(useAppStore.getState()) as Record<string, unknown>
    expect(persisted).toMatchObject({
      activeWorkspaceId: 'workspace-b',
      mainSurface: 'board',
      projectRailOpen: false,
      toolsOpen: false,
      workspaceTool: 'agents',
      toolDockWidth: 372
    })
  })

  it('validates persisted presentation values against current configured Workspaces and enums', () => {
    expect(restorePersistedUiState(config, {
      activeWorkspaceId: 'deleted-workspace',
      mainSurface: 'unknown-surface' as never,
      projectRailOpen: 'yes' as never,
      toolsOpen: 1 as never,
      workspaceTool: 'old-tool' as never,
      toolDockWidth: Number.POSITIVE_INFINITY
    })).toEqual({
      activeWorkspaceId: 'workspace-a',
      mainSurface: 'workbench',
      projectRailOpen: true,
      toolsOpen: true,
      workspaceTool: 'files-branches',
      toolDockWidth: 440
    })
  })

  it('waits for persistence hydration before asking Core for a recovery snapshot', async () => {
    const gate = deferred<void>()
    const hasHydrated = vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(false)
    const rehydrate = vi.spyOn(useAppStore.persist, 'rehydrate').mockReturnValue(gate.promise)
    const configGet = vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.providers, 'list').mockResolvedValue([])
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({
      sessions: [],
      timelines: {},
      recoveryCandidates: []
    })

    const initialized = useAppStore.getState().initialize()
    await Promise.resolve()
    expect(rehydrate).toHaveBeenCalledOnce()
    expect(configGet).not.toHaveBeenCalled()

    gate.resolve()
    const dispose = await initialized
    expect(configGet).toHaveBeenCalledOnce()
    expect(hasHydrated).toHaveBeenCalled()
    dispose()
  })

  it('restores a valid active Workspace and surface instead of forcing the first Workspace', async () => {
    useAppStore.setState({
      loading: true,
      restoredWorkbench: null,
      activeWorkspaceId: 'workspace-b',
      mainSurface: 'board',
      projectRailOpen: false,
      toolsOpen: false,
      workspaceTool: 'agents',
      toolDockWidth: 372
    })
    vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.providers, 'list').mockResolvedValue([])
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({
      sessions: [],
      timelines: {},
      recoveryCandidates: []
    })

    const dispose = await useAppStore.getState().initialize()
    expect(useAppStore.getState()).toMatchObject({
      activeWorkspaceId: 'workspace-b',
      mainSurface: 'board',
      projectRailOpen: false,
      toolsOpen: false,
      workspaceTool: 'agents',
      toolDockWidth: 372
    })
    dispose()
  })

  it('actually runs the restore during initialize, not just alongside it', async () => {
    // The test above seeds values that are ALREADY valid, so "restored them" and "left them alone"
    // produce identical state — deleting the restore from initialize keeps it green. Hydrated state
    // that is INVALID is what separates the two: only a restore that really runs can correct it.
    useAppStore.setState({
      loading: true,
      restoredWorkbench: null,
      activeWorkspaceId: 'deleted-workspace',
      workspaceTool: 'old-tool' as never,
      toolDockWidth: Number.POSITIVE_INFINITY
    })
    vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.providers, 'list').mockResolvedValue([])
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({
      sessions: [],
      timelines: {},
      recoveryCandidates: []
    })

    const dispose = await useAppStore.getState().initialize()
    expect(useAppStore.getState()).toMatchObject({
      // A Workspace that no longer exists cannot stay selected: it addresses nothing.
      activeWorkspaceId: 'workspace-a',
      workspaceTool: 'files-branches',
      toolDockWidth: 440
    })
    dispose()
  })

  it('keeps the saved Workbench visible when the Runtime snapshot is temporarily unavailable', async () => {
    const tab = createWorkbenchTab('snapshot-outage-view', {
      regionId: initialWorkbenchRegionId('snapshot-outage-view'),
      kind: 'agent',
      phase: 'attached',
      workspaceId: 'workspace-a',
      sessionId: 'agent-during-snapshot-outage'
    })
    useAppStore.setState({
      loading: true,
      restoredWorkbench: {
        tabs: { [tab.id]: tab },
        layouts: { 'workspace-a': createWorkspaceLayout('pane', [tab.id]) }
      }
    })
    vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.providers, 'list').mockResolvedValue([])
    vi.spyOn(api.sessions, 'snapshot').mockRejectedValue(new Error('Runtime snapshot timed out'))

    const dispose = await useAppStore.getState().initialize()
    const state = useAppStore.getState()

    expect(state.loading).toBe(false)
    expect(state.config).toEqual(config)
    expect(state.sessions).toEqual([])
    expect(state.tabs[tab.id]).toEqual(tab)
    expect(state.layouts['workspace-a']?.groups[0]?.tabOrder).toEqual([tab.id])
    expect(state.error).toContain('Runtime Session snapshot did not complete: Runtime snapshot timed out')
    expect(state.error).toContain('The saved Workbench remains visible')
    dispose()
  })

  it('keeps existing Sessions usable when the Provider catalog lookup fails', async () => {
    useAppStore.setState({ loading: true, restoredWorkbench: null })
    vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.providers, 'list').mockRejectedValue(new Error('Provider catalog unavailable'))
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({
      sessions: [],
      timelines: {},
      recoveryCandidates: []
    })

    const dispose = await useAppStore.getState().initialize()
    const state = useAppStore.getState()

    expect(state.loading).toBe(false)
    expect(state.config).toEqual(config)
    expect(state.providerCatalog).toEqual([])
    expect(state.error).toContain('Provider catalog lookup did not complete: Provider catalog unavailable')
    expect(state.error).toContain('Existing Sessions remain usable')
    dispose()
  })

  it('does not discard a persisted Region when an automatic recovery call rejects', async () => {
    const sessionId = 'agent-recovery-workflow-outage'
    const tab = createWorkbenchTab('recovery-outage-view', {
      regionId: initialWorkbenchRegionId('recovery-outage-view'),
      kind: 'agent',
      phase: 'attached',
      workspaceId: 'workspace-a',
      sessionId
    })
    const candidate: AgentSessionRecoveryCandidate = {
      agentSessionId: sessionId,
      hostId: 'local',
      workspacePath: '/repo/a',
      providerId: 'codex',
      executorId: 'codex',
      capabilities: {
        terminal: true,
        hookEvents: true,
        timeline: 'streaming',
        permission: 'observe',
        providerResume: true,
        acp: false,
        replyCorrelation: 'none'
      },
      label: 'Codex · recovery outage',
      createdAt: 1,
      updatedAt: 1,
      run: { runId: 'run-recovery-workflow-outage' }
    }
    useAppStore.setState({
      loading: true,
      restoredWorkbench: {
        tabs: { [tab.id]: tab },
        layouts: { 'workspace-a': createWorkspaceLayout('pane', [tab.id]) }
      }
    })
    vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.providers, 'list').mockResolvedValue([])
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({
      sessions: [],
      timelines: {},
      recoveryCandidates: [candidate]
    })
    vi.spyOn(api.sessions, 'recover').mockRejectedValue(new Error('Provider handshake unavailable'))

    const dispose = await useAppStore.getState().initialize()
    const state = useAppStore.getState()

    expect(state.loading).toBe(false)
    expect(state.tabs[tab.id]).toEqual(tab)
    expect(state.layouts['workspace-a']?.groups[0]?.tabOrder).toEqual([tab.id])
    expect(state.error).toContain('Automatic Agent recovery did not complete: Provider handshake unavailable')
    expect(state.error).toContain('The original Region remains visible')
    dispose()
  })
})
