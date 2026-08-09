import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: () => undefined
}))
import {
  collectTerminalColdParkCandidates,
  useTerminalColdParking
} from '../src/renderer/src/lib/terminal-cold-parking-coordinator.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'

function terminalTab(id: string, phase: 'launching' | 'attached' = 'attached') {
  return createWorkbenchTab(id, {
    regionId: `region:${id}`,
    kind: 'terminal',
    phase,
    workspaceId: 'workspace-1',
    sessionId: `session:${id}`
  })
}

function session(id: string, processState: 'running' | 'exited' = 'running') {
  return {
    id: `session:${id}`,
    kind: 'terminal' as const,
    providerId: null,
    hostId: 'local',
    workspacePath: '/repo',
    label: 'Terminal',
    createdAt: 1,
    updatedAt: 1,
    processState,
    status: {
      state: processState === 'running' ? 'running' as const : 'exited' as const,
      source: 'run-process' as const,
      observedAt: 1
    },
    latestOutputBytes: 0,
    control: {
      kind: 'terminal' as const,
      hostId: 'local',
      runId: `session:${id}`,
      run: { runId: `run:${id}` }
    }
  }
}

describe('window terminal parking coordinator', () => {
  it('treats a partially hydrated store as an empty workbench during static render', () => {
    function Probe() {
      const parkedRegionIds = useTerminalColdParking({ workbenchVisible: false })
      return createElement('output', { 'data-parked-count': parkedRegionIds.size })
    }

    expect(() => renderToStaticMarkup(createElement(Probe))).not.toThrow()
  })

  it('marks only the active tab Region visible and keeps Region identity stable', () => {
    const first = terminalTab('first')
    const second = terminalTab('second')
    const tabs = { [first.id]: first, [second.id]: second }
    const layout = createWorkspaceLayout('group', [first.id, second.id])
    const candidates = collectTerminalColdParkCandidates({
      tabs,
      layouts: { 'workspace-1': layout },
      sessions: [session('first'), session('second')],
      activeWorkspaceId: 'workspace-1',
      workbenchVisible: true
    })

    expect(candidates).toEqual([
      expect.objectContaining({ id: 'region:first', visible: true, navigationContextActive: true, canRebuild: true }),
      expect.objectContaining({ id: 'region:second', visible: false, navigationContextActive: true, canRebuild: true })
    ])
  })

  it('blocks parking for launching or exited Sessions', () => {
    const launching = terminalTab('launching', 'launching')
    const exited = terminalTab('exited')
    const layout = createWorkspaceLayout('group', [launching.id, exited.id])
    const candidates = collectTerminalColdParkCandidates({
      tabs: { [launching.id]: launching, [exited.id]: exited },
      layouts: { 'workspace-1': layout },
      sessions: [session('launching'), session('exited', 'exited')],
      activeWorkspaceId: 'other-workspace',
      workbenchVisible: true
    })

    expect(candidates).toEqual([
      expect.objectContaining({ id: 'region:launching', phase: 'launching', navigationContextActive: false, canRebuild: true }),
      expect.objectContaining({ id: 'region:exited', phase: 'attached', navigationContextActive: false, canRebuild: false })
    ])
  })

  it('keeps a Session that failed continuity recovery rendered, on the state its writers actually produce', () => {
    // 恢复失败的 Session 必须留在屏上，否则用户看不到恢复过程。但守住它的是 `state !== 'error'`，
    // 不是 `continuity` 这个字段本身：`continuityStatusFields`（启动候选投影与用户点「恢复」两条路
    // 共用的唯一产出口）把 `state` 钉成 `'error'`，而后续任何状态事件都整体替换 `status`
    // （session-state.ts 的 agent-status / process-state 两处），所以 `continuity` 在场时 `state`
    // 必然是 `error`。
    //
    // 这条断言因此喂**真实写入点造出来的形状**，而不是手拼一个 `state: 'running'` +
    // `continuity: 'unavailable'` 的组合——那个组合 production 里不存在，据它写的判据是自证：
    // 实测加一条 `continuity === undefined` 子句后，删掉它只有那条合成 fixture 会红（2258 条里 1 条）。
    const tab = terminalTab('recovering')
    const layout = createWorkspaceLayout('group', [tab.id])
    // 形状取自真写入点 `continuityStatusFields`（store.ts）：它把 `state` 钉成 'error' 并附上
    // continuity 三兄弟。那个函数确实这么产出，由 continuity-failure-notice.test.ts 直接调
    // `recoveryCandidateSession` 断言。这里不 import 它——本文件把整个 store mock 掉了（coordinator
    // 依赖 store），所以这份形状是手抄的：它与真产出漂移时，红的会是那一侧而不是这一侧。
    const recovering = {
      ...session('recovering'),
      status: {
        state: 'error' as const,
        source: 'run-process' as const,
        observedAt: 1,
        continuity: 'unavailable' as const,
        continuityReason: 'provider-unavailable' as const
      }
    }

    const candidates = collectTerminalColdParkCandidates({
      tabs: { [tab.id]: tab },
      layouts: { 'workspace-1': layout },
      sessions: [recovering],
      activeWorkspaceId: 'other-workspace',
      workbenchVisible: true
    })

    expect(candidates[0]?.id).toBe('region:recovering')
    expect(candidates[0]?.canRebuild).toBe(false)
  })

  it('keeps a hidden Region warm when only the Workspace context changed', () => {
    const tab = terminalTab('remote-project')
    const layout = createWorkspaceLayout('group', [tab.id])
    const candidates = collectTerminalColdParkCandidates({
      tabs: { [tab.id]: tab },
      layouts: { 'workspace-1': layout },
      sessions: [session('remote-project')],
      activeWorkspaceId: 'another-workspace',
      workbenchVisible: true
    })

    expect(candidates[0]).toMatchObject({
      id: 'region:remote-project',
      visible: false,
      navigationContextActive: false
    })
  })

  it('keeps a hidden Region warm when only the Scratch Topic changed', () => {
    const workspaceId = '__scratch__'
    const topicA = 'view:topic-a'
    const topicB = 'view:topic-b'
    const first = {
      ...terminalTab('topic-a'),
      workspaceId,
      topicId: topicA
    }
    const second = {
      ...terminalTab('topic-b'),
      workspaceId,
      topicId: topicB
    }
    const layout = createWorkspaceLayout('group', [first.id, second.id])
    const activeTopicLayout = {
      ...layout,
      groups: layout.groups.map((group) => ({ ...group, activeTabId: second.id }))
    }
    const candidates = collectTerminalColdParkCandidates({
      tabs: { [first.id]: first, [second.id]: second },
      layouts: { [workspaceId]: activeTopicLayout },
      sessions: [session('topic-a'), session('topic-b')],
      activeWorkspaceId: workspaceId,
      workbenchVisible: true
    })

    expect(candidates.find((candidate) => candidate.id === 'region:topic-a')).toMatchObject({
      visible: false,
      navigationContextActive: false
    })
    expect(candidates.find((candidate) => candidate.id === 'region:topic-b')).toMatchObject({
      visible: true,
      navigationContextActive: true
    })
  })
})
