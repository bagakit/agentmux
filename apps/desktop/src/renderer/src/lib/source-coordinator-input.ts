import type { AgentMuxRpcParams, AgentMuxRpcResult } from '@agentmux/core'
import { parseCoordinatorAgentReference } from '@agentmux/core/agent-open-contract'
import type { AgentExecutionRecoveryReference, AgentLaunchInput } from '../../../shared/contracts'
import type { SpaceMountRecord } from '../../../shared/space-mount'
import type { LauncherNames } from './launcher-name-draft'
import type { LauncherSourceExecution } from './launcher-source'
import { mountedSpaceInputs } from './space-mount-view'

type OriginalReachRequest = AgentLaunchInput & { agentSessionId: string; createOperationId: string;
  sourceCoordinator: NonNullable<AgentLaunchInput['sourceCoordinator']>; toolWorkspace: NonNullable<AgentLaunchInput['toolWorkspace']> }
/** One private user intention spanning original A creation C and B association L.
 * It is neither a Session nor a second creation/permission owner. */
export type SourceCoordinatorInput = {
  kind: 'source-coordinator-launch'
  origin: { launcherId: string; slot: { tabId: string; regionId: string }; project: LauncherSourceExecution['project']; names: LauncherNames }
  target: SpaceMountRecord
  request: OriginalReachRequest
  submitted: boolean
  acknowledged?: { target: AgentExecutionRecoveryReference; run: { runId: string } }
  issue?: string
  association: { operationId: string; submitted: boolean;
    request?: AgentMuxRpcParams<'agent.open'> & { operationId: string }; receipt?: AgentMuxRpcResult<'agent.open'>;
    /** The first producer response stays historical when an explicit same-L continuation responds later. */
    originalReceipt?: unknown; issue?: string }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && !!value && !value.includes('\0')
const unavailable = (): never => { throw Error('This original Coordinator and project-link intention is unreadable. Its complete input is retained; existing work remains available.') }
export const sourceCoordinatorInputKey = (request: Pick<OriginalReachRequest, 'agentSessionId' | 'createOperationId'> & {
  sourceCoordinator: Pick<OriginalReachRequest['sourceCoordinator'], 'hostId' | 'runtimeId'> }) =>
  JSON.stringify(['source-coordinator-launch', request.sourceCoordinator.hostId, request.sourceCoordinator.runtimeId, request.agentSessionId, request.createOperationId])
const sameTarget = (a: SpaceMountRecord, b: SpaceMountRecord) => a.hostId === b.hostId && a.reference.runtimeId === b.reference.runtimeId &&
  a.reference.spaceId === b.reference.spaceId && a.zoneId === b.zoneId && a.workspaceId === b.workspaceId

export function sourceCoordinatorInput(value: unknown, key: string): SourceCoordinatorInput | undefined {
  const raw = mountedSpaceInputs(value)[key]
  if (raw === undefined) return undefined
  if (!object(raw) || raw.kind !== 'source-coordinator-launch' || !object(raw.target) || !object(raw.target.reference) || !object(raw.request) ||
      !object(raw.origin) || !object(raw.origin.slot) || !object(raw.origin.project) || !object(raw.origin.names) || !object(raw.association)) return unavailable()
  const request = raw.request, target = raw.target, reference = raw.target.reference, origin = raw.origin,
    slot = raw.origin.slot, names = raw.origin.names, project = raw.origin.project, link = raw.association
  if (!object(request.sourceCoordinator) || !object(request.toolWorkspace) ||
      ![request.hostId, request.agentSessionId, request.createOperationId, request.executorId, request.workspacePath,
        request.sourceCoordinator.hostId, request.sourceCoordinator.runtimeId, request.sourceCoordinator.resourceRuntimeId,
        target.hostId, reference.runtimeId, reference.spaceId, target.zoneId, target.workspaceId,
        origin.launcherId, slot.tabId, slot.regionId, project.id, project.hostId, project.path, link.operationId].every(text) ||
      request.sourceCoordinator.workingDirectory !== 'device-home' || request.sourceCoordinator.hostId !== request.hostId ||
      request.sourceCoordinator.resourceRuntimeId !== reference.runtimeId || target.hostId !== project.hostId ||
      request.toolWorkspace.id !== project.id || request.toolWorkspace.hostId !== project.hostId || request.toolWorkspace.path !== project.path ||
      typeof names.agentName !== 'string' || typeof names.tabName !== 'string' || typeof raw.submitted !== 'boolean' || typeof link.submitted !== 'boolean' ||
      project.repoPath !== undefined && typeof project.repoPath !== 'string' ||
      raw.issue !== undefined && typeof raw.issue !== 'string' || link.issue !== undefined && typeof link.issue !== 'string' ||
      request.prompt !== undefined && typeof request.prompt !== 'string') return unavailable()
  const input = raw as SourceCoordinatorInput
  if (sourceCoordinatorInputKey(input.request) !== key) return unavailable()
  if (raw.acknowledged !== undefined && (!object(raw.acknowledged) || !object(raw.acknowledged.target) ||
      !object(raw.acknowledged.target.coordinator) || !object(raw.acknowledged.target.reference) || !object(raw.acknowledged.run))) return unavailable()
  if (input.acknowledged && (input.acknowledged.target.coordinator.hostId !== input.request.hostId || input.acknowledged.target.coordinator.runtimeId !== input.request.sourceCoordinator.runtimeId ||
      input.acknowledged.target.reference.agentSessionId !== input.request.agentSessionId || input.acknowledged.target.reference.createOperationId !== input.request.createOperationId ||
      !text(input.acknowledged.target.reference.bindingId) || !text(input.acknowledged.run?.runId))) return unavailable()
  if (link.request !== undefined && (!object(link.request) || !object(link.request.content) || !object(link.request.destination))) return unavailable()
  if (input.association.request) {
    const r = input.association.request
    if (r.operationId !== link.operationId || r.content.kind !== 'agent-session' || !r.content.reference || !r.content.expectedResource ||
        r.destination?.spaceId !== input.target.reference.spaceId || r.destination.zoneId !== input.target.zoneId || r.destination.newTab !== true || r.focus !== false) return unavailable()
    const reference = parseCoordinatorAgentReference(r.content.reference)
    if (reference.runtimeId !== input.request.sourceCoordinator.runtimeId || reference.binding.agentSessionId !== input.request.agentSessionId ||
        reference.binding.createOperationId !== input.request.createOperationId ||
        r.content.expectedResource.runtimeId !== input.target.reference.runtimeId || r.content.expectedResource.workspaceId !== input.target.workspaceId || r.content.expectedResource.workspacePath !== input.origin.project.path) return unavailable()
  }
  if (input.association.receipt && input.association.receipt.operationId !== link.operationId) return unavailable()
  return input
}

export function editSourceCoordinatorInput(value: unknown, key: string, update: (current: SourceCoordinatorInput | undefined) => SourceCoordinatorInput | undefined) {
  const entries = mountedSpaceInputs(value), current = sourceCoordinatorInput(entries, key), next = update(current)
  if (next === current) return value
  if (next) {
    if (current && (next.request !== current.request || next.origin !== current.origin || next.association.operationId !== current.association.operationId ||
        current.association.request && next.association.request !== current.association.request ||
        Object.hasOwn(current.association, 'originalReceipt') && next.association.originalReceipt !== current.association.originalReceipt || !sameTarget(next.target, current.target))) return unavailable()
    sourceCoordinatorInput({ ...entries, [key]: next }, key)
  }
  const result = { ...entries }
  if (next === undefined) delete result[key]; else result[key] = next
  return result
}

/** Read only this original private UI intention, regardless of a later selection. */
export function sourceCoordinatorInputs(value: unknown, origin: { launcherId: string } | { tabId: string; regionId: string }) {
  const entries = mountedSpaceInputs(value), result: SourceCoordinatorInput[] = []
  const unreadable: Array<{ key: string; issue: string }> = []
  for (const [key, raw] of Object.entries(entries)) {
    if (!object(raw) || raw.kind !== 'source-coordinator-launch' || !object(raw.origin)) continue
    if ('launcherId' in origin ? raw.origin.launcherId !== origin.launcherId :
      !object(raw.origin.slot) || raw.origin.slot.tabId !== origin.tabId || raw.origin.slot.regionId !== origin.regionId) continue
    try {
      const input = sourceCoordinatorInput(entries, key)
      if (input) result.push(input)
    } catch (cause) { unreadable.push({ key, issue: cause instanceof Error ? cause.message : String(cause) }) }
  }
  return { inputs: result, unreadable }
}
