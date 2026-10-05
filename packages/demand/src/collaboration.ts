/** Original business provenance; names and live metadata remain with their identity owners. */
export type DemandParticipationKind = 'create' | 'discussion' | 'requirements'
export type DemandParticipationSource = {
  kind: DemandParticipationKind
  agentSessionId: string
  hostId: string
  entryPoint: string
  mote?: { workspaceId: string; topicId: string; identityDirectoryPath: string }
}
export type DemandParticipation = DemandParticipationSource & {
  id: string
  operationId: string
  recordedAt: number
}
export type DemandCreationOrigin = {
  operationId: string
  requesterAsSupervisor: boolean
  requesterParticipationId: string | null
  supervisorDefaultPending: boolean
}

function fields(value: unknown, allowed: readonly string[], required = allowed): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Goal provenance requires an object.')
  const data = value as Record<string, unknown>
  if (Object.keys(data).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(data, key))) throw new Error('Goal provenance contains unsupported or missing fields.')
  return data
}
function identity(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value)) throw new Error('Goal provenance identity is invalid.')
  return value
}
export function parseDemandParticipationSource(value: unknown): DemandParticipationSource {
  const data = fields(value, ['kind', 'agentSessionId', 'hostId', 'entryPoint', 'mote'], ['kind', 'agentSessionId', 'hostId', 'entryPoint'])
  if (!['create', 'discussion', 'requirements'].includes(String(data.kind))) throw new Error('Goal participation kind is invalid.')
  const mote = data.mote === undefined ? undefined : fields(data.mote, ['workspaceId', 'topicId', 'identityDirectoryPath'])
  return { kind: data.kind as DemandParticipationKind, agentSessionId: identity(data.agentSessionId), hostId: identity(data.hostId), entryPoint: identity(data.entryPoint),
    ...(mote ? { mote: { workspaceId: identity(mote.workspaceId), topicId: identity(mote.topicId), identityDirectoryPath: identity(mote.identityDirectoryPath) } } : {}) }
}
export function parseDemandParticipations(value: unknown): DemandParticipation[] {
  if (!Array.isArray(value)) throw new Error('Goal participations require an array.')
  const ids = new Set<string>(), operations = new Set<string>()
  return value.map(entry => {
    const data = fields(entry, ['id', 'operationId', 'recordedAt', 'kind', 'agentSessionId', 'hostId', 'entryPoint', 'mote'], ['id', 'operationId', 'recordedAt', 'kind', 'agentSessionId', 'hostId', 'entryPoint'])
    const { id, operationId, recordedAt, ...source } = data
    const item = { ...parseDemandParticipationSource(source), id: identity(id), operationId: identity(operationId), recordedAt: recordedAt as number }
    if (!Number.isSafeInteger(recordedAt) || (recordedAt as number) <= 0) throw new Error('Goal participation time is invalid.')
    const key = JSON.stringify([item.operationId, item.kind, item.agentSessionId])
    if (ids.has(item.id) || operations.has(key)) throw new Error('Goal participation contains duplicate original identities.')
    ids.add(item.id); operations.add(key); return item
  })
}
export function parseDemandCreationOrigin(value: unknown): DemandCreationOrigin {
  const data = fields(value, ['operationId', 'requesterAsSupervisor', 'requesterParticipationId', 'supervisorDefaultPending'])
  if (typeof data.requesterAsSupervisor !== 'boolean' || typeof data.supervisorDefaultPending !== 'boolean' || (!data.requesterAsSupervisor && data.supervisorDefaultPending)) throw new Error('Goal first-default policy is invalid.')
  return { operationId: identity(data.operationId), requesterAsSupervisor: data.requesterAsSupervisor,
    requesterParticipationId: data.requesterParticipationId === null ? null : identity(data.requesterParticipationId), supervisorDefaultPending: data.supervisorDefaultPending }
}
