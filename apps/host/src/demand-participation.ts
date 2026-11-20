import type { DemandNameContext, DemandParticipationKind, DemandParticipationSource } from '@agentmux/demand'
import type { WorkspaceRecord } from './content-types.js'
import type { ScratchTopics } from './mote-resources.js'

/** Consume authenticated ingress facts; a name, content reference or focused Tab is not a source. */
export async function admittedDemandParticipation(context: DemandNameContext, kind: DemandParticipationKind,
  config: { workspaces: readonly WorkspaceRecord[] }, scratch: Pick<ScratchTopics, 'readForDirectory' | 'read'>): Promise<DemandParticipationSource | undefined> {
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
