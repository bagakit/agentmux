import { split } from 'shlex'
import type { AppConfig } from '../../../shared/contracts'
import type { ExecutorDetectionState, HostExecutorInventoryState } from '../store'
import { currentExecutorDetection, executorDetectionKey } from './executor-detection'
import { configValuesEqual } from '../../../shared/config-edit'

export type ConfiguredExecutor = AppConfig['executors'][string] & { id: string }
export type ExecutorChoice = Pick<ConfiguredExecutor, 'id' | 'label' | 'providerId' | 'command'> & {
  executorRevision?: string
  detection?: ExecutorDetectionState | undefined
}
export function hostExecutorInventoryMatches(inventory: HostExecutorInventoryState | undefined, host: AppConfig['hosts'][number] | undefined): inventory is HostExecutorInventoryState {
  return Boolean(host && inventory && configValuesEqual(inventory.input, host))
}

/** One choice projection. Remote launch metadata always belongs to that target Host. */
export function executorsForHost(config: AppConfig | null | undefined, hostId: string | undefined,
  detections: Record<string, ExecutorDetectionState>, inventory: HostExecutorInventoryState | undefined, source?: 'host'): ExecutorChoice[] {
  const host = config?.hosts.find(item => item.id === hostId)
  if (!host) return []
  if (host.kind === 'local' && source !== 'host') return configuredExecutors(config).map(({ id, label, providerId, command, env }) => ({ id, label, providerId, command,
    detection: currentExecutorDetection(detections[executorDetectionKey(host.id, id)], id, { providerId, command, env }, host) }))
  if (!hostExecutorInventoryMatches(inventory, host)) return []
  return (inventory.result?.executors ?? []).map(item => ({ id: item.executorId, label: item.label, providerId: item.providerId,
    command: item.command, executorRevision: item.configRevision, detection: {
      state: inventory.state === 'error' ? 'error' : inventory.state === 'checking' ? 'checking'
        : item.availability === 'available' ? 'ready' : item.availability === 'missing' ? 'missing'
          : item.availability === 'check-failed' ? 'error' : 'idle',
      input: { executorId: item.executorId, providerId: item.providerId, command: item.command, host },
      ...(item.availability === 'missing' ? { result: {
        input: { executorId: item.executorId, providerId: item.providerId, command: item.command, host },
        executable: item.command, availability: 'missing' as const, ...(item.cause ? { cause: item.cause } : {})
      } } : {}),
      ...(inventory.detail || item.cause ? { detail: inventory.detail ?? `${item.cause!.code}: ${item.cause!.message}` } : {}),
      ...(inventory.observedAt === undefined ? {} : { observedAt: inventory.observedAt })
    } }))
}

export function configuredExecutors(config: AppConfig | null | undefined): ConfiguredExecutor[] {
  return Object.entries(config?.executors ?? {}).map(([id, executor]) => ({ id, ...executor }))
}

export function parseExecutorArgs(text: string): string[] { return split(text) }
