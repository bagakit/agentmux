const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { parseAgentMuxControlRequest, parseAgentMuxControlReceipt, type AgentMuxSpaceControlRequest } from '@agentmux/core'
import { rpcControlResult, parseRpcControlResult } from '../../../packages/core/src/rpc-business-codec'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AgentLaunchResult, AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { directoryIdentity, spatialSources, workspaceZoneId } from '../src/shared/space-addresses'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { dispatchWorkbenchCommand, focusedSessionId } from '../src/renderer/src/lib/workbench-shortcuts'
import { layoutForLogicalRegionFocus } from '../src/renderer/src/lib/region-focus'
import { agentCreationFixture } from './helpers/agent-creation-fixture'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'

const initial = useAppStore.getState()
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }],
  executors: { fixture: { label: 'Fixture', providerId: 'codex', command: 'fixture', args: [], env: {}, injectAgentMuxGuide: false } },
  workspaces: [{ id: 'repo', hostId: 'local', name: 'Repo', path: _hygiene_fixturePath("repo"), kind: 'folder' },
    { id: 'other', hostId: 'local', name: 'Other', path: _hygiene_fixturePath("other"), kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
function agent(id: string, cwd = _hygiene_fixturePath("repo")): Extract<SessionSnapshot, { kind: 'agent' }> {
  return { id, kind: 'agent', providerId: 'codex', executorId: 'fixture', hostId: 'local', workspacePath: cwd, label: id,
    capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, latestOutputBytes: 0, processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    control: { kind: 'agent', agentSessionId: id, hostId: 'local', run: { runId: `run:${id}` } } }
}
function launch(session: Extract<SessionSnapshot, { kind: 'agent' }>, requestId: string): AgentLaunchResult {
  return { created: { ...agentCreationFixture(session), creation: { createOperationId: requestId, initialPrompt: 'unknown' } },
    creation: { createOperationId: requestId, initialPrompt: 'confirmed' }, session,
    timeline: { agentSessionId: session.id, revision: 0, items: [] }, projectionFailures: [] }
}
function request(value: Record<string, unknown>): AgentMuxSpaceControlRequest {
  return parseAgentMuxControlRequest({ schemaVersion: 5, requestId: `private:${crypto.randomUUID()}`, ...value }) as AgentMuxSpaceControlRequest
}
async function control(value: Record<string, unknown>) { return await useAppStore.getState().executeControl(request(value)) }
let dispose: (() => void) | undefined
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto)
  localStorage.clear()
  useAppStore.setState({ ...initial, config: null, restoredWorkbench: null, spaceZoneBindings: {}, spatialRequests: {}, retainedSpatialFocus: null }, true)
  vi.spyOn(api.config, 'get').mockResolvedValue(structuredClone(config))
  vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  let spatial: Awaited<ReturnType<typeof api.spatial.read>> = null
  vi.spyOn(api.spatial, 'read').mockImplementation(async () => structuredClone(spatial))
  vi.spyOn(api.spatial, 'commit').mockImplementation(async input => {
    if ((spatial?.revision ?? 0) !== input.expectedRevision) throw new Error('Spatial state changed.')
    spatial = { schemaVersion: 1, revision: input.expectedRevision + 1, graph: structuredClone(input.graph) }
    return structuredClone(spatial)
  })
  vi.spyOn(api.spatial, 'onChange').mockImplementation(() => () => {})
  dispose = await useAppStore.getState().initialize()
})
afterEach(() => { dispose?.(); dispose = undefined; vi.restoreAllMocks(); useAppStore.setState(initial, true); vi.unstubAllGlobals() })

