import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import {
  AGENTMUX_CONTROL_SCHEMA_VERSION,
  type AgentMuxControlRequest
} from '@agentmux/core'
import type { AgentLaunchResult, AppConfig, SessionSnapshot } from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import {
  addWorkbenchRegion,
  createWorkbenchTab,
  initialWorkbenchRegionId,
  workbenchSurfaces,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs.js'
import { executorDetectionKey, useAppStore } from '../src/renderer/src/store.js'

const initialState = useAppStore.getState()
const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {
    codex: {
      label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true
    }
  },
  workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
}

function agent(id: string): Extract<SessionSnapshot, { kind: 'agent' }> {
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
    label: id,
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  }
}

function terminal(id: string): Extract<SessionSnapshot, { kind: 'terminal' }> {
  return {
    id,
    kind: 'terminal',
    providerId: null,
    hostId: 'local',
    workspacePath: '/repo',
    label: id,
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'terminal', hostId: 'local', runId: id, run: { runId: id } }
  }
}

function fixture(extraSessions: SessionSnapshot[] = []): WorkbenchTab {
  const caller = agent('caller')
  const tab = createWorkbenchTab('tab-caller', {
    regionId: 'region-caller',
    kind: 'agent',
    phase: 'attached',
    workspaceId: 'workspace',
    sessionId: caller.id
  })
  useAppStore.setState({
    config,
    sessions: [caller, ...extraSessions],
    activeWorkspaceId: 'workspace',
    mainSurface: 'workbench',
    tabs: { [tab.id]: tab },
    layouts: { workspace: createWorkspaceLayout('group', [tab.id]) },
    pendingAgentLaunches: {},
    executorDetections: {
      [executorDetectionKey('local', 'codex')]: {
        state: 'ready',
        result: { executorId: 'codex', providerId: 'codex', hostId: 'local', installed: true }
      }
    },
    error: null
  })
  return tab
}

function request<T extends AgentMuxControlRequest>(value: Omit<T, 'schemaVersion' | 'requestId'>): T {
  return {
    schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
    requestId: `request-${value.operation}`,
    ...value
  } as T
}

function launch(session: Extract<SessionSnapshot, { kind: 'agent' }>): AgentLaunchResult {
  return { session, timeline: { agentSessionId: session.id, revision: 0, items: [] } }
}

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

