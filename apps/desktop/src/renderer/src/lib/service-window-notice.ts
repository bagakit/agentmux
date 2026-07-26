import type { SessionSnapshot } from '../../../shared/contracts'

/**
 * 服务窗（AGENTS.md 原则 11）的判定层：一处失败在阻断用户之前，先分清它是哪一种。
 *
 * 这一层是纯函数，因为要害不是渲染，是**分类**——判据是「Agent 还能干活吗」，不是「我们的检查
 * 过了吗」。同一次超时，进程还活着就是我们的流程坏了（放行 + 提醒），进程退了才是 Agent 坏了
 * （阻断诚实）；分不清时如实说分不清，绝不猜一个再照着做。这些取舍写在 useEffect 里没有断言够
 * 得着（本仓库测试用 renderToStaticMarkup，不跑 effect），拎成纯函数后每一条都能被直接断言。
 */

/**
 * Agent 自身的存活判定——**这才是判据**，与「我们的步骤过没过」分开。
 *
 * `unknown` 是一等状态，不是缺省：分不清是 Agent 死了还是我们的流程断了时，必须如实报 unknown，
 * 由类型强制它不能被 `default` 悄悄折进「完全好的」。
 */
type AgentViability = 'alive' | 'dead' | 'unknown'

/**
 * 我们的一个中间步骤。三段文案就是服务窗要说清的三件事：哪一步没走通、现在按什么状态在跑、
 * 要恢复完整能力该做什么。
 */
type ProcessStep = {
  /** 步骤名（名词短语），分类器据此拼出「X didn't complete」。 */
  label: string
  /** 放行之后 Session 以什么状态在跑（第 2 类用）。 */
  degradedMode: string
  /** 恢复完整能力的具体动作。 */
  restore: string
}

/**
 * 一个步骤的结局。步骤走通了就没有可分类的失败；没走通才进入分类，且必须带上 Agent 的存活判定。
 * 用 discriminated union 让「走通了」这一支根本不需要提供文案——没有失败就没有服务窗。
 */
type StepOutcome =
  | { completed: true }
  | { completed: false; step: ProcessStep; agentViability: AgentViability }

/** 服务窗要显示的三行。 */
type ServiceNotice = {
  /** 哪一步没走通。 */
  step: string
  /** 现在按什么状态在跑。 */
  mode: string
  /** 要恢复完整能力该做什么。 */
  restore: string
}

/**
 * 四种归类。前三种是原则里的「完全坏了 / 我们的流程坏了 / 完全好的」，第四种「分不清」是原则
 * 明令必须显式存在、不能当成好的那一类。只有会渲染服务窗的两类带 `notice`。
 */
type ServiceNoticeClass =
  | { kind: 'agent-broken' } // 完全坏了：Agent 本身不行了，阻断是诚实的——服务窗不接手（既有恢复横幅承载）。
  | { kind: 'process-degraded'; notice: ServiceNotice } // 我们的流程坏了：放行 + 提醒。
  | { kind: 'indeterminate'; notice: ServiceNotice } // 分不清：不阻断、不静默，如实说分不清。
  | { kind: 'healthy' } // 完全好的：不打扰。

/** 会渲染成服务窗的那两类——它们各自带一条 notice。 */
export type RenderableServiceNotice = Extract<ServiceNoticeClass, { notice: ServiceNotice }>

/**
 * 把一个步骤结局分成四类。
 *
 * `agentViability` 的 switch **没有 default**：这是原则「不许把未知当成好的」的类型级兑现——
 * 少写一个分支会编译不过，而不是安静地漏成 healthy。
 */
export function classifyServiceNotice(outcome: StepOutcome): ServiceNoticeClass {
  // 步骤走通了：我们没有制造任何失败，不打扰。
  if (outcome.completed) return { kind: 'healthy' }

  const { step, agentViability } = outcome
  switch (agentViability) {
    case 'dead':
      // 完全坏了。服务窗不接手：一个死掉的 Agent，阻断本身就是诚实的，由既有恢复横幅承载。
      return { kind: 'agent-broken' }
    case 'alive':
      // Agent 活得好好的，是我们的流程坏了。绝不阻断——放行，同时把状态说清楚。
      return {
        kind: 'process-degraded',
        notice: {
          step: `${step.label} didn’t complete`,
          mode: step.degradedMode,
          restore: step.restore
        }
      }
    case 'unknown':
      // 分不清是哪一类。不阻断（没证据说 Agent 死了），也不静默（没证据说它好着）——如实说分不清。
      return {
        kind: 'indeterminate',
        notice: {
          step: `${step.label} didn’t complete`,
          mode: 'We can’t confirm whether the Agent itself is affected — you are not blocked',
          restore: step.restore
        }
      }
  }
}

/**
 * 从归类里取出要渲染的服务窗，healthy 与 agent-broken 得到 null。
 *
 * 「哪些类要渲染」是一个判定，所以留在这一层被断言，而不是散在组件的 JSX 里：第 2 类与分不清
 * 都必须非 null（绝不静默），完全好的与完全坏了都为 null（前者不打扰，后者由恢复横幅承载）。
 */
export function serviceNoticeToRender(classification: ServiceNoticeClass): RenderableServiceNotice | null {
  return 'notice' in classification ? classification : null
}

/**
 * 一个真实渲染点用到的映射：把 Agent Session 的诚实事实映成一个步骤结局。
 *
 * 这里只读会真实发生、且不属于两个尚未接线的消费者（启动握手超时、重启后会话恢复）的信号：
 * Agent 报 `disconnected`——我们与它的连接断了。它自己还活着吗？**看进程，不看我们的连接**：
 * 进程在跑就是第 2 类（连接断了、Agent 没坏），进程退了才是第 1 类，既非在跑也非退出（interrupted）
 * 就是分不清。非 Agent、或没报 disconnected 的，都是走通了——不打扰。
 */
export function agentSessionServiceOutcome(session: SessionSnapshot | undefined): StepOutcome {
  if (!session || session.kind !== 'agent') return { completed: true }

  // Core's durable marker is stronger than an inferred disconnected status: it says exactly which
  // workflow step timed out while this Run remained usable. Project it directly so a healthy Agent is
  // never painted as failed and the notice survives reconnect/restart snapshots.
  if (session.terminalCapability?.reason === 'handshake-timeout') {
    const step: ProcessStep = {
      label: 'Checking terminal capabilities',
      degradedMode: 'The Agent is still usable; terminal capability is unknown and prompts remain available',
      restore: 'Resume this session to retry the capability check'
    }
    if (session.processState === 'running') {
      return { completed: false, step, agentViability: 'alive' }
    }
    if (session.processState === 'exited') {
      return { completed: false, step, agentViability: 'dead' }
    }
    return { completed: false, step, agentViability: 'unknown' }
  }

  if (session.status.state !== 'disconnected') return { completed: true }

  const step: ProcessStep = {
    label: 'Reconnecting to this Agent',
    degradedMode: 'The Agent process is still running; only this window’s link to it dropped',
    restore: 'Resume the session to reattach'
  }
  if (session.processState === 'running') {
    return { completed: false, step, agentViability: 'alive' }
  }
  if (session.processState === 'exited') {
    return { completed: false, step, agentViability: 'dead' }
  }
  // interrupted：连接断了，进程既非明确在跑也非明确退出——分不清，如实说，不猜。
  return { completed: false, step, agentViability: 'unknown' }
}
