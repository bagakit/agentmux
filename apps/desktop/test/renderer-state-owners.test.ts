import { describe, expect, it } from 'vitest'
import type { AgentTimelineItem, RuntimeEvent, SessionSnapshot } from '../src/shared/contracts.js'
import { reduceBrowserEvent } from '../src/renderer/src/lib/browser-state.js'
import {
  reduceDocumentContent,
  reduceDocumentWritten,
  reduceFileDelete,
  reduceFileOpened,
  reduceFileRename,
  type FileWorkbenchState,
  reconcileWorkbenchFileProjection
} from '../src/renderer/src/lib/file-workbench-state.js'
import { reduceAgentMembershipSnapshot, reduceRuntimeEvent, reduceTerminalMembershipSnapshot } from '../src/renderer/src/lib/session-state.js'
import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import {
  addWorkbenchRegion,
  createWorkbenchTab,
  documentKey,
  initialWorkbenchRegionId,
  titleWorkbenchSurface,
  workbenchSurfaces
} from '../src/renderer/src/lib/workbench-tabs.js'
import {
  applyWorkbenchViewCloseTopology,
  planWorkbenchViewClose,
  reconcileWorkbenchViewClose
} from '../src/renderer/src/lib/workbench-view-close.js'

const session: SessionSnapshot = {
  id: 'session-1',
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
  workspacePath: '/repo',
  label: 'Codex',
  createdAt: 1,
  updatedAt: 2,
  processState: 'running',
  status: { state: 'running', source: 'run-process', observedAt: 2 },
  latestOutputBytes: 0,
  control: {
    kind: 'agent',
    hostId: 'local',
    agentSessionId: 'session-1',
    run: { runId: 'run-1' }
  }
}

const timelineItem: AgentTimelineItem = {
  id: 'activity-1',
  agentSessionId: session.id,
  kind: 'lifecycle',
  status: 'complete',
  source: 'user',
  createdAt: 2,
  updatedAt: 2,
  title: 'Started'
}

function core(event: RuntimeEvent['event']): RuntimeEvent {
  return { type: 'core', hostId: 'local', event }
}

function sessionTab(tabId: string, phase: 'launching' | 'attached') {
  return createWorkbenchTab(tabId, {
    regionId: initialWorkbenchRegionId(tabId),
    kind: 'agent',
    phase,
    workspaceId: 'workspace-1',
    sessionId: session.id
  })
}

