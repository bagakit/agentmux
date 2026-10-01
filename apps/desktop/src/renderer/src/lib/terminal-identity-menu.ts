import { agentRosterMenuActions, type AgentRosterMenuAction } from './agent-roster-menu'

export type TerminalIdentityMenuAction = AgentRosterMenuAction

/** Plain terminals have no Agent identity; Agent terminals reuse the Roster's identity actions. */
export function terminalIdentityMenuActions(input: Parameters<typeof agentRosterMenuActions>[0] & {
  sessionKind: 'agent' | 'terminal'
}): TerminalIdentityMenuAction[] {
  return input.sessionKind === 'agent' ? agentRosterMenuActions(input) : []
}
