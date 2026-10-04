import type { AgentSessionNameMetadata } from '../../../shared/contracts'

export type SessionNameMetadata = Readonly<Record<string, AgentSessionNameMetadata>>
export const sessionNameMetadataKey = (hostId: string, agentSessionId: string) => JSON.stringify([hostId, agentSessionId])

/** Snapshot-only reading facts. Reuse unchanged entries so unrelated names do not rerender a Tab. */
export function sessionNameMetadataRecord(incoming: readonly AgentSessionNameMetadata[], previous: SessionNameMetadata = {}): SessionNameMetadata {
  const entries = incoming.map(value => {
    const key = sessionNameMetadataKey(value.hostId, value.agentSessionId), old = previous[key]
    return [key, old && JSON.stringify(old) === JSON.stringify(value) ? old : value] as const
  })
  return entries.length === Object.keys(previous).length && entries.every(([key, value]) => previous[key] === value)
    ? previous : Object.fromEntries(entries)
}

/** Display placement cannot establish execution identity; absent or conflicting Hosts stay unknown. */
export function sessionNameMetadataFor(metadata: SessionNameMetadata, agentSessionId: string, hosts: readonly (string | null | undefined)[]): AgentSessionNameMetadata | undefined {
  const known = new Set(hosts.filter((host): host is string => Boolean(host)))
  const host = known.size === 1 ? [...known][0] : undefined
  return host ? metadata[sessionNameMetadataKey(host, agentSessionId)] : undefined
}

/** A Tab may repeat an ID at different execution Hosts. Only unambiguous references share a name. */
export function sessionNamesForReferences(metadata: SessionNameMetadata, references: readonly {agentSessionId: string; hosts: readonly (string | null | undefined)[]}[]): Record<string, AgentSessionNameMetadata> {
  const resolved = new Map<string, AgentSessionNameMetadata | undefined>()
  for (const reference of references) {
    const name = sessionNameMetadataFor(metadata, reference.agentSessionId, reference.hosts)
    resolved.set(reference.agentSessionId, resolved.has(reference.agentSessionId) && resolved.get(reference.agentSessionId) !== name ? undefined : name)
  }
  return Object.fromEntries([...resolved].flatMap(([id, name]) => name ? [[id, name]] : []))
}
