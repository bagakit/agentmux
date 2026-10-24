import type { ConnectionEffectiveGrant, ConnectionGrant } from '@agentmux/core/connections'
/** Room snapshots remain the original persisted format; application references are explicitly namespaced. */
export function effectiveRoomGrant(grant: ConnectionGrant): ConnectionEffectiveGrant {
  return { actor: grant.actor, state: grant.state, capabilities: grant.capabilities, source: { kind: 'room', grantId: grant.grantId, revision: grant.revision } }
}
export function effectiveGrantSource(grant: ConnectionGrant | ConnectionEffectiveGrant): ConnectionEffectiveGrant['source'] {
  return 'source' in grant ? grant.source : { kind: 'room', grantId: grant.grantId, revision: grant.revision }
}
export function grantAuthorReference(grant: ConnectionEffectiveGrant) {
  return { grantId: grant.source.grantId, grantRevision: grant.source.revision, ...(grant.source.kind === 'application' ? { grantSource: 'application' as const } : {}) }
}
/** Keep the original room projection key bytes; the new source has its own namespace. */
export function effectiveGrantKey(grant: ConnectionGrant | ConnectionEffectiveGrant) {
  const source = effectiveGrantSource(grant)
  return source.kind === 'room' ? [source.grantId, source.revision] : ['application', source.grantId, source.revision]
}
