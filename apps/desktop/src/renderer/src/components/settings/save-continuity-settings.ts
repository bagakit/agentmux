import { api } from '../../lib/api'
import { useAppStore } from '../../store'
import type { ContinuationSettings, ExecutionSettings } from './continuity-settings-fields'

/** The original ConfigOwner merges authored field differences against their captured baseline. */
export async function saveContinuitySettings<T extends ExecutionSettings | ContinuationSettings>(value: T, expected: T): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) throw new Error('Configuration is unavailable. Your choices are kept; reload configuration and retry saving.')
  await api.config.save({ ...current, continuity: { ...current.continuity, ...value } },
    { ...current, continuity: { ...current.continuity, ...expected } })
}
