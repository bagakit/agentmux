import { createClaudeNativeHistory } from '@agentmux/providers/claude/native-history'
import { createClaudeNativeCatalog } from '@agentmux/providers/claude/native-catalog'
import { createClaudeNativeRegistry } from '@agentmux/providers/claude/native-registry'
import { createClaudeNativeSession } from '@agentmux/providers/claude/native-session'
import { NativeJsonlHistoryReader, readNativeConversationChanges } from '../native-jsonl-history-reader.js'
import { isNativeText, nativeJsonStringify, nativeTextConcat, nativeTextJoin, type NativeText } from '../native-history-value.js'
import { nativeConversationProvenance } from '../conversation-provenance.js'
import { normalizeSessionHistoryMetrics } from '../session-history.js'
import { nativeInputCorrelationKey } from '../native-input-correlation.js'
import type { AgentProviderSessionHistoryContext, AgentSessionHistoryItem } from '../types.js'
import type { ProviderConversationChangesContext, ProviderConversationChangesPage } from '../session-history-changes.js'
import { AgentMuxError } from '../errors.js'
import type { AgentProvider } from '../agent-provider.js'
import { normalizeNativeSessionId } from '../agent-native-locator.js'
import { nativeProcessBirth, nativeProcessFiles } from '../agent-native-process.js'
import { linuxNativeProcessStart } from '../agent-native-process-linux.js'
import { runProcess } from '../process-runner.js'
import { assertNativeCatalogPath, nativeCatalogFiles, nativeCatalogIssue, readNativeCatalogFile } from './native-session-catalog-files.js'

const discoverClaudeRegisteredSession = createClaudeNativeRegistry({ AgentMuxError, nativeProcessBirth, linuxNativeProcessStart, runProcess })
const nativeSession = createClaudeNativeSession({ AgentMuxError, normalizeNativeSessionId, nativeProcessFiles, discoverClaudeRegisteredSession })
export const { locateClaudeNativeSessions }: Pick<ReturnType<typeof createClaudeNativeSession>, 'locateClaudeNativeSessions'> = nativeSession
export const discoverClaudeNativeSession: NonNullable<AgentProvider['discoverNativeSession']> = nativeSession.discoverClaudeNativeSession
const nativeCatalog = createClaudeNativeCatalog({ AgentMuxError, normalizeNativeSessionId, assertNativeCatalogPath,
  nativeCatalogFiles, nativeCatalogIssue, readNativeCatalogFile })
export const listClaudeNativeSessions: NonNullable<AgentProvider['listNativeSessions']> = nativeCatalog.listClaudeNativeSessions
export const assertClaudeNativeResumeSource: NonNullable<AgentProvider['assertNativeResumeSource']> = nativeCatalog.assertClaudeNativeResumeSource
export const claudeRecoveryFiles: NonNullable<AgentProvider['recoveryFiles']> = nativeCatalog.claudeRecoveryFiles

const nativeHistory = createClaudeNativeHistory<NativeText, AgentProviderSessionHistoryContext, AgentSessionHistoryItem,
  ProviderConversationChangesContext, ProviderConversationChangesPage, NativeJsonlHistoryReader>({
  AgentMuxError, NativeJsonlHistoryReader, readNativeConversationChanges, nativeConversationProvenance,
  normalizeSessionHistoryMetrics, nativeInputCorrelationKey, isNativeText, nativeJsonStringify, nativeTextConcat, nativeTextJoin
})
export const readClaudeSessionHistoryPage: NonNullable<AgentProvider['readSessionHistoryPage']> = nativeHistory.readClaudeSessionHistoryPage
export const readClaudeSessionHistoryRecord: NonNullable<AgentProvider['readSessionHistoryRecord']> = nativeHistory.readClaudeSessionHistoryRecord
export const readClaudeConversationChanges: NonNullable<AgentProvider['readConversationChanges']> = nativeHistory.readClaudeConversationChanges
