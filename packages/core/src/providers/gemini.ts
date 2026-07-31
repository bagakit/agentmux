import { GEMINI_LAUNCH_OPTIONS } from '../agent-launch-option.js'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import { catalog } from './shared.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

export function createGeminiProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  return defineAgentProvider({
    catalog: catalog({
      id: 'gemini', label: 'Gemini', executable: 'gemini', expectedProcess: 'gemini', promptDelivery: 'flag-prompt-interactive',
      hookStrategy: { kind: 'none' }, resumeStrategy: { kind: 'none' }, acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true, hookEvents: false, timeline: 'unavailable', permission: 'none', providerResume: false,
        acp: false, replyCorrelation: 'none'
      }
    }),
    buildArgs: (prompt, args) => prompt ? ['--prompt-interactive', prompt, ...args] : [...args],
    hook: { rules: [] },
    launchOptions: GEMINI_LAUNCH_OPTIONS
  })
}
