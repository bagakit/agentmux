import type { AgentMuxMessageTrust, AgentMuxMessageTrustInput } from './agent-message-federation.js'
import { isDeepStrictEqual } from 'node:util'
import { parseHostEnvironment, parseSelectedHostEnvironment,
  type AgentMuxHostEnvironment, type AgentMuxSelectedHostEnvironment } from './host-environment.js'
import { parseHostRuntimeObservation, type HostRuntimeObservation } from './host-runtime-observation.js'
import { parseHostNetworkObservation, type HostNetworkObservation } from './host-network-observation.js'
import { parseHostAgentResourceObservation, type HostAgentResourceObservation } from './host-agent-resources.js'
import { settingsResourceRecord } from './settings-resource-json.js'
import type { AgentMuxControlSettingsResourceFields } from './control.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString } from './rpc-data.js'
import type { AgentMuxCreationTrust, AgentMuxCreationAuthorityIdentity } from './agent-creation-admission.js'
import { parseAgentMuxCreationTrust, parseAgentMuxCreationTrustInput, type AgentMuxCreationTrustInput } from './agent-creation-admission.js'
import { parseHostExecutorDescriptor, parseHostExecutorInventory, type AgentMuxHostExecutorInventory, type AgentMuxHostExecutorConfiguration, type AgentMuxHostExecutorConfigureInput, type AgentMuxHostExecutorRemoval } from './executor-contract.js'
import type { AgentHostExecutorHookResult, AgentHostExecutorHookTarget } from './managed-hook-installer.js'
import type { AgentHostProviderHookList, AgentHostProviderHookListInput, AgentHostProviderHookResult,
  AgentHostProviderHookScope, AgentHostProviderHookTarget } from './host-provider-hooks.js'

