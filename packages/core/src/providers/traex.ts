import { TRAEX_LAUNCH_OPTIONS } from '../agent-launch-option.js'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import { observeNativeJsonlHistory } from '../native-history-source-observer.js'
import { discoverAppServerNativeSession } from './app-server-native-session.js'
import { readAppServerSessionHistoryPage } from './app-server-native-history.js'
import { catalog } from './shared.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

export function createTraexProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  return defineAgentProvider({
    catalog: catalog({
      id: 'traex', label: 'TraeX', executable: 'traex', expectedProcess: 'traex', promptDelivery: 'positional-argv',
      hookStrategy: { kind: 'none' }, resumeStrategy: { kind: 'provider-native', locator: 'session-id' }, acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true, timeline: 'unavailable', permission: 'none', providerResume: true,
        replyCorrelation: 'none'
      }
    }),
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])],
    buildResumeArgs: (sessionId, _transcriptPath, prompt, args) => ['resume', sessionId, ...(prompt ? [prompt] : []), ...args],
    discoverNativeSession: context => discoverAppServerNativeSession(context, 'traex'),
    readSessionHistoryPage: readAppServerSessionHistoryPage,
    observeSessionHistory: observeNativeJsonlHistory,
    hook: { rules: [] },
    launchOptions: TRAEX_LAUNCH_OPTIONS
  })
}
