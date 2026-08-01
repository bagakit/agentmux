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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let tick = 0; tick < 200; tick += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('Timed out waiting for the Store operation')
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

  it('persists the file path verbatim while stripping browser page content (url/title/nav)', () => {
    // The Workbench projection persisted under `restoredWorkbench` must carry back the file Regions a
    // user had open — a file Region is only {regionId,kind,workspaceId,path}, has no runtime content,
    // and its very tab id is `file:${workspaceId}:${path}`, so persisting the Region and persisting
    // the path are the same act. This is the fix for「重启后 tab 和分屏没了」: stripping file Regions is
    // what erased whole tabs and collapsed splits. A browser Region is different — it embeds the live
    // BrowserSnapshot (url/title/navigationId), browsing history is a different sensitivity class, and
    // there is no cold-start lifecycle that revives a persisted browser into a usable blank page — so
    // the whole browser Region stays stripped. This guard must redden if a future change re-strips the
    // file path, or starts leaking a browser's url/title/navigationId.
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
    const persisted = partialize!(useAppStore.getState()) as {
      restoredWorkbench: { tabs: Record<string, { regions: Record<string, { kind: string }> }> }
    }
    const serialized = JSON.stringify(persisted.restoredWorkbench)
    // Browser page content must NOT leak — the browser Region is stripped whole.
    expect(serialized).not.toContain('https://secret.example.com/private-path')
    expect(serialized).not.toContain('Secret internal dashboard')
    expect(serialized).not.toContain('nav-1')
    // The file path is now persisted verbatim (this is the reversed decision).
    expect(serialized).toContain('/repo/a/secret/credentials.env')
    // The attached Agent skeleton it legitimately keeps proves the projection ran (rather than the
    // file path surviving from an empty projection): sessionId identity is display state, not content.
    expect(serialized).toContain('agent-keep')
    // Strongest guard: the browser Region is gone entirely, not merely emptied of some fields. Any
    // change that reintroduces a persisted browser Region (with or without its snapshot) reddens here.
    const projectedTab = persisted.restoredWorkbench.tabs[tab.id]!
    const persistedKinds = Object.values(projectedTab.regions).map((region) => region.kind).sort()
    expect(persistedKinds).toEqual(['agent', 'file'])
  })

  it('validates persisted presentation values against current configured Workspaces and enums', () => {
    expect(restorePersistedUiState(config, {
      activeWorkspaceId: 'deleted-workspace',
      mainSurface: 'unknown-surface' as never,
      projectRailOpen: 'yes' as never,
      collapsedProjectGroups: 'all' as never,
      toolsOpen: 1 as never,
      workspaceTool: 'old-tool' as never,
      toolDockWidth: Number.POSITIVE_INFINITY,
      // 换行开关和 projectRailOpen/toolsOpen 走同一条 restoredBoolean 校验，所以同样喂坏值：
      // 只把它加进下面的期望值（不喂坏值）等于只守「它在场」，而它自己那条取值校验无人守。
      editorWordWrap: 'on' as never
    })).toEqual({
      activeWorkspaceId: 'workspace-a',
      mainSurface: 'workbench',
      projectRailOpen: true,
      collapsedProjectGroups: {},
      toolsOpen: true,
      workspaceTool: 'files-branches',
      toolDockWidth: 440,
      editorWordWrap: false
    })
  })

  it('筛掉坏掉的折叠记录，但保住好的那些——一条坏记录不该让整份折叠状态回退', () => {
    // 与这个函数已有的立场一致：缺字段走默认、坏枚举走默认，而不是整体丢弃。逐条筛因此比
    // "有一条不对就全清"更贴近它。
    //
    // 只收恰好是 `true` 的值：写入侧只写 true（折叠集合里"在"就是折叠），读回时放宽会让这个
    // 约定在读写两侧不一致——`false` 被收下之后，那一组就会既"在集合里"又"没被折叠"。
    const restored = restorePersistedUiState(config, {
      collapsedProjectGroups: {
        '["local","/proj/kit"]': true,
        '["local","/proj/other"]': false as never,
        '["local","/proj/third"]': 'yes' as never,
        '': true
      }
    })
    expect(restored.collapsedProjectGroups).toEqual({ '["local","/proj/kit"]': true })
  })

  it('折叠状态进持久化——折起来的分组重开还在', () => {
    // 用户折叠一个不看的分组是个持久意图，不是一次性手势。这条同时钉住它**在** partialize 里：
    // 漏掉它的话每次重启所有分组都弹回展开，而那个 bug 只在重启后才看得见。
    const state = useAppStore.getState()
    useAppStore.setState({ collapsedProjectGroups: { '["local","/proj/kit"]': true } })
    try {
      const partialize = useAppStore.persist.getOptions().partialize
      const persisted = partialize!(useAppStore.getState()) as Record<string, unknown>
      expect(persisted.collapsedProjectGroups).toEqual({ '["local","/proj/kit"]': true })
    } finally {
      useAppStore.setState({ collapsedProjectGroups: state.collapsedProjectGroups })
    }
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

  it('reconciles an unknown Terminal Region when the first post-startup snapshot becomes authoritative', async () => {
    const staleTerminalId = 'terminal-stale-after-restart'
    const tab = createWorkbenchTab('terminal-stale-view', {
      regionId: initialWorkbenchRegionId('terminal-stale-view'),
      kind: 'terminal',
      phase: 'attached',
      workspaceId: 'workspace-a',
      sessionId: staleTerminalId
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
    const currentTerminal = {
      id: 'terminal-current-after-restart',
      kind: 'terminal' as const,
      providerId: null,
      hostId: 'local',
      workspacePath: '/repo/a',
      label: 'Terminal · A',
      createdAt: 2,
      updatedAt: 2,
      processState: 'running' as const,
      status: { state: 'running' as const, source: 'run-process' as const, observedAt: 2 },
      latestOutputBytes: 0,
      control: {
        kind: 'terminal' as const,
        hostId: 'local',
        runId: 'terminal-current-after-restart',
        run: { runId: 'terminal-current-after-restart' }
      }
    }
    const snapshot = vi.spyOn(api.sessions, 'snapshot')
      .mockRejectedValueOnce(new Error('Runtime snapshot timed out'))
      .mockResolvedValue({ sessions: [currentTerminal], timelines: {}, recoveryCandidates: [] })

    const dispose = await useAppStore.getState().initialize()
    await waitFor(() => useAppStore.getState().tabs[tab.id] === undefined)
    expect(snapshot).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().layouts['workspace-a']?.groups[0]?.tabOrder).toEqual([])
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
        timeline: 'streaming',
        permission: 'observe',
        providerResume: true,
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
        timeline: 'streaming',
        permission: 'observe',
        providerResume: true,
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

  it('给恢复出来的文件面装上文档时，不许动用户留下的布局', async () => {
    // 用户报的「重启后 tab 和分屏没了」有两半。第一半是文件面被整面剥掉（持久化侧）；第二半是
    // 布局回来了但没人读那份文档，而 EditorPane 只要 documents[key] 缺失就渲染 unavailable 态——
    // tab 在、点开报「不可用」，看起来像文件坏了。
    //
    // 装文档这件事必须与「打开文件」分开：reduceFileOpened 会 activateTab 并改写 last-active
    // file（点击时正确），若恢复时复用它，多个恢复出的文件面会一个个抢激活位，最后加载完的那个
    // 赢，用户离开时的活动 tab 就被换掉了。所以这里两侧都钉：文档要装上，布局一个字节不许动。
    const filePath = 'src/restored.ts'
    const tabId = `file:workspace-a:${filePath}`
    const otherTabId = `file:workspace-a:src/other.ts`
    const tab = createWorkbenchTab(tabId, {
      regionId: initialWorkbenchRegionId(tabId),
      kind: 'file',
      workspaceId: 'workspace-a',
      path: filePath
    })
    const otherTab = createWorkbenchTab(otherTabId, {
      regionId: initialWorkbenchRegionId(otherTabId),
      kind: 'file',
      workspaceId: 'workspace-a',
      path: 'src/other.ts'
    })
    // 用户离开时活动的是 otherTab；装 tab 的文档不得把活动位抢过去。
    const layout = createWorkspaceLayout('pane', [otherTabId, tabId])
    useAppStore.setState({
      activeWorkspaceId: 'workspace-a',
      config,
      tabs: { [tabId]: tab, [otherTabId]: otherTab },
      layouts: { 'workspace-a': layout }
    })
    const observe = vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
    const read = vi.spyOn(api.files, 'read').mockResolvedValue({
      status: 'read',
      document: { path: filePath, content: 'export const restored = true\n', revision: 'rev-1' }
    })

    await useAppStore.getState().attachPersistedFileDocument('workspace-a', filePath)
    const state = useAppStore.getState()

    // 走的是与点击同一条 api.files seam：observe 之后 read。
    expect(observe).toHaveBeenCalledWith('workspace-a', filePath)
    expect(read).toHaveBeenCalledWith('workspace-a', filePath)
    // 决定 EditorPane 画编辑器还是画 unavailable 的，就是这个 key 上有没有文档。
    expect(state.documents[`workspace-a\0${filePath}`]?.content).toBe('export const restored = true\n')
    // 布局这一侧：活动 tab 仍是用户离开时那个，tab 顺序不变，last-active 没被改写成没人选的文件。
    // 若有人「顺手」把这里改成复用 reduceFileOpened，下面三条会红。
    expect(state.layouts['workspace-a']?.groups[0]?.activeTabId).toBe(otherTabId)
    expect(state.layouts['workspace-a']?.groups[0]?.tabOrder).toEqual([otherTabId, tabId])
    expect(state.lastActiveFileByWorkspace['workspace-a']).toBeUndefined()
    // 文档没有被误标脏——用户什么都没改。
    expect(state.dirtyDocuments[`workspace-a\0${filePath}`]).toBeFalsy()
  })

  it('一个面还没上板时不许装文档——不留没有面的孤儿文档', async () => {
    // reduceDocumentAttached 要求那个 Tab 存在。没有面的文档是不可达状态：没人会显示它、没人会
    // 释放它的 observe，而 disposeClosedFileOwners 是按面枚举来回收的，于是它会一直挂着。
    vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
    vi.spyOn(api.files, 'read').mockResolvedValue({
      status: 'read',
      document: { path: 'src/ghost.ts', content: 'ghost\n', revision: 'rev-1' }
    })
    useAppStore.setState({ activeWorkspaceId: 'workspace-a', config, tabs: {}, layouts: {} })

    await useAppStore.getState().attachPersistedFileDocument('workspace-a', 'src/ghost.ts')

    expect(useAppStore.getState().documents['workspace-a\0src/ghost.ts']).toBeUndefined()
  })

  it('文件在关闭期间被删掉时，不另造一个错误态', async () => {
    // 「关着的时候文件被删了」与「开着的时候文件被删了」是同一件事，走同一条既有失败态
    // （EditorPane 的 unavailable + Reveal 回退到最近存在的祖先）。这里不许多报一个 error。
    const filePath = 'src/gone.ts'
    const tabId = `file:workspace-a:${filePath}`
    const tab = createWorkbenchTab(tabId, {
      regionId: initialWorkbenchRegionId(tabId),
      kind: 'file',
      workspaceId: 'workspace-a',
      path: filePath
    })
    useAppStore.setState({
      activeWorkspaceId: 'workspace-a',
      config,
      error: null,
      tabs: { [tabId]: tab },
      layouts: { 'workspace-a': createWorkspaceLayout('pane', [tabId]) }
    })
    vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
    const unobserve = vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
    vi.spyOn(api.files, 'read').mockResolvedValue({ status: 'deleted' })

    await useAppStore.getState().attachPersistedFileDocument('workspace-a', filePath)
    const state = useAppStore.getState()

    expect(state.documents[`workspace-a\0${filePath}`]).toBeUndefined()
    // observe 必须撤掉，否则一个读不到的文件会永久占着一个 watcher。
    expect(unobserve).toHaveBeenCalledWith('workspace-a', filePath)
    // 原因必须记下来，走的是「打开着的文件被删」那条既有 issue 而不是新造一种：没有它，
    // EditorPane 只能退回通用的「不可用」，「关闭期间被删」与「读失败」长得一模一样，
    // 而且那个面无从知道自己该停止重读。
    expect(state.documentIssues[`workspace-a\0${filePath}`]).toEqual({ kind: 'deleted' })
    // 不刷 startup error：那会在服务窗里多出一条用户已经能从编辑器面里看懂的话。
    expect(state.error).toBeNull()
  })

  it('装载途中文件被改了，装完要补读一次——否则面上是旧内容且不带 changed 标', async () => {
    // 这条钉的是一个只在「读在途」窗口里存在的漏报。watcher 的失效通知会调 refreshDocument，而
    // refreshFileDocument 在 `documents[key]` 还不存在时早退（store.ts:706）——也就是说这个通知
    // 落在了地上。装载路径必须自己认下它：读之前记下失效序号，装好之后发现变了就补读一次。
    //
    // 少了这个调和，面上会稳定停在比磁盘旧一版的内容上，而且**没有** changed 提示；下一次磁盘变动
    // 之前用户不会知道。保存时的 revision 检查确实还会挡住写坏，但那时报的「文件已在磁盘上更改」
    // 说的是用户根本没见过的那次更改——诊断成本远高于此刻多读一次。
    const filePath = 'src/racing.ts'
    const tabId = `file:workspace-a:${filePath}`
    const tab = createWorkbenchTab(tabId, {
      regionId: initialWorkbenchRegionId(tabId),
      kind: 'file',
      workspaceId: 'workspace-a',
      path: filePath
    })
    // 失效序号只有 initialize() 注册的 onInvalidated 回调会 bump（store.ts:1306 是唯一写入点），
    // 所以这里必须真的走一遍 initialize 把那个回调拿到手，不能绕过它自己造一个。
    let invalidate: ((event: { workspaceId: string; path: string }) => void) | null = null
    vi.spyOn(api.files, 'onInvalidated').mockImplementation((handler) => {
      invalidate = handler as typeof invalidate
      return () => {}
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
    expect(invalidate).toBeTypeOf('function')

    useAppStore.setState({
      activeWorkspaceId: 'workspace-a',
      config,
      tabs: { [tabId]: tab },
      layouts: { 'workspace-a': createWorkspaceLayout('pane', [tabId]) }
    })
    vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
    const firstRead = deferred<{ status: 'read'; document: { path: string; content: string; revision: string } }>()
    const reads: Array<'load' | 'refresh'> = []
    vi.spyOn(api.files, 'read').mockImplementation(async () => {
      if (reads.length === 0) {
        reads.push('load')
        return firstRead.promise
      }
      reads.push('refresh')
      return { status: 'read', document: { path: filePath, content: 'fresh from disk\n', revision: 'rev-2' } }
    })

    const loading = useAppStore.getState().attachPersistedFileDocument('workspace-a', filePath)
    // 等第一次读真的发出去，再让 watcher 报变化——这就是那个在途窗口。
    await waitFor(() => reads.length === 1)
    invalidate!({ workspaceId: 'workspace-a', path: filePath })
    firstRead.resolve({
      status: 'read',
      document: { path: filePath, content: 'stale at load time\n', revision: 'rev-1' }
    })
    await loading

    // 补读发生了，而且面上是磁盘上的那一版，不是装载时读到的旧版。
    expect(reads).toEqual(['load', 'refresh'])
    expect(useAppStore.getState().documents[`workspace-a\0${filePath}`]?.content).toBe('fresh from disk\n')
    dispose()
  })

  it('读这一步自己抛（IPC 断了，不是读到了坏结果）也要记下原因', async () => {
    // 三条 read 判决（deleted/directory/error）都会记 issue，唯独 await 本身抛出时曾经只 reportError
    // 就走了。issue 是那个面唯一的停止条件（见下一条用例），所以没有它，这个面会退回通用的
    // 「不可用」，既不告诉用户是 IPC 断了，也不给 Retry 一个已知的失败态去重试。
    const filePath = 'src/ipc-down.ts'
    const tabId = `file:workspace-a:${filePath}`
    const tab = createWorkbenchTab(tabId, {
      regionId: initialWorkbenchRegionId(tabId),
      kind: 'file',
      workspaceId: 'workspace-a',
      path: filePath
    })
    useAppStore.setState({
      activeWorkspaceId: 'workspace-a',
      config,
      tabs: { [tabId]: tab },
      layouts: { 'workspace-a': createWorkspaceLayout('pane', [tabId]) }
    })
    vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
    const unobserve = vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
    const read = vi.spyOn(api.files, 'read').mockRejectedValue(new Error('IPC channel closed'))

    await useAppStore.getState().attachPersistedFileDocument('workspace-a', filePath)
    const state = useAppStore.getState()

    expect(state.documents[`workspace-a\0${filePath}`]).toBeUndefined()
    // 记的是 read-error，与三条判决走同一种 issue——不新造一种失败态。
    expect(state.documentIssues[`workspace-a\0${filePath}`]).toMatchObject({
      kind: 'read-error',
      code: 'WORKSPACE_FILE_READ_FAILED',
      message: 'IPC channel closed'
    })
    // watcher 不许留下：这个路径此刻读不到，占着一个 observe 就是泄漏。
    expect(unobserve).toHaveBeenCalledWith('workspace-a', filePath)
    // 而且既然记下了，它同样构成停止条件：第二次不到 IPC。
    await useAppStore.getState().attachPersistedFileDocument('workspace-a', filePath)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('读失败的原因记下之后，不再对同一个路径重复发读', async () => {
    // EditorPane 的 effect 依赖 document 与 issue 两者。若失败时什么都不记，issue 恒为空、
    // document 恒为空，任何一次依赖变化都会对一个已知读不到的路径再读一遍。这条钉的是
    // 「记下原因」本身构成了停止条件：第二次调用必须在到达 IPC 之前就返回。
    const filePath = 'src/gone-twice.ts'
    const tabId = `file:workspace-a:${filePath}`
    const tab = createWorkbenchTab(tabId, {
      regionId: initialWorkbenchRegionId(tabId),
      kind: 'file',
      workspaceId: 'workspace-a',
      path: filePath
    })
    useAppStore.setState({
      activeWorkspaceId: 'workspace-a',
      config,
      tabs: { [tabId]: tab },
      layouts: { 'workspace-a': createWorkspaceLayout('pane', [tabId]) }
    })
    vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
    vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
    const read = vi.spyOn(api.files, 'read').mockResolvedValue({ status: 'deleted' })

    await useAppStore.getState().attachPersistedFileDocument('workspace-a', filePath)
    expect(read).toHaveBeenCalledTimes(1)
    await useAppStore.getState().attachPersistedFileDocument('workspace-a', filePath)
    // 仍然是 1：第二次没有到达 IPC。
    expect(read).toHaveBeenCalledTimes(1)
  })
})
