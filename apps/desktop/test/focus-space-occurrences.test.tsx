// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { spatialCatalog as coreCatalog } from '@agentmux/core/spatial-graph'
import { parseAgentMuxControlRequest } from '../../../packages/core/src/control-codec'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
import { api } from '../src/renderer/src/lib/api'
import { agentRegionExecution, useAppStore } from '../src/renderer/src/store'
import * as executionOwner from '../src/renderer/src/store'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { workbenchSelectionCatalog } from '../src/renderer/src/lib/desktop-focus-navigation'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { createFocusContextIdentitySelector, focusContextIdentityKey, focusContextAtRegion } from '../src/renderer/src/lib/focus-context-identity'
import { deriveFocusProjectLanes, focusLanesByContext, focusProjectKey } from '../src/renderer/src/lib/focus-project-lanes'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { chooseFocusFilter, focusFilterOptions } from './fixtures/focus-filter-menu'
import type { FocusContext } from '../src/renderer/src/lib/focus-context'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses'
import { groupFocusTimeline, focusTimelineOrderCandidates } from '../src/renderer/src/lib/focus-history-timeline'
import { focusTimeSegments } from '../src/renderer/src/lib/focus-time-window'

// Retain actual Store, original spatial owner, Focus projection, filters, cards and navigation.
// PTY rendering and filesystem hierarchy reads are independent external leaves.
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))
vi.mock('../src/renderer/src/lib/use-focus-hierarchy', () => ({ useFocusHierarchy: () => ({ facts: { topics: {}, worktrees: [] }, errors: [] }) }))
const dom = composerDOM()
const home = { ...composerConfig.workspaces[0]!, id: 'source-home', name: 'Home', path: fixturePath('home') }
const project = { ...home, id: 'display-project', name: 'Human teams', path: fixturePath('projects/human-teams') }
const another = { ...home, id: 'other-project', name: 'Another project', path: fixturePath('projects/another') }
const farm = { ...home, id: 'farm-home', hostId: 'farm', name: 'Farm Home', path: fixturePath('farm/home') }
const original = { ...composerSession('original-split-agent'), hostId: 'farm', workspacePath: farm.path,
  control: { kind: 'agent' as const, hostId: 'farm', agentSessionId: 'original-native-sid', run: { runId: 'original-run' } },
  toolExecution: { bindingId: 'original-binding', resourceHostId: 'original-coordinator-local', resourceRuntimeId: 'original-local-runtime', workspacePath: home.path },
  workPlacement: { agentHostId: 'farm', resourceHostId: 'local' } }
