import { TRAEX_LAUNCH_OPTIONS } from './launch-options.js'

export const traexProvider = {
  catalog: {
    id: 'traex', label: 'TraeX', executable: 'traex', expectedProcess: 'traex', promptDelivery: 'positional-argv',
    hookStrategy: { kind: 'none' }, resumeStrategy: { kind: 'provider-native', locator: 'session-id' }, acpStrategy: { kind: 'none' },
    capabilities: {
      terminal: true, timeline: 'unavailable', permission: 'none', providerResume: true,
      replyCorrelation: 'none'
    }
  } as const,
  buildArgs: (prompt: string, args: readonly string[]) => [...args, ...(prompt ? [prompt] : [])],
  buildResumeArgs: (sessionId: string, _transcriptPath: string | undefined, prompt: string | undefined, args: readonly string[]) => ['resume', sessionId, ...(prompt ? [prompt] : []), ...args],
  hook: { rules: [] },
  launchOptions: TRAEX_LAUNCH_OPTIONS
}
