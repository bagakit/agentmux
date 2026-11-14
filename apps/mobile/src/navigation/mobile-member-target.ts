import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxSpaceAddress, AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { parseSpaceMemberRoute } from '@agentmux/core/space-member-codec'
import type { SpaceMemberRoute } from '@agentmux/core/space-member'

/** A device navigation reference, never admission or a transport grant. */
export type MobileMemberSelection = { sourceRuntimeId: string | null; target?: SpaceMemberRoute; issue?: string }
export function mobileMemberDraftScope(selection: MobileMemberSelection, agentSessionId: string, context?: AgentMuxSpaceAddress): string {
  return JSON.stringify(['member', selection.sourceRuntimeId, selection.target?.reference.spaceId, selection.target?.regionId,
    selection.target?.runtimeId, context?.spaceId, context?.tabId, context?.regionId, agentSessionId])
}
export function parseMobileMemberSelection(value: unknown): MobileMemberSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('原成员位置无法读取，原记录保持不变。')
  const p = value as Record<string, unknown>
  if (Object.keys(p).some(key => !['sourceRuntimeId', 'target', 'issue'].includes(key)) ||
      p.sourceRuntimeId !== null && (typeof p.sourceRuntimeId !== 'string' || !p.sourceRuntimeId) ||
      p.issue !== undefined && typeof p.issue !== 'string') throw Error('原成员位置无法读取，原记录保持不变。')
  const target = p.target === undefined ? undefined : parseSpaceMemberRoute(p.target)
  if (target && target.reference.runtimeId !== p.sourceRuntimeId) throw Error('原 Source 身份不一致，原记录保持不变。')
  return { sourceRuntimeId: p.sourceRuntimeId as string | null, ...(target ? { target } : {}), ...(p.issue === undefined ? {} : { issue: p.issue as string }) }
}

export function mobileMemberSelection(client: AgentMuxHostedClient | null, catalog: AgentMuxSpaceCatalog,
  id: string, place?: AgentMuxSpaceAddress, expectedHostId?: string): MobileMemberSelection | undefined {
  const sourceRuntimeId = client?.runtimeOwnerIdentity?.()?.runtimeId ?? null
  const unavailable = (issue: string): MobileMemberSelection => ({ sourceRuntimeId, issue })
  const regions = catalog.regions.filter(region => region.agentSessionId === id && (!expectedHostId || region.execution?.hostId === expectedHostId) && (!place ||
    region.regionId === place.regionId && region.tabId === place.tabId))
  // Only a positively matched original Runtime may use the connected local SDK.
  if (sourceRuntimeId && regions.length && regions.every(region => !region.association && region.execution?.hostId === 'local' &&
      (!region.execution.runtimeId || region.execution.runtimeId === sourceRuntimeId))) return undefined
  if (!regions.length) return !place && expectedHostId === 'local' ? undefined
    : unavailable('原执行端的成员位置尚未确认，未改用本机同名对话。')
  const region = regions.length === 1 ? regions[0] : undefined
  if (!region) return unavailable('原成员的执行位置不唯一，请选择准确位置；没有改用本机同名对话。')
  const spaces = place?.spaceId ? [place.spaceId] : catalog.bindings.filter(binding =>
    binding.zoneId === catalog.tabs.find(tab => tab.tabId === region.tabId)?.zoneId).map(binding => binding.spaceId)
  const spaceId = [...new Set(spaces)].length === 1 ? spaces[0] : undefined
  const runtimeId = region.execution?.runtimeId, operationId = region.association?.operationId ?? region.creationOperationId
  if (!sourceRuntimeId || !spaceId || !runtimeId || !operationId) return unavailable('原成员的 Source、执行身份或 C/L 尚未确认，原对话引用仍保留。')
  const identity = { reference: { runtimeId: sourceRuntimeId, spaceId }, regionId: region.regionId, runtimeId,
    agentSessionId: id, expectedAdmission: { kind: region.association ? 'association' as const : 'creation' as const, operationId } }
  return { sourceRuntimeId, target: region.runId && !region.association ? { ...identity, expectedRun: { runId: region.runId } }
    : { ...identity, kind: 'conversation' } }
}

