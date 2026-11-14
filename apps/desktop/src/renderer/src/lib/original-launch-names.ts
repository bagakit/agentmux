import type { AgentMuxRpcResult } from '@agentmux/core'
import { parseNameControlParams, parseNameControlResult, type NameChangeResult, type NameControlParams, type NameObservation } from '@agentmux/core/name-control'
import { configValuesEqual } from '../../../shared/config-edit'
import type { SpaceMountTarget } from '../../../shared/space-mount'
import { api } from './api'
import { checkpointMountedSpaceInputs, useAppStore } from '../store'
import { sourceCoordinatorInput, sourceCoordinatorInputKey, type SourceCoordinatorInput } from './source-coordinator-input'
import { mountedAgentOpenInput, mountedAgentOpenKey, type MountedAgentOpenInput } from './space-mount-launch'
import { presentError } from '@agentmux/client-ui/error-presentation'

export type LaunchNameRole = 'agent' | 'tab'
export type LaunchNameOwner = ({ kind: 'reach'; input: SourceCoordinatorInput } | { kind: 'source'; input: MountedAgentOpenInput }) & {
  /** Current readonly location, never the original C/L producer acknowledgement. */
  observation?: AgentMuxRpcResult<'agent.open'>
}
export type LaunchNameAddress = { kind: 'member'; carrier: SpaceMountTarget; name: NameControlParams['space.member.name.inspect'] }
  | { kind: 'agent'; carrier: { hostId: string; expectedRuntimeId: string }; name: import('@agentmux/core/name-control').AgentNameTarget }
export type OriginalLaunchNameInput = { target: LaunchNameAddress; change: Extract<NameControlParams['agent.name.change']['change'], { kind: 'rename' }>;
  submitted: boolean; response?: NameChangeResult; issue?: string | undefined }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const unavailable = (): never => { throw Error('This original name input is unreadable. Its bytes and the Agent are retained; other names remain available.') }