export const AGENTMUX_RPC_HOST_SETTINGS_METHODS = {
  'settings.hosts.home': 'long',
  'settings.hosts.inspect': 'long',
  'settings.hosts.agent-resources': 'long',
  'settings.hosts.network': 'long',
  'settings.executors.discover': 'long',
  'settings.executors.register': 'long',
  'settings.executors.unregister': 'long',
  'settings.executors.hooks-inspect': 'long',
  'settings.executors.hooks-update': 'long',
  'settings.providers.hooks-list': 'long',
  'settings.providers.hooks-inspect': 'long',
  'settings.providers.hooks-update': 'long',
  'settings.hosts.trusted-sources': 'long',
  'settings.hosts.message-trusted-sources': 'long',
  'settings.hosts.trust-message-source': 'long',
  'settings.hosts.trust-source': 'long'
} as const
export type HostSettingsMethod = keyof typeof AGENTMUX_RPC_HOST_SETTINGS_METHODS
export type HostSettingsParameterMap = {
  'settings.hosts.home': { hostId: string; expected?: AgentMuxControlSettingsResourceFields; agentSessionId?: string }
  'settings.hosts.inspect': { hostId: string; expected?: AgentMuxControlSettingsResourceFields }
  'settings.hosts.agent-resources': { hostId: string; kind: 'records' | 'running'; expected?: AgentMuxControlSettingsResourceFields; expectedRuntimeId?: string }
  'settings.hosts.network': { hostId: string; expected?: AgentMuxControlSettingsResourceFields }
  'settings.executors.discover': { hostId: string; refresh?: boolean; executorId?: string }
  'settings.executors.unregister': { hostId: string; executorId: string; expectedRegistrationRevision: string }
  'settings.executors.register': { hostId: string; executorId: string; input: Omit<AgentMuxHostExecutorConfigureInput, 'executorId'> }
  'settings.executors.hooks-inspect': AgentHostExecutorHookTarget & { hostId: string }
  'settings.executors.hooks-update': AgentHostExecutorHookTarget & { hostId: string }
  'settings.providers.hooks-list': AgentHostProviderHookListInput & { hostId: string }
  'settings.providers.hooks-inspect': AgentHostProviderHookTarget & { hostId: string }
  'settings.providers.hooks-update': AgentHostProviderHookTarget & { hostId: string }
  'settings.hosts.trusted-sources': { hostId: string }
  'settings.hosts.trust-source': { hostId: string; input: AgentMuxCreationTrustInput }
  'settings.hosts.message-trusted-sources': { hostId: string }
  'settings.hosts.trust-message-source': { hostId: string; input: AgentMuxMessageTrustInput }
}
export type HostSettingsResultMap = {
  'settings.hosts.home': (AgentMuxHostEnvironment | AgentMuxSelectedHostEnvironment) & { routeHostId: string }
  'settings.hosts.inspect': HostRuntimeObservation
  'settings.hosts.agent-resources': HostAgentResourceObservation
  'settings.hosts.network': HostNetworkObservation
  'settings.executors.discover': AgentMuxHostExecutorInventory & { routeHostId: string }
  'settings.executors.unregister': AgentMuxHostExecutorRemoval & { routeHostId: string }
  'settings.executors.register': AgentMuxHostExecutorConfiguration & { routeHostId: string }
  'settings.executors.hooks-inspect': AgentHostExecutorHookResult & { routeHostId: string }
  'settings.executors.hooks-update': AgentHostExecutorHookResult & { routeHostId: string }
  'settings.providers.hooks-list': AgentHostProviderHookList & { routeHostId: string }
  'settings.providers.hooks-inspect': AgentHostProviderHookResult & { routeHostId: string }
  'settings.providers.hooks-update': AgentHostProviderHookResult & { routeHostId: string }
  'settings.hosts.trusted-sources': { routeHostId: string; authority: AgentMuxCreationAuthorityIdentity; sources: AgentMuxCreationTrust[] }
  'settings.hosts.trust-source': { routeHostId: string; authority: AgentMuxCreationAuthorityIdentity; source: AgentMuxCreationTrust }
  'settings.hosts.message-trusted-sources': { routeHostId: string; authority: AgentMuxCreationAuthorityIdentity; sources: AgentMuxMessageTrust[] }
  'settings.hosts.trust-message-source': { routeHostId: string; authority: AgentMuxCreationAuthorityIdentity; source: AgentMuxMessageTrust }
}
export function isHostSettingsMethod(method: unknown): method is HostSettingsMethod {
  return typeof method === 'string' && Object.hasOwn(AGENTMUX_RPC_HOST_SETTINGS_METHODS, method)
}
export function isExecutorHookMethod(method: string): method is 'settings.executors.hooks-inspect' | 'settings.executors.hooks-update' {
  return method === 'settings.executors.hooks-inspect' || method === 'settings.executors.hooks-update'
}
export function isProviderHookMethod(method: string): method is 'settings.providers.hooks-list' | 'settings.providers.hooks-inspect' | 'settings.providers.hooks-update' {
  return method === 'settings.providers.hooks-list' || method === 'settings.providers.hooks-inspect' || method === 'settings.providers.hooks-update'
}
const isHookDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const providerHookTargetFields = ['providerId', 'runtimeId', 'scopeId', 'scopeRevision', 'workspacePath'] as const

