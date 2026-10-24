import { AgentMuxError } from './errors.js'
import { settingsResourceBudget, settingsResourceEnvelope } from './settings-resource-json.js'
import type { AgentMuxSurveyCollectionChange, AgentMuxSurveyOrganization } from './space-control.js'

/** Reuse the same exact-ID/dense-array codec for membership and organization. */
export function parseSurveyZoneIds(value: unknown, code = 'INVALID_CONTROL_REQUEST'): string[] {
  return parseSurveyOrganization({ ungrouped: value, groups: [] }, code).ungrouped
}

export function parseSurveyCollectionChange(value: unknown, code = 'INVALID_CONTROL_REQUEST'): AgentMuxSurveyCollectionChange {
  const raw = settingsResourceEnvelope(value, ['zoneIds', 'expectedZoneIds'], code)
  return { zoneIds: parseSurveyZoneIds(raw.zoneIds, code), expectedZoneIds: parseSurveyZoneIds(raw.expectedZoneIds, code) }
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
