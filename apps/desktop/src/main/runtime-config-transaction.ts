import type { AppConfig } from '../shared/contracts.js'
import type { RuntimeController } from './runtime-controller.js'

type ConfigWriter = {
  save(config: AppConfig): Promise<AppConfig>
}

export async function saveRuntimeConfig(args: {
  runtime: RuntimeController
  configWriter: ConfigWriter
  next: AppConfig
}): Promise<AppConfig> {
  const preparation = await args.runtime.prepare(args.next)
  let saved: AppConfig
  try {
    saved = await args.configWriter.save(args.next)
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
