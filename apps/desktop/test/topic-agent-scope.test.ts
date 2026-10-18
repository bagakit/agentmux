import { describe, expect, it } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { fixturePath } from '../../../test/fixture-values.mjs'
import type { AppConfig, ScratchTopicSnapshot, SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts'
import type { AgentSessionHistoryDescriptor } from '@agentmux/core'
import { directoryIdentity, homeZoneId, workspaceZoneId, type SpaceZoneBindings } from '../src/shared/space-addresses'
import { scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceAgentListSelector, workspaceAgentListMembers, type WorkspaceAgentExecutionResolver,
  type WorkspaceAgentScopeState } from '../src/renderer/src/lib/workspace-agent-scope'

type Agent = Extract<SessionSnapshot, { kind: 'agent' }>
const agent = (id: string, workspacePath: string, hostId = 'local', canonicalId = id, providerId = 'codex'): Agent => ({
  id, kind: 'agent', providerId, executorId: providerId, hostId, workspacePath,
  promptSubmissionPredecessor: null, agentSessionUpdatedAt: 1, label: providerId, createdAt: 1, updatedAt: 1,
  latestOutputBytes: 0, processState: 'running', status: { state: 'running', source: 'run-process', observedAt: 1 },
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId, agentSessionId: canonicalId, run: { runId: `${hostId}:${canonicalId}` } }
})
const subjects = (sessions: readonly Agent[]) => sessions.map(value => [value.control.hostId, value.control.agentSessionId].join(':')).sort()

function fixture() {
  const scratch: WorkspaceRecord = { id: '__scratch__', name: 'Topics', hostId: 'local', path: fixturePath('scope/scratch'), kind: 'folder' }
  const project: WorkspaceRecord = { id: 'project', name: 'Project', hostId: 'local', path: fixturePath('scope/project'), kind: 'folder' }
  const remote: WorkspaceRecord = { id: 'remote-project', name: 'Remote Project', hostId: 'remote', path: fixturePath('scope/remote'), kind: 'folder' }
  const category = { categoryId: 'shared', hostId: 'local', title: 'Shared', directoryPath: fixturePath('scope/category'),
    spaceId: directoryIdentity('local', fixturePath('scope/category')), revision: null }
  const topics: ScratchTopicSnapshot[] = ['one', 'two', 'mote'].map(label => {
    const id = `launcher:${label}`
    const directoryPath = scratchTopicDirectoryName(id), path = `${scratch.path}/${directoryPath}`
    return { id, kind: label === 'mote' ? 'mote' : 'topic', title: `Object ${label}`, summary: '', directoryPath,
      identityDirectoryPath: path, physicalDirectoryPath: path, confirmedDirectoryPaths: [path],
      topicPath: `${directoryPath}/topic.md`, collaborators: [],
      ...(label === 'mote' ? { soul: { path: 'SOUL.md', content: 'Original persona', version: 'original' } } : {}) }
  })
  const original = (topic: ScratchTopicSnapshot) => {
    const spaceId = directoryIdentity(scratch.hostId, topic.identityDirectoryPath!)
    return { spaceId, zoneId: homeZoneId(spaceId) }
  }
  const address = (topic: ScratchTopicSnapshot) => ({ ...original(topic), spaceId: topic.kind === 'mote' ? original(topic).spaceId : category.spaceId })
  const bindings: SpaceZoneBindings = Object.fromEntries(topics.map(topic => [original(topic).zoneId, {
    spaceId: original(topic).spaceId, workspaceId: scratch.id, topicId: topic.id, contentKind: topic.kind,
    directoryPath: topic.physicalDirectoryPath,
    ...(topic.kind !== 'mote' ? { relations: { [category.spaceId]: true } } : {})
  }]))
  const projectSpaceId = directoryIdentity(project.hostId, project.path), projectZone = workspaceZoneId(projectSpaceId, project.id)
  const remoteSpaceId = directoryIdentity(remote.hostId, remote.path), remoteZone = workspaceZoneId(remoteSpaceId, remote.id)
  const moteSpaceId = original(topics[2]!).spaceId
  bindings[projectZone] = { spaceId: projectSpaceId, workspaceId: project.id, relations: { [moteSpaceId]: true } }
  bindings[remoteZone] = { spaceId: remoteSpaceId, workspaceId: remote.id, relations: { [moteSpaceId]: true } }
  const sessions = [agent('one-open', topics[0]!.physicalDirectoryPath!), agent('one-closed', topics[0]!.physicalDirectoryPath!),
    agent('two-agent', topics[1]!.physicalDirectoryPath!), agent('mote-agent', topics[2]!.physicalDirectoryPath!),
    agent('root-agent', scratch.path), agent('project-agent', project.path), agent('same-sid', remote.path, 'remote'),
    agent('same-sid', fixturePath('scope/unbound-local'), 'local')]
  const makeTab = (id: string, workspace: WorkspaceRecord, session: Agent, space: { spaceId: string; zoneId: string }, topicId?: string) => {
    const tab = createWorkbenchTab(id, { kind: 'agent', phase: 'attached', regionId: `${id}-region`,
      workspaceId: workspace.id, sessionId: session.control.agentSessionId })
    return { ...tab, space, ...(topicId ? { topicId } : {}) }
  }
  const tabs = {
    one: makeTab('one', scratch, sessions[0]!, address(topics[0]!), topics[0]!.id),
    two: makeTab('two', scratch, sessions[2]!, address(topics[1]!), topics[1]!.id),
    mote: makeTab('mote', scratch, sessions[3]!, address(topics[2]!), topics[2]!.id),
    project: makeTab('project', project, sessions[5]!, { spaceId: projectSpaceId, zoneId: projectZone }),
    remote: makeTab('remote', remote, sessions[6]!, { spaceId: remoteSpaceId, zoneId: remoteZone })
  }
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }],
    executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } },
    workspaces: [scratch, project, remote], appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  const choose = (topic: ScratchTopicSnapshot) => ({ ...address(topic), workspaceId: scratch.id, topicId: topic.id,
    tabId: topic.id.split(':')[1]!, regionId: `${topic.id.split(':')[1]}-region`, groupId: 'scratch-group' })
  const state: WorkspaceAgentScopeState = { config, sessions, tabs,
    layouts: { [scratch.id]: createWorkspaceLayout('scratch-group', ['two', 'one', 'mote']),
      [project.id]: createWorkspaceLayout('project-group', ['project']), [remote.id]: createWorkspaceLayout('remote-group', ['remote']) },
    spaceZoneBindings: bindings, scratchTopicSnapshots: { [scratch.id]: { scope: scratchTopicsScope(scratch), revision: 1,
      topics, error: null, reading: false } }, workbenchSpaceSelection: choose(topics[0]!), topicCategories: [category],
    projectGroups: [], spatialRequests: {} }
  const resolve: WorkspaceAgentExecutionResolver = ref => {
    const tab = state.tabs[ref.tabId], region = tab?.regions[ref.regionId]
    if (region?.kind !== 'agent' || region.sessionId !== ref.agentSessionId) return null
    return { hostId: ref.tabId === 'remote' ? 'remote' : 'local' }
  }
  return { state, scratch, project, remote, topics, original, address, choose, resolve, projectZone, remoteZone }
}

