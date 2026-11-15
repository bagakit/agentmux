import { createCodexSessionStatus } from '@agentmux/providers/codex/session-status'
import type { AgentProvider } from '../agent-provider.js'
import { AgentMuxError } from '../errors.js'
import { observeNativeJsonlHistory } from '../native-history-source-observer.js'
import { NativeJsonlHistoryReader } from '../native-jsonl-history-reader.js'

export const observeCodexSessionStatus: NonNullable<AgentProvider['observeSessionStatus']> =
  createCodexSessionStatus({ AgentMuxError, observeNativeJsonlHistory,
    openNativeHistory: ({ nativeSessionId, ...context }) => NativeJsonlHistoryReader.open({
      ...context, source: { providerId: 'codex', nativeSessionId }, command: '', args: [], env: {}, limit: 1,
    }),
  })
