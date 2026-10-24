import { groupWindowLimit, type ConnectionDiagnosisTarget, type ConnectionDiagnosisWindow, type GroupDiagnosis } from '@agentmux/core/connections'
import type { api } from './api'
export { groupTarget, groupWindowLimit, deliveryFacts, deliveryMatches, formatGroupDiagnosis, retainGroupDiagnosis } from '@agentmux/core/connections'
export type { GroupDiagnosis } from '@agentmux/core/connections'
export type GroupTarget = ConnectionDiagnosisTarget
export type GroupWindow = ConnectionDiagnosisWindow

/** GUI and managed Agents consume the same safe public projection. No private/admin reads here. */
export async function readGroupDiagnosis(source: typeof api.connections.call, target: GroupTarget, window: GroupWindow = {}): Promise<GroupDiagnosis> {
  try {
    const report = await source('connection.diagnose', { executionHostId: target.executionHostId, agentSessionId: target.agentSessionId, bindingId: target.bindingId, bindingRevision: target.bindingRevision, ...window })
    const group = report.groups.value?.items.find(group => JSON.stringify(group.target) === JSON.stringify(target))
    if (group) return { ...group, service: report.service }
    const issue = report.groups.issue ?? 'target-unconfirmed'
    return { target, window, limit: groupWindowLimit, service: report.service, adapterService: { value: null, issue }, connection: { value: null, issue }, binding: { value: null, issue }, outgoing: { value: null, issue }, incoming: { value: null, issue } }
  } catch {
    const issue = 'read-unavailable' as const
    return { target, window, limit: groupWindowLimit, service: { value: null, issue }, adapterService: { value: null, issue }, connection: { value: null, issue }, binding: { value: null, issue }, outgoing: { value: null, issue }, incoming: { value: null, issue } }
  }
}
