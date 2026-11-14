import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString } from './rpc-data.js'
import { observeRead } from './observation-read.js'
import { parseHostedRuntimeOwnerIdentity } from './hosted-value.js'
import { parseHostRuntimeSource, type HostRuntimeSource } from './host-runtime-observation.js'
import { parseAgentSessionResources, parseRunningSavedAgentResources } from './runtime-observation-codec.js'
import type { AgentMuxClient } from './client.js'
import type { AgentMuxRuntimeOwnerIdentity, AgentMuxHostedClient } from './hosted-client-contract.js'
import type { AgentMuxAgentSessionResourceSnapshot, AgentMuxRunningSavedAgentResourceSnapshot } from './types.js'

type Base = { routeHostId: string; requestedAt: number; completedAt: number; owner: HostRuntimeSource<AgentMuxRuntimeOwnerIdentity> }
export type HostAgentResourceObservation = Base & (
  | { kind: 'records'; measurement: HostRuntimeSource<AgentMuxAgentSessionResourceSnapshot> }
  | { kind: 'running'; measurement: HostRuntimeSource<AgentMuxRunningSavedAgentResourceSnapshot> }
)
type Client = Partial<Pick<AgentMuxClient, 'agentSessionResourceSnapshot' | 'runningSavedAgentResourceSnapshot'>> & Partial<Pick<AgentMuxHostedClient, 'readRuntimeOwnerIdentity'>>
type Query = { hostId: string; kind: 'records' | 'running'; expectedRuntimeId?: string }
const unavailable = (error: unknown): HostRuntimeSource<never> => ({ state: 'unavailable',
  code: error instanceof AgentMuxError ? error.code : 'AGENT_RESOURCE_UNAVAILABLE',
  message: 'This original Host measurement is unavailable. Refresh it; existing Agents and other measurements remain available.', readAt: Date.now() })

/** One requested source only. No clocks, shared observation cache, lifecycle or other-source wait. */
export async function observeHostAgentResources(query: Query, client: Client,
  readOwner: () => AgentMuxRuntimeOwnerIdentity | null | Promise<AgentMuxRuntimeOwnerIdentity | null>, signal?: AbortSignal): Promise<HostAgentResourceObservation> {
  const requestedAt = Date.now()
  const read = async <T>(operation: () => T | Promise<T>, validate: (value: unknown) => T): Promise<HostRuntimeSource<T>> => {
    signal?.throwIfAborted()
    try { const value = await observeRead(Promise.resolve().then(operation), signal); signal?.throwIfAborted(); return { state: 'available', value: validate(value), readAt: Date.now() } }
    catch (error) { signal?.throwIfAborted(); return unavailable(error) }
  }
  const readIdentity = () => read(async () => {
    // A passive empty cache cannot pre-empt the exact SDK read's own control identity.
    const value = await readOwner() ?? await client.readRuntimeOwnerIdentity?.(signal ? { signal } : undefined)
    if (!value) throw new AgentMuxError('The original Host identity is unconfirmed.', 'RUNTIME_OWNER_UNCONFIRMED')
    return value
  }, parseHostedRuntimeOwnerIdentity)
  const before = await readIdentity()
  const pinned = (owner: HostRuntimeSource<AgentMuxRuntimeOwnerIdentity>) => {
    if (query.expectedRuntimeId !== undefined && (owner.state !== 'available' || owner.value.runtimeId !== query.expectedRuntimeId))
      throw new AgentMuxError('The selected Host Runtime pin is unconfirmed or changed. Inspect the original route.', 'RUNTIME_OWNER_UNCONFIRMED')
  }
  pinned(before)
  const measurement = query.kind === 'records'
    ? await read(() => { if (!client.agentSessionResourceSnapshot) throw new AgentMuxError('This Core does not expose Agent record counts.', 'AGENT_RESOURCE_UNAVAILABLE'); return client.agentSessionResourceSnapshot(signal ? { signal } : undefined) }, parseAgentSessionResources)
    : await read(() => { if (!client.runningSavedAgentResourceSnapshot) throw new AgentMuxError('This Core does not expose running saved-Agent counts.', 'AGENT_RESOURCE_UNAVAILABLE'); return client.runningSavedAgentResourceSnapshot(signal ? { signal } : undefined) }, parseRunningSavedAgentResources)
  const owner = await readIdentity(); pinned(owner)
  const changed = before.state === 'available' && owner.state === 'available' &&
    (before.value.runtimeId !== owner.value.runtimeId || before.value.ownerInstanceId !== owner.value.ownerInstanceId)
  if (changed) throw new AgentMuxError('The original Host owner changed during its observation. Read the selected source again.', 'RUNTIME_OWNER_CHANGED')
  const base = { routeHostId: query.hostId, requestedAt, completedAt: Date.now(), owner }
  return parseHostAgentResourceObservation({ ...base, kind: query.kind, measurement }, query)
}

export function parseHostAgentResourceObservation(value: unknown, query: Query): HostAgentResourceObservation {
  const p = rpcRecord(value, ['routeHostId', 'kind', 'requestedAt', 'completedAt', 'owner', 'measurement'], 'CONTROL_PROTOCOL_ERROR')
  if (p.routeHostId !== query.hostId || p.kind !== query.kind || ![p.requestedAt, p.completedAt].every(n => Number.isSafeInteger(n) && (n as number) >= 0))
    throw new AgentMuxError('Agent measurements belong to another route/source or have invalid timestamps.', 'CONTROL_PROTOCOL_ERROR')
  parseHostRuntimeSource(p.owner, parseHostedRuntimeOwnerIdentity)
  parseHostRuntimeSource(p.measurement, query.kind === 'records' ? parseAgentSessionResources : parseRunningSavedAgentResources)
  const owner = p.owner as HostRuntimeSource<AgentMuxRuntimeOwnerIdentity>
  if (query.expectedRuntimeId !== undefined && (owner.state !== 'available' || owner.value.runtimeId !== query.expectedRuntimeId))
    throw new AgentMuxError('Agent measurement Runtime does not match its original pin.', 'CONTROL_PROTOCOL_ERROR')
  rpcString(p.routeHostId, 'Route Host ID')
  return value as HostAgentResourceObservation
}
