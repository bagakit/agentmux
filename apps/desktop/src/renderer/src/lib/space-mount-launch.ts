import type { AgentMuxRpcParams, AgentMuxRpcResult } from '@agentmux/core'
import type { SpaceMountRecord } from '../../../shared/space-mount'
import { editMountedSpaceInput, mountedSpaceInputs, mountedSpaceInput } from './space-mount-view'

export type MountedLauncherSlot = { kind: 'region'; tabId: string; regionId: string } | { kind: 'new-work'; zoneId: string }
export type MountedLauncherSelection = { agentHostId: string; executorId: string; prompt?: string }
/** Original user intent, retained beside this Window's private view; never a source Session or phase. */
export type MountedAgentOpenInput = { kind: 'agent-open'; target: SpaceMountRecord; slot: MountedLauncherSlot;
  request: AgentMuxRpcParams<'agent.open'> & { operationId: string }; submitted: boolean; receipt?: AgentMuxRpcResult<'agent.open'>; issue?: string }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0')
const unavailable = (): never => { throw Error('The original Space task arrangement is unreadable. Its input is retained; source observation remains available.') }
export function mountedLauncherSelection(value: unknown, key: string, slot: MountedLauncherSlot): MountedLauncherSelection | undefined {
  const entry = mountedSpaceInput(value, key)
  if (!entry || entry.launchers === undefined) return undefined
  if (!object(entry.launchers)) return unavailable()
  const selected = entry.launchers[mountedLauncherSlotKey(entry.target.reference, slot)]
  if (selected === undefined) return undefined
  if (!object(selected) || !text(selected.agentHostId) || typeof selected.executorId !== 'string' || selected.prompt !== undefined && typeof selected.prompt !== 'string') return unavailable()
  return selected as MountedLauncherSelection
}
export function editMountedLauncherSelection(value: unknown, key: string, slot: MountedLauncherSlot, selection: MountedLauncherSelection) {
  mountedLauncherSelection(value, key, slot)
  return editMountedSpaceInput(value, key, current => {
    if (!current) return unavailable()
    const id = mountedLauncherSlotKey(current.target.reference, slot)
    return { ...current, launchers: { ...(current.launchers as Record<string, unknown> | undefined), [id]: selection } }
  })
}
export const mountedLauncherSlotKey = (reference: SpaceMountRecord['reference'], slot: MountedLauncherSlot) =>
  JSON.stringify([reference.runtimeId, reference.spaceId, ...(slot.kind === 'region' ? ['region', slot.tabId, slot.regionId] : ['new-work', slot.zoneId])])
export const mountedAgentOpenKey = (target: SpaceMountRecord, slot: MountedLauncherSlot) => JSON.stringify(['agent-open', mountedLauncherSlotKey(target.reference, slot)])

export function mountedAgentOpenInput(value: unknown, key: string): MountedAgentOpenInput | undefined {
  const entry = mountedSpaceInputs(value)[key]
  if (entry === undefined) return undefined
  if (!object(entry) || entry.kind !== 'agent-open' || !object(entry.target) || !text(entry.target.hostId) || !object(entry.target.reference) ||
    !text(entry.target.reference.runtimeId) || !text(entry.target.reference.spaceId) || !text(entry.target.zoneId) || !text(entry.target.workspaceId) ||
    !object(entry.slot) || (entry.slot.kind === 'region' ? !text(entry.slot.tabId) || !text(entry.slot.regionId) : entry.slot.kind !== 'new-work' || entry.slot.zoneId !== entry.target.zoneId) || typeof entry.submitted !== 'boolean' || entry.receipt !== undefined && (!object(entry.receipt) || entry.receipt.operationId !== (object(entry.request) ? entry.request.operationId : undefined)) ||
    entry.issue !== undefined && typeof entry.issue !== 'string' || !object(entry.request)) return unavailable()
  const request = entry.request, content = request.content, destination = request.destination
  // Only this producer's current public request shape is adoptable. Other bytes remain opaque.
  if (!text(request.operationId) || request.focus !== false || !object(content) || content.kind !== 'new-agent' || !text(content.executorId) ||
    content.prompt !== undefined && typeof content.prompt !== 'string' || !object(destination) || destination.spaceId !== entry.target.reference.spaceId ||
    destination.zoneId !== entry.target.zoneId || destination.newTab !== true) return unavailable()
  if (content.agentTarget !== undefined && (!object(content.agentTarget) || !text(content.agentTarget.hostId) || !text(content.agentTarget.runtimeId))) return unavailable()
  const result = entry as MountedAgentOpenInput
  return mountedAgentOpenKey(result.target, result.slot) === key ? result : unavailable()
}
export function editMountedAgentOpen(value: unknown, key: string, update: (current: MountedAgentOpenInput | undefined) => MountedAgentOpenInput | undefined) {
  const entries = mountedSpaceInputs(value), current = mountedAgentOpenInput(value, key), next = update(current)
  if (next && mountedAgentOpenKey(next.target, next.slot) !== key) return unavailable()
  if (next === current) return entries
  const result = { ...entries }
  if (next) result[key] = next
  else delete result[key]
  return result
}
