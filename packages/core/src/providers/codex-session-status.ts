import { createCodexSessionStatus } from '@agentmux/providers/codex/session-status'
import type { AgentProvider } from '../agent-provider.js'
import { AgentMuxError } from '../errors.js'
import { observeNativeJsonlHistory } from '../native-history-source-observer.js'

export const observeCodexSessionStatus: NonNullable<AgentProvider['observeSessionStatus']> =
  createCodexSessionStatus({ AgentMuxError, observeNativeJsonlHistory })
