// T-005 of f-25k8f8m9k：身份绑定与重启恢复的 durable 边界。
//
// 两条会静默腐烂的性质，各配一条**被破坏时会红**的测试，都跑在真的收敛 owner 上（渲染层的持久化
// 恢复入口 `useAppStore.initialize` 与运行时成员对齐 reducer `reduceAgentMembershipSnapshot`，两者
// 是同一个「一份快照要不要退役一个 Region」判断的两个出口）：
//
//   1. 空快照 / 恢复路径故障**不清工作面**。空快照分不清「真的没有 Session」与「Core 没就绪 /
//      根目录接错」；这是 AGENTS.md 原则 11 的 class-2/3 典型——我们这段读失败了，Agent 可能好好
//      活着。此时清掉用户的工作面正是被禁止的动作。两条出口都必须 fail-open。
//   2. 新进程按**原 Session 身份**恢复，输入投到它、不投到新铸的身份。恢复出来的 Session 必须保留
//      原 agentSessionId 与原 control（含 run 绑定），渲染层据此把输入送回原 Agent。
//
// 每条都配一处 mutation 说明：破坏该性质会让点名的断言变红（见各 it 内注释）。
//
// 这是渲染/持久化 owner 侧的证据；Core owner 侧（provider-native resume 后仍是原 agentSessionId、
// 输入落到新 Run 而非退役旧 Run）由 packages/core/test/agent-session-continuity.test.ts 的
// 「重启恢复保持原 Session 身份且输入不误投递」一组证明。两侧合起来覆盖 outcome 的两个性质。

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type {
  AppConfig,
  RuntimeSnapshot,
  SessionSnapshot
} from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import {
  createWorkbenchTab,
  initialWorkbenchRegionId,
  workbenchSurfaces
} from '../src/renderer/src/lib/workbench-tabs.js'
import { reduceAgentMembershipSnapshot } from '../src/renderer/src/lib/session-state.js'
import { useAppStore } from '../src/renderer/src/store.js'

const initialState = useAppStore.getState()

const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [
    { id: 'workspace-a', name: 'A', hostId: 'local', path: '/repo/a', kind: 'folder' }
  ],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
}

function agentSession(id: string, runId: string): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    id,
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true,
      timeline: 'complete-events',
      permission: 'observe',
      providerResume: true,
      replyCorrelation: 'none'
    },
    hostId: 'local',
    workspacePath: '/repo/a',
    label: 'Codex',
    createdAt: 1,
    updatedAt: 2,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 2 },
    latestOutputBytes: 0,
    control: {
      kind: 'agent',
      hostId: 'local',
      agentSessionId: id,
      run: { runId }
    }
  }
}

function agentTab(sessionId: string) {
  const tabId = `session:${sessionId}`
  const tab = createWorkbenchTab(tabId, {
    regionId: initialWorkbenchRegionId(tabId),
    kind: 'agent',
    phase: 'attached',
    workspaceId: 'workspace-a',
    sessionId
  })
  return { tabId, tab }
}

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

