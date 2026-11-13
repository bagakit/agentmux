import { resolveFocusRecentActivityHours, type FocusPreferences } from '../../../shared/focus-preferences'
import { configValuesEqual } from '../../../shared/config-edit'
import { saveConfigSlice } from '../components/settings/save-config-slice'

/** Both the Focus editor and map control submit only their authored choices to ConfigOwner. */
export async function saveFocusPreferences(value: Partial<FocusPreferences>, expected: Partial<FocusPreferences>): Promise<void> {
  // Only authored keys are written; each side keeps every other Focus key as the owner has it.
  const authored = (Object.keys(value) as (keyof FocusPreferences)[]).filter(key => !configValuesEqual(value[key], expected[key]))
  await saveConfigSlice((current, side: Partial<FocusPreferences>) => {
    const focus = { recentActivityHours: resolveFocusRecentActivityHours(current.focus?.recentActivityHours), ...current.focus }
    for (const key of authored) Object.assign(focus, { [key]: side[key] })
    return { ...current, focus }
  }, value, expected)
}
