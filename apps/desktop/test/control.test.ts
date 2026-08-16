import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import {
  AGENTMUX_CONTROL_SCHEMA_VERSION,
  type AgentMuxControlRequest,
  type AgentMuxExecutorProbeOutcome
} from '@agentmux/core'
import { BUILT_IN_AGENT_LABELS, BUILT_IN_AGENT_PROVIDER_IDS } from '@agentmux/core/provider-id'
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
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
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
        result: { executorId: 'codex', providerId: 'codex', hostId: 'local', availability: 'available' }
      }
    },
    error: null
  })
  return tab
}

// Omit<Union, K> 只保留联合的**公共**键，会把每个成员各自的 target/content/url 折叠掉——这正是本文件
// 一批「属性不存在于 Omit<...>」错误的根。用分配式 Omit 逐成员剥掉那两个字段，各成员的专有键得以保留。
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
function request<T extends AgentMuxControlRequest>(value: DistributiveOmit<T, 'schemaVersion' | 'requestId'>): T {
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
      loading: false, profileId: 'default', viewport: 'responsive', navigationId: 'navigation-1', error: null,
      driving: false,
      appLinkPrompt: null
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
      operation: 'send', target: { kind: 'tab', tabId: tab.id }, text: 'continue', caller: { agentSessionId: 'caller' }
    }))
    expect(submit).toHaveBeenCalledExactlyOnceWith(agent('caller').control, 'continue', expect.any(String), 'caller')

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

  // T-002 身份关联 + 环境安全：新开的 Agent Region 与它的 Session（agentSessionId）、Run（runId）、
  // Workspace（workspaceId）靠共享标识连起来，且发现面上不出现任何环境变量的值。能力从 providerId
  // 经 registry 派生，不内联在 Region 上（保持一处 SSOT）。
  it('joins a new agent Region to its Run, Workspace, and session by shared identity without leaking env', async () => {
    fixture()
    useAppStore.setState({ config: {
      ...config,
      executors: { codex: { ...config.executors.codex!, env: { CODEX_TOKEN: 'sk-region-secret' } } }
    } })
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async (input) => launch(agent(input.agentSessionId!)))

    const opened = await useAppStore.getState().executeControl(request({
      operation: 'open.agent',
      content: { kind: 'new-agent', executorId: 'codex', prompt: 'write' },
      destination: { kind: 'split', direction: 'right', region: { kind: 'region', regionId: 'region-caller' } }
    }))
    if (opened.operation !== 'open.agent') throw new Error('Unexpected result')

    // Region 带着连接键：agentSessionId 连到 Session，workspaceId 连到 destination 的 Workspace。
    const sessionId = opened.region.agentSessionId
    const session = useAppStore.getState().sessions.find((s) => s.id === sessionId)
    expect(session?.kind).toBe('agent')
    expect(opened.region.workspaceId).toBe('workspace')
    // Run 身份经同一个 agentSessionId 连到 Session 的 control.run。
    expect(session?.control.run.runId).toBe(`run-${sessionId}`)

    // inspect.region 用 Region 自己交出的 regionId 回读，拿到同一格——闭环。
    const inspected = await useAppStore.getState().executeControl(request({
      operation: 'inspect.region', target: { kind: 'region', regionId: opened.region.regionId }
    }))
    if (inspected.operation !== 'inspect.region') throw new Error('Unexpected result')
    expect(inspected.region.kind === 'agent' && inspected.region.agentSessionId).toBe(sessionId)

    // 两个发现面（open 回执、inspect 回读）都不含环境变量的值。
    expect(JSON.stringify(opened.region)).not.toContain('sk-region-secret')
    expect(JSON.stringify(inspected.region)).not.toContain('sk-region-secret')
    // Region 不内联 capabilities——能力经 providerId 派生，Region 上只有 providerId 这个连接键。
    expect(opened.region).not.toHaveProperty('capabilities')
    expect(opened.region.providerId).toBe('codex')
  })

  it('opens Agent, Terminal, and Browser through their owners with exact creation payloads', async () => {
    fixture()
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async (input) => launch(agent(input.agentSessionId!)))
    const launchTerminal = vi.spyOn(api.sessions, 'launchTerminal').mockResolvedValue(terminal('terminal-created'))
    const createBrowser = vi.spyOn(api.browser, 'create').mockImplementation(async (id, url) => ({
      id, url, title: '', canGoBack: false, canGoForward: false, loading: false, profileId: 'default',
      viewport: 'responsive', navigationId: 'navigation-created', error: null, driving: false,
      appLinkPrompt: null
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

  // T-002 发现四态：list.agents 按目标 Host 的检查状态区分 unknown / check-failed / missing / available，
  // 并列出每个 executor 的自定义 ID、名称、Provider。四态是四件事，任何两态折成一态都是缺陷——
  // 尤其 check-failed（没查成）绝不能与 missing（确实没装）同形。
  it('list.agents distinguishes all four availability states and lists id/name/provider', async () => {
    fixture()
    // 四台 Host，各把同一个 executor 检查成不同状态；executor 配在各自 Host 上。
    useAppStore.setState({
      config: {
        ...config,
        hosts: [
          { id: 'h-unknown', kind: 'ssh', label: 'A', hostname: 'a' },
          { id: 'h-checkfailed', kind: 'ssh', label: 'B', hostname: 'b' },
          { id: 'h-missing', kind: 'ssh', label: 'C', hostname: 'c' },
          { id: 'h-available', kind: 'ssh', label: 'D', hostname: 'd' }
        ],
        executors: {
          'e-unknown': { ...config.executors.codex!, label: 'Unknown One', providerId: 'codex' },
          'e-checkfailed': { ...config.executors.codex!, label: 'Degraded One', providerId: 'claude' },
          'e-missing': { ...config.executors.codex!, label: 'Absent One', providerId: 'gemini' },
          'e-available': { ...config.executors.codex!, label: 'Ready One', providerId: 'grok' }
        },
        workspaces: [
          { id: 'w1', name: 'P1', hostId: 'h-unknown', path: '/r1', kind: 'folder' },
          { id: 'w2', name: 'P2', hostId: 'h-checkfailed', path: '/r2', kind: 'folder' },
          { id: 'w3', name: 'P3', hostId: 'h-missing', path: '/r3', kind: 'folder' },
          { id: 'w4', name: 'P4', hostId: 'h-available', path: '/r4', kind: 'folder' }
        ]
      },
      executorDetections: {
        // h-unknown: 正在查（checking）→ unknown。用 checking 而不是「键缺席」，以钉住
        // 「正在查」也必须归 unknown、绝不提前显示成 available/missing。
        [executorDetectionKey('h-unknown', 'e-unknown')]: { state: 'checking' },
        [executorDetectionKey('h-checkfailed', 'e-checkfailed')]: { state: 'error', detail: 'PATH degraded' },
        [executorDetectionKey('h-missing', 'e-missing')]: { state: 'missing' },
        [executorDetectionKey('h-available', 'e-available')]: {
          state: 'ready',
          result: { executorId: 'e-available', providerId: 'grok', hostId: 'h-available', availability: 'available' }
        }
      }
    })

    const result = await useAppStore.getState().executeControl(request({ operation: 'list.agents' }))
    if (result.operation !== 'list.agents') throw new Error('Unexpected result')
    const byId = new Map(result.agents.map((a) => [a.executorId, a]))
    // 四态各归各位——把映射里任意两态折成一处（如 error→missing、checking→available）都会打破某一行。
    expect(byId.get('e-unknown')?.availability).toBe('unknown')
    expect(byId.get('e-checkfailed')?.availability).toBe('check-failed')
    expect(byId.get('e-missing')?.availability).toBe('missing')
    expect(byId.get('e-available')?.availability).toBe('available')
    // 钉住投影的**基数**：上面四句各查一个 id，对「多出一个 Agent」「同一个 Executor 被投影两次」
    // 全部失明——join/dedup 改坏时它们照样绿。这一条守的是那件另外的事。
    // （不写 `new Set(availability).size === 4`：availability 是四成员闭合联合，上面四句已各钉一个
    // 不同字面量，那条恒真，属于「被蕴含的断言排在最后＝永不执行」。）
    expect(result.agents).toHaveLength(4)
    // 列出自定义 ID、名称、Provider（身份三件套）。
    expect(byId.get('e-available')).toMatchObject({ executorId: 'e-available', label: 'Ready One', providerId: 'grok' })
  })

  // T-002 多 Host 归并：同一个 executor 配在多台 Host 上、各查成不同状态时，list.agents 的扁平表按
  // 「最可用/最有信息量」归并（available > missing > check-failed > unknown）。钉住 reduce 的排序方向——
  // 把 rank 反过来（如让 check-failed 压过 available）必打红此用例。
  it('list.agents merges a multi-host executor to its most-available state', async () => {
    fixture()
    useAppStore.setState({
      config: {
        ...config,
        hosts: [
          { id: 'h1', kind: 'ssh', label: 'H1', hostname: 'h1' },
          { id: 'h2', kind: 'ssh', label: 'H2', hostname: 'h2' }
        ],
        executors: {
          'e-up': { ...config.executors.codex!, label: 'Up Somewhere', providerId: 'codex' },
          'e-blind': { ...config.executors.codex!, label: 'Blind Somewhere', providerId: 'gemini' }
        },
        workspaces: [
          { id: 'w1', name: 'P1', hostId: 'h1', path: '/r1', kind: 'folder' },
          { id: 'w2', name: 'P2', hostId: 'h2', path: '/r2', kind: 'folder' }
        ]
      },
      executorDetections: {
        // e-up：h1 缺失、h2 就绪 → 归并到 available（有一台装了就算可用）。
        [executorDetectionKey('h1', 'e-up')]: { state: 'missing' },
        [executorDetectionKey('h2', 'e-up')]: {
          state: 'ready',
          result: { executorId: 'e-up', providerId: 'codex', hostId: 'h2', availability: 'available' }
        },
        // e-blind：h1 没查成（error）、h2 正在查（checking）→ 都不是「确定没装」，归并到最有信息量的
        // check-failed，绝不能塌成 missing。
        [executorDetectionKey('h1', 'e-blind')]: { state: 'error', detail: 'PATH degraded' },
        [executorDetectionKey('h2', 'e-blind')]: { state: 'checking' }
      }
    })

    const result = await useAppStore.getState().executeControl(request({ operation: 'list.agents' }))
    if (result.operation !== 'list.agents') throw new Error('Unexpected result')
    const byId = new Map(result.agents.map((a) => [a.executorId, a]))
    expect(byId.get('e-up')?.availability).toBe('available')
    expect(byId.get('e-blind')?.availability).toBe('check-failed')
  })

  // 探测结局 → store 检查状态的**正向**映射。上面两条钉的是反向（store 状态 → list.agents 的四态），
  // 它们不经过 detectExecutors，所以把这一格改坏它们全绿：审计把 check-failed 这一格从 'error' 折成
  // 'missing'，control.test.ts 20/20 仍全绿——而这一格恰恰就是三态探测存在的全部理由。
  // 「没查成」和「确实没装」在界面上是两句话（"Check failed" / "Not installed"），也是两种下一步动作，
  // 任何把二者折成一处的改动必须在这里红。
  it('detectExecutors maps each probe outcome to its own check state, keeping check-failed off missing', async () => {
    fixture()
    const outcomes: Record<string, AgentMuxExecutorProbeOutcome> = {
      'e-available': 'available',
      'e-missing': 'missing',
      'e-blind': 'check-failed'
    }
    useAppStore.setState({
      config: {
        ...config,
        executors: Object.fromEntries(
          Object.keys(outcomes).map((executorId) => [executorId, { ...config.executors.codex!, label: executorId }])
        )
      },
      // fixture() 留下的 codex 记录落在**不被读到**的键上（本例的 executor 换成了另外三个），所以它
      // 不会混淆下面的读取。清空是防御性卫生，不是本例成立的前提——写清楚，免得下一个人以为这一行
      // 承重而不敢动。
      executorDetections: {}
    })
    vi.spyOn(api.executors, 'detect').mockImplementation(async (executorId, hostId) => ({
      executorId, providerId: 'codex', hostId, availability: outcomes[executorId]!
    }))

    await useAppStore.getState().detectExecutors('local')

    const stateOf = (executorId: string): string | undefined =>
      useAppStore.getState().executorDetections[executorDetectionKey('local', executorId)]?.state
    expect(stateOf('e-available')).toBe('ready')
    expect(stateOf('e-missing')).toBe('missing')
    expect(stateOf('e-blind')).toBe('error')
    // 这里刻意**不**补一条 `new Set(...).size === 3`。上面三句要的就是三个两两不同的字面量：三句全过时
    // 集合必然是 3，三句里有一句不过时测试已经红在那一句上——那条断言没有任何变异能让它先红，是证明形状
    // 而不是证明（同族：subsuming-assertion-placed-last-never-runs）。
    // 原始结局一并留在格子里：界面文案可以塌，诊断依据不许丢。
    expect(useAppStore.getState().executorDetections[executorDetectionKey('local', 'e-blind')]?.result)
      .toMatchObject({ availability: 'check-failed' })
  })

  // 异步落点回执：启动是异步的，从 planControlOpen 造出 plan.tabId 到 launch 完成之间，用户可能把那一格
  // 搬到别的 Tab。此刻若照 plan.tabId 生成回执，就把**旧坐标**交回给发起方——调用方拿它去 focus/inspect
  // 会落到错误的 Tab。589ab7bf 只补了 agent 那条路；terminal 那条是同一个判断的第二份拷贝，两道 owner
  // 闸都只认 surface 身份，没有一道比较过 Tab id，于是照旧返回旧的。现在两条路共用 resolveSpatialCommit：
  // 这条用例驱动的是 **terminal**（被漏掉的那半）。
  //
  // 触发器用**右键促升**（`promoteRegionToTab`，纯布局代数）而不是 `promote.region` 控制请求：后者要先把
  // 这一格投影成 Control 面，而启动中的 Region 没有稳定投影，会先一步以 CONTROL_OWNER_LOST 拒掉——够不到
  // 这里要测的竞态。用户右键那条路没有这道闸，正是现实里真能把在途的一格搬走的那条。
  it('open.terminal reports the Region current Tab when the user moves it mid-launch', async () => {
    const tab = fixture()
    let release!: (value: Extract<SessionSnapshot, { kind: 'terminal' }>) => void
    vi.spyOn(api.sessions, 'launchTerminal').mockReturnValue(
      new Promise((resolve) => { release = resolve })
    )

    const opening = useAppStore.getState().executeControl(request({
      operation: 'open.terminal',
      destination: { kind: 'split', direction: 'down', region: { kind: 'region', regionId: 'region-caller' } }
    }))
    // launch 在途：新格已就位（launcher 相），session 还没回来。把它促升成自己的 Tab。
    const planned = Object.values(useAppStore.getState().tabs).find((candidate) => candidate.id === tab.id)!
    const movedRegionId = workbenchSurfaces(planned).find((surface) => surface.regionId !== 'region-caller')!.regionId
    useAppStore.getState().promoteRegionToTab('workspace', planned.id, movedRegionId)
    const promotedTabId = Object.values(useAppStore.getState().tabs)
      .find((candidate) => workbenchSurfaces(candidate).some((surface) => surface.regionId === movedRegionId))!.id
    expect(promotedTabId).not.toBe(planned.id)

    release(terminal('terminal-created'))
    const opened = await opening
    if (opened.operation !== 'open.terminal') throw new Error('Unexpected result')
    // 回执必须指向它**现在**所在的 Tab，不是计划里的那个。
    expect(opened.region.tabId).toBe(promotedTabId)
    expect(opened.region.regionId).toBe(movedRegionId)
  })

  // 同一件事的 agent 那一半。589ab7bf 修的正是这条（回执从 plan.tabId 改成实际落点），但它当时**没有
  // 留下任何判据**——那个提交里唯一的新用例讲的是「重名 Executor 要在启动前拒掉」，与落点无关。我实测
  // 过：把 agent 这条路改回 `plan.tabId`，在补这条用例之前 22 条全绿。修复入库、守卫留在工作树之外，
  // 是本仓反复出现的一族（memory fix-committed-guard-left-behind）。两条路现在共用 resolveSpatialCommit，
  // 判据也就该两条都有。
  it('open.agent reports the Region current Tab when the user moves it mid-launch', async () => {
    const tab = fixture()
    let release!: (value: AgentLaunchResult) => void
    let launchedAgentSessionId = ''
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation((input) => {
      launchedAgentSessionId = input.agentSessionId!
      return new Promise((resolve) => { release = resolve })
    })

    const opening = useAppStore.getState().executeControl(request({
      operation: 'open.agent',
      content: { kind: 'new-agent', executorId: 'codex', prompt: 'write' },
      destination: { kind: 'split', direction: 'right', region: { kind: 'region', regionId: 'region-caller' } }
    }))
    await vi.waitFor(() => { if (!launchedAgentSessionId) throw new Error('not launched yet') })
    const movedRegionId = workbenchSurfaces(useAppStore.getState().tabs[tab.id]!)
      .find((surface) => surface.regionId !== 'region-caller')!.regionId
    useAppStore.getState().promoteRegionToTab('workspace', tab.id, movedRegionId)
    const promotedTabId = Object.values(useAppStore.getState().tabs)
      .find((candidate) => workbenchSurfaces(candidate).some((surface) => surface.regionId === movedRegionId))!.id
    expect(promotedTabId).not.toBe(tab.id)

    release(launch(agent(launchedAgentSessionId)))
    const opened = await opening
    if (opened.operation !== 'open.agent') throw new Error('Unexpected result')
    expect(opened.region.tabId).toBe(promotedTabId)
    expect(opened.region.regionId).toBe(movedRegionId)
  })

  // T-002 不暴露环境值：list.agents 的元信息里不许出现任何环境变量的值。
  it('list.agents never leaks an environment variable value', async () => {
    fixture()
    useAppStore.setState({ config: {
      ...config,
      executors: {
        codex: { ...config.executors.codex!, env: { CODEX_TOKEN: 'sk-list-secret' } }
      }
    } })
    const result = await useAppStore.getState().executeControl(request({ operation: 'list.agents' }))
    // 判据落在实际序列化的那份结果上，不是「对象里没有 env 键」——后者会在 env 被塞进内部对象再
    // spread 出来时假绿。
    expect(JSON.stringify(result)).not.toContain('sk-list-secret')
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

  // T-001 (a) 稳定 ID：executorId 恰好是 config.executors 的键，直接按键启动那一个。
  // 关键在**优先级**：让 requested 同时是 executor A 的键、又是 executor B 的唯一名称——精确键必须赢，
  // 否则会解析成 B。这样破坏「精确键优先于名称」时本条才会红（否则 return requested 与键匹配同解，测不出）。
  it('launches a custom Executor by its stable id, and the id wins over a colliding name', async () => {
    fixture()
    useAppStore.setState({ config: {
      ...config,
      executors: {
        // A：键是 'reviewer-1'，名字无关。
        'reviewer-1': { ...config.executors.codex!, label: 'Code Reviewer' },
        // B：名字恰好等于 A 的键。若解析退化成先按名字，requested 'reviewer-1' 会命中 B。
        'other': { ...config.executors.codex!, label: 'reviewer-1' }
      }
    } })
    const launchAgent = vi.spyOn(api.sessions, 'launchAgent')
      .mockImplementation(async (input) => launch(agent(input.agentSessionId!)))

    await useAppStore.getState().executeControl(request({
      operation: 'open.agent', content: { kind: 'new-agent', executorId: 'reviewer-1' },
      destination: { kind: 'split', direction: 'right', region: { kind: 'region', regionId: 'region-caller' } }
    }))
    // 单断言：启动的是键 A，不是同名的 B。破坏精确键优先级 → 解析成 'other'，本条红。
    expect(launchAgent).toHaveBeenCalledWith(expect.objectContaining({ executorId: 'reviewer-1' }))
  })

  // T-001 (a) 唯一名称：executorId 是一个 label（不等于任何键）且全局唯一 → 解析成它的键再启动。
  it('launches a custom Executor by a unique name that is not its id', async () => {
    fixture()
    useAppStore.setState({ config: {
      ...config,
      executors: {
        'exec-7': { ...config.executors.codex!, label: 'Code Reviewer' }
      }
    } })
    const launchAgent = vi.spyOn(api.sessions, 'launchAgent')
      .mockImplementation(async (input) => launch(agent(input.agentSessionId!)))

    await useAppStore.getState().executeControl(request({
      operation: 'open.agent', content: { kind: 'new-agent', executorId: 'Code Reviewer' },
      destination: { kind: 'split', direction: 'right', region: { kind: 'region', regionId: 'region-caller' } }
    }))
    // 单断言：名称被解析成键 'exec-7' 后启动。破坏 resolveExecutorId 的 label 分支（原样返回 requested），
    // 下游 config.executors['Code Reviewer'] 缺失 → 抛 AGENT_EXECUTOR_NOT_CONFIGURED，本条红。
    expect(launchAgent).toHaveBeenCalledWith(expect.objectContaining({ executorId: 'exec-7' }))
  })

  // T-001 (c) 不替换默认 Provider：请求指名一个**内置 providerId 字符串**（它不是任何 executor 键、
  // 也匹配不到任何 executor 的名称）→ 必须拒绝启动，即使有 executor 恰好 backing 着这个内置 Provider。
  // 解析只按「键」或「名称」，绝不按 providerId 猜。Provider id/label 从 SSOT 取，不手写字面量：
  // 某家被改名/删除时这条守卫不会 asserting 陈旧的名字。
  it('never lets a bare built-in Provider id shadow a configured Executor', async () => {
    const requestedProviderId = BUILT_IN_AGENT_PROVIDER_IDS[0]
    // executor 的 label 用**另一家**内置 Provider 的展示名：证明 label 撞上内置名也不构成替换，
    // 且它与 requestedProviderId 不同，排除「碰巧唯一名称命中」这条合法路径的干扰。
    const decoyLabel = BUILT_IN_AGENT_LABELS[BUILT_IN_AGENT_PROVIDER_IDS[1]]
    const tab = fixture()
    useAppStore.setState({ config: {
      ...config,
      executors: {
        // 这个 executor 恰好 backing 着被请求的那个内置 Provider（providerId 相同），却仍不能被
        // 一个裸 providerId 请求命中——命中要靠键或名称，不靠 providerId。
        'my-exec': { ...config.executors.codex!, providerId: requestedProviderId, label: decoyLabel }
      }
    } })
    const launchAgent = vi.spyOn(api.sessions, 'launchAgent')

    // 请求 providerId 本身（非 executor 键，也非任何 label）：既非稳定 ID、也匹配不到唯一名称，
    // resolveExecutorId 原样回传，随后 config.executors[providerId] 缺失 → 拒绝。
    await expect(useAppStore.getState().executeControl(request({
      operation: 'open.agent', content: { kind: 'new-agent', executorId: requestedProviderId },
      destination: { kind: 'split', direction: 'right', region: { kind: 'region', regionId: 'region-caller' } }
    }))).rejects.toMatchObject({ code: 'AGENT_EXECUTOR_NOT_CONFIGURED' })
    // 一个 Provider 字符串匹配不能凭空启动，布局也不能动。破坏点：若 resolveExecutorId 退化成把
    // requested 当 providerId 猜一个 executor，或 open.agent 少了 configured-guard，这里会启动/改布局。
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
      loading: false, profileId: 'default', viewport: 'responsive', navigationId: 'nav', error: null, driving: false,
      appLinkPrompt: null
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
    // 抛 typed REGION_ALREADY_SOLE，而不是笼统的 CONTROL_FAILED：调用方要能把「已经到位」和
    // 「请求不成立」分开，不必去 match 文案。破坏 reducer 让它对单格也造新 Tab，这条红（本该
    // reject 却 resolve）；把这个码退回 CONTROL_FAILED，这条也红。
    await expect(useAppStore.getState().executeControl(request({
      operation: 'promote.region', target: { kind: 'region', regionId: 'region-caller' }
    }))).rejects.toMatchObject({ code: 'REGION_ALREADY_SOLE' })
    // 没有凭空多出一张 Tab：输入不动。
    expect(useAppStore.getState().tabs).toEqual({ [tab.id]: tab })
  })
})