describe('Renderer resource state owners', () => {
  it('keeps terminal output out of the global Session projection', () => {
    const state = {
      sessions: [session],
      timelines: {},
      pendingAgentLaunches: {},
      tabs: {},
      layouts: {},
      viewModes: {}
    }

    const next = reduceRuntimeEvent(state, core({
      type: 'terminal-output',
      agentSessionId: session.id,
      run: session.control.run,
      data: 'Waiting for approval',
      evidence: {
        source: 'terminal-output',
        observedAt: 4,
        run: session.control.run,
        outputByteRange: { startByte: 0, endByte: 20 }
      }
    }))

    expect(next).toBe(state)
  })

  it('does not let a newer Run running event erase semantic Agent status', () => {
    const working = {
      ...session,
      updatedAt: 3,
      status: { state: 'working' as const, source: 'native-hook' as const, observedAt: 3 }
    }
    const state = {
      sessions: [working],
      timelines: {},
      pendingAgentLaunches: {},
      tabs: {},
      layouts: {},
      viewModes: {}
    }

    const next = reduceRuntimeEvent(state, core({
      type: 'process-state',
      agentSessionId: session.id,
      run: session.control.run,
      state: 'running',
      pid: 42,
      evidence: { source: 'run-process', observedAt: 4, run: session.control.run }
    }))

    expect(next.sessions[0]).toMatchObject({
      processState: 'running',
      status: { state: 'working', source: 'native-hook', observedAt: 3 }
    })
  })

  it('does not let a newer Run running event erase an ACP-sourced semantic status', () => {
    // 姊妹用例，钉死守卫的 `|| item.status.source === 'acp'` 那半：ACP agent 的转圈/等待记号
    // 走 status.source === 'acp' 进来，一条更新的 process-state=running 到达时，语义状态必须保住、
    // 不能降级成裸 `running`。single-change 变异：删掉 `|| item.status.source === 'acp'` → 这条红；
    // native-hook 那侧的用例（上一条）此时仍绿，两侧各有独立断言，粗断言吃不掉这里的信号。
    const acpWaiting: SessionSnapshot = {
      ...session,
      updatedAt: 3,
      // 语义态由 ACP 侧观测得来；observedAt=3 严格早于下面 process-state 的 4，确保事件真的被 own 并进入分支。
      status: { state: 'waiting' as const, source: 'acp' as const, observedAt: 3 }
    }
    const state = {
      sessions: [acpWaiting],
      timelines: {},
      pendingAgentLaunches: {},
      tabs: {},
      layouts: {},
      viewModes: {}
    }

    const next = reduceRuntimeEvent(state, core({
      type: 'process-state',
      agentSessionId: session.id,
      run: session.control.run,
      state: 'running',
      pid: 42,
      // 注意 evidence.source 是 run-process：守卫一旦坏掉，status 会被这条覆盖成
      // { state: 'running', source: 'run-process', observedAt: 4 }，与下面的期望字面量三个字段全不同。
      evidence: { source: 'run-process', observedAt: 4, run: session.control.run }
    }))

    // processState 已推进到 running，证明事件确实被 own 并跑进了 process-state 分支（排除「没触碰=看着像保住」的假绿）；
    // 而语义 status 原样保留在 ACP 观测上——期望值锚成写死字面量，不由被测对象算出。
    expect(next.sessions[0]).toMatchObject({
      processState: 'running',
      status: { state: 'waiting', source: 'acp', observedAt: 3 }
    })
  })

  it('projects and clears only Core-owned typed interactions', () => {
    const state = {
      sessions: [session],
      timelines: {},
      pendingAgentLaunches: {},
      tabs: {},
      layouts: {},
      viewModes: {}
    }
    const request = {
      kind: 'permission' as const,
      id: 'permission-1',
      agentSessionId: session.id,
      title: 'Allow command?',
      options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' as const }],
      evidence: {
        source: 'native-hook' as const,
        observedAt: 3,
        run: session.control.run,
        hookReceiptId: 'permission-1'
      }
    }
    const pending = reduceRuntimeEvent(state, core({ type: 'interaction', request }))
    expect(pending.sessions[0]).toMatchObject({ pendingInteraction: request })

    const cleared = reduceRuntimeEvent(pending, core({
      type: 'agent-session',
      session: {
        kind: 'agent',
        agentSessionId: session.id,
        providerId: 'codex',
        executorId: 'codex',
        hostId: 'local',
        workspacePath: '/repo',
        run: session.control.run,
        retiredRuns: [],
        outputCursorBytes: 0,
        createdAt: 1,
        updatedAt: 4,
        semanticStatus: {
          state: 'waiting',
          source: 'native-hook',
          observedAt: 3,
          detail: 'PermissionRequest'
        }
      }
    }))
    expect(cleared.sessions[0]?.pendingInteraction).toBeUndefined()
    expect(cleared.sessions[0]?.status).toMatchObject({ state: 'waiting', source: 'native-hook' })
  })

  it('does not let a stale agent-session republish bounce a decayed status back to working', () => {
    // 衰减把 working→running 时刻意保留了 observedAt（衰减不是新观察）。core 侧那条 semanticStatus 仍
    // 停在 working、observedAt 不变，且会随任意会话变更（终端能力降级、prompt 投递清理等）被反复重发。
    // 若 agent-session reducer 无门禁地套用它，就会把已衰减的 running 按原 observedAt 又贴回 working——
    // 闪一帧。门禁要求严格新于当前观测，这条同 observedAt 的重发必须被跳过。
    const decayed = {
      ...session,
      updatedAt: 5,
      // 衰减后的样子：显示态已是 running，但 observedAt 仍是那次 working 观测的 3。
      status: { state: 'running' as const, source: 'native-hook' as const, observedAt: 3 }
    }
    const state = {
      sessions: [decayed],
      timelines: {},
      pendingAgentLaunches: {},
      tabs: {},
      layouts: {},
      viewModes: {}
    }

    const republished = reduceRuntimeEvent(state, core({
      type: 'agent-session',
      session: {
        kind: 'agent',
        agentSessionId: session.id,
        providerId: session.providerId,
        executorId: session.executorId,
        hostId: session.hostId,
        workspacePath: session.workspacePath,
        run: session.control.run,
        retiredRuns: [],
        outputCursorBytes: 0,
        createdAt: session.createdAt,
        updatedAt: 6,
        // 陈旧的 working——observedAt 不比当前的 3 新，不许把圈重新转起来。
        semanticStatus: { state: 'working', source: 'native-hook', observedAt: 3 }
      }
    }))

    expect(republished.sessions[0]?.status).toMatchObject({ state: 'running', observedAt: 3 })
  })

  it('lets a genuinely newer agent-session semanticStatus relight a decayed agent', () => {
    // 对偶：一条真正的新证据（observedAt 更大）必须照常点亮，证明门禁不是把 agent-session 的
    // semanticStatus 一律封死，只挡「同/更旧 observedAt 的重发」。
    const decayed = {
      ...session,
      updatedAt: 5,
      status: { state: 'running' as const, source: 'native-hook' as const, observedAt: 3 }
    }
    const state = {
      sessions: [decayed],
      timelines: {},
      pendingAgentLaunches: {},
      tabs: {},
      layouts: {},
      viewModes: {}
    }

    const relit = reduceRuntimeEvent(state, core({
      type: 'agent-session',
      session: {
        kind: 'agent',
        agentSessionId: session.id,
        providerId: session.providerId,
        executorId: session.executorId,
        hostId: session.hostId,
        workspacePath: session.workspacePath,
        run: session.control.run,
        retiredRuns: [],
        outputCursorBytes: 0,
        createdAt: session.createdAt,
        updatedAt: 7,
        semanticStatus: { state: 'working', source: 'native-hook', observedAt: 9 }
      }
    }))

    expect(relit.sessions[0]?.status).toMatchObject({ state: 'working', observedAt: 9 })
  })

  it('projects the Core-owned degraded terminal capability and clears it on acknowledgement', () => {
    const state = {
      sessions: [session],
      timelines: {},
      pendingAgentLaunches: {},
      tabs: {},
      layouts: {},
      viewModes: {}
    }
    const capability = {
      state: 'unknown' as const,
      mode: 'degraded' as const,
      reason: 'handshake-timeout' as const,
      run: session.control.run,
      observedAt: 4
    }
    const degraded = reduceRuntimeEvent(state, core({
      type: 'agent-session',
      session: {
        kind: 'agent',
        agentSessionId: session.id,
        providerId: session.providerId,
        executorId: session.executorId,
        hostId: session.hostId,
        workspacePath: session.workspacePath,
        run: session.control.run,
        retiredRuns: [],
        outputCursorBytes: 0,
        createdAt: session.createdAt,
        updatedAt: 4,
        terminalCapability: capability
      }
    }))
    expect(degraded.sessions[0]).toMatchObject({ terminalCapability: capability })

    const acknowledged = reduceRuntimeEvent(degraded, core({
      type: 'agent-session',
      session: {
        kind: 'agent',
        agentSessionId: session.id,
        providerId: session.providerId,
        executorId: session.executorId,
        hostId: session.hostId,
        workspacePath: session.workspacePath,
        run: session.control.run,
        retiredRuns: [],
        outputCursorBytes: 0,
        createdAt: session.createdAt,
        updatedAt: 5,
      }
    }))
    expect(acknowledged.sessions[0]?.terminalCapability).toBeUndefined()
  })

  it('mirrors Core turnUsage: copies a fresh value in, then clears a Core-side clear', () => {
    // fix #1：Core 侧的 turnUsage 覆盖式更新（收尾带就复制、Core 清空就丢弃）必须原样穿过 renderer 的
    // agent-session reducer。两半成对——条件复制把新值带进来，destructure 把陈旧值从 ...current 剔掉。
    const usage = { inputTokens: 11, outputTokens: 22, totalTokens: 33, observedAt: 100 }
    const state = {
      sessions: [session],
      timelines: {},
      pendingAgentLaunches: {},
      tabs: {},
      layouts: {},
      viewModes: {}
    }

    // 防假绿的锚：先让一条带 turnUsage 的 agent-session 快照把值真正复制进去。
    const withUsage = reduceRuntimeEvent(state, core({
      type: 'agent-session',
      session: {
        kind: 'agent',
        agentSessionId: session.id,
        providerId: session.providerId,
        executorId: session.executorId,
        hostId: session.hostId,
        workspacePath: session.workspacePath,
        run: session.control.run,
        retiredRuns: [],
        outputCursorBytes: 0,
        createdAt: session.createdAt,
        updatedAt: 4,
        turnUsage: usage
      }
    }))
    expect(withUsage.sessions[0]?.turnUsage).toEqual(usage)

    // Core 侧清空（读 transcript 失败那一轮）：下一条快照不带 turnUsage，陈旧数字必须从 UI 状态里消失。
    // 若只加条件复制、漏了 destructure，这里会红——上一轮的值会一直挂在「Last turn」下。
    const cleared = reduceRuntimeEvent(withUsage, core({
      type: 'agent-session',
      session: {
        kind: 'agent',
        agentSessionId: session.id,
        providerId: session.providerId,
        executorId: session.executorId,
        hostId: session.hostId,
        workspacePath: session.workspacePath,
        run: session.control.run,
        retiredRuns: [],
        outputCursorBytes: 0,
        createdAt: session.createdAt,
        updatedAt: 5
      }
    }))
    expect(cleared.sessions[0]?.turnUsage).toBeUndefined()
  })

  it('ignores old-Run lifecycle events but accepts committed Session Timeline revisions', () => {
    const tabId = `session:${session.id}`
    const state = {
      sessions: [session],
      timelines: {
        [session.id]: { agentSessionId: session.id, revision: 1, items: [timelineItem] }
      },
      pendingAgentLaunches: {},
      tabs: {
        [tabId]: sessionTab(tabId, 'attached')
      },
      layouts: { 'workspace-1': createWorkspaceLayout('pane', [tabId]) },
      viewModes: { [session.id]: 'activity' as const }
    }
    const staleRun = { runId: 'stale-run' }

    const afterState = reduceRuntimeEvent(state, core({
      type: 'process-state',
      agentSessionId: session.id,
      run: staleRun,
      state: 'exited',
      pid: 99,
      exitCode: 1,
      evidence: { source: 'run-process', observedAt: 10, run: staleRun }
    }))
    const afterTimeline = reduceRuntimeEvent(afterState, core({
      type: 'agent-timeline',
      agentSessionId: session.id,
      revision: 2,
      mutation: {
        type: 'append',
        agentSessionId: session.id,
        item: {
          ...timelineItem,
          id: 'stale-run-item',
          updatedAt: 10,
          createdAt: 10,
          title: 'Stale run'
        }
      },
      evidence: { source: 'native-hook', observedAt: 10, run: staleRun }
    }))
    const afterRemoval = reduceRuntimeEvent(afterTimeline, core({
      type: 'run-removed',
      agentSessionId: session.id,
      run: staleRun,
      evidence: { source: 'user', observedAt: 11, run: staleRun }
    }))

    expect(afterRemoval.sessions[0]).toMatchObject({
      id: session.id,
      processState: 'running',
      control: { run: session.control.run }
    })
    expect(afterRemoval.timelines[session.id]).toMatchObject({
      revision: 2,
      items: [
        timelineItem,
        expect.objectContaining({ id: 'stale-run-item', title: 'Stale run' })
      ]
    })
  })

  it('owns every Runtime Event transition and fully removes Session resources', () => {
    const tabId = `session:${session.id}`
    let state = {
      sessions: [session],
      timelines: {
        [session.id]: { agentSessionId: session.id, revision: 1, items: [timelineItem] }
      },
      pendingAgentLaunches: {},
      tabs: {
        [tabId]: sessionTab(tabId, 'attached')
      },
      layouts: { 'workspace-1': createWorkspaceLayout('pane', [tabId]) },
      viewModes: { [session.id]: 'activity' as const }
    }

    state = reduceRuntimeEvent(state, core({
      type: 'agent-status',
      agentSessionId: session.id,
      state: 'waiting',
      evidence: { source: 'native-hook', observedAt: 3, run: session.control.run }
    }))
    state = reduceRuntimeEvent(state, core({
      type: 'agent-timeline',
      agentSessionId: session.id,
      revision: 2,
      mutation: {
        type: 'append',
        agentSessionId: session.id,
        item: {
          id: 'activity-2',
          agentSessionId: session.id,
          kind: 'assistant_message',
          status: 'streaming',
          source: 'native-hook',
          createdAt: 4,
          updatedAt: 4,
          title: 'Assistant response',
          content: 'Hello'
        }
      },
      evidence: { source: 'native-hook', observedAt: 4, run: session.control.run }
    }))
    expect(state.sessions[0]).toMatchObject({
      status: { state: 'waiting' },
      latestOutputBytes: 0,
      updatedAt: 4
    })
    state = reduceRuntimeEvent(state, core({
      type: 'agent-timeline',
      agentSessionId: session.id,
      revision: 3,
      mutation: {
        type: 'update',
        agentSessionId: session.id,
        itemId: 'activity-2',
        updatedAt: 5,
        status: 'complete',
        content: 'Hello, world'
      },
      evidence: { source: 'native-hook', observedAt: 5, run: session.control.run }
    }))
    expect(state.timelines[session.id]).toMatchObject({ revision: 3 })
    expect(state.timelines[session.id]?.items).toHaveLength(2)
    expect(state.timelines[session.id]?.items[1]).toMatchObject({ content: 'Hello, world', status: 'complete' })

    state = reduceRuntimeEvent(state, core({
      type: 'run-removed',
      agentSessionId: session.id,
      run: session.control.run,
      evidence: { source: 'user', observedAt: 6, run: session.control.run }
    }))
    expect(state.sessions).toEqual([])
    expect(state.timelines[session.id]).toBeUndefined()
    expect(state.tabs[tabId]).toBeUndefined()
    expect(state.layouts['workspace-1']?.groups[0]?.tabOrder).toEqual([])
    expect(state.viewModes[session.id]).toBeUndefined()
  })

  it('removes a launching Tab when Core removes the matching Session', () => {
    const tabId = `session:${session.id}`
    const state = reduceRuntimeEvent({
      sessions: [session],
      timelines: {},
      pendingAgentLaunches: {},
      tabs: {
        [tabId]: sessionTab(tabId, 'launching')
      },
      layouts: { 'workspace-1': createWorkspaceLayout('pane', [tabId]) },
      viewModes: {}
    }, core({
      type: 'run-removed',
      agentSessionId: session.id,
      run: session.control.run,
      evidence: { source: 'user', observedAt: 5, run: session.control.run }
    }))

    expect(state.sessions).toEqual([])
    expect(state.tabs[tabId]).toBeUndefined()
    expect(state.layouts['workspace-1']?.groups[0]?.tabOrder).toEqual([])
  })

  it('owns Browser update and close convergence across Tab and Layout', () => {
    const tabId = 'browser-tab'
    const browserRegionId = initialWorkbenchRegionId(tabId)
    const browserSurface = {
      id: 'browser-1',
      navigationId: 'navigation-1',
      regionId: browserRegionId,
      kind: 'browser' as const,
      workspaceId: 'workspace-1',
      browserId: 'browser-1',
      url: 'about:blank',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      viewport: 'responsive',
      error: null
    }
    const browserTab = createWorkbenchTab(tabId, browserSurface)
    let state = {
      tabs: { [tabId]: browserTab },
      layouts: { 'workspace-1': createWorkspaceLayout('pane', [tabId]) }
    }
    state = reduceBrowserEvent(state, {
      type: 'updated',
      browser: { ...browserSurface, title: 'Docs', url: 'https://example.com/' }
    })
    expect(titleWorkbenchSurface(state.tabs[tabId]!)).toMatchObject({
      title: 'Docs',
      url: 'https://example.com/'
    })

    state = reduceBrowserEvent(state, { type: 'closed', id: 'browser-1' })
    expect(state.tabs[tabId]).toBeUndefined()
    expect(state.layouts['workspace-1']?.groups[0]?.tabOrder).toEqual([])
  })

  it('owns File open, edit, and save transitions without Store side effects', () => {
    const workspaceId = 'workspace-1'
    let state = {
      tabs: {},
      documents: {},
      dirtyDocuments: {},
      documentGenerations: {},
      documentObservationGenerations: {},
      documentIssues: {},
      savingDocuments: {},
      layouts: { [workspaceId]: createWorkspaceLayout('pane') },
      lastActiveFileByWorkspace: {}
    }
    state = reduceFileOpened(
      state,
      workspaceId,
      'src/app.ts',
      { path: 'src/app.ts', content: 'before', revision: 'revision-before' }
    )
    const tabId = `file:${workspaceId}:src/app.ts`
    state = reduceDocumentContent(state, tabId, 'after')
    expect(state.documents[documentKey(workspaceId, 'src/app.ts')]).toEqual({
      path: 'src/app.ts',
      content: 'after',
      revision: 'revision-before'
    })
    expect(state.dirtyDocuments[documentKey(workspaceId, 'src/app.ts')]).toBe(true)

    state = reduceDocumentWritten(state, workspaceId, 'src/app.ts', 1, 'revision-after')
    expect(state.dirtyDocuments[documentKey(workspaceId, 'src/app.ts')]).toBe(false)
    expect(state.documents[documentKey(workspaceId, 'src/app.ts')]?.revision).toBe('revision-after')
    expect(state.layouts[workspaceId]?.groups[0]?.activeTabId).toBe(tabId)

    const plan = planWorkbenchViewClose({
      tabs: state.tabs,
      layouts: state.layouts,
      sessions: [],
      workspaceId,
      tabGroupId: 'pane',
      tabId,
      keepAgentSessions: false
    })!
    const reconciliation = reconcileWorkbenchViewClose({
      plan,
      currentTab: state.tabs[tabId],
      currentSessions: [],
      receipts: []
    })
    state = reconcileWorkbenchFileProjection(
      state,
      applyWorkbenchViewCloseTopology(state, plan, reconciliation.tab)
    )
    expect(state.tabs[tabId]).toBeUndefined()
    expect(state.documents[documentKey(workspaceId, 'src/app.ts')]).toBeUndefined()
    expect(state.dirtyDocuments[documentKey(workspaceId, 'src/app.ts')]).toBeUndefined()
    expect(state.documentGenerations[documentKey(workspaceId, 'src/app.ts')]).toBeUndefined()
    expect(state.documentObservationGenerations[documentKey(workspaceId, 'src/app.ts')]).toBeUndefined()
    expect(state.documentIssues[documentKey(workspaceId, 'src/app.ts')]).toBeUndefined()
    expect(state.savingDocuments[documentKey(workspaceId, 'src/app.ts')]).toBeUndefined()
    expect(state.lastActiveFileByWorkspace[workspaceId]).toBeUndefined()
  })

  it('rekeys and removes File owners in non-title Regions without replacing the View', () => {
    const workspaceId = 'workspace-1'
    const tabId = `file:${workspaceId}:src/title.ts`
    const titleRegionId = initialWorkbenchRegionId(tabId)
    const detailRegionId = 'region:detail'
    const titleTab = createWorkbenchTab(tabId, {
      regionId: titleRegionId,
      kind: 'file',
      workspaceId,
      path: 'src/title.ts'
    })
    const tab = addWorkbenchRegion(titleTab, titleRegionId, 'right', {
      regionId: detailRegionId,
      kind: 'file',
      workspaceId,
      path: 'src/detail/value.ts'
    })
    const detailKey = documentKey(workspaceId, 'src/detail/value.ts')
    const state: FileWorkbenchState = {
      tabs: { [tabId]: tab },
      documents: {
        [documentKey(workspaceId, 'src/title.ts')]: {
          path: 'src/title.ts', content: 'title', revision: 'revision-title'
        },
        [detailKey]: { path: 'src/detail/value.ts', content: 'detail', revision: 'revision-detail' }
      },
      dirtyDocuments: { [detailKey]: true },
      documentGenerations: { [detailKey]: 2 },
      documentObservationGenerations: { [detailKey]: 3 },
      documentIssues: { [detailKey]: { kind: 'deleted' } },
      savingDocuments: { [detailKey]: true },
      layouts: { [workspaceId]: createWorkspaceLayout('pane', [tabId]) },
      lastActiveFileByWorkspace: { [workspaceId]: 'src/detail/value.ts' },
      fileExplorerStates: {
        [workspaceId]: {
          selection: {
            activePath: 'src/detail/value.ts',
            anchorPath: 'src/detail/value.ts',
            selectedPaths: new Set(['src/detail/value.ts', 'src/details.ts'])
          },
          expandedPaths: new Set(['src/detail', 'src/details'])
        }
      }
    }

    const renamed = reduceFileRename(state, workspaceId, 'src/detail', 'src/renamed')
    const renamedKey = documentKey(workspaceId, 'src/renamed/value.ts')
    expect(renamed.tabs[tabId]?.layout).toEqual(tab.layout)
    expect(workbenchSurfaces(renamed.tabs[tabId]!)).toEqual(expect.arrayContaining([
      expect.objectContaining({ regionId: titleRegionId, path: 'src/title.ts' }),
      expect.objectContaining({ regionId: detailRegionId, path: 'src/renamed/value.ts' })
    ]))
    expect(renamed.documents[renamedKey]).toMatchObject({ path: 'src/renamed/value.ts' })
    expect(renamed.documentGenerations[renamedKey]).toBe(2)
    expect(renamed.documentObservationGenerations[renamedKey]).toBe(3)
    expect(renamed.documentIssues[renamedKey]).toEqual({ kind: 'deleted' })
    expect(renamed.savingDocuments[renamedKey]).toBe(false)
    expect(renamed.fileExplorerStates[workspaceId]?.selection).toEqual({
      activePath: 'src/renamed/value.ts',
      anchorPath: 'src/renamed/value.ts',
      selectedPaths: new Set(['src/renamed/value.ts', 'src/details.ts'])
    })
    expect(renamed.fileExplorerStates[workspaceId]?.expandedPaths).toEqual(
      new Set(['src/renamed', 'src/details'])
    )

    const deleted = reduceFileDelete(renamed, workspaceId, 'src/renamed')
    expect(deleted.tabs[tabId]).toBeDefined()
    expect(workbenchSurfaces(deleted.tabs[tabId]!)).toEqual([
      expect.objectContaining({ regionId: titleRegionId, path: 'src/title.ts' })
    ])
    expect(deleted.documents[renamedKey]).toBeUndefined()
    expect(deleted.documentGenerations[renamedKey]).toBeUndefined()
    expect(deleted.documentObservationGenerations[renamedKey]).toBeUndefined()
    expect(deleted.documentIssues[renamedKey]).toBeUndefined()
    expect(deleted.savingDocuments[renamedKey]).toBeUndefined()
    expect(deleted.fileExplorerStates[workspaceId]?.selection).toEqual({
      activePath: 'src/details.ts',
      anchorPath: 'src/details.ts',
      selectedPaths: new Set(['src/details.ts'])
    })
    expect(deleted.fileExplorerStates[workspaceId]?.expandedPaths).toEqual(new Set(['src/details']))
  })

  it('rekeys changed observation payloads without touching prefix-neighbor issues', () => {
    const workspaceId = 'workspace-1'
    const sourcePath = 'src/app/index.ts'
    const neighborPath = 'src/application.ts'
    const sourceKey = documentKey(workspaceId, sourcePath)
    const neighborKey = documentKey(workspaceId, neighborPath)
    const sourceTabId = `file:${workspaceId}:${sourcePath}`
    const sourceTab = createWorkbenchTab(sourceTabId, {
      regionId: initialWorkbenchRegionId(sourceTabId),
      kind: 'file',
      workspaceId,
      path: sourcePath
    })
    const state: FileWorkbenchState = {
      tabs: { [sourceTabId]: sourceTab },
      documents: {
        [sourceKey]: { path: sourcePath, content: 'draft', revision: 'source-revision' },
        [neighborKey]: { path: neighborPath, content: 'neighbor', revision: 'neighbor-revision' }
      },
      dirtyDocuments: { [sourceKey]: true, [neighborKey]: true },
      documentGenerations: {},
      documentObservationGenerations: {},
      documentIssues: {
        [sourceKey]: {
          kind: 'changed',
          observed: { path: sourcePath, content: 'observed', revision: 'observed-revision' }
        },
        [neighborKey]: { kind: 'deleted' }
      },
      savingDocuments: {},
      layouts: { [workspaceId]: createWorkspaceLayout('pane', [sourceTabId]) },
      lastActiveFileByWorkspace: { [workspaceId]: sourcePath },
      fileExplorerStates: {}
    }

    const renamed = reduceFileRename(state, workspaceId, 'src/app', 'src/moved')
    const destinationKey = documentKey(workspaceId, 'src/moved/index.ts')

    expect(renamed.documentIssues[sourceKey]).toBeUndefined()
    expect(renamed.documentIssues[destinationKey]).toEqual({
      kind: 'changed',
      observed: {
        path: 'src/moved/index.ts',
        content: 'observed',
        revision: 'observed-revision'
      }
    })
    expect(renamed.documentIssues[neighborKey]).toBe(state.documentIssues[neighborKey])
    expect(renamed.documents[neighborKey]).toBe(state.documents[neighborKey])
  })
})

