import type { AgentMuxSpaceControlRequest, AgentMuxSurveyListReport, AgentMuxSurveyOrganization, AgentMuxSpatialSave } from '@agentmux/core/control'
import { parseSurveyOrganization, parseSurveyCollectionChange } from '@agentmux/core/control'

export const EMPTY_SURVEY_ORGANIZATION: AgentMuxSurveyOrganization = { ungrouped: [], groups: [] }

/** Restore only client presentation. Missing topology never retires a saved reference. */
export function restoreSurveyOrganization(value: unknown): AgentMuxSurveyOrganization {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const seen = new Set<string>(), groupIds = new Set<string>()
  const ids = (values: unknown): string[] => Array.isArray(values) ? values.flatMap(id => {
    if (typeof id !== 'string' || !id.trim() || /[\0\r\n]/u.test(id) || seen.has(id)) return []
    seen.add(id); return [id]
  }) : []
  const ungrouped = ids(raw.ungrouped)
  const groups = Array.isArray(raw.groups) ? raw.groups.flatMap(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const group = value as Record<string, unknown>
    if (typeof group.groupId !== 'string' || !group.groupId.trim() || /[\0\r\n]/u.test(group.groupId) || groupIds.has(group.groupId) || typeof group.name !== 'string' || typeof group.collapsed !== 'boolean') return []
    groupIds.add(group.groupId)
    return [{ groupId: group.groupId, name: group.name, collapsed: group.collapsed, zoneIds: ids(group.zoneIds) }]
  }) : []
  return { ungrouped, groups }
}

export function surveyOrganizationZoneIds(organization: AgentMuxSurveyOrganization): string[] {
  return [...organization.ungrouped, ...organization.groups.flatMap(group => group.zoneIds)]
}

/** Membership remains at collected; collapsed groups still publish every original member. */
export function effectiveSurveyOrganization(organization: AgentMuxSurveyOrganization | undefined, collected: Readonly<Record<string, true>>): AgentMuxSurveyOrganization {
  const original = restoreSurveyOrganization(organization), members = Object.keys(collected).filter(id => collected[id] === true)
  const kept = (ids: string[]) => ids.filter(id => Object.hasOwn(collected, id) && collected[id] === true)
  const known = new Set(surveyOrganizationZoneIds(original))
  return { ungrouped: [...kept(original.ungrouped), ...members.filter(id => !known.has(id))],
    groups: original.groups.map(group => ({ ...group, zoneIds: kept(group.zoneIds) })) }
}

type State = { surveyOrganization: AgentMuxSurveyOrganization; surveyCollectedZones: Record<string, true> }
type Ports = { get(): State; set(state: State): void; hasZone(zoneId: string): boolean; save(): Promise<AgentMuxSpatialSave> }
type Request = Extract<AgentMuxSpaceControlRequest, { operation: 'space.survey-list' }>

export const surveyCollectedZoneIds = (collected: Readonly<Record<string, true>>): string[] => Object.keys(collected).filter(id => collected[id] === true)
const sameMembers = (left: string[], right: string[]) => { const members = new Set(right); return left.length === members.size && left.every(id => members.has(id)) }

/** Original references may remain unavailable; only an explicit new member needs a confirmed Zone. */
export function changeSurveyCollection(before: Record<string, true>, zoneIds: string[], hasZone: Ports['hasZone']): Record<string, true> | null {
  if (zoneIds.some(id => before[id] !== true && !hasZone(id))) return null
  const requested = new Set(zoneIds), original = surveyCollectedZoneIds(before)
  const kept = original.filter(id => requested.has(id)), added = zoneIds.filter(id => before[id] !== true).sort()
  if (kept.length === original.length && !added.length) return before
  return Object.fromEntries([...kept, ...added].map(id => [id, true as const]))
}

