import { parseDemandAgentReference, parseDemandAgentReferences, demandAgentReferenceKey, type DemandAgentReference, type DemandSpaceMemberReference } from '@agentmux/demand/relations'
import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString } from './rpc-data.js'
import { parseAdoptedHostRoute, type AdoptedHostRoute } from './host-route.js'

/** One operation's configured carrier. A saved business relation carries no access grant. */
export type GoalRuntimeAccess = { hostId: string; via?: { routeId: string; adoptedRoute: AdoptedHostRoute } }
export type GoalQualifiedAccess = { source: GoalRuntimeAccess; coordinator?: GoalRuntimeAccess }
/** Read an already-frozen input through its original independent owner. Start,
 * Resume and relationship writes continue to require GoalQualifiedAccess. */
export type GoalInspectionAccess = GoalQualifiedAccess | { coordinator: GoalRuntimeAccess; source?: never }
export type GoalRelationAccess = { reference: DemandSpaceMemberReference; access: GoalQualifiedAccess }

export function parseGoalAgentReference(value: unknown, code = 'INVALID_CONTROL_REQUEST'): DemandAgentReference {
  try {
    const ref = parseDemandAgentReference(value)
    const ids = typeof ref === 'string' ? [ref] : [ref.source.runtimeId, ref.source.spaceId, ref.source.regionId, ref.source.admission.operationId, ref.execution.runtimeId, ref.execution.agentSessionId]
    if (ids.some(id => new TextEncoder().encode(id).byteLength > 512 || /[\0\r\n]/u.test(id))) throw new Error('Goal reference identifier exceeds the original wire boundary')
    return ref
  }
  catch (cause) { throw Object.assign(new AgentMuxError('The original Goal Agent reference is invalid.', code), { cause }) }
}
export function parseGoalAgentReferences(value: unknown, code = 'INVALID_CONTROL_REQUEST'): DemandAgentReference[] {
  try {
    if (!Array.isArray(value) || value.length > 128) throw new Error('Goal reference array exceeds the original wire boundary')
    return parseDemandAgentReferences(value).map(ref => parseGoalAgentReference(ref, code))
  }
  catch (cause) { throw Object.assign(new AgentMuxError('The original Goal Agent references are invalid.', code), { cause }) }
}
function runtimeAccess(value: unknown): GoalRuntimeAccess {
  const p = rpcRecord(value, ['hostId', 'via'])
  const via = p.via === undefined ? undefined : rpcRecord(p.via, ['routeId', 'adoptedRoute'])
  return { hostId: rpcString(p.hostId, 'Configured Goal carrier'), ...(via ? { via: {
    routeId: rpcString(via.routeId, 'Original saved prefix'), adoptedRoute: parseAdoptedHostRoute(via.adoptedRoute) } } : {}) }
}
export function parseGoalQualifiedAccess(value: unknown): GoalQualifiedAccess {
  const p = rpcRecord(value, ['source', 'coordinator'])
  return { source: runtimeAccess(p.source), ...(p.coordinator === undefined ? {} : { coordinator: runtimeAccess(p.coordinator) }) }
}
export function parseGoalInspectionAccess(value: unknown): GoalInspectionAccess {
  const p = rpcRecord(value, ['source', 'coordinator'])
  if (p.source !== undefined) return parseGoalQualifiedAccess(p)
  return { coordinator: runtimeAccess(p.coordinator) }
}
export function parseGoalRelationAccesses(value: unknown): GoalRelationAccess[] {
  if (!Array.isArray(value)) throw new AgentMuxError('Goal relation access must be an array.', 'INVALID_CONTROL_REQUEST')
  const keys = new Set<string>()
  return value.map(item => {
    const p = rpcRecord(item, ['reference', 'access']), reference = parseGoalAgentReference(p.reference)
    if (typeof reference === 'string') throw new AgentMuxError('Relation access must name an exact Source member.', 'INVALID_CONTROL_REQUEST')
    const key = demandAgentReferenceKey(reference)
    if (keys.has(key)) throw new AgentMuxError('Duplicate Goal relation access is ambiguous.', 'INVALID_CONTROL_REQUEST')
    keys.add(key)
    return { reference, access: parseGoalQualifiedAccess(p.access) }
  })
}