// ---------------------------------------------------------------------------
// 性质 1：空快照 / 恢复路径故障不清工作面。
// ---------------------------------------------------------------------------
describe('空快照与流程故障不清工作面（T-005 性质 1）', () => {
  it('启动路径：一份空快照下持久化的 Agent Region 原样保留', async () => {
    const sessionId = 'agent-empty-startup'
    const { tabId, tab } = agentTab(sessionId)
    useAppStore.setState({
      loading: true,
      restoredWorkbench: {
        tabs: { [tabId]: tab },
        layouts: { 'workspace-a': createWorkspaceLayout('pane', [tabId]) }
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

    // 承重：Region 与它在 layout 里的位置都还在。删掉 store.ts 空快照守卫（`retainUnknownSessionViews`
    // 那段的空判据）后，restoreTab 会因 session 不在而摘掉这一格，这两条随之变红。
    expect(state.tabs[tabId]).toEqual(tab)
    expect(state.layouts['workspace-a']?.groups[0]?.tabOrder).toEqual([tabId])
    // 且必须响亮告知，而不是静默保留。
    expect(state.error).toContain('returned no Session facts')
    dispose()
  })

  it('运行时成员对齐：空快照不退役仍在跑的 Agent（原样返回）', () => {
    const sessionId = 'agent-empty-resync'
    const { tabId, tab } = agentTab(sessionId)
    const state = {
      sessions: [agentSession(sessionId, 'run-1')],
      timelines: {},
      pendingAgentLaunches: {},
      tabs: { [tabId]: tab },
      layouts: { 'workspace-a': createWorkspaceLayout('pane', [tabId]) },
      viewModes: {}
    }
    const empty: RuntimeSnapshot = { sessions: [], timelines: {}, recoveryCandidates: [] }

    const next = reduceAgentMembershipSnapshot(state, empty, new Set())

    // 承重：不可逆的删除面前 fail-open——整份 state 原样返回。把 session-state.ts:343 的空快照守卫
    // 删掉（让它继续走 removeSessionProjection），这一格连 tab 带 layout 会被摘掉，这三条变红。
    expect(next).toBe(state)
    expect(next.tabs[tabId]).toBeDefined()
    expect(next.layouts['workspace-a']?.groups[0]?.tabOrder).toEqual([tabId])
  })

  it('启动路径：自动恢复调用抛错时（我们这步故障），原 Region 仍可见', async () => {
    const sessionId = 'agent-recovery-failed'
    const { tabId, tab } = agentTab(sessionId)
    useAppStore.setState({
      loading: true,
      restoredWorkbench: {
        tabs: { [tabId]: tab },
        layouts: { 'workspace-a': createWorkspaceLayout('pane', [tabId]) }
      }
    })
    vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.providers, 'list').mockResolvedValue([])
    // 快照点名它为恢复候选（「还在，只是要重连」），但恢复调用本身抛错——这是 class-2：我们这步
    // 失败了，不是 Agent 死了。不能据此删掉用户的 Region。
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({
      sessions: [],
      timelines: {},
      recoveryCandidates: [{
        agentSessionId: sessionId,
        hostId: 'local',
        workspacePath: '/repo/a',
        providerId: 'codex',
        executorId: 'codex',
        capabilities: {
          terminal: true,
          timeline: 'complete-events',
          permission: 'observe',
          providerResume: true,
          replyCorrelation: 'none'
        },
        label: 'Codex',
        createdAt: 1,
        updatedAt: 1,
        run: { runId: 'run-1' }
      }]
    })
    vi.spyOn(api.sessions, 'recover').mockRejectedValue(new Error('Provider handshake unavailable'))

    const dispose = await useAppStore.getState().initialize()
    const state = useAppStore.getState()

    // 承重：Region 保留，且故障被说清（而非静默）。
    expect(state.tabs[tabId]).toEqual(tab)
    expect(state.layouts['workspace-a']?.groups[0]?.tabOrder).toEqual([tabId])
    expect(state.error).toContain('Automatic Agent recovery did not complete: Provider handshake unavailable')
    expect(state.error).toContain('The original Region remains visible')
    dispose()
  })
})

// ---------------------------------------------------------------------------
// 性质 2：新进程按原 Session 身份恢复，输入投到它、不投到新铸身份。
//
// 分工：Core owner 侧证「provider-native resume 后仍是原 agentSessionId、输入落到新 Run 而非退役
// 旧 Run」，并带真 mutation（见 packages/core/test/agent-session-continuity.test.ts 的
// 「重启恢复保持原 Session 身份且输入不误投递」——把 client.ts 的 `...current` 换成铸新 id 会让那
// 两条红）。这里证渲染/重启 owner 侧的对应半：新进程的第一份权威快照到达后，持久化 Region 绑回
// **原身份**，投递用的 control 正是这个原身份——不孤儿化、不改键。
// ---------------------------------------------------------------------------
describe('重启后按原 Session 身份恢复且输入不误投递（T-005 性质 2）', () => {
  it('一份活的快照把持久化 Region 恢复到原 agentSessionId 与原 control（投递身份不漂移）', async () => {
    const sessionId = 'agent-restart-identity'
    const restoredRunId = 'run-after-restart'
    const { tabId, tab } = agentTab(sessionId)
    useAppStore.setState({
      loading: true,
      restoredWorkbench: {
        tabs: { [tabId]: tab },
        layouts: { 'workspace-a': createWorkspaceLayout('pane', [tabId]) }
      }
    })
    vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.providers, 'list').mockResolvedValue([])
    // 新进程的第一份权威快照：同一 agentSessionId 下的一个活着的 Run（重启后 reattach/resume 的结果）。
    const restored = agentSession(sessionId, restoredRunId)
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({
      sessions: [restored],
      timelines: { [sessionId]: { agentSessionId: sessionId, revision: 1, items: [] } },
      recoveryCandidates: []
    })

    const dispose = await useAppStore.getState().initialize()
    const state = useAppStore.getState()

    // 承重：恢复出来的 Session 仍是**原身份**（agentSessionId 未变），绑到重启后的新 Run；持久化
    // Region 依旧挂在这个原身份上。TerminalView 键入走 `api.sessions.write(session.control, data)`，
    // 用的正是这个 control，所以「control 保持原身份」就是「输入投回原 Agent、不投到新铸身份」。
    // 若恢复铸了新 id，权威快照里就没有原 sessionId，下面 find 得到 undefined，Region 也绑不回去——
    // 三条都红。（铸新 id 的生产 owner 是 Core 的 client.ts；那侧的 mutation 证据见 core 测试。）
    const projected = state.sessions.find((session) => session.id === sessionId)
    expect(projected?.control).toMatchObject({
      kind: 'agent',
      agentSessionId: sessionId,
      run: { runId: restoredRunId }
    })
    const surface = workbenchSurfaces(state.tabs[tabId]!).find((s) => s.kind === 'agent')
    expect(surface).toMatchObject({ kind: 'agent', sessionId })
    expect(state.layouts['workspace-a']?.groups[0]?.tabOrder).toEqual([tabId])
    dispose()
  })
})
