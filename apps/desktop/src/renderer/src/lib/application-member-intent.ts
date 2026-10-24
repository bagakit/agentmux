import { parseConnectionActor, parseConnectionApplicationGrant, parseConnectionParams, type ConnectionActor, type ConnectionApplicationGrant, type ConnectionApplicationAccessConfigure, type ConnectionGrant } from '@agentmux/core/connections'
import { isMemberCapabilities, sameMemberCapabilities, savedMemberCapabilities } from './connector-member-draft'

export type ApplicationMemberDraft = {
  adapterId: string
  actor: ConnectionActor
  baseline: ConnectionApplicationGrant | null | 'unconfirmed'
  decision: 'rule' | 'absent'
  capabilities: ConnectionGrant['capabilities']
  reviewedOperations?: string[]
}
export type ApplicationMemberRequest = { adapterId: string; input: ConnectionApplicationAccessConfigure; phase: 'not-dispatched' | 'may-have-dispatched' }
/** Safe drafts and original requests only. Public reads remain the sole access facts. */
export type ApplicationAccessContinuation = {
  drafts: Record<string, ApplicationMemberDraft>
  requests: Record<string, ApplicationMemberRequest>
}
export const applicationMemberKey = (adapterId: string, actor: ConnectionActor) => JSON.stringify([adapterId, actor.application.domain, actor.application.appId, actor.idType, actor.userId])
export const emptyApplicationAccess = (): ApplicationAccessContinuation => ({ drafts: {}, requests: {} })

export function editApplicationMemberDraft(previous: ApplicationMemberDraft | undefined, adapterId: string, actor: ConnectionActor, current: ConnectionApplicationGrant | null | undefined, capabilities: ConnectionGrant['capabilities']): ApplicationMemberDraft | undefined {
  const baseline = previous ? previous.baseline : current === undefined ? 'unconfirmed' : current
  return { adapterId, actor: structuredClone(actor), baseline: structuredClone(baseline), decision: 'rule', capabilities: [...capabilities], ...(previous?.reviewedOperations ? { reviewedOperations: previous.reviewedOperations } : {}) }
}
export const applicationMemberDirty = (draft: ApplicationMemberDraft) => draft.baseline === 'unconfirmed' || (draft.decision === 'absent' ? draft.baseline !== null : draft.baseline === null || !sameMemberCapabilities(draft.capabilities, savedMemberCapabilities(draft.baseline)))

export function restoredApplicationAccess(value: unknown): ApplicationAccessContinuation {
  const result = emptyApplicationAccess()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  const raw = value as Partial<ApplicationAccessContinuation>
  for (const [key, item] of Object.entries(raw.drafts ?? {})) {
    try {
      const actor = parseConnectionActor(item.actor)
      if (typeof item.adapterId !== 'string' || !item.adapterId || key !== applicationMemberKey(item.adapterId, actor) || !isMemberCapabilities(item.capabilities) || item.decision !== 'rule' && item.decision !== 'absent') continue
      const baseline = item.baseline === null || item.baseline === 'unconfirmed' ? item.baseline : parseConnectionApplicationGrant(item.baseline)
      if (baseline && baseline !== 'unconfirmed' && (baseline.adapterId !== item.adapterId || JSON.stringify(baseline.actor) !== JSON.stringify(actor))) continue
      if (item.reviewedOperations !== undefined && !Array.isArray(item.reviewedOperations)) continue
      const reviewedOperations = item.reviewedOperations?.map(operationId => parseConnectionParams('connection.application.access.inspect', { operationId }).operationId)
      if (item.decision === 'absent' && (baseline !== null && baseline !== 'unconfirmed' || item.capabilities.length)) continue
      result.drafts[key] = { adapterId: item.adapterId, actor, baseline, decision: item.decision, capabilities: [...item.capabilities], ...(reviewedOperations ? { reviewedOperations } : {}) }
    } catch { /* An unreadable UI draft never creates an authorization decision. */ }
  }
  for (const [key, item] of Object.entries(raw.requests ?? {})) {
    try {
      const input = parseConnectionParams('connection.application.access.configure', item.input)
      if (key !== input.operationId || typeof item.adapterId !== 'string' || !item.adapterId) continue
      result.requests[key] = { adapterId: item.adapterId, input, phase: item.phase === 'not-dispatched' ? 'not-dispatched' : 'may-have-dispatched' }
    } catch { /* Keep the original Host operation; invalid local correlation never dispatches. */ }
  }
  return result
}
