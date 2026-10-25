import type { ConnectionSetupPermissionPurpose, ConnectionSetupPermissionReview } from '@agentmux/core/connections'
import type { SetupPermissionPlan } from '../../connection-setup-adapter.js'

const messages = ['im:message:send_as_bot', 'im:message:readonly', 'im:message.group_msg', 'im:message.reactions:write_only'] as const
const groups = ['im:chat:create', 'im:chat:read', 'im:chat.members:read', 'im:chat.members:write_only'] as const
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
/** Lossless local support, not an assertion about every native scope ID representation. */
export const supportedScopeId = (value: unknown): value is string | number => typeof value === 'string' && value.length > 0 || typeof value === 'number' && Number.isSafeInteger(value)

/** Requirements belong to these actual adapter consumers, not a global permission catalog. */
export function reviewFeishuPermissions(catalogState: string, appliedState: string, _purpose: ConnectionSetupPermissionPurpose): SetupPermissionPlan {
  const required = [
    ...messages.map(name => ({ name, group: 'messages' as const })),
    ...groups.map(name => ({ name, group: 'groups' as const })),
    { name: 'application:application:self_manage', group: 'identity' as const },
    // contact.user.get needs both endpoint access and the name/avatar field permission.
    { name: 'contact:contact.base:readonly', group: 'identity' as const },
    { name: 'contact:user.base:readonly', group: 'identity' as const }
  ]
  const parse = (value: string): Record<string, unknown> | null => { try { return record(JSON.parse(value)) } catch { return null } }
  const catalog = parse(catalogState)?.scopes, applied = parse(appliedState)?.scopes
  let reason: ConnectionSetupPermissionReview['reason'] = !Array.isArray(catalog) ? 'catalog-unconfirmed' : !Array.isArray(applied) ? 'applied-unconfirmed' : undefined
  if (Array.isArray(applied) && applied.some(value => { const row = record(value); return !row || row.scopeIdentityType !== 1 && row.scopeIdentityType !== 2 || row.scopeIdentityType === 2 && !supportedScopeId(row.id) })) reason ??= 'applied-unconfirmed'
  const listsConfirmed = !reason
  const ids: Array<string | number> = [], missing: Array<string | number> = []
  const permissions = required.map(item => {
    let state: 'requested' | 'missing' | 'unknown' = 'unknown'
    if (listsConfirmed && Array.isArray(catalog) && Array.isArray(applied)) {
      const rows = catalog.map(record).filter(row => row?.name === item.name)
      const candidates = rows.filter(row => Array.isArray(row!.scopeType) && row!.scopeType.includes(2))
      const row = candidates[0]
      if (!row || rows.some(row => !Array.isArray(row!.scopeType))) reason ??= 'scope-unavailable'
      else if (candidates.length !== 1) reason ??= 'scope-ambiguous'
      else if (!supportedScopeId(row.id)) reason ??= 'unsupported-scope-id'
      else if (ids.includes(row.id) || catalog.some(value => { const other = record(value); return other !== null && other.id === row.id && other.name !== item.name && Array.isArray(other.scopeType) && other.scopeType.includes(2) })) reason ??= 'scope-ambiguous'
      else {
        ids.push(row.id)
        const matches = applied.map(record).filter(entry => entry?.id === row.id)
        const app = matches.filter(entry => entry!.scopeIdentityType === 2)
        if (app.length > 1) reason ??= 'scope-ambiguous'
        else { state = app.length ? 'requested' : 'missing'; if (!app.length) missing.push(row.id) }
      }
    }
    return { ...item, state }
  })
  return { review: { permissions, ...(reason ? { reason } : {}) }, appScopeIDs: reason ? [] : missing }
}
