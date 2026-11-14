import { createHermesHookSpecification, planHermesManagedHooks, resolveHermesHome as nativeHome } from '@agentmux/providers/hermes/provider'
import { executionEnvironmentValue, executionHomeDirectory, executionPath, type ProviderExecutionEnvironment } from './execution-environment.js'
import { HERMES_LAUNCH_OPTIONS } from './launch-options.js'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import { formatHookToolOutput } from '../hook-tool-outcome.js'
import { readHermesSessionHistoryPage } from './hermes-native-history.js'
import { catalog, hookToolFields, runScopedHookCommand, hookCommandTimeout } from './shared.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

const services = { executionEnvironmentValue, executionHomeDirectory, executionPath, runScopedHookCommand, hookCommandTimeout }
export const HERMES_HOOKS = createHermesHookSpecification({ hookToolFields, formatHookToolOutput })
export const resolveHermesHome = (env?: ProviderExecutionEnvironment, workspacePath?: string) =>
  nativeHome(services, env, workspacePath)
export const createHermesManagedHookPlan = (env?: ProviderExecutionEnvironment, workspacePath?: string) =>
  planHermesManagedHooks(services, env, workspacePath)

export function createHermesProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  return defineAgentProvider({
    planManagedHooks: ({ env, workspacePath }) => createHermesManagedHookPlan(env, workspacePath),
    catalog: catalog({
      id: 'hermes', label: 'Hermes', executable: 'hermes', expectedProcess: 'hermes',
      promptDelivery: 'hermes-query',
      hookStrategy: { kind: 'native', installation: 'explicit-managed' },
      resumeStrategy: { kind: 'none' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true, timeline: 'complete-events', permission: 'observe',
        providerResume: false, replyCorrelation: 'none'
      }
    }),
    buildArgs: (prompt, args) => prompt ? ['chat', '--query', prompt, ...args, '--tui'] : [...args, '--tui'],
    readSessionHistoryPage: readHermesSessionHistoryPage,
    hook: HERMES_HOOKS,
    launchOptions: HERMES_LAUNCH_OPTIONS
  })
}
