import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { SessionSnapshot } from '../src/shared/contracts.js'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import {
  decayStaleAgentStatuses,
  nextAgentStatusDecayDelayMs
} from '../src/renderer/src/lib/agent-status-decay.js'
import { useAppStore } from '../src/renderer/src/store.js'

// ---------------------------------------------------------------------------
// T-003：掉了 hook 流的 `working` 不该留一个永远转的圈。
//
// 三截，各证一件事：
//  1) 纯函数判定（decayStaleAgentStatuses / nextAgentStatusDecayDelayMs）——把陈旧的 working 降成
//     中性态、把还活着的排到满额定时器。core 侧已断言「哪种状态、多久之后算陈旧」；这层断言 renderer
//     怎么把那个判定作用到 SessionSnapshot 上（降哪个字段、保哪个字段、无变化时不换引用）。
//  2) store action 真的接上了那个纯函数：喂一个陈旧的 working 进 store，调 decayStaleAgentStatuses(now)，
//     断言 store 里那条真的降了。这一截可以真跑（zustand action 是纯 set）。
//  3) App 把这个 hook 挂上了窗口。本仓库组件测试用 renderToStaticMarkup，effect/定时器都不跑，所以只能
//     读源码断言挂载存在（同 workbench-shortcut-wiring / terminal-search 的扫描式断言）。删掉 useAgentStatusDecay()
//     这一行，单测全绿、这里会红。
// ---------------------------------------------------------------------------

const STALE_AFTER_MS = 15 * 60_000

function agent(
  id: string,
  state: SessionSnapshot['status']['state'],
  observedAt: number
): SessionSnapshot {
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
    workspacePath: '/repo',
    label: `Agent ${id}`,
    createdAt: 1,
    updatedAt: observedAt,
    processState: 'running',
    status: { state, source: 'native-hook', observedAt },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  } as unknown as SessionSnapshot
}

function terminal(id: string): SessionSnapshot {
  return {
    id,
    kind: 'terminal',
    providerId: null,
    hostId: 'local',
    workspacePath: '/repo',
    label: 'Terminal',
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'terminal', hostId: 'local', runId: `run-${id}`, run: { runId: `run-${id}` } }
  } as unknown as SessionSnapshot
}

describe('decayStaleAgentStatuses：把陈旧的 working 降成中性态', () => {
  it('静默超过阈值的 working 降为 running，绝不降成 done/error', () => {
    const [decayed] = decayStaleAgentStatuses([agent('a', 'working', 0)], STALE_AFTER_MS + 1)
    expect(decayed!.status.state).toBe('running')
  })

  it('只改 state，保留 observedAt 与 source——衰减是重新解读旧观察，不是一次新观察', () => {
    const [decayed] = decayStaleAgentStatuses([agent('a', 'working', 1_000)], 1_000 + STALE_AFTER_MS + 1)
    expect(decayed!.status.observedAt).toBe(1_000)
    expect(decayed!.status.source).toBe('native-hook')
  })

  it('保留 continuity 与 continuityReason——衰减是重新解读 state，不是重写整个 status', () => {
    // 衰减只动 `state` 一个字段，其余原样保留。这条契约承重的地方是**恢复失败横幅**：
    // SessionPane 用 `status.continuity` / `continuityReason` / `continuityConflict` 三个字段
    // 分类失败原因并决定按钮做什么（continuity-failure-notice.ts）。一次「顺手把 status 重写成
    // state/source/observedAt 三个字段」的改动会让别处全绿，而用户看到的是恢复失败的原因与
    // 那个按钮一起消失，只剩一条不说原因的通用横幅。
    //
    // 注意这个组合本身在 production 里到不了：写 continuity 的唯一产出口把 state 钉成 'error'，
    // 而衰减只对陈旧的 `working` 触发。所以这条守的是「保字段」这条契约本身，不是某个具体现场——
    // 冷泊车曾被认为靠 `continuity === undefined` 挡住衰减产物，实测那是死代码（已删）。
    const stale = agent('a', 'working', 1_000)
    const withContinuity = {
      ...stale,
      status: { ...stale.status, continuity: 'unavailable', continuityReason: 'provider-unavailable' }
    } as unknown as SessionSnapshot

    const [decayed] = decayStaleAgentStatuses([withContinuity], 1_000 + STALE_AFTER_MS + 1)

    expect(decayed!.status.state).toBe('running')
    expect(decayed!.status.continuity).toBe('unavailable')
    expect(decayed!.status.continuityReason).toBe('provider-unavailable')
  })

  it('阈值内、正跑长命令的 working 不被误降级', () => {
    const fiveMinutesQuiet = 5 * 60_000
    const [kept] = decayStaleAgentStatuses([agent('a', 'working', 0)], fiveMinutesQuiet)
    expect(kept!.status.state).toBe('working')
  })

  it('waiting/done/error 从不被这里改动', () => {
    const input = [agent('w', 'waiting', 0), agent('d', 'done', 0), agent('e', 'error', 0)]
    const out = decayStaleAgentStatuses(input, STALE_AFTER_MS * 100)
    expect(out.map((s) => s.status.state)).toEqual(['waiting', 'done', 'error'])
  })

  it('终端 Session 不碰', () => {
    const input = [terminal('t')]
    expect(decayStaleAgentStatuses(input, STALE_AFTER_MS * 100)[0]!.status.state).toBe('running')
  })

  it('无一需降时返回原数组引用——store 不做无谓写入', () => {
    const input = [agent('a', 'working', 0)]
    expect(decayStaleAgentStatuses(input, STALE_AFTER_MS - 1)).toBe(input)
  })
})

