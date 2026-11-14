import { RISK_TIERS } from './risk-tier.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString } from './rpc-data.js'
import type { AgentCatalogEntry } from './types.js'

export const PROVIDER_CATALOG_METHODS = { 'agent.provider.ls': 'long' } as const
export type ProviderCatalogMethod = keyof typeof PROVIDER_CATALOG_METHODS
export type ProviderCatalogQuery = { hostId: string; providerId?: string }
export type ProviderCatalogObservation = {
  routeHostId: string
  /** Semantic owner identity when confirmed; absence does not hide declarations. */
  runtimeId: string | null
  observedAt: number
  catalog: AgentCatalogEntry[]
}
export type ProviderCatalogParamsMap = { 'agent.provider.ls': ProviderCatalogQuery }
export type ProviderCatalogResultMap = { 'agent.provider.ls': ProviderCatalogObservation }
export function parseProviderCatalogQuery(value: unknown): ProviderCatalogQuery {
  const p = rpcRecord(value, ['hostId', 'providerId'])
  return { hostId: rpcString(p.hostId, 'Exact route Host ID'),
    ...(p.providerId === undefined ? {} : { providerId: rpcString(p.providerId, 'Provider ID') }) }
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
  const choice = (value: unknown) => {
    const c = rpcRecord(value, ['id', 'label', 'description', 'tier'], 'CONTROL_PROTOCOL_ERROR')
    wireString(c.id); wireString(c.label)
    if (c.description !== undefined && typeof c.description !== 'string' || c.tier !== undefined && !RISK_TIERS.includes(c.tier as typeof RISK_TIERS[number])) invalid()
  }
  if (!Array.isArray(p.launchOptions)) invalid()
  for (const value of p.launchOptions) {
    const option = rpcRecord(value, ['id', 'label', 'description', 'choices'], 'CONTROL_PROTOCOL_ERROR')
    wireString(option.id); wireString(option.label)
    if (!Array.isArray(option.choices)) invalid()
    option.choices.forEach(choice)
  }
  if (p.postureControl !== undefined) {
    const control = rpcRecord(p.postureControl, ['id', 'label', 'modes'], 'CONTROL_PROTOCOL_ERROR')
    wireString(control.id); wireString(control.label)
    if (!Array.isArray(control.modes)) invalid()
    control.modes.forEach(choice)
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
