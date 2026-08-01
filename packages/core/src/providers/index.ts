import type { AgentManagedHookPlan } from '../managed-hook-installer.js'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import type { AgentProviderId } from '../types.js'
import { createAntigravityManagedHookPlan, createAntigravityProvider } from './antigravity.js'
import { createClaudeManagedHookPlan, createClaudeProvider } from './claude.js'
import { createCodexManagedHookPlan, createCodexProvider } from './codex.js'
import { createCopilotManagedHookPlan, createCopilotProvider } from './copilot.js'
import { createCursorManagedHookPlan, createCursorProvider } from './cursor.js'
import { createDroidManagedHookPlan, createDroidProvider } from './droid.js'
import { createGeminiManagedHookPlan, createGeminiProvider } from './gemini.js'
import { createGrokManagedHookPlan, createGrokProvider } from './grok.js'
import { createHermesManagedHookPlan, createHermesProvider } from './hermes.js'
import { createKimiProvider } from './kimi.js'
import { createOpenCodeManagedHookPlan, createOpenCodeProvider } from './opencode.js'
import { createPiManagedHookPlan, createPiProvider } from './pi.js'
import { createTraexProvider } from './traex.js'

export type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider
/**
 * `endpoint` 只在启动路径存在（那时 Binding 已建好）。写**命令**的 Provider 用不到它——命令在运行时
 * 从自己进程的环境变量读 URL/token；写**投递代码**的 Provider（opencode 的 JS 插件跑在 OpenCode 自己
 * 进程里，看不到 PTY 环境）必须在安装那一刻把它内联进文件。
 *
 * 返回 `null` 表示「这次不该装」：修复路径没有 Binding，需要 endpoint 的 Provider 必须在那里如实弃权，
 * 而不是写一份带死 token 的配置出去。
 */
export type ManagedHookPlanResolver = (
  workspacePath: string,
  env?: Readonly<Record<string, string>>,
  endpoint?: { url: string; token: string }
) => AgentManagedHookPlan | null

/** Composition-only list. Provider-specific definitions live in their own modules. */
export function createBuiltInAgentProviders(defineAgentProvider: ProviderFactory): readonly AgentProvider[] {
  return [
    createCodexProvider(defineAgentProvider),
    createClaudeProvider(defineAgentProvider),
    createTraexProvider(defineAgentProvider),
    createHermesProvider(defineAgentProvider),
    createPiProvider(defineAgentProvider),
    createGrokProvider(defineAgentProvider),
    createGeminiProvider(defineAgentProvider),
    createAntigravityProvider(defineAgentProvider),
    createCursorProvider(defineAgentProvider),
    createKimiProvider(defineAgentProvider),
    createDroidProvider(defineAgentProvider),
    createCopilotProvider(defineAgentProvider),
    createOpenCodeProvider(defineAgentProvider)
  ]
}

/** Managed hook installers are composed by Provider id; the registry has no provider-specific branches. */
export const MANAGED_HOOK_PLAN_RESOLVERS: Partial<Record<AgentProviderId, ManagedHookPlanResolver>> = {
  codex: (workspacePath) => createCodexManagedHookPlan(workspacePath),
  claude: (workspacePath) => createClaudeManagedHookPlan(workspacePath),
  antigravity: (_workspacePath) => createAntigravityManagedHookPlan(),
  hermes: (_workspacePath, env) => createHermesManagedHookPlan(env),
  // grok 只装到用户 home 下 `~/.grok/hooks/`（grok 文档标注 always-trusted），与 workspace 无关。
  grok: (_workspacePath) => createGrokManagedHookPlan(),
  // gemini 装到 `~/.gemini/settings.json` 的 hooks 键，同样与 workspace 无关。注意 Antigravity 用的是
  // 同一目录下的 `config/hooks.json`——不同文件，别写串。
  gemini: (_workspacePath) => createGeminiManagedHookPlan(),
  // cursor 是唯一**必须**拿到 workspacePath 的：它的 trust marker 路径按 workspace 派生
  // （`~/.cursor/projects/<slug>/.workspace-trusted`），hooks 配置本身仍在 user 层。
  cursor: (workspacePath, env) => createCursorManagedHookPlan(workspacePath, env),
  // droid 装到 `<FACTORY_HOME_OVERRIDE ?? HOME>/.factory/hooks.json`，与 workspace 无关。
  droid: (_workspacePath, env) => createDroidManagedHookPlan(env),
  // copilot 装到 `<COPILOT_HOME ?? ~/.copilot>/hooks/agentmux.json`——它自己独占的一份文件
  // （那个目录下任意文件名都会被加载），与 workspace 无关。绝不碰用户的 `config.json`。
  copilot: (_workspacePath, env) => createCopilotManagedHookPlan(env),
  // opencode 是唯一**必须**拿到 endpoint 的：它装的是一个 JS 插件文件，插件跑在 OpenCode 自己的进程里，
  // 拿不到 AgentMux 注入 PTY 的 `AGENTMUX_HOOK_URL`/`TOKEN`，所以 URL 与 token 必须在写盘时内联。
  // 没有 endpoint（修复路径）时如实返回 null——写一份带死 token 的插件比不写更坏：它会静默地把每个
  // 事件 POST 到一个已失效的凭证上，看起来装好了，实际一条都收不到。
  opencode: (_workspacePath, env, endpoint) =>
    endpoint ? createOpenCodeManagedHookPlan(endpoint.url, endpoint.token, env) : null,
  // pi 装的也是一份 JS 文件（Pi 的扩展面就是 in-process JS，没有「写一条命令」那条通路），但与 opencode
  // 相反**不需要 endpoint**：Pi 是 AgentMux 通过 PTY 起的进程，扩展在它里面能直接读到我们注入的
  // `AGENTMUX_HOOK_URL`/`TOKEN`。所以内容在运行时取值，token 一个字节都不落盘，修复路径也照常可装。
  pi: (_workspacePath, env) => createPiManagedHookPlan(env)
}

export {
  createAntigravityManagedHookPlan,
  createClaudeManagedHookPlan,
  createCodexManagedHookPlan,
  createCopilotManagedHookPlan,
  createCursorManagedHookPlan,
  createDroidManagedHookPlan,
  createGeminiManagedHookPlan,
  createGrokManagedHookPlan,
  createHermesManagedHookPlan,
  createOpenCodeManagedHookPlan,
  createPiManagedHookPlan
}
export { createAntigravityProvider } from './antigravity.js'
export { createClaudeProvider } from './claude.js'
export { createCodexProvider } from './codex.js'
export { createCopilotProvider } from './copilot.js'
export { createCursorProvider } from './cursor.js'
export { createDroidProvider } from './droid.js'
export { createGeminiProvider } from './gemini.js'
export { createGrokProvider } from './grok.js'
export { createHermesProvider } from './hermes.js'
export { createKimiProvider } from './kimi.js'
export { createOpenCodeProvider } from './opencode.js'
export { createPiProvider } from './pi.js'
export { createTraexProvider } from './traex.js'
