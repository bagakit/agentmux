/**
 * 内置 Provider 的 id 全集，作为运行时 SSOT——这一个元组同时派生出 {@link BuiltInAgentProviderId}
 * 类型，也是守卫可以真正拿在手里的**值**。
 *
 * 为什么必须是元组而不是纯类型 union：`AgentProviderId` 会拓宽成 `string`，所以「union 里有没有这个
 * id」在运行时**无迹可寻**——从 union 删掉一家（比如误删 `'droid'`）既不会编译报错，也没有任何测试能
 * 发红。把 id 集合物化成元组后，`test/provider-conformance.test.ts` 那条守卫才能断言「union 列出的、
 * providers/ 目录里真实存在的、以及 BUILT_IN_AGENT_PROVIDERS 真正注册进去的」三方集合逐一相等，
 * 三者漂移时立刻发红。这与 `types.ts` 里 `RISK_TIERS` 的做法同源：元组是 SSOT，类型从它派生。
 *
 * 本文件刻意不 import 任何 node 内置模块，好让 Desktop Renderer 能直接用这份身份清单，
 * 而不必把 Core 的 process/filesystem 运行时一并拖进渲染进程。
 */
export const BUILT_IN_AGENT_PROVIDER_IDS = [
  'codex',
  'claude',
  'traex',
  'hermes',
  'pi',
  'grok',
  'gemini',
  'antigravity',
  'cursor',
  'kimi',
  'droid',
  'copilot',
  'opencode'
] as const

export type BuiltInAgentProviderId = (typeof BUILT_IN_AGENT_PROVIDER_IDS)[number]
export type AgentProviderId = BuiltInAgentProviderId | (string & {})

/**
 * 每家内置 Provider 的展示名，与 id 全集同住一个 node-free 模块。
 *
 * 为什么在这里而不是只留在各 `providers/*.ts` 的 catalog 里：catalog 那份是真 SSOT，但取到它必须
 * import `providers/index.js`，而那条路会拖进 `node:path` / `node:crypto`——渲染进程与 Web 预览都
 * 到不了。于是「这家叫什么」在仓里曾有**四份**取值：core catalog、Desktop 的
 * `AgentProviderIcon.tsx`、主进程的 `config-store.ts` 默认表，以及 Web 预览 `api.ts` 里一句
 * `id.charAt(0).toUpperCase() + id.slice(1)`。前三份靠手抄恰好一致，第四份是算的，而算法对
 * 13 家里的 2 家算错：`traex → Traex`（真值 `TraeX`）、`opencode → Opencode`（真值 `OpenCode`）。
 *
 * 当时的守卫为什么没抓住：`agent-provider-icon.test.ts` 只断言 `agentProviderLabel(id) !== id`，
 * 「不等于 id」对 `Traex` 也成立。判据比缺陷粗一档，于是 11 家恰好对上就够它绿了
 *（记忆 sampled-pair-can-be-the-blind-spot / 数符号名守不住别的拼法）。
 *
 * 现在只剩两份取值，且 `provider-conformance.test.ts` 里那条守卫**逐 id 双向**把这张表钉在
 * catalog 的 `label` 上：多一家、少一家、或任何一家取值不同，都红。剩下的消费者一律 import
 * 这张表，不再自己算、也不再手抄。
 */
export const BUILT_IN_AGENT_LABELS = {
  codex: 'Codex',
  claude: 'Claude',
  traex: 'TraeX',
  hermes: 'Hermes',
  pi: 'Pi',
  grok: 'Grok',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  cursor: 'Cursor',
  kimi: 'Kimi',
  droid: 'Droid',
  copilot: 'Copilot',
  opencode: 'OpenCode'
} as const satisfies Record<BuiltInAgentProviderId, string>

/**
 * 展示名。不是内置 Provider（用户自建 executor）时原样回显 id——那时没有别的信息，而回显 id
 * 至少让用户认得出自己填的是哪一个。
 */
export function builtInAgentProviderLabel(providerId: AgentProviderId): string {
  return Object.prototype.hasOwnProperty.call(BUILT_IN_AGENT_LABELS, providerId)
    ? BUILT_IN_AGENT_LABELS[providerId as BuiltInAgentProviderId]
    : providerId
}