/**
 * 运行时的成员对齐。用户报的是「切换走再切换回来, 有些 Region 会消失」——切换本身不删任何 Region
 * （selectWorkspace 只写 activeWorkspaceId，两个保活协调器只读 store），真正的删除发生在后台：一次
 * 成员重整趁用户在别的 Workspace 时异步跑完，切回来才被发现。
 *
 * 启动那条出口早有空快照守卫并配了测试（`store-persistence.test.ts` 的
 * 「keeps persisted Agent Regions when an initial snapshot is empty...」），运行时这条出口此前既没有
 * 守卫也没有测试——被守的那侧有测试，没守的那侧连测试都没有。
 */
describe('运行时成员快照不拿一份空回答退役 Agent', () => {
  /**
   * 一个**真正形状**的恢复候选。
   *
   * 不要拿 `{ ...session }` 当候选用：`SessionSnapshot` 的身份字段是 `id`，而
   * `AgentSessionRecoveryCandidate` 的是 `agentSessionId`（contracts.ts:537）。把 session 摊进候选
   * 位置，得到的对象 `agentSessionId` 是 undefined——它能通过"候选数不为零"这类只看长度的判断，却在
   * 任何按 id 比对的地方都对不上。用这种假候选写出来的测试会看起来覆盖了候选路径，实际一次也没有。
   */
  function recoveryCandidate(agentSessionId: string) {
    return {
      agentSessionId,
      hostId: session.hostId,
      workspacePath: session.workspacePath,
      providerId: 'codex' as const,
      executorId: 'codex' as const,
      capabilities: session.kind === 'agent' ? session.capabilities : undefined!,
      label: session.label,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      run: { runId: 'run-1' }
    }
  }

  /** 一个带 agent 面的 attached tab，加上它在 layout 里的位置。 */
  function seedAttachedAgent() {
    const tabId = `session:${session.id}`
    return {
      tabId,
      state: {
        sessions: [session],
        timelines: {},
        pendingAgentLaunches: {},
        tabs: { [tabId]: sessionTab(tabId, 'attached') },
        layouts: { 'workspace-1': createWorkspaceLayout('pane', [tabId]) },
        viewModes: {}
      }
    }
  }

  const EMPTY = { sessions: [], timelines: {}, recoveryCandidates: [] }

  it('一份空快照不删仍在跑的 Agent Region', () => {
    // 空快照分不清「真的没有 session」与「Core 没就绪 / 根目录接错」。此前它被当作权威，于是一个
    // status 仍是 running 的 agent 连 tab 带 layout 一起被摘掉——用户离开时留下的格子，回来就没了。
    const { tabId, state } = seedAttachedAgent()
    const next = reduceAgentMembershipSnapshot(state, EMPTY, new Set())

    expect(next.sessions.map((item) => item.id)).toEqual([session.id])
    expect(next.tabs[tabId]).toBeDefined()
    expect(next.layouts['workspace-1']?.groups[0]?.tabOrder).toEqual([tabId])
    // 整个 state 原样返回：不可逆的删除面前 fail open，等下一份快照来纠正。
    expect(next).toBe(state)
  })

  it('本地没有 Agent 时空快照原样返回，不凭空造出状态', () => {
    // 守卫的判据只是「这一份快照说不出话」，不再多问一句"本地还记着 agent 吗"：空快照里没有 canonical
    // agent 可合并，那个条件不会改变任何结果。这条守的是空快照下的返回值本身干净——既不删也不加。
    const state = {
      sessions: [],
      timelines: {},
      pendingAgentLaunches: {},
      tabs: {},
      layouts: {},
      viewModes: {}
    }
    expect(reduceAgentMembershipSnapshot(state, EMPTY, new Set())).toBe(state)
  })

  it('说得出别的 session 的快照仍有资格退役一个 Agent', () => {
    // 反向：守卫只挡整份为空的那一种回答。一份带着别的 session 的快照是可信的成员事实，此时"不在
    // 快照里"就是"已经不在了"——这正是这个函数存在的理由，不能被守卫一起挡掉。
    const { tabId, state } = seedAttachedAgent()
    const other: SessionSnapshot = { ...session, id: 'session-2', control: { ...session.control, agentSessionId: 'session-2' } }
    // 快照带 session 就必须带它的 timeline——这是 reducer 自己的不变量，它会对缺项抛错。
    const snapshot = {
      sessions: [other],
      timelines: { 'session-2': { agentSessionId: 'session-2', revision: 1, items: [] } },
      recoveryCandidates: []
    }
    const next = reduceAgentMembershipSnapshot(state, snapshot, new Set())

    expect(next.sessions.map((item) => item.id)).toEqual(['session-2'])
    expect(next.tabs[tabId]).toBeUndefined()
    expect(next.layouts['workspace-1']?.groups[0]?.tabOrder).toEqual([])
  })

  it('只带恢复候选、没有 session 的快照也算说得出话', () => {
    // 恢复候选是「这个 agent 还在，只是要重连」。一份列着候选的快照不是"空"，它有资格谈成员——
    // 守卫因此把候选数也计入，与启动那侧的判据逐字对齐（两处都要求 sessions 与候选同时为空）。
    //
    // 注意这里的候选是**另一个 id**（session-3）：本地的 session-1 既不在 sessions 里、也不是候选，
    // 是真的没了，所以删除正确。「候选点名的就是本地这个 agent」是完全不同的一侧，见下一条——
    // 那一侧此前无人守，而它才是承重的。
    const { tabId, state } = seedAttachedAgent()
    const snapshot = {
      sessions: [],
      timelines: {},
      recoveryCandidates: [recoveryCandidate('session-3')]
    }
    const next = reduceAgentMembershipSnapshot(state, snapshot, new Set())

    expect(next.tabs[tabId]).toBeUndefined()
    expect(next.sessions).toEqual([])
  })

  it('被点名为恢复候选的那个 Agent 自己不许被成员对齐删掉', () => {
    // 这是用户报的「有些 Region 会消失」在运行时那条路上的真身。
    //
    // 一个 run 退出后 Core 不再把它当投影主体，于是它从 snapshot.sessions 里消失、只留在
    // recoveryCandidates 里——也就是说 Core 正在说「这个 agent 可以恢复」。此前 canonicalIds 只
    // 从 sessions 建，候选只参与「整份快照是否为空」，于是任何一次无关的成员 resync（例如另一个
    // 窗口新起了一个 agent 触发 membership gap）都会把这个**恰恰可恢复**的 agent 连 tab 带 layout
    // 摘掉，而 partialize 随后把删剩的投影落盘——不可逆，且不给任何理由。
    //
    // 启动那侧对同一个候选是「保留 + 恢复」（store.ts 的 recoveryFailures/retired 分支），两侧
    // 必须对同一个 Core 概念给出同一个语义。删掉 recoverableIds 那行，这条变红。
    const { tabId, state } = seedAttachedAgent()
    const snapshot = {
      sessions: [],
      timelines: {},
      recoveryCandidates: [recoveryCandidate(session.id)]
    }
    const next = reduceAgentMembershipSnapshot(state, snapshot, new Set())

    expect(next.tabs[tabId]).toBeDefined()
    expect(next.sessions.map((item) => item.id)).toEqual([session.id])
    expect(next.layouts['workspace-1']?.groups[0]?.tabOrder).toEqual([tabId])
  })

  it('候选保护不是"有候选就谁都不删"——同一份快照里的其他陌生 Agent 照删', () => {
    // 上一条的保护必须精确到被点名的那个 id。若写成「快照里有候选就整体 fail open」，一个真的
    // 已经消失的 agent 会永远赖在界面上，而这个函数存在的理由正是收掉它。两条一起钉，才不是
    // 把一个静默删除的 bug 换成一个永不清理的 bug。
    const { tabId, state } = seedAttachedAgent()
    const strangerTabId = 'session:session-9'
    // 注意不能用 sessionTab()：它把 sessionId 写死成 session.id，那样"陌生 tab"其实指着 session-1，
    // 断言就变成了自相矛盾。这里显式造一个真的指向 session-9 的面。
    const seeded = {
      ...state,
      sessions: [...state.sessions, { ...session, id: 'session-9', control: { ...session.control, agentSessionId: 'session-9' } }],
      tabs: {
        ...state.tabs,
        [strangerTabId]: createWorkbenchTab(strangerTabId, {
          regionId: initialWorkbenchRegionId(strangerTabId),
          kind: 'agent',
          phase: 'attached',
          workspaceId: 'workspace-1',
          sessionId: 'session-9'
        })
      }
    }
    const snapshot = {
      sessions: [],
      timelines: {},
      recoveryCandidates: [recoveryCandidate(session.id)]
    }
    const next = reduceAgentMembershipSnapshot(seeded, snapshot, new Set())

    expect(next.tabs[tabId]).toBeDefined()
    expect(next.tabs[strangerTabId]).toBeUndefined()
    expect(next.sessions.map((item) => item.id)).toEqual([session.id])
  })
})

