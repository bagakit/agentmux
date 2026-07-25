import { workbenchSurfaces, type WorkbenchTab } from './workbench-tabs'

export function formatAgentMuxTabHandoff(tabId: string): string {
  const tabArgument = `'${tabId.replaceAll("'", `'"'"'`)}'`
  return `Continue in AgentMux Tab ${tabId}.

Inspect it with:
agentmux inspect --tab=${tabArgument}

Send to its Agent when the Tab has exactly one Agent Session:
agentmux send --to-tab=${tabArgument} --text "..."

Use agentSessionId from the inspect receipt. If send returns MESSAGE_TARGET_NOT_UNIQUE, choose an agentSessionId from the error candidates, then use:
agentmux send --to-session <agentSessionId> --text "..."`
}

export function copyableAgentSessionIdForTab(tab: WorkbenchTab): string | null {
  const agentSessionIds = new Set(workbenchSurfaces(tab).flatMap((surface) =>
    surface.kind === 'agent' ? [surface.sessionId] : []
  ))
  return agentSessionIds.size === 1 ? (agentSessionIds.values().next().value ?? null) : null
}
