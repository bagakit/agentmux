import { describe, expect, it, vi } from 'vitest'
import type { AgentMuxSpaceCatalog, AgentMuxSpaceLocation, AgentMuxZoneFact } from '@agentmux/core/control'
import type { SessionSnapshot } from '../src/shared/contracts'
import { buildActivitySpaces, type AgentSession } from '../src/renderer/src/lib/project-activity-spaces'
import { createWorkbenchTab, type WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { fixturePath, fixtureTime } from '../scripts/lib/fixture-values.mjs'

function agent(id: string, hostId = 'execution-host'): AgentSession {
  const observedAt = fixtureTime()
  return { id, hostId, kind: 'agent', providerId: 'codex', executorId: 'codex', workspacePath: fixturePath('execution'),
    label: id, createdAt: observedAt, updatedAt: observedAt, agentSessionUpdatedAt: observedAt, processState: 'running', latestOutputBytes: 0,
    status: { state: 'running', source: 'run-process', observedAt },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId, agentSessionId: id, run: { runId: `run-${hostId}-${id}` } } }
}
function zone(zoneId = 'zone', overrides: Partial<AgentMuxZoneFact> = {}): AgentMuxZoneFact {
  return { zoneId, workspaceId: 'resource-workspace', kind: 'worktree', hostId: 'display-host',
    directoryPath: fixturePath('display/checkout'), branch: 'feature', ...overrides }
}
function location(tabId = 'tab', regionId = 'region', overrides: Partial<AgentMuxSpaceLocation> = {}): AgentMuxSpaceLocation {
  return { spaceId: 'space', zoneId: 'zone', workspaceId: 'resource-workspace', displayWorkspaceId: 'display-workspace',
    groupId: 'group', tabId, regionId, ...overrides }
}
function tab(session: AgentSession, tabId = 'tab', regionId = 'region', name?: string): WorkbenchTab {
  return createWorkbenchTab(tabId, { kind: 'agent', regionId, workspaceId: 'resource-workspace', phase: 'attached', sessionId: session.id }, name)
}
function catalog(tabs: readonly WorkbenchTab[], locations: AgentMuxSpaceLocation[], zones = [zone()]): AgentMuxSpaceCatalog {
  return { spaces: [], bindings: [], zones, locations,
    tabs: tabs.map(value => ({ tabId: value.id, workspaceId: value.workspaceId, zoneId: value.space?.zoneId ?? 'zone',
      name: value.name ?? null, regionIds: Object.keys(value.regions) })),
    regions: tabs.flatMap(value => Object.values(value.regions).map(surface => ({ regionId: surface.regionId,
      tabId: value.id, kind: surface.kind, agentSessionId: surface.kind === 'agent' ? surface.sessionId : null,
      runId: null, execution: null }))) }
}

