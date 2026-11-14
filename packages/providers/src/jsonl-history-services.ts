import type { NativeProviderError } from './provider-error.js'

/* Native protocol readers project records through the original Core's JSONL source and materializer. */
export type NativeHistoryTarget = { source: { providerId: string; nativeSessionId: string }; signal: AbortSignal }
export type NativeHistoryReadBudget = { bytesRead: number; startedAt: number }
export type NativeHistoryText<Text> = string | Text

export type NativeHistoryPart<Text> = (
  | { kind: 'text'; text: NativeHistoryText<Text>; readingRange?: { start: number; end: number } }
  | { kind: 'resource'; resourceType: 'image' | 'audio' | 'file' | 'other' | 'text'; reference: NativeHistoryText<Text>; label?: string }
  | { kind: 'reasoning'; text: NativeHistoryText<Text>; signature?: NativeHistoryText<Text>; redacted?: boolean }
  | { kind: 'tool-call'; name: string; input: NativeHistoryText<Text>; callId?: string }
  | { kind: 'tool-result'; output: NativeHistoryText<Text>; name?: string; callId?: string; failed?: boolean }
) & {
  contentEligibility?: 'public' | 'private' | 'unconfirmed'
  contentRole?: 'tool' | 'reasoning'
}

export type NativeHistoryItem<Text> = {
  id: string
  turnId?: string
  kind: 'user-message' | 'assistant-message' | 'system-message' | 'activity'
  recordPurpose?: 'system-event'
  messagePhase?: 'progress' | 'final'
  contentParts: NativeHistoryPart<Text>[]
  title?: string
  startedAt?: number
  completedAt?: number
}

export type NativeHistoryReaderContext<Context> = Omit<Context, 'cursor' | 'transcriptPath' | 'limit'> & {
  cursor?: string
  transcriptPath?: string
  limit: number
}

export type NativeJsonlHistoryReader<Text, Item> = {
  readonly continuation: string | undefined
  readFirst(): Promise<Record<string, unknown> | null>
  readPrevious(): Promise<{ value: Record<string, unknown>; start: number; end: number } | null>
  repeatPrevious(): void
  verifyUnchanged(): Promise<void>
  nextCursor(continuation?: string): Promise<string | null>
  close(): Promise<void>
  materializeItem(item: NativeHistoryItem<Text>): Promise<Item>
}

export type NativeJsonlHistoryServices<Text, Context, Item> = {
  AgentMuxError: NativeProviderError
  NativeJsonlHistoryReader: { open(context: NativeHistoryReaderContext<Context>, budget?: NativeHistoryReadBudget): Promise<NativeJsonlHistoryReader<Text, Item>> }
  isNativeText(value: unknown): value is NativeHistoryText<Text>
  nativeJsonStringify(value: unknown, replacer?: null, space?: number): NativeHistoryText<Text>
  nativeTextConcat(...values: NativeHistoryText<Text>[]): NativeHistoryText<Text>
}
