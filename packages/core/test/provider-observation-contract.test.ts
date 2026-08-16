import { describe, expect, it } from 'vitest'
import {
  observeAgent,
  type AgentObservation
} from '../src/agent-status-freshness.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import type {
  AgentCapabilities,
  AgentDisplayState,
  AgentMuxEvidenceSource,
  AgentMuxRunState
} from '../src/types.js'

/**
 * Provider 观察合同的收敛点：{@link observeAgent} 把三条**不折叠**的轴（进程活性 / 语义活性 / 就绪性）
 * 从 Session 现在的事实里投影出来。
 *
 * 这一族守的是判定本身；「真实消费者是否真的走了这个投影」由 client.statusAgent（Core 侧公开 API）与
 * desktop 侧 provider-observation-consumer.test.tsx 各自钉死。分工与本仓既有的
 * agent-status-freshness / run-process-status-convergence 两族一致。
 */

const NOW = 1_000_000

function status(input: {
  state: AgentDisplayState
  source: AgentMuxEvidenceSource
  observedAt: number
}): { state: AgentDisplayState; source: AgentMuxEvidenceSource; observedAt: number } {
  return { state: input.state, source: input.source, observedAt: input.observedAt }
}

function observe(input: {
  process?: AgentMuxRunState
  // 默认 'working'：一条活动声明来源报的「此刻在干活」正是这个 state。默认写死 'running' 会让 state
  // 维度失效——那正是本合同要挡的缺陷（native-hook 报 running 不等于在干活）。
  state?: AgentDisplayState
  source?: AgentMuxEvidenceSource
  observedAt?: number
  timeline?: AgentCapabilities['timeline']
  awaitingRequest?: boolean
  terminalUnverified?: boolean
  now?: number
}): AgentObservation {
  return observeAgent(
    {
      process: input.process ?? 'running',
      status: status({
        state: input.state ?? 'working',
        source: input.source ?? 'native-hook',
        observedAt: input.observedAt ?? NOW
      }),
      timelineCapability: input.timeline ?? 'complete-events',
      awaitingRequest: input.awaitingRequest ?? false,
      terminalCapabilityUnverified: input.terminalUnverified ?? false
    },
    input.now ?? NOW
  )
}

describe('三条轴不折叠成一个 busy', () => {
  it('进程 alive + semantic idle + readiness pending 三件事各自可判、互不塌陷', () => {
    // 进程活着、有待答请求：这恰是"活着但不是在干活、且还不能接普通输入"这一格——若三轴塌成 busy，
    // 这三个不同的值就再也分不出来。
    const pending = observe({ process: 'running', source: 'run-process', awaitingRequest: true })
    expect(pending.process).toBe('running')   // 进程 alive
    expect(pending.semantic).toBe('idle')     // 没有活动声明 = 语义 idle（不是 busy）
    expect(pending.readiness).toBe('pending') // 卡在待答请求 = 就绪 pending

    // 同一进程状态下，语义与就绪各自能独立取到别的值——证明它们不是同一个布尔的三个别名。
    const active = observe({ process: 'running', source: 'native-hook' })
    expect(active.semantic).toBe('active')
    expect(active.readiness).toBe('ready')
  })

  it('semantic active 只由活动声明来源支撑，裸 running 是 idle 不是 active', () => {
    // 缺陷的正脸：把 run-process 也当活动声明会让每个活着的进程都显示"在干活"。
    expect(observe({ source: 'native-hook' }).semantic).toBe('active')
    expect(observe({ source: 'acp' }).semantic).toBe('active')
    expect(observe({ source: 'run-process' }).semantic).toBe('idle')
    // 终端字节永不作语义活动证据（本仓设计红线）。
    expect(observe({ source: 'terminal-output' }).semantic).toBe('idle')
  })

  it('同一活动声明来源(native-hook)下，声明的 state 决定 semantic——不塌成一个 active', () => {
    // 缺陷的正脸（本轮修的）：只看 source 会让同一个 native-hook 报的 working/waiting/blocked/done/error
    // 全塌成 active。判据必须同时读 state。遍历同一 source 下的不同 state，证明它们得到不同的读数。
    expect(observe({ source: 'native-hook', state: 'working' }).semantic).toBe('active')
    // waiting/blocked 是「停下了、在等你」的静止声明，自成一档 awaiting-input，绝不压成 idle
    // （压成 idle 会抹掉驱动「需要你」提醒的真实信号）。
    expect(observe({ source: 'native-hook', state: 'waiting' }).semantic).toBe('awaiting-input')
    expect(observe({ source: 'native-hook', state: 'blocked' }).semantic).toBe('awaiting-input')
    // done/error 是**结论**：进程还 running 时绝不报 active（那会谎称一个已出结论的 Agent 还在干活）。
    expect(observe({ source: 'native-hook', state: 'done' }).semantic).toBe('idle')
    expect(observe({ source: 'native-hook', state: 'error' }).semantic).toBe('idle')
    // 至少存在两个互不相同的读数——直接钉死「不塌成一个值」这件事本身。
    const readings = new Set(
      (['working', 'waiting', 'done'] as const).map((s) => observe({ source: 'native-hook', state: s }).semantic)
    )
    expect(readings.size).toBeGreaterThan(1)
  })

  it('awaiting-input 是静止声明，不随静默衰减——20 分钟前的「等你」仍在等你', () => {
    // 只有 working 会衰减；waiting/blocked 静默与其相容，衰减掉等于把「需要你」提醒悄悄抹了。
    const staleWaiting = observe({ source: 'native-hook', state: 'waiting', observedAt: NOW, now: NOW + 20 * 60_000 })
    expect(staleWaiting.semantic).toBe('awaiting-input')
    // 对照：同样静默 20 分钟的 working 会衰减落 idle——证明衰减确实只作用于 working。
    expect(observe({ source: 'native-hook', state: 'working', observedAt: NOW, now: NOW + 20 * 60_000 }).semantic)
      .toBe('idle')
  })

  it('进程不是 running 时语义/就绪都退回 unknown，绝不伪造 idle/ready', () => {
    for (const process of ['exited', 'interrupted'] as const) {
      const observation = observe({ process, source: 'native-hook' })
      expect(observation.semantic).toBe('unknown')
      expect(observation.readiness).toBe('unknown')
    }
  })

  it('迟到活动声明过了新鲜度窗口 → 语义落回 idle 且标 stale，不再冒充在干活', () => {
    const stale = observe({ source: 'native-hook', observedAt: NOW, now: NOW + 16 * 60_000 })
    expect(stale.semantic).toBe('idle')
    expect(stale.stale).toBe(true)
    // 未过窗口的同源读数仍是 active——证明衰减确实是那道窗口在起作用。
    expect(observe({ source: 'native-hook', observedAt: NOW, now: NOW + 60_000 }).semantic).toBe('active')
  })
})

