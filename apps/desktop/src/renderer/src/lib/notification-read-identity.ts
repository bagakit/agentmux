import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'

type ReadReceipts = Record<string, Record<string, string>>
type Fingerprint = [string | null, string, unknown]
const compact = (value: string) => /^sha256:[a-f0-9]{64}$/u.test(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Hash the complete canonical identity; a compact identity is already its final representation. */
export function compactNotificationIdentity(rawCanonical: string): string {
  return compact(rawCanonical) ? rawCanonical : `sha256:${bytesToHex(sha256(utf8ToBytes(rawCanonical)))}`
}

/** Owner keys contain original spatial or execution identities, never display labels. */
export function ownedNotificationIdentity(ownerKey: string, kind: string, normalizedReason: string): string {
  return compactNotificationIdentity(JSON.stringify([kind, ownerKey, normalizedReason]))
}

function parse(value: string): unknown {
  try { return JSON.parse(value) } catch { return undefined }
}
function tuple(value: unknown, length: number): unknown[] | undefined {
  const parsed = typeof value === 'string' ? parse(value) : value
  return Array.isArray(parsed) && parsed.length === length ? parsed : undefined
}
function fingerprint(value: string): Fingerprint | undefined {
  const parsed = tuple(value, 3)
  return parsed && (parsed[0] === null || typeof parsed[0] === 'string') && nonempty(parsed[1])
    ? parsed as Fingerprint : undefined
}
function normalizedFingerprint(value: string, item: Fingerprint | undefined): string {
  if (!item) return value
  return JSON.stringify([item[0], item[1], compactNotificationIdentity(
    typeof item[2] === 'string' ? item[2] : JSON.stringify(item[2]))])
}
function lifecycleCause(value: unknown): [string, string] | undefined {
  const cause = tuple(value, 2)
  return cause && (cause[0] === 'launch' || cause[0] === 'resume') && typeof cause[1] === 'string'
    ? cause as [string, string] : undefined
}
function subjectOwner(subject: unknown): string | undefined {
  if (!record(subject) || subject.kind !== 'agent' || !nonempty(subject.hostId) || !nonempty(subject.agentSessionId) ||
    !record(subject.run) || !nonempty(subject.run.runId)) return undefined
  return JSON.stringify(['resume', subject.hostId, subject.agentSessionId, subject.run.runId])
}
function localOwner(scope: string): string | undefined {
  const owner = parse(scope.slice('local:lifecycle:'.length))
  if (!record(owner)) return undefined
  if (Object.keys(owner).length === 1 && nonempty(owner.regionId)) return JSON.stringify(['launch', owner.regionId])
  return Object.keys(owner).length === 1 ? subjectOwner(owner.subject) : undefined
}
function legacyCanonical(value: unknown): unknown[] | undefined {
  const item = tuple(value, 10)
  if (!item || !['healthy', 'agent-broken', 'process-degraded', 'indeterminate'].includes(item[0] as string) ||
    typeof item[9] !== 'string' || ![1, 2, 3, 4, 5].every(index => item[index] === null || typeof item[index] === 'string') ||
    !(item[6] === null || record(item[6])) || !(item[7] === null || Array.isArray(item[7]) && item[7].every(nonempty)) ||
    !(item[8] === null || item[8] === 'provider-catalog')) return undefined
  if (item[3] === null) return item[2] === null && item[4] === null && item[5] === null ? item : undefined
  if (!nonempty(item[2]) || !nonempty(item[5])) return undefined
  return item[3] === 'agent' && nonempty(item[4]) || item[3] === 'terminal' && item[4] === null ? item : undefined
}
function nativeRead(value: unknown): string | undefined {
  const item = legacyCanonical(value)
  if (!item || item[1] !== 'AGENT_NATIVE_IDENTITY_UNCONFIRMED' || item[3] !== 'agent' ||
    item[6] !== null || item[7] !== null || item[8] !== null) return undefined
  const owner = JSON.stringify(['AGENT_NATIVE_IDENTITY_UNCONFIRMED', item[2], item[4], item[5]])
  return ownedNotificationIdentity(owner, item[0] as string, item[9] as string)
}
function sessionRecovery(scope: string, id: string, item: Fingerprint): string | undefined {
  const occurrence = tuple(item[0], 3), cause = lifecycleCause(item[2])
  if (item[1] !== 'indeterminate' || !occurrence?.every(nonempty) || cause?.[0] !== 'resume') return undefined
  if (scope === 'global:sessions') {
    const address = tuple(id, 3)
    if (!address || address[0] !== occurrence[0] || address[1] !== occurrence[1] || address[2] !== 'recovery') return undefined
  } else if (id !== 'recovery' || scope !== occurrence[1]) return undefined
  return JSON.stringify(['resume', ...occurrence])
}

/** Normalize once at hydration. Only complete original machine structures can confer a typed read. */
export function normalizeNotificationReadReceipts(receipts: unknown): ReadReceipts {
  if (!record(receipts)) return {}
  const scopes = new Map<string, Map<string, string>>()
  const events = new Map<string, string>()
  const local = new Map<string, string>()
  for (const [scope, values] of Object.entries(receipts)) {
    if (!record(values)) continue
    const retained = new Map<string, string>()
    for (const [id, value] of Object.entries(values)) {
      if (typeof value !== 'string') continue
      if (scope === 'global:events') {
        if (compact(id) && value === 'read') events.set(id, 'read')
        else if (value === id) {
          const canonical = legacyCanonical(id)
          if (canonical) events.set(nativeRead(canonical) ?? compactNotificationIdentity(id), 'read')
        }
        continue
      }
      const item = fingerprint(value)
      if (scope === 'global:workflow' && id === 'current' && item?.[0] === null && item[1] === 'indeterminate') {
        const identity = nativeRead(item[2])
        if (identity) { events.set(identity, 'read'); continue }
      }
      const cause = item && lifecycleCause(item[2])
      if (scope === 'global:sessions' && item && cause) {
        const launch = tuple(id, 2)
        const owner = launch?.[0] === 'launch' && nonempty(launch[1]) && item[0] === null && item[1] === 'indeterminate' && cause[0] === 'launch'
          ? JSON.stringify(launch) : sessionRecovery(scope, id, item)
        if (owner) { events.set(ownedNotificationIdentity(owner, item[1], cause[1]), 'read'); continue }
      }
      if (scope.startsWith('local:lifecycle:') && id === 'lifecycle' && item && cause) {
        const owner = localOwner(scope)
        if (owner && tuple(owner, cause[0] === 'launch' ? 2 : 4)?.[0] === cause[0] && item[0] === null && item[1] === 'indeterminate') {
          local.set(`local:lifecycle:${owner}`, JSON.stringify([null, item[1], ownedNotificationIdentity(owner, item[1], cause[1])]))
          continue
        }
      }
      const recovery = item && cause && sessionRecovery(scope, id, item)
      if (recovery && scope !== 'global:sessions') {
        local.set(`local:lifecycle:${recovery}`, JSON.stringify([null, item![1], ownedNotificationIdentity(recovery, item![1], cause![1])]))
        continue
      }
      retained.set(id, normalizedFingerprint(value, item))
    }
    if (retained.size) scopes.set(scope, retained)
  }
  if (events.size) scopes.set('global:events', events)
  for (const [scope, value] of local) {
    const retained = scopes.get(scope) ?? new Map<string, string>()
    // An already canonical receipt takes precedence over an older alias of that same owner.
    if (!retained.has('lifecycle')) retained.set('lifecycle', value)
    scopes.set(scope, retained)
  }
  return Object.fromEntries([...scopes].map(([scope, values]) => [scope, Object.fromEntries(values)]))
}
