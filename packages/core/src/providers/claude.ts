import { listClaudeNativeSessions, assertClaudeNativeResumeSource, claudeRecoveryFiles, discoverClaudeNativeSession,
  readClaudeSessionHistoryPage, readClaudeSessionHistoryRecord, readClaudeConversationChanges } from './claude-native-sources.js'
import { inspectClaudeHookSettings, prepareClaudeOwnedWorkspaceTrust, readClaudeInputInitialization } from './claude-native-settings.js'
import { prepareClaudeToolExecutionLaunch } from './claude-tool-execution-launch.js'
import { prepareClaudeExecutionHelper } from './claude-execution-helper.js'
import { claudeProvider } from '@agentmux/providers/claude/provider'
import { prepareClaudeNativeInput } from './claude-native-input.js'
import { CLAUDE_ASKED_TOOL_END_EVENT, withClaudePlugin } from '@agentmux/providers/claude/native-activity'
import { createClaudePlugin } from './claude-plugin.js'
import { observeNativeJsonlHistory } from '../native-history-source-observer.js'
import { normalizeNativeSessionId } from '../agent-native-locator.js'
import type { AgentManagedHookPlan } from '../managed-hook-installer.js'
import { createNumberedTerminalInteractionProtocol } from '../agent-interaction.js'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import type { AgentNativeHookSpecification } from '../hook-normalizer.js'
import { formatHookToolOutput } from '../hook-tool-outcome.js'
import {
  buildPromptInputPayload,
  catalog,
  hookToolFields,
  runScopedHookCommand,
  hookCommandTimeout,
  sanitizeBracketedPasteText
} from './shared.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

const { hook, catalog: seed, terminalInteraction, managedHookGroups, ...claude } = claudeProvider({
  hookToolFields, formatHookToolOutput, normalizeNativeSessionId, buildPromptInputPayload, sanitizeBracketedPasteText,
  runScopedHookCommand, hookCommandTimeout
})
export const CLAUDE_HOOKS: AgentNativeHookSpecification = hook

export function claudeManagedPlugin(): ReturnType<typeof createClaudePlugin> {
  return createClaudePlugin(managedHookGroups())
}

export function createClaudeManagedHookPlan(): AgentManagedHookPlan {
  return { providerId: 'claude', mutations: claudeManagedPlugin().mutations }
}

export function createClaudeProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  const provider = defineAgentProvider({
    prepareToolExecutionLaunch: prepareClaudeToolExecutionLaunch,
    prepareExecutionHelper: prepareClaudeExecutionHelper,
    planManagedHooks: () => createClaudeManagedHookPlan(),
    prepareOwnedWorkspaceTrust: prepareClaudeOwnedWorkspaceTrust,
    readInputInitialization: readClaudeInputInitialization,
    readSessionHistoryPage: readClaudeSessionHistoryPage,
    recoveryFiles: claudeRecoveryFiles,
    readSessionHistoryRecord: readClaudeSessionHistoryRecord,
    readConversationChanges: readClaudeConversationChanges,
    discoverNativeSession: discoverClaudeNativeSession,
    prepareNativeInput: prepareClaudeNativeInput,
    listNativeSessions: listClaudeNativeSessions,
    assertNativeResumeSource: assertClaudeNativeResumeSource,
    observeSessionHistory: observeNativeJsonlHistory,
    ...claude,
    catalog: catalog(seed),
    hook: CLAUDE_HOOKS,
    inspectHookActivation: inspectClaudeHookSettings,
    interaction: createNumberedTerminalInteractionProtocol(terminalInteraction)
  })
  return {
    ...provider,
    normalizeHook(envelope, context) {
      let normalized = provider.normalizeHook(envelope, context)
      if (normalized.mainSubject && normalized.eventName === 'turn.complete' && normalized.currentActivity?.state === 'unknown') {
        normalized = { ...normalized, currentActivityIssue: envelope.payload?.backgroundWork === 'pending'
          ? 'The native turn reported background tasks, which may include ambient observers. Current idle or active is unconfirmed. The original Session, Run, results and input remain available; a later native turn with a confirmed empty task snapshot can confirm idle.'
          : 'The native turn has no confirmed matching background-task snapshot. Current idle is unconfirmed. The original Session, Run, results and input remain available; a later native turn with a confirmed empty task snapshot can confirm idle.' }
      }
      // Only the interaction end belongs to this observation; it is not a tool row or activity.
      if (normalized.eventName === CLAUDE_ASKED_TOOL_END_EVENT) return { ...normalized, timeline: [] }
      // An identified ask is a stage of the call PreToolUse already recorded; its tool row is that one.
      if (normalized.eventName === 'PermissionRequest' && normalized.interaction?.nativeToolCallId) {
        return { ...normalized, timeline: normalized.timeline.filter(mutation => mutation.type === 'update' || mutation.item.kind !== 'tool_call') }
      }
      if (normalized.eventName === 'StopFailure') {
        // Classic StopFailure exposes error text but no native turn identity. Keep its local
        // diagnostic without borrowing the most recent turn or publishing its last answer.
        const payload = envelope.payload ?? {}
        const detail = [payload.error, payload.error_details].filter(value => typeof value === 'string').join(': ')
        return { ...normalized, status: { ...normalized.status,
          detail: detail || 'Native request failed; its native turn identity is unconfirmed.' },
          timeline: normalized.timeline.map(mutation => mutation.type === 'update' ? mutation : {
            ...mutation, item: { ...mutation.item,
              ...(mutation.item.kind === 'assistant_message' ? { contentEligibility: 'unconfirmed' as const } :
                detail ? { content: detail } : {}) }
          }) }
      }
      if (normalized.eventName === 'turn.complete' && normalized.mainSubject &&
        normalized.semanticState === 'error' && normalized.currentActivity) {
        const nativeTurnId = normalized.currentActivity.nativeTurnId
        if (!nativeTurnId) return normalized
        // The native runner identifies its error end, but exposes no original API error fields.
        const failure = { code: 'AGENT_PROVIDER_ERROR', nativeTurnId,
          message: 'The native Claude turn ended in error; the original error code is unavailable.',
          publicMessage: 'Claude could not finish this request.',
          recovery: 'Inspect the original Agent for details. Retry only after choosing to submit again.' }
        return { ...normalized, status: { ...normalized.status, failure, detail: failure.message },
          timeline: normalized.timeline.map(mutation => mutation.type === 'update' ? mutation : {
            ...mutation, item: { ...mutation.item, turnOutcome: { status: 'failed' as const, failure } }
          }) }
      }
      return normalized
    },
    buildLaunch(context) {
      const launch = provider.buildLaunch(context)
      return { ...launch, args: withClaudePlugin(launch.args, claudeManagedPlugin().directory) }
    },
    buildResumeLaunch(context) {
      const launch = provider.buildResumeLaunch(context)
      return { ...launch, args: withClaudePlugin(launch.args, claudeManagedPlugin().directory) }
    },
    ...(provider.buildForkLaunch ? { buildForkLaunch(context: Parameters<NonNullable<AgentProvider['buildForkLaunch']>>[0]) {
      const launch = provider.buildForkLaunch!(context)
      return { ...launch, args: withClaudePlugin(launch.args, claudeManagedPlugin().directory) }
    } } : {})
  }
}
