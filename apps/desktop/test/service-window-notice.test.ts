import { describe, expect, it } from 'vitest'
import {
  agentSessionServiceOutcome,
  classifyServiceNotice,
  serviceNoticeToRender
} from '../src/renderer/src/lib/service-window-notice.js'
import type { SessionSnapshot } from '../src/shared/contracts.js'

/**
 * 服务窗的判定层（AGENTS.md 原则 11）。
 *
 * 这条原则的全部要害在**分类**：一处失败在阻断用户之前，先分清 Agent 是真的坏了，还是只是我们的
 * 流程坏了。两条硬边界必须各有一条会变红的断言守住：第 2 类绝不静默放行；未知绝不当成好的。
 *
 * 判定的唯一公开入口是 `agentSessionServiceOutcome`（不为测试另开一条构造 outcome 的口子），
 * 因此下面的 outcome 全部由真实 Session 事实经这个入口得到。
 */

function agentSession(overrides: {
  state?: SessionSnapshot['status']['state']
  processState?: SessionSnapshot['processState']
  kind?: 'agent' | 'terminal'
  terminalCapability?: Extract<SessionSnapshot, { kind: 'agent' }>['terminalCapability']
}): SessionSnapshot {
  return {
    id: 's',
    hostId: 'local',
    workspacePath: '/w',
    label: 'a',
    createdAt: 0,
    updatedAt: 0,
    processState: overrides.processState ?? 'running',
    kind: overrides.kind ?? 'agent',
    providerId: 'claude',
    executorId: 'claude-code',
    capabilities: {},
    ...(overrides.terminalCapability ? { terminalCapability: overrides.terminalCapability } : {}),
    status: { state: overrides.state ?? 'working', source: 'run-process', observedAt: 0 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: 's', run: { runId: 'r', hostId: 'local' } }
  } as unknown as SessionSnapshot
}

const handshakeDegraded = agentSession({
  state: 'working',
  terminalCapability: {
    state: 'unknown',
    mode: 'degraded',
    reason: 'handshake-timeout',
    run: { runId: 'r', hostId: 'local' },
    observedAt: 10
  }
})

/** 断连但存活 = 第 2 类（我们的流程坏了）。 */
const aliveButDisconnected = agentSession({ state: 'disconnected', processState: 'running' })
/** 断连且退出 = 第 1 类（Agent 真的坏了）。 */
const deadAndDisconnected = agentSession({ state: 'disconnected', processState: 'exited' })
/** 断连、进程既非在跑也非退出 = 分不清。 */
const indeterminate = agentSession({ state: 'disconnected', processState: 'interrupted' })