const tab = createWorkbenchTab('source-home-tab', { kind: 'agent', phase: 'attached', regionId: 'original-region', workspaceId: home.id, sessionId: original.id })
const reference = { displayWorkspaceId: project.id, groupId: 'project-group', tabId: tab.id, regionId: 'original-region' }
async function refresh() {
  const graph = desktopSpatialGraph(useAppStore.getState(), [])
  vi.spyOn(api.spatial, 'read').mockResolvedValue({ schemaVersion: 1, revision: 1, graph })
  await initializeSpatialControlFixture()
  return graph
}
const rows = () => [...dom.container.querySelectorAll<HTMLElement>('.focus-project-board__live .focus-project-lanes__row')]
const card = () => dom.container.querySelector<HTMLButtonElement>('[data-session-id="original-split-agent"]')!
beforeEach(async () => {
  localStorage.clear()
  useAppStore.setState({ loading: false, mainSurface: 'agents', focusView: 'list',
    config: { ...composerConfig, hosts: [...composerConfig.hosts, { id: 'farm', kind: 'ssh', label: 'Farm', hostname: 'fixture.invalid' }], workspaces: [home, project, another, farm] },
    sessions: [original], timelines: {}, tabs: { [tab.id]: tab }, layouts: { [project.id]: createWorkspaceLayout(reference.groupId, [tab.id]) },
    agentNames: { [original.id]: 'Develop the original project' }, scratchTopicSnapshots: {}, spaceZoneBindings: {}, spatialRequests: {},
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } },
    agentComposerDrafts: { [original.id]: 'Original unsent task' } })
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  await refresh()
})
it('projects the exact displayed project across Hosts while preserving source Home and every execution byte', async () => {
  const state = useAppStore.getState(), originalBytes = JSON.stringify({ sessions: state.sessions, tabs: state.tabs, layouts: state.layouts, drafts: state.agentComposerDrafts })
  const contexts = createFocusProjectionSelector()(state).laneContexts
  const identities = createFocusContextIdentitySelector()(workbenchSelectionCatalog(state), state.tabs, contexts, state.config, state.layouts, agentRegionExecution, true)
  const identity = identities.get(focusContextIdentityKey('farm', original.id))!
  expect(identity.locations.status).toBe('confirmed')
  expect(identity.locations.occurrences).toEqual([expect.objectContaining({ source: expect.objectContaining({ workspaceId: home.id, hostId: 'local' }), display: { workspaceId: project.id, hostId: 'local', groupId: reference.groupId, tabId: tab.id, regionId: reference.regionId } })])
  await dom.render(<GlobalFocusSurface currentReference={reference} />)
  expect(rows()).toHaveLength(1)
  expect(rows()[0]!.dataset.projectKey).toBe(focusProjectKey('local', project.id))
  expect(rows()[0]!.textContent).toContain('Human teams')
  expect(rows()[0]!.dataset.focusCurrent).toBe('true')
  expect(card()).not.toBeNull()
  expect(rows()[0]!.textContent).not.toContain('Farm Home')
  expect(JSON.stringify({ sessions: useAppStore.getState().sessions, tabs: useAppStore.getState().tabs, layouts: useAppStore.getState().layouts, drafts: useAppStore.getState().agentComposerDrafts })).toBe(originalBytes)
})
it('retains every display project, filters by the set, and never gives Mobile a principal project', async () => {
  useAppStore.setState(state => ({ layouts: { ...state.layouts, [another.id]: createWorkspaceLayout('another-group', [tab.id]) } }))
  await refresh()
  await dom.render(<GlobalFocusSurface currentReference={reference} />)
  expect(rows()).toHaveLength(2)
  expect(rows().map(row => row.dataset.projectKey)).toEqual([focusProjectKey('local', project.id), focusProjectKey('local', another.id)])
  const options = await focusFilterOptions(dom.container, 'project')
  for (const id of [project.id, another.id]) expect(options.find(option => option.value === focusProjectKey('local', id))?.text).toMatch(/ · 1$/u)
  await chooseFocusFilter(dom.container, 'project', focusProjectKey('local', another.id))
  expect(rows()).toHaveLength(1); expect(rows()[0]!.dataset.projectKey).toBe(focusProjectKey('local', another.id))
  const result = await useAppStore.getState().executeControl(parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'read-original-presentation', operation: 'space.ls', target: {}, presentation: true }))
  expect(result.operation).toBe('space.ls')
  if (result.operation !== 'space.ls') throw Error('Expected the original space reader')
  expect(result.catalog.agentPresentation?.find(value => value.agentSessionId === original.control.agentSessionId)?.projectGroup).toBeUndefined()
  expect(useAppStore.getState().sessions[0]!.control).toEqual(original.control)
})
it('publishes a unique confirmed project through the original Store spatial presentation consumer', async () => {
  const result = await useAppStore.getState().executeControl(parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'read-unique-presentation', operation: 'space.ls', target: {}, presentation: true }))
  expect(result.operation).toBe('space.ls')
  if (result.operation !== 'space.ls') throw Error('Expected the original space reader')
  expect(result.catalog.agentPresentation?.find(value => value.agentSessionId === original.control.agentSessionId)?.projectGroup).toMatchObject({ hostId: 'local', projectId: project.id, name: project.name })
})
it('keeps the detached original Folder and exact execution project without opening a workface', async () => {
  const unplaced = { ...composerSession('unplaced-project-agent'), workspacePath: project.path }
  useAppStore.setState({ sessions: [original, unplaced] })
  useAppStore.setState({ layouts: {} }); await refresh()
  useAppStore.setState(state => ({ config: { ...state.config!, workspaces: state.config!.workspaces.filter(workspace => workspace.id !== home.id) } }))
  const previous = useAppStore.getState()
  await dom.render(<GlobalFocusSurface />)
  expect(rows().map(row => row.dataset.projectKey)).toEqual(expect.arrayContaining([
    focusProjectKey('local', home.id), focusProjectKey('local', project.id)
  ]))
  expect(rows()).toHaveLength(2)
  expect(card().closest('[data-project-key]')?.getAttribute('data-project-key')).toBe(focusProjectKey('local', home.id))
  expect(card().getAttribute('aria-description')).toContain('No open workface')
  expect(card().querySelector('.focus-context__position')).toBeNull()
  const store = useAppStore.getState()
  const contexts = createFocusProjectionSelector()(store).laneContexts
  const identities = createFocusContextIdentitySelector()(workbenchSelectionCatalog(store), store.tabs, contexts, store.config, store.layouts,
    agentRegionExecution, true, executionOwner.currentCoreSpatialGraph())
  const timeline = groupFocusTimeline(contexts, deriveFocusProjectLanes(contexts, store.config, undefined, identities), new Map())
  expect(timeline.find(group => group.key === focusProjectKey('local', home.id))?.tracks.map(track => track.sessionId)).toEqual([original.id])
  expect(timeline.find(group => group.key === focusProjectKey('local', project.id))?.tracks.map(track => track.sessionId)).toEqual([unplaced.id])
  expect(rows().some(row => row.dataset.focusCurrent === 'true')).toBe(false)
  const source = { clientId: 'original-client', rendererId: 'original-renderer', documentGeneration: 1 }
  const focus = await store.executeControl({ schemaVersion: 5, requestId: 'read-placed-members', operation: 'focus.read', source,
    input: { scope: { kind: 'project', hostId: 'local', projectSpaceId: directoryIdentity(project.hostId, project.path) }, selection: { kind: 'all' } } })
  expect(focus).toMatchObject({ operation: 'focus.read', page: { items: [{ reference: { hostId: 'local', contextId: unplaced.id },
    availability: 'observed', locations: { status: 'confirmed', occurrences: [] } }] } })
  const bound = await store.executeControl({ schemaVersion: 5, requestId: 'read-original-folder-members', operation: 'focus.read', source,
    input: { scope: { kind: 'project', hostId: 'local', projectSpaceId: directoryIdentity(home.hostId, home.path) }, selection: { kind: 'all' } } })
  expect(bound).toMatchObject({ operation: 'focus.read', page: { items: [{ reference: { hostId: 'farm', contextId: original.id },
    availability: 'observed', locations: { status: 'confirmed', occurrences: [] } }] } })
  const status = await store.executeControl(parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'read-project-status', operation: 'space.ls', target: {}, presentation: true }))
  expect(status.operation).toBe('space.ls')
  if (status.operation !== 'space.ls') throw Error('Expected the original space reader')
  expect(status.catalog.agentPresentation?.find(subject => subject.agentSessionId === original.control.agentSessionId)?.projectGroup).toMatchObject({ projectId: home.id })
  expect(status.catalog.agentPresentation?.find(subject => subject.agentSessionId === unplaced.id)?.projectGroup).toMatchObject({ projectId: project.id })
  expect(store.sessions).toBe(previous.sessions)
  expect(store.tabs).toBe(previous.tabs)
  expect(store.layouts).toBe(previous.layouts)
  expect(store.agentComposerDrafts).toBe(previous.agentComposerDrafts)
})
it('qualifies same SID by original Host, retains sets, and preserves a last confirmed relation only as unconfirmed', () => {
  const state = useAppStore.getState(), graph = desktopSpatialGraph(state, []), catalog = coreCatalog(graph)
  const base = createFocusProjectionSelector()(state).laneContexts[0]!
  const contexts: FocusContext[] = [{ ...base, id: 'same-sid', hostId: 'farm', control: { kind: 'agent', hostId: 'farm', agentSessionId: original.control.agentSessionId, run: { runId: 'farm-run' } } },
    { ...base, id: 'same-sid', hostId: 'local', control: { kind: 'agent', hostId: 'local', agentSessionId: original.control.agentSessionId, run: { runId: 'local-run' } } }]
  const localTab = createWorkbenchTab('local-source-tab', { kind: 'agent', phase: 'attached', regionId: 'local-region', workspaceId: home.id, sessionId: 'same-sid' })
  const tabs = { [tab.id]: { ...tab, regions: { [reference.regionId]: { ...tab.regions[reference.regionId]!, sessionId: 'same-sid' } } }, [localTab.id]: localTab }
  const localFact = { ...catalog.regions[0]!, tabId: localTab.id, regionId: 'local-region' }
  const joined = { ...catalog, regions: [...catalog.regions, localFact], locations: [...catalog.locations,
    { ...catalog.locations[0]!, displayWorkspaceId: another.id, groupId: 'another-group', tabId: localTab.id, regionId: 'local-region' }] }
  const select = createFocusContextIdentitySelector(), executionFor = ({ tabId }: { tabId: string }) => ({ hostId: tabId === localTab.id ? 'local' : 'farm' })
  const held = select(joined, tabs, contexts, state.config, state.layouts, executionFor, true)
  expect(held.get(focusContextIdentityKey('farm', 'same-sid'))!.locations.occurrences.map(value => value.display.workspaceId)).toEqual([project.id])
  expect(held.get(focusContextIdentityKey('local', 'same-sid'))!.locations.occurrences.map(value => value.display.workspaceId)).toEqual([another.id])
  const lanes = deriveFocusProjectLanes(contexts, state.config, undefined, held, Date.now())
  const byContext = focusLanesByContext(lanes)
  expect(byContext.get(focusContextIdentityKey('farm', 'same-sid'))!.map(lane => lane.workspaceId)).toEqual([project.id])
  expect(byContext.get(focusContextIdentityKey('local', 'same-sid'))!.map(lane => lane.workspaceId)).toEqual([another.id])
  const unknown = select(joined, tabs, contexts, state.config, state.layouts, () => null, true)
  expect(unknown.get(focusContextIdentityKey('farm', 'same-sid'))!.locations).toEqual({ status: 'unconfirmed', occurrences: held.get(focusContextIdentityKey('farm', 'same-sid'))!.locations.occurrences })
  expect(unknown.get(focusContextIdentityKey('farm', 'same-sid'))!.occurrenceCount).toBe(0)
})
it('invalidates original execution qualification without new topology and never uses the first matching SID', () => {
  const state = useAppStore.getState(), contexts = createFocusProjectionSelector()(state).laneContexts
  const catalog = workbenchSelectionCatalog(state), select = createFocusContextIdentitySelector()
  const graph = desktopSpatialGraph(state, [])
  let hostId: string | null = 'farm'
  const executionFor = vi.fn(() => hostId ? { hostId } : null)
  const first = select(catalog, state.tabs, contexts, state.config, state.layouts, executionFor, true, graph)
  expect(first.get(focusContextIdentityKey('farm', original.id))!.locations.status).toBe('confirmed')
  hostId = null
  const next = select(catalog, state.tabs, contexts, state.config, state.layouts, executionFor, true, { ...graph })
  expect(next.get(focusContextIdentityKey('farm', original.id))!.locations.status).toBe('unconfirmed')
  expect(next.get(focusContextIdentityKey('farm', original.id))!.occurrenceCount).toBe(0)
})
it('reuses the topology join across activity updates at independent Session and position sizes', () => {
  const state = useAppStore.getState(), base = createFocusProjectionSelector()(state).laneContexts[0]!
  for (const [count, copies] of [[8, 3], [80, 7]]) {
    const contexts = Array.from({ length: count! }, (_, i) => ({ ...base, id: 'agent-' + i, hostId: i % 2 ? 'farm' : 'local',
      control: { kind: 'agent' as const, hostId: i % 2 ? 'farm' : 'local', agentSessionId: 'sid-' + i, run: { runId: 'original-' + i } } }))
    const tabs = Object.fromEntries(contexts.map(context => { const value = createWorkbenchTab('tab-' + context.id,
      { kind: 'agent', phase: 'attached', regionId: 'region-' + context.id, workspaceId: home.id, sessionId: context.id }); return [value.id, value] }))
    const layouts = Object.fromEntries(Array.from({ length: copies! }, (_, index) => [index ? another.id + index : project.id,
      createWorkspaceLayout('group-' + index, Object.keys(tabs))]))
    const graph = desktopSpatialGraph({ ...state, sessions: [], tabs, layouts }, [])
    const catalog = coreCatalog(graph), executionFor = vi.fn(({ tabId }: { tabId: string }) => ({ hostId: Number(tabId.slice('tab-agent-'.length)) % 2 ? 'farm' : 'local' }))
    const select = createFocusContextIdentitySelector(), first = select(catalog, tabs, contexts, state.config, layouts, executionFor, true)
    expect(executionFor).toHaveBeenCalledTimes(count! * copies!)
    const subject = focusContextIdentityKey(contexts[0]!.hostId, contexts[0]!.id), held = first.get(subject)!
    expect(held.occurrenceCount).toBe(copies)
    executionFor.mockClear()
    const next = select(catalog, tabs, contexts.map((context, index) => index === 1 ? { ...context, detail: 'Only this unrelated activity changed' } : context), state.config, layouts, executionFor, true)
    expect(executionFor).not.toHaveBeenCalled()
    expect(next.get(subject)).toBe(held)
    expect(next.get(subject)!.locations).toBe(held.locations)
  }
})

