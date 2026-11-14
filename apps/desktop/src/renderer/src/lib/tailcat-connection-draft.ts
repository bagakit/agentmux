import type { HostConfig } from '../../../shared/contracts'
import { configValuesEqual } from '../../../shared/config-edit'

export type TailcatConnectionDraft = { value: HostConfig; expected?: HostConfig; allowedText?: string; retained?: unknown[] }
export type TailcatDraftScope = 'hosts' | 'incoming'
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v))
export function tailcatDraftRecord(value: unknown): Record<string, unknown> | null { return value === undefined ? {} : object(value) ? value : null }
export function tailcatConnectionDraft(value: unknown): TailcatConnectionDraft | null {
  if (!object(value) || !object(value.value) || typeof value.value.id !== 'string' || typeof value.value.label !== 'string' || !['local', 'ssh'].includes(String(value.value.kind))) return null
  if (value.expected !== undefined && (!object(value.expected) || value.expected.id !== value.value.id || value.expected.kind !== value.value.kind)) return null
  if (value.allowedText !== undefined && typeof value.allowedText !== 'string') return null
  if (value.retained !== undefined && !Array.isArray(value.retained)) return null
  for (const host of [value.value, value.expected]) {
    if (!object(host) || host.tailcat === undefined) continue
    const t = host.tailcat
    if (!object(t) || typeof t.keyFile !== 'string' || (host.kind === 'local'
      ? typeof t.enabled !== 'boolean' || !Array.isArray(t.allowedClients) || !t.allowedClients.every(k => typeof k === 'string')
      : typeof t.address !== 'string')) return null
  }
  return value as TailcatConnectionDraft
}
const route = (host: HostConfig) => {
  if (host.kind === 'local') return { id: host.id, kind: host.kind }
  return { id: host.id, kind: host.kind, hostname: host.hostname, user: host.user, port: host.port, transport: host.transport,
    runtimeId: host.runtimeId, identityFile: host.identityFile, remoteCommand: host.remoteCommand, remoteSocketPath: host.remoteSocketPath, address: host.tailcat?.address }
}
export function tailcatDraftMatchesSaved(entry: TailcatConnectionDraft, saved: HostConfig | undefined): boolean {
  return entry.expected ? Boolean(saved && configValuesEqual(route(entry.expected), route(saved))) : saved === undefined
}
export function isTailcatDraftHost(host: HostConfig | undefined): boolean {
  return Boolean(host && (host.tailcat !== undefined || host.kind === 'ssh' && host.transport === 'tailcat'))
}
