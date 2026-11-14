import { AgentMuxError } from './errors.js'
import { settingsResourceBudget, settingsResourceEnvelope } from './settings-resource-json.js'
import type { AgentMuxSurveyCollectionChange, AgentMuxSurveyOrganization, AgentMuxSurveyPageReference, AgentMuxSurveyPinReference, AgentMuxSurveyPinChange } from './space-control.js'

/** Machine references only; a display title never identifies a pinned item. */
export function parseSurveyPinReference(value: unknown, code = 'INVALID_CONTROL_REQUEST'): AgentMuxSurveyPinReference {
  const raw = settingsResourceEnvelope(value, ['kind', 'zoneId', 'regionId', 'browserId'], code)
  if (raw.kind === 'zone') {
    settingsResourceEnvelope(value, ['kind', 'zoneId'], code)
    return { kind: 'zone', zoneId: parseSurveyZoneIds([raw.zoneId], code)[0]! }
  }
  if (raw.kind === 'page') {
    settingsResourceEnvelope(value, ['kind', 'regionId', 'browserId'], code)
    return { kind: 'page', ...parseSurveyPageReferences([{ regionId: raw.regionId, browserId: raw.browserId }], code)[0]! }
  }
  throw new AgentMuxError('Choose an exact Survey Zone or Browser page reference.', code)
}
export function parseSurveyPinChange(value: unknown, code = 'INVALID_CONTROL_REQUEST'): AgentMuxSurveyPinChange {
  const raw = settingsResourceEnvelope(value, ['reference', 'pinned', 'expectedPinned'], code)
  if (typeof raw.pinned !== 'boolean' || typeof raw.expectedPinned !== 'boolean') throw new AgentMuxError('Pin changes require the exact original pin state.', code)
  return { reference: parseSurveyPinReference(raw.reference, code), pinned: raw.pinned, expectedPinned: raw.expectedPinned }
}
export function parseSurveyPinnedReferences(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): AgentMuxSurveyPinReference[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) throw new AgentMuxError('Pinned references require an ordinary dense array.', code)
  const references = value.map(item => parseSurveyPinReference(item, code))
  if (new Set(references.map(reference => JSON.stringify(reference))).size !== references.length) throw new AgentMuxError('Pinned references must name each original once.', code)
  return references
}

/** Reuse the same exact-ID/dense-array codec for membership and organization. */
export function parseSurveyZoneIds(value: unknown, code = 'INVALID_CONTROL_REQUEST'): string[] {
  return parseSurveyOrganization({ ungrouped: value, groups: [] }, code).ungrouped
}

export function parseSurveyCollectionChange(value: unknown, code = 'INVALID_CONTROL_REQUEST'): AgentMuxSurveyCollectionChange {
  const raw = settingsResourceEnvelope(value, ['zoneIds', 'expectedZoneIds', 'pageReferences', 'expectedPageReferences'], code)
  const zones = Object.hasOwn(raw, 'zoneIds'), pages = Object.hasOwn(raw, 'pageReferences')
  if (zones !== Object.hasOwn(raw, 'expectedZoneIds') || pages !== Object.hasOwn(raw, 'expectedPageReferences') || !zones && !pages) {
    throw new AgentMuxError('Survey membership changes require the exact original members for each changed scope.', code)
  }
  return {
    ...(zones ? { zoneIds: parseSurveyZoneIds(raw.zoneIds, code), expectedZoneIds: parseSurveyZoneIds(raw.expectedZoneIds, code) } : {}),
    ...(pages ? { pageReferences: parseSurveyPageReferences(raw.pageReferences, code), expectedPageReferences: parseSurveyPageReferences(raw.expectedPageReferences, code) } : {})
  }
}

/** A Region keeps its occupant condition; current placement comes from Core, never this preference. */
export function parseSurveyPageReferences(value: unknown, code = 'INVALID_CONTROL_REQUEST'): AgentMuxSurveyPageReference[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) {
    throw new AgentMuxError('Survey pages require an ordinary dense array.', code)
  }
  const pages = Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor?.enumerable || !('value' in descriptor)) throw new AgentMuxError('Survey pages require exact original references.', code)
    const raw = settingsResourceEnvelope(descriptor.value, ['regionId', 'browserId'], code)
    return { regionId: surveyPageId(raw.regionId, code), browserId: surveyPageId(raw.browserId, code) }
  })
  if (new Set(pages.map(page => page.regionId)).size !== pages.length) {
    throw new AgentMuxError('Survey pages contain conflicting original Region references.', code)
  }
  // The RPC frame owner bounds individual messages; cumulative saved references have no such cap.
  return pages
}

function surveyPageId(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim() || value === 'self' || /[\0\r\n]/u.test(value) || new TextEncoder().encode(value).byteLength > 16 * 1024) {
    throw new AgentMuxError('Survey pages require exact original IDs.', code)
  }
  return value
}

/** One portable codec for public wire and the original client preference owner. */
export function parseSurveyOrganization(value: unknown, code = 'INVALID_CONTROL_REQUEST'): AgentMuxSurveyOrganization {
  const fail = (message: string): never => { throw new AgentMuxError(message, code) }
  const array = <T>(value: unknown, parse: (entry: unknown) => T): T[] => {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) return fail('Survey organization requires ordinary dense arrays.')
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !('value' in descriptor)) return fail('Survey organization requires ordinary dense arrays.')
      return parse(descriptor.value)
    })
  }
  const id = (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim() || value === 'self' || /[\0\r\n]/u.test(value) || new TextEncoder().encode(value).byteLength > 16 * 1024) return fail('Survey organization requires exact original IDs.')
    return value
  }
  const fields = (value: unknown, allowed: string[]) => settingsResourceEnvelope(value, allowed, code)
  const raw = fields(value, ['ungrouped', 'groups'])
  const organization = { ungrouped: array(raw.ungrouped, id), groups: array(raw.groups, value => {
    const group = fields(value, ['groupId', 'name', 'collapsed', 'zoneIds'])
    if (typeof group.name !== 'string' || typeof group.collapsed !== 'boolean') return fail('Survey group name and collapsed state are invalid.')
    return { groupId: id(group.groupId), name: group.name, collapsed: group.collapsed, zoneIds: array(group.zoneIds, id) }
  }) }
  const members = [...organization.ungrouped, ...organization.groups.flatMap(group => group.zoneIds)]
  if (new Set(members).size !== members.length || new Set(organization.groups.map(group => group.groupId)).size !== organization.groups.length) fail('Survey organization contains duplicate original IDs.')
  settingsResourceBudget(organization, code)
  return organization
}

/** A display/new-page preference, never an applied Browser binding or permission. */
export function parseSurveyProfileView(value: unknown, code = 'INVALID_CONTROL_REQUEST'): import('./space-control.js').AgentMuxSurveyProfileView {
  const raw = settingsResourceEnvelope(value, ['kind', 'profileId'], code)
  if (raw.kind === 'default' && Object.keys(raw).length === 1) return { kind: 'default' }
  if (raw.kind === 'profile' && Object.keys(raw).length === 2) return { kind: 'profile', profileId: surveyPageId(raw.profileId, code) }
  throw new AgentMuxError('Survey environment view requires default or an exact Profile ID.', code)
}
