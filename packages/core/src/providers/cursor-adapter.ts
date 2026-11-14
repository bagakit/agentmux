import { cursorProvider } from '@agentmux/providers/cursor/provider'
import { createCursorPayloadConsumption } from '@agentmux/providers/cursor/payload-consumption'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import { normalizeNativeHook } from '../hook-normalizer.js'
import { formatHookToolOutput } from '../hook-tool-outcome.js'
import { catalog, hookToolFields, runScopedHookCommand, hookCommandTimeout } from './shared.js'
import { cursorDataRoot, readCursorSessionHistoryPage, observeCursorSessionHistory, resolveCursorStorePath } from './cursor-history.js'
import { discoverCursorNativeSession, prepareCursorOwnedWorkspaceTrust, qualifyCursorPayloadProtocol } from './cursor-native-sources.js'
import { buildPromptInputPayload, sanitizeBracketedPasteText } from '../bracketed-paste.js'
import { AgentMuxError } from '../errors.js'
import { nativeProcessBirth } from '../agent-native-process.js'

export const { cursorPromptPayloadConsumption }: { cursorPromptPayloadConsumption: NonNullable<AgentProvider['promptPayloadConsumption']> } =
  createCursorPayloadConsumption({ AgentMuxError, nativeProcessBirth: (...args) => nativeProcessBirth(...args),
    resolveCursorStorePath, qualifyCursorPayloadProtocol, discoverCursorNativeSession
  })

export function createCursorProvider(defineAgentProvider: (definition: AgentProviderDefinition) => AgentProvider): AgentProvider {
  const { catalog: seed, planManagedHooks, hook, ...cursor } = cursorProvider({
    hookToolFields, formatHookToolOutput, runScopedHookCommand, hookCommandTimeout, buildPromptInputPayload, sanitizeBracketedPasteText
  })
  const { subagentTracking: _tracking, nativeHandle: _identity, ...observationOnly } = hook
  const provider = defineAgentProvider({
    ...cursor, hook, catalog: catalog(seed),
    planManagedHooks: ({ workspacePath, env }) => planManagedHooks(cursorDataRoot(workspacePath, env)),
    prepareOwnedWorkspaceTrust: prepareCursorOwnedWorkspaceTrust,
    promptPayloadConsumption: cursorPromptPayloadConsumption,
    discoverNativeSession: discoverCursorNativeSession,
    readSessionHistoryPage: readCursorSessionHistoryPage,
    observeSessionHistory: observeCursorSessionHistory
  })
  return {
    ...provider,
    normalizeHook(envelope, context) {
      const payload = envelope.payload ?? {}
      const sessionId = typeof payload.conversation_id === 'string' && payload.conversation_id.trim()
        ? payload.conversation_id.trim() : undefined
      const known = context.nativeHandle
      const foreign = known !== undefined && sessionId !== undefined && sessionId !== known.sessionId
      // A foreign receipt must not mutate this Run's existing child roster before
      // its return value is fenced. It contributes only the authenticated raw observation.
      const normalized = foreign ? normalizeNativeHook({ ...observationOnly, rules: [] }, envelope, context)
        : provider.normalizeHook(envelope, context)
      if (!foreign) {
        // An authenticated first-party receipt establishes birth. A later receipt cannot
        // replace the durable locator for the same main native Session. Known child
        // settlement retains the shared roster's proven parent completion contribution.
        return known && normalized.nativeHandle ? { ...normalized, nativeHandle: known } : normalized
      }
      const { nativeHandle: _handle, turnUsage: _usage, interaction: _interaction,
        interactionCompletion: _completion, ...neutral } = normalized
      return { ...neutral, mainSubject: false, lifecycleEvent: null, semanticState: 'unknown',
        status: { ...normalized.status, state: 'running' }, timeline: [] }
    }
  }

}
