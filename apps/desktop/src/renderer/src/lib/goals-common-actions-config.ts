import type { AppConfig, ComposerShortcut } from '../../../shared/contracts'
import { saveConfigSlice } from '../components/settings/save-config-slice'

/** One original config transaction saves directory references and optional library edits together. */
export async function saveGoalsCommonActions(input: {
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
