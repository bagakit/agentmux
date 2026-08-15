import type { AgentTurnUsage } from '@agentmux/core'
import type { SessionSnapshot } from '../../../shared/contracts'

// 一个 Agent 的 token 用量在名册里怎么显示。
//
// 难的不是渲染，而是**把三种真值分清楚，且一种都不塌成误导性的 0**（验收 1/3/6）：
//   1. 这个 Provider 报真实用量，且已经跑完过一个 turn —— 显示那一 turn 的真实 token 数；
//   2. 这个 Provider 报用量，但还没有一个完成的 turn —— 显示"不知道"记号，不是 0；
//   3. 这个 Provider 根本不报用量 —— 明说"不报"，不是 0、不是空洞、更不是字节估算。
// 三者用一个带 kind 的联合表达，好让行为测试逐个钉住，也让渲染层不必自己判空。

export type AgentUsageDisplay =
  // Provider 报了真实用量且有一 turn：text 是紧凑数字，title 是这一 turn 的分项明细。
  | { kind: 'tokens'; text: string; title: string }
  // Provider 报用量但还没有完成的 turn：一个中性记号，读作"还不知道"，与"是 0"分得开。
  | { kind: 'awaiting'; text: string; title: string }
  // Provider 不报用量：明说不报，绝不显示 0 或任何估算。
  | { kind: 'unsupported'; text: string; title: string }

/** 拿不到数时的中性记号，沿用资源面板同一个符号，全窗口"不知道"长一个样。 */
const UNKNOWN = '—'

/**
 * 上下文窗口用掉了百分之几；答不上来就是 `null`，**绝不塌成 0**。
 *
 * 这是全窗口唯一一处这个判定。此前它长在两个地方——`AgentContextUsage.tsx` 的 `known`/`used`，和
 * `project-activity-row.ts` 的 `contextPercent`（后者注释里写着「照抄 6 行」，并留了 `ponytail:`
 * 说「若第三处也要它，再抽到 agent-usage.ts」）。名册就是那第三处，所以搬到这里，而不是抄第三份。
 *
 * 为什么这 6 行值得抽：它判的不是「怎么算百分比」，而是**「这个数到底知不知道」**。三个条件
 * （容量有限且为正、已用有限且非负、context 在场）任一不成立都必须读作「这个 Provider 此刻没报」。
 * 抄三份的代价不是重复，是**漂移**：哪天有人在其中一处加上 `capacityTokens >= usedTokens` 的校验，
 * 另外两处就会对同一个 Session 给出不同的「知不知道」，而这三处分别画在输入框、项目行和名册上——
 * 同一个 Agent 在三个地方显示三种状态，谁都不知道信哪个。
 *
 * 返回 `null` 而不是 0：0 的意思是「查过了，一点没用」，`null` 是「没报」。把没报显示成 0%，
 * 用户会以为这个 Agent 刚开始跑，而它可能正要被压缩。
 */
export function contextUsedPercent(context: AgentTurnUsage['context'] | undefined): number | null {
  if (!context) return null
  if (!Number.isFinite(context.capacityTokens) || context.capacityTokens <= 0) return null
  if (!Number.isFinite(context.usedTokens) || context.usedTokens < 0) return null
  return Math.min(100, Math.max(0, Math.round((context.usedTokens / context.capacityTokens) * 100)))
}

/**
 * 把 token 数压成紧凑可读串：987 → "987"，12432 → "12.4k"，1_200_000 → "1.2M"。
 *
 * 名册一行地方有限，裸的五位数字读起来费劲；k/M 到一位小数够用，更细的位数只是噪音。
 * 负数不该出现（token 数非负），真出现就原样显示，让异常可见而不是被 format 吞掉。
 */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return String(tokens)
  if (tokens < 1000) return String(tokens)
  if (tokens < 1_000_000) {
    const k = tokens / 1000
    // 10k 以上不留小数（10.0k 读起来啰嗦），10k 以下留一位（1.2k 比 1k 有信息）。
    return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`
  }
  const m = tokens / 1_000_000
  return `${m >= 10 ? Math.round(m) : m.toFixed(1)}M`
}

/**
 * 从一个 Agent Session 的自描述投影里算出它的用量显示。
 *
 * 只读 SessionSnapshot 自己带的两件事实：`capabilities.usage`（这个 Provider 报不报用量、是 catalog 的
 * SSOT 投影）和 `turnUsage`（最近一 turn 的真实数）。不碰 providerCatalog、不做任何按 Provider 名的
 * 硬编码分支——能力声明在哪，判断就依据哪，新增一个报用量的 Provider 无需改这里。
 */
export function agentUsageDisplay(
  session: Extract<SessionSnapshot, { kind: 'agent' }>
): AgentUsageDisplay {
  // 未声明 usage 能力：这个 Provider 不报 token 用量。明说，不留 0、不留空洞（验收 1/6）。
  if (!session.capabilities.usage) {
    return {
      kind: 'unsupported',
      text: 'no token usage',
      title: 'This provider does not report token usage.'
    }
  }
  const usage = session.turnUsage
  // 声明了能力但还没有一 turn 的真实数：显示"不知道"，不编 0。
  if (!usage) {
    return {
      kind: 'awaiting',
      text: UNKNOWN,
      title: 'No completed turn yet — token usage appears after the first turn finishes.'
    }
  }
  // 有真实数：显示 output token（最接近"这一步产出了多少"），title 给出 turn 的分项。刻意不含任何 /s——
  // 速率的分母（turn 墙钟时长）含思考、审批、工具、网络往返，是不可验证的数，真实分子除以它仍是编的数。
  return {
    kind: 'tokens',
    text: `${formatTokenCount(usage.outputTokens)} tok`,
    title:
      `Last turn · in ${usage.inputTokens.toLocaleString()} · ` +
      `out ${usage.outputTokens.toLocaleString()} · ` +
      `total ${usage.totalTokens.toLocaleString()} tokens`
  }
}
