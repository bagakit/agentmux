import type { AgentMuxBrowserControl } from '@agentmux/core'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { regionIds } from '@agentmux/layout'
import type { AgentSessionControl, BrowserControlHandoff, SessionSnapshot } from '../../../shared/contracts'
import { agentSessionPresentationIndex } from './session-presentation'
import type { BrowserWorkbenchSurface, WorkbenchTab } from './workbench-tabs'
import type { WorkbenchProjectionSelection } from './workbench-projection'

export type BrowserAgentIdentity = NonNullable<AgentMuxBrowserControl['agent']>
export type BrowserAgentSession = Extract<SessionSnapshot, { kind: 'agent' }>
export type BrowserTabAgentCandidates = { sessions: readonly BrowserAgentSession[]; unconfirmed: boolean }

export function sameBrowserAgent(a: AgentMuxBrowserControl['agent'], b: AgentMuxBrowserControl['agent']): boolean {
  return a === b || Boolean(a && b && a.hostId === b.hostId && a.agentSessionId === b.agentSessionId)
}

/** Display membership suggests a recipient; only Main can admit the actual handoff. */
export function browserTabAgentCandidates(tab: WorkbenchTab | undefined, sessions: readonly SessionSnapshot[]): BrowserTabAgentCandidates {
  if (!tab) return { sessions: [], unconfirmed: true }
  const index = agentSessionPresentationIndex(sessions), selected = new Map<string, BrowserAgentSession>()
  let unconfirmed = false
  for (const regionId of regionIds(tab.layout.root)) {
    const region = tab.regions[regionId]
    if (region?.kind !== 'agent') continue
    const candidates = (index.get(region.sessionId) ?? []).filter(session => session.id === region.sessionId && session.hostId === session.control.hostId)
    if (candidates.length !== 1) { unconfirmed = true; continue }
    const session = candidates[0]!
    const key = JSON.stringify([session.control.hostId, session.control.agentSessionId])
    if (!selected.has(key)) selected.set(key, session)
  }
  return { sessions: [...selected.values()], unconfirmed }
}

export function browserTabAgentSessions(tab: WorkbenchTab | undefined, sessions: readonly SessionSnapshot[]): readonly BrowserAgentSession[] {
  return browserTabAgentCandidates(tab, sessions).sessions
}

/** An absent or ambiguous observation cannot be replaced with the historical operator. */
export function browserAssociatedAgentSession(agent: AgentMuxBrowserControl['agent'], sessions: readonly SessionSnapshot[]): BrowserAgentSession | undefined {
  if (!agent) return
  const candidates = (agentSessionPresentationIndex(sessions).get(agent.agentSessionId) ?? []).filter(session =>
    session.hostId === agent.hostId && session.control.hostId === agent.hostId && session.control.agentSessionId === agent.agentSessionId)
  return candidates.length === 1 ? candidates[0] : undefined
}

/** Freeze the page the person saw. A newer projection never silently retargets their click. */
export function browserAgentHandoffInput(observed: Pick<BrowserWorkbenchSurface, 'browserId' | 'navigationId' | 'control'>,
  current: Pick<BrowserWorkbenchSurface, 'browserId' | 'navigationId' | 'control'>, agent: AgentSessionControl): BrowserControlHandoff {
  const control = observed.control
  if (!control || control.owner !== 'human' || !observed.navigationId ||
    current.browserId !== observed.browserId || current.navigationId !== observed.navigationId ||
    current.control?.owner !== 'human' || current.control.revision !== control.revision || !sameBrowserAgent(current.control.agent, control.agent)) {
    throw new Error('This Browser page or control changed before the handoff. Its page and Agents are kept; inspect the current control and choose again.')
  }
  return { navigationId: observed.navigationId, expectedRevision: control.revision,
    agent: { ...agent, run: { ...agent.run } }, ...(control.agent ? { expectedAgent: { hostId: control.agent.hostId, agentSessionId: control.agent.agentSessionId } }
      : control.agent === undefined ? { expectedAgent: 'unknown' as const } : {}) }
}

/** Existing association return is fenced without turning a missing Run observation into a new grant. */
export function browserAgentReturnInput(observed: Pick<BrowserWorkbenchSurface, 'browserId' | 'navigationId' | 'control'>,
  current: Pick<BrowserWorkbenchSurface, 'browserId' | 'navigationId' | 'control'>): BrowserControlHandoff {
  const control = observed.control
  if (!control?.agent || control.owner !== 'human' || !observed.navigationId || current.browserId !== observed.browserId ||
    current.navigationId !== observed.navigationId || current.control?.owner !== 'human' ||
    current.control.revision !== control.revision || !sameBrowserAgent(current.control.agent, control.agent)) {
    throw new Error('This Browser page or linked Agent changed before control could be returned. The original page and relationship are kept; inspect the current control and choose again.')
  }
  return { navigationId: observed.navigationId, expectedRevision: control.revision,
    expectedAgent: { hostId: control.agent.hostId, agentSessionId: control.agent.agentSessionId } }
}

/** Every original occurrence is retained; multiple displays require an explicit choice. */
export function browserAgentLocations(catalog: AgentMuxSpaceCatalog, agent: BrowserAgentIdentity): readonly WorkbenchProjectionSelection[] {
  const matching = new Set(catalog.regions.filter(region => region.kind === 'agent' && region.agentSessionId === agent.agentSessionId &&
    region.execution?.hostId === agent.hostId).map(region => JSON.stringify([region.tabId, region.regionId])))
  const choices = new Map<string, WorkbenchProjectionSelection>()
  for (const location of catalog.locations) if (matching.has(JSON.stringify([location.tabId, location.regionId]))) {
    const choice = { displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId, tabId: location.tabId, regionId: location.regionId }
    choices.set(JSON.stringify(choice), choice)
  }
  return [...choices.values()]
}
