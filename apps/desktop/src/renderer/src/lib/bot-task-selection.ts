import type { ConnectionRecord } from '@agentmux/core/connections'
import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'

export type ManagementTaskScope = { kind: 'management'; connectionId: string; adapterId: string; domain: string; appId: string }
export type IdentityRemovalTaskScope = { kind: 'identity-removal'; connectionId: string; adapterId: string; domain: string; appId: string; expectedRevision: number }
export type BotTaskScope = { kind: 'mote'; target: MotePreferencesTarget } | { kind: 'enrollment' } | ManagementTaskScope | IdentityRemovalTaskScope | { kind: 'management-route' }
/** Presentation locators only. Original owners retain every outcome and private view. */
export type BotTaskSelections = Record<string, string>

export function botTaskSelectionKey(scope: BotTaskScope): string {
  if (scope.kind === 'enrollment') return 'enrollment'
  if (scope.kind === 'management-route') return 'management'
  if (scope.kind === 'identity-removal') return JSON.stringify(['identity-removal', scope.connectionId, scope.adapterId, scope.domain, scope.appId, scope.expectedRevision])
  if (scope.kind === 'management') return JSON.stringify(['management', scope.connectionId, scope.adapterId, scope.domain, scope.appId])
  const target = scope.target
  return JSON.stringify(['mote', target.spaceId, target.zoneId, target.expectedResource.hostId, target.expectedResource.workspaceId, target.expectedResource.workspacePath])
}

/** Exact removal input locator, never a deletion result or a replacement revision. */
export function retainedIdentityRemovalTasks(selections: BotTaskSelections): Array<{ scope: IdentityRemovalTaskScope; operationId: string }> {
  const result: Array<{ scope: IdentityRemovalTaskScope; operationId: string }> = []
  for (const [key, operationId] of Object.entries(selections)) {
    try {
      const parts: unknown = JSON.parse(key)
      if (!Array.isArray(parts) || parts.length !== 6 || parts[0] !== 'identity-removal' || !parts.slice(1, 5).every(value => typeof value === 'string' && value.trim()) || !Number.isSafeInteger(parts[5]) || parts[5] < 1) continue
      const [, connectionId, adapterId, domain, appId, expectedRevision] = parts as [string, string, string, string, string, number]
      result.push({ scope: { kind: 'identity-removal', connectionId, adapterId, domain, appId, expectedRevision }, operationId })
    } catch { /* Other saved task locators have their own shape and owner. */ }
  }
  return result
}
export function restoredIdentityRemovalTask(record: { config: Pick<ConnectionRecord['config'], 'connectionId' | 'adapterId' | 'application'> }, selections: BotTaskSelections) {
  return retainedIdentityRemovalTasks(selections).find(({ scope }) => scope.connectionId === record.config.connectionId && scope.adapterId === record.config.adapterId && scope.domain === record.config.application.domain && scope.appId === record.config.application.appId) ?? null
}

export function restoredBotTaskSelections(value: unknown): BotTaskSelections {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([, id]) => typeof id === 'string' && id.trim()))
    : {}
}

export function managementTaskScope(record: ConnectionRecord): ManagementTaskScope {
  return { kind: 'management', connectionId: record.config.connectionId, adapterId: record.config.adapterId, domain: record.config.application.domain, appId: record.config.application.appId }
}

/** The explicit navigation pointer contains only the exact saved target, never a reading. */
export function restoredManagementTask(selections: BotTaskSelections): { scope: ManagementTaskScope; operationId: string } | null {
  const key = selections.management
  if (!key || !selections[key]) return null
  try {
    const parts: unknown = JSON.parse(key)
    if (!Array.isArray(parts) || parts.length !== 5 || parts[0] !== 'management' || !parts.slice(1).every(value => typeof value === 'string' && value.trim())) return null
    const [, connectionId, adapterId, domain, appId] = parts as [string, string, string, string, string]
    return { scope: { kind: 'management', connectionId, adapterId, domain, appId }, operationId: selections[key]! }
  } catch { return null }
}
