import { prepareCodexToolExecutionLaunch } from './codex-tool-execution-launch.js'
import { prepareCodexExecutionHelper } from './codex-execution-helper.js'
import { codexProvider } from '@agentmux/providers/codex/provider'
import { observeCodexTerminalFrontend, reconnectCodexTerminalFrontend } from './codex-managed-frontend.js'
import { readCodexPromptExecutionEvidence, createCodexPromptExecutionTransportVerifier } from './codex-prompt-execution-evidence.js'
import { readCodexResumedTurnInterruption } from './codex-resumed-turn-interruption.js'
import { createCodexNativeCatalog } from '@agentmux/providers/codex/native-catalog'
import { assertNativeCatalogPath, nativeCatalogFiles, nativeCatalogIssue, readNativeCatalogFile } from './native-session-catalog-files.js'
import { AgentMuxError } from '../errors.js'
import { createCodexPromptTransportPreparation } from './codex-prompt-transport-preparation.js'
import { inspectCodexPromptExecution, inspectCodexPromptPreparationWait } from './codex-prompt-execution.js'
import { observeCodexSessionStatus } from './codex-session-status.js'
import { prepareCodexManagedLaunch, prepareCodexNativeInput } from './codex-native-input.js'
import { normalizeNativeSessionId } from '../agent-native-locator.js'
import { inspectCodexHookActivation, withCodexLaunchHooks } from './codex-hook-services.js'
import { codexMainNativeRecord } from '@agentmux/providers/codex/native-record-role'
import { observeNativeJsonlHistory } from '../native-history-source-observer.js'
import { discoverAppServerNativeSession, planCodexQuestionReply, readAppServerSessionHistoryPage,
  readAppServerSessionHistoryRecord } from './app-server.js'
import { readCodexSavedSessionHistoryPage, readCodexSavedSessionHistoryRecord, readCodexSavedConversationChanges } from './codex-history-reader.js'
import { createNumberedTerminalInteractionProtocol } from '../agent-interaction.js'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import { formatHookToolOutput } from '../hook-tool-outcome.js'
import { buildPromptInputPayload, catalog, hookToolFields, sanitizeBracketedPasteText } from './shared.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

const { listCodexNativeSessions, assertCodexNativeResumeSource, codexRecoveryFiles } = createCodexNativeCatalog({
  AgentMuxError, normalizeNativeSessionId, assertNativeCatalogPath, nativeCatalogFiles, nativeCatalogIssue, readNativeCatalogFile
})

export function createCodexProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  const { catalog: seed, interaction, withHookIssue, ...contribution } = codexProvider({
    buildPromptInputPayload, formatHookToolOutput, hookToolFields, normalizeNativeSessionId,
    sanitizeBracketedPasteText, withCodexLaunchHooks
  })
  const verifyPromptExecutionTransport = createCodexPromptExecutionTransportVerifier()
  const provider = defineAgentProvider({
    ...contribution,
    catalog: catalog(seed),
    interaction: createNumberedTerminalInteractionProtocol(interaction),
    prepareToolExecutionLaunch: (plan, context) => prepareCodexToolExecutionLaunch(plan, { workspacePath: context.binding.workspacePath, url: context.url }, { launchWorkspacePath: context.launchWorkspacePath, ...(context.invocation ? { invocation: context.invocation } : {}) }),
    prepareExecutionHelper: prepareCodexExecutionHelper,
    prepareManagedLaunch: prepareCodexManagedLaunch,
    prepareNativeInput: prepareCodexNativeInput,
    planQuestionReply: planCodexQuestionReply,
    observeTerminalFrontend: observeCodexTerminalFrontend,
    reconnectTerminalFrontend: reconnectCodexTerminalFrontend,
    inspectPromptExecution: inspectCodexPromptExecution,
    inspectPromptPreparationWait: inspectCodexPromptPreparationWait,
    verifyPromptExecutionTransport,
    preparePromptExecutionTransport: createCodexPromptTransportPreparation(verifyPromptExecutionTransport),
    readPromptExecutionEvidence: readCodexPromptExecutionEvidence,
    readResumedTurnInterruption: readCodexResumedTurnInterruption,
    observeSessionStatus: observeCodexSessionStatus,
    discoverNativeSession: context => discoverAppServerNativeSession(context, 'codex', codexMainNativeRecord),
    listNativeSessions: listCodexNativeSessions,
    assertNativeResumeSource: assertCodexNativeResumeSource,
    readConversationChanges: readCodexSavedConversationChanges,
    readSessionHistoryPage: context => context.transcriptPath ? readCodexSavedSessionHistoryPage(context) : readAppServerSessionHistoryPage(context),
    recoveryFiles: codexRecoveryFiles,
    readSessionHistoryRecord: context => context.transcriptPath ? readCodexSavedSessionHistoryRecord(context) : readAppServerSessionHistoryRecord(context),
    observeSessionHistory: observeNativeJsonlHistory,
    inspectHookActivation: inspectCodexHookActivation,
  })
  return { ...provider,
    buildLaunch: context => withHookIssue(provider.buildLaunch(context), context.args),
    buildResumeLaunch: context => withHookIssue(provider.buildResumeLaunch(context), context.args),
    buildForkLaunch: context => withHookIssue(provider.buildForkLaunch!(context), context.args)
  }
}