it('does not aggregate changed relation topology in a hidden Focus view', async () => {
  await dom.render(<GlobalFocusSurface />)
  await dom.render(<GlobalFocusSurface visible={false} />)
  const reads = vi.spyOn(executionOwner, 'agentRegionExecution')
  await act(async () => useAppStore.setState({ layouts: { [project.id]: createWorkspaceLayout('later-project-group', [tab.id]) } }))
  expect(reads).not.toHaveBeenCalled()
  await dom.render(<GlobalFocusSurface />)
  expect(reads).toHaveBeenCalled()
  expect(rows()[0]!.dataset.projectKey).toBe(focusProjectKey('local', project.id))
})
it('keeps two original Hosts with the same native SID distinct in real Focus and leaves SID-only public grouping unconfirmed', async () => {
  const twin = { ...composerSession('local-presentation-twin'), workspacePath: another.path,
    control: { kind: 'agent' as const, hostId: 'local', agentSessionId: original.control.agentSessionId, run: { runId: 'original-local-run' } } }
  const twinTab = createWorkbenchTab('local-twin-tab', { kind: 'agent', phase: 'attached', regionId: 'local-twin-region', workspaceId: another.id, sessionId: twin.id })
  useAppStore.setState(state => ({ sessions: [...state.sessions, twin], tabs: { ...state.tabs, [twinTab.id]: twinTab },
    layouts: { ...state.layouts, [another.id]: createWorkspaceLayout('local-twin-group', [twinTab.id]) } }))
  await refresh()
  await dom.render(<GlobalFocusSurface currentReference={reference} />)
  expect(rows()).toHaveLength(2)
  expect(rows().find(row => row.dataset.projectKey === focusProjectKey('local', project.id))?.querySelector('[data-session-id="original-split-agent"]')).not.toBeNull()
  expect(rows().find(row => row.dataset.projectKey === focusProjectKey('local', another.id))?.querySelector('[data-session-id="local-presentation-twin"]')).not.toBeNull()
  const result = await useAppStore.getState().executeControl(parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'read-colliding-sid-presentation', operation: 'space.ls', target: {}, presentation: true }))
  if (result.operation !== 'space.ls') throw Error('Expected the original space reader')
  const presentations = result.catalog.agentPresentation!.filter(value => value.agentSessionId === original.control.agentSessionId)
  expect(presentations).toHaveLength(2)
  expect(presentations.every(value => value.projectGroup === undefined)).toBe(true)
  expect(useAppStore.getState().sessions.map(session => session.control.run.runId)).toEqual(['original-run', 'original-local-run'])
})
it('coalesces one displayed project across Agent Hosts while retaining both exact members with the same native SID', async () => {
  const twin = { ...composerSession('same-project-local-agent'), workspacePath: project.path,
    control: { kind: 'agent' as const, hostId: 'local', agentSessionId: original.control.agentSessionId, run: { runId: 'same-project-local-run' } } }
  const twinTab = createWorkbenchTab('same-project-local-tab', { kind: 'agent', phase: 'attached', regionId: 'same-project-local-region', workspaceId: home.id, sessionId: twin.id })
  useAppStore.setState(state => ({ sessions: [...state.sessions, twin], tabs: { ...state.tabs, [twinTab.id]: twinTab },
    layouts: { [project.id]: createWorkspaceLayout(reference.groupId, [tab.id, twinTab.id]) } }))
  await refresh()
  await dom.render(<GlobalFocusSurface currentReference={reference} />)
  expect(rows()).toHaveLength(1)
  expect(rows()[0]!.dataset.projectKey).toBe(focusProjectKey('local', project.id))
  expect(rows()[0]!.querySelectorAll('button.focus-context[data-session-id]')).toHaveLength(2)
  expect([...rows()[0]!.querySelectorAll<HTMLElement>('[data-focus-agent-host]')].map(node => node.dataset.focusAgentHost).sort()).toEqual(['farm', 'local'])
  const options = await focusFilterOptions(dom.container, 'project')
  expect(options.find(option => option.value === focusProjectKey('local', project.id))?.text).toMatch(/ · 2$/u)
  expect(useAppStore.getState().sessions.map(session => session.control.run.runId)).toEqual(['original-run', 'same-project-local-run'])
})

