import { useState } from 'react'
import { useAppStore } from '../store'
import { EMPTY_LAUNCHER_NAMES, launcherNameBinding, type LauncherNameField } from './launcher-name-draft'
import { launcherPromptBinding } from './launcher-prompt-draft'
import { EMPTY_LAUNCHER_OPTIONS, updateLauncherOption } from './launcher-option-draft'
type LauncherInputState = ReturnType<typeof useAppStore.getState>

/** Original Region inputs survive pending launches without subscribing to other drafts. */
export function useLauncherInputs(regionId: string | undefined) {
  const [localPrompt, setLocalPrompt] = useState('')
  const [localNames, setLocalNames] = useState(EMPTY_LAUNCHER_NAMES)
  const [localOptions, setLocalOptions] = useState(EMPTY_LAUNCHER_OPTIONS)
  const promptBinding = (state: LauncherInputState) => launcherPromptBinding({
    regionId, drafts: state.agentComposerDrafts, writeShared: state.setAgentComposerDraft,
    local: localPrompt, writeLocal: setLocalPrompt
  })
  const nameBinding = (state: LauncherInputState) => launcherNameBinding({
    regionId, drafts: state.launcherNameDrafts, writeShared: state.setLauncherNameDraft,
    local: localNames, writeLocal: (field, value) => setLocalNames(current => ({ ...current, [field]: value }))
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
      if (regionId === undefined) setLocalOptions(current => updateLauncherOption(current, providerId, optionId, choiceId))
      else state.setLauncherOptionDraft(regionId, providerId, optionId, choiceId)
    }
  }
}
