import { performance } from 'node:perf_hooks'
import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString } from './rpc-business-codec.js'
import { settingsResourceRecord } from './settings-resource-json.js'
import { observeRead } from './observation-read.js'
import { agentMuxSshEndpoint } from './runtime-client.js'
import { readNetworkInterfaces, parseNetworkInterfaces, parseRuntimeNetworkSnapshot, type NetworkInterfaceAddress, type RuntimeNetworkSnapshot } from './runtime-network.js'
import { readSshNetworkConfiguration, type SshNetworkConfiguration } from './ssh-network-configuration.js'
import type { AgentMuxControlSettingsResourceFields } from './control.js'
import type { AgentMuxRuntimeOwnerIdentity, AgentMuxRuntimeFence } from './hosted-client-contract.js'
import type { AgentMuxSshRuntimeClientOptions } from './runtime-client.js'
import type { HostRuntimeSource } from './host-runtime-observation.js'

export type HostNetworkObservation = {
  routeHostId: string
  configuration: AgentMuxControlSettingsResourceFields
  requestedAt: number
  completedAt: number
  /** The process composing this observation, not the user's device inferred from a Host alias. */
  observer: HostRuntimeSource<{ processId: number; observedAt: number; interfaces: NetworkInterfaceAddress[] }>
  /** Duration wraps only the fresh original-owner RPC, including any opening/queueing/processing. */
  target: HostRuntimeSource<{ requestDurationMs: number; sample: RuntimeNetworkSnapshot }>
  /** A configuration evaluation performed now, not a receipt from the live SSH carrier. */
  ssh: HostRuntimeSource<SshNetworkConfiguration> | null
}
const fail = (): never => { throw new AgentMuxError('Network observation is malformed or belongs to another source.', 'CONTROL_PROTOCOL_ERROR') }
function count(value: unknown, positive = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0)) return fail()
  return value as number
}
function source<T>(value: unknown, parse: (raw: unknown) => T): HostRuntimeSource<T> {
  const p = rpcRecord(value, ['state', 'value', 'code', 'message', 'readAt'], 'CONTROL_PROTOCOL_ERROR'), readAt = count(p.readAt)
  if (p.state === 'available' && p.code === undefined && p.message === undefined && Object.hasOwn(p, 'value')) return { state: 'available', value: parse(p.value), readAt }
  if (p.state === 'unavailable' && !Object.hasOwn(p, 'value')) return { state: 'unavailable', code: rpcString(p.code, 'Network observation error'), message: rpcString(p.message, 'Network observation message'), readAt }
  return fail()
}
function sshConfiguration(value: unknown): SshNetworkConfiguration {
  const p = rpcRecord(value, ['hostname', 'user', 'port', 'serverAliveInterval', 'serverAliveCountMax', 'tcpKeepAlive', 'proxy', 'jumps'], 'CONTROL_PROTOCOL_ERROR')
  rpcString(p.hostname, 'SSH hostname'); rpcString(p.user, 'SSH user')
  if (count(p.port, true) > 65535 || !['yes', 'no', 'transport', 'all'].includes(p.tcpKeepAlive as string) || !['direct', 'jump', 'command'].includes(p.proxy as string) || !Array.isArray(p.jumps)) return fail()
  count(p.serverAliveInterval); count(p.serverAliveCountMax)
  for (const raw of p.jumps) {
    const j = rpcRecord(raw, ['host', 'user', 'port'], 'CONTROL_PROTOCOL_ERROR')
    rpcString(j.host, 'SSH jump hostname'); if (j.user !== null) rpcString(j.user, 'SSH jump user')
    if (j.port !== null && count(j.port, true) > 65535) return fail()
  }
  if ((p.proxy === 'jump') !== (p.jumps.length > 0)) return fail()
  return p as SshNetworkConfiguration
}
export function parseHostNetworkObservation(value: unknown, hostId: string): HostNetworkObservation {
  const p = rpcRecord(value, ['routeHostId', 'configuration', 'requestedAt', 'completedAt', 'observer', 'target', 'ssh'], 'CONTROL_PROTOCOL_ERROR')
  if (p.routeHostId !== hostId) return fail()
  const configuration = settingsResourceRecord(p.configuration, 'CONTROL_PROTOCOL_ERROR')
  if (configuration.id !== hostId || !['local', 'ssh'].includes(configuration.kind as string)) return fail()
  count(p.requestedAt); count(p.completedAt)
  const observer = source(p.observer, raw => {
    const o = rpcRecord(raw, ['processId', 'observedAt', 'interfaces'], 'CONTROL_PROTOCOL_ERROR')
    return { processId: count(o.processId, true), observedAt: count(o.observedAt), interfaces: parseNetworkInterfaces(o.interfaces) }
  })
  const target = source(p.target, raw => {
    const t = rpcRecord(raw, ['requestDurationMs', 'sample'], 'CONTROL_PROTOCOL_ERROR')
    if (typeof t.requestDurationMs !== 'number' || !Number.isFinite(t.requestDurationMs) || t.requestDurationMs < 0) return fail()
    const sampleRecord = rpcRecord(t.sample, undefined, 'CONTROL_PROTOCOL_ERROR')
    const owner = rpcRecord(sampleRecord.owner, undefined, 'CONTROL_PROTOCOL_ERROR')
    const sample = parseRuntimeNetworkSnapshot(t.sample, { runtimeId: rpcString(owner.runtimeId, 'Runtime ID'), ownerInstanceId: rpcString(owner.ownerInstanceId, 'Owner instance') })
    if (configuration.kind === 'ssh' && configuration.runtimeId !== undefined && sample.owner.runtimeId !== configuration.runtimeId) return fail()
    return { requestDurationMs: t.requestDurationMs, sample }
  })
  if (configuration.kind === 'local' ? p.ssh !== null : p.ssh === null) return fail()
  return { routeHostId: hostId, configuration, requestedAt: p.requestedAt as number, completedAt: p.completedAt as number,
    observer, target, ssh: p.ssh === null ? null : source(p.ssh, sshConfiguration) }
}

