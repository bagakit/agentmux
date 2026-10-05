import type { AgentMuxControlRequest } from '@agentmux/core/control'
import type { CreateDemandInput, UpdateDemandInput, DemandNameContext, DemandParticipationKind, DemandParticipationSource } from '@agentmux/demand'
import type { AppConfig } from '../shared/contracts.js'
import type { ScratchTopics } from './scratch-topics.js'

/** Consume authenticated ingress facts; a name, content reference or focused Tab is not a source. */
export async function admittedDemandParticipation(context: DemandNameContext, kind: DemandParticipationKind,
  config: AppConfig, scratch: Pick<ScratchTopics, 'readForDirectory' | 'read'>): Promise<DemandParticipationSource | undefined> {
  if (!context.actor.verified || context.actor.kind !== 'agent' || !context.actor.id ||
      context.location.callerSessionId !== context.actor.id || !context.location.hostId) return undefined
  const source: DemandParticipationSource = { kind, agentSessionId: context.actor.id,
    hostId: context.location.hostId, entryPoint: context.entryPoint }
  const cwd = context.location.callerCwd
  const roots = config.workspaces.filter(workspace => workspace.id === '__scratch__' && workspace.hostId === source.hostId)
  if (!cwd || roots.length !== 1) return source
  // Directory metadata is optional; its observation cannot invalidate the exact authenticated Agent.
  const fact = await scratch.readForDirectory(roots[0]!, cwd).catch(() => null)
  const topic = fact?.identityDirectoryPath ? await scratch.read(roots[0]!, fact.id).catch(() => null) : null
  if (fact?.identityDirectoryPath && topic?.kind === 'mote') source.mote = { workspaceId: roots[0]!.id,
    topicId: fact.id, identityDirectoryPath: fact.identityDirectoryPath }
  return source
}


const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
/** Match authored business fields; project names and inferred content refs are host projections. */
export function admittedDemandCreateMatches(request: AgentMuxControlRequest, input: CreateDemandInput): boolean {
  if (request.operation !== 'demand.create') return false
  if (input.title !== request.title.trim() || (input.description ?? '') !== (request.description ?? '') ||
      (input.projectId ?? null) !== (request.projectId ?? null) || !same(input.sessionIds ?? [], request.sessionIds ?? [])) return false
  for (const field of ['status', 'priority', 'assigneeSessionIds', 'supervisorSessionId'] as const) {
    if (Object.hasOwn(input, field) !== Object.hasOwn(request, field) || !same(input[field], request[field])) return false
  }
  if (request.demandId !== undefined && input.id !== request.demandId || request.contentRefs !== undefined && !same(input.contentRefs, request.contentRefs)) return false
  return Object.keys(input).every(field => ['id', 'title', 'description', 'status', 'priority', 'projectId', 'projectName', 'sessionIds', 'assigneeSessionIds', 'supervisorSessionId', 'contentRefs'].includes(field))
}
export function admittedDemandUpdateMatches(request: AgentMuxControlRequest, id: string, patch: UpdateDemandInput, expectedUpdatedAt?: number): boolean {
  if (request.operation !== 'demand.update' && request.operation !== 'demand.assign' && request.operation !== 'demand.handoff') return false
  if (request.demandId !== id || request.expectedUpdatedAt !== undefined && request.expectedUpdatedAt !== expectedUpdatedAt) return false
  if (request.operation === 'demand.update') {
    // Legacy activityLog is committed by its original follow-up activity owner, not this patch.
    const authored = Object.fromEntries(Object.entries(request.patch).filter(([key]) => key !== 'activityLog'))
    return Object.entries(authored).every(([key, value]) => same(value, (patch as Record<string, unknown>)[key])) &&
      Object.keys(patch).every(key => Object.hasOwn(authored, key) || key === 'projectName' && Object.hasOwn(authored, 'projectId'))
  }
  const authored = { ...(request.assigneeSessionIds === undefined ? request.operation === 'demand.handoff' && request.sessionId ? { assigneeSessionIds: [request.sessionId] } : {} : { assigneeSessionIds: request.assigneeSessionIds }),
    ...(request.supervisorSessionId === undefined ? {} : { supervisorSessionId: request.supervisorSessionId }),
    ...(request.operation === 'demand.assign' && request.projectId !== undefined ? { projectId: request.projectId } : {}) }
  return Object.entries(authored).every(([key, value]) => same(value, (patch as Record<string, unknown>)[key])) &&
    Object.keys(patch).every(key => Object.hasOwn(authored, key) || key === 'projectName' && Object.hasOwn(authored, 'projectId'))
}
