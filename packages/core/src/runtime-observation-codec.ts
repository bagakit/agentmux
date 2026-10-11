import { AgentMuxError } from './errors.js'
import type { AgentMuxRuntimeIdentity, AgentMuxRuntimeDiagnostics, AgentMuxRuntimeResourceSnapshot } from './types.js'

/** Shared leaves for public Runtime, Hosted and resource observations. */
function invalid(): never { throw new AgentMuxError('Runtime observation is malformed.', 'CONTROL_PROTOCOL_ERROR') }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid()
  return value as Record<string, unknown>
}
function identity(value: unknown): void { if (typeof value !== 'string' || !value) invalid() }
function count(value: unknown): void { if (!Number.isSafeInteger(value) || (value as number) < 0) invalid() }
export function parseRuntimeIdentity(value: unknown): AgentMuxRuntimeIdentity {
  const p = record(value, ['hostId', 'ownership', 'buildIdentity', 'protocolVersion', 'processId', 'instanceId'])
  for (const key of ['hostId', 'buildIdentity', 'instanceId']) identity(p[key])
  count(p.protocolVersion); if (p.processId !== null) count(p.processId)
  if (p.ownership !== undefined && p.ownership !== 'owned' && p.ownership !== 'unverified') invalid()
  return value as AgentMuxRuntimeIdentity
}
export function parseRuntimeDiagnostics(value: unknown): AgentMuxRuntimeDiagnostics {
  const p = record(value, ['nodeVersion', 'platform', 'arch', 'supported', 'ctxmux'])
  for (const key of ['nodeVersion', 'platform', 'arch']) identity(p[key])
  if (typeof p.supported !== 'boolean') invalid()
  const ctx = record(p.ctxmux, ['state', 'serving', 'bundled', 'ready', 'capabilities'])
  const state = record(ctx.state, ['configuredDirectory', 'servingDirectory'])
  identity(state.configuredDirectory); if (state.servingDirectory !== null) identity(state.servingDirectory)
  const serving = record(ctx.serving, ['buildIdentity', 'protocolVersion', 'instanceId', 'sourceCommit'])
  identity(serving.buildIdentity); identity(serving.instanceId); count(serving.protocolVersion)
  if (serving.sourceCommit !== null || typeof ctx.ready !== 'boolean') invalid()
  const bundled = record(ctx.bundled, ['version', 'sourceCommit', 'artifactPlatform'])
  for (const key of ['version', 'sourceCommit', 'artifactPlatform']) identity(bundled[key])
  const capabilities = record(ctx.capabilities, ['transport', 'orderedOutputBytes', 'boundedReplay', 'recoverableInput', 'resize', 'interrupt', 'completeStop'])
  if (capabilities.transport !== 'local-unix') invalid()
  for (const key of ['orderedOutputBytes', 'boundedReplay', 'recoverableInput', 'resize', 'interrupt', 'completeStop']) if (capabilities[key] !== true) invalid()
  return value as AgentMuxRuntimeDiagnostics
}
export function parseRuntimeResources(value: unknown): AgentMuxRuntimeResourceSnapshot {
  const p = record(value, ['observedAt', 'runCount', 'runningRuns', 'terminatedRuns', 'terminatedUnattachedRuns', 'attachments', 'retainedOutputBytes'])
  for (const key of ['observedAt', 'runCount', 'runningRuns', 'terminatedRuns', 'terminatedUnattachedRuns', 'attachments', 'retainedOutputBytes']) count(p[key])
  if ((p.runningRuns as number) + (p.terminatedRuns as number) !== p.runCount || (p.terminatedUnattachedRuns as number) > (p.terminatedRuns as number)) invalid()
  return value as AgentMuxRuntimeResourceSnapshot
}
