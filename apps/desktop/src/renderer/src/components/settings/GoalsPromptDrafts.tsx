import { createContext, useContext, useState, type ReactNode } from 'react'
import type { AppConfig, ComposerShortcut, GoalsCommonActionRef } from '../../../../shared/contracts'
import { isPromptReactionCode } from '@agentmux/core/prompt-reaction'
import { resolveComposerShortcuts } from '../../../../shared/composer-shortcut-library'
import { configValuesEqual } from '../../../../shared/config-edit'
import { createCommonActionPrompt, DEFAULT_GOALS_COMMON_ACTIONS } from '../../lib/goals-common-actions'
import { saveGoalsCommonActions, savePromptLibrarySettings } from '../../lib/goals-common-actions-config'
import { useResourceDrafts } from './use-resource-drafts'
import { useSettingDraftRecord } from './use-setting-draft'
import { useSettingsSave } from './SettingsSaveBar'

export function promptProblems(prompts: readonly ComposerShortcut[]) {
  const counts = new Map<string, number>()
  for (const prompt of prompts) counts.set(prompt.keyword.trim(), (counts.get(prompt.keyword.trim()) ?? 0) + 1)
  return prompts.flatMap(prompt => {
    const keyword = prompt.keyword.trim()
    const errors: Array<{ id: string; field: 'Keyword' | 'Prompt'; message: string }> = []
    if (!keyword) errors.push({ id: prompt.id, field: 'Keyword', message: 'Add a keyword to reach this prompt.' })
    else if (counts.get(keyword)! > 1) errors.push({ id: prompt.id, field: 'Keyword', message: `“${keyword}” is already used by another prompt.` })
    if (prompt.reactionIcon && !isPromptReactionCode(keyword)) errors.push({ id: prompt.id, field: 'Keyword', message: 'Quick reply codes use up to 48 lowercase letters, digits or hyphens and start with a letter.' })
    if (!prompt.body.trim()) errors.push({ id: prompt.id, field: 'Prompt', message: 'Write the instruction this prompt will use.' })
    return errors
  })
}
const promptRecords = (prompts: readonly ComposerShortcut[]) => Object.fromEntries(prompts.map(prompt => [prompt.id, prompt]))

