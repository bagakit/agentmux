import type { AgentMuxRunState } from '@agentmux/core'
import type { SessionSnapshot } from '../../../shared/contracts'
import { CONNECTION_UNRECOVERABLE_DETAIL } from './session-state'

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
 * 从进程事实映出 Agent 的存活判定——**唯一一处**，四个渲染点共用。
 *
 * 判据是「进程还在跑吗」，不是「我们的连接/步骤过了吗」：`running` 是活着（第 2 类，放行 + 提醒），
 * `exited` 是死了（第 1 类，交给恢复横幅），`interrupted`（连接断了、进程既非明确在跑也非明确退出）
 * 是分不清——`unknown` 是一等状态，绝不折进 alive 或 dead。
 *
 * 用 `Record<AgentMuxRunState, …>` 总映射而不是 switch/ternary，是因为这**就是验收判据**：给
 * `AgentMuxRunState` 加一个成员，这张表少一格会让 tsc 变红，而不是安静落进某个 `default`/末尾三元
 * 分支被当成 `unknown`。此前这段映射在四处手抄，任何一处写错都无编译器、无测试拦得住。
 */
const AGENT_VIABILITY_BY_PROCESS_STATE: Record<AgentMuxRunState, AgentViability> = {
  running: 'alive',
  exited: 'dead',
  interrupted: 'unknown'
}

export function agentViabilityFromProcessState(processState: AgentMuxRunState): AgentViability {
  return AGENT_VIABILITY_BY_PROCESS_STATE[processState]
}

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
 *
 * 导出是因为消费方不止一个（握手降级、终端揭示超时……），它们各自把自己那一步映成这个类型，
 * 再共用下面的分类器。让每个消费方自带一份等价定义，等于让「什么算一次失败」有第二个说法。
 */
export type StepOutcome =
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
 * 每一类通报的音量。**档位是分类的派生值**——不由调用点各自挑，也不另起第二个枚举：kind 已 1:1 承载
 * 存活判定（`process-degraded`⟸alive、`indeterminate`⟸unknown、`agent-broken`⟸dead），按 kind 映射
 * 就是「由 agentViability 推导」。用 `Record` 总映射的理由同 `AGENT_VIABILITY_BY_PROCESS_STATE`（见上）：
 * 新增一类会让 tsc 变红。`assertive` 只给 dead，alive/unknown 都 `polite`——降级轻声说，不喊狼来了。
 *
 * 诚实一句：`serviceNoticeToRender` 对 `agent-broken` 与 `healthy` 都返回 null，所以服务窗只会渲染
 * `process-degraded`/`indeterminate`（都 polite），`assertive` 这一档**在本渲染面没有消费方**。
 * 它不是无用的占位：这张表已经是第二个渲染面的音量来源——`TransientErrorNotice`（`reportError` 的唯一
 * 出口，~69 处调用全走它）原先一律硬编码 assertive，现在改为向本函数取音量（见该组件文件头）。
 * 也就是说轴已经收敛成一条，两个渲染面共用，没有第二张严重度表。
 *
 * 但 `assertive` 至今仍**没有生产代码走到**：`App.tsx` 渲染 TransientErrorNotice 时不传 `kind`，
 * 于是全部落在默认的 `indeterminate`。差的不是通路而是标注——要让某条结局真的喊出来，得由知道
 * 「Agent 确实没了」的那个调用点显式传 `kind="agent-broken"`。逐个标注 ~69 处调用点是后续工作；
 * 在那之前 assertive 只被单元测试钉住，这句话就得继续留着。
 *
 * f-25n8fzxzw 的处置：它的诊断（重连失败后字进沉默终端）成立，但它开的方子（status==='error' 时
 * canSubmit=false）是 RED-LINES.md 的红线，已由 8a62269b 反向钉死。它的真实残值是「把降级如实告知」
 * 那一半（T-002），并入本 feature，不单独立项，也不在此重演那个被否决的置灰。
 */
type ServiceNoticeAriaLive = 'polite' | 'assertive'

const SERVICE_NOTICE_ARIA_LIVE: Record<ServiceNoticeClass['kind'], ServiceNoticeAriaLive> = {
  healthy: 'polite',
  'process-degraded': 'polite',
  indeterminate: 'polite',
  'agent-broken': 'assertive'
}

