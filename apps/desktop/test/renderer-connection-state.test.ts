import { describe, expect, it } from 'vitest'
import type { RuntimeEvent, SessionSnapshot } from '../src/shared/contracts.js'
import { reduceRuntimeEvent } from '../src/renderer/src/lib/session-state.js'
import {
  CONNECTION_LOST_DETAIL,
  CONNECTION_UNRECOVERABLE_DETAIL
} from '../src/renderer/src/lib/session-state.js'

// 本任务的核心价值面：Core 一发 connection-state:lost，渲染端就必须把该 Host 的每个 Agent 置成
// `disconnected`——这是那 8 处现成故障 UX 唯一的触发源。守卫最重要的一条：让掉线**不置** disconnected
// （把这条 reducer 分支删掉/改成不改状态），下面第一个断言必红。
function agent(overrides: Partial<SessionSnapshot> & { id: string; hostId: string }): SessionSnapshot {
  return {
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
    workspacePath: '/repo',
    label: 'Codex',
    createdAt: 1,
    updatedAt: 2,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 2 },
    latestOutputBytes: 0,
    control: {
      kind: 'agent',
      hostId: overrides.hostId,
      agentSessionId: overrides.id,
      run: { runId: `run-${overrides.id}` }
    },
    ...overrides
  }
}

function stateWith(sessions: SessionSnapshot[]) {
  return {
    sessions,
    timelines: {},
    pendingAgentLaunches: {},
    tabs: {},
    layouts: {},
    viewModes: {}
  }
}

function connectionState(
  hostId: string,
  connectionState: 'lost' | 'restored' | 'unrecoverable',
  observedAt: number
): RuntimeEvent {
  return {
    type: 'core',
    hostId,
    event: {
      type: 'connection-state',
      state: connectionState,
      evidence: { source: 'run-process', observedAt }
    }
  }
}

describe('Renderer connection-state projection', () => {
  it('sets every agent on the disconnected host to `disconnected` on lost', () => {
    const state = stateWith([
      agent({ id: 'a-1', hostId: 'local' }),
      agent({ id: 'a-2', hostId: 'local', status: { state: 'working', source: 'native-hook', observedAt: 5 } })
    ])

    const next = reduceRuntimeEvent(state, connectionState('local', 'lost', 9))

    // 最重要的一条：掉线必须把状态置 disconnected，否则整套 UX 又回到死代码。
    expect(next.sessions.map((session) => session.status.state)).toEqual([
      'disconnected',
      'disconnected'
    ])
  })

  it('only touches agents on the event host, leaving other hosts and terminals alone', () => {
    const state = stateWith([
      agent({ id: 'a-1', hostId: 'local' }),
      agent({ id: 'a-2', hostId: 'remote' })
    ])

    const next = reduceRuntimeEvent(state, connectionState('local', 'lost', 9))

    const byId = new Map(next.sessions.map((session) => [session.id, session.status.state]))
    expect(byId.get('a-1')).toBe('disconnected')
    // 单 daemon 是 per-Host 的：另一台 Host 的 Agent 不受影响。
    expect(byId.get('a-2')).toBe('running')
  })

  it('unrecoverable 也必须置 disconnected——判死了却还挂着 running 是最坏的谎话', () => {
    // 抖动预算用尽时 Core **不再发 lost**，直接发 unrecoverable（检查点前移，见 client 的
    // handleConnectionLost）。只认 lost 的话，连接已经判死、整屏 Agent 还显示在跑，用户会继续
    // 往一个不存在的连接里发消息。把这条 reducer 分支改回 `core.state !== 'lost'` 就会红。
    const state = stateWith([agent({ id: 'a-1', hostId: 'local' })])

    const next = reduceRuntimeEvent(state, connectionState('local', 'unrecoverable', 9))

    expect(next.sessions[0]!.status.state).toBe('disconnected')
  })

  it('两类失联写下互不重叠的 detail——一句说在自愈，一句说已放弃', () => {
    // 状态位两类共用（都是 disconnected），区分全靠 detail。这条守「两句话真的不一样」，而且不是
    // 逐字不等就算过：措辞近似等于把终局伪装成暂时，用户对这两种局面该做的事完全相反。
    const state = stateWith([agent({ id: 'a-1', hostId: 'local' })])

    const lost = reduceRuntimeEvent(state, connectionState('local', 'lost', 9))
    const gaveUp = reduceRuntimeEvent(state, connectionState('local', 'unrecoverable', 9))

    expect(lost.sessions[0]!.status.detail).toBe(CONNECTION_LOST_DETAIL)
    expect(gaveUp.sessions[0]!.status.detail).toBe(CONNECTION_UNRECOVERABLE_DETAIL)

    // 实词无交集：只有一方谈「重连中」，只有一方谈「放弃」。把两条文案改成近似措辞（例如都写
    // 'Reconnecting…'）时，not.toBe 会照旧通过，而下面这两条会红。
    const stop = new Set(['to', 'this', 'host', 'your', 'agent', 'processes', 'may', 'still', 'be',
      'running', 'keep', 'only', 'window', 's', 'link', 'dropped', 'use', 'after'])
    const words = (copy: string) => new Set(
      copy.toLowerCase().split(/[^a-z]+/).filter((word) => word.length > 2 && !stop.has(word)))
    const lostWords = words(CONNECTION_LOST_DETAIL)
    const gaveUpWords = words(CONNECTION_UNRECOVERABLE_DETAIL)
    expect([...lostWords].filter((word) => gaveUpWords.has(word))).toEqual([])
    // 而且各自都真的有实词——两边都空集时上面那条会恒真。
    expect(lostWords.size).toBeGreaterThan(0)
    expect(gaveUpWords.size).toBeGreaterThan(0)
  })

  it('restored 不改状态——真相由补发的 run-state 事件拉回', () => {
    // restored 后由 Core 补发的 process-state/agent-status 把每个 run 拉回进程真相，比这里猜一个
    // 状态准。这条只确认 reducer 不擅自翻转。
    const disconnected = stateWith([
      agent({ id: 'a-1', hostId: 'local', status: { state: 'disconnected', source: 'run-process', observedAt: 9 } })
    ])

    const afterRestored = reduceRuntimeEvent(disconnected, connectionState('local', 'restored', 10))
    expect(afterRestored.sessions[0]!.status.state).toBe('disconnected')
  })
})