describe('public Desktop spatial Control owner', () => {
  it('generates a fixed-width Base58 identity at the real Desktop launch boundary', async () => {
    useAppStore.setState({ config: structuredClone(config), activeWorkspaceId: 'repo', mainSurface: 'workbench' })
    const created = vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(new Error('Creation receipt unavailable'))
    const zoneId = workspaceZoneId(directoryIdentity('local', _hygiene_fixturePath("other")), 'other')
    const receipt = await control({ operation: 'agent.open', content: { kind: 'new-agent', executorId: 'fixture' }, destination: { zoneId }, focus: false })
    if (receipt.operation !== 'agent.open') throw new Error('Wrong operation')
    expect(created).toHaveBeenCalledTimes(1)
    const agentSessionId = created.mock.calls[0]![0].agentSessionId!
    expect(agentSessionId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{17}$/u)
    expect(useAppStore.getState().spatialRequests[receipt.requestId]!.agentSessionId).toBe(agentSessionId)
    expect(created.mock.calls[0]![0]).toMatchObject({ workspacePath: _hygiene_fixturePath("other"), createOperationId: receipt.requestId })
    expect(receipt.issues).toContainEqual(expect.objectContaining({ message: 'Creation receipt unavailable' }))
  })

  it('discovers another Space without navigation or body/readiness reads, and opens its first Tab with one first prompt', async () => {
    useAppStore.setState({ activeWorkspaceId: 'repo', mainSurface: 'workbench', agentComposerDrafts: { untouched: 'kept' } })
    const snapshot = vi.spyOn(api.sessions, 'snapshot')
    const timeline = vi.spyOn(api.sessions, 'timeline')
    const refresh = vi.spyOn(api.sessions, 'refresh')
    const stop = vi.spyOn(api.sessions, 'stop')
    const created = vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async input => launch(agent(input.agentSessionId!, input.workspacePath), input.createOperationId!))
    const discovery = await control({ operation: 'space.ls', target: {} })
    if (discovery.operation !== 'space.ls') throw new Error('Wrong operation')
    expect(discovery.catalog.spaces.map(space => space.directoryPath)).toEqual([_hygiene_fixturePath("repo"), _hygiene_fixturePath("other")])
    const zoneId = discovery.catalog.zones.find(zone => zone.directoryPath === _hygiene_fixturePath("other"))!.zoneId
    const receipt = await control({ operation: 'agent.open', content: { kind: 'new-agent', executorId: 'fixture', prompt: 'first task' }, destination: { zoneId }, focus: false })
    if (receipt.operation !== 'agent.open') throw new Error('Wrong operation')
    expect(receipt.outcome).toBe('opened')
    expect(receipt.agent).toMatchObject({ cwd: _hygiene_fixturePath("other"), initialPrompt: 'confirmed' })
    expect(receipt.to).toMatchObject({ zoneId, workspaceId: 'other' })
    expect(receipt.save).toEqual({ layoutApplied: true, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'confirmed', reason: null })
    expect(created).toHaveBeenCalledTimes(1)
    expect(created.mock.calls[0]![0]).toMatchObject({ workspacePath: _hygiene_fixturePath("other"), prompt: 'first task', createOperationId: receipt.requestId })
    expect(useAppStore.getState().activeWorkspaceId).toBe('repo')
    expect(useAppStore.getState().agentComposerDrafts).toEqual({ untouched: 'kept' })
    expect(snapshot).not.toHaveBeenCalled()
    expect(timeline).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
    const stored = JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state
    expect(stored.restoredWorkbench).toBeUndefined()
    expect((await api.spatial.read())!.graph.tabs.find(tab => tab.tabId === receipt.to!.tabId)).toMatchObject({ zoneId })
    expect(stored.spatialRequests[receipt.requestId].agentSessionId).toBe(receipt.agent!.agentSessionId)
    expect(JSON.stringify(stored.spatialRequests)).not.toContain('first task')
  })

  it('returns reusable Zone candidates rather than guessing main/current, and checks parent consistency before effects', async () => {
    useAppStore.setState({ config: { ...config, workspaces: [...config.workspaces, { id: 'wt', name: 'branch', hostId: 'local', path: _hygiene_fixturePath("repo/.worktrees/b"), repoPath: _hygiene_fixturePath("repo"), kind: 'worktree', branch: 'b' }] } })
    const launchAgent = vi.spyOn(api.sessions, 'launchAgent')
    const ambiguous = await control({ operation: 'agent.open', content: { kind: 'new-agent', executorId: 'fixture' }, destination: { spaceId: directoryIdentity('local', _hygiene_fixturePath("repo")) }, focus: false })
    if (ambiguous.operation !== 'agent.open') throw new Error('Wrong operation')
    expect(ambiguous.issues[0]?.candidates).toEqual([
      { spaceId: directoryIdentity('local', _hygiene_fixturePath("repo")), zoneId: workspaceZoneId(directoryIdentity('local', _hygiene_fixturePath("repo")), 'repo') },
      { spaceId: directoryIdentity('local', _hygiene_fixturePath("repo")), zoneId: workspaceZoneId(directoryIdentity('local', _hygiene_fixturePath("repo")), 'wt') }])
    expect(useAppStore.getState().tabs).toEqual({})
    const conflicting = await control({ operation: 'agent.open', content: { kind: 'new-agent', executorId: 'fixture' },
      destination: { spaceId: directoryIdentity('local', _hygiene_fixturePath("other")), zoneId: ambiguous.issues[0]!.candidates![0]!.zoneId }, focus: false })
    if (conflicting.operation !== 'agent.open') throw new Error('Wrong operation')
    expect(conflicting.issues[0]?.code).toBe('SPACE_PARENT_MISMATCH')
    expect(launchAgent).not.toHaveBeenCalled()
  })

  it('moves exactly one projection across Space, consumes an empty Region, and keeps execution and another projection', async () => {
    const session = agent('a')
    const source = createWorkbenchTab('source', { regionId: 'source-region', kind: 'agent', phase: 'attached', workspaceId: 'repo', sessionId: 'a' })
    const duplicate = createWorkbenchTab('duplicate', { regionId: 'duplicate-region', kind: 'agent', phase: 'attached', workspaceId: 'other', sessionId: 'a' })
    const empty = createWorkbenchTab('empty', { regionId: 'empty-region', kind: 'launcher', workspaceId: 'other' })
    useAppStore.setState({ sessions: [session], tabs: { source, duplicate, empty },
      layouts: { repo: createWorkspaceLayout('g1', ['source']), other: createWorkspaceLayout('g2', ['duplicate', 'empty']) }, activeWorkspaceId: 'repo' })
    const stop = vi.spyOn(api.sessions, 'stop'); const start = vi.spyOn(api.sessions, 'launchAgent')
    const moved = await control({ operation: 'space.mv', fromRegionId: 'source-region', expectedAgentSessionId: 'a', destination: { regionId: 'empty-region' }, focus: false })
    if (moved.operation !== 'space.mv') throw new Error('Wrong operation')
    expect(moved.outcome).toBe('moved')
    expect(moved.to).toMatchObject({ tabId: 'empty', regionId: 'source-region', workspaceId: 'other' })
    expect(moved.agent).toMatchObject({ agentSessionId: 'a', runId: 'run:a', hostId: 'local', cwd: _hygiene_fixturePath("repo") })
    expect(useAppStore.getState().tabs.source).toBeUndefined()
    expect(Object.keys(useAppStore.getState().tabs.empty!.regions)).toEqual(['source-region'])
    expect(useAppStore.getState().tabs.duplicate).toEqual({ ...duplicate, space: { spaceId: directoryIdentity('local', _hygiene_fixturePath("other")), zoneId: workspaceZoneId(directoryIdentity('local', _hygiene_fixturePath("other")), 'other') } })
    expect(useAppStore.getState().sessions).toEqual([session])
    expect(stop).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled()
  })

  it.each([false, true])('preserves active-source logical focus and makes the next close/split neutral (split source=%s)', async split => {
    let source = createWorkbenchTab('source', { regionId: 'a', kind: 'agent', phase: 'attached', workspaceId: 'repo', sessionId: 'session-a' })
    if (split) {
      source = addWorkbenchRegion(source, 'a', 'right', { regionId: 'b', kind: 'agent', phase: 'attached', workspaceId: 'repo', sessionId: 'session-b' })
      source = addWorkbenchRegion(source, 'b', 'below', { regionId: 'c', kind: 'agent', phase: 'attached', workspaceId: 'repo', sessionId: 'session-c' })
    }
    source = { ...source, layout: { ...source.layout, activeRegionId: 'a' } }
    const other = createWorkbenchTab('other-tab', { regionId: 'c', kind: 'agent', phase: 'attached', workspaceId: 'repo', sessionId: 'session-c' })
    useAppStore.setState({ sessions: [agent('session-a'), agent('session-b'), agent('session-c')], tabs: { source, 'other-tab': other },
      layouts: { repo: createWorkspaceLayout('g', ['source', 'other-tab']), other: createWorkspaceLayout('g2') }, activeWorkspaceId: 'repo', mainSurface: 'workbench' })
    const selected = await useAppStore.getState().executeControl(parseAgentMuxControlRequest({ schemaVersion: 5,
      requestId: 'private-desktop-focus-before-move', operation: 'focus', target: { kind: 'space', regionId: 'a' } }))
    if (selected.operation !== 'focus') throw new Error('Wrong focus operation')
    expect(selected.navigation.selection.space).toMatchObject({ workspaceId: 'repo', tabId: 'source', regionId: 'a' })
    const beforeFocus = useAppStore.getState().agentFocus
    const moved = await control({ operation: 'space.mv', fromRegionId: 'a', expectedAgentSessionId: 'session-a', destination: { zoneId: workspaceZoneId(directoryIdentity('local', _hygiene_fixturePath("other")), 'other') }, focus: false })
    if (moved.operation !== 'space.mv') throw new Error('Wrong operation')
    expect(moved.outcome).toBe('moved')
    const state = useAppStore.getState()
    expect(state.activeWorkspaceId).toBe('repo'); expect(state.agentFocus).toEqual(beforeFocus)
    expect(state.retainedSpatialFocus).toMatchObject({ regionId: 'a', tabId: 'source', workspaceId: 'repo' })
    expect(state.workbenchSpaceSelection).toMatchObject({ spaceId: directoryIdentity('local', _hygiene_fixturePath("repo")),
      zoneId: workspaceZoneId(directoryIdentity('local', _hygiene_fixturePath("repo")), 'repo'), workspaceId: 'repo',
      tabId: split ? 'source' : null, groupId: split ? 'g' : null, regionId: null })
    expect(layoutForLogicalRegionFocus(state.layouts.repo!, state.tabs, state.retainedSpatialFocus).groups[0]?.activeTabId).toBe(split ? 'source' : null)
    if (split) expect(Object.keys(state.tabs.source!.regions)).toEqual(['b', 'c'])
    expect(focusedSessionId(state)).toBeNull()
    const close = vi.spyOn(state, 'requestCloseRegion'); const closeTab = vi.spyOn(state, 'requestCloseTab'); const add = vi.spyOn(state, 'splitRegion')
    expect(dispatchWorkbenchCommand({ kind: 'close-region' }, state)).toBe(false)
    expect(dispatchWorkbenchCommand({ kind: 'split', direction: 'right' }, state)).toBe(false)
    expect(close).not.toHaveBeenCalled(); expect(closeTab).not.toHaveBeenCalled(); expect(add).not.toHaveBeenCalled()
    useAppStore.getState().activateTab('repo', 'g', 'other-tab')
    expect(useAppStore.getState().retainedSpatialFocus).toBeNull()
    expect(focusedSessionId(useAppStore.getState())).toBe('session-c')
  })

  it('keeps a removed source neutral when its only leaf moves to another Tab in the same Zone', async () => {
    const source = createWorkbenchTab('source', { regionId: 'r', kind: 'agent', phase: 'attached', workspaceId: 'repo', sessionId: 'a' })
    useAppStore.setState({ sessions: [agent('a')], tabs: { source }, layouts: { repo: createWorkspaceLayout('g', ['source']) }, activeWorkspaceId: 'repo', mainSurface: 'workbench' })
    useAppStore.getState().focusRegion('repo', 'source', 'r')
    const beforeFocus = useAppStore.getState().agentFocus
    const moved = await control({ operation: 'space.mv', fromRegionId: 'r', expectedAgentSessionId: 'a',
      destination: { zoneId: workspaceZoneId(directoryIdentity('local', _hygiene_fixturePath("repo")), 'repo'), newTab: true }, focus: false })
    if (moved.operation !== 'space.mv') throw new Error('Wrong operation')
    expect(moved.outcome).toBe('moved'); expect(moved.to?.tabId).not.toBe('source')
    const state = useAppStore.getState()
    expect(state.tabs.source).toBeUndefined(); expect(state.agentFocus).toEqual(beforeFocus)
    expect(state.retainedSpatialFocus).toMatchObject({ tabId: 'source', regionId: 'r' })
    expect(layoutForLogicalRegionFocus(state.layouts.repo!, state.tabs, state.retainedSpatialFocus).groups[0]?.activeTabId).toBeNull()
    expect(focusedSessionId(state)).toBeNull()
    expect(dispatchWorkbenchCommand({ kind: 'close-region' }, state)).toBe(false)
  })

  it('binds self-unchanged intent, rejects changed input on that ID, and never copies or moves on replay', async () => {
    const source = createWorkbenchTab('source', { regionId: 'r', kind: 'agent', phase: 'attached', workspaceId: 'repo', sessionId: 'a' })
    useAppStore.setState({ sessions: [agent('a')], tabs: { source }, layouts: { repo: createWorkspaceLayout('g', ['source']) } })
    const same = request({ operation: 'space.mv', fromRegionId: 'r', expectedAgentSessionId: 'a', destination: { regionId: 'r' }, focus: false })
    const first = await useAppStore.getState().executeControl(same)
    expect(first).toMatchObject({ outcome: 'unchanged' })
    expect(await useAppStore.getState().executeControl(same)).toMatchObject({ outcome: 'unchanged' })
    const different = { ...same, destination: { zoneId: workspaceZoneId(directoryIdentity('local', _hygiene_fixturePath("other")), 'other') } }
    expect(await useAppStore.getState().executeControl(different)).toMatchObject({ issues: [{ code: 'SPACE_REQUEST_CONFLICT' }] })
    expect(useAppStore.getState().tabs).toEqual({ source: { ...source, space: { spaceId: directoryIdentity('local', _hygiene_fixturePath("repo")), zoneId: workspaceZoneId(directoryIdentity('local', _hygiene_fixturePath("repo")), 'repo') } } })
  })

  it('explicit focus navigates from another Workspace/Board to the exact visible target and clears held focus', async () => {
    useAppStore.setState({ activeWorkspaceId: 'repo', mainSurface: 'board', retainedSpatialFocus: {
      spaceId: directoryIdentity('local', _hygiene_fixturePath("repo")), zoneId: workspaceZoneId(directoryIdentity('local', _hygiene_fixturePath("repo")), 'repo'),
      workspaceId: 'repo', tabId: 'old', regionId: 'held' } })
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async input => launch(agent(input.agentSessionId!, _hygiene_fixturePath("other")), input.createOperationId!))
    const opened = await control({ operation: 'agent.open', content: { kind: 'new-agent', executorId: 'fixture' },
      destination: { zoneId: workspaceZoneId(directoryIdentity('local', _hygiene_fixturePath("other")), 'other') }, focus: true })
    if (opened.operation !== 'agent.open') throw new Error('Wrong operation')
    expect(useAppStore.getState().activeWorkspaceId).toBe('other')
    expect(useAppStore.getState().mainSurface).toBe('workbench')
    expect(useAppStore.getState().retainedSpatialFocus).toBeNull()
    expect(focusedSessionId(useAppStore.getState())).toBe(opened.agent!.agentSessionId)
    expect(useAppStore.getState().regionCaretFocus?.regionId).toBe(opened.to!.regionId)
  })

  it('classifies a newly focused Mote only after Core attachment and preserves the prior execution lane', async () => {
    useAppStore.setState({ config: { ...config, workspaces: [...config.workspaces,
      { id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Topics', path: _hygiene_fixturePath("scratch"), kind: 'folder' }] },
      sessions: [agent('execution')], agentFocus: { execution: { sessionId: 'execution', history: [{ sessionId: 'execution', focusedAt: 1 }] }, pmo: { sessionId: null } } })
    vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([{ id: PMO_TEAMS_TOPIC_ID, directoryPath: 'topic--launcher--leader',
      topicPath: 'topic--launcher--leader/topic.md', title: 'Mote', summary: '', collaborators: [] }])
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async input => {
      expect(input).toMatchObject({ workspacePath: _hygiene_fixturePath("scratch"), scratchTopicId: PMO_TEAMS_TOPIC_ID })
      expect(useAppStore.getState().agentFocus.execution.sessionId).toBe('execution')
      return launch(agent(input.agentSessionId!, _hygiene_fixturePath("scratch/topic--launcher--leader")), input.createOperationId!)
    })
    const opened = await control({ operation: 'agent.open', content: { kind: 'new-agent', executorId: 'fixture' },
      destination: { spaceId: directoryIdentity('local', _hygiene_fixturePath("scratch/topic--launcher--leader")) }, focus: true })
    if (opened.operation !== 'agent.open') throw new Error('Wrong operation')
    expect(useAppStore.getState().agentFocus).toEqual({ execution: { sessionId: 'execution', history: [{ sessionId: 'execution', focusedAt: 1 }] },
      pmo: { sessionId: opened.agent!.agentSessionId } })
    expect(useAppStore.getState().activeWorkspaceId).toBe(SCRATCH_WORKSPACE_ID)
  })

  it('a delayed focused launch does not take back the Workspace or lane after explicit navigation elsewhere', async () => {
    let fulfill!: (result: AgentLaunchResult) => void
    let input: Parameters<typeof api.sessions.launchAgent>[0] | undefined
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(value => { input = value; return new Promise(resolve => { fulfill = resolve }) })
    const opening = control({ operation: 'agent.open', content: { kind: 'new-agent', executorId: 'fixture' },
      destination: { zoneId: workspaceZoneId(directoryIdentity('local', _hygiene_fixturePath("other")), 'other') }, focus: true })
    await vi.waitFor(() => expect(input).toBeDefined())
    await useAppStore.getState().selectWorkspace('repo')
    useAppStore.setState({ mainSurface: 'board' })
    const focus = useAppStore.getState().agentFocus
    fulfill(launch(agent(input!.agentSessionId!, _hygiene_fixturePath("other")), input!.createOperationId!))
    await opening
    expect(useAppStore.getState().activeWorkspaceId).toBe('repo')
    expect(useAppStore.getState().mainSurface).toBe('board')
    expect(useAppStore.getState().agentFocus).toEqual(focus)
  })

  it('does not assign another Session projection to an Agent that finishes after the exact Region was rebound', async () => {
    let fulfill!: (result: AgentLaunchResult) => void
    let launchedInput: Parameters<typeof api.sessions.launchAgent>[0] | undefined
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(input => {
      launchedInput = input
      return new Promise(resolve => { fulfill = resolve })
    })
    const stop = vi.spyOn(api.sessions, 'stop')
    const opening = control({ operation: 'agent.open', content: { kind: 'new-agent', executorId: 'fixture', prompt: 'one task' },
      destination: { zoneId: workspaceZoneId(directoryIdentity('local', _hygiene_fixturePath("other")), 'other') }, focus: false })
    await vi.waitFor(() => expect(launchedInput).toBeDefined())
    const tab = Object.values(useAppStore.getState().tabs)[0]!
    const regionId = Object.keys(tab.regions)[0]!
    useAppStore.setState(state => ({ sessions: [agent('replacement', _hygiene_fixturePath("other"))], tabs: { ...state.tabs,
      [tab.id]: { ...tab, regions: { ...tab.regions, [regionId]: { ...tab.regions[regionId]!, kind: 'agent', phase: 'attached', workspaceId: 'other', sessionId: 'replacement' } } } } }))
    fulfill(launch(agent(launchedInput!.agentSessionId!, _hygiene_fixturePath("other")), launchedInput!.createOperationId!))
    const receipt = await opening
    expect(receipt).toMatchObject({ outcome: 'partial', to: null, agent: { agentSessionId: launchedInput!.agentSessionId }, issues: [{ code: 'SPACE_PLACEMENT_UNKNOWN' }] })
    expect(useAppStore.getState().tabs[tab.id]!.regions[regionId]).toMatchObject({ kind: 'agent', sessionId: 'replacement' })
    expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(['replacement', launchedInput!.agentSessionId])
    expect(useAppStore.getState().displacedAgentSessionIds).toContain(launchedInput!.agentSessionId)
    expect(stop).not.toHaveBeenCalled()
  })

  it('retains a healthy Agent when the caller aborts and returns partial first-prompt/projection/save facts without stop', async () => {
    const abort = new AbortController()
    const stop = vi.spyOn(api.sessions, 'stop')
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async input => {
      abort.abort(new Error('Lost caller'))
      return { ...launch(agent(input.agentSessionId!, input.workspacePath), input.createOperationId!),
        creation: { createOperationId: input.createOperationId!, initialPrompt: 'unconfirmed' }, projectionFailures: [{ step: 'timeline', message: 'Display read failed' }] }
    })
    const input = request({ operation: 'agent.open', content: { kind: 'new-agent', executorId: 'fixture', prompt: 'first only' },
      destination: { zoneId: workspaceZoneId(directoryIdentity('local', _hygiene_fixturePath("other")), 'other') }, focus: false })
    const result = await useAppStore.getState().executeControl(input, abort.signal)
    expect(result).toMatchObject({ outcome: 'partial', agent: { initialPrompt: 'unconfirmed' } })
    if (result.operation !== 'agent.open') throw new Error('Wrong operation')
    expect(result.issues.map(issue => issue.code)).toEqual(['AGENT_DISPLAY_UNCONFIRMED', 'INITIAL_PROMPT_UNCONFIRMED', 'CONTROL_RECEIPT_INTERRUPTED'])
    expect(useAppStore.getState().sessions.map(session => session.id)).toEqual([result.agent!.agentSessionId])
    expect(useAppStore.getState().tabs[result.to!.tabId]?.regions[result.to!.regionId]).toMatchObject({ phase: 'attached', sessionId: result.agent!.agentSessionId })
    expect(stop).not.toHaveBeenCalled()
    expect(useAppStore.getState().error).toContain('Inspect the request ID')
  })

  it('same request and inspection read original Core owner without respawn/resend, even after a later cross-host display move', async () => {
    const created = vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async input => launch(agent(input.agentSessionId!, input.workspacePath), input.createOperationId!))
    const input = request({ operation: 'agent.open', content: { kind: 'new-agent', executorId: 'fixture', prompt: 'once' }, destination: { zoneId: workspaceZoneId(directoryIdentity('local', _hygiene_fixturePath("other")), 'other') }, focus: false })
    const creation = vi.spyOn(api.sessions, 'creation').mockImplementation(async (_host, id) => ({ ...agentCreationFixture(agent(id, _hygiene_fixturePath("other"))), creation: { createOperationId: input.requestId, initialPrompt: 'confirmed' } }))
    const opened = await useAppStore.getState().executeControl(input)
    if (opened.operation !== 'agent.open') throw new Error('Wrong operation')
    const replay = await useAppStore.getState().executeControl(input)
    expect(replay).toMatchObject({ outcome: 'opened', to: opened.to })
    expect(created).toHaveBeenCalledTimes(1)
    const conflict = await useAppStore.getState().executeControl({ ...input,
      content: { kind: 'new-agent', executorId: 'fixture', prompt: 'A different task on the existing ID' } } as AgentMuxSpaceControlRequest)
    expect(conflict).toMatchObject({ issues: [{ code: 'SPACE_REQUEST_CONFLICT' }] })
    expect(useAppStore.getState().spatialRequests[input.requestId]!.originalFailure).toBeUndefined()
    useAppStore.setState(state => ({ config: { ...state.config!, hosts: [...state.config!.hosts, { id: 'remote', kind: 'ssh', label: 'Remote', hostname: 'private.invalid', user: 'fixture', port: 22 }],
      workspaces: [...state.config!.workspaces, { id: 'remote-dir', hostId: 'remote', name: 'Remote', path: _hygiene_fixturePath("remote"), kind: 'folder' }] } }))
    await control({ operation: 'space.mv', fromRegionId: opened.to!.regionId, expectedAgentSessionId: opened.agent!.agentSessionId,
      destination: { zoneId: workspaceZoneId(directoryIdentity('remote', _hygiene_fixturePath("remote")), 'remote-dir') }, focus: false })
    const inspected = await control({ operation: 'space.inspect', target: { requestId: input.requestId } })
    expect(inspected).toMatchObject({ request: { known: true, report: { outcome: 'unknown', agent: { hostId: 'local', cwd: _hygiene_fixturePath("other") } } } })
    expect(creation.mock.calls.map(call => call[0])).toEqual(['local', 'local'])
    expect(created).toHaveBeenCalledTimes(1)
  })

  it('retains the first launch error across persistence reload and public readback without replaying', async () => {
    const original = Object.assign(new Error('Runtime durable database is full'), { code: 'CTXMUX_DURABILITY_FAILED' })
    const created = vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(original)
    const stop = vi.spyOn(api.sessions, 'stop')
    vi.spyOn(api.sessions, 'creation').mockRejectedValue(new Error('No confirmed Session or prepared start'))
    const input = request({ operation: 'agent.open', content: { kind: 'new-agent', executorId: 'fixture', prompt: 'Do not replay this task' },
      destination: { zoneId: workspaceZoneId(directoryIdentity('local', _hygiene_fixturePath("other")), 'other') }, focus: false })
    const failed = await useAppStore.getState().executeControl(input)
    if (failed.operation !== 'agent.open') throw new Error('Wrong operation')
    expect(failed.issues[0]).toMatchObject({ step: 'owner', code: original.code, message: original.message })
    const persisted = localStorage.getItem('agentmux-workbench-v1')!
    const binding = JSON.parse(persisted).state.spatialRequests[input.requestId]
    expect(binding.originalFailure).toEqual(failed.issues[0])
    expect(persisted).not.toContain('Do not replay this task')
    const before = { tabs: useAppStore.getState().tabs, layouts: useAppStore.getState().layouts }
    useAppStore.setState({ spatialRequests: {} })
    await useAppStore.getState().retryWorkbenchSave()
    localStorage.setItem('agentmux-workbench-v1', persisted)
    await useAppStore.persist.rehydrate()
    expect(useAppStore.getState().spatialRequests[input.requestId]!.originalFailure).toEqual(failed.issues[0])
    const query = request({ operation: 'space.inspect', target: { requestId: input.requestId } })
    const inspected = await useAppStore.getState().executeControl(query)
    if (inspected.operation !== 'space.inspect') throw new Error('Wrong operation')
    const receipt = parseAgentMuxControlReceipt({ schemaVersion: 5, requestId: query.requestId, ok: true, operation: inspected.operation,
      result: Object.fromEntries(Object.entries(inspected).filter(([key]) => key !== 'operation')) }, query)
    expect(receipt).toMatchObject({ result: { request: { report: { outcome: 'unknown', issues: [
      { step: 'original-owner', code: original.code, message: 'Original operation failure: Runtime durable database is full' },
      { step: 'creation-read', message: 'Current creation check: No confirmed Session or prepared start' }
    ] } } } })
    const wire = rpcControlResult('space.inspect', inspected)
    const publicResult = parseRpcControlResult('space.inspect', wire, { target: { operationId: input.requestId } })
    expect(publicResult).toMatchObject({ request: { operationId: input.requestId, report: {
      operationId: input.requestId, issues: inspected.request!.report!.issues
    } } })
    const repeated = await useAppStore.getState().executeControl(input)
    expect(repeated).toMatchObject({ issues: inspected.request!.report!.issues })
    expect(useAppStore.getState().tabs).toEqual(before.tabs)
    expect(useAppStore.getState().layouts).toEqual(before.layouts)
    expect(created).toHaveBeenCalledTimes(1)
    expect(stop).not.toHaveBeenCalled()
  })

  it('keeps the original failure visible when saving the failure receipt is unavailable', async () => {
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async () => {
      vi.mocked(api.ui.requestStorageFlush).mockRejectedValue(new Error('Failure receipt flush unavailable'))
      throw new Error('Original launch response unavailable')
    })
    const failed = await control({ operation: 'agent.open', content: { kind: 'new-agent', executorId: 'fixture' },
      destination: { zoneId: workspaceZoneId(directoryIdentity('local', _hygiene_fixturePath("other")), 'other') }, focus: false })
    expect(failed).toMatchObject({ outcome: 'partial', save: { diskDurability: 'unconfirmed', storageFlushRequested: false }, issues: [
      { step: 'owner', message: 'Original launch response unavailable' },
      { step: 'failure-save', code: 'SPACE_FAILURE_SAVE_UNCONFIRMED', message: 'Failure receipt flush unavailable' }
    ] })
    expect(useAppStore.getState().spatialRequests[failed.requestId]!.originalFailure?.message).toBe('Original launch response unavailable')
    expect(api.sessions.launchAgent).toHaveBeenCalledTimes(1)
  })

  it('launches a selected remote Workspace below a local Region and retains its resource through display moves and operation readback', async () => {
    const local = createWorkbenchTab('local-tab', { kind: 'agent', phase: 'attached', regionId: 'local-region', workspaceId: 'repo', sessionId: 'local-agent' })
    useAppStore.setState({ config: { ...config, hosts: [...config.hosts, { id: 'remote', kind: 'ssh', label: 'Remote', hostname: 'fixture.invalid' }],
      workspaces: [...config.workspaces, { id: 'remote-workspace', hostId: 'remote', name: 'Remote', path: _hygiene_fixturePath("remote/repo"), kind: 'folder' }] },
      sessions: [agent('local-agent')], tabs: { [local.id]: local }, layouts: { repo: createWorkspaceLayout('local-group', [local.id]) } })
    const created = vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async input => {
      const session = { ...agent(input.agentSessionId!, input.workspacePath), hostId: input.hostId,
        control: { kind: 'agent' as const, hostId: input.hostId, agentSessionId: input.agentSessionId!, run: { runId: 'remote-run' } } }
      return launch(session, input.createOperationId!)
    })
    const creation = vi.spyOn(api.sessions, 'creation').mockImplementation(async (hostId, id) => ({
      ...agentCreationFixture({ ...agent(id, _hygiene_fixturePath("remote/repo")), hostId }), creation: { createOperationId: input.requestId, initialPrompt: 'confirmed' }
    }))
    const input = request({ operation: 'agent.open', content: { kind: 'new-agent', executorId: 'remote-only', executionWorkspaceId: 'remote-workspace', prompt: 'once' },
      destination: { regionId: 'local-region', split: 'down' }, focus: false })
    const result = await useAppStore.getState().executeControl(input)
    expect(result).toMatchObject({ operation: 'agent.open', outcome: 'opened', agent: { hostId: 'remote', cwd: _hygiene_fixturePath("remote/repo") },
      to: { tabId: local.id, workspaceId: 'repo', displayWorkspaceId: 'repo' } })
    if (result.operation !== 'agent.open') throw new Error('Wrong operation')
    expect(created).toHaveBeenCalledTimes(1)
    expect(created.mock.calls[0]![0]).toMatchObject({ hostId: 'remote', workspacePath: _hygiene_fixturePath("remote/repo"), executorId: 'remote-only', prompt: 'once' })
    expect(created.mock.calls[0]![0]).not.toHaveProperty('forkSource')
    expect(useAppStore.getState().tabs[local.id]!.regions[result.to!.regionId]).toMatchObject({ workspaceId: 'remote-workspace' })
    await control({ operation: 'space.mv', fromRegionId: result.to!.regionId, expectedAgentSessionId: result.agent!.agentSessionId,
      destination: { zoneId: workspaceZoneId(directoryIdentity('local', _hygiene_fixturePath("other")), 'other'), newTab: true }, focus: false })
    const moved = Object.values(useAppStore.getState().tabs).flatMap(tab => Object.values(tab.regions)).find(surface => surface.kind === 'agent' && surface.sessionId === result.agent!.agentSessionId)
    expect(moved).toMatchObject({ workspaceId: 'remote-workspace' })
    useAppStore.setState(state => ({ config: { ...state.config!, workspaces: state.config!.workspaces.map(workspace => workspace.id === 'remote-workspace' ? { ...workspace, path: _hygiene_fixturePath("later/changed") } : workspace) } }))
    useAppStore.setState({ sessions: [agent(result.agent!.agentSessionId, _hygiene_fixturePath("wrong-local-projection"))] })
    await useAppStore.getState().executeControl(input)
    expect(creation).toHaveBeenCalledWith('remote', result.agent!.agentSessionId)
    expect(created).toHaveBeenCalledTimes(1)
  })

  it('refuses an unknown execution Workspace before layout, resource or creation side effects', async () => {
    const before = { tabs: useAppStore.getState().tabs, layouts: useAppStore.getState().layouts, spatialRequests: useAppStore.getState().spatialRequests }
    const created = vi.spyOn(api.sessions, 'launchAgent'), resource = vi.spyOn(api.workspaces, 'createZoneResource')
    const result = await control({ operation: 'agent.open', content: { kind: 'new-agent', executorId: 'fixture', executionWorkspaceId: 'missing' },
      destination: { zoneId: workspaceZoneId(directoryIdentity('local', _hygiene_fixturePath("repo")), 'repo'), newTab: true }, focus: false })
    expect(result).toMatchObject({ outcome: 'unknown', issues: expect.arrayContaining([expect.objectContaining({ code: 'SPACE_EXECUTION_WORKSPACE_UNKNOWN' })]) })
    expect(created).not.toHaveBeenCalled(); expect(resource).not.toHaveBeenCalled()
    expect(useAppStore.getState()).toMatchObject(before)
  })

  it('reports admission-only mv as unknown at its actual source, and does not execute it when queried', async () => {
    const source = createWorkbenchTab('source', { regionId: 'r', kind: 'agent', phase: 'attached', workspaceId: 'repo', sessionId: 'a' })
    useAppStore.setState({ sessions: [agent('a')], tabs: { source }, layouts: { repo: createWorkspaceLayout('g', ['source']) },
      spatialRequests: { interrupted: { requestId: 'interrupted', inputDigest: 'digest', operation: 'space.mv', tabId: 'reserved-target', regionId: 'r', agentSessionId: 'a', createAgent: false,
        from: { spaceId: directoryIdentity('local', _hygiene_fixturePath("repo")), zoneId: workspaceZoneId(directoryIdentity('local', _hygiene_fixturePath("repo")), 'repo'), workspaceId: 'repo', tabId: 'source', regionId: 'r' },
        target: { spaceId: directoryIdentity('local', _hygiene_fixturePath("other")), zoneId: workspaceZoneId(directoryIdentity('local', _hygiene_fixturePath("other")), 'other') } } } })
    const observed = await control({ operation: 'space.inspect', target: { requestId: 'interrupted' } })
    expect(observed).toMatchObject({ request: { known: true, report: { outcome: 'unknown', to: { tabId: 'source', regionId: 'r' }, issues: [{ code: 'SPACE_PLACEMENT_UNKNOWN' }] } } })
    expect(useAppStore.getState().tabs).toEqual({ source: { ...source, space: { spaceId: directoryIdentity('local', _hygiene_fixturePath("repo")), zoneId: workspaceZoneId(directoryIdentity('local', _hygiene_fixturePath("repo")), 'repo') } } })
  })

  it('puts a new Project Zone first Tab in the exact requested display Group while keeping its execution resource', async () => {
    const display = createWorkspaceLayout('display-group')
    useAppStore.setState(state => ({ config: { ...state.config!, hosts: [...state.config!.hosts,
      { id: 'remote', kind: 'ssh', hostname: 'fixture.invalid', label: 'Display' }],
      workspaces: [...state.config!.workspaces, { id: 'display', hostId: 'remote', name: 'Display', path: _hygiene_fixturePath("display"), kind: 'folder' }] },
      layouts: { ...state.layouts, display } }))
    const createResource = vi.spyOn(api.workspaces, 'createZoneResource').mockImplementation(async input => {
      expect(input.resource).toEqual({ kind: 'directory', projectId: directoryIdentity('local', _hygiene_fixturePath("repo")), path: _hygiene_fixturePath("new-dir") })
      const workspace = { id: 'new-zone-workspace', hostId: 'local', name: 'New', path: _hygiene_fixturePath("new-dir"), kind: 'folder' as const }
      return { config: { ...useAppStore.getState().config!, workspaces: [...useAppStore.getState().config!.workspaces, workspace] }, workspace,
        resource: { projectId: directoryIdentity('local', _hygiene_fixturePath("repo")), sourceWorkspaceId: 'repo', hostId: 'local', path: _hygiene_fixturePath("new-dir"),
          workspaceId: workspace.id, kind: 'directory', branch: null }, issue: null }
    })
    const created = vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async input => {
      expect(input).toMatchObject({ hostId: 'local', workspacePath: _hygiene_fixturePath("new-dir"), prompt: 'one first task' })
      return launch(agent(input.agentSessionId!, input.workspacePath), input.createOperationId!)
    })
    const stop = vi.spyOn(api.sessions, 'stop')
    const opening = { operation: 'agent.open', content: { kind: 'new-agent', executorId: 'fixture', prompt: 'one first task' },
      destination: { spaceId: directoryIdentity('local', _hygiene_fixturePath("other")), displayWorkspaceId: 'display', groupId: 'display-group',
        newZone: { kind: 'directory', projectId: directoryIdentity('local', _hygiene_fixturePath("repo")), path: _hygiene_fixturePath("new-dir") } }, focus: false }
    const opened = await control(opening)
    if (opened.operation !== 'agent.open') throw new Error('Wrong operation')
    expect(opened.outcome, JSON.stringify(opened)).toBe('opened')
    expect(opened.to).toMatchObject({ displayWorkspaceId: 'display', groupId: 'display-group', workspaceId: 'new-zone-workspace' })
    expect(opened.agent).toMatchObject({ hostId: 'local', cwd: _hygiene_fixturePath("new-dir"), initialPrompt: 'confirmed' })
    expect(useAppStore.getState().layouts.display?.groups[0]?.tabOrder).toEqual([opened.to!.tabId])
    expect(useAppStore.getState().layouts['new-zone-workspace']).toBeUndefined()
    expect(useAppStore.getState().spatialRequests[opened.requestId]?.target).toMatchObject({ displayWorkspaceId: 'display', groupId: 'display-group' })
    vi.spyOn(api.sessions, 'creation').mockImplementation(async (_host, id) => ({ ...agentCreationFixture(agent(id, _hygiene_fixturePath("new-dir"))),
      creation: { createOperationId: opened.requestId, initialPrompt: 'confirmed' } }))
    useAppStore.setState(state => ({ layouts: { ...state.layouts, other: createWorkspaceLayout('later-group', [opened.to!.tabId]) } }))
    const writeReadback = await control({ ...opening, requestId: opened.requestId })
    expect(writeReadback).toMatchObject({ operation: 'agent.open', outcome: 'opened', agent: { agentSessionId: opened.agent!.agentSessionId }, to: opened.to })
    const repeated = await control({ operation: 'space.inspect', target: { requestId: opened.requestId } })
    expect(repeated).toMatchObject({ request: { known: true, report: { outcome: 'opened',
      to: { displayWorkspaceId: 'display', groupId: 'display-group', tabId: opened.to!.tabId, regionId: opened.to!.regionId } } } })
    expect(createResource).toHaveBeenCalledTimes(1); expect(created).toHaveBeenCalledTimes(1)
    expect(stop).not.toHaveBeenCalled()
  })

  it('new Zone receipts and repeat inspection conform to strict wire fields, while resource failure retains the resource', async () => {
    vi.spyOn(api.workspaces, 'createZoneResource').mockImplementation(async input => {
      const workspace = { id: 'new-resource', hostId: 'local', name: 'New', path: input.resource.path, kind: 'folder' as const }
      return { config: { ...config, workspaces: [...config.workspaces, workspace] }, workspace,
        resource: { projectId: input.resource.projectId, sourceWorkspaceId: 'repo', hostId: 'local', path: workspace.path, workspaceId: workspace.id, kind: 'directory', branch: null } }
    })
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async input => launch(agent(input.agentSessionId!, input.workspacePath), input.createOperationId!))
    const input = request({ operation: 'agent.open', content: { kind: 'new-agent', executorId: 'fixture' },
      destination: { spaceId: directoryIdentity('local', _hygiene_fixturePath("repo")), newZone: { kind: 'directory', projectId: directoryIdentity('local', _hygiene_fixturePath("repo")), path: _hygiene_fixturePath("new-dir") } }, focus: false })
    vi.spyOn(api.sessions, 'creation').mockImplementation(async (_host, id) => ({ ...agentCreationFixture(agent(id, _hygiene_fixturePath("new-dir"))), creation: { createOperationId: input.requestId, initialPrompt: 'confirmed' } }))
    const opened = await useAppStore.getState().executeControl(input)
    expect(opened).toMatchObject({ outcome: 'opened', resource: { workspaceId: 'new-resource' } })
    const queried = request({ operation: 'space.inspect', target: { requestId: input.requestId } })
    const result = await useAppStore.getState().executeControl(queried)
    expect(() => parseAgentMuxControlReceipt({ schemaVersion: 5, requestId: queried.requestId, ok: true, operation: result.operation, result: Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'operation')) }, queried)).not.toThrow()
    expect(result).toMatchObject({ request: { report: { outcome: 'opened', resource: { path: _hygiene_fixturePath("new-dir"), workspaceId: 'new-resource' } } } })
    expect(api.workspaces.createZoneResource).toHaveBeenCalledTimes(1)
  })
})
