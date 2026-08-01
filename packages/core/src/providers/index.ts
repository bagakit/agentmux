import type { AgentManagedHookPlan } from '../managed-hook-installer.js'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import type { AgentProviderId } from '../types.js'
import { createAntigravityManagedHookPlan, createAntigravityProvider } from './antigravity.js'
import { createClaudeManagedHookPlan, createClaudeProvider } from './claude.js'
import { createCodexManagedHookPlan, createCodexProvider } from './codex.js'
import { createCursorManagedHookPlan, createCursorProvider } from './cursor.js'
import { createGeminiManagedHookPlan, createGeminiProvider } from './gemini.js'
import { createGrokManagedHookPlan, createGrokProvider } from './grok.js'
import { createHermesManagedHookPlan, createHermesProvider } from './hermes.js'
import { createPiProvider } from './pi.js'
import { createTraexProvider } from './traex.js'

export type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider
export type ManagedHookPlanResolver = (
  workspacePath: string,
  env?: Readonly<Record<string, string>>
) => AgentManagedHookPlan

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
    createCursorProvider(defineAgentProvider)
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
  cursor: (workspacePath, env) => createCursorManagedHookPlan(workspacePath, env)
}

export {
  createAntigravityManagedHookPlan,
  createClaudeManagedHookPlan,
  createCodexManagedHookPlan,
  createCursorManagedHookPlan,
  createGeminiManagedHookPlan,
  createGrokManagedHookPlan,
  createHermesManagedHookPlan
}
export { createAntigravityProvider } from './antigravity.js'
export { createClaudeProvider } from './claude.js'
export { createCodexProvider } from './codex.js'
export { createCursorProvider } from './cursor.js'
export { createGeminiProvider } from './gemini.js'
export { createGrokProvider } from './grok.js'
export { createHermesProvider } from './hermes.js'
export { createPiProvider } from './pi.js'
export { createTraexProvider } from './traex.js'
