import { AgentMuxError } from './errors.js'

export type AgentMuxCreationSource = { runtimeId: string; agentSessionId: string; runId: string }
export type AgentMuxCreationTarget = { runtimeId: string; intentDigest: string }
export type AgentMuxCreationAuthorityIdentity = { runtimeId: string; publicKey: string; fingerprint: string }
export type AgentMuxCreationUserPrincipal = { kind: 'user'; id: string }
export type AgentMuxCreationTrustInput = {
  sourceRuntimeId: string
  publicKey: string
  targetRuntimeId: string
  targetKeyFingerprint: string
}
export type AgentMuxCreationTrust = {
  sourceRuntimeId: string
  publicKey: string
  fingerprint: string
  targetRuntimeId: string
  registeredAt: number
  registeredBy: AgentMuxCreationUserPrincipal
}
export type AgentMuxCreationAdmission = {
  schema: 'agentmux.agent-creation-admission.v1'
  source: AgentMuxCreationSource
  target: AgentMuxCreationTarget
  signature: string
}
export type AgentMuxCreationOrigin = {
  source: AgentMuxCreationSource
  proofFingerprint: string
  verifiedBy: { runtimeId: string; keyFingerprint: string }
  delegatedBy: AgentMuxCreationTrust
}

function invalid(): never {
  throw new AgentMuxError('Invalid Agent creation provenance structure.', 'AGENT_CREATION_PROVENANCE_INVALID')
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const result = value as Record<string, unknown>
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) invalid()
  return result
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 256 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) invalid()
  return value
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) invalid()
  return value
}
export function parseAgentMuxCreationTrustInput(value: unknown): AgentMuxCreationTrustInput {
  const p = record(value, ['sourceRuntimeId', 'publicKey', 'targetRuntimeId', 'targetKeyFingerprint'])
  if (typeof p.publicKey !== 'string' || !p.publicKey) invalid()
  return { sourceRuntimeId: text(p.sourceRuntimeId), publicKey: p.publicKey,
    targetRuntimeId: text(p.targetRuntimeId), targetKeyFingerprint: digest(p.targetKeyFingerprint) }
}
function source(value: unknown): AgentMuxCreationSource {
  const p = record(value, ['runtimeId', 'agentSessionId', 'runId'])
  return { runtimeId: text(p.runtimeId), agentSessionId: text(p.agentSessionId), runId: text(p.runId) }
}

/** Wire/store validation only; source authentication requires the authority's verify method. */
export function parseAgentMuxCreationAdmission(value: unknown): AgentMuxCreationAdmission {
  const p = record(value, ['schema', 'source', 'target', 'signature'])
  const target = record(p.target, ['runtimeId', 'intentDigest'])
  if (p.schema !== 'agentmux.agent-creation-admission.v1' || typeof p.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/u.test(p.signature)) invalid()
  return { schema: p.schema, source: source(p.source),
    target: { runtimeId: text(target.runtimeId), intentDigest: digest(target.intentDigest) }, signature: p.signature }
}

/** Public keys are canonical SPKI DER encoded as base64url; no private material belongs here. */
export function parseAgentMuxCreationTrust(value: unknown): AgentMuxCreationTrust {
  const p = record(value, ['sourceRuntimeId', 'publicKey', 'fingerprint', 'targetRuntimeId', 'registeredAt', 'registeredBy'])
  const principal = record(p.registeredBy, ['kind', 'id'])
  if (principal.kind !== 'user' || typeof p.publicKey !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/u.test(p.publicKey) ||
    typeof p.registeredAt !== 'number' || !Number.isSafeInteger(p.registeredAt) || p.registeredAt < 0) invalid()
  return { sourceRuntimeId: text(p.sourceRuntimeId), publicKey: p.publicKey, fingerprint: digest(p.fingerprint),
    targetRuntimeId: text(p.targetRuntimeId), registeredAt: p.registeredAt, registeredBy: { kind: 'user', id: text(principal.id) } }
}

/** Preserve the original verified source and explicit user delegation in durable creation receipts. */
export function parseAgentMuxCreationOrigin(value: unknown): AgentMuxCreationOrigin {
  const p = record(value, ['source', 'proofFingerprint', 'verifiedBy', 'delegatedBy'])
  const verified = record(p.verifiedBy, ['runtimeId', 'keyFingerprint'])
  const origin = { source: source(p.source), proofFingerprint: digest(p.proofFingerprint),
    verifiedBy: { runtimeId: text(verified.runtimeId), keyFingerprint: digest(verified.keyFingerprint) },
    delegatedBy: parseAgentMuxCreationTrust(p.delegatedBy) }
  if (origin.source.runtimeId !== origin.verifiedBy.runtimeId || origin.source.runtimeId !== origin.delegatedBy.sourceRuntimeId ||
    origin.verifiedBy.keyFingerprint !== origin.delegatedBy.fingerprint) invalid()
  return origin
}
