import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import { antigravityProvider } from '@agentmux/providers/antigravity/provider'
import { createAntigravityAcpProbe } from '@agentmux/providers/antigravity/acp-probe'
import { formatHookToolOutput } from '../hook-tool-outcome.js'
import { antigravityNativeHistory } from '@agentmux/providers/antigravity/native-history'
import { antigravityNativeSession } from '@agentmux/providers/antigravity/native-session'
import { AgentMuxError } from '../errors.js'
import { nativeProcessBirth, nativeProcessFiles } from '../agent-native-process.js'
import { observeNativeJsonlHistory } from '../native-history-source-observer.js'
import { NativeJsonlHistoryReader } from '../native-jsonl-history-reader.js'
import { isNativeText, nativeJsonStringify, nativeTextConcat, nativeTextHasSpeech, nativeTextTrim, type NativeText } from '../native-history-value.js'
import { nativeTextBetween } from '../native-history-source.js'
import { observeRead } from '../observation-read.js'
import { AgentMuxRpcLines, isRpcId, rpcEncode } from '../public-rpc-frame.js'
import type { AgentProviderSessionHistoryContext, AgentProviderSessionHistoryObservation, AgentProviderSessionHistoryObservationContext, AgentSessionHistoryItem } from '../types.js'
import { executionEnvironmentValue, executionHomeDirectory, executionPath, executionTemporaryDirectory } from './execution-environment.js'
import { catalog, hookCommandTimeout, hookToolFields, runScopedHookCommand } from './shared.js'
import { createClaudeProvider } from './claude.js'
import { createCodexProvider } from './codex.js'
import { copilotProvider } from '@agentmux/providers/copilot/provider'
import { normalizeNativeSessionId } from '../agent-native-locator.js'
import { createCursorProvider } from './cursor.js'
import { createDroidProvider } from './droid.js'
import { geminiProvider } from '@agentmux/providers/gemini/provider'
import { createGrokProvider } from './grok.js'
import { createHermesProvider } from './hermes.js'
import { createKimiProvider } from './kimi.js'
import { createOpenCodeProvider } from './opencode.js'
import { createPiProvider } from './pi.js'
import { createTraexProvider } from './traex.js'

export type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider
function createAntigravityProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  const { catalog: seed, planManagedHooks, ...provider } = antigravityProvider({
    formatHookToolOutput, hookToolFields, hookCommandTimeout, runScopedHookCommand
  })
  const { assertAntigravityHistorySource, readAntigravitySessionHistoryPage } =
    antigravityNativeHistory<NativeText, AgentProviderSessionHistoryContext, AgentSessionHistoryItem>({
      AgentMuxError, NativeJsonlHistoryReader, isNativeText, nativeJsonStringify, nativeTextConcat, nativeTextHasSpeech,
      nativeTextTrim, nativeTextBetween
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
  return [
    createCodexProvider(defineAgentProvider),
    createClaudeProvider(defineAgentProvider),
    createTraexProvider(defineAgentProvider),
    createHermesProvider(defineAgentProvider),
    createPiProvider(defineAgentProvider),
    createGrokProvider(defineAgentProvider),
    defineAgentProvider({ ...gemini, catalog: catalog(gemini.catalog) }),
    createAntigravityProvider(defineAgentProvider),
    createCursorProvider(defineAgentProvider),
    createKimiProvider(defineAgentProvider),
    createDroidProvider(defineAgentProvider),
    defineAgentProvider({ ...copilot, catalog: catalog(copilot.catalog) }),
    createOpenCodeProvider(defineAgentProvider)
  ]
}

export { createClaudeProvider } from './claude.js'
export { createCodexProvider } from './codex.js'
export { createCursorProvider } from './cursor.js'
export { createDroidProvider } from './droid.js'
export { createGrokProvider } from './grok.js'
export { createHermesProvider } from './hermes.js'
export { createKimiProvider } from './kimi.js'
export { createOpenCodeProvider } from './opencode.js'
export { createPiProvider } from './pi.js'
export { createTraexProvider } from './traex.js'
