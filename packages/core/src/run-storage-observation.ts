import type { AgentMuxRunRef, AgentMuxRuntimeIdentity } from './types.js'
import type { RunStorageObservation } from '@ctxmux/sdk'

export type AgentMuxRunStorageFacts = {
  memory: { firstAvailableByte: number; latestOutputByte: number }
  /** Sampled owner watermarks; an unknown commit may have put disk ahead of confirmedByte. */
  persistence: null | { firstFailure: string | null; actorStopped: boolean; queuedAppendCommands: number;
    offeredByte: number; confirmedByte: number }
  policy: { memoryPerRunBytes: number; memorySharedBytes: number; replayPerRunBytes: number;
    replaySharedBytes: number; databaseBytes: number; walCheckpointBytes: number;
    terminalHistoryRows: number; terminalCheckpointBytes: number }
}
export type AgentMuxRunStorageObservation = {
  run: AgentMuxRunRef; runtime: AgentMuxRuntimeIdentity; observedAt: number
} & ({ status: 'observed'; storage: AgentMuxRunStorageFacts } |
  { status: 'unsupported'; message: string })

/** Project only public owner facts. No database access, disk-floor inference or health predicate. */
export function projectRunStorageFacts(value: RunStorageObservation): AgentMuxRunStorageFacts {
  const p = value.persistence, policy = value.policy
  return {
    memory: { firstAvailableByte: value.memory_first_available_byte, latestOutputByte: value.latest_output_bytes },
    persistence: p === null ? null : { firstFailure: p.first_failure, actorStopped: p.actor_stopped,
      queuedAppendCommands: p.queued_append_commands, offeredByte: p.offered_output_bytes, confirmedByte: p.committed_output_bytes },
    policy: { memoryPerRunBytes: policy.run_output_bytes, memorySharedBytes: policy.hot_output_bytes,
      replayPerRunBytes: policy.durable_run_output_bytes, replaySharedBytes: policy.durable_replay_bytes,
      databaseBytes: policy.database_bytes, walCheckpointBytes: policy.wal_checkpoint_bytes,
      terminalHistoryRows: policy.terminal_history_rows, terminalCheckpointBytes: policy.terminal_checkpoint_bytes }
  }
}