describe('把一处失败分成四类', () => {
  it('步骤走通了就是完全好的——不打扰', () => {
    const outcome = agentSessionServiceOutcome(agentSession({ state: 'working' }))
    expect(classifyServiceNotice(outcome)).toEqual({ kind: 'healthy' })
    expect(serviceNoticeToRender(classifyServiceNotice(outcome))).toBeNull()
  })

  it('Agent 死了是完全坏了——服务窗不接手，阻断由恢复横幅承载', () => {
    const classification = classifyServiceNotice(agentSessionServiceOutcome(deadAndDisconnected))
    expect(classification.kind).toBe('agent-broken')
    // 完全坏了不渲染服务窗：一个死掉的 Agent，阻断本身就是诚实的。
    expect(serviceNoticeToRender(classification)).toBeNull()
  })

  it('Agent 活着但我们的流程坏了——放行，且绝不静默', () => {
    // 这是原则的样板。第 2 类必须能被看见：拿到一条带三段文案的 notice，而不是 null。
    const classification = classifyServiceNotice(agentSessionServiceOutcome(aliveButDisconnected))
    expect(classification.kind).toBe('process-degraded')
    const rendered = serviceNoticeToRender(classification)
    // 边界一：第 2 类绝不静默放行。这条断言在「alive 也返回 null / healthy」时变红。
    expect(rendered).not.toBeNull()
    expect(rendered!.notice.step).toContain('Reconnecting to this Agent')
    expect(rendered!.notice.mode).toContain('still running')
    expect(rendered!.notice.restore).toContain('Resume')
  })

  it('分不清是哪一类——如实说分不清，不猜一个再照着做', () => {
    const classification = classifyServiceNotice(agentSessionServiceOutcome(indeterminate))
    // 边界二：未知绝不当成好的。这条在「unknown 被折进 healthy / 被当成 alive」时变红。
    expect(classification.kind).toBe('indeterminate')
    const rendered = serviceNoticeToRender(classification)
    expect(rendered).not.toBeNull()
    // 现在按什么状态在跑要如实说「分不清、但你没被阻断」，不冒充「一切正常」。
    expect(rendered!.notice.mode).toContain('can’t confirm')
    // 未知与完全好的必须分得开——这正是原则「不许把未知当成好的」。
    expect(classification.kind).not.toBe('healthy')
  })

  it('三段文案齐全：哪一步、什么状态、怎么恢复', () => {
    // 服务窗要说清的就是这三件事，缺一段都不算说清。
    for (const session of [aliveButDisconnected, indeterminate]) {
      const rendered = serviceNoticeToRender(classifyServiceNotice(agentSessionServiceOutcome(session)))!
      expect(rendered.notice.step.length).toBeGreaterThan(0)
      expect(rendered.notice.mode.length).toBeGreaterThan(0)
      expect(rendered.notice.restore.length).toBeGreaterThan(0)
    }
  })

  it('第 2 类与分不清的「当前状态」措辞不同——不拿降级文案冒充分不清', () => {
    const degraded = serviceNoticeToRender(classifyServiceNotice(agentSessionServiceOutcome(aliveButDisconnected)))!
    const unknown = serviceNoticeToRender(classifyServiceNotice(agentSessionServiceOutcome(indeterminate)))!
    // 分不清不能宣称「进程还在跑」——那正是它分不清的那件事。
    expect(unknown.notice.mode).not.toBe(degraded.notice.mode)
    expect(unknown.notice.mode).not.toContain('still running')
  })
})

describe('把一个 Agent Session 映成步骤结局：看进程，不看我们的连接', () => {
  it('Core 的握手超时事实即使 status 仍是 working 也必须显示服务窗', () => {
    const outcome = agentSessionServiceOutcome(handshakeDegraded)
    const rendered = serviceNoticeToRender(classifyServiceNotice(outcome))
    expect(classifyServiceNotice(outcome).kind).toBe('process-degraded')
    expect(rendered?.notice.step).toContain('terminal capabilities')
    expect(rendered?.notice.mode).toContain('prompts remain available')
    expect(rendered?.notice.restore).toContain('retry')
  })

  it('非 Agent Session 没有服务窗', () => {
    expect(agentSessionServiceOutcome(agentSession({ kind: 'terminal' }))).toEqual({ completed: true })
    expect(agentSessionServiceOutcome(undefined)).toEqual({ completed: true })
  })

  it('没报 disconnected 的 Agent 走通了——不打扰', () => {
    expect(agentSessionServiceOutcome(agentSession({ state: 'working' }))).toEqual({ completed: true })
  })

  it('连接断了但进程在跑 = 第 2 类：我们的流程坏了，Agent 没坏', () => {
    // 判据是「Agent 还能干活吗」（进程在跑），不是「我们的连接过了吗」（连接断了）。
    const outcome = agentSessionServiceOutcome(aliveButDisconnected)
    expect(outcome).toMatchObject({ completed: false, agentViability: 'alive' })
    // 端到端：一个断连但存活的 Agent 落成一条会渲染的服务窗，而不是被静默或被阻断。
    expect(serviceNoticeToRender(classifyServiceNotice(outcome))?.kind).toBe('process-degraded')
  })

  it('连接断了且进程退了 = 第 1 类：Agent 真的坏了', () => {
    const outcome = agentSessionServiceOutcome(deadAndDisconnected)
    expect(outcome).toMatchObject({ completed: false, agentViability: 'dead' })
    expect(classifyServiceNotice(outcome).kind).toBe('agent-broken')
  })

  it('连接断了、进程既非在跑也非退出（interrupted）= 分不清', () => {
    // interrupted 是「不知道」而不是「坏了」：没有证据说进程死了，也没有证据说它好着。
    const outcome = agentSessionServiceOutcome(indeterminate)
    expect(outcome).toMatchObject({ completed: false, agentViability: 'unknown' })
    expect(classifyServiceNotice(outcome).kind).toBe('indeterminate')
  })
})
