// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { executeSpatialControl, spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { executionFocusPresentation } from '../src/renderer/src/lib/focus-tab-projection'
import { buildActivitySpaces } from '../src/renderer/src/lib/project-activity-spaces'
import { createFocusContextIdentitySelector, focusContextIdentityKey } from '../src/renderer/src/lib/focus-context-identity'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { useAppStore } from '../src/renderer/src/store'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { reviewCurrentFork, currentForkRequest } from '../src/renderer/src/lib/agent-current-fork'
import { fixturePath, fixtureTime } from '../scripts/lib/fixture-values.mjs'

const initial = useAppStore.getState()
afterEach(() => { useAppStore.setState(initial, true); vi.restoreAllMocks() })
function original() {
  const observedAt = fixtureTime(), alias = 'renderer-original-alias', sid = 'canonical-original-session'
  const workspace = { id: 'original-resource', hostId: 'local', kind: 'folder', path: fixturePath('original-project'), name: 'Original project' }
  const session = { id: alias, hostId: 'local', kind: 'agent', providerId: 'codex', executorId: 'codex', workspacePath: workspace.path, label: 'Original Agent',
    createdAt: observedAt, updatedAt: observedAt, agentSessionUpdatedAt: observedAt, processState: 'running', latestOutputBytes: 0,
    status: { state: 'running', source: 'run-process', observedAt }, capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: sid, run: { runId: 'original-run' } } } as const
  const tab = createWorkbenchTab('original-tab', { kind: 'agent', regionId: 'original-region', workspaceId: workspace.id, phase: 'attached', sessionId: alias })
  const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Original Host' }], executors: {}, workspaces: [workspace], appearance: { terminalTheme: 'graphite' } } as any
  useAppStore.setState({ ...initial, config, sessions: [session], tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('original-group', [tab.id]) },
    activeWorkspaceId: workspace.id, spaceZoneBindings: {}, spatialRequests: {}, scratchTopicSnapshots: {} }, true)
  const state = useAppStore.getState(), catalog = spatialCatalog(state, [])
  expect(catalog.regions[0]?.agentSessionId).toBe(sid)
  return { alias, sid, session, tab, state, catalog }
}
it('the original Activity and Focus identity consumers join the actual canonical catalog to renderer aliases', () => {
  const f = original(), executionFor = vi.fn(() => ({ hostId: f.session.control.hostId }))
  const spaces = buildActivitySpaces(f.state.sessions, f.catalog, f.state.tabs, executionFor)
  expect(spaces.zones[0]?.sessions).toEqual([f.session]); expect(spaces.unplaced).toEqual([])
  const contexts = [agentContextForSession(f.session, undefined, undefined, f.state.config!.workspaces[0], null)]
  const identities = createFocusContextIdentitySelector()(f.catalog, f.state.tabs, contexts, f.state.config, f.state.layouts, executionFor)
  expect(identities.get(focusContextIdentityKey(f.session.hostId, f.alias))?.occurrenceCount).toBe(1)
  expect(executionFor.mock.calls.every(([input]) => input.agentSessionId === f.sid)).toBe(true)
})
it('the real Focus navigation owner preserves its alias and selects the exact canonical Agent occurrence', () => {
  const f = original()
  const selected = f.state.focusExecutionSession(f.alias)
  expect(selected).toBe(true)
  const now = useAppStore.getState()
  expect(now.agentFocus.execution.sessionId).toBe(f.alias)
  expect(now.agentFocus.execution.reference).toMatchObject({ tabId: f.tab.id, regionId: 'original-region' })
  expect(now.workbenchSpaceSelection).toMatchObject({ tabId: f.tab.id, regionId: 'original-region' })
  const projected = executionFocusPresentation(now.agentFocus.execution, now.tabs, f.catalog, () => {}, 'region', f.session.control.agentSessionId)
  expect(projected.projection?.selection[0]).toMatchObject({ tabId: f.tab.id, regionId: 'original-region' })
  expect(executionFocusPresentation(now.agentFocus.execution, now.tabs, f.catalog, () => {}, 'region', 'foreign-canonical-session').projection).toBeNull()
  expect(now.sessions).toBe(f.state.sessions); expect(now.tabs).toBe(f.state.tabs)
})

