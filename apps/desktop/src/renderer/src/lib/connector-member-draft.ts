import { parseConnectionActor, parseConnectionGrant, parseConnectionParams, type ConnectionActor, type ConnectionGrant, type RoomBinding } from '@agentmux/core/connections'

type Capabilities = ConnectionGrant['capabilities']
export type ConnectorMemberDraft = {
  bindingId: string
  bindingRevision: number
  actor: ConnectionActor
  /** Original UI edit baseline only; the Host still owns authorization and CAS. */
  baseline: ConnectionGrant | null | 'unconfirmed'
  capabilities: Capabilities
  /** Terminal original requests explicitly reviewed against this UI baseline. */
  reviewedOperations?: string[]
}
export type ConnectorMemberDrafts = Record<string, ConnectorMemberDraft>
const capabilities = ['input', 'answer', 'permission'] as const
export const sameMemberCapabilities = (a: Capabilities, b: Capabilities) => capabilities.every(value => a.includes(value) === b.includes(value))
export const savedMemberCapabilities = (grant: Pick<ConnectionGrant, 'state' | 'capabilities'> | null | undefined): Capabilities => grant?.state === 'active' ? grant.capabilities : []
export const isMemberCapabilities = (value: unknown): value is Capabilities => Array.isArray(value) && value.length <= capabilities.length && new Set(value).size === value.length && value.every(item => capabilities.includes(item))
export const connectorMemberKey = (binding: Pick<RoomBinding, 'bindingId' | 'revision'>, actor: ConnectionActor) => JSON.stringify([binding.bindingId, binding.revision, actor.application.domain, actor.application.appId, actor.idType, actor.userId])

export function editConnectorMemberDraft(drafts: ConnectorMemberDrafts, binding: RoomBinding, actor: ConnectionActor, current: ConnectionGrant | null | undefined, desired: Capabilities): ConnectorMemberDrafts {
  const key = connectorMemberKey(binding, actor), previous = drafts[key]
  const baseline = previous ? previous.baseline : current === undefined ? 'unconfirmed' : current
  const next = { ...drafts }
  if (baseline !== 'unconfirmed' && sameMemberCapabilities(desired, savedMemberCapabilities(baseline))) delete next[key]
  else next[key] = { bindingId: binding.bindingId, bindingRevision: binding.revision, actor: structuredClone(actor), baseline: structuredClone(baseline), capabilities: capabilities.filter(value => desired.includes(value)), ...(previous?.reviewedOperations ? { reviewedOperations: previous.reviewedOperations } : {}) }
  return next
}

export function reviewConnectorMemberDraft(drafts: ConnectorMemberDrafts, binding: RoomBinding, actor: ConnectionActor, current: ConnectionGrant | null, originalKey = connectorMemberKey(binding, actor), reviewedOperations: string[] = [], requested?: Capabilities): ConnectorMemberDrafts {
  const key = connectorMemberKey(binding, actor), previous = drafts[originalKey]
  if (!previous && !requested || originalKey !== key && drafts[key]) return drafts
  const desired = previous?.capabilities ?? requested!
  const next = { ...drafts }
  delete next[originalKey]
  if (!sameMemberCapabilities(desired, savedMemberCapabilities(current))) next[key] = { bindingId: binding.bindingId, bindingRevision: binding.revision, actor: structuredClone(actor), capabilities: desired, baseline: structuredClone(current), reviewedOperations }
  return next
}

/** A receipt retires only the UI draft that still matches its exact submitted choices. */
export function acknowledgeConnectorMemberDraft(drafts: ConnectorMemberDrafts, binding: RoomBinding, actor: ConnectionActor, submitted: Capabilities): ConnectorMemberDrafts {
  const key = connectorMemberKey(binding, actor), draft = drafts[key]
  if (!draft || !sameMemberCapabilities(draft.capabilities, submitted)) return drafts
  const next = { ...drafts }; delete next[key]; return next
}

export function connectorMemberBaselineCurrent(draft: ConnectorMemberDraft, current: ConnectionGrant | null | undefined): boolean {
  if (current === undefined || draft.baseline === 'unconfirmed') return false
  return draft.baseline === null ? current === null : current?.grantId === draft.baseline.grantId && current.revision === draft.baseline.revision
}

export function restoredConnectorMemberDrafts(value: unknown): ConnectorMemberDrafts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: ConnectorMemberDrafts = {}
  for (const [key, raw] of Object.entries(value)) {
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const p = raw as Record<string, unknown>, actor = parseConnectionActor(p.actor)
      if (typeof p.bindingId !== 'string' || !p.bindingId || !Number.isSafeInteger(p.bindingRevision) || Number(p.bindingRevision) < 1 ||
          !Array.isArray(p.capabilities) || p.capabilities.length > capabilities.length || new Set(p.capabilities).size !== p.capabilities.length || p.capabilities.some(value => !capabilities.includes(value))) continue
      const selected = p.capabilities
      const baseline = p.baseline === null || p.baseline === 'unconfirmed' ? p.baseline : parseConnectionGrant(p.baseline)
      if (p.reviewedOperations !== undefined && !Array.isArray(p.reviewedOperations)) continue
      const reviewedOperations = p.reviewedOperations === undefined ? undefined : p.reviewedOperations.map(operationId => parseConnectionParams('connection.binding.inspect', { operationId }).operationId!)
      const draft: ConnectorMemberDraft = { bindingId: p.bindingId, bindingRevision: Number(p.bindingRevision), actor, baseline, capabilities: capabilities.filter(value => selected.includes(value)), ...(reviewedOperations ? { reviewedOperations } : {}) }
      if (key !== connectorMemberKey({ bindingId: draft.bindingId, revision: draft.bindingRevision }, actor) || baseline && baseline !== 'unconfirmed' && (baseline.bindingId !== draft.bindingId || baseline.bindingRevision !== draft.bindingRevision || JSON.stringify(baseline.actor) !== JSON.stringify(actor))) continue
      result[key] = draft
    } catch { /* Unreadable UI drafts never create or replace an authorization request. */ }
  }
  return result
}
