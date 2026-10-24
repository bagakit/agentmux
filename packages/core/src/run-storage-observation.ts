import type { AgentMuxRunRef, AgentMuxRuntimeIdentity } from './types.js'
import type { RunStorageObservation, StorageFailure } from '@ctxmux/sdk'
import type { AgentMuxStorageFailure } from './errors.js'

export type AgentMuxRunStorageFacts = {
  memory: { firstAvailableByte: number; latestOutputByte: number }
  /** Sampled owner watermarks; an unknown commit may have put disk ahead of confirmedByte. */
  persistence: null | { firstFailure: string | null; storageFailure: AgentMuxStorageFailure | null; actorStopped: boolean; queuedAppendCommands: number;
    offeredByte: number; confirmedByte: number }
  policy: { memoryPerRunBytes: number; memorySharedBytes: number; replayPerRunBytes: number;
    replaySharedBytes: number; databaseBytes: number; walCheckpointBytes: number;
    terminalHistoryRows: number; terminalCheckpointBytes: number }
}
export type AgentMuxRunStorageObservation = {
  run: AgentMuxRunRef; runtime: AgentMuxRuntimeIdentity; observedAt: number
} & ({ status: 'observed'; storage: AgentMuxRunStorageFacts } |
  { status: 'unsupported'; message: string })

export function projectStorageFailure(value: StorageFailure): AgentMuxStorageFailure {
  return { stage: value.stage, sqlitePrimaryCode: value.sqlite_primary_code,
    sqliteExtendedCode: value.sqlite_extended_code, systemErrno: value.system_errno,
    transactionOutcome: value.transaction_outcome }
}

/** Project only public owner facts. No database access, disk-floor inference or health predicate. */
export function projectRunStorageFacts(value: RunStorageObservation): AgentMuxRunStorageFacts {
  const p = value.persistence, policy = value.policy
  return {
    memory: { firstAvailableByte: value.memory_first_available_byte, latestOutputByte: value.latest_output_bytes },
    persistence: p === null ? null : { firstFailure: p.first_failure, actorStopped: p.actor_stopped,
      storageFailure: p.storage_failure === null ? null : projectStorageFailure(p.storage_failure),
      queuedAppendCommands: p.queued_append_commands, offeredByte: p.offered_output_bytes, confirmedByte: p.committed_output_bytes },
    policy: { memoryPerRunBytes: policy.run_output_bytes, memorySharedBytes: policy.hot_output_bytes,
      replayPerRunBytes: policy.durable_run_output_bytes, replaySharedBytes: policy.durable_replay_bytes,
      databaseBytes: policy.database_bytes, walCheckpointBytes: policy.wal_checkpoint_bytes,
      terminalHistoryRows: policy.terminal_history_rows, terminalCheckpointBytes: policy.terminal_checkpoint_bytes }
  }
}
