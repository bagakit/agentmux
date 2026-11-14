import type { AppConfig, ComposerShortcut } from '../../../shared/contracts'
import { api } from './api'
import { useAppStore } from '../store'
import { configValuesEqual } from '../../../shared/config-edit'
import { saveConfigSlice } from '../components/settings/save-config-slice'

/** One original config transaction saves directory references and optional library edits together. */
export async function savePromptLibrarySettings(input: {
  directory: AppConfig['goalsCommonActions']
  expectedDirectory: AppConfig['goalsCommonActions']
  prompts?: { value: ComposerShortcut[]; expected: ComposerShortcut[] }
}): Promise<AppConfig> {
  type Side = { directory: AppConfig['goalsCommonActions']; prompts?: ComposerShortcut[] | undefined }
  return await saveConfigSlice((current, side: Side) => {
    const { goalsCommonActions: _previous, ...rest } = current
    return { ...rest, ...(side.directory ? { goalsCommonActions: side.directory } : {}), ...(side.prompts ? { composerShortcuts: side.prompts } : {}) }
  }, { directory: input.directory, prompts: input.prompts?.value }, { directory: input.expectedDirectory, prompts: input.prompts?.expected })
}

/** Goals edits only its ordered references and referenced Prompt fields at the same original owner. */
export async function saveGoalsCommonActions(input: Parameters<typeof savePromptLibrarySettings>[0]): Promise<AppConfig> {
  const current = useAppStore.getState().config
  if (!current) throw Object.assign(new Error('Settings are still loading. Your common actions are retained.'), { code: 'CONFIG_UNAVAILABLE' })
  const promptEdits = (input.prompts?.value ?? []).flatMap(prompt => {
    const previous = input.prompts?.expected.find(value => value.id === prompt.id)
    const fields = ({ id: _id, ...value }: ComposerShortcut) => value
    return configValuesEqual(prompt, previous) ? [] : [{ id: prompt.id, expected: previous ? fields(previous) : null, value: fields(prompt) }]
  })
  const committed = await api.config.configureGoalsCommonActions({ expected: input.expectedDirectory ?? null, directory: input.directory ?? null, ...(promptEdits.length ? { promptEdits } : {}) })
  if (useAppStore.getState().config === current) useAppStore.getState().setConfig(committed)
  return committed
}