describe('nextAgentStatusDecayDelayMs：给定时器排下一个到点', () => {
  it('working 刚落地时排满额 TTL', () => {
    expect(nextAgentStatusDecayDelayMs([agent('a', 'working', 0)], 0)).toBe(STALE_AFTER_MS)
  })

  it('多个 working 取最近将陈旧的那个', () => {
    const sessions = [agent('a', 'working', 0), agent('b', 'working', 5_000)]
    // a 在 STALE_AFTER_MS 到点、b 在 5_000+STALE_AFTER_MS；now=0 时 a 更近。
    expect(nextAgentStatusDecayDelayMs(sessions, 0)).toBe(STALE_AFTER_MS)
  })

  it('没有在途 working 时返回 null（不排定时器）', () => {
    expect(nextAgentStatusDecayDelayMs([agent('a', 'waiting', 0), terminal('t')], 0)).toBeNull()
  })

  it('已过点的 working 不排 0ms 空转——被 msUntil>0 的过滤挡掉', () => {
    expect(nextAgentStatusDecayDelayMs([agent('a', 'working', 0)], STALE_AFTER_MS + 10)).toBeNull()
  })
})

describe('store action 真的接上了纯判定', () => {
  const initialState = useAppStore.getState()
  afterEach(() => useAppStore.setState(initialState, true))

  it('decayStaleAgentStatuses(now) 把 store 里陈旧的 working 降为中性态', () => {
    useAppStore.setState({ sessions: [agent('a', 'working', 0)] })
    useAppStore.getState().decayStaleAgentStatuses(STALE_AFTER_MS + 1)
    expect(useAppStore.getState().sessions[0]!.status.state).toBe('running')
  })

  it('无一陈旧时不换 sessions 引用（不触发无谓重渲染）', () => {
    const sessions = [agent('a', 'working', 0)]
    useAppStore.setState({ sessions })
    useAppStore.getState().decayStaleAgentStatuses(STALE_AFTER_MS - 1)
    expect(useAppStore.getState().sessions).toBe(sessions)
  })
})

describe('App 把衰减 hook 挂到窗口', () => {
  const appSource = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
  // 先剥注释——注释里描述规则的文字不是规则本身，别让它假装成挂载。
  const code = appSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')

  it('App 导入并调用了 useAgentStatusDecay——删掉这行，别处全绿这里红', () => {
    expect(code).toMatch(/import\s*\{\s*useAgentStatusDecay\s*\}\s*from\s*'\.\/lib\/agent-status-decay'/)
    expect(code).toMatch(/useAgentStatusDecay\(\)/)
  })
})
