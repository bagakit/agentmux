import { createCodexSavedHistory } from '@agentmux/providers/codex/saved-history'
import type { AgentProvider } from '../agent-provider.js'
import { AgentMuxError } from '../errors.js'
import { NativeJsonlHistoryReader, readNativeConversationChanges, NATIVE_CONVERSATION_CHANGES_PAGE_RESERVE_BYTES } from '../native-jsonl-history-reader.js'
import { isNativeText, nativeJsonStringify, nativeTextConcat, nativeTextStartsWith, type NativeText } from '../native-history-value.js'
import { nativeConversationProvenance } from '../conversation-provenance.js'
import { normalizeSessionHistoryMetrics, SESSION_HISTORY_MAX_PAGE_BYTES } from '../session-history.js'
import type { AgentProviderSessionHistoryContext } from '../types.js'
import type { ProviderConversationChangesContext, ProviderConversationChangesPage } from '../session-history-changes.js'
import { codexQuestionRequest, codexQuestionAnswers } from './app-server.js'

const history = createCodexSavedHistory<NativeText, AgentProviderSessionHistoryContext,
  ProviderConversationChangesContext, ProviderConversationChangesPage, NativeJsonlHistoryReader>({
  AgentMuxError, NativeJsonlHistoryReader, readNativeConversationChanges, nativeConversationProvenance,
  normalizeSessionHistoryMetrics, isNativeText, nativeJsonStringify, nativeTextConcat, nativeTextStartsWith,
  codexQuestionRequest, codexQuestionAnswers, SESSION_HISTORY_MAX_PAGE_BYTES, NATIVE_CONVERSATION_CHANGES_PAGE_RESERVE_BYTES
})
export const readCodexSavedSessionHistoryPage: NonNullable<AgentProvider['readSessionHistoryPage']> = history.readCodexSavedSessionHistoryPage
export const readCodexSavedSessionHistoryRecord: NonNullable<AgentProvider['readSessionHistoryRecord']> = history.readCodexSavedSessionHistoryRecord
export const readCodexSavedConversationChanges: NonNullable<AgentProvider['readConversationChanges']> = history.readCodexSavedConversationChanges
