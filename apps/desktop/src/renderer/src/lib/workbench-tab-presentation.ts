import type { AgentTimelineSnapshot } from '@agentmux/core'
import { builtInAgentProviderLabel } from '@agentmux/core/provider-id'
import type { SessionSnapshot } from '../../../shared/contracts'
import { assertUnreachableSurface } from './workbench-surface-kinds'
import { firstPromptFromTimeline, tabDisplayName, titleWorkbenchSurface, type AgentNameFacts, type WorkbenchTab } from './workbench-tabs'

function tabSurfaceFallback(tab: WorkbenchTab, sessions: readonly SessionSnapshot[]): string {
  const surface = titleWorkbenchSurface(tab)
  switch (surface.kind) {
    case 'git-diff':
      return `${surface.comparison.file.path.split('/').at(-1) ?? surface.comparison.file.path} · Diff`
    case 'file':
      return surface.path.split('/').at(-1) ?? surface.path
    case 'launcher':
      return 'New Tab'
    case 'browser':
      return surface.title && surface.title !== 'about:blank'
        ? surface.title
        : surface.url === 'about:blank' ? 'New Tab' : surface.url
    case 'agent':
    case 'terminal':
      return sessions.find((session) => session.id === surface.sessionId)?.label ?? surface.sessionId
    default:
      return assertUnreachableSurface(surface)
  }
}

/** Feed the existing naming owner the same Store facts on every Tab identity surface. */
export function workbenchAgentFactsFor(
  sessions: readonly SessionSnapshot[],
  agentNames: Readonly<Record<string, string>>,
  timelines: Readonly<Record<string, AgentTimelineSnapshot>>
): (sessionId: string) => AgentNameFacts | null {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  return (sessionId) => {
    const session = byId.get(sessionId)
    return session?.kind === 'agent' ? {
      userName: agentNames[sessionId],
      firstPrompt: firstPromptFromTimeline(timelines[sessionId]),
      fallbackLabel: session.label,
      providerLabel: builtInAgentProviderLabel(session.providerId)
    } : null
  }
}

export function workbenchTabDisplayName(
  tab: WorkbenchTab,
  sessions: readonly SessionSnapshot[],
  agentNames: Readonly<Record<string, string>>,
  timelines: Readonly<Record<string, AgentTimelineSnapshot>>
): string {
  return tabDisplayName({
    tab,
    fallback: tabSurfaceFallback(tab, sessions),
    agentFactsFor: workbenchAgentFactsFor(sessions, agentNames, timelines)
  })
}