it('qualifies the original Agent Terminal by exact Run and keeps its current project highlighted', async () => {
  const sourceSpaceId = directoryIdentity(home.hostId, home.path)
  const terminal = { ...firstTerminal(), space: { spaceId: sourceSpaceId, zoneId: workspaceZoneId(sourceSpaceId, home.id) } }
  function firstTerminal() { return createWorkbenchTab('agent-terminal-tab', { kind: 'terminal', regionId: 'agent-terminal-region', workspaceId: home.id, sessionId: original.id }) }
  const terminalReference = { displayWorkspaceId: project.id, groupId: reference.groupId, tabId: terminal.id, regionId: 'agent-terminal-region' }
  useAppStore.setState({ tabs: { [terminal.id]: terminal }, layouts: { [project.id]: createWorkspaceLayout(reference.groupId, [terminal.id]) } })
  await refresh()
  await dom.render(<GlobalFocusSurface currentReference={terminalReference} />)
  expect(rows()).toHaveLength(1)
  expect(rows()[0]!.dataset.projectKey).toBe(focusProjectKey('local', project.id))
  expect(rows()[0]!.dataset.focusCurrent).toBe('true')
  const state = useAppStore.getState(), contexts = createFocusProjectionSelector()(state).laneContexts
  expect(createFocusContextIdentitySelector()(workbenchSelectionCatalog(state), state.tabs, contexts, state.config, state.layouts, agentRegionExecution, true).get(focusContextIdentityKey('farm', original.id))?.occurrenceCount).toBe(1)
  expect(agentRegionExecution({ ...terminalReference, agentSessionId: original.control.agentSessionId, expectedRunId: 'another-original-run' })).toBeNull()
  expect(useAppStore.getState().sessions[0]!.control.run.runId).toBe('original-run')
})
it('uses one original qualified resolver for current and shown candidates without raw-SID or first-Host selection', () => {
  const state = useAppStore.getState(), base = createFocusProjectionSelector()(state).laneContexts[0]!
  const candidates = [{ ...base, id: 'shared-presentation-id' }, { ...base, id: 'shared-presentation-id', hostId: 'local',
    control: { kind: 'agent' as const, hostId: 'local', agentSessionId: original.control.agentSessionId, run: { runId: 'local-original-run' } } }]
  const qualify = ({ expectedRunId }: { expectedRunId?: string }) => expectedRunId === 'local-original-run' ? { hostId: 'local' } : null
  expect(focusContextAtRegion(candidates, reference, qualify)?.hostId).toBe('local')
  expect(focusContextAtRegion(candidates, reference, () => null)).toBeNull()
  expect(focusContextAtRegion([candidates[1]!, candidates[1]!], reference, qualify)).toBeNull()
})
it('groups the current timeline at the Project Host while original history and Agent control stay at their original Host', () => {
  const state = useAppStore.getState(), contexts = createFocusProjectionSelector()(state).laneContexts
  const identities = createFocusContextIdentitySelector()(workbenchSelectionCatalog(state), state.tabs, contexts, state.config, state.layouts, agentRegionExecution, true)
  const lanes = deriveFocusProjectLanes(contexts, state.config, undefined, identities)
  const now = Date.now(), entry = { sessionId: original.id, focusedAt: now - 1000, identity: { name: 'Original source observation', kind: 'agent' as const, providerId: 'codex', hostId: 'farm', workspacePath: farm.path, project: { id: farm.id, name: farm.name } } }
  const originalBytes = JSON.stringify(entry)
  const groups = groupFocusTimeline(contexts, lanes, focusTimeSegments([entry], { start: now - 2000, end: now + 1 }, now))
  const current = groups.find(group => group.key === focusProjectKey('local', project.id))!
  expect(current).toBeDefined()
  expect(current.tracks[0]!.current?.control).toEqual(original.control)
  expect(current.tracks[0]!.identity).toMatchObject({ hostId: 'farm', workspacePath: farm.path, project: { id: project.id, hostId: 'local' } })
  const previous = groups.find(group => group.key === focusProjectKey('farm', farm.id))!
  expect(previous.tracks[0]!.current).toBeUndefined(); expect(previous.tracks[0]!.segments).toHaveLength(1)
  expect(JSON.stringify(entry)).toBe(originalBytes)
  expect(focusTimelineOrderCandidates(contexts, lanes, [entry]).map(group => group.key)).toContain(focusProjectKey('local', project.id))
})
it('keeps same-SID current timeline tracks separate by Agent Host within one Project', () => {
  const state = useAppStore.getState(), base = createFocusProjectionSelector()(state).laneContexts[0]!
  const contexts = [{ ...base, id: 'same-sid' }, { ...base, id: 'same-sid', hostId: 'local', control: { kind: 'agent' as const, hostId: 'local', agentSessionId: 'same-sid', run: { runId: 'local-original-run' } } }]
  const lane = { id: 'one-project', workspaceId: project.id, projectId: project.id, projectWorkspaceId: project.id, hostId: 'local', path: project.path,
    name: project.name, labels: [project.name], topicId: null, recovery: null, summary: null,
    contextRefs: contexts.map(context => ({ hostId: context.hostId, id: context.id })), activeAgentRefs: contexts.map(context => ({ hostId: context.hostId, id: context.id })) }
  const groups = groupFocusTimeline(contexts, [lane], new Map())
  expect(groups).toHaveLength(1); expect(groups[0]!.key).toBe(focusProjectKey('local', project.id)); expect(groups[0]!.tracks).toHaveLength(2)
  expect(groups[0]!.tracks.map(track => track.current?.hostId).sort()).toEqual(['farm', 'local'])
  expect(new Set(groups[0]!.tracks.map(track => track.key)).size).toBe(2)
})

