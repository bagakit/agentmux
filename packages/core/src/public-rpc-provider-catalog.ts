import { isAbsolute } from 'node:path'
import { AGENT_PROVIDER_ACP_PROBE_FAILURES, type AgentProviderAcpProbe } from './agent-provider-acp-probe.js'
import { RISK_TIERS } from './risk-tier.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString } from './rpc-data.js'
import type { AgentCatalogEntry } from './types.js'
import type { LaunchOption } from './agent-launch-option.js'

export const PROVIDER_CATALOG_METHODS = { 'agent.provider.ls': 'long', 'agent.provider.probe': 'long' } as const
export type ProviderCatalogMethod = keyof typeof PROVIDER_CATALOG_METHODS
export type ProviderCatalogQuery = { hostId: string; providerId?: string }
export type ProviderCatalogObservation = {
  routeHostId: string
  /** Semantic owner identity when confirmed; absence does not hide declarations. */
  runtimeId: string | null
  observedAt: number
  catalog: AgentCatalogEntry[]
}
export type ProviderProbeTarget = { runtimeId: string; executorId: string; configRevision: string; workspacePath: string }
export type ProviderProbeQuery = ProviderProbeTarget & { hostId: string }
export type ProviderProbeObservation = AgentProviderAcpProbe & ProviderProbeTarget & { routeHostId: string; providerId: string }
export type ProviderCatalogParamsMap = { 'agent.provider.ls': ProviderCatalogQuery; 'agent.provider.probe': ProviderProbeQuery }
export type ProviderCatalogResultMap = { 'agent.provider.ls': ProviderCatalogObservation; 'agent.provider.probe': ProviderProbeObservation }
export function parseProviderCatalogQuery(value: unknown): ProviderCatalogQuery {
  const p = rpcRecord(value, ['hostId', 'providerId'])
  return { hostId: rpcString(p.hostId, 'Exact route Host ID'),
    ...(p.providerId === undefined ? {} : { providerId: rpcString(p.providerId, 'Provider ID') }) }
}

export function parseProviderProbeQuery(value: unknown): ProviderProbeQuery {
  const p = rpcRecord(value, ['hostId', 'runtimeId', 'executorId', 'configRevision', 'workspacePath'])
  const workspacePath = rpcString(p.workspacePath, 'Original workspace directory')
  if (!isAbsolute(workspacePath)) throw new AgentMuxError('Choose an absolute workspace directory on the original Host.', 'INVALID_CONTROL_REQUEST')
  return { hostId: rpcString(p.hostId, 'Exact route Host ID'), runtimeId: rpcString(p.runtimeId, 'Original Runtime ID'),
    executorId: rpcString(p.executorId, 'Original Executor ID'), configRevision: rpcString(p.configRevision, 'Original Executor revision'), workspacePath }
}

export function parseProviderProbeObservation(value: unknown, query: ProviderProbeQuery): ProviderProbeObservation {
  const p = rpcRecord(value, ['routeHostId', 'runtimeId', 'executorId', 'configRevision', 'workspacePath', 'providerId', 'handshake', 'service'], 'CONTROL_PROTOCOL_ERROR')
  if (p.routeHostId !== query.hostId || p.runtimeId !== query.runtimeId || p.executorId !== query.executorId ||
      p.configRevision !== query.configRevision || p.workspacePath !== query.workspacePath) probeInvalid()
  wireString(p.providerId)
  let lists = false
  if (p.handshake !== null) {
    const handshake = rpcRecord(p.handshake, ['protocolVersion', 'sessions', 'prompt'], 'CONTROL_PROTOCOL_ERROR')
    if (handshake.protocolVersion !== 1) probeInvalid()
    const sessions = requireFlags(handshake.sessions, ['list', 'load', 'resume', 'close', 'additionalDirectories'])
    requireFlags(handshake.prompt, ['image', 'audio', 'embeddedContext'])
    lists = sessions.list === true
  }
  const service = rpcRecord(p.service, ['state', 'stage', 'reason', 'rpcCode'], 'CONTROL_PROTOCOL_ERROR')
  switch (service.state) {
    case 'unsupported':
      if (service.stage !== (p.handshake === null ? 'provider' : 'session/list') || lists || Object.keys(service).length !== 2) probeInvalid()
      break
    case 'ready':
      if (!lists || service.stage !== 'session/list' || Object.keys(service).length !== 2) probeInvalid()
      break
    case 'authentication-required':
      if (!lists || service.stage !== 'session/list' || service.rpcCode !== -32000 || Object.keys(service).length !== 3) probeInvalid()
      break
    case 'unconfirmed':
      if (p.handshake === null ? service.stage !== 'launch' && service.stage !== 'initialize' : !lists || service.stage !== 'session/list') probeInvalid()
      if (!AGENT_PROVIDER_ACP_PROBE_FAILURES.includes(service.reason as typeof AGENT_PROVIDER_ACP_PROBE_FAILURES[number]) ||
          (service.reason === 'rpc-error' ? !Number.isSafeInteger(service.rpcCode) : Object.hasOwn(service, 'rpcCode'))) probeInvalid()
      break
    default: probeInvalid()
  }
  return structuredClone(p) as unknown as ProviderProbeObservation
}