describe('运行时成员快照收敛 Terminal projection', () => {
  const terminal: SessionSnapshot = {
    id: 'terminal-1',
    kind: 'terminal',
    providerId: null,
    hostId: 'local',
    workspacePath: '/repo',
    label: 'Terminal · Project',
    createdAt: 1,
    updatedAt: 2,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 2 },
    latestOutputBytes: 0,
    control: {
      kind: 'terminal',
      hostId: 'local',
      runId: 'terminal-1',
      run: { runId: 'terminal-1' }
    }
  }

  function terminalTab() {
    return createWorkbenchTab('terminal-view', {
      regionId: initialWorkbenchRegionId('terminal-view'),
      kind: 'terminal',
      phase: 'attached',
      workspaceId: 'workspace-1',
      sessionId: terminal.id
    })
  }

  const empty = { sessions: [], timelines: {}, recoveryCandidates: [] }

  it('keeps Agent and Terminal projections when the snapshot is empty', () => {
    const state = {
      sessions: [session, terminal],
      timelines: {},
      pendingAgentLaunches: {},
      tabs: { 'terminal-view': terminalTab() },
      layouts: { 'workspace-1': createWorkspaceLayout('pane', ['terminal-view']) },
      viewModes: {}
    }
    expect(reduceTerminalMembershipSnapshot(state, empty)).toBe(state)
  })

  it('removes a missing Terminal Region without manufacturing or deleting unrelated views', () => {
    let tab = createWorkbenchTab('agent-terminal-view', {
      regionId: initialWorkbenchRegionId('agent-terminal-view'),
      kind: 'agent',
      phase: 'attached',
      workspaceId: 'workspace-1',
      sessionId: session.id
    })
    tab = addWorkbenchRegion(tab, tab.layout.activeRegionId, 'right', {
      regionId: 'terminal-region',
      kind: 'terminal',
      phase: 'attached',
      workspaceId: 'workspace-1',
      sessionId: terminal.id
    })
    const state = {
      sessions: [session, terminal],
      timelines: {},
      pendingAgentLaunches: {},
      tabs: { [tab.id]: tab },
      layouts: { 'workspace-1': createWorkspaceLayout('pane', [tab.id]) },
      viewModes: {}
    }
    const other = { ...session, id: 'other-agent', control: { ...session.control, agentSessionId: 'other-agent' } }
    const next = reduceTerminalMembershipSnapshot({ ...state, sessions: [...state.sessions, other] }, {
      sessions: [other],
      timelines: { 'other-agent': { agentSessionId: 'other-agent', revision: 1, items: [] } },
      recoveryCandidates: []
    })

    expect(next.sessions.map((item) => item.id)).toEqual([session.id, 'other-agent'])
    expect(next.tabs[tab.id]).toBeDefined()
    expect(workbenchSurfaces(next.tabs[tab.id]!)).toEqual([
      expect.objectContaining({ kind: 'agent', sessionId: session.id })
    ])
  })

  it('updates an existing Terminal from the canonical snapshot and never adds an unrepresented one', () => {
    const state = {
      sessions: [terminal],
      timelines: {},
      pendingAgentLaunches: {},
      tabs: { 'terminal-view': terminalTab() },
      layouts: { 'workspace-1': createWorkspaceLayout('pane', ['terminal-view']) },
      viewModes: {}
    }
    const canonical = { ...terminal, label: 'Terminal · Renamed', updatedAt: 9 }
    const unseen: SessionSnapshot = { ...terminal, id: 'terminal-unseen', control: { ...terminal.control, runId: 'terminal-unseen', run: { runId: 'terminal-unseen' } } }
    const next = reduceTerminalMembershipSnapshot(state, {
      sessions: [canonical, unseen],
      timelines: {},
      recoveryCandidates: []
    })

    expect(next.sessions).toEqual([canonical])
    expect(next.tabs['terminal-view']).toBe(state.tabs['terminal-view'])
  })
})
