import { identityRuntimeSource } from '@agentmux/identity/runtime-source'
import { adaptOpenCodePayload, createOpenCodeHookSpecification, inspectOpenCodeHookActivation, isChildPayload,
  planOpenCodeManagedHooks, qualifyOpenCodeHookHost } from '@agentmux/providers/opencode/provider'
import { executionEnvironmentValue, executionHomeDirectory, executionPath, type ProviderExecutionEnvironment } from './execution-environment.js'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import { createOpenCodeNativeHistory } from '@agentmux/providers/opencode/native-history'
import { AgentMuxError } from '../errors.js'
import { SESSION_HISTORY_MAX_PAGE_BYTES } from '../session-history.js'
import { catalog, hookToolFields } from './shared.js'
import { hookDeliverySource } from '../agent-hook-delivery.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

const services = { executionEnvironmentValue, executionHomeDirectory, executionPath, hookDeliverySource, identityRuntimeSource }
export const OPENCODE_HOOKS = createOpenCodeHookSpecification({ hookToolFields })
export const createOpenCodeManagedHookPlan = (env?: ProviderExecutionEnvironment, workspacePath?: string) =>
  planOpenCodeManagedHooks(services, env, workspacePath)

const readOpenCodeSessionHistoryPage = createOpenCodeNativeHistory({ AgentMuxError, SESSION_HISTORY_MAX_PAGE_BYTES })

export function createOpenCodeProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  const provider = defineAgentProvider({
    planManagedHooks: ({ env, workspacePath }) => createOpenCodeManagedHookPlan(env, workspacePath),
    catalog: catalog({
      id: 'opencode', label: 'OpenCode', executable: 'opencode', expectedProcess: 'opencode',
      promptDelivery: 'positional-argv',
      hookStrategy: { kind: 'native', installation: 'explicit-managed' },
      resumeStrategy: { kind: 'provider-native', locator: 'session-id' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true, timeline: 'complete-events',
        permission: 'observe',
        providerResume: true,
        replyCorrelation: 'none'
      }
    }),
    readSessionHistoryPage: readOpenCodeSessionHistoryPage,
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])],
    hook: OPENCODE_HOOKS,
    inspectHookActivation: inspectOpenCodeHookActivation,
    buildResumeArgs: (sessionId, _transcriptPath, prompt, args) => [
      '--session', sessionId, ...args, ...(prompt ? [prompt] : [])
    ]
  })

  return {
    ...provider,
    buildLaunch: context => qualifyOpenCodeHookHost(provider.buildLaunch(context)),
    buildResumeLaunch: context => qualifyOpenCodeHookHost(provider.buildResumeLaunch(context)),
    normalizeHook(envelope, context) {
      const payload = envelope.payload ?? {}
      const nativeHandle = context.nativeHandle
      const trustedRootSessionId = nativeHandle?.sessionId
      const sid = typeof payload.sessionID === 'string' && payload.sessionID.trim().length > 0
        ? payload.sessionID.trim()
        : undefined
      const isChild = isChildPayload(payload)
      const isRoot = sid !== undefined && trustedRootSessionId !== undefined && sid === trustedRootSessionId && !isChild

      const adapted = adaptOpenCodePayload(payload)
      const normalized = provider.normalizeHook({ ...envelope, payload: adapted }, context)

      if (isRoot && nativeHandle) {
        return {
          ...normalized,
          nativeHandle
        }
      }

      const {
        nativeHandle: _nh,
        turnUsage: _tu,
        interaction: _ix,
        interactionCompletion: _ic,
        lifecycleEvent: _le,
        ...fenced
      } = normalized

      return {
        ...fenced,
        lifecycleEvent: null,
        semanticState: 'unknown',
        status: {
          ...normalized.status,
          state: 'running'
        }
      }
    }
  }
}