export function parseProviderHookListInput(value: unknown): AgentHostProviderHookListInput {
  const p = rpcRecord(value, ['providerId', 'workspacePath'])
  return { ...(p.providerId === undefined ? {} : { providerId: rpcString(p.providerId, 'Provider ID') }),
    ...(p.workspacePath === undefined ? {} : { workspacePath: rpcString(p.workspacePath, 'Workspace path') }) }
}
export function parseProviderHookTarget(value: unknown): AgentHostProviderHookTarget {
  const p = rpcRecord(value, providerHookTargetFields)
  if (!isHookDigest(p.scopeId) || !isHookDigest(p.scopeRevision)) {
    throw new AgentMuxError('Use the original Hook scope identity and revision from Provider Hooks discovery.', 'INVALID_CONTROL_REQUEST')
  }
  return { runtimeId: rpcString(p.runtimeId, 'Original Runtime ID'), providerId: rpcString(p.providerId, 'Provider ID'),
    scopeId: p.scopeId, scopeRevision: p.scopeRevision,
    ...(p.workspacePath === undefined ? {} : { workspacePath: rpcString(p.workspacePath, 'Workspace path') }) }
}
export function parseExecutorHookTarget(p: Record<string, unknown>): AgentHostExecutorHookTarget {
  return { runtimeId: rpcString(p.runtimeId, 'Original Runtime ID'), executorId: rpcString(p.executorId, 'Executor ID'),
    configRevision: rpcString(p.configRevision, 'Current Executor configuration revision'),
    ...(p.workspacePath === undefined ? {} : { workspacePath: rpcString(p.workspacePath, 'Workspace path') }) }
}
export function parseHostSettingsParams<M extends HostSettingsMethod>(method: M, value: unknown): HostSettingsParameterMap[M] {
  if (isExecutorHookMethod(method)) {
    const p = rpcRecord(value, ['hostId', 'runtimeId', 'executorId', 'configRevision', 'workspacePath'])
    return { hostId: rpcString(p.hostId, 'Route Host ID'), ...parseExecutorHookTarget(p) } as HostSettingsParameterMap[M]
  }
  if (isProviderHookMethod(method)) {
    const { hostId, ...p } = rpcRecord(value, method === 'settings.providers.hooks-list'
      ? ['hostId', 'providerId', 'workspacePath'] : ['hostId', ...providerHookTargetFields])
    return { hostId: rpcString(hostId, 'Route Host ID'), ...(method === 'settings.providers.hooks-list'
      ? parseProviderHookListInput(p) : parseProviderHookTarget(p)) } as HostSettingsParameterMap[M]
  }
  if (method === 'settings.hosts.agent-resources') {
    const p = rpcRecord(value, ['hostId', 'kind', 'expected', 'expectedRuntimeId'])
    if (p.kind !== 'records' && p.kind !== 'running') throw new AgentMuxError('Choose records or running for this Host observation.', 'INVALID_CONTROL_REQUEST')
    return { hostId: rpcString(p.hostId, 'Route Host ID'), kind: p.kind,
      ...(p.expected === undefined ? {} : { expected: settingsResourceRecord(p.expected, 'INVALID_CONTROL_REQUEST') }),
      ...(p.expectedRuntimeId === undefined ? {} : { expectedRuntimeId: rpcString(p.expectedRuntimeId, 'Original Runtime ID') }) } as HostSettingsParameterMap[M]
  }
  if (method === 'settings.hosts.home') {
    const p = rpcRecord(value, ['hostId', 'expected', 'agentSessionId'])
    return { hostId: rpcString(p.hostId, 'Route Host ID'),
      ...(p.expected === undefined ? {} : { expected: settingsResourceRecord(p.expected, 'INVALID_CONTROL_REQUEST') }),
      ...(p.agentSessionId === undefined ? {} : { agentSessionId: rpcString(p.agentSessionId, 'Original Agent Session ID') }) } as HostSettingsParameterMap[M]
  }
  if (method === 'settings.hosts.inspect' || method === 'settings.hosts.network') {
    const p = rpcRecord(value, ['hostId', 'expected'])
    return { hostId: rpcString(p.hostId, 'Route Host ID'), ...(p.expected === undefined ? {} : { expected: settingsResourceRecord(p.expected, 'INVALID_CONTROL_REQUEST') }) } as HostSettingsParameterMap[M]
  }
  if (method === 'settings.executors.discover') {
    const p = rpcRecord(value, ['hostId', 'refresh', 'executorId'])
    if (p.refresh !== undefined && typeof p.refresh !== 'boolean') throw new AgentMuxError('Executor refresh must be boolean.', 'INVALID_CONTROL_REQUEST')
    return { hostId: rpcString(p.hostId, 'Route Host ID'), ...(p.refresh === undefined ? {} : { refresh: p.refresh }),
      ...(p.executorId === undefined ? {} : { executorId: rpcString(p.executorId, 'Selected Executor ID') }) } as HostSettingsParameterMap[M]
  }
  if (method === 'settings.executors.unregister') {
    const p = rpcRecord(value, ['hostId', 'executorId', 'expectedRegistrationRevision'])
    return { hostId: rpcString(p.hostId, 'Route Host ID'), executorId: rpcString(p.executorId, 'Executor ID'),
      expectedRegistrationRevision: rpcString(p.expectedRegistrationRevision, 'Exact registration revision') } as HostSettingsParameterMap[M]
  }
  if (method === 'settings.executors.register') {
    const p = rpcRecord(value, ['hostId', 'executorId', 'input']), input = rpcRecord(p.input, ['config', 'expectedRevision'])
    // The target Executor owner validates the complete launch configuration before persistence.
    rpcRecord(input.config, ['label', 'providerId', 'command', 'args', 'env', 'injectAgentMuxGuide'])
    return { hostId: rpcString(p.hostId, 'Route Host ID'), executorId: rpcString(p.executorId, 'Executor ID'), input: {
      config: input.config, ...(input.expectedRevision === undefined ? {} : { expectedRevision: rpcString(input.expectedRevision, 'Executor revision') })
    } } as HostSettingsParameterMap[M]
  }
  const p = rpcRecord(value, (method === 'settings.hosts.trust-source' || method === 'settings.hosts.trust-message-source') ? ['hostId', 'input'] : ['hostId'])
  const hostId = rpcString(p.hostId, 'Route Host ID')
  if (method === 'settings.hosts.inspect' || method === 'settings.hosts.trusted-sources' || method === 'settings.hosts.message-trusted-sources') return { hostId } as HostSettingsParameterMap[M]
  return { hostId, input: parseAgentMuxCreationTrustInput(p.input) } as HostSettingsParameterMap[M]
}

