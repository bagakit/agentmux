import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseTailcatListenerObservation, type TailcatListenerObservation } from './host-runtime-observation.js'
import type { AgentMuxRpcCallContext } from './public-rpc-service.js'

export type TailcatListenerConfig = { enabled: boolean; keyFile: string; allowedClients: string[] }
export const TAILCAT_CONFIGURATION_METHODS = { 'settings.hosts.tailcat.inspect': 'long', 'settings.hosts.tailcat.configure': 'long' } as const
export type TailcatConfigurationMethod = keyof typeof TAILCAT_CONFIGURATION_METHODS
export type TailcatConfigurationParamsMap = {
  'settings.hosts.tailcat.inspect': { hostId: 'local' }
  'settings.hosts.tailcat.configure': { hostId: 'local'; expected: TailcatListenerConfig | null; candidate: TailcatListenerConfig | null }
}
export type TailcatConfigurationObservation = {
  routeHostId: 'local'
  configuration: { source: 'original-config-owner'; value: TailcatListenerConfig | null; revision: string; readAt: number }
  /** Configuration publication and listener adoption are separate observations. */
  listener: { source: 'original-local-host-listener'; value: TailcatListenerObservation; readAt: number }
}
export type TailcatConfigurationResultMap = { [M in TailcatConfigurationMethod]: TailcatConfigurationObservation }
export type TailcatConfigurationContext = Pick<AgentMuxRpcCallContext, 'principal' | 'caller' | 'signal'>
export type TailcatConfigurationPort = { call<M extends TailcatConfigurationMethod>(method: M, params: TailcatConfigurationParamsMap[M], context: TailcatConfigurationContext): Promise<TailcatConfigurationResultMap[M]> }
export function assertTailcatConfigurationWriter(context: TailcatConfigurationContext): void {
  if (!context || context.caller !== undefined || context.principal?.kind !== 'user') throw new AgentMuxError(
    'Incoming Tailcat configuration requires a transport-approved user without a managed Agent caller. Keep the draft for that original user action.', 'CONTROL_PERMISSION_DENIED')
}
function configuration(value: unknown, code: string): TailcatListenerConfig | null {
  if (value === null) return null
  const p = rpcRecord(value, ['enabled', 'keyFile', 'allowedClients'], code)
  if (typeof p.enabled !== 'boolean' || typeof p.keyFile !== 'string' || !Array.isArray(p.allowedClients) || p.allowedClients.some(key => typeof key !== 'string')) throw new AgentMuxError('Tailcat configuration needs enabled, keyFile and allowedClients. No key material is accepted.', code)
  return { enabled: p.enabled, keyFile: p.keyFile, allowedClients: [...p.allowedClients] as string[] }
}
export function parseTailcatConfigurationParams<M extends TailcatConfigurationMethod>(method: M, value: unknown): TailcatConfigurationParamsMap[M] {
  const p = rpcRecord(value, method === 'settings.hosts.tailcat.inspect' ? ['hostId'] : ['hostId', 'expected', 'candidate'])
  if (p.hostId !== 'local') throw new AgentMuxError('Choose the answering App’s original local Host, not another route or Node.', 'INVALID_CONTROL_REQUEST')
  return (method === 'settings.hosts.tailcat.inspect' ? { hostId: 'local' } : { hostId: 'local', expected: configuration(p.expected, 'INVALID_CONTROL_REQUEST'), candidate: configuration(p.candidate, 'INVALID_CONTROL_REQUEST') }) as TailcatConfigurationParamsMap[M]
}
export function tailcatConfigurationRevision(value: TailcatListenerConfig | null): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
export function parseTailcatConfigurationResult<M extends TailcatConfigurationMethod>(method: M, value: unknown, input: TailcatConfigurationParamsMap[M]): TailcatConfigurationObservation {
  const p = rpcRecord(value, ['routeHostId', 'configuration', 'listener'], 'CONTROL_PROTOCOL_ERROR')
  const saved = rpcRecord(p.configuration, ['source', 'value', 'revision', 'readAt'], 'CONTROL_PROTOCOL_ERROR')
  const listener = rpcRecord(p.listener, ['source', 'value', 'readAt'], 'CONTROL_PROTOCOL_ERROR')
  const config = configuration(saved.value, 'CONTROL_PROTOCOL_ERROR')
  if (p.routeHostId !== 'local' || saved.source !== 'original-config-owner' || listener.source !== 'original-local-host-listener' ||
    saved.revision !== tailcatConfigurationRevision(config) || !Number.isSafeInteger(saved.readAt) || Number(saved.readAt) < 0 || !Number.isSafeInteger(listener.readAt) || Number(listener.readAt) < 0 ||
    method === 'settings.hosts.tailcat.configure' && !isDeepStrictEqual(config, (input as TailcatConfigurationParamsMap['settings.hosts.tailcat.configure']).candidate)) throw new AgentMuxError('Tailcat configuration returned another saved slice or source.', 'CONTROL_PROTOCOL_ERROR')
  return { routeHostId: 'local', configuration: { source: 'original-config-owner', value: config, revision: saved.revision as string, readAt: saved.readAt as number },
    listener: { source: 'original-local-host-listener', value: parseTailcatListenerObservation(listener.value), readAt: listener.readAt as number } }
}
