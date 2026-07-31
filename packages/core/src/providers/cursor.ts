import { CURSOR_LAUNCH_OPTIONS } from '../agent-launch-option.js'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import { catalog } from './shared.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

export function createCursorProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  return defineAgentProvider({
    catalog: catalog({
      id: 'cursor', label: 'Cursor', executable: 'cursor-agent', expectedProcess: 'cursor-agent', promptDelivery: 'positional-argv',
      hookStrategy: { kind: 'none' }, resumeStrategy: { kind: 'none' }, acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true, hookEvents: false, timeline: 'unavailable', permission: 'none', providerResume: false,
        acp: false, replyCorrelation: 'none'
      }
    }),
    launchOptions: CURSOR_LAUNCH_OPTIONS,
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])],
    hook: { rules: [] }
  })
}