function parseHookMaintenanceResult(p: Record<string, unknown>, updateRequested: boolean, fail: () => never): Pick<AgentHostExecutorHookResult, 'inspection' | 'health' | 'canUpdate' | 'update'> {
  const protocol = 'CONTROL_PROTOCOL_ERROR'
  if (typeof p.canUpdate !== 'boolean' || !['current', 'issue', 'unknown', 'not-managed'].includes(p.health as string)) fail()
  const inspection = rpcRecord(p.inspection, ['providerId', 'checkedAt', 'status', 'code', 'action', 'targets'], protocol)
  if (typeof inspection.providerId !== 'string' || typeof inspection.checkedAt !== 'number' || !Number.isFinite(inspection.checkedAt) ||
    !['installed', 'not_installed', 'partial', 'error', 'skipped'].includes(inspection.status as string) ||
    typeof inspection.code !== 'string' || (inspection.action !== null && typeof inspection.action !== 'string') || !Array.isArray(inspection.targets)) return fail()
  for (const target of inspection.targets) {
    const item = rpcRecord(target, ['path', 'status', 'code', 'expectedRevision', 'observedRevision', 'legacyDeclarations',
      'missingLegacyEntrypoints', 'missingLegacyDependencies'], protocol)
    const counts = [item.legacyDeclarations, item.missingLegacyEntrypoints, item.missingLegacyDependencies]
    if (typeof item.path !== 'string' || !['current', 'not_present', 'partial', 'error'].includes(item.status as string) ||
      (item.code !== undefined && typeof item.code !== 'string') ||
      [item.expectedRevision, item.observedRevision].some(revision => revision !== undefined && !isHookDigest(revision)) ||
      (item.observedRevision !== undefined && item.expectedRevision === undefined) ||
      counts.some(count => count !== undefined && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1)) ||
      Number(item.missingLegacyEntrypoints ?? 0) + Number(item.missingLegacyDependencies ?? 0) > Number(item.legacyDeclarations ?? 0)) fail()
  }
  const update = rpcRecord(p.update, ['status', 'receiptId', 'code'], protocol)
  if (updateRequested ? !['not-applicable', 'unchanged', 'updated', 'unconfirmed'].includes(update.status as string) : update.status !== 'not-requested') fail()
  if (update.status === 'updated' ? typeof update.receiptId !== 'string' || update.code !== undefined :
    update.receiptId !== undefined || (update.status === 'unconfirmed' ? typeof update.code !== 'string' : update.code !== undefined)) fail()
  return p as ReturnType<typeof parseHookMaintenanceResult>
}

