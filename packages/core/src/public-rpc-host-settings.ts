import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString } from './rpc-business-codec.js'
import type { AgentMuxCreationTrust, AgentMuxCreationAuthorityIdentity } from './agent-creation-admission.js'
import { parseAgentMuxCreationTrust } from './agent-creation-admission.js'
import type { AgentMuxHostExecutorInventory, AgentMuxHostExecutorConfiguration, AgentMuxHostExecutorConfigureInput, AgentMuxHostExecutorDescriptor } from './executor-contract.js'
import { isAgentMuxExecutorAvailability } from './control.js'

export const AGENTMUX_RPC_HOST_SETTINGS_METHODS = {
  'settings.executors.discover': 'long',
  'settings.executors.register': 'long',
  'settings.hosts.trusted-sources': 'long',
  'settings.hosts.trust-source': 'long'
} as const
export type HostSettingsMethod = keyof typeof AGENTMUX_RPC_HOST_SETTINGS_METHODS
export type HostSettingsParameterMap = {
  'settings.executors.discover': { hostId: string; refresh?: boolean }
  'settings.executors.register': { hostId: string; executorId: string; input: Omit<AgentMuxHostExecutorConfigureInput, 'executorId'> }
  'settings.hosts.trusted-sources': { hostId: string }
  'settings.hosts.trust-source': { hostId: string; input: { sourceRuntimeId: string; publicKey: string } }
}
export type HostSettingsResultMap = {
  'settings.executors.discover': AgentMuxHostExecutorInventory & { routeHostId: string }
  'settings.executors.register': AgentMuxHostExecutorConfiguration & { routeHostId: string }
  'settings.hosts.trusted-sources': { routeHostId: string; authority: AgentMuxCreationAuthorityIdentity; sources: AgentMuxCreationTrust[] }
  'settings.hosts.trust-source': { routeHostId: string; authority: AgentMuxCreationAuthorityIdentity; source: AgentMuxCreationTrust }
}
export function isHostSettingsMethod(method: unknown): method is HostSettingsMethod {
  return typeof method === 'string' && Object.hasOwn(AGENTMUX_RPC_HOST_SETTINGS_METHODS, method)
}
export function parseHostSettingsParams<M extends HostSettingsMethod>(method: M, value: unknown): HostSettingsParameterMap[M] {
  if (method === 'settings.executors.discover') {
    const p = rpcRecord(value, ['hostId', 'refresh'])
    if (p.refresh !== undefined && typeof p.refresh !== 'boolean') throw new AgentMuxError('Executor refresh must be boolean.', 'INVALID_CONTROL_REQUEST')
    return { hostId: rpcString(p.hostId, 'Route Host ID'), ...(p.refresh === undefined ? {} : { refresh: p.refresh }) } as HostSettingsParameterMap[M]
  }
  if (method === 'settings.executors.register') {
    const p = rpcRecord(value, ['hostId', 'executorId', 'input']), input = rpcRecord(p.input, ['config', 'expectedRevision'])
    // The target Executor owner validates the complete launch configuration before persistence.
    rpcRecord(input.config, ['label', 'providerId', 'command', 'args', 'env', 'injectAgentMuxGuide'])
    return { hostId: rpcString(p.hostId, 'Route Host ID'), executorId: rpcString(p.executorId, 'Executor ID'), input: {
      config: input.config, ...(input.expectedRevision === undefined ? {} : { expectedRevision: rpcString(input.expectedRevision, 'Executor revision') })
    } } as HostSettingsParameterMap[M]
  }
  const p = rpcRecord(value, method === 'settings.hosts.trust-source' ? ['hostId', 'input'] : ['hostId'])
  const hostId = rpcString(p.hostId, 'Route Host ID')
  if (method === 'settings.hosts.trusted-sources') return { hostId } as HostSettingsParameterMap[M]
  const input = rpcRecord(p.input, ['sourceRuntimeId', 'publicKey'])
  return { hostId, input: { sourceRuntimeId: rpcString(input.sourceRuntimeId, 'Source Runtime ID'),
    publicKey: rpcString(input.publicKey, 'Source public key') } } as HostSettingsParameterMap[M]
}
export function parseHostSettingsResult<M extends HostSettingsMethod>(method: M, value: unknown,
  input: HostSettingsParameterMap[M]): HostSettingsResultMap[M] {
  const fail = (): never => { throw new AgentMuxError('Host settings result belongs to another Host or source.', 'CONTROL_PROTOCOL_ERROR') }
  if (method === 'settings.executors.discover' || method === 'settings.executors.register') {
    const p = rpcRecord(value, method === 'settings.executors.discover' ? ['routeHostId', 'runtimeId', 'executors'] : ['routeHostId', 'runtimeId', 'executor'], 'CONTROL_PROTOCOL_ERROR')
    if (p.routeHostId !== input.hostId || typeof p.runtimeId !== 'string' || !p.runtimeId || /[\0\r\n]/u.test(p.runtimeId)) fail()
    const descriptor = (value: unknown): AgentMuxHostExecutorDescriptor => {
      const d = rpcRecord(value, ['executorId', 'label', 'providerId', 'command', 'source', 'configRevision', 'availability', 'executable', 'cause'], 'CONTROL_PROTOCOL_ERROR')
      for (const key of ['executorId', 'label', 'providerId', 'command', 'configRevision']) if (typeof d[key] !== 'string' || !d[key] || /[\0\r\n]/u.test(d[key])) fail()
      if (!['registered', 'provider-default'].includes(d.source as string) || !isAgentMuxExecutorAvailability(d.availability)) fail()
      if (d.executable !== undefined && (typeof d.executable !== 'string' || !d.executable.startsWith('/') || /[\0\r\n]/u.test(d.executable))) fail()
      if (d.availability === 'available' && (!d.executable || d.cause !== undefined) || d.availability === 'check-failed' && d.cause === undefined) fail()
      if (d.cause !== undefined) {
        const cause = rpcRecord(d.cause, ['code', 'message'], 'CONTROL_PROTOCOL_ERROR')
        if (typeof cause.code !== 'string' || !cause.code || typeof cause.message !== 'string') fail()
      }
      return d as AgentMuxHostExecutorDescriptor
    }
    if (method === 'settings.executors.discover') {
      if (!Array.isArray(p.executors)) fail()
      const executors = (p.executors as unknown[]).map(descriptor)
      if (new Set(executors.map(item => item.executorId)).size !== executors.length) fail()
      return { routeHostId: input.hostId, runtimeId: p.runtimeId, executors } as HostSettingsResultMap[M]
    }
    const executor = descriptor(p.executor)
    if (executor.executorId !== (input as HostSettingsParameterMap['settings.executors.register']).executorId) fail()
    return { routeHostId: input.hostId, runtimeId: p.runtimeId, executor } as HostSettingsResultMap[M]
  }
  const p = rpcRecord(value, method === 'settings.hosts.trust-source'
    ? ['routeHostId', 'authority', 'source'] : ['routeHostId', 'authority', 'sources'], 'CONTROL_PROTOCOL_ERROR')
  if (p.routeHostId !== input.hostId) fail()
  const authority = rpcRecord(p.authority, ['runtimeId', 'publicKey', 'fingerprint'], 'CONTROL_PROTOCOL_ERROR')
  for (const key of ['runtimeId', 'publicKey', 'fingerprint']) {
    if (typeof authority[key] !== 'string' || !authority[key] || /[\0\r\n]/u.test(authority[key])) fail()
  }
  const source = (value: unknown) => {
    const parsed = parseAgentMuxCreationTrust(value)
    if (parsed.targetRuntimeId !== authority.runtimeId) fail()
    return parsed
  }
  if (method === 'settings.hosts.trusted-sources') {
    if (!Array.isArray(p.sources)) fail()
    const sources = (p.sources as unknown[]).map(source)
    if (new Set(sources.map(item => item.sourceRuntimeId)).size !== sources.length) fail()
    return { routeHostId: input.hostId, authority, sources } as HostSettingsResultMap[M]
  }
  const actual = source(p.source), expected = (input as HostSettingsParameterMap['settings.hosts.trust-source']).input
  if (actual.sourceRuntimeId !== expected.sourceRuntimeId || actual.publicKey !== expected.publicKey) fail()
  return { routeHostId: input.hostId, authority, source: actual } as HostSettingsResultMap[M]
}
