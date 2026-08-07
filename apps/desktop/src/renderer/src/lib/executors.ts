import type { AppConfig } from '../../../shared/contracts'

export type ConfiguredExecutor = AppConfig['executors'][string] & { id: string }

export function configuredExecutors(config: AppConfig | null | undefined): ConfiguredExecutor[] {
  return Object.entries(config?.executors ?? {}).map(([id, executor]) => ({ id, ...executor }))
}
