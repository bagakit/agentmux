import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { AgentMuxControlSettingsResourceFields as Fields } from './control.js'

export const GOALS_COMMON_ACTION_IDS = ['understand', 'ideas', 'next'] as const
export type GoalsCommonActionRef = { kind: 'builtin'; id: typeof GOALS_COMMON_ACTION_IDS[number] } | { kind: 'prompt'; id: string }
export type GoalsCommonActionsConfig = { items: GoalsCommonActionRef[]; collapsed: boolean }
export type CommonActionsConfigure = {
  expected: GoalsCommonActionsConfig | null; directory: GoalsCommonActionsConfig | null
  promptEdits?: Array<{ id: string; expected: Fields | null; value: Fields }>
}
export type CommonActionsObservation = {
  directory: GoalsCommonActionsConfig | null; effective: GoalsCommonActionsConfig; revision: string
  availableRefs: Array<{ ref: GoalsCommonActionRef; label: string }>
  issues: Array<{ ref: GoalsCommonActionRef; code: 'PROMPT_NOT_FOUND'; message: string }>
}
export type SettingsPreferenceParams = {
  'settings.goals.common-actions.inspect': Record<string, never>
  'settings.goals.common-actions.configure': CommonActionsConfigure
}
export type SettingsPreferenceResults = {
  'settings.goals.common-actions.inspect': CommonActionsObservation
  'settings.goals.common-actions.configure': CommonActionsObservation
}
export const SETTINGS_PREFERENCE_METHODS = {
  'settings.goals.common-actions.inspect': 'short', 'settings.goals.common-actions.configure': 'long'
} as const
export type SettingsPreferenceMethod = keyof typeof SETTINGS_PREFERENCE_METHODS
export const SETTINGS_PREFERENCE_OPERATIONS = Object.fromEntries(Object.keys(SETTINGS_PREFERENCE_METHODS).map(method => [method, method])) as { [M in SettingsPreferenceMethod]: M }
export type SettingsPreferenceRequest = { [M in SettingsPreferenceMethod]: { schemaVersion: typeof import('./control.js').AGENTMUX_CONTROL_SCHEMA_VERSION; requestId: string; operation: M } & SettingsPreferenceParams[M] }[SettingsPreferenceMethod]
export type SettingsPreferenceResult = { [M in SettingsPreferenceMethod]: { operation: M } & SettingsPreferenceResults[M] }[SettingsPreferenceMethod]
export function isSettingsPreferenceMethod(value: unknown): value is SettingsPreferenceMethod { return typeof value === 'string' && Object.hasOwn(SETTINGS_PREFERENCE_METHODS, value) }
function invalid(code: string): never { throw new AgentMuxError('The original structured preference is invalid.', code) }
function text(value: unknown, code: string): string { if (typeof value !== 'string' || !value) invalid(code); return value as string }
function ref(value: unknown, code: string): GoalsCommonActionRef {
  const p = rpcRecord(value, ['kind', 'id'], code), id = text(p.id, code)
  if (p.kind !== 'prompt' && (p.kind !== 'builtin' || !(GOALS_COMMON_ACTION_IDS as readonly string[]).includes(id))) invalid(code)
  return { kind: p.kind, id } as GoalsCommonActionRef
}
export function parseGoalsCommonActions(value: unknown, code = 'INVALID_CONTROL_REQUEST'): GoalsCommonActionsConfig {
  const p = rpcRecord(value, ['items', 'collapsed'], code)
  if (!Array.isArray(p.items) || typeof p.collapsed !== 'boolean') invalid(code)
  const items = (p.items as unknown[]).map(item => ref(item, code))
  if (new Set(items.map(item => item.kind + ':' + item.id)).size !== items.length) invalid(code)
  return { items, collapsed: p.collapsed as boolean }
}
export function parseSettingsPreferenceParams<M extends SettingsPreferenceMethod>(method: M, value: unknown): SettingsPreferenceParams[M] {
  const p = rpcRecord(value, method === 'settings.goals.common-actions.inspect' ? [] : ['expected', 'directory', 'promptEdits'])
  if (method === 'settings.goals.common-actions.inspect') return {} as SettingsPreferenceParams[M]
  const directory = p.directory === null ? null : parseGoalsCommonActions(p.directory)
  const expected = p.expected === null ? null : parseGoalsCommonActions(p.expected)
  let promptEdits: CommonActionsConfigure['promptEdits']
  if (p.promptEdits !== undefined) {
    if (!Array.isArray(p.promptEdits)) invalid('INVALID_CONTROL_REQUEST')
    const fields = (value: unknown) => structuredClone(rpcRecord(value, ['keyword', 'label', 'body', 'providerId', 'states', 'reactionIcon'])) as Fields
    promptEdits = (p.promptEdits as unknown[]).map(value => {
      const e = rpcRecord(value, ['id', 'expected', 'value'])
      return { id: text(e.id, 'INVALID_CONTROL_REQUEST'), expected: e.expected === null ? null : fields(e.expected), value: fields(e.value) }
    })
    if (new Set(promptEdits.map(edit => edit.id)).size !== promptEdits.length) invalid('INVALID_CONTROL_REQUEST')
  }
  return { expected, directory, ...(promptEdits === undefined ? {} : { promptEdits }) } as SettingsPreferenceParams[M]
}
export function parseSettingsPreferenceResult<M extends SettingsPreferenceMethod>(method: M, value: unknown): SettingsPreferenceResults[M] {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['directory', 'effective', 'revision', 'availableRefs', 'issues'], code)
  const directory = p.directory === null ? null : parseGoalsCommonActions(p.directory, code), effective = parseGoalsCommonActions(p.effective, code)
  if (!Array.isArray(p.availableRefs) || !Array.isArray(p.issues)) invalid(code)
  const availableRefs = (p.availableRefs as unknown[]).map(value => { const a = rpcRecord(value, ['ref', 'label'], code); return { ref: ref(a.ref, code), label: text(a.label, code) } })
  if (new Set(availableRefs.map(a => a.ref.kind + ':' + a.ref.id)).size !== availableRefs.length) invalid(code)
  const issues = (p.issues as unknown[]).map(value => {
    const i = rpcRecord(value, ['ref', 'code', 'message'], code)
    if (i.code !== 'PROMPT_NOT_FOUND') invalid(code)
    return { ref: ref(i.ref, code), code: 'PROMPT_NOT_FOUND' as const, message: text(i.message, code) }
  })
  return { directory, effective, revision: text(p.revision, code), availableRefs, issues } as SettingsPreferenceResults[M]
}
