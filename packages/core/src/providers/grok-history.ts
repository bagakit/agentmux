import { grokNativeHistory } from '@agentmux/providers/grok/native-history'
import { grokNativeStatus } from '@agentmux/providers/grok/session-status'
import type { AgentProvider } from '../agent-provider.js'
import { AgentMuxError } from '../errors.js'
import * as nativeProcess from '../agent-native-process.js'
import { observeNativeJsonlHistory } from '../native-history-source-observer.js'
import * as nativeHistory from '../native-jsonl-history-reader.js'
import type { NativeJsonlHistoryReader, NativeHistoryReadBudget } from '../native-jsonl-history-reader.js'
import * as nativeValues from '../native-history-value.js'
import { SESSION_HISTORY_MAX_PAGE_BYTES, SESSION_HISTORY_TIMEOUT_MS } from '../session-history.js'
import type { AgentProviderSessionHistoryContext, AgentProviderSessionHistoryObservationContext,
  AgentSessionHistoryItem, AgentSessionHistoryObservationHandle } from '../types.js'

type Source = Pick<AgentProviderSessionHistoryContext, 'source' | 'transcriptPath' | 'env' | 'workspacePath' | 'signal'>
const history: {
  grokRecoveryFiles: NonNullable<AgentProvider['recoveryFiles']>
  resolveGrokUpdatesPath(context: Source, allowMissing?: boolean): Promise<string>
  verifyGrokSummaryIdentity(directory: string, context: Source, budget: NativeHistoryReadBudget, strict?: boolean): Promise<void>
  openGrokReader(context: AgentProviderSessionHistoryContext): Promise<NativeJsonlHistoryReader>
  observeGrokSessionHistory: NonNullable<AgentProvider['observeSessionHistory']>
  readGrokSessionHistoryPage: NonNullable<AgentProvider['readSessionHistoryPage']>
  readGrokConversationChanges: NonNullable<AgentProvider['readConversationChanges']>
  readGrokSessionHistoryRecord: NonNullable<AgentProvider['readSessionHistoryRecord']>
} =
  grokNativeHistory<nativeValues.NativeText, AgentProviderSessionHistoryContext, AgentProviderSessionHistoryObservationContext,
    AgentSessionHistoryObservationHandle, AgentSessionHistoryItem, NativeJsonlHistoryReader>({
    AgentMuxError, NativeJsonlHistoryReader: nativeHistory.NativeJsonlHistoryReader,
    readNativeHistoryBytes: (...args) => nativeHistory.readNativeHistoryBytes(...args), nativeValues,
    observeNativeJsonlHistory, pageMaxBytes: SESSION_HISTORY_MAX_PAGE_BYTES,
    changePageReserveBytes: nativeHistory.NATIVE_CONVERSATION_CHANGES_PAGE_RESERVE_BYTES
  })

export const { grokRecoveryFiles, resolveGrokUpdatesPath, verifyGrokSummaryIdentity, openGrokReader,
  observeGrokSessionHistory, readGrokSessionHistoryPage, readGrokConversationChanges, readGrokSessionHistoryRecord } = history

const status: { readGrokPromptExecutionEvidence: NonNullable<AgentProvider['readPromptExecutionEvidence']>;
  observeGrokSessionStatus: NonNullable<AgentProvider['observeSessionStatus']> } = grokNativeStatus({
  AgentMuxError, nativeProcessBirth: (...args) => nativeProcess.nativeProcessBirth(...args),
  nativeProcessFiles: (...args) => nativeProcess.nativeProcessFiles(...args),
  readNativeHistoryBytes: (...args) => nativeHistory.readNativeHistoryBytes(...args), historyTimeoutMs: SESSION_HISTORY_TIMEOUT_MS,
  resolveGrokUpdatesPath, openGrokReader, verifyGrokSummaryIdentity, observeNativeJsonlHistory
})
export const { readGrokPromptExecutionEvidence, observeGrokSessionStatus } = status