describe('Desktop Control owner', () => {
  it('inspects one Tab with closed Agent, Terminal, Browser, File, and Launcher projections', async () => {
    let tab = fixture([terminal('terminal-run')])
    tab = addWorkbenchRegion(tab, 'region-caller', 'right', {
      regionId: 'region-terminal', kind: 'terminal', phase: 'attached', workspaceId: 'workspace', sessionId: 'terminal-run'
    })
    tab = addWorkbenchRegion(tab, 'region-terminal', 'down', {
      regionId: 'region-browser', kind: 'browser', workspaceId: 'workspace', browserId: 'browser-1',
      id: 'browser-1', url: 'https://example.com', title: 'Example', canGoBack: false, canGoForward: false,
      loading: false, profileId: 'default', viewport: 'responsive', navigationId: 'navigation-1', error: null
    })
    tab = addWorkbenchRegion(tab, 'region-caller', 'down', {
      regionId: 'region-file', kind: 'file', workspaceId: 'workspace', path: '/repo/a.ts'
    })
    tab = addWorkbenchRegion(tab, 'region-file', 'right', {
      regionId: 'region-launcher', kind: 'launcher', workspaceId: 'workspace'
    })
    useAppStore.setState((state) => ({ tabs: { ...state.tabs, [tab.id]: tab } }))

    const result = await useAppStore.getState().executeControl(request({
      operation: 'inspect.tab', target: { kind: 'tab', tabId: tab.id }
    }))

    expect(result.operation).toBe('inspect.tab')
    if (result.operation !== 'inspect.tab') throw new Error('Unexpected result')
    expect(result.tab.regions.map(({ kind }) => kind)).toEqual(['agent', 'file', 'launcher', 'terminal', 'browser'])
    expect(result.tab.regions.find(({ kind }) => kind === 'browser')).not.toHaveProperty('url')
  })

  // 用户原话：「当描述"右边"、"左边"的时候，除了识别 region，也可以去识别 tab」「如果让他去查看的
  // 时候，如果没有 split，tab 应该也要能识别」。判定本身在 directional-addressing.test.ts 里；
  // 这一层证明的是**它真的被接到了 inspect 上**——判定再对，没人调用等于没做。
  it('inspect 把方向邻居一起交给 Agent——分了栏答 Region', async () => {
    let tab = fixture([terminal('terminal-run')])
    tab = addWorkbenchRegion(tab, 'region-caller', 'right', {
      regionId: 'region-terminal', kind: 'terminal', phase: 'attached', workspaceId: 'workspace', sessionId: 'terminal-run'
    })
    useAppStore.setState((state) => ({ tabs: { ...state.tabs, [tab.id]: tab } }))

    const result = await useAppStore.getState().executeControl(request({
      operation: 'inspect.region', target: { kind: 'region', regionId: 'region-caller' }
    }))

    if (result.operation !== 'inspect.region') throw new Error('Unexpected result')
    expect(result.region.neighbors.right).toEqual({ kind: 'region', regionId: 'region-terminal' })
    expect(result.region.neighbors.left).toEqual({ kind: 'none' })
  })

  it('没有分栏时 inspect 的右邻是 Tab 条上那张——这正是用户要补的那件事', async () => {
    const tab = fixture()
    const second = createWorkbenchTab('tab-second', {
      regionId: 'region-second', kind: 'launcher', workspaceId: 'workspace'
    })
    useAppStore.setState((state) => ({
      tabs: { ...state.tabs, [second.id]: second },
      layouts: { workspace: createWorkspaceLayout('group', [tab.id, second.id]) }
    }))

    const result = await useAppStore.getState().executeControl(request({
      operation: 'inspect.region', target: { kind: 'region', regionId: 'region-caller' }
    }))

    if (result.operation !== 'inspect.region') throw new Error('Unexpected result')
    // 只有一格，却仍然答得出右边——退到 Tab 邻接。答 none 就是对着用户看得见的东西说不存在。
    expect(result.region.neighbors.right).toEqual({ kind: 'tab', tabId: 'tab-second' })
    // up/down 对 Tab 不成立：Tab 条是一维水平序列。把 up 折成 prev 这里会红。
    expect(result.region.neighbors.up).toEqual({ kind: 'none' })
    expect(result.region.neighbors.down).toEqual({ kind: 'none' })
  })

  it('inspect.tab 的每一格都带上自己的邻居', async () => {
    let tab = fixture()
    tab = addWorkbenchRegion(tab, 'region-caller', 'down', {
      regionId: 'region-file', kind: 'file', workspaceId: 'workspace', path: '/repo/a.ts'
    })
    useAppStore.setState((state) => ({ tabs: { ...state.tabs, [tab.id]: tab } }))

    const result = await useAppStore.getState().executeControl(request({
      operation: 'inspect.tab', target: { kind: 'tab', tabId: tab.id }
    }))

    if (result.operation !== 'inspect.tab') throw new Error('Unexpected result')
    const byId = new Map(result.tab.regions.map((region) => [region.regionId, region.neighbors]))
    expect(byId.get('region-caller')?.down).toEqual({ kind: 'region', regionId: 'region-file' })
    expect(byId.get('region-file')?.up).toEqual({ kind: 'region', regionId: 'region-caller' })
  })

  it('deduplicates Tab Agent Sessions and returns typed ambiguity candidates', async () => {
    let tab = fixture([agent('reviewer')])
    tab = addWorkbenchRegion(tab, 'region-caller', 'right', {
      regionId: 'region-caller-2', kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: 'caller'
    })
    useAppStore.setState((state) => ({ tabs: { ...state.tabs, [tab.id]: tab } }))
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue()
    await useAppStore.getState().executeControl(request({
      operation: 'send', target: { kind: 'tab', tabId: tab.id }, text: 'continue'
    }))
    expect(submit).toHaveBeenCalledOnce()

    tab = addWorkbenchRegion(tab, 'region-caller-2', 'down', {
      regionId: 'region-reviewer', kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: 'reviewer'
    })
    useAppStore.setState((state) => ({ tabs: { ...state.tabs, [tab.id]: tab } }))
    await expect(useAppStore.getState().executeControl(request({
      operation: 'send', target: { kind: 'tab', tabId: tab.id }, text: 'continue'
    }))).rejects.toMatchObject({
      code: 'MESSAGE_TARGET_NOT_UNIQUE',
      candidates: [
        { agentSessionId: 'caller', regionIds: ['region-caller', 'region-caller-2'] },
        { agentSessionId: 'reviewer', regionIds: ['region-reviewer'] }
      ]
    })
  })

  it('opens Agent, Terminal, and Browser through their owners with exact creation payloads', async () => {
    fixture()
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async (input) => launch(agent(input.agentSessionId!)))
    const launchTerminal = vi.spyOn(api.sessions, 'launchTerminal').mockResolvedValue(terminal('terminal-created'))
    const createBrowser = vi.spyOn(api.browser, 'create').mockImplementation(async (id, url) => ({
      id, url, title: '', canGoBack: false, canGoForward: false, loading: false, profileId: 'default',
      viewport: 'responsive', navigationId: 'navigation-created', error: null
    }))

    const openedAgent = await useAppStore.getState().executeControl(request({
      operation: 'open.agent',
      content: { kind: 'new-agent', executorId: 'codex', prompt: 'write' },
      destination: { kind: 'split', direction: 'right', region: { kind: 'region', regionId: 'region-caller' } }
    }))
    expect(openedAgent.operation).toBe('open.agent')

    const openedTerminal = await useAppStore.getState().executeControl(request({
      operation: 'open.terminal',
      shellCommand: 'pnpm test:fast',
      destination: { kind: 'split', direction: 'down', region: { kind: 'region', regionId: 'region-caller' } }
    }))
    expect(launchTerminal).toHaveBeenCalledWith(expect.objectContaining({
      createOperationId: 'request-open.terminal', shellCommand: 'pnpm test:fast'
    }))

    const openedBrowser = await useAppStore.getState().executeControl(request({
      operation: 'open.browser',
      url: 'https://example.com',
      destination: { kind: 'new-tab', after: { kind: 'tab', tabId: 'tab-caller' } }
    }))
    expect(openedBrowser.operation).toBe('open.browser')
    if (openedBrowser.operation !== 'open.browser') throw new Error('Unexpected result')
    expect(openedBrowser.region.browserId).not.toBe(openedBrowser.region.regionId)
    expect(createBrowser).toHaveBeenCalledWith(openedBrowser.region.browserId, 'https://example.com')
    expect(openedTerminal.operation).toBe('open.terminal')
  })

  it('rejects ambiguous custom Executor labels before launching or changing layout', async () => {
    const tab = fixture()
    useAppStore.setState({ config: {
      ...config,
      executors: {
        first: { ...config.executors.codex!, label: 'Custom' },
        second: { ...config.executors.codex!, label: 'Custom' }
      }
    } })
    const launchAgent = vi.spyOn(api.sessions, 'launchAgent')
    await expect(useAppStore.getState().executeControl(request({
      operation: 'open.agent', content: { kind: 'new-agent', executorId: 'Custom' },
      destination: { kind: 'split', direction: 'right', region: { kind: 'region', regionId: 'region-caller' } }
    }))).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    expect(launchAgent).not.toHaveBeenCalled()
    expect(useAppStore.getState().tabs).toEqual({ [tab.id]: tab })
  })

  it('rolls back only its planned Region and cleans a Browser created after cancellation', async () => {
    const tab = fixture()
    let release!: (value: Awaited<ReturnType<typeof api.browser.create>>) => void
    let requestedBrowserId = ''
    vi.spyOn(api.browser, 'create').mockImplementation(async (id) => {
      requestedBrowserId = id
      return await new Promise((resolve) => { release = resolve })
    })
    const close = vi.spyOn(api.browser, 'close').mockResolvedValue()
    const controller = new AbortController()
    const pending = useAppStore.getState().executeControl(request({
      operation: 'open.browser',
      url: 'https://example.com',
      destination: { kind: 'split', direction: 'right', region: { kind: 'region', regionId: 'region-caller' } }
    }), controller.signal)
    controller.abort(Object.assign(new Error('timed out'), { code: 'CONTROL_TIMEOUT' }))
    release({
      id: requestedBrowserId, url: 'https://example.com', title: '', canGoBack: false, canGoForward: false,
      loading: false, profileId: 'default', viewport: 'responsive', navigationId: 'nav', error: null
    })

    await expect(pending).rejects.toMatchObject({ code: 'CONTROL_TIMEOUT' })
    expect(close).toHaveBeenCalledWith(requestedBrowserId)
    expect(useAppStore.getState().tabs[tab.id]).toEqual(tab)
  })

  it('does not clean up a Browser id that Main create never returned', async () => {
    const tab = fixture()
    vi.spyOn(api.browser, 'create').mockRejectedValue(new Error('Browser owner create failed'))
    const close = vi.spyOn(api.browser, 'close').mockResolvedValue()

    await expect(useAppStore.getState().executeControl(request({
      operation: 'open.browser',
      url: 'https://example.com',
      destination: {
        kind: 'split',
        direction: 'right',
        region: { kind: 'region', regionId: 'region-caller' }
      }
    }))).rejects.toThrow('Browser owner create failed')

    expect(close).not.toHaveBeenCalled()
    expect(useAppStore.getState().tabs[tab.id]).toEqual(tab)
  })

  it('creates requested presets atomically and inserts a new Tab immediately after its anchor', async () => {
    const tab = fixture([agent('target')])
    const arranged = await useAppStore.getState().executeControl(request({
      operation: 'arrange', target: { kind: 'tab', tabId: tab.id }, mode: { kind: 'preset', preset: 'grid-4' }
    }))
    expect(arranged.operation).toBe('arrange')
    if (arranged.operation !== 'arrange') throw new Error('Unexpected result')
    expect(arranged.tab.regions).toHaveLength(4)

    const opened = await useAppStore.getState().executeControl(request({
      operation: 'open.agent',
      content: { kind: 'agent-session', agentSessionId: 'target' },
      destination: { kind: 'new-tab', after: { kind: 'tab', tabId: tab.id } }
    }))
    expect(opened.operation).toBe('open.agent')
    if (opened.operation !== 'open.agent') throw new Error('Unexpected result')
    expect(useAppStore.getState().layouts.workspace?.groups[0]?.tabOrder.slice(0, 2)).toEqual([tab.id, opened.region.tabId])
  })

  // T-004 验收：搬动保持 Region/Session/Run 身份，源删除、目标唯一，且**不调用任何 Runtime lifecycle**。
  // 树代数复用既有的 promoteRegionToTab reducer（promote-region-to-tab.test.ts 钉纯函数那侧），这里钉的是
  // executeControl 这一层真的接了它、身份端到端保住、且这条路上一个 lifecycle 方法都没调。
  it('promotes a Region into its own new Tab, preserves identity, and calls no Runtime lifecycle', async () => {
    let tab = fixture([agent('other')])
    tab = addWorkbenchRegion(tab, 'region-caller', 'right', {
      regionId: 'region-second', kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: 'other'
    })
    useAppStore.setState((state) => ({ tabs: { ...state.tabs, [tab.id]: tab } }))

    // 「移动不调用 Runtime lifecycle」是断言出来的，不是读源码读出来的：搬一格不许起/停/重启底层 Run。
    const launchAgent = vi.spyOn(api.sessions, 'launchAgent')
    const launchTerminal = vi.spyOn(api.sessions, 'launchTerminal')
    const submitPrompt = vi.spyOn(api.sessions, 'submitPrompt')
    const resume = vi.spyOn(api.sessions, 'resume')
    const interrupt = vi.spyOn(api.sessions, 'interrupt')
    const stop = vi.spyOn(api.sessions, 'stop')

    const result = await useAppStore.getState().executeControl(request({
      operation: 'promote.region', target: { kind: 'region', regionId: 'region-second' }
    }))
    expect(result.operation).toBe('promote.region')
    if (result.operation !== 'promote.region') throw new Error('Unexpected result')

    // 身份保住：regionId 原样带去新 Tab（不新铸）。破坏 reducer 让它铸新 id，这条红。
    expect(result.regionId).toBe('region-second')
    expect(result.workspaceId).toBe('workspace')
    // 目标唯一且是**新** Tab（不是源 Tab）。
    expect(result.tabId).not.toBe('tab-caller')

    const state = useAppStore.getState()
    // 源删除：源 Tab 不再含被促升的那格。破坏 reducer 让它把 leaf 留在源树，这条红。
    expect(state.tabs['tab-caller']!.regions['region-second']).toBeUndefined()
    // 目标唯一：新 Tab 恰含且仅含被促升的那格。
    const newTab = state.tabs[result.tabId]!
    expect(Object.keys(newTab.regions)).toEqual(['region-second'])

    // 身份端到端：inspect 回读新坐标，拿到同一个 Agent Session（Run 经同一 agentSessionId 连回）。
    const inspected = await useAppStore.getState().executeControl(request({
      operation: 'inspect.region', target: { kind: 'region', regionId: 'region-second' }
    }))
    if (inspected.operation !== 'inspect.region') throw new Error('Unexpected result')
    expect(inspected.region.kind === 'agent' && inspected.region.agentSessionId).toBe('other')
    expect(inspected.region.tabId).toBe(result.tabId)

    // 一个 Runtime lifecycle 方法都没被调——促升只搬布局投影。
    for (const spy of [launchAgent, launchTerminal, submitPrompt, resume, interrupt, stop]) {
      expect(spy).not.toHaveBeenCalled()
    }
  })

  it('promote.region resolves self to the caller\'s own Region', async () => {
    let tab = fixture()
    tab = addWorkbenchRegion(tab, 'region-caller', 'right', {
      regionId: 'region-second', kind: 'launcher', workspaceId: 'workspace'
    })
    useAppStore.setState((state) => ({ tabs: { ...state.tabs, [tab.id]: tab } }))

    const result = await useAppStore.getState().executeControl(request({
      operation: 'promote.region', target: { kind: 'self' }, caller: { agentSessionId: 'caller' }
    }))
    if (result.operation !== 'promote.region') throw new Error('Unexpected result')
    // self 解析到 caller 自己那格（region-caller），把它促升成新 Tab。
    expect(result.regionId).toBe('region-caller')
    expect(result.tabId).not.toBe('tab-caller')
  })

  it('refuses to promote the only Region of a Tab with a typed error, not a fake success', async () => {
    const tab = fixture()
    // 单格 Tab：促升是 no-op（它已经就是一张 Tab）。绝不把「什么都没做」报成一次成功的移动——
    // 抛 typed CONTROL_FAILED。破坏 reducer 让它对单格也造新 Tab，这条红（本该 reject 却 resolve）。
    await expect(useAppStore.getState().executeControl(request({
      operation: 'promote.region', target: { kind: 'region', regionId: 'region-caller' }
    }))).rejects.toMatchObject({ code: 'CONTROL_FAILED' })
    // 没有凭空多出一张 Tab：输入不动。
    expect(useAppStore.getState().tabs).toEqual({ [tab.id]: tab })
  })
})
