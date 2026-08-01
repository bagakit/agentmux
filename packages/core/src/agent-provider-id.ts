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