type ReadTarget = (fence: AgentMuxRuntimeFence, signal: AbortSignal) => Promise<unknown>
/** Explicit, bounded observations only. Failure never disposes the borrowed client or changes its route. */
export async function observeHostNetwork(hostId: string, configuration: AgentMuxControlSettingsResourceFields,
  readOwner: () => AgentMuxRuntimeOwnerIdentity | null | Promise<AgentMuxRuntimeOwnerIdentity | null>, readTarget: ReadTarget,
  signal?: AbortSignal): Promise<HostNetworkObservation> {
  signal?.throwIfAborted()
  const requestedAt = Date.now()
  const read = async <T>(operation: (scope: AbortSignal) => T | Promise<T>): Promise<HostRuntimeSource<T>> => {
    // One observation may stop waiting; no Run or connection is declared unavailable by this budget.
    const deadline = AbortSignal.timeout(30_000), scope = signal ? AbortSignal.any([signal, deadline]) : deadline
    try { const value = await observeRead(Promise.resolve().then(() => operation(scope)), scope); signal?.throwIfAborted(); return { state: 'available', value, readAt: Date.now() } }
    catch (error) {
      signal?.throwIfAborted()
      return { state: 'unavailable', code: deadline.aborted ? 'NETWORK_OBSERVATION_TIMEOUT' : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'NETWORK_OBSERVATION_UNAVAILABLE',
        message: deadline.aborted ? 'This network read stopped waiting. The original connection and Runs are retained; read this link again.' : error instanceof Error ? error.message : 'This network source could not be read.', readAt: Date.now() }
    }
  }
  const [observer, target, ssh] = await Promise.all([
    read(() => ({ processId: process.pid, observedAt: Date.now(), interfaces: readNetworkInterfaces() })),
    read(async scope => {
      const owner = await observeRead(Promise.resolve().then(readOwner), scope)
      if (!owner || configuration.kind === 'ssh' && configuration.runtimeId !== undefined && configuration.runtimeId !== owner.runtimeId) throw new AgentMuxError('The original semantic owner is unconfirmed. Existing connections and work are retained.', 'RUNTIME_OWNER_UNCONFIRMED')
      const fence = { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }
      const start = performance.now()
      const raw = await readTarget(fence, scope)
      const requestDurationMs = performance.now() - start
      const sample = parseRuntimeNetworkSnapshot(raw, fence)
      return { requestDurationMs, sample }
    }),
    configuration.kind === 'ssh' ? read(scope => {
      const target = { ...configuration, hostId, hostname: rpcString(configuration.hostname, 'SSH hostname') } as AgentMuxSshRuntimeClientOptions['target']
      return readSshNetworkConfiguration(agentMuxSshEndpoint(target), scope)
    }) : Promise.resolve(null)
  ])
  signal?.throwIfAborted()
  return parseHostNetworkObservation({ routeHostId: hostId, configuration, requestedAt, completedAt: Date.now(), observer, target, ssh }, hostId)
}