describe('Topic and Mote Agent membership uses original object facts', () => {
  it('keeps two Topics in the same Category separate despite active Tab focus and closed Tabs', () => {
    const f = fixture(), select = createWorkspaceAgentListSelector(f.resolve)
    const first = select(f.state, f.scratch)
    expect(first.title).toBe('Object one')
    expect(subjects(first.sessions)).toEqual(['local:one-closed', 'local:one-open'])
    const second = select({ ...f.state, workbenchSpaceSelection: f.choose(f.topics[1]!) }, f.scratch)
    expect(subjects(second.sessions)).toEqual(['local:two-agent'])
    expect(second.key).not.toBe(first.key)
    expect(first.issue).toBeNull()
  })

  it('includes every legally bound Mote Zone and qualifies an external Session by its exact execution Host', () => {
    const f = fixture(), select = createWorkspaceAgentListSelector(f.resolve)
    const selected = { ...f.state, workbenchSpaceSelection: f.choose(f.topics[2]!) }
    expect(subjects(select(selected, f.scratch).sessions)).toEqual(['local:mote-agent', 'local:project-agent', 'remote:same-sid'])
    expect(subjects(workspaceAgentListMembers(selected, f.scratch, f.resolve))).toEqual([
      'local:mote-agent', 'local:one-closed', 'local:one-open', 'local:project-agent', 'local:root-agent', 'local:two-agent', 'remote:same-sid'
    ])
    const unlinked = { ...selected, spaceZoneBindings: { ...selected.spaceZoneBindings,
      [f.remoteZone]: { ...selected.spaceZoneBindings[f.remoteZone]!, relations: { [f.original(f.topics[2]!).spaceId]: false } } } }
    expect(subjects(select(unlinked, f.scratch).sessions)).toEqual(['local:mote-agent', 'local:project-agent'])
  })

  it('accepts confirmed exact aliases and historical collaborators without borrowing another Host or Provider', () => {
    const f = fixture(), alias = fixturePath('scope/retained-alias'), topics = [...f.topics]
    topics[0] = { ...topics[0]!, confirmedDirectoryPaths: [...topics[0]!.confirmedDirectoryPaths!, alias],
      collaborators: [{ sessionId: 'historic', providerId: 'codex', fileName: 'codex--historic.md' }] }
    const state = { ...f.state, sessions: [...f.state.sessions, agent('alias-agent', alias), agent('nested', `${alias}/nested`),
      agent('historic', fixturePath('scope/moved')), agent('historic', fixturePath('scope/foreign'), 'remote'),
      agent('wrong-provider', fixturePath('scope/moved'), 'local', 'historic', 'claude')],
    scratchTopicSnapshots: { [f.scratch.id]: { ...f.state.scratchTopicSnapshots[f.scratch.id]!, topics } } }
    expect(subjects(createWorkspaceAgentListSelector(f.resolve)(state, f.scratch).sessions)).toEqual([
      'local:alias-agent', 'local:historic', 'local:one-closed', 'local:one-open'
    ])
  })

  it('does not grant a Topic a directory alias claimed by another original Topic', () => {
    const f = fixture(), alias = fixturePath('scope/conflicting-alias')
    const topics = f.topics.map(topic => topic.kind === 'topic' ? { ...topic,
      confirmedDirectoryPaths: [...topic.confirmedDirectoryPaths!, alias] } : topic)
    const state = { ...f.state, sessions: [...f.state.sessions, agent('ambiguous-owner', alias)],
      scratchTopicSnapshots: { [f.scratch.id]: { ...f.state.scratchTopicSnapshots[f.scratch.id]!, topics } } }
    expect(subjects(createWorkspaceAgentListSelector(f.resolve)(state, f.scratch).sessions)).toEqual(['local:one-closed', 'local:one-open'])
  })

  it('does not revive a held alias after current directory facts expose a conflicting Topic owner', () => {
    const f = fixture(), alias = fixturePath('scope/newly-conflicting-alias'), select = createWorkspaceAgentListSelector(f.resolve)
    const topics = [...f.topics]
    topics[0] = { ...topics[0]!, confirmedDirectoryPaths: [...topics[0]!.confirmedDirectoryPaths!, alias] }
    const state = { ...f.state, sessions: [...f.state.sessions, agent('alias-agent', alias)],
      scratchTopicSnapshots: { [f.scratch.id]: { ...f.state.scratchTopicSnapshots[f.scratch.id]!, topics } } }
    expect(subjects(select(state, f.scratch).sessions)).toEqual(['local:alias-agent', 'local:one-closed', 'local:one-open'])
    const conflict = [{ ...topics[0]!, readError: 'Optional Topic details could not be read' },
      { ...topics[1]!, confirmedDirectoryPaths: [...topics[1]!.confirmedDirectoryPaths!, alias] }, topics[2]!]
    const changed = { ...state, scratchTopicSnapshots: { [f.scratch.id]: { ...state.scratchTopicSnapshots[f.scratch.id]!,
      revision: 2, topics: conflict } } }
    expect(subjects(select(changed, f.scratch).sessions)).toEqual(['local:one-closed', 'local:one-open'])
  })

  it('retains the same object during a directory gap without expanding to Scratch or dropping confirmed collaborators', () => {
    const f = fixture(), topic = { ...f.topics[0]!, collaborators: [{ sessionId: 'historic', providerId: 'codex', fileName: 'codex--historic.md' }] }
    const state = { ...f.state, sessions: [...f.state.sessions, agent('historic', fixturePath('scope/moved'))],
      scratchTopicSnapshots: { [f.scratch.id]: { ...f.state.scratchTopicSnapshots[f.scratch.id]!, topics: [topic, ...f.topics.slice(1)] } } }
    const select = createWorkspaceAgentListSelector(f.resolve), before = select(state, f.scratch)
    expect(subjects(before.sessions)).toEqual(['local:historic', 'local:one-closed', 'local:one-open'])
    const gap = { ...state, scratchTopicSnapshots: { [f.scratch.id]: { ...state.scratchTopicSnapshots[f.scratch.id]!,
      revision: 2, topics: null, error: 'Original filesystem observation unavailable' } } }
    const after = select(gap, f.scratch)
    expect(subjects(after.sessions)).toEqual(subjects(before.sessions))
    expect(after.key).toBe(before.key)
    expect(after.issue).toBeTruthy()
    expect(subjects(select({ ...gap, workbenchSpaceSelection: f.choose(f.topics[1]!) }, f.scratch).sessions)).toEqual(['local:two-agent'])
  })

  it('keeps a previously confirmed external member during execution observation gaps and clears it on explicit unbind', () => {
    const f = fixture(), state = { ...f.state, workbenchSpaceSelection: f.choose(f.topics[2]!) }
    let available = true
    const select = createWorkspaceAgentListSelector(ref => available ? f.resolve(ref) : null)
    const before = select(state, f.scratch)
    available = false
    const after = select(state, f.scratch)
    expect(subjects(after.sessions)).toEqual(subjects(before.sessions))
    expect(after.issue).toBeTruthy()
    const unbound = { ...state, spaceZoneBindings: { ...state.spaceZoneBindings, [f.remoteZone]: {
      ...state.spaceZoneBindings[f.remoteZone]!, relations: { [f.original(f.topics[2]!).spaceId]: false } } } }
    expect(subjects(select(unbound, f.scratch).sessions)).toEqual(['local:mote-agent', 'local:project-agent'])
    const fresh = createWorkspaceAgentListSelector(() => null)(state, f.scratch)
    expect(subjects(fresh.sessions)).toEqual(['local:mote-agent'])
  })

  it('leaves an unknown explicit Topic empty and never treats it as a global Scratch choice', () => {
    const f = fixture(), missing = { ...f.choose(f.topics[0]!), topicId: 'unobserved-topic',
      zoneId: 'opaque-original-zone', spaceId: 'opaque-original-space', tabId: null, regionId: null }
    const list = createWorkspaceAgentListSelector(f.resolve)({ ...f.state, workbenchSpaceSelection: missing }, f.scratch)
    expect(list.sessions).toEqual([])
    expect(list.issue).toBeTruthy()
  })

  it('changes the management scope key when the same logical Topic ID belongs to a replacement resource root', () => {
    const f = fixture(), select = createWorkspaceAgentListSelector(f.resolve), before = select(f.state, f.scratch)
    const scratch = { ...f.scratch, path: fixturePath('scope/replacement') }
    const topics = f.topics.map(topic => { const path = `${scratch.path}/${topic.directoryPath}`
      return { ...topic, identityDirectoryPath: path, physicalDirectoryPath: path, confirmedDirectoryPaths: [path] } })
    const state = { ...f.state, config: { ...f.state.config!, workspaces: [scratch, f.project, f.remote] },
      scratchTopicSnapshots: { [scratch.id]: { scope: scratchTopicsScope(scratch), revision: 1, topics, error: null, reading: false } } }
    expect(select(state, scratch).key).not.toBe(before.key)
  })

  it('changes the management scope key for a different original Zone even when the logical Topic ID is reused', () => {
    const f = fixture(), select = createWorkspaceAgentListSelector(f.resolve), before = select(f.state, f.scratch)
    const path = fixturePath('scope/replacement-topic-home'), topic = { ...f.topics[0]!, identityDirectoryPath: path,
      physicalDirectoryPath: path, confirmedDirectoryPaths: [path] }, source = directoryIdentity(f.scratch.hostId, path), zoneId = homeZoneId(source)
    const bindings = { ...f.state.spaceZoneBindings }
    const old = bindings[f.original(f.topics[0]!).zoneId]!
    delete bindings[f.original(f.topics[0]!).zoneId]
    bindings[zoneId] = { ...old, spaceId: source, directoryPath: path }
    const state = { ...f.state, spaceZoneBindings: bindings,
      workbenchSpaceSelection: { ...f.state.workbenchSpaceSelection!, zoneId },
      scratchTopicSnapshots: { [f.scratch.id]: { ...f.state.scratchTopicSnapshots[f.scratch.id]!, topics: [topic, ...f.topics.slice(1)] } } }
    expect(select(state, f.scratch).key).not.toBe(before.key)
  })

  it('preserves global Scratch and Project membership, including original Project Space bindings', () => {
    const f = fixture(), state = { ...f.state, workbenchSpaceSelection: null }, select = createWorkspaceAgentListSelector(f.resolve)
    expect(subjects(select(state, f.scratch).sessions)).toEqual([
      'local:mote-agent', 'local:one-closed', 'local:one-open', 'local:project-agent', 'local:root-agent', 'local:two-agent', 'remote:same-sid'
    ])
    expect(subjects(select(state, f.project).sessions)).toEqual(['local:project-agent'])
    const linked = { ...state, spaceZoneBindings: { ...state.spaceZoneBindings, [f.remoteZone]: {
      ...state.spaceZoneBindings[f.remoteZone]!, relations: { [directoryIdentity(f.project.hostId, f.project.path)]: true } } } }
    expect(subjects(select(linked, f.project).sessions)).toEqual(['local:project-agent', 'remote:same-sid'])
  })

  it('does not let the current Mote presentation grant unrelated public Project ordering membership', () => {
    const f = fixture(), selected = { ...f.state, workbenchSpaceSelection: {
      ...f.choose(f.topics[2]!), workspaceId: f.project.id, zoneId: f.projectZone,
      tabId: 'project', regionId: 'project-region', groupId: 'project-group'
    } }
    const withoutSelection = workspaceAgentListMembers({ ...selected, workbenchSpaceSelection: null }, f.project, f.resolve)
    expect(subjects(withoutSelection)).toEqual(['local:project-agent'])
    expect(subjects(workspaceAgentListMembers(selected, f.project, f.resolve))).toEqual(subjects(withoutSelection))
  })

  it('shares the immutable directory and canonical Session indexes across selectors and preserves unaffected result references', () => {
    const f = fixture(), cost = { passes: 0, filters: 0 }
    const source = new Proxy([...f.state.sessions, ...Array.from({ length: 500 }, (_, index) => agent(`outside-${index}`, fixturePath(`scope/other-${index}`)))], {
      get(target, key, receiver) { if (key === 'filter') cost.filters++
        if (key === Symbol.iterator) return function* () { cost.passes++; yield* target }
        return Reflect.get(target, key, receiver) }
    })
    const state = { ...f.state, sessions: source }, selectors = Array.from({ length: 8 }, () => createWorkspaceAgentListSelector(f.resolve))
    const first = selectors.map(select => select(state, f.scratch))
    for (let index = 0; index < 20; index++) selectors.forEach((select, at) => expect(select({ ...state }, f.scratch)).toBe(first[at]))
    // One directory index and one canonical Session index, shared by all eight projections.
    expect(cost).toEqual({ passes: 2, filters: 0 })
    const next = { ...state, sessions: source.map(session => session.id === 'outside-0' ? { ...session, latestOutputBytes: 200 } : session) }
    selectors.forEach((select, at) => expect(select(next, f.scratch)).toBe(first[at]))
  })

  it('shares one observed metadata path index and retains unchanged original member references', () => {
    const f = fixture(), cost = { passes: 0 }
    class ObservedMetadata extends Map<string, AgentSessionHistoryDescriptor> {
      override *values(): MapIterator<AgentSessionHistoryDescriptor> { cost.passes++; yield* super.values() }
    }
    const sources = new ObservedMetadata(Array.from({ length: 500 }, (_, index) => {
      const id = 'retained-' + index, value: AgentSessionHistoryDescriptor = { agentSessionId: id, hostId: 'local', state: 'retired',
        history: { providerId: 'codex', executorId: 'codex', workspacePath: index ? fixturePath('scope/irrelevant-' + index) : f.project.path, createdAt: 1 } }
      return [JSON.stringify(['local', id]), value] as const
    }))
    const state = { ...f.state, workbenchSpaceSelection: null }, selectors = Array.from({ length: 8 }, () => createWorkspaceAgentListSelector(f.resolve))
    const before = selectors.map(select => select(state, f.project, state.sessions, sources))
    for (let index = 0; index < 20; index++) selectors.forEach((select, at) => expect(select({ ...state }, f.project, state.sessions, sources)).toBe(before[at]))
    expect(cost.passes).toBe(1)
    expect(before.every(list => list.members.some(member => member.subject.agentSessionId === 'retained-0' && member.basis === 'workspace'))).toBe(true)
    expect(before.every(list => !list.sessions.some(session => session.id.startsWith('retained-')))).toBe(true)
    const updated = state.sessions.map(session => session.id === 'project-agent' ? { ...session, updatedAt: 3 } : session)
    for (const [at, select] of selectors.entries()) {
      const after = select({ ...state, sessions: updated }, f.project, updated, sources)
      expect(after.members).toBe(before[at]!.members)
    }
    expect(cost.passes).toBe(1)
  })
})
