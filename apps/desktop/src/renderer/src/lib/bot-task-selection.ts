import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { readConnectionHostingTarget } from '../../../shared/connection-hosting-target'
import { sameConnectionApplication, type ConnectionRecord } from '@agentmux/core/connections'
import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'

export type ManagementTaskScope = { kind: 'management'; connectionId: string; adapterId: string; domain: string; appId: string; issuer?: string }
export type IdentityRemovalTaskScope = { kind: 'identity-removal'; connectionId: string; adapterId: string; domain: string; appId: string; issuer?: string; expectedRevision: number; hostingTarget?: ConnectionHostingTarget }
export type BotTaskScope = { kind: 'mote'; target: MotePreferencesTarget } | { kind: 'enrollment' } | ManagementTaskScope | IdentityRemovalTaskScope | { kind: 'management-route' }
/** Presentation locators only. Original owners retain every outcome and private view. */
export type BotTaskLocator = { operationId: string; hostingTarget: ConnectionHostingTarget }
export type BotTaskSelections = Record<string, string | BotTaskLocator>

/** Old string locators retain their exact operation without inventing a hosting owner. */
export function readBotTaskLocator(value: unknown): { operationId: string; hostingTarget: ConnectionHostingTarget | null } | null {
  if (typeof value === 'string' && value.trim()) return { operationId: value, hostingTarget: null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>, hostingTarget = readConnectionHostingTarget(row.hostingTarget)
  return Object.keys(row).every(key => key === 'operationId' || key === 'hostingTarget') && typeof row.operationId === 'string' && !!row.operationId.trim() && hostingTarget
    ? { operationId: row.operationId, hostingTarget } : null
}

export function botTaskSelectionKey(scope: BotTaskScope): string {
  if (scope.kind === 'enrollment') return 'enrollment'
  if (scope.kind === 'management-route') return 'management'
  if (scope.kind === 'identity-removal') return JSON.stringify(['identity-removal', scope.connectionId, scope.adapterId, scope.domain, scope.appId, scope.expectedRevision, ...(scope.hostingTarget ? [scope.hostingTarget.hostId, scope.hostingTarget.runtimeId] : []), ...(scope.issuer === undefined ? [] : [{ issuer: scope.issuer }])])
  if (scope.kind === 'management') return JSON.stringify(['management', scope.connectionId, scope.adapterId, scope.domain, scope.appId, ...(scope.issuer === undefined ? [] : [{ issuer: scope.issuer }])])
  const target = scope.target
  return JSON.stringify(['mote', target.spaceId, target.zoneId, target.expectedResource.hostId, target.expectedResource.workspaceId, target.expectedResource.workspacePath])
}

/** Exact removal input locator, never a deletion result or a replacement revision. */
export function retainedIdentityRemovalTasks(selections: BotTaskSelections): Array<{ scope: IdentityRemovalTaskScope; operationId: string; hostingTarget: ConnectionHostingTarget | null }> {
  const result: Array<{ scope: IdentityRemovalTaskScope; operationId: string; hostingTarget: ConnectionHostingTarget | null }> = []
  for (const [key, value] of Object.entries(selections)) {
    try {
      const locator = readBotTaskLocator(value)
      if (!locator) continue
      const { operationId } = locator
      const parts: unknown = JSON.parse(key)
      if (!Array.isArray(parts)) continue
      const last = parts.at(-1), issuer = last && typeof last === 'object' && !Array.isArray(last) && typeof last.issuer === 'string' && last.issuer ? last.issuer : undefined
      if (issuer !== undefined) parts.pop()
      if ((parts.length !== 6 && parts.length !== 8) || parts[0] !== 'identity-removal' || !parts.slice(1, 5).every(value => typeof value === 'string' && value.trim()) || !Number.isSafeInteger(parts[5]) || parts[5] < 1) continue
      const [, connectionId, adapterId, domain, appId, expectedRevision] = parts as [string, string, string, string, string, number]
      const scopeOwner = parts.length === 8 ? readConnectionHostingTarget({ hostId: parts[6], runtimeId: parts[7] }) : null
      if (parts.length === 8 && (!scopeOwner || JSON.stringify(scopeOwner) !== JSON.stringify(locator.hostingTarget))) continue
      result.push({ scope: { kind: 'identity-removal', connectionId, adapterId, domain, appId, expectedRevision, ...(scopeOwner ? { hostingTarget: scopeOwner } : {}), ...(issuer === undefined ? {} : { issuer }) }, operationId, hostingTarget: locator.hostingTarget })
    } catch { /* Other saved task locators have their own shape and owner. */ }
  }
  return result
}
export function restoredIdentityRemovalTask(record: { config: Pick<ConnectionRecord['config'], 'connectionId' | 'adapterId' | 'application'> }, selections: BotTaskSelections, hostingTarget?: ConnectionHostingTarget | null) {
  return retainedIdentityRemovalTasks(selections).find(({ scope, hostingTarget: owner }) => scope.connectionId === record.config.connectionId && scope.adapterId === record.config.adapterId && sameConnectionApplication({ domain: scope.domain, appId: scope.appId, ...(scope.issuer === undefined ? {} : { issuer: scope.issuer }) }, record.config.application) && (hostingTarget === undefined || JSON.stringify(owner) === JSON.stringify(hostingTarget))) ?? null
}

export function restoredBotTaskSelections(value: unknown): BotTaskSelections {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).flatMap<[string, string | BotTaskLocator]>(([key, raw]) => {
      if (typeof raw === 'string' && raw.trim()) return [[key, raw]]
      const locator = readBotTaskLocator(raw)
      return key !== 'management' && locator?.hostingTarget ? [[key, { operationId: locator.operationId, hostingTarget: locator.hostingTarget }]] : []
    }))
    : {}
}

export function managementTaskScope(record: ConnectionRecord): ManagementTaskScope {
  return { kind: 'management', connectionId: record.config.connectionId, adapterId: record.config.adapterId, domain: record.config.application.domain, appId: record.config.application.appId, ...(record.config.application.issuer === undefined ? {} : { issuer: record.config.application.issuer }) }
}

/** The explicit navigation pointer contains only the exact saved target, never a reading. */
export function restoredManagementTask(selections: BotTaskSelections): { scope: ManagementTaskScope; operationId: string; hostingTarget: ConnectionHostingTarget | null } | null {
  const key = selections.management
  if (typeof key !== 'string' || !selections[key]) return null
  const locator = readBotTaskLocator(selections[key])
  if (!locator) return null
  try {
    const parts: unknown = JSON.parse(key)
    if (!Array.isArray(parts)) return null
    const last = parts.at(-1), issuer = last && typeof last === 'object' && !Array.isArray(last) && typeof last.issuer === 'string' && last.issuer ? last.issuer : undefined
    if (issuer !== undefined) parts.pop()
    if (parts.length !== 5 || parts[0] !== 'management' || !parts.slice(1).every(value => typeof value === 'string' && value.trim())) return null
    const [, connectionId, adapterId, domain, appId] = parts as [string, string, string, string, string]
    return { scope: { kind: 'management', connectionId, adapterId, domain, appId, ...(issuer === undefined ? {} : { issuer }) }, operationId: locator.operationId, hostingTarget: locator.hostingTarget }
  } catch { return null }
}
