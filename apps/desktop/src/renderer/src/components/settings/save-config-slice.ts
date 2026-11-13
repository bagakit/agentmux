import { api } from '../../lib/api'
import { useAppStore } from '../../store'
import type { AppConfig } from '../../../../shared/contracts'

/**
 * The one way a settings section saves.
 *
 * `slice` turns a section's own values into a complete configuration built on the store's current
 * configuration; it is called once with the draft and once with the baseline the draft was edited
 * from, so ConfigOwner merges only what this section authored. A section never reports success while
 * configuration is unavailable. The owner's receipt is applied only while nothing newer has been
 * observed, so a lost change event cannot leave the page behind and a later publication always wins.
 */
export async function saveConfigSlice<T>(slice: (current: AppConfig, value: T) => AppConfig, value: T, expected: T): Promise<AppConfig> {
  const current = useAppStore.getState().config
  if (!current) throw Object.assign(new Error('Settings are still loading. Your changes are kept; save again once they load.'), { code: 'CONFIG_UNAVAILABLE' })
  const committed = await api.config.save(slice(current, value), slice(current, expected))
  if (useAppStore.getState().config === current) useAppStore.getState().setConfig(committed)
  return committed
}