function parseProviderHookScope(value: unknown, update: boolean, fail: () => never): AgentHostProviderHookScope {
  const protocol = 'CONTROL_PROTOCOL_ERROR'
  const p = rpcRecord(value, ['providerId', 'scopeId', 'scopeRevision', 'kind', 'paths', 'executors', 'inspection', 'health', 'canUpdate', 'update'], protocol)
  const maintenance = parseHookMaintenanceResult(p, update, fail)
  if (typeof p.providerId !== 'string' || !p.providerId || maintenance.inspection.providerId !== p.providerId || !isHookDigest(p.scopeId) ||
    !['configuration', 'launch-carried', 'unresolved', 'unmanaged'].includes(p.kind as string) ||
    (p.scopeRevision !== undefined && (!isHookDigest(p.scopeRevision) || p.kind !== 'configuration')) || p.canUpdate !== (p.scopeRevision !== undefined) ||
    !Array.isArray(p.paths) || p.paths.some(path => typeof path !== 'string' || !path || path.includes('\0')) || new Set(p.paths).size !== p.paths.length ||
    (p.kind === 'configuration') !== (p.paths.length > 0) || !Array.isArray(p.executors) || !p.executors.length) return fail()
  const paths = new Set(p.paths)
  if (maintenance.inspection.targets.some(target => !paths.has(target.path))) return fail()
  const executorIds = new Set<string>()
  for (const executor of p.executors) {
    const item = rpcRecord(executor, ['executorId', 'label', 'configRevision', 'canInspectLoading'], protocol)
    if (typeof item.executorId !== 'string' || !item.executorId || executorIds.has(item.executorId) || typeof item.label !== 'string' || !item.label ||
      !isHookDigest(item.configRevision) || typeof item.canInspectLoading !== 'boolean') return fail()
    executorIds.add(item.executorId)
  }
  return p as AgentHostProviderHookScope
}

