import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// 状态栏现在挂着资源面板，而资源面板要读 api，api 在模块加载时就要判断跑在哪个宿主里。
// 不先立起这个全局，import 阶段就炸，一条断言都跑不到。
vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { SessionSnapshot } from '../src/shared/contracts.js'
import type { AgentDisplayState } from '@agentmux/core'
import { summarizeAgentAttention, summarizeProviderActivity } from '../src/renderer/src/lib/agent-attention.js'
import { sessionBoardColumn } from '../src/renderer/src/lib/project-board.js'

const fixture = vi.hoisted(() => ({
  state: {
    sessions: [] as SessionSnapshot[],
    selectSession: vi.fn()
  }
}))

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state)
}))


function agent(
  id: string,
  state: AgentDisplayState,
  observedAt: number,
  providerId = 'codex'
): SessionSnapshot {
  return {
    id,
    kind: 'agent',
    providerId,
    executorId: 'codex',
    capabilities: {
      terminal: true,
      timeline: 'streaming',
      permission: 'respond',
      providerResume: true,
      replyCorrelation: 'native-turn-id'
    },
    hostId: 'local',
    workspacePath: '/repo',
    label: id,
    createdAt: 1,
    updatedAt: observedAt,
    processState: 'running',
    status: { state, source: 'native-hook', observedAt },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  }
}

function terminal(id: string): SessionSnapshot {
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
    control: { kind: 'terminal', hostId: 'local', runId: id, run: { runId: `run-${id}` } }
  }
}

describe('summarizeAgentAttention', () => {
  it('counts each attention class and ignores Terminal Sessions', () => {
    const rollup = summarizeAgentAttention([
      agent('a', 'working', 10),
      agent('b', 'waiting', 20),
      agent('c', 'blocked', 30),
      agent('d', 'error', 40),
      agent('e', 'done', 50),
      terminal('t')
    ])
    expect(rollup.total).toBe(5)
    expect(rollup.working).toBe(1)
    // waiting + blocked both fold into the single "needs you" class.
    expect(rollup.needsYou).toBe(2)
    expect(rollup.error).toBe(1)
  })

  it('targets the earliest session by observedAt within each attention class', () => {
    const rollup = summarizeAgentAttention([
      agent('late-block', 'blocked', 300),
      agent('early-wait', 'waiting', 100),
      agent('mid-wait', 'waiting', 200),
      agent('late-error', 'error', 90),
      agent('early-error', 'error', 50)
    ])
    // earliest across waiting|blocked is the wait at t=100, not the block at t=300.
    expect(rollup.needsYouSessionId).toBe('early-wait')
    expect(rollup.errorSessionId).toBe('early-error')
  })

  it('leaves jump targets null when an attention class is empty', () => {
    const rollup = summarizeAgentAttention([agent('a', 'working', 10)])
    expect(rollup.needsYou).toBe(0)
    expect(rollup.needsYouSessionId).toBeNull()
    expect(rollup.error).toBe(0)
    expect(rollup.errorSessionId).toBeNull()
  })
})

/**
 * 按 Provider 的活跃/待机计数。
 *
 * 这里最容易出的错不是数错，而是**发明第二套状态归类**：同一个 `running` 的 Agent，Board 判它
 * 在跑（working 列含 starting/running/working），状态栏若只认 `state === 'working'` 就判它待机。
 * 所以下面穷举九个状态逐一对照 `sessionBoardColumn`，而不是抽查几个——抽查漏掉的恰好会是
 * `starting`/`running` 这两个不显眼的。
 */
describe('summarizeProviderActivity', () => {
  const ALL_STATES: AgentDisplayState[] = [
    'starting', 'running', 'disconnected', 'working', 'waiting', 'blocked', 'done', 'exited', 'error'
  ]

  it('活跃与待机的定义就是 Board 的列，九个状态逐一对照', () => {
    for (const state of ALL_STATES) {
      const [entry] = summarizeProviderActivity([agent('a', state, 1)])
      const inWorkingColumn = sessionBoardColumn(agent('a', state, 1)) === 'working'
      expect(`${state}: active=${entry?.active} idle=${entry?.idle}`).toBe(
        `${state}: active=${inWorkingColumn ? 1 : 0} idle=${inWorkingColumn ? 0 : 1}`
      )
    }
    // 穷举必须真的覆盖了整个类型——漏一个状态，上面的循环会安静地少跑一轮。
    expect(ALL_STATES).toHaveLength(9)
  })

  it('按 Provider 分开计数，不把两个 Provider 合成一个数', () => {
    const counts = summarizeProviderActivity([
      agent('c1', 'working', 1, 'codex'),
      agent('c2', 'done', 2, 'codex'),
      agent('k1', 'running', 3, 'claude'),
      agent('k2', 'waiting', 4, 'claude'),
      agent('k3', 'blocked', 5, 'claude')
    ])
    expect(counts).toEqual([
      { providerId: 'codex', active: 1, idle: 1 },
      { providerId: 'claude', active: 1, idle: 2 }
    ])
  })

  it('零 Agent 的 Provider 不占位——没出现过就没有条目', () => {
    expect(summarizeProviderActivity([agent('a', 'working', 1, 'codex')]))
      .toEqual([{ providerId: 'codex', active: 1, idle: 0 }])
    expect(summarizeProviderActivity([])).toEqual([])
  })

  it('忽略 Terminal Session——它没有 Provider，也不是 Agent', () => {
    expect(summarizeProviderActivity([terminal('t')])).toEqual([])
  })

  it('顺序由首次出现决定，不随计数变化而跳位', () => {
    // 按活跃数排序会让一排图标在 Agent 状态变化时来回换位，读数的人要重新找。
    const counts = summarizeProviderActivity([
      agent('k', 'done', 1, 'claude'),
      agent('c1', 'working', 2, 'codex'),
      agent('c2', 'working', 3, 'codex')
    ])
    expect(counts.map((entry) => entry.providerId)).toEqual(['claude', 'codex'])
  })
})

