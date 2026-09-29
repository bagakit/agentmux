import type { AppConfig, ComposerShortcut, GoalsCommonActionsConfig } from '../../../shared/contracts'
import { api } from './api'
import { useAppStore } from '../store'

/** One original config transaction saves directory references and optional library edits together. */
export async function saveGoalsCommonActions(input: {
  directory: GoalsCommonActionsConfig
  expectedDirectory: AppConfig['goalsCommonActions']
  prompts?: { value: ComposerShortcut[]; expected: ComposerShortcut[] }
}): Promise<AppConfig> {
  const current = useAppStore.getState().config
  if (!current) throw new Error('配置尚未读取，草稿已保留。')
  const next = { ...current, goalsCommonActions: input.directory }
  const expected = { ...current }
  if (input.expectedDirectory) expected.goalsCommonActions = input.expectedDirectory
  else delete expected.goalsCommonActions
  if (input.prompts) { next.composerShortcuts = input.prompts.value; expected.composerShortcuts = input.prompts.expected }
  const saved = await api.config.save(next, expected)
  useAppStore.getState().setConfig(saved)
  return saved
}
