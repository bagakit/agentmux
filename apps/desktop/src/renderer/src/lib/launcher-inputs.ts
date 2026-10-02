import { useAppStore } from '../store'
import { EMPTY_LAUNCHER_NAMES, launcherNameBinding, type LauncherNameField } from './launcher-name-draft'
import { launcherPromptBinding } from './launcher-prompt-draft'
import { EMPTY_LAUNCHER_OPTIONS } from './launcher-option-draft'
import { useLauncherState } from './launcher-state'
type LauncherInputState = ReturnType<typeof useAppStore.getState>

/** A real Region uses AppStore; an empty Group uses its existing durable Launcher draft. */
export function useLauncherInputs(regionId: string | undefined, launcherId: string) {
  const localPrompt = useLauncherState(state => regionId === undefined ? state.drafts[launcherId]?.prompt ?? '' : '')
  const localNames = useLauncherState(state => regionId === undefined ? state.drafts[launcherId]?.names ?? EMPTY_LAUNCHER_NAMES : EMPTY_LAUNCHER_NAMES)
  const localOptions = useLauncherState(state => regionId === undefined ? state.drafts[launcherId]?.optionsByProvider ?? EMPTY_LAUNCHER_OPTIONS : EMPTY_LAUNCHER_OPTIONS)
  const promptBinding = (state: LauncherInputState) => launcherPromptBinding({
    regionId, drafts: state.agentComposerDrafts, writeShared: state.setAgentComposerDraft,
    local: localPrompt, writeLocal: value => { useLauncherState.getState().setDraft(launcherId, 'prompt', value) }
  })
  const nameBinding = (state: LauncherInputState) => launcherNameBinding({
    regionId, drafts: state.launcherNameDrafts, writeShared: state.setLauncherNameDraft,
    local: localNames, writeLocal: (field, value) => { useLauncherState.getState().setAgentName(launcherId, field, value) }
  })
  const prompt = useAppStore(state => promptBinding(state).prompt)
  const names = useAppStore(state => nameBinding(state).names)
  const optionsByProvider = useAppStore(state => regionId === undefined
    ? localOptions : state.launcherOptionDrafts[regionId] ?? EMPTY_LAUNCHER_OPTIONS)
  const state = useAppStore.getState()
  return {
    prompt,
    setPrompt: (value: string) => promptBinding(state).set(value),
    names,
    setName: (field: LauncherNameField, value: string) => nameBinding(state).set(field, value),
    optionsByProvider,
    selectOption(providerId: string, optionId: string, choiceId: string | null) {
      if (regionId === undefined) useLauncherState.getState().setAgentOption(launcherId, providerId, optionId, choiceId)
      else state.setLauncherOptionDraft(regionId, providerId, optionId, choiceId)
    }
  }
}
