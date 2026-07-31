import { GROK_LAUNCH_OPTIONS } from '../agent-launch-option.js'
import type { PostureControlDeclaration } from '../agent-interaction.js'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import { catalog } from './shared.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

export const GROK_POSTURE: PostureControlDeclaration = {
  id: 'approval', label: 'Approvals',
  modes: [
    { id: 'ask', label: 'Ask each time', description: 'Grok asks before running commands or editing files.', tier: 'safe', input: '/always-approve off\r' },
    { id: 'always-approve', label: 'Auto-approve', description: 'Skip all permission prompts for this session.', tier: 'danger', input: '/always-approve on\r' }
  ]
}

export function createGrokProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  return defineAgentProvider({
    catalog: catalog({
      id: 'grok', label: 'Grok', executable: 'grok', expectedProcess: 'grok', promptDelivery: 'positional-argv',
      hookStrategy: { kind: 'none' }, resumeStrategy: { kind: 'none' }, acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true, hookEvents: false, timeline: 'unavailable', permission: 'none', providerResume: false,
        acp: false, replyCorrelation: 'none'
      }
    }),
    buildArgs: (prompt, args) => prompt ? [...args, '--', prompt] : [...args],
    posture: GROK_POSTURE,
    hook: { rules: [] },
    launchOptions: GROK_LAUNCH_OPTIONS
  })
}
