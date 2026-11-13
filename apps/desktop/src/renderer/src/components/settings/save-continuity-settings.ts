import type { ContinuationSettings, ExecutionSettings } from './continuity-settings-fields'
import { saveConfigSlice } from './save-config-slice'

/** The original ConfigOwner merges authored field differences against their captured baseline. */
export async function saveContinuitySettings<T extends ExecutionSettings | ContinuationSettings>(value: T, expected: T): Promise<void> {
  await saveConfigSlice((current, settings: T) => ({ ...current, continuity: { ...current.continuity, ...settings } }), value, expected)
}
