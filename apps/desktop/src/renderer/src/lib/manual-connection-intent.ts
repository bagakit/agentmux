import type { ConnectionConfigureInput } from '@agentmux/core/connections'
import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { restoredApplicationAccess, type ApplicationAccessContinuation } from './application-member-intent'

export type ManualConnectionDraft = {
  view: 'library' | 'new' | 'edit' | 'saved'
  selectedConnectionId?: string
  label: string
  appId: string
  domain: string
  enabled: boolean
}
/** UI request continuation only. No secret or owner receipt is retained here. */
export type ManualConnectionIntent = {
  channel: 'lark' | 'discord'
  target: ConnectionHostingTarget | null
  draft: ManualConnectionDraft
  /** An empty credentialRef means the original credential operation remains unconfirmed. */
  pending?: ConnectionConfigureInput
  applicationAccess?: ApplicationAccessContinuation
}
export const manualConnectionScope = (channel: ManualConnectionIntent['channel'], target: ConnectionHostingTarget | null) => JSON.stringify([channel, target?.hostId ?? null, target?.runtimeId ?? null])
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
const text = (value: unknown): value is string => typeof value === 'string' && !/[\0\r\n]/u.test(value)
const targetId = (value: unknown): value is string => text(value) && !!value.trim()
export function restoredManualConnectionSelections(value: unknown): Partial<Record<'lark' | 'discord', ConnectionHostingTarget | null>> {
  const result: Partial<Record<'lark' | 'discord', ConnectionHostingTarget | null>> = {}
  if (!record(value)) return result
  for (const channel of ['lark','discord'] as const) {
    const target = value[channel]
    if (target === null) result[channel] = null
    else if (record(target) && targetId(target.hostId) && targetId(target.runtimeId)) result[channel] = { hostId: target.hostId, runtimeId: target.runtimeId }
  }
  return result
}
export function restoredManualConnectionIntents(value: unknown): Record<string, ManualConnectionIntent> {
  const result: Record<string, ManualConnectionIntent> = {}
  if (!record(value)) return result
  for (const [key, raw] of Object.entries(value)) {
    if (!record(raw) || raw.channel !== 'lark' && raw.channel !== 'discord') continue
    const t = raw.target, d = raw.draft
    if (t !== null && (!record(t) || !targetId(t.hostId) || !targetId(t.runtimeId))) continue
    const target = t === null ? null : { hostId: t.hostId as string, runtimeId: t.runtimeId as string }
    if (key !== manualConnectionScope(raw.channel, target) || !record(d) || !['library','new','edit','saved'].includes(String(d.view)) ||
      !text(d.label) || !text(d.appId) || !text(d.domain) || typeof d.enabled !== 'boolean' || d.selectedConnectionId !== undefined && !id(d.selectedConnectionId)) continue
    const draft: ManualConnectionDraft = { view: d.view as ManualConnectionDraft['view'], label: d.label, appId: d.appId, domain: d.domain, enabled: d.enabled,
      ...(d.selectedConnectionId === undefined ? {} : { selectedConnectionId: d.selectedConnectionId }) }
    let pending: ConnectionConfigureInput | undefined
    if (raw.pending !== undefined) {
      const p = raw.pending
      if (!record(p) || !id(p.operationId) || p.expectedRevision !== null && (!Number.isSafeInteger(p.expectedRevision) || (p.expectedRevision as number) < 1) || !record(p.connection)) continue
      const c = p.connection, a = c.application
      if (!id(c.connectionId) || !id(c.adapterId) || !record(a) || !text(a.domain) || !a.domain || !text(a.appId) || !a.appId || !text(c.label) || !c.label || typeof c.enabled !== 'boolean' || !text(c.credentialRef)) continue
      pending = { operationId: p.operationId, expectedRevision: p.expectedRevision as number | null, connection: {
        connectionId: c.connectionId, adapterId: c.adapterId, application: { domain: a.domain, appId: a.appId }, label: c.label, enabled: c.enabled, credentialRef: c.credentialRef } }
    }
    result[key] = { channel: raw.channel, target, draft, ...(pending ? { pending } : {}), ...(raw.applicationAccess ? { applicationAccess: restoredApplicationAccess(raw.applicationAccess) } : {}) }
  }
  return result
}
