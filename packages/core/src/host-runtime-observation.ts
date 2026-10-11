import { parseRuntimeIdentity, parseRuntimeDiagnostics, parseRuntimeResources } from './runtime-observation-codec.js'
import { settingsResourceRecord } from './settings-resource-json.js'
import type { AgentMuxControlSettingsResourceFields } from './control.js'
import { AgentMuxError } from './errors.js'
import { observeRead } from './observation-read.js'
import { parseHostedRuntimeOwnerIdentity } from './hosted-value.js'
import type { AgentMuxClient } from './client.js'
import type { AgentMuxRuntimeOwnerIdentity } from './hosted-client-contract.js'
import type { AgentMuxRuntimeIdentity, AgentMuxRuntimeDiagnostics, AgentMuxRuntimeResourceSnapshot } from './types.js'

/** readAt is the receiving service's read completion, never a producer sample timestamp. */
export type HostRuntimeSource<T> =
  | { state: 'available'; value: T; readAt: number }
  | { state: 'unavailable'; code: string; message: string; readAt: number }
export type HostRuntimeObservation = {
  routeHostId: string
  /** Original route configuration; null when this endpoint has no Host configuration owner. */
  configuration: AgentMuxControlSettingsResourceFields | null
  requestedAt: number
  completedAt: number
  owner: HostRuntimeSource<AgentMuxRuntimeOwnerIdentity>
  nativeIdentity: HostRuntimeSource<AgentMuxRuntimeIdentity>
  diagnostics: HostRuntimeSource<AgentMuxRuntimeDiagnostics>
  resources: HostRuntimeSource<AgentMuxRuntimeResourceSnapshot>
}
function invalid(): never { throw new AgentMuxError('Host Runtime observation is malformed or belongs to another source.', 'CONTROL_PROTOCOL_ERROR') }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid()
  return value as Record<string, unknown>
}
function identity(value: unknown): void { if (typeof value !== 'string' || !value || /[\0\r\n]/u.test(value)) invalid() }
function count(value: unknown): void { if (!Number.isSafeInteger(value) || (value as number) < 0) invalid() }
function source(value: unknown, validate: (value: unknown) => void): void {
  const p = record(value, ['state', 'value', 'code', 'message', 'readAt'])
  count(p.readAt)
  if (p.state === 'available') { if (p.code !== undefined || p.message !== undefined || !Object.hasOwn(p, 'value')) invalid(); validate(p.value) }
  else if (p.state === 'unavailable') { if (Object.hasOwn(p, 'value')) invalid(); identity(p.code); if (typeof p.message !== 'string' || !p.message) invalid() }
  else invalid()
}
export function parseHostRuntimeObservation(value: unknown, routeHostId: string): HostRuntimeObservation {
  const p = record(value, ['routeHostId', 'configuration', 'requestedAt', 'completedAt', 'owner', 'nativeIdentity', 'diagnostics', 'resources'])
  if (p.routeHostId !== routeHostId) invalid()
  if (p.configuration !== null) settingsResourceRecord(p.configuration, 'CONTROL_PROTOCOL_ERROR')
  identity(p.routeHostId); count(p.requestedAt); count(p.completedAt)
  source(p.owner, parseHostedRuntimeOwnerIdentity); source(p.nativeIdentity, parseRuntimeIdentity); source(p.diagnostics, parseRuntimeDiagnostics); source(p.resources, parseRuntimeResources)
  const result = value as HostRuntimeObservation
  if (result.nativeIdentity.state === 'available' && result.diagnostics.state === 'available' &&
      result.nativeIdentity.value.instanceId !== result.diagnostics.value.ctxmux.serving.instanceId) invalid()
  if (result.owner.state === 'available' && result.owner.value.ctxmux && result.nativeIdentity.state === 'available' &&
      result.owner.value.ctxmux.instanceId !== result.nativeIdentity.value.instanceId) invalid()
  return result
}
function unavailable(error: unknown): HostRuntimeSource<never> {
  return { state: 'unavailable', code: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'RUNTIME_OBSERVATION_UNAVAILABLE',
    message: error instanceof Error ? error.message : String(error), readAt: Date.now() }
}
/** Composes the original read methods. No connection, Session discovery, attachment or sampling clock. */
export async function observeHostRuntime(routeHostId: string,
  client: Pick<AgentMuxClient, 'runtimeIdentity' | 'runtimeDiagnostics' | 'runtimeResourceSnapshot'>,
  readOwner: () => AgentMuxRuntimeOwnerIdentity | null | Promise<AgentMuxRuntimeOwnerIdentity | null>, signal?: AbortSignal,
  configuration: AgentMuxControlSettingsResourceFields | null = null): Promise<HostRuntimeObservation> {
  signal?.throwIfAborted()
  const requestedAt = Date.now()
  const read = async <T>(operation: () => T | Promise<T>, validate?: (value: unknown) => T): Promise<HostRuntimeSource<T>> => {
    signal?.throwIfAborted()
    try { const raw = await observeRead(Promise.resolve().then(operation), signal); signal?.throwIfAborted(); return { state: 'available', value: validate ? validate(raw) : raw, readAt: Date.now() } }
    catch (error) { signal?.throwIfAborted(); return unavailable(error) }
  }
  const semanticOwner = async () => {
    const value = await readOwner()
    if (!value) throw new AgentMuxError('The original semantic Runtime identity is unconfirmed.', 'RUNTIME_OWNER_UNCONFIRMED')
    return parseHostedRuntimeOwnerIdentity(value)
  }
  let owner = await read(semanticOwner)
  let nativeIdentity = await read(() => client.runtimeIdentity(), parseRuntimeIdentity)
  let [diagnosticSource, resourceSource] = await Promise.all([
    read(() => client.runtimeDiagnostics(signal ? { signal } : undefined), parseRuntimeDiagnostics),
    read(() => client.runtimeResourceSnapshot(signal ? { signal } : undefined), parseRuntimeResources)
  ])
  const after = await read(semanticOwner)
  const changed = owner.state === 'available' && after.state === 'available' && after.value &&
    (owner.value.runtimeId !== after.value.runtimeId || owner.value.ownerInstanceId !== after.value.ownerInstanceId)
  if (changed) {
    const failure = unavailable(new AgentMuxError('The semantic Runtime owner changed during this observation. Read the original target again.', 'RUNTIME_OWNER_CHANGED'))
    owner = failure; nativeIdentity = failure; diagnosticSource = failure; resourceSource = failure
  } else if (nativeIdentity.state === 'available') {
    const before = nativeIdentity.value.instanceId
    const current = await read(() => client.runtimeIdentity(), parseRuntimeIdentity)
    if (current.state !== 'available' || current.value.instanceId !== before) {
      const failure = unavailable(new AgentMuxError('The Native Runtime changed or became unconfirmed during this observation.', 'CTXMUX_DISCONNECTED'))
      nativeIdentity = failure; diagnosticSource = failure; resourceSource = failure
    }
  }
  if (!changed) owner = after
  // The serving diagnostics can be newer than the consumer's cached Native identity.
  // Keep that successful producer fact; resource counts carry no instance identity of
  // their own, so do not attribute them to the stale cached instance.
  if (nativeIdentity.state === 'available' && diagnosticSource.state === 'available' && nativeIdentity.value.instanceId !== diagnosticSource.value.ctxmux.serving.instanceId) {
    const failure = unavailable(new AgentMuxError('The Native identity cache has not confirmed this diagnostics instance. Refresh the original observation.', 'NATIVE_IDENTITY_UNCONFIRMED'))
    nativeIdentity = failure; resourceSource = failure
  }
  if (owner.state === 'available' && owner.value.ctxmux && nativeIdentity.state === 'available' && owner.value.ctxmux.instanceId !== nativeIdentity.value.instanceId) {
    owner = unavailable(new AgentMuxError('The semantic owner cache has not confirmed this Native instance. Refresh the original observation.', 'RUNTIME_OWNER_UNCONFIRMED'))
  }
  signal?.throwIfAborted()
  return parseHostRuntimeObservation({ routeHostId, configuration, requestedAt, completedAt: Date.now(), owner,
    nativeIdentity, diagnostics: diagnosticSource, resources: resourceSource }, routeHostId)
}