export function parseHostSettingsResult<M extends HostSettingsMethod>(method: M, value: unknown,
  input: HostSettingsParameterMap[M]): HostSettingsResultMap[M] {
  if (method === 'settings.hosts.agent-resources') return parseHostAgentResourceObservation(value,
    input as HostSettingsParameterMap['settings.hosts.agent-resources']) as HostSettingsResultMap[M]
  if (method === 'settings.hosts.home') {
    const query = input as HostSettingsParameterMap['settings.hosts.home']
    const selected = query.agentSessionId !== undefined
    const p = rpcRecord(value, selected ? ['routeHostId', 'homeDirectory', 'agentWorkspace'] : ['routeHostId', 'homeDirectory'], 'CONTROL_PROTOCOL_ERROR')
    if (p.routeHostId !== input.hostId) throw new AgentMuxError('The home directory belongs to another Host route.', 'CONTROL_PROTOCOL_ERROR')
    if (!selected) return { routeHostId: input.hostId, ...parseHostEnvironment({ homeDirectory: p.homeDirectory }) } as HostSettingsResultMap[M]
    const expectedRuntimeId = typeof query.expected?.runtimeId === 'string' ? query.expected.runtimeId : undefined
    const environment = parseSelectedHostEnvironment({ homeDirectory: p.homeDirectory, agentWorkspace: p.agentWorkspace },
      { agentSessionId: query.agentSessionId! }, expectedRuntimeId)
    return { routeHostId: input.hostId, ...environment } as HostSettingsResultMap[M]
  }
  if (method === 'settings.hosts.network') {
    const result = parseHostNetworkObservation(value, input.hostId)
    const expected = (input as HostSettingsParameterMap['settings.hosts.network']).expected
    if (expected !== undefined && !isDeepStrictEqual(result.configuration, expected)) throw new AgentMuxError('Network observation returned another Host configuration.', 'CONTROL_PROTOCOL_ERROR')
    return result as HostSettingsResultMap[M]
  }
  if (method === 'settings.hosts.inspect') {
    const result = parseHostRuntimeObservation(value, input.hostId)
    const expected = (input as HostSettingsParameterMap['settings.hosts.inspect']).expected
    if (expected !== undefined && !isDeepStrictEqual(result.configuration, expected)) throw new AgentMuxError('Host observation returned another configuration.', 'CONTROL_PROTOCOL_ERROR')
    return result as HostSettingsResultMap[M]
  }
  const fail = (): never => { throw new AgentMuxError('Host settings result belongs to another Host or source.', 'CONTROL_PROTOCOL_ERROR') }
  if (isExecutorHookMethod(method)) {
    const expected = input as HostSettingsParameterMap['settings.executors.hooks-inspect']
    const protocol = 'CONTROL_PROTOCOL_ERROR'
    const p = rpcRecord(value, ['routeHostId', 'runtimeId', 'executorId', 'configRevision', 'workspacePath', 'inspection', 'health', 'canUpdate', 'update'], protocol)
    if (p.routeHostId !== expected.hostId || p.runtimeId !== expected.runtimeId || p.executorId !== expected.executorId || p.configRevision !== expected.configRevision ||
        p.workspacePath !== expected.workspacePath) fail()
    parseHookMaintenanceResult(p, method === 'settings.executors.hooks-update', fail)
    return p as HostSettingsResultMap[M]
  }
  if (isProviderHookMethod(method)) {
    const expected = input as HostSettingsParameterMap[typeof method]
    const list = method === 'settings.providers.hooks-list'
    const p = rpcRecord(value, ['routeHostId', 'runtimeId', 'workspacePath', list ? 'scopes' : 'scope'], 'CONTROL_PROTOCOL_ERROR')
    if (p.routeHostId !== expected.hostId || p.workspacePath !== expected.workspacePath ||
      typeof p.runtimeId !== 'string' || !p.runtimeId || /[\0\r\n]/u.test(p.runtimeId)) return fail()
    if (list) {
      if (!Array.isArray(p.scopes)) return fail()
      const ids = new Set<string>(), executors = new Set<string>()
      for (const value of p.scopes) {
        const scope = parseProviderHookScope(value, false, fail)
        if (ids.has(scope.scopeId) || (expected.providerId !== undefined && expected.providerId !== scope.providerId)) return fail()
        ids.add(scope.scopeId)
        for (const executor of scope.executors) {
          if (executors.has(executor.executorId)) return fail()
          executors.add(executor.executorId)
        }
      }
    } else {
      if (!('scopeId' in expected) || p.runtimeId !== expected.runtimeId) return fail()
      const scope = parseProviderHookScope(p.scope, method === 'settings.providers.hooks-update', fail)
      if (scope.providerId !== expected.providerId || scope.scopeId !== expected.scopeId || scope.scopeRevision !== expected.scopeRevision) return fail()
    }
    return p as HostSettingsResultMap[M]
  }
  if (method === 'settings.executors.discover' || method === 'settings.executors.register' || method === 'settings.executors.unregister') {
    const p = rpcRecord(value, method === 'settings.executors.discover' ? ['routeHostId', 'runtimeId', 'executors'] : method === 'settings.executors.unregister' ? ['routeHostId', 'runtimeId', 'executorId', 'removedRegistration', 'registrationRevision', 'effectiveExecutor'] : ['routeHostId', 'runtimeId', 'executor'], 'CONTROL_PROTOCOL_ERROR')
    if (p.routeHostId !== input.hostId || typeof p.runtimeId !== 'string' || !p.runtimeId || /[\0\r\n]/u.test(p.runtimeId)) fail()
    if (method === 'settings.executors.discover') {
      const inventory = parseHostExecutorInventory({ runtimeId: p.runtimeId, executors: p.executors })
      const query = input as HostSettingsParameterMap['settings.executors.discover']
      if (query.executorId !== undefined && inventory.executors.some(executor => executor.executorId !== query.executorId)) fail()
      return { routeHostId: input.hostId, ...inventory } as HostSettingsResultMap[M]
    }
    if (method === 'settings.executors.unregister') {
      const expected = input as HostSettingsParameterMap['settings.executors.unregister']
      if (p.executorId !== expected.executorId || p.removedRegistration !== true || p.registrationRevision !== expected.expectedRegistrationRevision) fail()
      const effectiveExecutor = p.effectiveExecutor === null ? null : parseHostExecutorDescriptor(p.effectiveExecutor)
      if (effectiveExecutor && (effectiveExecutor.executorId !== expected.executorId || effectiveExecutor.source === 'registered')) fail()
      return { routeHostId: input.hostId, runtimeId: p.runtimeId, executorId: p.executorId, removedRegistration: true,
        registrationRevision: p.registrationRevision, effectiveExecutor } as HostSettingsResultMap[M]
    }
    const executor = parseHostExecutorDescriptor(p.executor)
    if (executor.executorId !== (input as HostSettingsParameterMap['settings.executors.register']).executorId) fail()
    return { routeHostId: input.hostId, runtimeId: p.runtimeId, executor } as HostSettingsResultMap[M]
  }
  const p = rpcRecord(value, (method === 'settings.hosts.trust-source' || method === 'settings.hosts.trust-message-source')
    ? ['routeHostId', 'authority', 'source'] : ['routeHostId', 'authority', 'sources'], 'CONTROL_PROTOCOL_ERROR')
  if (p.routeHostId !== input.hostId) fail()
  const authority = rpcRecord(p.authority, ['runtimeId', 'publicKey', 'fingerprint'], 'CONTROL_PROTOCOL_ERROR')
  for (const key of ['runtimeId', 'publicKey', 'fingerprint']) {
    if (typeof authority[key] !== 'string' || !authority[key] || /[\0\r\n]/u.test(authority[key])) fail()
  }
  const source = (value: unknown) => {
    const messagePurpose = method === 'settings.hosts.message-trusted-sources' || method === 'settings.hosts.trust-message-source'
    const raw = value as Record<string, unknown>
    if (messagePurpose && raw?.purpose !== 'agent-message') fail()
    const { purpose: _, ...fields } = messagePurpose ? raw : {}
    const parsed = parseAgentMuxCreationTrust(messagePurpose ? fields : value)
    if (parsed.targetRuntimeId !== authority.runtimeId) fail()
    return messagePurpose ? { ...parsed, purpose: 'agent-message' as const } : parsed
  }
  if (method === 'settings.hosts.trusted-sources' || method === 'settings.hosts.message-trusted-sources') {
    if (!Array.isArray(p.sources)) fail()
    const sources = (p.sources as unknown[]).map(source)
    if (new Set(sources.map(item => item.sourceRuntimeId)).size !== sources.length) fail()
    return { routeHostId: input.hostId, authority, sources } as HostSettingsResultMap[M]
  }
  const actual = source(p.source), expected = (input as HostSettingsParameterMap['settings.hosts.trust-source']).input
  if (authority.runtimeId !== expected.targetRuntimeId || authority.fingerprint !== expected.targetKeyFingerprint) fail()
  if (actual.sourceRuntimeId !== expected.sourceRuntimeId || actual.publicKey !== expected.publicKey) fail()
  return { routeHostId: input.hostId, authority, source: actual } as HostSettingsResultMap[M]
}
