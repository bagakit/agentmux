import type { LaunchOptionSelection } from '../../../shared/contracts'

export type LauncherProviderOptions = Record<string, LaunchOptionSelection>
export type LauncherOptionDrafts = Record<string, LauncherProviderOptions>
export const EMPTY_LAUNCHER_OPTIONS: LauncherProviderOptions = {}
export const EMPTY_LAUNCH_OPTION_SELECTION: LaunchOptionSelection = {}

/** Explicit choices belong to one Provider; clearing a choice restores that Provider's default. */
export function updateLauncherOption(
  options: LauncherProviderOptions,
  providerId: string,
  optionId: string,
  choiceId: string | null
): LauncherProviderOptions {
  const selection = options[providerId] ?? EMPTY_LAUNCH_OPTION_SELECTION
  if ((selection[optionId] ?? null) === choiceId) return options
  const next = { ...selection }
  if (choiceId === null) delete next[optionId]
  else next[optionId] = choiceId
  const result = { ...options }
  if (Object.keys(next).length) result[providerId] = next
  else delete result[providerId]
  return result
}
