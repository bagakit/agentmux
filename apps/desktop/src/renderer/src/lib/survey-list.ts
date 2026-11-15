import type { AgentMuxSpaceControlRequest, AgentMuxSurveyListReport, AgentMuxSurveyOrganization, AgentMuxSpatialSave } from '@agentmux/core/control'
import { parseSurveyOrganization, parseSurveyCollectionChange, parseSurveyPinChange } from '@agentmux/core/control'
import { changeSurveyPin, surveyPinnedReferences, surveyPinKey, type SurveyPinReadRecovery } from './survey-pins'
import { surveyPageKey, updateSurveyPageTimes, type SurveyPageTimes } from './survey-page-organization'

export const EMPTY_SURVEY_ORGANIZATION: AgentMuxSurveyOrganization = { ungrouped: [], groups: [] }

/** Move only an original Zone reference; never change its content or membership. */
export function moveSurveyListItem(base: AgentMuxSurveyOrganization, zoneId: string, target: string | null, index?: number): AgentMuxSurveyOrganization {
  const next = { ungrouped: base.ungrouped.filter(id => id !== zoneId),
    groups: base.groups.map(group => ({ ...group, zoneIds: group.zoneIds.filter(id => id !== zoneId) })) }
  const ids = target === null ? next.ungrouped : next.groups.find(group => group.groupId === target)?.zoneIds
  if (ids) ids.splice(index ?? ids.length, 0, zoneId)
  return next
}

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

type Page = import('@agentmux/core/control').AgentMuxSurveyPageReference
type State = {
  surveyOrganization: AgentMuxSurveyOrganization
  surveyCollectedZones: Record<string, true>
  surveyPageReferences: Page[]
  surveyPageAddedAt?: SurveyPageTimes
  surveyPageReadRecovery?: { issue: string } | null
  pinnedItems: Record<string, string[]>
  surveyPinReadRecovery?: SurveyPinReadRecovery | null
}
type Ports = {
  get(): State
  set(state: Partial<Omit<State, 'surveyPageReadRecovery'>> & Pick<State, 'surveyPageReferences'>): void
  hasZone(zoneId: string): boolean
  hasPage(reference: Page): boolean
  save(): Promise<AgentMuxSpatialSave>
}
type Request = Extract<AgentMuxSpaceControlRequest, { operation: 'space.survey-list' }>

