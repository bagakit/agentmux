import type { AppConfig } from '../shared/contracts.js'
import type { RuntimeController, RuntimePreparation } from './runtime-controller.js'

type ConfigWriter = {
  save(config: AppConfig): Promise<AppConfig>
}

/** Save a learned semantic binding through the existing configuration owner. */
export function configWithRuntimeBindings(config: AppConfig, preparation: Pick<RuntimePreparation, 'runtimeBindings'>): AppConfig {
  const bindings = preparation.runtimeBindings ?? new Map<string, string>()
  if (bindings.size === 0) return config
  let changed = false
  const hosts = config.hosts.map(host => {
    const runtimeId = bindings.get(host.id)
    if (host.kind !== 'ssh' || runtimeId === undefined || host.runtimeId === runtimeId) return host
    if (host.runtimeId !== undefined) throw new Error(`Runtime binding changed for ${host.id}`)
    changed = true
    return { ...host, runtimeId }
  })
  return changed ? { ...config, hosts } : config
}

export async function saveRuntimeConfig(args: {
  runtime: RuntimeController
  configWriter: ConfigWriter
  next: AppConfig
}): Promise<AppConfig> {
  const preparation = await args.runtime.prepare(args.next)
  let saved: AppConfig
  try {
    saved = await args.configWriter.save(configWithRuntimeBindings(args.next, preparation))
  } catch (error) {
    try {
      await args.runtime.discard(preparation)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Config save and prepared Runtime cleanup both failed.')
    }
    throw error
  }
  args.runtime.commit(preparation)
  return saved
}
