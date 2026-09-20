import type { AgentExecutorConfig, ExecutorDetectionInput, HostConfig } from '../../../shared/contracts'
import type { ExecutorDetectionState } from '../store'

type ExecutableInput = Pick<AgentExecutorConfig, 'providerId' | 'command'>

/** Only fields used by this executable check participate; launch options and labels do not. */
export function executorDetectionMatches(
  input: ExecutorDetectionInput | undefined,
  executorId: string,
  executor: ExecutableInput | undefined,
  host: HostConfig | undefined
): boolean {
  if (!input || !executor || !host || input.executorId !== executorId || input.providerId !== executor.providerId ||
    input.command !== executor.command || input.host.id !== host.id || input.host.kind !== host.kind) return false
  if (input.host.kind === 'local' && host.kind === 'local') return true
  return input.host.kind === 'ssh' && host.kind === 'ssh' && input.host.hostname === host.hostname &&
    input.host.user === host.user && input.host.port === host.port && input.host.identityFile === host.identityFile
}

/** A previous check cannot decorate another command or connection just because its ID survived. */
export function currentExecutorDetection(
  check: ExecutorDetectionState | undefined,
  executorId: string,
  executor: ExecutableInput | undefined,
  host: HostConfig | undefined
): ExecutorDetectionState | undefined {
  return executorDetectionMatches(check?.input, executorId, executor, host) ? check : undefined
}

export function executorDetectionLabel(check: ExecutorDetectionState | undefined): string {
  switch (check?.state) {
    case 'ready': return 'Available'
    case 'checking': return 'Checking'
    case 'error': return 'Check failed'
    case 'missing': return check.result?.availability === 'missing' && check.result.cause ? 'Not available' : 'Not installed'
    default: return 'Not checked'
  }
}