const roles: LaunchNameRole[] = ['agent', 'tab']
function currentOwner(owner: LaunchNameOwner) {
  const value = useAppStore.getState().mountedSpaceInputs
  return owner.kind === 'reach' ? sourceCoordinatorInput(value, sourceCoordinatorInputKey(owner.input.request))
    : mountedAgentOpenInput(value, mountedAgentOpenKey(owner.input.target, owner.input.slot))
}
function editName(owner: LaunchNameOwner, role: LaunchNameRole, update: (input: OriginalLaunchNameInput | undefined) => OriginalLaunchNameInput) {
  const apply = (entry: SourceCoordinatorInput | MountedAgentOpenInput | undefined) => {
    if (!entry || entry.request !== owner.input.request) return entry
    if (entry.nameInputs !== undefined && !object(entry.nameInputs)) return unavailable()
    const previous = originalLaunchName(owner, role), next = update(previous)
    if (previous && (!configValuesEqual(next.target, previous.target) || !configValuesEqual(next.change, previous.change))) return unavailable()
    return { ...entry, nameInputs: { ...entry.nameInputs as Record<string, unknown> | undefined, [role]: next } }
  }
  const store = useAppStore.getState()
  if (owner.kind === 'reach') store.retainSourceCoordinatorInput(sourceCoordinatorInputKey(owner.input.request), entry => apply(entry) as SourceCoordinatorInput | undefined)
  else store.retainSpaceMountAgentOpen(mountedAgentOpenKey(owner.input.target, owner.input.slot), entry => apply(entry) as MountedAgentOpenInput | undefined)
}
/** Only original producer facts locate a name. This is not a permission or Run check. */
export function launchNameAddress(owner: LaunchNameOwner, role: LaunchNameRole, report = owner.observation): LaunchNameAddress | undefined {
  const input = owner.input, source = input.target
  const carrier = { hostId: source.hostId, reference: source.reference }
  if (owner.kind === 'reach' && role === 'agent') {
    const acknowledged = owner.input.acknowledged
    if (!acknowledged) return
    return { kind: 'agent', carrier: { hostId: owner.input.request.hostId, expectedRuntimeId: owner.input.request.sourceCoordinator.runtimeId }, name: {
      runtimeId: owner.input.request.sourceCoordinator.runtimeId, agentSessionId: owner.input.request.agentSessionId, createOperationId: owner.input.request.createOperationId } }
  }
  const receipt = report ?? (owner.kind === 'reach' ? owner.input.association.receipt : owner.input.receipt), operationId = owner.kind === 'reach' ? owner.input.association.operationId : owner.input.request.operationId
  if (!receipt?.to || receipt.operationId !== operationId || receipt.to.spaceId !== source.reference.spaceId || receipt.to.zoneId !== source.zoneId) return
  if (owner.kind === 'reach') {
    if (!owner.input.acknowledged || role !== 'tab') return
    return { kind: 'member', carrier, name: { object: role, target: { reference: source.reference, regionId: receipt.to.regionId,
      runtimeId: owner.input.request.sourceCoordinator.runtimeId, agentSessionId: owner.input.request.agentSessionId, expectedAdmission: { kind: 'association', operationId } } } }
  }
  const content = owner.input.request.content, agent = receipt.agent
  if (content.kind !== 'new-agent' || !content.agentTarget?.runtimeId || !agent || agent.createOperationId !== operationId) return
  return { kind: 'member', carrier, name: { object: role, target: { reference: source.reference, regionId: receipt.to.regionId,
    runtimeId: content.agentTarget.runtimeId, agentSessionId: agent.agentSessionId, expectedAdmission: { kind: 'creation', operationId } } } }
}
export function originalLaunchName(owner: LaunchNameOwner, role: LaunchNameRole): OriginalLaunchNameInput | undefined {
  const entry = currentOwner(owner)
  if (!entry || entry.request !== owner.input.request) return
  if (entry.nameInputs === undefined) return
  if (!object(entry.nameInputs)) return unavailable()
  const raw = entry.nameInputs[role]
  if (raw === undefined) return
  if (!object(raw) || !object(raw.target) || !object(raw.target.carrier) || !object(raw.target.name) || !object(raw.change) || typeof raw.submitted !== 'boolean' || raw.issue !== undefined && typeof raw.issue !== 'string') return unavailable()
  const target = raw.target as LaunchNameAddress
  if (target.kind !== 'agent' && target.kind !== 'member') return unavailable()
  const expected = launchNameAddress(owner, role)
  // A retained exact name locator survives a later gap in the placement reply.
  // Core still resolves its C/L and current viewer authority on every operation.
  if (expected ? !configValuesEqual(target, expected) : !retainedNameMatchesOwner(owner, role, target)) return unavailable()
  const parsed = target.kind === 'member' ? parseNameControlParams('space.member.name.change', { ...target.name, change: raw.change })
    : parseNameControlParams('agent.name.change', { ...target.name, change: raw.change })
  if (parsed.change.kind !== 'rename' || parsed.change.source !== 'launch') return unavailable()
  if (raw.response !== undefined) {
    if (target.kind === 'member') parseNameControlResult('space.member.name.change', raw.response, { ...target.name, change: parsed.change })
    else parseNameControlResult('agent.name.change', raw.response, { ...target.name, change: parsed.change })
  }
  return raw as OriginalLaunchNameInput
}
function retainedNameMatchesOwner(owner: LaunchNameOwner, role: LaunchNameRole, target: LaunchNameAddress) {
  if (owner.kind === 'reach' && role === 'agent') return target.kind === 'agent' && target.carrier.hostId === owner.input.request.hostId &&
    target.carrier.expectedRuntimeId === owner.input.request.sourceCoordinator.runtimeId && target.name.runtimeId === owner.input.request.sourceCoordinator.runtimeId &&
    target.name.agentSessionId === owner.input.request.agentSessionId && target.name.createOperationId === owner.input.request.createOperationId
  if (target.kind !== 'member' || target.name.object !== role || target.carrier.hostId !== owner.input.target.hostId ||
      !configValuesEqual(target.carrier.reference, owner.input.target.reference) || !configValuesEqual(target.name.target.reference, owner.input.target.reference)) return false
  const member = target.name.target
  if (owner.kind === 'reach') return role === 'tab' && member.runtimeId === owner.input.request.sourceCoordinator.runtimeId && member.agentSessionId === owner.input.request.agentSessionId &&
    member.expectedAdmission.kind === 'association' && member.expectedAdmission.operationId === owner.input.association.operationId
  const content = owner.input.request.content
  return content.kind === 'new-agent' && member.runtimeId === content.agentTarget?.runtimeId && member.expectedAdmission.kind === 'creation' && member.expectedAdmission.operationId === owner.input.request.operationId
}
export function readLaunchName(target: LaunchNameAddress, operationId?: string, signal?: AbortSignal) {
  return target.kind === 'member' ? api.spaceMounts.call('memberNameInspect', { ...target.carrier, name: { ...target.name, ...(operationId ? { operationId } : {}) } }, signal)
    : api.spaceMounts.call('agentNameInspect', { ...target.carrier, name: { runtimeId: target.name.runtimeId, agentSessionId: target.name.agentSessionId, ...(operationId ? { operationId } : {}) } }, signal)
}
const sends = new WeakMap<OriginalLaunchNameInput['change'], Promise<NameChangeResult>>()
/** A retry is always an explicit action on the same target, OP, value and CAS. */
export function sendLaunchName(owner: LaunchNameOwner, role: LaunchNameRole, confirm = false) {
  const input = originalLaunchName(owner, role)
  if (!input) return Promise.reject(Error('The original name intent is not available. The Agent remains unchanged.'))
  const pending = sends.get(input.change)
  if (pending) return pending
  const sending = (async () => {
    let dispatched = false
    try {
      editName(owner, role, value => value ? { ...value, issue: undefined } : unavailable())
      await checkpointMountedSpaceInputs()
      if (originalLaunchName(owner, role)?.change !== input.change) throw Error('The original name input changed before dispatch. No substitute name was sent.')
      const change = confirm ? { kind: 'confirm' as const, operationId: input.change.operationId } : input.change
      dispatched = true; editName(owner, role, value => value ? { ...value, submitted: true } : unavailable())
      const response = input.target.kind === 'member' ? await api.spaceMounts.call('memberNameChange', { ...input.target.carrier, name: { ...input.target.name, change } })
        : await api.spaceMounts.call('agentNameChange', { ...input.target.carrier, name: { ...input.target.name, change } })
      editName(owner, role, value => value ? { ...value, response, issue: undefined } : unavailable())
      return response
    } catch (cause) {
      editName(owner, role, value => value ? { ...value, issue: `${dispatched ? 'The original name result is unconfirmed.' : 'This name was not sent in this attempt.'} ${presentError(cause)}` } : unavailable())
      throw cause
    }
  })()
  sends.set(input.change, sending)
  void sending.finally(() => { if (sends.get(input.change) === sending) sends.delete(input.change) }).catch(() => {})
  return sending
}
/** Called only by the original explicit creation producer, never by render/read/restart. */
export async function applyOriginalLaunchNames(owner: LaunchNameOwner, selected: LaunchNameRole[] = roles) {
  await Promise.allSettled(selected.map(async role => {
    if (originalLaunchName(owner, role)) return
    const name = owner.input.origin?.names[role === 'agent' ? 'agentName' : 'tabName'].trim(), target = launchNameAddress(owner, role)
    if (!name || !target) return
    const input: OriginalLaunchNameInput = { target, change: { kind: 'rename', operationId: crypto.randomUUID(), name, source: 'launch', expectedNameRevision: 0 }, submitted: false }
    editName(owner, role, value => value ?? input)
    await sendLaunchName(owner, role)
  }))
}
/** A lower revision ACK keeps its operation history without rolling back current presentation. */
export function newestNameObservation(current: NameObservation | NameChangeResult | undefined, next: NameObservation | NameChangeResult) {
  return current && configValuesEqual(current.target, next.target) && current.current.nameRevision > next.current.nameRevision ? current : next
}
