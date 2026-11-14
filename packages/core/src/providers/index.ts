import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import { antigravityProvider } from '@agentmux/providers/antigravity/provider'
import { createAntigravityAcpProbe } from '@agentmux/providers/antigravity/acp-probe'
import { formatHookToolOutput } from '../hook-tool-outcome.js'
import { antigravityNativeHistory } from '@agentmux/providers/antigravity/native-history'
import { antigravityNativeSession } from '@agentmux/providers/antigravity/native-session'
import { AgentMuxError } from '../errors.js'
import { nativeProcessBirth, nativeProcessFiles } from '../agent-native-process.js'
import { observeNativeJsonlHistory } from '../native-history-source-observer.js'
import { NativeJsonlHistoryReader, readNativeHistoryBytes } from '../native-jsonl-history-reader.js'
import { isNativeText, nativeJsonStringify, nativeTextConcat, nativeTextHasSpeech, nativeTextJoin, nativeTextBase64, nativeTextTrim, type NativeText } from '../native-history-value.js'
import { nativeTextBetween } from '../native-history-source.js'
import { observeRead } from '../observation-read.js'
import { AgentMuxRpcLines, isRpcId, rpcEncode } from '../public-rpc-frame.js'
import type { AgentProviderSessionHistoryContext, AgentProviderSessionHistoryObservation, AgentProviderSessionHistoryObservationContext, AgentSessionHistoryItem } from '../types.js'
import { executionEnvironmentValue, executionHomeDirectory, executionPath, executionTemporaryDirectory } from './execution-environment.js'
import { catalog, hookCommandTimeout, hookToolFields, inspectHookDisableSetting, runScopedHookCommand } from './shared.js'
import { createClaudeProvider } from './claude.js'
import { createCodexProvider } from './codex.js'
import { copilotProvider } from '@agentmux/providers/copilot/provider'
import { normalizeNativeSessionId } from '../agent-native-locator.js'
import { createCursorProvider } from './cursor.js'
import { droidProvider } from '@agentmux/providers/droid/provider'
import { droidNativeHistory } from '@agentmux/providers/droid/native-history'
import { geminiProvider } from '@agentmux/providers/gemini/provider'
import { grokProvider } from '@agentmux/providers/grok/provider'
import { observeGrokSessionHistory, readGrokSessionHistoryPage, readGrokConversationChanges, readGrokSessionHistoryRecord, grokRecoveryFiles } from './grok-native-history.js'
import { readGrokInputInitialization } from './grok-input-initialization.js'
import { observeGrokSessionStatus, readGrokPromptExecutionEvidence } from './grok-session-status.js'
import { createHermesProvider } from './hermes.js'
import { kimiProvider } from '@agentmux/providers/kimi/provider'
import { kimiNativeHistory } from '@agentmux/providers/kimi/native-history'
import { createOpenCodeProvider } from './opencode.js'
import { createPiProvider } from './pi.js'
import { traexProvider } from '@agentmux/providers/traex/provider'
import { discoverAppServerNativeSession, readAppServerSessionHistoryPage } from './app-server.js'

export type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

const historyServices = { AgentMuxError, NativeJsonlHistoryReader, isNativeText, nativeJsonStringify, nativeTextConcat }

function createAntigravityProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  const { catalog: seed, planManagedHooks, ...provider } = antigravityProvider({
    formatHookToolOutput, hookToolFields, hookCommandTimeout, runScopedHookCommand
  })
  const { assertAntigravityHistorySource, readAntigravitySessionHistoryPage } =
    antigravityNativeHistory<NativeText, AgentProviderSessionHistoryContext, AgentSessionHistoryItem>({
      ...historyServices, nativeTextHasSpeech, nativeTextTrim, nativeTextBetween
    })
  const { discoverAntigravityNativeSession, observeAntigravitySessionHistory } =
    antigravityNativeSession<AgentProviderSessionHistoryObservation, AgentProviderSessionHistoryObservationContext>({
      AgentMuxError, nativeProcessBirth, nativeProcessFiles, observeNativeJsonlHistory, assertAntigravityHistorySource
    })
  return defineAgentProvider({
    ...provider,
    catalog: catalog(seed),
    probeAcp: createAntigravityAcpProbe({ observeRead, AgentMuxRpcLines, isRpcId, rpcEncode }),
    planManagedHooks: ({ env, workspacePath }) => planManagedHooks(executionPath(executionHomeDirectory(env), workspacePath)),
    discoverNativeSession: discoverAntigravityNativeSession,
    readSessionHistoryPage: readAntigravitySessionHistoryPage,
    observeSessionHistory: observeAntigravitySessionHistory
  })
}

