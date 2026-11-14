import { createCursorNativeHistory } from '@agentmux/providers/cursor/native-history'
import type { AgentProvider } from '../agent-provider.js'
import { AgentMuxError } from '../errors.js'
import { NativeSqliteHistoryReader } from '../native-sqlite-history-reader.js'
import { observeNativeSqliteHistory } from '../native-sqlite-history-observer.js'
import { SESSION_HISTORY_MAX_PAGE_BYTES } from '../session-history.js'
import { executionEnvironmentValue, executionHomeDirectory, executionPath } from './execution-environment.js'

const history = createCursorNativeHistory({
  AgentMuxError, openStore: (path, signal) => NativeSqliteHistoryReader.open(path, signal), observeNativeSqliteHistory,
  SESSION_HISTORY_MAX_PAGE_BYTES, executionEnvironmentValue, executionHomeDirectory, executionPath
})

export const { cursorDataRoot, cursorConfigRoot, resolveCursorStorePath, readCursorStoreMetadata } = history
export const observeCursorSessionHistory: NonNullable<AgentProvider['observeSessionHistory']> = history.observeCursorSessionHistory
export const readCursorSessionHistoryPage: NonNullable<AgentProvider['readSessionHistoryPage']> = history.readCursorSessionHistoryPage
