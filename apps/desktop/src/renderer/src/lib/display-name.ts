/**
 * 显示名的唯一求值处。
 *
 * 设计合同《显示名与身份》立下两条：名字只用于显示、绝不进入 id/寻址 key/持久化路径；名字有一条
 * 统一的优先级链，任何展示名字的地方都经它求值，仓库里不出现第二份拼名逻辑。这个模块就是那"一处"。
 *
 * 优先级链（自高到低）：
 *   用户手改  >  启动时指定  >  从成员/首条 prompt 派生  >  Provider·Workspace 派生
 *
 * 最低一档「Provider·Workspace 派生」的那串字面（`Codex · workspace`）由 Desktop Main 构建并放在
 * `session.label` 上——那是唯一构建它的地方。本链把它当作 `fallback` 消费，而**不**在渲染层再拼一份：
 * 再拼一份正是本合同禁止的"第二份拼名逻辑"，且两份会在 Provider 改名或 workspace 改名时各自漂移。
 *
 * 只有 `resolveAgentName` 与 `resolveTabName` 对外暴露。`deriveNameFromPrompt`、`tabFamilyName` 是这
 * 条链的内部环节，不单独导出——一个只被同文件调用的导出符号过不了零调用者检查，且把它们藏在链后也
 * 强制了"任何展示名字的地方都经这条链"这条约束（外部拿不到半截逻辑去自己拼）。
 */

/** 名字最终落在哪一档。它是求值结果的一部分（结构化返回），调用方按结构读 `.source`，不按名导入。 */
type DisplayNameSource = 'user' | 'launch' | 'derived' | 'fallback'

type ResolvedDisplayName = {
  name: string
  source: DisplayNameSource
}

/** 空白即视为未指定：空串、纯空格、undefined、null 一律不占据它那一档。 */
function present(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const PROMPT_DERIVED_MAX_LENGTH = 48

/**
 * 从首条 prompt 派生一个名字：取第一段非空文本、压平内部空白、限长。
 *
 * 这是"从成员/首条 prompt 派生"这一档的一个来源。它比从 Provider·Workspace 派生更贴近这个 Agent
 * 实际在做的事，但仍**低于**用户手改与启动时指定——自动来源绝不越过用户意图。
 */
function deriveNameFromPrompt(prompt: string | null | undefined): string | null {
  const trimmed = present(prompt)
  if (!trimmed) return null
  const firstLine = trimmed.split('\n').map((line) => line.trim()).find((line) => line.length > 0)
  if (!firstLine) return null
  const collapsed = firstLine.replace(/\s+/gu, ' ')
  return collapsed.length > PROMPT_DERIVED_MAX_LENGTH
    ? `${collapsed.slice(0, PROMPT_DERIVED_MAX_LENGTH - 1).trimEnd()}…`
    : collapsed
}

/**
 * Agent 显示名：走完整优先级链。
 *
 * `fallback` 是最低一档，通常是 `session.label`（Main 构建的 Provider·Workspace 事实）。它不会缺席——
 * 缺席意味着这个 Agent 连最基本的身份都没有，那是上游的 bug，不该由这里编一个占位掩盖。
 */
export function resolveAgentName(input: {
  /** 用户手改（最高档）。 */
  userName?: string | null | undefined
  /** 启动对话框里指定的名字。 */
  launchName?: string | null | undefined
  /** 首条 prompt / 成员派生。 */
  firstPrompt?: string | null | undefined
  /** Provider·Workspace 派生，通常是 session.label。 */
  fallback: string
}): ResolvedDisplayName {
  const user = present(input.userName)
  if (user) return { name: user, source: 'user' }
  const launch = present(input.launchName)
  if (launch) return { name: launch, source: 'launch' }
  const derived = deriveNameFromPrompt(input.firstPrompt)
  if (derived) return { name: derived, source: 'derived' }
  return { name: input.fallback, source: 'fallback' }
}

/** 一张 View 里的一个 Agent 成员，供 Tab 家族名派生。只带派生所需的两项，不泄露 id 或寻址身份。 */
export type TabAgentMember = {
  /** 这个 Agent 自己经链求值后的显示名。 */
  name: string
  /** Provider 的展示标签（如 "Codex"），用于家族名分组。 */
  providerLabel: string
}

/**
 * Tab 家族名：多个 Agent 共处一张 View 时体现"这是一组 Agent"，而**不显示其中任一个成员名**。
 *
 * 按 Provider 分组计数（`Codex ×2 · Claude`），因此：
 *   - 绝不冒充某一个成员——名字里没有任何成员的显示名；
 *   - 不随哪个 Region 是 title region 而跳变——它对全体成员对称，与顺序无关（按 providerLabel 排序）。
 */
function tabFamilyName(agents: readonly TabAgentMember[]): string {
  const countByProvider = new Map<string, number>()
  for (const agent of agents) {
    countByProvider.set(agent.providerLabel, (countByProvider.get(agent.providerLabel) ?? 0) + 1)
  }
  return [...countByProvider.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, count]) => (count > 1 ? `${label} ×${count}` : label))
    .join(' · ')
}

/**
 * Tab 显示名：默认策略随 Agent 成员数量变化，用户手改后永久停手。
 *
 *   - 用户手改过（`userName` 存在）→ 用它，两条自动策略对这张 Tab 永久停手；
 *   - 启动时指定 → 用它；
 *   - 恰好一个 Agent 成员 → 对齐该 Agent 的名字（两级身份此刻指向同一件事，用户填一次就够）；
 *   - 两个及以上 Agent 成员 → 家族名（见 tabFamilyName）；
 *   - 没有 Agent 成员 → 落到 `fallback`（文件名、"New Tab"、浏览器标题等既有的表面派生）。
 */
export function resolveTabName(input: {
  userName?: string | null | undefined
  launchName?: string | null | undefined
  agents: readonly TabAgentMember[]
  fallback: string
}): ResolvedDisplayName {
  const user = present(input.userName)
  if (user) return { name: user, source: 'user' }
  const launch = present(input.launchName)
  if (launch) return { name: launch, source: 'launch' }
  if (input.agents.length === 1) return { name: input.agents[0]!.name, source: 'derived' }
  if (input.agents.length >= 2) return { name: tabFamilyName(input.agents), source: 'derived' }
  return { name: input.fallback, source: 'fallback' }
}
