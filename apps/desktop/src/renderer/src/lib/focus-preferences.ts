import { resolveFocusRecentActivityHours, type FocusPreferences } from '../../../shared/focus-preferences'
import { configValuesEqual } from '../../../shared/config-edit'
import { useAppStore } from '../store'
import { api } from './api'

/** Both the Focus editor and map control submit only their authored choices to ConfigOwner. */
export async function saveFocusPreferences(value: Partial<FocusPreferences>, expected: Partial<FocusPreferences>): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) throw new Error('Configuration is unavailable. Your Focus choices are kept; reload configuration and retry saving.')
  const nextFocus = { recentActivityHours: resolveFocusRecentActivityHours(current.focus?.recentActivityHours), ...current.focus }
  const expectedFocus = { ...nextFocus }
  for (const key of Object.keys(value) as (keyof FocusPreferences)[]) {
    if (configValuesEqual(value[key], expected[key])) continue
    Object.assign(nextFocus, { [key]: value[key] }); Object.assign(expectedFocus, { [key]: expected[key] })
  }
  await api.config.save({ ...current, focus: nextFocus }, { ...current, focus: expectedFocus })
}
