import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'

export type BotTaskScope = { kind: 'mote'; target: MotePreferencesTarget } | { kind: 'enrollment' }
/** Presentation locators only. Original owners retain every outcome and private view. */
export type BotTaskSelections = Record<string, string>

export function botTaskSelectionKey(scope: BotTaskScope): string {
  if (scope.kind === 'enrollment') return 'enrollment'
  const target = scope.target
  return JSON.stringify(['mote', target.spaceId, target.zoneId, target.expectedResource.hostId, target.expectedResource.workspaceId, target.expectedResource.workspacePath])
}

export function restoredBotTaskSelections(value: unknown): BotTaskSelections {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([, id]) => typeof id === 'string' && id.trim()))
    : {}
}
