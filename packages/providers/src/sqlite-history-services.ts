import type { NativeHistoryItem, NativeHistoryTarget } from './jsonl-history-services.js'
import type { NativeProviderError } from './provider-error.js'

export type NativeSqliteHistoryContext = NativeHistoryTarget & {
  workspacePath: string
  env: Readonly<NodeJS.ProcessEnv>
  transcriptPath?: string
  cursor?: string
  limit: number
}

export type NativeSqliteHistoryPage = {
  source: NativeHistoryTarget['source']
  items: NativeHistoryItem<string>[]
  nextCursor: string | null
}

export type NativeSqliteHistoryServices = {
  AgentMuxError: NativeProviderError
  SESSION_HISTORY_MAX_PAGE_BYTES: number
}
