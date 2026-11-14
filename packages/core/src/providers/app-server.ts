import { createAppServerNativeHistory } from '@agentmux/providers/app-server/native-history'
import { createAppServerNativeRead } from '@agentmux/providers/app-server/native-read'
import { createAppServerNativeSession } from '@agentmux/providers/app-server/native-session'
import { createCodexQuestionProtocol } from '@agentmux/providers/codex/question'
import { normalizeNativeSessionId } from '../agent-native-locator.js'
import { nativeProcessFiles } from '../agent-native-process.js'
import { AgentMuxError } from '../errors.js'
import { SESSION_HISTORY_MAX_PAGE_BYTES, SESSION_HISTORY_TIMEOUT_MS } from '../session-history.js'
import type {
  AgentProviderSessionHistoryContext, AgentProviderSessionHistoryPage, AgentProviderSessionHistoryRecordContext, AgentSessionHistoryItem
} from '../types.js'

const questions = createCodexQuestionProtocol(AgentMuxError)
export const { codexQuestionRequest, codexQuestionAnswers, planCodexQuestionReply } = questions
export const withAppServerNativeRead = createAppServerNativeRead({
  AgentMuxError, SESSION_HISTORY_MAX_PAGE_BYTES, SESSION_HISTORY_TIMEOUT_MS
})
export const { locateAppServerNativeSession, discoverAppServerNativeSession } = createAppServerNativeSession({
  AgentMuxError, normalizeNativeSessionId,
  nativeProcessFiles: (processId, signal, scope) => nativeProcessFiles(processId, signal, scope)
})
export const { readAppServerSessionHistoryPage, readAppServerSessionHistoryRecord }: {
  readAppServerSessionHistoryPage(context: AgentProviderSessionHistoryContext): Promise<AgentProviderSessionHistoryPage>
  readAppServerSessionHistoryRecord(context: AgentProviderSessionHistoryRecordContext): Promise<AgentSessionHistoryItem>
} = createAppServerNativeHistory({
  AgentMuxError, withAppServerNativeRead, ...questions
})
