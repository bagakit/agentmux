import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import { createAntigravityProvider } from './antigravity.js'
import { createClaudeProvider } from './claude.js'
import { createCodexProvider } from './codex.js'
import { createCopilotProvider } from './copilot.js'
import { createCursorProvider } from './cursor.js'
import { createDroidProvider } from './droid.js'
import { createGeminiProvider } from './gemini.js'
import { createGrokProvider } from './grok.js'
import { createHermesProvider } from './hermes.js'
import { createKimiProvider } from './kimi.js'
import { createOpenCodeProvider } from './opencode.js'
import { createPiProvider } from './pi.js'
import { createTraexProvider } from './traex.js'

export type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider
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
