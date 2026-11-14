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
    args.runtime.validatePreparation(preparation)
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


/** Recover a saved document's facts without saving it again or repeating client preparation effects. */
export async function confirmRuntimeConfig(args: {
  runtime: RuntimeController
  configWriter: { confirmSaved(config: AppConfig): Promise<void> }
  saved: AppConfig
}): Promise<AppConfig> {
  const preparation = await args.runtime.prepare(args.saved)
  try {
    args.runtime.validatePreparation(preparation)
    if (configWithRuntimeBindings(args.saved, preparation) !== args.saved) {
      throw new Error('The original saved configuration has an unconfirmed Runtime binding. No replacement configuration was written; inspect that original Host before retrying the edit.')
    }
    await args.configWriter.confirmSaved(args.saved)
  } catch (error) {
    try { await args.runtime.discard(preparation) }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Configuration readback and prepared Runtime cleanup both failed.') }
    throw error
  }
  // As with the original save: a committed Runtime is never discarded as failed preparation.
  args.runtime.commit(preparation)
  return args.saved
}
