import type { AgentMuxRuntimeFence, RecoveryStatus } from '@agentmux/core'

/** Exact original local Host observation, not a Renderer backup ledger. */
export type DesktopStorageRecoveryRead = { owner: AgentMuxRuntimeFence; status: RecoveryStatus }
