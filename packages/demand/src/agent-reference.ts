/** A relation is a business locator, never a current Run or an authorization. */
export type DemandSpaceMemberReference = {
  kind: 'space-member'
  source: { runtimeId: string; spaceId: string; regionId: string;
    admission: { kind: 'creation' | 'association'; operationId: string } }
  execution: { runtimeId: string; agentSessionId: string }
}
export type DemandAgentReference = string | DemandSpaceMemberReference

function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const result = value as Record<string, unknown>
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) throw new Error(`${label} has missing or unknown fields`)
  return result
}
function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value
}
export function parseDemandAgentReference(value: unknown): DemandAgentReference {
  // Original raw strings keep their bytes and are never decoded as another kind.
  if (typeof value === 'string') return id(value, 'Original Agent reference')
  const p = record(value, ['kind', 'source', 'execution'], 'Agent reference')
  if (p.kind !== 'space-member') throw new Error('Unknown Agent reference kind')
  const s = record(p.source, ['runtimeId', 'spaceId', 'regionId', 'admission'], 'Source member')
  const a = record(s.admission, ['kind', 'operationId'], 'Source admission')
  if (a.kind !== 'creation' && a.kind !== 'association') throw new Error('Unknown Source admission kind')
  const e = record(p.execution, ['runtimeId', 'agentSessionId'], 'Execution member')
  return { kind: 'space-member', source: { runtimeId: id(s.runtimeId, 'Source Runtime'), spaceId: id(s.spaceId, 'Source Space'),
    regionId: id(s.regionId, 'Source Region'), admission: { kind: a.kind, operationId: id(a.operationId, 'Original admission') } },
    execution: { runtimeId: id(e.runtimeId, 'Execution Runtime'), agentSessionId: id(e.agentSessionId, 'Original Session') } }
}
export function demandAgentReferenceKey(value: DemandAgentReference): string {
  return typeof value === 'string' ? JSON.stringify(['legacy', value]) : JSON.stringify(['space-member', value.source.runtimeId,
    value.source.spaceId, value.source.regionId, value.source.admission.kind, value.source.admission.operationId,
    value.execution.runtimeId, value.execution.agentSessionId])
}
export function parseDemandAgentReferences(value: unknown): DemandAgentReference[] {
  if (!Array.isArray(value)) throw new Error('Agent references must be an array')
  const refs = value.map(parseDemandAgentReference), keys = refs.map(demandAgentReferenceKey)
  if (new Set(keys).size !== keys.length) throw new Error('Agent references must not contain duplicates')
  return refs
}
/** Preserve original order; equal object values, not JS object identity, deduplicate. */
export function mergeDemandAgentReferences(...groups: readonly (readonly DemandAgentReference[])[]): DemandAgentReference[] {
  const unique = new Map<string, DemandAgentReference>()
  for (const group of groups) for (const ref of group) { const key = demandAgentReferenceKey(ref); if (!unique.has(key)) unique.set(key, ref) }
  return [...unique.values()]
}
export function demandAgentReferenceLabel(ref: DemandAgentReference): string {
  return typeof ref === 'string' ? ref : `${ref.execution.agentSessionId} @ ${ref.execution.runtimeId} (Space ${ref.source.spaceId}, ${ref.source.admission.kind} ${ref.source.admission.operationId})`
}