export const surveyCollectedZoneIds = (collected: Readonly<Record<string, true>>): string[] => Object.keys(collected).filter(id => collected[id] === true)
const sameMembers = (left: string[], right: string[]) => { const members = new Set(right); return left.length === members.size && left.every(id => members.has(id)) }
export const samePage = (a: Page, b: Page) => a.regionId === b.regionId && a.browserId === b.browserId
const samePages = (left: readonly Page[], right: readonly Page[]) =>
  left.length === right.length && left.every((page, index) => samePage(page, right[index]!))

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
    applied = before, members = state.surveyCollectedZones, pages = state.surveyPageReferences): AgentMuxSurveyListReport => ({
    scope: 'survey-list', storedOrganization: applied, pageReferences: pages.map(page => ({ ...page })),
    pinnedReferences: surveyPinnedReferences(ports.get()),
    collectedZoneIds: surveyCollectedZoneIds(members), effectiveOrganization: effectiveSurveyOrganization(applied, members),
    changed: JSON.stringify(applied) !== JSON.stringify(before) || !sameMembers(surveyCollectedZoneIds(members), originalMembers) || !samePages(pages, state.surveyPageReferences),
    outcome: ports.get().surveyPinReadRecovery && outcome === 'read' ? 'unknown' : outcome, save,
    issues: [...issues, ...(ports.get().surveyPinReadRecovery ? [{ step: 'survey-pin-read', code: 'SURVEY_PIN_PARTIAL_READ',
      message: ports.get().surveyPinReadRecovery!.issue, recovery: 'Known pin entries remain editable. Restore unread original records without replacing this scope.' }] : [])]
  })
  const unread = state.surveyPageReadRecovery ? [{ step: 'survey-page-read', code: 'SURVEY_PAGE_PREFERENCES_UNREADABLE',
    message: state.surveyPageReadRecovery.issue,
    recovery: 'Keep the original pages and saved source. Restore that original preference source and read the Survey page references again.' }] : []
  if (request.organization === undefined && request.collection === undefined && request.pin === undefined) return report(unread.length ? 'unknown' : 'read', unread)
  let next = before, expected = before, collection: Request['collection'], pin: Request['pin']
  try {
    if (request.organization !== undefined) { next = parseSurveyOrganization(request.organization); expected = parseSurveyOrganization(request.expected) }
    if (request.collection !== undefined) collection = parseSurveyCollectionChange(request.collection)
    if (request.pin !== undefined) pin = parseSurveyPinChange(request.pin)
  } catch (error) {
    return report('refused', [{ step: 'target', code: 'SURVEY_LIST_INVALID_ORGANIZATION',
      message: error instanceof Error ? error.message : String(error),
      recovery: 'Read this same list and provide each exact original item and group once. Existing work is retained.' }])
  }
  if (JSON.stringify(expected) !== JSON.stringify(before)) return report('refused', [{ step: 'target', code: 'SURVEY_LIST_CONFLICT',
    message: 'The original Survey list organization changed after it was read.', recovery: 'Read this same Survey list and review its current preference before changing it.' }])
  if (collection?.zoneIds !== undefined && !sameMembers(collection.expectedZoneIds!, originalMembers)) return report('refused', [{
    step: 'target', code: 'SURVEY_LIST_COLLECTION_CONFLICT', message: 'The original explicit Survey membership changed after it was read.',
    recovery: 'Read this same list and review its current members before another change.' }])
  if (collection?.pageReferences !== undefined && !samePages(collection.expectedPageReferences!, state.surveyPageReferences)) return report('refused', [{
    step: 'target', code: 'SURVEY_LIST_PAGE_CONFLICT', message: 'The exact Survey page order or membership changed after it was read.',
    recovery: 'Read this same list before changing the original page references. Its pages remain available.' }])
  const pages = collection?.pageReferences ?? state.surveyPageReferences
  if (collection?.pageReferences !== undefined && unread.length) return report('unknown', unread)
  const originals = new Set(state.surveyPageReferences.map(surveyPageKey))
  if (pages.some(page => !originals.has(surveyPageKey(page)) && !ports.hasPage(page))) return report('refused', [{
    step: 'target', code: 'SURVEY_LIST_PAGE_UNCONFIRMED', message: 'A new Survey reference has no confirmed original Browser in that Region.',
    recovery: 'Inspect that exact Region and Browser ID. Existing references and healthy pages are kept.' }])
  const appliedMembers = collection?.zoneIds !== undefined ? changeSurveyCollection(state.surveyCollectedZones, collection.zoneIds, ports.hasZone) : state.surveyCollectedZones
  if (!appliedMembers) return report('refused', [{ step: 'target', code: 'SURVEY_LIST_ZONE_UNCONFIRMED',
    message: 'A new Survey member has no confirmed original Zone.',
    recovery: 'Inspect that exact Zone and retry this explicit change when its identity is confirmed. Existing references and work remain.' }])
  const ids = surveyOrganizationZoneIds(next), zoneOriginals = new Set([...surveyCollectedZoneIds(appliedMembers), ...surveyOrganizationZoneIds(before)])
  if (ids.some(id => !zoneOriginals.has(id))) return report('refused', [{ step: 'target', code: 'SURVEY_LIST_MEMBER_UNCONFIRMED',
    message: 'A requested Zone is not in the original explicit Survey list or its saved organization.',
    recovery: 'Read the same Survey list. Existing references, work surfaces and healthy Runs are retained.' }])
  let pinChange: ReturnType<typeof changeSurveyPin> | undefined
  if (pin) {
    const target = pin.reference, key = surveyPinKey(target), originalPinned = surveyPinnedReferences(state).some(reference => surveyPinKey(reference) === key)
    if (originalPinned !== pin.expectedPinned) return report('refused', [{ step: 'target', code: 'SURVEY_PIN_CONFLICT',
      message: 'This item’s original pin state changed.', recovery: 'Read this same list and review that exact item before changing its pin.' }])
    const member = target.kind === 'zone' ? appliedMembers[target.zoneId] === true
      : pages.some(page => page.regionId === target.regionId && page.browserId === target.browserId)
    if (pin.pinned && !member) return report('refused', [{ step: 'target', code: 'SURVEY_PIN_MEMBER_UNKNOWN',
      message: 'Only an explicitly saved Survey item can be pinned.', recovery: 'Save the exact page or research in this list first. Existing content and pin preferences are kept.' }])
    pinChange = changeSurveyPin(state, pin.reference, pin.pinned)
    if (!pinChange) return report('unknown', [{ step: 'survey-pin-read', code: 'SURVEY_PIN_SOURCE_UNREADABLE',
      message: 'The original pin preference scope is not an editable list.', recovery: 'The original bytes are retained. Restore that preference source before editing this pin.' }])
  }
  // Omitted originals return to the ungrouped area; organization never removes membership.
  const requested = new Set(ids)
  const applied = request.organization === undefined ? before : { ...next, ungrouped: [...next.ungrouped, ...[...zoneOriginals].filter(id => !requested.has(id))] }
  const originalPages = state.surveyPageReferences
  ports.set({ surveyOrganization: applied, surveyCollectedZones: appliedMembers,
    surveyPageReferences: pages === originalPages ? pages : pages.map(page => ({ ...page })),
    ...(pages !== originalPages && state.surveyPageAddedAt ? { surveyPageAddedAt: updateSurveyPageTimes(originalPages, pages, state.surveyPageAddedAt, Date.now()) } : {}),
    ...pinChange })
  let save: AgentMuxSpatialSave
  try { save = await ports.save() }
  catch (error) {
    save = { layoutApplied: false, clientStateWritten: false, storageFlushRequested: false, diskDurability: 'unconfirmed',
      reason: error instanceof Error ? error.message : String(error) }
  }
  // Core topology acknowledgements cannot confirm Chromium's separate preference flush.
  save = { ...save, diskDurability: 'unconfirmed' }
  const saveIssues = save.reason || !save.clientStateWritten ? [{ step: 'save', code: 'SURVEY_LIST_SAVE_UNCONFIRMED',
    message: save.reason ?? 'The original Survey preference write was not confirmed.',
    recovery: 'The applied organization is retained. Read this same Survey list before another change.' }] : []
  const issues = [...unread, ...saveIssues]
  const result = report(issues.length ? 'partial' : 'unchanged', issues, save, applied, appliedMembers, pages)
  if (pinChange && JSON.stringify(pinChange.pinnedItems) !== JSON.stringify(state.pinnedItems)) result.changed = true
  if (!issues.length && result.changed) result.outcome = 'changed'
  return result
}