const hookServices = { formatHookToolOutput, hookCommandTimeout, hookToolFields, runScopedHookCommand,
  executionEnvironmentValue, executionHomeDirectory, executionPath }

/** Composition-only list. Provider-specific definitions live in their own modules. */
export function createBuiltInAgentProviders(defineAgentProvider: ProviderFactory): readonly AgentProvider[] {
  const gemini = geminiProvider({ ...hookServices, executionTemporaryDirectory })
  const copilot = copilotProvider({ ...hookServices, normalizeNativeSessionId })
  const grok = grokProvider({ ...hookServices, normalizeNativeSessionId })
  const kimi = kimiProvider(hookServices)
  const { hookDisableKey, ...droid } = droidProvider(hookServices)
  const { readKimiSessionHistoryPage } = kimiNativeHistory<NativeText, AgentProviderSessionHistoryContext, AgentSessionHistoryItem>({
    ...historyServices, readNativeHistoryBytes
  })
  const { readDroidSessionHistoryPage, readDroidSessionHistoryRecord } =
    droidNativeHistory<NativeText, AgentProviderSessionHistoryContext, AgentSessionHistoryItem>({
      ...historyServices, nativeTextJoin, nativeTextHasSpeech, nativeTextBase64
    })
  return [
    createCodexProvider(defineAgentProvider),
    createClaudeProvider(defineAgentProvider),
    defineAgentProvider({ ...traexProvider, catalog: catalog(traexProvider.catalog),
      discoverNativeSession: context => discoverAppServerNativeSession(context, 'traex'),
      readSessionHistoryPage: readAppServerSessionHistoryPage, observeSessionHistory: observeNativeJsonlHistory }),
    createHermesProvider(defineAgentProvider),
    createPiProvider(defineAgentProvider),
    defineAgentProvider({ ...grok, catalog: catalog(grok.catalog),
      readSessionHistoryPage: readGrokSessionHistoryPage,
      recoveryFiles: grokRecoveryFiles,
      readSessionHistoryRecord: readGrokSessionHistoryRecord,
      observeSessionHistory: observeGrokSessionHistory,
      readConversationChanges: readGrokConversationChanges,
      readInputInitialization: readGrokInputInitialization,
      observeSessionStatus: observeGrokSessionStatus,
      readPromptExecutionEvidence: readGrokPromptExecutionEvidence }),
    defineAgentProvider({ ...gemini, catalog: catalog(gemini.catalog) }),
    createAntigravityProvider(defineAgentProvider),
    createCursorProvider(defineAgentProvider),
    defineAgentProvider({ ...kimi, catalog: catalog(kimi.catalog), readSessionHistoryPage: readKimiSessionHistoryPage }),
    defineAgentProvider({ ...droid, catalog: catalog(droid.catalog),
      readSessionHistoryPage: readDroidSessionHistoryPage, readSessionHistoryRecord: readDroidSessionHistoryRecord,
      inspectHookActivation: context => inspectHookDisableSetting(context, hookDisableKey) }),
    defineAgentProvider({ ...copilot, catalog: catalog(copilot.catalog) }),
    createOpenCodeProvider(defineAgentProvider)
  ]
}

export { createClaudeProvider } from './claude.js'
export { createCodexProvider } from './codex.js'
export { createCursorProvider } from './cursor.js'
export { createHermesProvider } from './hermes.js'
export { createOpenCodeProvider } from './opencode.js'
export { createPiProvider } from './pi.js'