describe('无能力的 Provider 保持 unsupported，不与 unknown 混为一谈', () => {
  it('timeline unavailable ⇒ semantic unsupported（进程 running 也不例外）', () => {
    // unsupported 与 unknown 必须分开：unknown 是"这一刻碰巧没有活动声明"，unsupported 是"这条通道
    // 根本不存在"。把它显示成 unknown 会让用户去等一个永远不来的信号。
    expect(observe({ timeline: 'unavailable', source: 'native-hook' }).semantic).toBe('unsupported')
    expect(observe({ timeline: 'unavailable', source: 'run-process' }).semantic).toBe('unsupported')
  })

  it('registry 里真的存在一个 timeline unavailable 的 Provider（否则 unsupported 分支是死路）', () => {
    // 从注册表枚举验证其他 Provider，而不是从一家推断：unsupported 不是假想的分支，registry 里
    // 确有 Provider 声明 timeline: 'unavailable'，它经这个投影会得到 unsupported。
    const registry = new AgentProviderRegistry()
    const unsupported = registry.list().filter((p) => p.catalog.capabilities.timeline === 'unavailable')
    expect(unsupported.length).toBeGreaterThan(0)
    for (const provider of unsupported) {
      expect(observe({ timeline: provider.catalog.capabilities.timeline, source: 'native-hook' }).semantic)
        .toBe('unsupported')
    }
    // 而有 timeline 能力的 Provider 在同样的活动声明下得到 active——两类分得开。
    const withTimeline = registry.list().filter((p) => p.catalog.capabilities.timeline !== 'unavailable')
    expect(withTimeline.length).toBeGreaterThan(0)
    for (const provider of withTimeline) {
      expect(observe({ timeline: provider.catalog.capabilities.timeline, source: 'native-hook' }).semantic)
        .toBe('active')
    }
  })
})

describe('就绪性区分 ready / pending / unknown', () => {
  it('running 且无阻塞 = ready；待答请求或终端能力未确认 = pending', () => {
    expect(observe({ process: 'running' }).readiness).toBe('ready')
    expect(observe({ process: 'running', awaitingRequest: true }).readiness).toBe('pending')
    expect(observe({ process: 'running', terminalUnverified: true }).readiness).toBe('pending')
  })
})
