import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { AppConfig, AgentSessionRecoveryCandidate, AgentTimelineSnapshot } from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import {
  addWorkbenchRegion,
  createWorkbenchTab,
  initialWorkbenchRegionId
} from '../src/renderer/src/lib/workbench-tabs.js'
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

  it('never persists Core-owned runtime state — no timelines, sessions, or pending launches on disk', () => {
    // acceptance 3 forbids writing PTY / scrollback / PID / Provider transcript. The round-trip test
    // above uses toMatchObject, which only proves the presentation fields are PRESENT — a newly ADDED
    // runtime field slips past it silently. This is the negative guard: seed the store with the exact
    // Core-owned facts (a full Provider transcript lives in `timelines`) and prove the persisted
    // projection carries none of them. Adding `timelines`/`sessions`/`pendingAgentLaunches` to the
    // partialize whitelist must turn this red.
    const timeline: AgentTimelineSnapshot = {
      agentSessionId: 'agent-secret',
      revision: 1,
      items: []
    }
    useAppStore.setState({
      timelines: { 'agent-secret': timeline },
      sessions: [{
        id: 'agent-secret',
        kind: 'agent',
        providerId: 'codex',
        executorId: 'codex',
        hostId: 'local',
        workspacePath: '/repo/a',
        label: 'secret',
        createdAt: 1,
        updatedAt: 1,
        processState: 'running',
        status: { state: 'running', source: 'run-process', observedAt: 1 },
        latestOutputBytes: 4096,
        control: { kind: 'agent', hostId: 'local', agentSessionId: 'agent-secret', run: { runId: 'run-secret' } }
      }],
      pendingAgentLaunches: { 'agent-secret': { events: [], overflowed: false } }
    })

    const partialize = useAppStore.persist.getOptions().partialize
    const persisted = partialize!(useAppStore.getState()) as Record<string, unknown>
    expect(persisted).not.toHaveProperty('timelines')
    expect(persisted).not.toHaveProperty('sessions')
    expect(persisted).not.toHaveProperty('pendingAgentLaunches')
    expect(persisted).not.toHaveProperty('documents')
  })

  it('strips runtime content out of the persisted Workbench projection (browser url/title, file path)', () => {
    // The Workbench projection persisted under `restoredWorkbench` is the other door runtime content
    // could walk through: a browser Region carries its live `url`/`title`, a file Region its `path`.
    // `projectPersistedWorkbench` keeps only attached Session skeletons, so these must not appear. A
    // future surface field or a projection change that leaks them must turn this red.
    const viewId = 'view:leaky'
    const agentRegionId = initialWorkbenchRegionId(viewId)
    let tab = createWorkbenchTab(viewId, {
      regionId: agentRegionId,
      kind: 'agent' as const,
      phase: 'attached' as const,
      workspaceId: 'workspace-a',
      sessionId: 'agent-keep'
    })
    tab = addWorkbenchRegion(tab, agentRegionId, 'right', {
      regionId: 'region-browser',
      kind: 'browser',
      workspaceId: 'workspace-a',
      browserId: 'browser-1',
      id: 'browser-1',
      navigationId: 'nav-1',
      profileId: 'profile-1',
      url: 'https://secret.example.com/private-path',
      title: 'Secret internal dashboard',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      viewport: 'desktop',
      error: null
    })
    tab = addWorkbenchRegion(tab, 'region-browser', 'down', {
      regionId: 'region-file',
      kind: 'file',
      workspaceId: 'workspace-a',
      path: '/repo/a/secret/credentials.env'
    })

    useAppStore.setState({
      tabs: { [tab.id]: tab },
      layouts: { 'workspace-a': createWorkspaceLayout('group', [tab.id]) }
    })

    const partialize = useAppStore.persist.getOptions().partialize
    const persisted = partialize!(useAppStore.getState()) as { restoredWorkbench: unknown }
    const serialized = JSON.stringify(persisted.restoredWorkbench)
    expect(serialized).not.toContain('https://secret.example.com/private-path')
    expect(serialized).not.toContain('Secret internal dashboard')
    expect(serialized).not.toContain('/repo/a/secret/credentials.env')
    // The attached Agent skeleton it legitimately keeps proves the projection ran (rather than the
    // absences coming from an empty projection): sessionId identity is display state, not content.
    expect(serialized).toContain('agent-keep')
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

  it('keeps persisted Agent Regions when an initial snapshot is empty and has no recovery candidates', async () => {
    const sessionId = 'agent-empty-snapshot'
    const tab = createWorkbenchTab('empty-snapshot-view', {
      regionId: initialWorkbenchRegionId('empty-snapshot-view'),
      kind: 'agent',
      phase: 'attached',
      workspaceId: 'workspace-a',
      sessionId
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
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({
      sessions: [],
      timelines: {},
      recoveryCandidates: []
    })

    const dispose = await useAppStore.getState().initialize()
    const state = useAppStore.getState()
    expect(state.tabs[tab.id]).toEqual(tab)
    expect(state.layouts['workspace-a']?.groups[0]?.tabOrder).toEqual([tab.id])
    expect(state.error).toContain('returned no Session facts')
    dispose()
  })

  it('说清一个被退役的 Agent Region 是被关掉了，而不是让它静默消失', async () => {
    // 退役与「不可用/冲突」的差别：后两者留下带 continuity 的错误骨架告诉用户发生了什么，
    // 而 retired 此前两个分支都不进，Region 被删掉且 error 为 null——用户离开时留下的一格，
    // 回来就没了，一个字都没有。删掉 Region 本身是对的（手动 recoverSession 在 retired 时同样
    // removeSessionProjection，空快照守卫也把「显式退役」列为停止保留的正当理由），所以这条
    // 断言不能落在 tabs 缺席上：那在修复前后都成立，检测不到缺失的告知。它必须落在 error 文本上。
    const sessionId = 'agent-retired-candidate'
    const tab = createWorkbenchTab('retired-candidate-view', {
      regionId: initialWorkbenchRegionId('retired-candidate-view'),
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
      label: 'Codex · retired',
      createdAt: 1,
      updatedAt: 1,
      run: { runId: 'run-retired-candidate' }
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
    vi.spyOn(api.sessions, 'recover').mockResolvedValue({ kind: 'retired' })

    const dispose = await useAppStore.getState().initialize()
    const state = useAppStore.getState()

    // 告知这一侧：删掉那条 retired 分支，这两行变红。
    expect(state.error).toContain('was retired')
    expect(state.error).toContain(candidate.label)
    // 不保留这一侧：若有人「顺手」把 retired 也塞进 recoveryFailures 去保住 Region，这行变红——
    // 那会让被明确退役的 Agent 赖着不走，与手动路径矛盾。两侧同时钉住，才不是只守一半。
    expect(state.tabs[tab.id]).toBeUndefined()
    expect(state.loading).toBe(false)
    dispose()
  })
})