function creator() {
  const f = original(), nativeHandle = { kind: 'provider' as const, providerId: 'codex', sessionId: 'original-native' }
  let state = { ...f.state, config: { ...f.state.config!, executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: false } } },
    sessions: [{ ...f.session, capabilities: { ...f.session.capabilities, providerFork: { current: true } }, nativeHandle }] } as any
  const parent = { kind: 'agent', agentSessionId: f.sid, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: f.session.workspacePath,
    run: f.session.control.run, retiredRuns: [], nativeHandle, createdAt: f.session.createdAt, updatedAt: f.session.updatedAt }
  const originals = new Map<string, any>([[f.sid, parent]])
  const creation = vi.fn(async (_host: string, id: string) => originals.get(id))
  const launch = vi.fn(async (input: any) => {
    const child = { ...f.session, id: input.agentSessionId, control: { ...f.session.control, agentSessionId: input.agentSessionId, run: { runId: 'child-run' } } }
    const created = { ...parent, agentSessionId: child.id, run: child.control.run, creation: { createOperationId: input.createOperationId, initialPrompt: 'not-requested', agentMuxContext: 'confirmed' }, forkedFrom: input.forkSource }
    originals.set(child.id, created)
    return { created, session: child, creation: created.creation, timeline: { agentSessionId: child.id, revision: 0, items: [] }, projectionFailures: [] }
  })
  const ports = { get: () => state, patch: (patch: any) => { state = { ...state, ...patch } }, topics: async () => [], creation, launch,
    attach: async (_region: string, result: any) => { state = { ...state, sessions: [...state.sessions, result.session] } },
    createResource: async () => { throw new Error('No new resource requested') }, save: async (layoutApplied: boolean) => ({ layoutApplied, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'confirmed', reason: null }),
    focus: vi.fn(), isFocused: () => false, notice: vi.fn(), closing: () => false }
  const service = new AgentMuxRpcService({ execute: request => executeSpatialControl(ports as any, request as any) as any })
  return { ...f, nativeHandle, state: () => state, ports, service, creation, launch }
}
it('the actual public fork request reaches the original Creator with canonical Core identity while its source Region keeps the alias', async () => {
  const f = creator(), source = f.state().sessions[0]
  const origin = { workspaceId: 'original-resource', tabGroupId: 'original-group', tabId: f.tab.id, regionId: 'original-region', sessionId: f.alias }
  const review = reviewCurrentFork(source, origin, 'canonical-fork-original')
  const request = currentForkRequest(review, source, spatialCatalog(f.state(), []), 'right', false)
  const report = await f.service.call('agent.open', { operationId: request.requestId, content: request.content, destination: request.destination, focus: request.focus })
  expect(report.outcome).toBe('opened')
  expect(f.creation).toHaveBeenCalledWith('local', f.sid)
  expect(f.launch).toHaveBeenCalledTimes(1)
  expect(f.launch.mock.calls[0]![0].forkSource).toEqual({ agentSessionId: f.sid, expectedRun: source.control.run, expectedNativeHandle: f.nativeHandle })
  expect(f.state().tabs[f.tab.id].regions['original-region'].sessionId).toBe(f.alias)
  const before = structuredClone(f.state().spatialRequests)
  const inspected = await f.service.call('space.inspect', { target: { operationId: review.operationId } })
  expect(inspected.request?.report?.agent?.forkedFrom?.agentSessionId).toBe(f.sid)
  expect(f.launch).toHaveBeenCalledTimes(1); expect(f.state().spatialRequests).toEqual(before)
})
it('an existing canonical Agent binds through the original Creator without creating or replacing its renderer identity', async () => {
  const f = creator(), target = f.catalog.locations[0]!
  const report = await f.service.call('agent.open', { operationId: 'canonical-existing-binding', content: { kind: 'agent-session', agentSessionId: f.sid },
    destination: { spaceId: target.spaceId!, zoneId: target.zoneId!, newTab: true }, focus: false })
  expect(report.outcome).toBe('opened'); expect(report.agent?.agentSessionId).toBe(f.sid)
  expect(f.launch).not.toHaveBeenCalled(); expect(f.creation).not.toHaveBeenCalled()
  expect(f.state().tabs[report.to!.tabId].regions[report.to!.regionId].sessionId).toBe(f.alias)
  const inspected = await f.service.call('space.inspect', { target: { operationId: 'canonical-existing-binding' } })
  expect(inspected.request?.report?.agent?.agentSessionId).toBe(f.sid)
  expect(inspected.request?.report?.to).toEqual(report.to)
})
it('does not choose a first Host when the public source SID has more than one observed control owner', async () => {
  const f = creator(), first = f.state().sessions[0]
  f.state().sessions = [...f.state().sessions, { ...first, id: 'another-renderer-alias', hostId: 'another-host', control: { ...first.control, hostId: 'another-host' } }]
  const before = structuredClone(f.state().tabs)
  const report = await f.service.call('agent.open', { operationId: 'ambiguous-canonical-fork', content: { kind: 'fork-agent', source: {
    agentSessionId: f.sid, expectedRun: first.control.run, expectedNativeHandle: f.nativeHandle
  } }, destination: { tabId: f.tab.id, regionId: 'original-region', split: 'right' }, focus: false })
  expect(report.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'AGENT_SESSION_UNKNOWN' })]))
  expect(f.creation).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled()
  expect(f.state().tabs).toEqual(before)
})
it('an unavailable Session observation does not remove the exact retained Focus workface', () => {
  const f = original()
  useAppStore.setState({ sessions: [] })
  expect(useAppStore.getState().focusExecutionSession(f.alias)).toBe(true)
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ tabId: f.tab.id, regionId: 'original-region' })
  expect(useAppStore.getState().sessions).toEqual([])
})
