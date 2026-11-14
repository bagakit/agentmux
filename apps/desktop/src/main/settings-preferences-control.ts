import { createHash } from 'node:crypto'
import { parseSettingsPreferenceParams, type CommonActionsConfigure, type CommonActionsObservation, type SettingsPreferenceRequest, type SettingsPreferenceResult } from '@agentmux/core'
import { DEFAULT_GOALS_COMMON_ACTIONS, resolveGoalsCommonActions } from '@agentmux/host/goals-preferences'
import { ConfigConflict, configValuesEqual } from '../shared/config-edit.js'
import type { AppConfig } from '../shared/contracts.js'
import type { ConfigOwner } from './config-owner.js'
import { replaceSettingsPrompts, validateSettingsPrompt } from './settings-resources-control.js'

const key = (ref: { kind: string; id: string }) => ref.kind + ':' + ref.id
function observe(config: AppConfig): CommonActionsObservation {
  const directory = config.goalsCommonActions ?? null, effective = resolveGoalsCommonActions(config.goalsCommonActions)
  const prompts = config.composerShortcuts ?? []
  const availableRefs: CommonActionsObservation['availableRefs'] = [
    ...DEFAULT_GOALS_COMMON_ACTIONS.items.map(ref => ({ ref, label: ref.id })),
    ...prompts.map(prompt => ({ ref: { kind: 'prompt' as const, id: prompt.id }, label: prompt.label }))]
  return { directory, effective, revision: 'sha256:' + createHash('sha256').update(JSON.stringify({ directory, prompts })).digest('hex'), availableRefs,
    issues: effective.items.flatMap(ref => ref.kind === 'prompt' && !prompts.some(prompt => prompt.id === ref.id)
      ? [{ ref, code: 'PROMPT_NOT_FOUND' as const, message: 'The original referenced Prompt is unavailable. Its reference is retained.' }] : []) }
}

/** One original ConfigOwner transaction, including only referenced Prompt edits. */
export async function configureGoalsCommonActions(owner: ConfigOwner, value: CommonActionsConfigure): Promise<AppConfig> {
  const input = parseSettingsPreferenceParams('settings.goals.common-actions.configure', value)
  return owner.update(current => {
    if (!configValuesEqual(current.goalsCommonActions ?? null, input.expected)) throw new ConfigConflict('goalsCommonActions')
    const directory = input.directory ?? DEFAULT_GOALS_COMMON_ACTIONS
    const edits: Parameters<typeof replaceSettingsPrompts>[1][number][] = []
    for (const edit of input.promptEdits ?? []) {
      if (!directory.items.some(ref => ref.kind === 'prompt' && ref.id === edit.id)) throw Object.assign(new Error('A common action may edit only its referenced Prompt.'), { code: 'INVALID_SETTING_VALUE' })
      const existing = current.composerShortcuts?.find(prompt => prompt.id === edit.id)
      const fields = existing ? Object.fromEntries(Object.entries(existing).filter(([key]) => key !== 'id')) : null
      if (!configValuesEqual(fields, edit.expected)) {
        const changed = fields && edit.expected
          ? [...new Set([...Object.keys(fields), ...Object.keys(edit.expected)])].find(field => !configValuesEqual(fields[field], edit.expected![field]))
          : undefined
        throw new ConfigConflict('composerShortcuts.' + edit.id + (changed ? '.' + changed : ''))
      }
      edits.push({ id: edit.id, value: validateSettingsPrompt(edit.value) })
    }
    const next = edits.length ? replaceSettingsPrompts(current, edits) : current
    const previousRefs = new Set(resolveGoalsCommonActions(current.goalsCommonActions).items.map(key))
    for (const ref of directory.items) if (ref.kind === 'prompt' && !next.composerShortcuts?.some(prompt => prompt.id === ref.id) && !previousRefs.has(key(ref)))
      throw Object.assign(new Error('Discover the exact original Prompt before adding its reference.'), { code: 'SETTING_RESOURCE_NOT_FOUND' })
    const { goalsCommonActions: _previous, ...rest } = next
    return { ...rest, ...(input.directory === null ? {} : { goalsCommonActions: input.directory }) }
  })
}
export async function executeSettingsPreferencesControl(request: SettingsPreferenceRequest, owner: ConfigOwner): Promise<SettingsPreferenceResult> {
  const { operation, schemaVersion: _version, requestId: _id, ...body } = request
  const input = parseSettingsPreferenceParams(operation, body)
  if (operation === 'settings.goals.common-actions.inspect') return { operation, ...await owner.inspect(observe) }
  const saved = await configureGoalsCommonActions(owner, input as CommonActionsConfigure)
  return { operation, ...observe(saved) }
}