describe('Activity Zone and Tab projection', () => {
  it('uses the original execution Host when the display Host and navigation execution differ', () => {
    const remote = agent('shared-session'), display = agent(remote.id, 'display-host')
    const original = tab(remote), held = location()
    const facts = catalog([original], [held])
    const executionFor = vi.fn(() => ({ hostId: remote.hostId }))
    const result = buildActivitySpaces([display, remote], facts, { [original.id]: original }, executionFor)
    expect(result.zones).toHaveLength(1)
    expect(result.zones[0]).toMatchObject({ zoneId: 'zone', hostId: 'display-host', path: zone().directoryPath, sessions: [remote] })
    expect(result.zones[0]!.tabs[0]!.agents).toEqual([{ session: remote, location: held }])
    expect(result.unplaced).toEqual([display])
    expect(executionFor).toHaveBeenCalledExactlyOnceWith({ tabId: 'tab', regionId: 'region', agentSessionId: remote.id })
    expect(remote.workspacePath).toBe(fixturePath('execution'))
    expect(facts.regions[0]!.execution).toBeNull()
    facts.regions[0]!.execution = { hostId: 'unrelated-host', cwd: fixturePath('unrelated') }
    expect(buildActivitySpaces([remote], facts, { [original.id]: original }, executionFor).zones[0]!.sessions).toEqual([remote])
  })

  it('keeps each Host subject separate even when Session ids and labels match', () => {
    const first = agent('shared'), second = agent('shared', 'second-host')
    const firstTab = tab(first, 'first-tab', 'first-region'), secondTab = tab(second, 'second-tab', 'second-region')
    const facts = catalog([firstTab, secondTab], [location(firstTab.id, 'first-region'), location(secondTab.id, 'second-region')])
    const result = buildActivitySpaces([first, second], facts, { [firstTab.id]: firstTab, [secondTab.id]: secondTab },
      reference => ({ hostId: reference.tabId === firstTab.id ? first.hostId : second.hostId }))
    expect(result.zones[0]!.sessions).toEqual([first, second])
    expect(result.zones[0]!.tabs.map(value => value.agents[0]!.session)).toEqual([first, second])
    expect(result.unplaced).toEqual([])
  })

  it('includes Mote and unbound workfaces without Focus eligibility or directory inference', () => {
    const mote = agent('mote'), original = tab(mote)
    original.topicId = 'mote-conversation'
    const held = location(original.id, 'region', { zoneId: null, spaceId: 'mote-space' })
    const facts = catalog([original], [held], [])
    facts.spaces.push({ spaceId: 'mote-space', kind: 'mote', name: 'Mote', hostId: mote.hostId,
      directoryPath: fixturePath('mote'), projectId: null })
    const result = buildActivitySpaces([mote], facts, { [original.id]: original }, () => ({ hostId: mote.hostId }))
    expect(result.zones).toMatchObject([{ zoneId: null, label: 'Unbound workfaces', path: null, hostId: null, sessions: [mote] }])
    expect(result.zones[0]!.tabs[0]!.agents[0]!.location).toBe(held)
    expect(result.unplaced).toEqual([])
  })

  it('preserves every display, group, Tab and Region occurrence while deduplicating space bindings', () => {
    const session = agent('agent'), original = tab(session)
    original.regions.other = { ...original.regions.region!, regionId: 'other' }
    const first = location(), secondRegion = location('tab', 'other')
    const secondGroup = location('tab', 'region', { groupId: 'other-group' })
    const secondDisplay = location('tab', 'region', { displayWorkspaceId: 'other-display' })
    const elsewhere = tab(session, 'other-tab', 'other-tab-region')
    const held = [first, { ...first, spaceId: 'second-binding' }, secondRegion, secondGroup, secondDisplay, location(elsewhere.id, 'other-tab-region')]
    const executionFor = vi.fn(() => ({ hostId: session.hostId }))
    const result = buildActivitySpaces([session], catalog([original, elsewhere], held), { [original.id]: original, [elsewhere.id]: elsewhere }, executionFor)
    expect(result.zones[0]!.tabs.map(value => value.key)).toEqual([
      JSON.stringify(['display-workspace', 'group', 'tab']), JSON.stringify(['display-workspace', 'other-group', 'tab']),
      JSON.stringify(['other-display', 'group', 'tab']), JSON.stringify(['display-workspace', 'group', 'other-tab'])
    ])
    expect(result.zones[0]!.tabs.map(value => value.agents.map(member => member.location))).toEqual([
      [first, secondRegion], [secondGroup], [secondDisplay], [held[5]]
    ])
    expect(result.zones[0]!.sessions).toEqual([session])
    expect(executionFor).toHaveBeenCalledTimes(5)
    expect(result.unplaced).toEqual([])
  })

  it('retains every Agent with missing or contradictory placement facts as unplaced', () => {
    const sessions = ['missing-region', 'wrong-session', 'missing-tab', 'terminal-region', 'unknown-execution', 'wrong-host', 'no-location'].map(id => agent(id))
    const originals = sessions.map(value => tab(value, value.id, value.id))
    const tabs = Object.fromEntries(originals.map(value => [value.id, value]))
    const facts = catalog(originals, originals.slice(0, -1).map(value => location(value.id, value.id)))
    facts.regions = facts.regions.filter(value => value.tabId !== 'missing-region')
    facts.regions.find(value => value.tabId === 'wrong-session')!.agentSessionId = 'different-session'
    delete tabs['missing-tab']
    facts.regions.find(value => value.tabId === 'terminal-region')!.kind = 'terminal'
    const result = buildActivitySpaces(sessions, facts, tabs, reference => reference.tabId === 'unknown-execution'
      ? null : { hostId: reference.tabId === 'wrong-host' ? 'other-host' : 'execution-host' })
    expect(result.zones).toEqual([])
    expect(result.unplaced).toEqual(sessions)
    expect(buildActivitySpaces([], facts, tabs, () => null)).toEqual({ zones: [], unplaced: [] })
  })

  it('does not mix equal Zone or Tab labels and uses branch, directory and kind labels in order', () => {
    const sessions = ['first', 'second', 'third', 'fourth'].map(id => agent(id))
    const originals = sessions.map(value => tab(value, value.id, value.id, 'Same Tab'))
    const zones = [zone('first', { branch: 'same' }), zone('second', { branch: 'same' }),
      zone('third', { branch: null, directoryPath: fixturePath('display/leaf') }),
      zone('fourth', { branch: null, directoryPath: null, kind: 'home', hostId: null })]
    const facts = catalog(originals, originals.map(value => location(value.id, value.id, { zoneId: value.id })), zones)
    const result = buildActivitySpaces(sessions, facts, Object.fromEntries(originals.map(value => [value.id, value])), () => ({ hostId: 'execution-host' }))
    expect(result.zones.map(value => value.label)).toEqual(['same', 'same', 'leaf', 'home'])
    expect(new Set(result.zones.map(value => value.key)).size).toBe(4)
    expect(result.zones.map(value => value.tabs[0]!.label)).toEqual(originals.map(() => 'Same Tab'))
    expect(new Set(result.zones.map(value => value.tabs[0]!.key)).size).toBe(4)
    expect(result.zones.map(value => value.sessions)).toEqual(sessions.map(value => [value]))
    expect(result.zones[3]).toMatchObject({ path: null, hostId: null })
  })

  it('uses the original Tab naming policy without merging same-SID identities', () => {
    const session = agent('first'), sibling = { ...agent('second'), providerId: 'claude', executorId: 'claude' }
    const original = tab(session)
    original.regions.other = { kind: 'agent', regionId: 'other', workspaceId: original.workspaceId, phase: 'attached', sessionId: sibling.id }
    const facts = catalog([original], [location(), location('tab', 'other')])
    const project = (members: SessionSnapshot[]) => buildActivitySpaces(members, facts, { [original.id]: original },
      reference => ({ hostId: reference.regionId === 'other' ? sibling.hostId : session.hostId }))
    expect(project([session, sibling]).zones[0]!.tabs[0]!.label).toBe('claude · codex')
    original.name = 'User title'
    expect(project([session, sibling]).zones[0]!.tabs[0]!.label).toBe('User title')
    delete original.name
    const sameSid = { ...sibling, id: session.id, label: 'Other identity', hostId: 'other-host', control: { ...sibling.control, hostId: 'other-host', agentSessionId: session.id } }
    original.regions.other = { ...original.regions.other, sessionId: sameSid.id }
    facts.regions[1]!.agentSessionId = sameSid.id
    sibling.hostId = sameSid.hostId
    const result = project([session, sameSid])
    expect(result.zones[0]!.tabs[0]!.label).toBe('Workbench')
    expect(result.zones[0]!.sessions).toEqual([session, sameSid])
  })

  it('joins a renderer alias to the public canonical SID through the exact original Session control', () => {
    const canonical = agent('core-session'), presentation = { ...canonical, id: 'presentation-alias' }
    const original = tab(presentation), facts = catalog([original], [location()])
    facts.regions[0]!.agentSessionId = canonical.control.agentSessionId
    const executionFor = vi.fn(() => ({ hostId: canonical.control.hostId }))
    const result = buildActivitySpaces([presentation], facts, { [original.id]: original }, executionFor)
    expect(result.zones[0]?.sessions).toEqual([presentation])
    expect(result.unplaced).toEqual([])
    expect(executionFor).toHaveBeenCalledExactlyOnceWith({ tabId: original.id, regionId: 'region', agentSessionId: canonical.control.agentSessionId })
    facts.regions[0]!.agentSessionId = 'another-canonical-session'
    expect(buildActivitySpaces([presentation], facts, { [original.id]: original }, executionFor).unplaced).toEqual([presentation])
  })
})
