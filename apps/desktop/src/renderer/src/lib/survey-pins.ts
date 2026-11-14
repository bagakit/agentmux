import { parseSurveyPinReference, type AgentMuxSurveyPinReference } from '@agentmux/core/control'

/** One scope in the original generic pin preference, independent of Profile and display location. */
export const SURVEY_PIN_SCOPE = 'survey-workbench'
export const surveyPinKey = (reference: AgentMuxSurveyPinReference): string => reference.kind === 'zone'
  ? JSON.stringify(['zone', reference.zoneId]) : JSON.stringify(['page', reference.regionId, reference.browserId])
export type SurveyPinReadRecovery = { source: unknown; issue: string }
function reference(value: unknown): AgentMuxSurveyPinReference | null {
  if (typeof value !== 'string') return null
  try {
    const tuple: unknown = JSON.parse(value)
    if (!Array.isArray(tuple)) return null
    return tuple[0] === 'zone' && tuple.length === 2 ? parseSurveyPinReference({ kind: 'zone', zoneId: tuple[1] })
      : tuple[0] === 'page' && tuple.length === 3 ? parseSurveyPinReference({ kind: 'page', regionId: tuple[1], browserId: tuple[2] }) : null
  } catch { return null }
}
export function readSurveyPins(value: unknown): { references: AgentMuxSurveyPinReference[]; recovery: SurveyPinReadRecovery | null } {
  if (value === undefined) return { references: [], recovery: null }
  const references = new Map<string, AgentMuxSurveyPinReference>()
  let unread = !Array.isArray(value)
  if (Array.isArray(value)) for (const entry of value) {
    const original = reference(entry)
    if (original) references.set(surveyPinKey(original), original)
    else unread = true
  }
  return { references: [...references.values()], recovery: unread ? { source: value,
    issue: 'Some original Survey pin preferences are unreadable. Their data is kept; known items can still be unpinned without replacing the other records.' } : null }
}
export function surveyPinnedReferences(state: { pinnedItems: Record<string, string[]>; surveyPinReadRecovery?: SurveyPinReadRecovery | null }): AgentMuxSurveyPinReference[] {
  return readSurveyPins(state.surveyPinReadRecovery ? state.surveyPinReadRecovery.source : state.pinnedItems[SURVEY_PIN_SCOPE]).references
}
export function restoreSurveyPinPreferences(pinnedItems: Record<string, string[]>, raw: unknown) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>)[SURVEY_PIN_SCOPE] : undefined
  const read = readSurveyPins(value)
  const next = { ...pinnedItems }
  if (read.references.length) next[SURVEY_PIN_SCOPE] = read.references.map(surveyPinKey)
  else delete next[SURVEY_PIN_SCOPE]
  return { pinnedItems: next, surveyPinReadRecovery: read.recovery }
}
/** Edit only the named original key; unread neighboring records stay in the same durable scope. */
export function changeSurveyPin(state: { pinnedItems: Record<string, string[]>; surveyPinReadRecovery?: SurveyPinReadRecovery | null }, target: AgentMuxSurveyPinReference, pinned: boolean) {
  const source = state.surveyPinReadRecovery ? state.surveyPinReadRecovery.source : state.pinnedItems[SURVEY_PIN_SCOPE] ?? []
  if (!Array.isArray(source)) return null
  const key = surveyPinKey(target), next = source.filter(entry => {
    const parsed = reference(entry)
    return !parsed || surveyPinKey(parsed) !== key
  })
  if (pinned) next.push(key)
  return restoreSurveyPinPreferences(state.pinnedItems, { [SURVEY_PIN_SCOPE]: next })
}
export function persistedSurveyPins(state: { pinnedItems: Record<string, string[]>; surveyPinReadRecovery: SurveyPinReadRecovery | null }): unknown {
  return state.surveyPinReadRecovery ? { ...state.pinnedItems, [SURVEY_PIN_SCOPE]: state.surveyPinReadRecovery.source } : state.pinnedItems
}