/** One GUI/public owner; only this request is refused on a stale or foreign target. */
export async function executeSurveyList(ports: Ports, request: Request): Promise<AgentMuxSurveyListReport> {
  const state = ports.get(), before = state.surveyOrganization, originalMembers = surveyCollectedZoneIds(state.surveyCollectedZones)
  const report = (outcome: AgentMuxSurveyListReport['outcome'], issues: AgentMuxSurveyListReport['issues'] = [], save: AgentMuxSpatialSave | null = null,
    applied = before, members = state.surveyCollectedZones): AgentMuxSurveyListReport => ({ scope: 'survey-list', storedOrganization: applied,
    collectedZoneIds: surveyCollectedZoneIds(members), effectiveOrganization: effectiveSurveyOrganization(applied, members),
    changed: JSON.stringify(applied) !== JSON.stringify(before) || !sameMembers(surveyCollectedZoneIds(members), originalMembers), outcome, save, issues })
  if (request.organization === undefined && request.collection === undefined) return report('read')
  let next = before, expected = before, collection: Request['collection']
  try {
    if (request.organization !== undefined) { next = parseSurveyOrganization(request.organization); expected = parseSurveyOrganization(request.expected) }
    if (request.collection !== undefined) collection = parseSurveyCollectionChange(request.collection)
  }
  catch (error) { return report('refused', [{ step: 'target', code: 'SURVEY_LIST_INVALID_ORGANIZATION',
    message: error instanceof Error ? error.message : String(error), recovery: 'Read this same list and provide each exact original item and group once. Existing work is retained.' }]) }
  if (JSON.stringify(expected) !== JSON.stringify(before)) return report('refused', [{ step: 'target', code: 'SURVEY_LIST_CONFLICT',
    message: 'The original Survey list organization changed after it was read.', recovery: 'Read this same Survey list and review its current preference before changing it.' }])
  if (collection && !sameMembers(collection.expectedZoneIds, originalMembers)) return report('refused', [{ step: 'target', code: 'SURVEY_LIST_COLLECTION_CONFLICT',
    message: 'The original explicit Survey membership changed after it was read.', recovery: 'Read this same list and review its current members before another change.' }])
  const appliedMembers = collection ? changeSurveyCollection(state.surveyCollectedZones, collection.zoneIds, ports.hasZone) : state.surveyCollectedZones
  if (!appliedMembers) return report('refused', [{ step: 'target', code: 'SURVEY_LIST_ZONE_UNCONFIRMED',
    message: 'A new Survey member has no confirmed original Zone.', recovery: 'Inspect that exact Zone and retry this explicit change when its identity is confirmed. Existing references and work remain.' }])
  const ids = surveyOrganizationZoneIds(next)
  const originals = new Set([...surveyCollectedZoneIds(appliedMembers), ...surveyOrganizationZoneIds(before)])
  if (ids.some(id => !originals.has(id))) return report('refused', [{ step: 'target', code: 'SURVEY_LIST_MEMBER_UNCONFIRMED',
    message: 'A requested Zone is not in the original explicit Survey list or its saved organization.',
    recovery: 'Read the same Survey list. Existing references, work surfaces and healthy Runs are retained.' }])
  // Omitted originals return to the ungrouped area; organization never removes membership.
  const requested = new Set(ids)
  const applied = request.organization === undefined ? before : { ...next, ungrouped: [...next.ungrouped, ...[...originals].filter(id => !requested.has(id))] }
  ports.set({ surveyOrganization: applied, surveyCollectedZones: appliedMembers })
  let save: AgentMuxSpatialSave
  try { save = await ports.save() } catch (error) { save = { layoutApplied: false, localStorageWritten: false,
    storageFlushRequested: false, diskDurability: 'unconfirmed', reason: error instanceof Error ? error.message : String(error) } }
  // Core topology acknowledgements cannot confirm Chromium's separate preference flush.
  save = { ...save, diskDurability: 'unconfirmed' }
  const issues = save.reason ? [{ step: 'save', code: 'SURVEY_LIST_SAVE_UNCONFIRMED', message: save.reason,
    recovery: 'The applied organization is retained. Read this same Survey list before another change.' }] : []
  const result = report(issues.length ? 'partial' : 'unchanged', issues, save, applied, appliedMembers)
  if (!issues.length && result.changed) result.outcome = 'changed'
  return result
}