/** 通报音量：由 kind（承载存活判定）派生，组件消费而非自行重算。 */
export function serviceNoticeAriaLive(kind: ServiceNoticeClass['kind']): ServiceNoticeAriaLive {
  return SERVICE_NOTICE_ARIA_LIVE[kind]
}

/**
 * 一个真实渲染点用到的映射：把 Agent Session 的诚实事实映成一个步骤结局。
 *
 * 先读 Core 落下的 durable marker（下面的 handshake-timeout、reattach-failed 分支——它们比推断出的
 * status 更权威，且挺过快照刷新），再退到 status：Agent 报 `disconnected`——我们与它的连接断了。它自己
 * 还活着吗？**看进程，不看我们的连接**：进程在跑就是第 2 类（连接断了、Agent 没坏），进程退了才是第 1 类，
 * 既非在跑也非退出（interrupted）就是分不清。非 Agent、或没有任何失败信号的，都是走通了——不打扰。
 *
 * 「重启后会话恢复」是唯一还没接线的消费者：它落地后会在这里多加一个自己的 marker 分支，共用同一存活判定。
 */
export function agentSessionServiceOutcome(session: SessionSnapshot | undefined): StepOutcome {
  if (!session || session.kind !== 'agent') return { completed: true }

  // Core's durable marker is stronger than an inferred disconnected status: it says exactly which
  // workflow step timed out while this Run remained usable. Project it directly so a healthy Agent is
  // never painted as failed and the notice survives reconnect/restart snapshots.
  //
  // restore 这句**不给动作**，因为这个状态下一个动作都没有——这不是偷懒，是实测的结论：
  //   · 这条 marker 只在 Run **还在跑**时才落得下（client.ts 的 requireRunningTerminalHandshakeRun
  //     对非 running 一律抛错），所以「等它退出再 Resume」不是这条告示要回答的局面；
  //   · Resume 对 running 的 Run 在 ensureAgentContinuity 就判出 `reattachable` 直接返回投影，
  //     不进 attach；就算走到 resumeAgentRun 也会撞 'Cannot resume while the original Run is
  //     still running.'；
  //   · 而 ensureTerminalHandshake 见到「有 marker 且握手未 acknowledged」就早退（client.ts:3012），
  //     注释写明是刻意的——不在每次重连/提交上再武装一个十秒观察者。清除 marker 的
  //     clearTerminalCapability 只在那个早退的下游被调用，因此本 Run 内无法重新触发。
  //   · 重挂这块 pane 也没用：那条路清的是 terminalOutputChannel（attachAgentRun → clearOutputChannel），
  //     碰不到 terminalCapability。
  // 也就是说：这项能力在这个 Run 的余生里就是未知。如实说「下个 Run 会重新探测」，而不是点名一个
  // 按下去什么都不会发生的 Resume——点名一个空动作比不点名更糟（原则 11 / RED-LINES）。
  if (session.terminalCapability?.reason === 'handshake-timeout') {
    const step: ProcessStep = {
      label: 'Checking terminal capabilities',
      degradedMode: 'The Agent is still usable; terminal capability is unknown and prompts remain available',
      restore: 'Nothing to do here — this Run keeps running, and the next one probes again'
    }
    return { completed: false, step, agentViability: agentViabilityFromProcessState(session.processState) }
  }

  // Core 落下的「输出通道断了、进程没死」事实，比推断出的 disconnected 更权威：重连本身成功了，是
  // 这一个 Run 的实时输出泵没能重建（client.ts 的 `resumed === 'dead'`）。输入照常送达 Agent，但它的
  // 输出永远到不了这块屏——不告知的话用户对着一块永不回显的屏幕打字。直接投影这条事实（进程在跑就是
  // 第 2 类，放行 + 提醒），它挺过视图切换与快照刷新，直到一次成功的 reattach 撤下它。
  //
  // restore 这句刻意**不说 Resume**，尽管清除这条事实的 Core 侧函数确实叫 reattach、而 Resume 的注释
  // 也声称走那条路。实测不是：这条降级只在进程**还在跑**时产生，而 Resume 走
  // `ensureAgentContinuity`，对一个 running 的 Run 判出 `reattachable` 就直接返回投影——
  // 全程 attach 调用数为 0，标记原样留着（对 client 实跑验证过：verdict=reattachable、attach 0 次、
  // 标记仍在）。也就是说 Resume 在这个状态下按了等于没按。
  //
  // 真正能撤下它的是让这块屏**重新挂载**：卸载时 TerminalView 会 detach（runtime-controller 随之
  // 丢掉 attachment owner），重新挂载时 `existing` 缺席，于是走 `reattachAgent` → `attachAgentRun`
  // → `clearOutputChannel`。
  //
  // 点名 Terminal/Activity 这个切换，而不是「切走再切回 tab」：后者要等冷却
  // （TERMINAL_COLD_PARK_DELAY_MS = 30s，且还要过 TTL 或被挤出热集）才真的卸载，用户照字面做
  // ——切走、马上切回——屏幕仍是热的、根本不重挂，于是什么都不会发生。这条视图切换是
  // SessionPane 里一个真正的条件卸载，立即生效，且 pane 上就有那个带标签的按钮。
  // 这条告示在两个视图下都会出现，所以措辞取「切到 Activity 再切回 Terminal」这个双向都说得通的
  // 来回，而不是预设用户此刻在哪一侧。
  if (session.terminalOutputChannel?.reason === 'reattach-failed') {
    const step: ProcessStep = {
      label: 'Reattaching this window’s output',
      degradedMode: 'Output may not be showing here, but your input still reaches the Agent',
      restore: 'Switch this pane to Activity and back to Terminal to reattach its output'
    }
    return { completed: false, step, agentViability: agentViabilityFromProcessState(session.processState) }
  }

  if (session.status.state !== 'disconnected') return { completed: true }

  // 失联分两类，这条告示的文案也必须分两类——判据取自 `status.detail`（连接投影写下的那对 SSOT 常量），
  // 而不是另起一个状态位：状态位就是 `disconnected`，两类共用它。
  //
  // 为什么这道分岔非做不可：终端视图的恢复横幅已经分了这两类，但那个横幅**只在终端分支里**。Agent 在
  // Activity（对话）视图下唯一可见的失联文案就是这条告示——不在这里分，抖动预算用尽后的终局会一直说
  // 「Reconnecting」，而实际上没有任何东西在重试。用户对这两种局面的正确反应完全相反（等 vs 动手），
  // 把终局伪装成暂时是这条路上最坏的谎话。
  // 两条 degradedMode 刻意**不共用**任何进行时的安慰词：「进程还在跑」是「重连中」那条的全部安慰，
  // 而终局要说的恰恰是另一件事——自动恢复停了。终局这句也刻意不写成否定式（「没有东西在重试」要读者
  // 先解析一个否定），直接说「已停止」。
  const step: ProcessStep = session.status.detail === CONNECTION_UNRECOVERABLE_DETAIL
    ? {
        label: 'Automatic recovery on this host',
        degradedMode: 'Automatic recovery has stopped — waiting will not clear this',
        restore: 'Resume this session to reattach; your Agent may still be alive on that host'
      }
    : {
        label: 'Reconnecting to this Agent',
        degradedMode: 'The Agent process is still running; only this window’s link to it dropped',
        restore: 'Resume the session to reattach'
      }
  // 看进程，不看我们的连接：进程在跑是第 2 类（连接断了、Agent 没坏），退了是第 1 类，
  // interrupted（既非明确在跑也非明确退出）是分不清——如实说，不猜。
  return { completed: false, step, agentViability: agentViabilityFromProcessState(session.processState) }
}

/** Core owns delivery evidence; this notice survives view switches and snapshot refreshes. */
export function agentPromptDeliveryServiceOutcome(session: SessionSnapshot | undefined): StepOutcome {
  if (!session || session.kind !== 'agent' || !session.terminalPromptDelivery) return { completed: true }
  const steps: Record<NonNullable<typeof session.terminalPromptDelivery>['reason'], string> = {
    'screen-evidence-gap': 'Screen confirmation from retained terminal output',
    'prompt-render-timeout': 'Confirming the prompt on screen',
    'screen-evidence-replaced': 'Confirming the prompt while the terminal refreshed'
  }
  return {
    completed: false,
    step: {
      label: steps[session.terminalPromptDelivery.reason],
      degradedMode: session.terminalPromptDelivery.reason === 'screen-evidence-gap'
        ? 'Earlier terminal output is no longer retained. Prompt input continued without full screen confirmation.'
        : 'Prompt input continued without full screen confirmation.',
      restore: 'Check the Agent’s response. You can review this notice in System; a verified prompt clears it.'
    },
    agentViability: agentViabilityFromProcessState(session.processState)
  }
}
