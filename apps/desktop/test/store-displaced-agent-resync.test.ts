import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import {
  AGENTMUX_CONTROL_SCHEMA_VERSION,
  type AgentMuxControlRequest
} from '@agentmux/core'
import type {
  AgentLaunchResult,
  AgentTimelineItem,
  AppConfig,
  RuntimeEvent,
  SessionSnapshot
} from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab, type WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { useAppStore } from '../src/renderer/src/store.js'

// ---------------------------------------------------------------------------
// store.ts:2485 —— displaced-agent 启动竞态里，被缓冲的 pending-launch 事件带着 revision 缺口时，
// 必须补一次 `resyncTimeline`。否则那个健康启动、但 Region 中途没了的 Agent，其 Timeline 会永远缺一段
// （缓冲里那条 gapped 事件既没被投影、也没触发重取），用户点进它的 Activity 看到的是断档。
//
// 缺口从哪来：reduceDetachedAgentLaunch -> projectAgentLaunchResult 回放缓冲事件，某条 agent-timeline
// 的 revision 与 baseline 不连续（这里 baseline=0，缓冲事件 revision=2）时，applyTimelineEvent 报 gap，
// projectAgentLaunchResult 把 timelineGapSessionId 设成该 session——store.ts:2485 据此补一次重取。
//
// 判据钉在「resyncTimeline 真的以这个 sessionId 被调了一次」上，这正是删掉 2485 那行会消失的可观测效果。
// 现有 control-spatial-commit.test.ts 只测纯 helper，displaced-agent-notice.test.tsx 只测告示组件；
// 没有任何测试驱动这一行。
// ---------------------------------------------------------------------------

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

function callerAgent(id: string): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    id, kind: 'agent', providerId: 'codex', executorId: 'codex',
    capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    hostId: 'local', workspacePath: '/repo', label: id, createdAt: 1, updatedAt: 1,
    processState: 'running', status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  }
}

function launchedAgent(id: string): Extract<SessionSnapshot, { kind: 'agent' }> {
  return callerAgent(id)
}

function fixture(): WorkbenchTab {
  const caller = callerAgent('caller')
  const tab = createWorkbenchTab('tab-caller', {
    regionId: 'region-caller', kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: caller.id
  })
  useAppStore.setState({
    config,
    sessions: [caller],
    activeWorkspaceId: 'workspace',
    mainSurface: 'workbench',
    tabs: { [tab.id]: tab },
    layouts: { workspace: createWorkspaceLayout('group', [tab.id]) },
    pendingAgentLaunches: {},
    error: null
  })
  return tab
}

// A buffered pending-launch agent-timeline event whose revision jumps past the baseline (0 -> 2).
// projectAgentLaunchResult replays it and applyTimelineEvent flags the gap -> timelineGapSessionId set.
function gappedTimelineEvent(agentSessionId: string): RuntimeEvent {
  const item: AgentTimelineItem = {
    id: `${agentSessionId}-late`, agentSessionId, kind: 'assistant_message', status: 'complete',
    source: 'native-hook', createdAt: 1, updatedAt: 1, title: 'Assistant response', content: 'buffered while launching'
  }
  return {
    type: 'core', hostId: 'local',
    event: {
      type: 'agent-timeline', agentSessionId, revision: 2,
      mutation: { type: 'append', agentSessionId, item },
      evidence: { source: 'native-hook', observedAt: 2, run: { runId: `run-${agentSessionId}` } }
    }
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
function request<T extends AgentMuxControlRequest>(value: DistributiveOmit<T, 'schemaVersion' | 'requestId'>): T {
  return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: `request-${value.operation}`, ...value } as T
}

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

describe('displaced-agent 启动竞态：带缺口的缓冲事件必须触发 resyncTimeline (store.ts:2485)', () => {
  it('Region 中途消失 + 缓冲里有 gapped 事件 -> resyncTimeline 以该 sessionId 被调用一次', async () => {
    fixture()

    // 只观测 2485 这行的效果，不真的去 api.sessions.timeline 往返。
    const resync = vi.spyOn(useAppStore.getState(), 'resyncTimeline').mockResolvedValue(undefined)

    let agentSessionId = ''
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async (input): Promise<AgentLaunchResult> => {
      agentSessionId = input.agentSessionId!
      // 启动在途的真实时序：迟到的 hook 事件已被缓冲进 pending-launch 台账，且带着 revision 缺口。
      useAppStore.setState((state) => ({
        pendingAgentLaunches: {
          ...state.pendingAgentLaunches,
          [agentSessionId]: { events: [gappedTimelineEvent(agentSessionId)], overflowed: false }
        }
      }))
      // Region 在启动期间没了（关闭 / id 被回收）——ownsSessionLaunch 于是为 false，走 displaced 路。
      useAppStore.setState({ tabs: {} })
      return { session: launchedAgent(agentSessionId), timeline: { agentSessionId, revision: 0, items: [] } }
    })

    // displaced 路以 CONTROL_OWNER_LOST 拒回执（Run 仍在跑）——这条 reject 同时自证我们真的进了被测分支，
    // 而不是落到 landed 那半。
    await expect(useAppStore.getState().executeControl(request({
      operation: 'open.agent',
      content: { kind: 'new-agent', executorId: 'codex', prompt: 'write' },
      destination: { kind: 'split', direction: 'right', region: { kind: 'region', regionId: 'region-caller' } }
    }))).rejects.toThrow()

    // 核心判据：删掉 store.ts:2485 那行 `void get().resyncTimeline(...)`，这一句会红。
    expect(resync).toHaveBeenCalledTimes(1)
    expect(resync).toHaveBeenCalledWith(agentSessionId)
  })
})