/** One Settings lifetime owns the library and its Goals references; selection stays in each view. */
function useGoalsPromptDrafts(config: AppConfig) {
  const resource = useResourceDrafts(promptRecords(resolveComposerShortcuts(config)))
  const directory = useSettingDraftRecord({ items: config.goalsCommonActions?.items, collapsed: config.goalsCommonActions?.collapsed }, configValuesEqual)
  const commonConfig = (value: typeof directory.value): AppConfig['goalsCommonActions'] => value.items === undefined && value.collapsed === undefined ? undefined
    : { items: value.items ?? DEFAULT_GOALS_COMMON_ACTIONS.items, collapsed: value.collapsed ?? DEFAULT_GOALS_COMMON_ACTIONS.collapsed }
  const common = commonConfig(directory.value) ?? DEFAULT_GOALS_COMMON_ACTIONS
  const [autoLabels, setAutoLabels] = useState<ReadonlySet<string>>(() => new Set())
  const [editRequest, setEditRequest] = useState<{ id: string } | null>(null)
  const saveState = useSettingsSave()
  // Goals never commits a library deletion. Only live, currently referenced bodies are in its scope.
  const commonIds = [...new Set(common.items.flatMap(ref => ref.kind === 'prompt' && Object.hasOwn(resource.value, ref.id) ? [ref.id] : []))]
  const commonValues = { ...resource.expected }
  for (const id of commonIds) commonValues[id] = resource.value[id]!
  const commonProblems = promptProblems(Object.values(commonValues)).filter(problem => commonIds.includes(problem.id))
  const commonDirty = directory.dirty || commonIds.some(id => !configValuesEqual(resource.value[id], resource.expected[id]))

  function update(id: string, patch: Partial<ComposerShortcut>) {
    if (Object.hasOwn(patch, 'label')) setAutoLabels(current => { const next = new Set(current); next.delete(id); return next })
    resource.setValue(current => ({ ...current, [id]: { ...current[id]!, ...patch } }))
  }
  function changeItems(items: GoalsCommonActionRef[]) {
    directory.setField('items', configValuesEqual(items, directory.expected.items ?? DEFAULT_GOALS_COMMON_ACTIONS.items) ? directory.expected.items : items)
  }
  function addCommon() {
    const prompt = createCommonActionPrompt('', Object.values(resource.value))
    setAutoLabels(current => new Set([...current, prompt.id]))
    resource.setValue(current => ({ ...current, [prompt.id]: prompt }))
    changeItems([...common.items, { kind: 'prompt', id: prompt.id }])
    setEditRequest({ id: prompt.id })
  }
  function forgetAutoLabel(id: string) { setAutoLabels(current => { const next = new Set(current); next.delete(id); return next }) }

  async function save(scope: 'goals' | 'prompts'): Promise<boolean> {
    if (saveState.saving || resource.saving) return false
    const ids = scope === 'goals' ? commonIds : undefined
    const captured = scope === 'goals' ? { ...resource.expected } : { ...resource.value }
    if (ids) for (const id of ids) captured[id] = resource.value[id]!
    const submittedAutoLabels = new Set([...autoLabels].filter(id => Object.hasOwn(captured, id) && (!ids || ids.includes(id))))
    const normalized = Object.values(captured).map(candidate => ids && !ids.includes(candidate.id) ? candidate : ({ ...candidate,
      keyword: candidate.keyword.trim(), label: submittedAutoLabels.has(candidate.id)
        ? createCommonActionPrompt(candidate.body, [], candidate.id).label : candidate.label.trim() || candidate.keyword.trim(), body: candidate.body }))
    // Put implicit metadata in the visible draft before capturing its submitted version.
    // A later explicit name must never compare equal to an earlier placeholder.
    for (const candidate of normalized) if (submittedAutoLabels.has(candidate.id)) captured[candidate.id] = { ...captured[candidate.id]!, label: candidate.label }
    resource.setValue(current => {
      const next = { ...current }
      for (const id of submittedAutoLabels) if (current[id] === resource.value[id] && captured[id]) next[id] = captured[id]!
      return next
    })
    const submitted = resource.beginSave(captured, ids)
    const submittedDirectory = directory.beginSave()
    let accepted: AppConfig | undefined
    const committed = await saveState.run(async () => {
      accepted = await (scope === 'goals' ? saveGoalsCommonActions : savePromptLibrarySettings)({ directory: commonConfig(submittedDirectory.value), expectedDirectory: commonConfig(submittedDirectory.expected),
        prompts: { value: normalized, expected: Object.values(submitted.expected) } })
    })
    submitted.finish(accepted ? promptRecords(resolveComposerShortcuts(accepted)) : undefined)
    submittedDirectory.finish(committed)
    if (committed) setAutoLabels(current => new Set([...current].filter(id => !submittedAutoLabels.has(id))))
    return committed
  }
  function useSaved(scope: 'goals' | 'prompts') {
    const ids = scope === 'goals' ? commonIds : undefined
    resource.useSaved(ids); directory.useSaved()
    setAutoLabels(current => ids ? new Set([...current].filter(id => !ids.includes(id))) : new Set())
  }
  function keepMine(scope: 'goals' | 'prompts') { resource.keepMine(scope === 'goals' ? commonIds : undefined); directory.keepMine() }
  return { resource, directory, common, commonDirty, commonProblems, commonIds, saveState, editRequest, update, changeItems, addCommon, forgetAutoLabel,
    requestEdit: (id: string) => setEditRequest({ id }),
    saveCommon: () => save('goals'), savePrompts: () => save('prompts'),
    commonResolution: { useSaved: () => useSaved('goals'), keepMine: () => keepMine('goals') },
    promptsResolution: { useSaved: () => useSaved('prompts'), keepMine: () => keepMine('prompts') } }
}
const GoalsPromptDraftContext = createContext<ReturnType<typeof useGoalsPromptDrafts> | null>(null)
function GoalsPromptDraftOwner({ config, children }: { config: AppConfig; children: ReactNode }) {
  const drafts = useGoalsPromptDrafts(config)
  return <GoalsPromptDraftContext.Provider value={drafts}>{children}</GoalsPromptDraftContext.Provider>
}
/** Only the two related panes live here. Other visited panes keep their original parent and instance. */
export function GoalsPromptDraftProvider({ config, enabled, children }: { config: AppConfig; enabled: boolean; children: ReactNode }) {
  return enabled ? <GoalsPromptDraftOwner config={config}>{children}</GoalsPromptDraftOwner> : null
}
export function useGoalsPrompts() {
  const drafts = useContext(GoalsPromptDraftContext)
  if (!drafts) throw new Error('Goals and Prompts must use their retained Settings draft owner')
  return drafts
}