it('the actual shown-Region map action keeps the qualified Agent Host when a raw presentation SID is shared', async () => {
  const shared = 'shared-ui-sid', local = { ...original, id: shared, hostId: 'local', workspacePath: project.path,
    control: { kind: 'agent' as const, hostId: 'local', agentSessionId: original.control.agentSessionId, run: { runId: 'local-shared-run' } } }
  const remote = { ...original, id: shared }
  const subject = createWorkbenchTab('shown-remote-tab', { kind: 'agent', phase: 'attached', regionId: 'shown-remote-region', workspaceId: home.id, sessionId: shared })
  const location = { displayWorkspaceId: project.id, groupId: reference.groupId, tabId: subject.id, regionId: 'shown-remote-region' }
  useAppStore.setState({ sessions: [local, remote], tabs: { [subject.id]: subject }, layouts: { [project.id]: createWorkspaceLayout(reference.groupId, [subject.id]) } })
  await refresh()
  const catalog = workbenchSelectionCatalog(useAppStore.getState())
  await dom.render(<GlobalFocusSurface currentReference={location} workspaceOpen={false} presentation={{ issue: null, references: [location], projection: {
    entity: { kind: 'tab', tabId: subject.id }, presentationId: 'original-shown-region', displayWorkspaceId: project.id, catalog, selection: [location], onSelect() {}
  } }} />)
  await dom.click('[aria-label="Locate Agent in map"]')
  expect(useAppStore.getState().collaborationMapTarget).toMatchObject({ kind: 'focus', subject: { hostId: 'farm', agentSessionId: original.control.agentSessionId } })
  expect(useAppStore.getState().sessions.map(session => session.control.run.runId)).toEqual(['local-shared-run', 'original-run'])
})
