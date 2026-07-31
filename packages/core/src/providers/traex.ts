import { TRAEX_LAUNCH_OPTIONS } from '../agent-launch-option.js'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import { catalog } from './shared.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

export function createTraexProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  return defineAgentProvider({
    catalog: catalog({
      id: 'traex', label: 'TraeX', executable: 'traex', expectedProcess: 'traex', promptDelivery: 'positional-argv',
      hookStrategy: { kind: 'none' }, resumeStrategy: { kind: 'none' }, acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true, hookEvents: false, timeline: 'unavailable', permission: 'none', providerResume: false,
        acp: false, replyCorrelation: 'none'
      }
    }),
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])],
    hook: { rules: [] },
    launchOptions: TRAEX_LAUNCH_OPTIONS
  })
}