function requireFlags(value: unknown, keys: string[]): Record<string, unknown> {
  const p = rpcRecord(value, keys, 'CONTROL_PROTOCOL_ERROR')
  if (keys.some(key => typeof p[key] !== 'boolean')) probeInvalid()
  return p
}

function probeInvalid(): never {
  throw new AgentMuxError('The original Host returned an invalid or mismatched ACP probe observation.', 'CONTROL_PROTOCOL_ERROR')
}

/** Validate the DESCRIBE projection, never private launch/keystroke declarations. */
function catalogEntry(value: unknown): AgentCatalogEntry {
  const p = rpcRecord(value, ['id', 'label', 'executable', 'expectedProcess', 'promptDelivery', 'readySignal', 'hookStrategy', 'resumeStrategy', 'acpStrategy', 'capabilities', 'launchOptions', 'postureControl', 'composer'], 'CONTROL_PROTOCOL_ERROR')
  for (const key of ['id', 'label', 'executable', 'expectedProcess']) wireString(p[key])
  if (!['positional-argv', 'hermes-query', 'flag-prompt-interactive', 'post-launch-only'].includes(p.promptDelivery as string)) invalid()
  rpcRecord(p.readySignal, ['kind', 'expectedProcess'], 'CONTROL_PROTOCOL_ERROR')
  rpcRecord(p.hookStrategy, ['kind', 'installation'], 'CONTROL_PROTOCOL_ERROR')
  rpcRecord(p.resumeStrategy, ['kind', 'locator'], 'CONTROL_PROTOCOL_ERROR')
  rpcRecord(p.acpStrategy, ['kind'], 'CONTROL_PROTOCOL_ERROR')
  rpcRecord(p.capabilities, ['terminal', 'timeline', 'permission', 'providerResume', 'turnOutcomes', 'nativeInterruption', 'providerFork', 'replyCorrelation', 'asyncQuestionReply', 'promptExecution', 'nativeConversationInput', 'usage'], 'CONTROL_PROTOCOL_ERROR')
  parseProviderLaunchOptions(p.launchOptions)
  if (p.postureControl !== undefined) {
    const control = rpcRecord(p.postureControl, ['id', 'label', 'modes'], 'CONTROL_PROTOCOL_ERROR')
    wireString(control.id); wireString(control.label)
    if (!Array.isArray(control.modes)) invalid()
    control.modes.forEach(parseChoice)
  }
  if (p.composer !== undefined) {
    const composer = rpcRecord(p.composer, ['skillRoots', 'commands'], 'CONTROL_PROTOCOL_ERROR')
    if (!Array.isArray(composer.skillRoots) || composer.skillRoots.some(v => typeof v !== 'string') || !Array.isArray(composer.commands)) invalid()
    for (const item of composer.commands) {
      const command = rpcRecord(item, ['text', 'description'], 'CONTROL_PROTOCOL_ERROR')
      if (typeof command.text !== 'string' || typeof command.description !== 'string') invalid()
    }
  }
  return structuredClone(p) as unknown as AgentCatalogEntry
}
function parseChoice(value: unknown): void {
  const c = rpcRecord(value, ['id', 'label', 'description', 'tier'], 'CONTROL_PROTOCOL_ERROR')
  wireString(c.id); wireString(c.label)
  if (c.description !== undefined && typeof c.description !== 'string' || c.tier !== undefined && !RISK_TIERS.includes(c.tier as typeof RISK_TIERS[number])) invalid()
}
/** Shared safe DESCRIBE codec; never accepts private argv or environment. */
export function parseProviderLaunchOptions(value: unknown): LaunchOption[] {
  if (!Array.isArray(value)) invalid()
  for (const item of value) {
    const option = rpcRecord(item, ['id', 'label', 'description', 'choices'], 'CONTROL_PROTOCOL_ERROR')
    wireString(option.id); wireString(option.label)
    if (option.description !== undefined && typeof option.description !== 'string' || !Array.isArray(option.choices)) invalid()
    option.choices.forEach(parseChoice)
  }
  return structuredClone(value) as LaunchOption[]
}
function wireString(value: unknown): string { try { return rpcString(value, 'Provider declaration') } catch { return invalid() } }
function invalid(): never { throw new AgentMuxError('The original Host returned invalid Provider declarations.', 'CONTROL_PROTOCOL_ERROR') }
export function parseProviderCatalogObservation(value: unknown, query: ProviderCatalogQuery): ProviderCatalogObservation {
  const p = rpcRecord(value, ['routeHostId', 'runtimeId', 'observedAt', 'catalog'], 'CONTROL_PROTOCOL_ERROR')
  if (p.routeHostId !== query.hostId || !Number.isSafeInteger(p.observedAt) || (p.observedAt as number) < 0 || !Array.isArray(p.catalog)) invalid()
  if (p.runtimeId !== null) wireString(p.runtimeId)
  const catalog = p.catalog.map(catalogEntry)
  if (new Set(catalog.map(entry => entry.id)).size !== catalog.length || query.providerId !== undefined && catalog.some(entry => entry.id !== query.providerId)) invalid()
  return { routeHostId: query.hostId, runtimeId: p.runtimeId as string | null, observedAt: p.observedAt as number, catalog }
}
