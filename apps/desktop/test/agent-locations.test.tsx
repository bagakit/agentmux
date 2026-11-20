// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createAgentInformationRoot } from './helpers/agent-information-root'
import { agentCardConversationFixture } from './helpers/agent-card-conversation-fixture'
import type { Root } from 'react-dom/client'
import * as storeOwner from '../src/renderer/src/store'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { AgentRoster } from '../src/renderer/src/components/AgentRoster'
import { FocusContextRow } from '../src/renderer/src/components/FocusContextRow'
import { WorkspaceAgentRow } from '../src/renderer/src/components/WorkspaceAgentRow'
import { SurfaceToolDock } from '../src/renderer/src/components/SurfaceToolDock'
import { QuickSwitcher } from '../src/renderer/src/components/QuickSwitcher'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore, agentRegionExecution, agentRegionLocationsKnown, rereadAgentRegionExecution } from '../src/renderer/src/store'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { createWorkbenchTab, addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { createFocusContextIdentitySelector, focusContextIdentityKey } from '../src/renderer/src/lib/focus-context-identity'
import * as navigation from '../src/renderer/src/lib/desktop-focus-navigation'
import * as quickSwitch from '../src/renderer/src/lib/quick-switch'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses'
import type { SessionLocationReference } from '../src/renderer/src/lib/desktop-focus-navigation'
import type { AgentTakeoverPage } from '@agentmux/core/agent-takeover'

const initial = useAppStore.getState(), id = 'original-agent'
let root: Root, container: HTMLDivElement, overlay: HTMLDivElement
const dom = { async render(content: import('react').ReactNode) { await act(async () => root.render(content)) } }
const picker = <QuickSwitcher open={false} onClose={() => {}} />
const selected = () => useAppStore.getState().workbenchSpaceSelection
const choices = () => [...document.querySelectorAll<HTMLButtonElement>('.quick-switch__row[data-kind="location"]')]
async function click(element: Element | null | undefined) { expect(element).toBeTruthy(); await act(async () => (element as HTMLElement).click()) }
async function key(element: Element, value: string) { await act(async () => element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))) }
function arrange(count = 1, multipleGroups = false) {
  const sessions = [composerSession(id), ...Array.from({ length: count - 1 }, (_, n) => composerSession(`unrelated-${n}`))]
  const single = createWorkbenchTab('first', { regionId: 'left', workspaceId: 'workspace', kind: 'agent', phase: 'attached', sessionId: id }, 'Same name')
  const first = addWorkbenchRegion(single, 'left', 'right', { regionId: 'right', workspaceId: 'workspace', kind: 'agent', phase: 'attached', sessionId: id })
  const second = createWorkbenchTab('second', { regionId: 'other', workspaceId: 'workspace', kind: 'agent', phase: 'attached', sessionId: id }, 'Same name')
  let layout = createWorkspaceLayout('group-a', ['first', 'second'])
  if (multipleGroups) layout = { ...layout, root: { type: 'split', direction: 'horizontal', ratio: .5, first: layout.root, second: { type: 'leaf', groupId: 'group-b' } },
    groups: [...layout.groups, ...createWorkspaceLayout('group-b', ['first']).groups] }
  useAppStore.setState({ config: composerConfig, sessions, tabs: { first, second }, layouts: { workspace: layout },
    activeWorkspaceId: 'workspace', mainSurface: 'agents', workbenchSpaceSelection: null, sessionLocationRequest: null,
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } },
    agentComposerDrafts: { [id]: 'Original unsent draft' }, spaceZoneBindings: {}, error: null })
  return sessions[0]!
}
function facts() {
  const state = useAppStore.getState(), session = state.sessions.find(one => one.id === id)!
  const context = agentContextForSession(session, undefined, undefined, composerConfig.workspaces[0], null)
  const identities = createFocusContextIdentitySelector()(navigation.workbenchSelectionCatalog(state), state.tabs, [context], state.config, state.layouts, agentRegionExecution, agentRegionLocationsKnown())
  return { context, identity: identities.get(focusContextIdentityKey(context.hostId, context.id)) }
}
function surface(kind: 'focus' | 'space' = 'focus') {
  const { context, identity } = facts()
  return <>{kind === 'focus' ? <FocusContextRow context={context} identity={identity} selected={false} onSelect={value => useAppStore.getState().focusExecutionSession(value)} />
    : <SurfaceToolDock workspace={composerConfig.workspaces[0]} />}{picker}</>
}
async function details(anchor = document.querySelector<HTMLButtonElement>('.focus-context')!) {
  expect(anchor).toBeTruthy()
  expect(document.querySelectorAll('.focus-context-card .agent-locations, .agent-roster__entry .agent-locations')).toHaveLength(0)
  anchor.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 240, bottom: 64, width: 240, height: 64, toJSON() {} })
  await act(async () => anchor.focus())
  await key(anchor, 'ArrowDown')
  const reader = document.querySelector('.agent-information-reader')!
  expect(reader).not.toBeNull()
  expect(reader.querySelector('.agent-locations')).toBeNull()
  await click(reader.querySelector('[aria-label="Agent information: usage, Goals, message relationships and source"]'))
  expect(reader.querySelector('.agent-locations')).toBeNull()
  await click([...reader.querySelectorAll('.agent-information-details__tabs button')].find(button => button.textContent === 'Source'))
  expect(reader.querySelector('.agent-locations')?.getAttribute('aria-haspopup')).toBe('dialog')
  return anchor
}
function disclose() { return document.querySelector('.agent-information-reader .agent-locations') }
const lifecycle: Array<{ mock: { calls: unknown[][] } }> = []
const spatialFixtures: { directory: string; dispose: () => void; pending: Set<Promise<unknown>>; read: typeof api.spatial.read; holdNotifications(): void }[] = []
beforeEach(async () => {
  lifecycle.length = 0
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); overlay = document.createElement('div'); overlay.dataset.overlayHost = ''
  document.body.append(container, overlay); root = createAgentInformationRoot(container)
  useAppStore.setState(initial, true)
  arrange()
  const work = useAppStore.getState(), directory = await mkdtemp(join(tmpdir(), 'agent-locations-'))
  const store = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
  await store.commit({ expectedRevision: 0, graph: desktopSpatialGraph(work, []) })
  vi.spyOn(api.spatial, 'read').mockImplementation(() => store.read())
  const pending = new Set<Promise<unknown>>()
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => {
    const commit = store.commit(input); pending.add(commit)
    void commit.then(() => pending.delete(commit), () => pending.delete(commit))
    return commit
  })
  let heldNotifications = false
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => store.subscribe(value => { if (!heldNotifications) listener(value) }))
  vi.spyOn(api.config, 'get').mockResolvedValue(work.config!)
  const snapshot = await api.sessions.snapshot()
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ ...snapshot, sessions: work.sessions })
  useAppStore.setState({ restoredWorkbench: { tabs: work.tabs, layouts: work.layouts } })
  spatialFixtures.push({ directory, dispose: await useAppStore.getState().initialize(), pending, read: () => store.read(), holdNotifications() { heldNotifications = true } })
  useAppStore.setState({ mainSurface: 'agents', agentComposerDrafts: work.agentComposerDrafts })
  for (const method of ['launchAgent', 'recover', 'resume', 'restart', 'stop', 'submitPrompt'] as const) lifecycle.push(vi.spyOn(api.sessions, method))
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  const source = { providerId: 'codex', nativeSessionId: 'original-location-reading' }
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async control => ({ agentSessionId: control.agentSessionId, source, dispose() {} }))
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async control => ({ agentSessionId: control.agentSessionId, source, items: [], nextCursor: null }))
  vi.spyOn(api.sessions, 'dispatches').mockImplementation(async control => ({ hostId: control.hostId, participantSessionId: control.agentSessionId, dispatches: [], nextSourceMessageId: null }))
  await agentCardConversationFixture(() => source)
})

afterEach(async () => {
  await act(async () => root.unmount())
  if (spatialFixtures[0]) vi.mocked(api.spatial.read).mockImplementation(spatialFixtures[0].read)
  await useAppStore.getState().retryWorkbenchSave()
  const completed = spatialFixtures.splice(0)
  for (const fixture of completed.slice().reverse()) fixture.dispose()
  for (const fixture of completed) while (fixture.pending.size) await Promise.allSettled([...fixture.pending])
  for (const fixture of completed) if (fixture.directory) await rm(fixture.directory, { recursive: true })
  container.remove(); overlay.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks()
})

it('Takeover Source keeps the exact Runtime through the real chooser, rejects a rebound target and recovers in the same request', async () => {
  const runtimeId = 'original-location-runtime', source = composerSession('source-for-takeover-detail')
  const reference = { displayWorkspaceId: 'workspace', groupId: 'group-a', tabId: 'first', regionId: 'right' }
  async function binding(value: string) {
    await act(async () => {
      await useAppStore.getState().retryWorkbenchSave()
      const current = (await api.spatial.read())!, graph = structuredClone(current.graph)
      for (const region of graph.regions) if (region.agentSessionId === id && region.execution) region.execution.runtimeId = value
      await api.spatial.commit({ expectedRevision: current.revision, graph })
      await rereadAgentRegionExecution({ tabId: reference.tabId, regionId: reference.regionId, agentSessionId: id })
    })
  }
  await binding(runtimeId)
  useAppStore.setState(state => ({ sessions: [...state.sessions, source] }))
  const owner = { runtimeId, ownerInstanceId: 'original-instance', protocolVersion: 2 as const, processId: 1, availability: 'connected' as const, ctxmux: null }
  vi.spyOn(api.spatial, 'owner').mockResolvedValue({ owner })
  vi.spyOn(api.sessions, 'owner').mockResolvedValue({ owner })
  vi.spyOn(api.sessions, 'creation').mockResolvedValue({ kind: 'agent', agentSessionId: source.id, hostId: 'local', providerId: source.providerId,
    executorId: source.executorId, workspacePath: source.workspacePath, run: source.control.run, retiredRuns: [], createdAt: 1, updatedAt: 1 })
  vi.spyOn(api.sessions, 'takeovers').mockImplementation(async query => ({ owner: { runtimeId, ownerInstanceId: 'original-instance' },
    direction: query.direction, subject: query.subject, nextCursor: null, coverage: { scope: 'selected-owner', history: 'recorded-takeovers' },
    records: query.direction === 'incoming' ? [] : [{ requestId: 'original-takeover-record',
      agent: { hostId: 'local', runtimeId, agentSessionId: id, run: composerSession(id).control.run }, phase: 'active', issue: null,
      takeover: { source: { hostId: 'local', runtimeId, agentSessionId: source.id, run: source.control.run, organization: null },
        destination: { owner: { runtimeId }, address: { spaceId: null, zoneId: null, workspaceId: 'workspace', ...reference }, organization: null }, nature: null } }]
  } satisfies AgentTakeoverPage))
  const context = { ...agentContextForSession(source, undefined, 'Original source', composerConfig.workspaces[0], null),
    access: { identity: { runtimeId, agentSessionId: source.id }, session: source, locations: [], select() {}, open() {}, refresh() {}, isCurrent: () => true } }
  await dom.render(<><WorkspaceAgentRow context={context} selected={false} selecting={false} disabled={false} onToggle={() => {}} onOpen={() => { throw Error('Reading does not navigate') }} />{picker}</>)
  const anchor = document.querySelector<HTMLButtonElement>('.focus-context')!
  await act(async () => anchor.focus()); await key(anchor, 'ArrowDown')
  await click(document.querySelector('.agent-information-reader__facts'))
  await click([...document.querySelectorAll('.agent-information-details__tabs button')].find(button => button.textContent === 'Source'))
  await vi.waitFor(() => expect([...document.querySelectorAll<HTMLButtonElement>('.agent-information-takeovers button')].some(button => button.textContent === 'Locate created Agent')).toBe(true))
  await click([...document.querySelectorAll<HTMLButtonElement>('.agent-information-takeovers button')].find(button => button.textContent === 'Locate created Agent'))
  const request = useAppStore.getState().sessionLocationRequest!, before = selected(), draft = useAppStore.getState().agentComposerDrafts
  expect(request.subject).toEqual({ hostId: 'local', agentSessionId: id, runtimeId })
  expect(choices()).toHaveLength(3)
  await binding('foreign-rebound-runtime')
  await click(choices().find(choice => choice.title.includes('"regionId":"right"')))
  expect(selected()).toBe(before)
  expect(useAppStore.getState().sessionLocationRequest?.requestId).toBe(request.requestId)
  expect(document.querySelector('.quick-switch')?.textContent).toContain('binding at this location is unconfirmed')
  expect(useAppStore.getState().agentComposerDrafts).toBe(draft)
  await binding(runtimeId)
  await click(choices().find(choice => choice.title.includes('"regionId":"right"')))
  expect(selected()).toMatchObject({ workspaceId: reference.displayWorkspaceId, groupId: reference.groupId, tabId: reference.tabId, regionId: reference.regionId })
  expect(useAppStore.getState().sessionLocationRequest).toBeNull()
  expect(useAppStore.getState().sessions.find(session => session.id === id)?.control).toEqual(composerSession(id).control)
  expect(useAppStore.getState().agentComposerDrafts).toBe(draft)
  for (const call of lifecycle) expect(call).not.toHaveBeenCalled()
})

it('Focus explicitly reselects the second Region while a held occurrence stays intact until exact choice', async () => {
  const first = { displayWorkspaceId: 'workspace', groupId: 'group-a', tabId: 'first', regionId: 'left' }
  expect(useAppStore.getState().focusExecutionSession(id, first)).toBe(true)
  const before = selected(), draft = useAppStore.getState().agentComposerDrafts
  await dom.render(surface()); await details()
  expect(disclose()?.getAttribute('aria-label')).toContain('3 locations')
  await click(disclose())
  expect(selected()).toBe(before); expect(choices()).toHaveLength(3)
  expect(new Set(choices().map(choice => choice.textContent)).size, 'Same-named Tabs must remain distinguishable in the actual picker').toBe(3)
  expect(choices()[0]?.textContent).toContain('Same name')
  await click(choices().find(one => one.title.includes('"regionId":"right"')))
  expect(selected()).toMatchObject({ workspaceId: 'workspace', groupId: 'group-a', tabId: 'first', regionId: 'right' })
  expect(useAppStore.getState().mainSurface).toBe('agents')
  expect(useAppStore.getState().agentFocus.execution.reference).toEqual({ ...first, regionId: 'right' })
  expect(useAppStore.getState().agentComposerDrafts).toBe(draft)
  for (const call of lifecycle.splice(0)) expect(call).not.toHaveBeenCalled()
})

it('Space keeps its Group-scoped primary action and allows explicit selection of another exact Group', async () => {
  arrange(1, true); useAppStore.setState(state => ({ mainSurface: 'workbench', workspaceTool: 'agents', projectRailOpen: true, layouts: { workspace: { ...state.layouts.workspace!, activeGroupId: 'group-b' } } }))
  await dom.render(surface('space'))
  expect(disclose()).toBeNull()
  await click(document.querySelector('.focus-context'))
  expect(useAppStore.getState().sessionLocationRequest?.groupId).toBe('group-b')
  const request = useAppStore.getState().sessionLocationRequest!
  await act(async () => useAppStore.getState().dismissSessionLocationRequest(request.requestId))
  await details(); expect(disclose()?.getAttribute('aria-label')).toContain('5 locations')
  await click(disclose())
  await click(choices().find(one => one.title.includes('"groupId":"group-b"') && one.title.includes('"regionId":"right"')))
  expect(selected()).toMatchObject({ groupId: 'group-b', regionId: 'right' })
  expect(useAppStore.getState().layouts.workspace?.activeGroupId).toBe('group-b')
  expect(useAppStore.getState().mainSurface).toBe('workbench')
})

it('cancel restores the original trigger and leaves the original tuple, draft and layout untouched', async () => {
  await dom.render(surface())
  const trigger = await details()
  const before = useAppStore.getState(), selection = before.workbenchSpaceSelection, layouts = before.layouts, drafts = before.agentComposerDrafts
  await click(disclose()); expect(document.querySelector('.agent-information-reader')).toBeNull()
  await key(document.querySelector('[role="combobox"]')!, 'Escape')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger))
  expect(selected()).toBe(selection); expect(useAppStore.getState().layouts).toBe(layouts); expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
})

it('a pinned original reader and its details action remain mounted when choosing and cancelling a location', async () => {
  await dom.render(surface()); await details()
  const reader = document.querySelector<HTMLElement>('.agent-information-reader')!, action = disclose() as HTMLElement
  const drafts = useAppStore.getState().agentComposerDrafts
  await click(reader.querySelector('.agent-information-reader__pin'))
  expect(reader.dataset.pinned).toBe('true')
  action.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 240, bottom: 32, width: 240, height: 32, toJSON() {} })
  await act(async () => action.focus()); await click(action)
  expect(document.querySelector('.agent-information-reader')).toBe(reader)
  expect(choices()).toHaveLength(3)
  await key(document.querySelector('[role="combobox"]')!, 'Escape')
  await vi.waitFor(() => expect(document.activeElement).toBe(action))
  expect(document.querySelector('.agent-information-reader')).toBe(reader)
  expect(reader.dataset.pinned).toBe('true'); expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
  await click(reader.querySelector('.agent-information-reader__pin'))
  for (const call of lifecycle) expect(call).not.toHaveBeenCalled()
})

it.each(['host', 'canonical-sid'] as const)('held Source refuses a changed %s under the same Renderer id and retains its original reading', async changed => {
  await dom.render(surface()); await details()
  const reader = document.querySelector('.agent-information-reader'), action = disclose(), before = useAppStore.getState()
  const original = composerSession(id), hostId = changed === 'host' ? 'different-host' : original.hostId
  await act(async () => useAppStore.setState({ sessions: [{ ...original, hostId, control: { ...original.control, hostId,
    agentSessionId: changed === 'canonical-sid' ? 'different-canonical-agent' : original.control.agentSessionId } }] }))
  await click(action)
  expect(useAppStore.getState().sessionLocationRequest).toBeNull()
  expect(document.querySelector('.quick-switch')).toBeNull()
  expect(document.querySelector('.agent-information-reader')).toBe(reader)
  expect(disclose()).toBe(action)
  expect(reader?.querySelector('.agent-locations + [role="status"]')?.textContent).toBe('The original Agent identity is no longer confirmed. This reading is kept; reopen the Agent’s current details to choose its location.')
  expect(selected()).toBe(before.workbenchSpaceSelection)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  for (const call of lifecycle) expect(call).not.toHaveBeenCalled()
})

it('held Source accepts the same exact Host and canonical SID after its Run changes', async () => {
  await dom.render(surface()); await details()
  const original = composerSession(id), run = { ...original.control.run, runId: 'new-run-for-same-original-agent' }
  await act(async () => useAppStore.setState({ sessions: [{ ...original, control: { ...original.control, run } }] }))
  await click(disclose())
  expect(choices()).toHaveLength(3)
  await click(choices().find(choice => choice.title.includes('"regionId":"right"')))
  expect(selected()).toMatchObject({ tabId: 'first', regionId: 'right' })
  expect(useAppStore.getState().sessions[0]?.control.run).toBe(run)
  expect(useAppStore.getState().agentComposerDrafts[id]).toBe('Original unsent draft')
  for (const call of lifecycle) expect(call).not.toHaveBeenCalled()
})

it('Source keeps its original Runtime and request while the exact destination is rebound', async () => {
  const originalRuntime = 'qualified-runtime-on-original-host'
  const start = (await api.spatial.read())!, originalGraph = structuredClone(start.graph)
  for (const region of originalGraph.regions) if (region.agentSessionId === id && region.execution) region.execution.runtimeId = originalRuntime
  spatialFixtures[0]!.holdNotifications()
  await api.spatial.commit({ expectedRevision: start.revision, graph: originalGraph })
  await rereadAgentRegionExecution({ tabId: 'first', regionId: 'right', agentSessionId: id })

  await dom.render(surface()); await details(); await click(disclose())
  const request = useAppStore.getState().sessionLocationRequest!
  expect(request.subject?.runtimeId).toBe(originalRuntime)
  const before = selected(), drafts = useAppStore.getState().agentComposerDrafts
  const current = (await api.spatial.read())!, graph = structuredClone(current.graph)
  const region = graph.regions.find(one => one.tabId === 'first' && one.regionId === 'right')!
  region.execution = { ...region.execution!, runtimeId: 'different-runtime-on-original-host' }
  spatialFixtures[0]!.holdNotifications()
  await act(async () => {
    await api.spatial.commit({ expectedRevision: current.revision, graph })
    await rereadAgentRegionExecution({ tabId: 'first', regionId: 'right', agentSessionId: id })
  })
  await click(choices().find(choice => choice.title.includes('"regionId":"right"')))
  expect(selected()).toBe(before)
  expect(useAppStore.getState().sessionLocationRequest).toMatchObject({ requestId: request.requestId, issue: expect.stringContaining('binding at this location is unconfirmed') })
  expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
  await key(document.querySelector('[role="combobox"]')!, 'Escape')
  await details(); await click(disclose())
  const next = useAppStore.getState().sessionLocationRequest!
  const stale = { displayWorkspaceId: 'workspace', groupId: 'group-a', tabId: 'first', regionId: 'left' }
  expect(next.requestId).not.toBe(request.requestId)
  await act(async () => expect(useAppStore.getState().chooseSessionLocation(request.requestId, stale)).toBe(false))
  expect(selected()).toBe(before)
  expect(useAppStore.getState().sessionLocationRequest).toBe(next)
  for (const call of lifecycle) expect(call).not.toHaveBeenCalled()
})

it('Source details count current spatial bindings rather than a card identity captured before reading', async () => {
  await dom.render(surface())
  const anchor = document.querySelector('.focus-context')!
  await key(anchor, 'ArrowDown')
  const reader = document.querySelector('.agent-information-reader')!
  expect(reader).not.toBeNull()
  const observed = (await api.spatial.read())!, graph = structuredClone(observed.graph)
  graph.regions.find(region => region.tabId === 'first' && region.regionId === 'right')!.execution = null
  spatialFixtures[0]!.holdNotifications()
  await api.spatial.commit({ expectedRevision: observed.revision, graph })
  await rereadAgentRegionExecution({ tabId: 'first', regionId: 'right', agentSessionId: id })
  await click(reader.querySelector('[aria-label="Agent information: usage, Goals, message relationships and source"]'))
  await click([...reader.querySelectorAll('.agent-information-details__tabs button')].find(button => button.textContent === 'Source'))
  expect(disclose()?.getAttribute('aria-label')).toContain('Locations unconfirmed')
  expect(disclose()?.textContent).toContain('Locations unconfirmed')
})

it('a changed Zone cannot be ignored when choosing the otherwise exact Region', async () => {
  await dom.render(surface()); await details(); await click(disclose())
  const before = selected(), request = useAppStore.getState().sessionLocationRequest!
  const reference = JSON.parse(choices().find(choice => choice.title.includes('"regionId":"right"'))!.title)
  delete reference.spaceId
  await act(async () => expect(useAppStore.getState().chooseSessionLocation(request.requestId, { ...reference, zoneId: 'another-zone' })).toBe(false))
  expect(selected()).toBe(before)
  expect(useAppStore.getState().sessionLocationRequest?.requestId).toBe(request.requestId)
})

it('a removed exact Region cannot redirect to the surviving first candidate and keeps its picker', async () => {
  await dom.render(surface()); await details(); await click(disclose())
  const request = useAppStore.getState().sessionLocationRequest!, stale: SessionLocationReference = { displayWorkspaceId: 'workspace', groupId: 'group-a', tabId: 'second', regionId: 'other' }
  const original = selected(), state = useAppStore.getState()
  await act(async () => useAppStore.setState({ tabs: { first: state.tabs.first! } }))
  await act(async () => expect(useAppStore.getState().chooseSessionLocation(request.requestId, stale)).toBe(false))
  expect(selected()).toBe(original); expect(useAppStore.getState().sessionLocationRequest?.requestId).toBe(request.requestId)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('no longer contains')
})

it('Space aliases count one physical occurrence each and preserve every exact context choice', async () => {
  const workspace = composerConfig.workspaces[0]!, alias = { ...workspace, id: 'alias', name: 'Other Space', path: workspace.path + '-alias' }
  const primary = directoryIdentity(workspace.hostId, workspace.path), other = directoryIdentity(alias.hostId, alias.path), zone = workspaceZoneId(primary, workspace.id)
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace, alias] }, spaceZoneBindings: {
    [zone]: { spaceId: primary, workspaceId: workspace.id, relations: { [primary]: true, [other]: true } }
  } })
  await dom.render(surface()); await details(); expect(disclose()?.getAttribute('aria-label')).toContain('3 locations')
  await click(disclose()); expect(choices()).toHaveLength(6)
  const row = choices().find(one => one.title.includes(JSON.stringify(other).slice(1,-1)) && one.title.includes('"regionId":"right"'))
  expect(row?.textContent).toContain('Other Space'); await click(row)
  expect(selected()).toMatchObject({ spaceId: other, zoneId: zone, regionId: 'right' })
  await details(); await click(disclose())
  const request = useAppStore.getState().sessionLocationRequest!, ref = navigation.sessionWorkbenchLocationChoices(useAppStore.getState().tabs, navigation.workbenchSelectionCatalog(useAppStore.getState()), id).find(one => one.spaceId === other)!
  const before = selected()
  await act(async () => useAppStore.setState({ spaceZoneBindings: { [zone]: { spaceId: primary, workspaceId: workspace.id, relations: { [primary]: true, [other]: false } } } }))
  await act(async () => expect(useAppStore.getState().chooseSessionLocation(request.requestId, ref)).toBe(false))
  expect(selected()).toBe(before); expect(document.querySelector('[role="dialog"]')).not.toBeNull()
})

it.each([0, 1])('actively opens %i positions without creating a view or Run', async count => {
  const first = useAppStore.getState().tabs.first!
  useAppStore.setState({ tabs: count ? { first: { ...first, layout: createWorkbenchTab('x', first.regions.left!).layout, regions: { left: first.regions.left! } } } : {}, layouts: { workspace: createWorkspaceLayout('group-a', count ? ['first'] : []) } })
  await dom.render(surface()); await details(); expect(disclose()?.getAttribute('aria-label')).toContain(count ? '1 location' : 'No open workface')
  const before = useAppStore.getState(); await click(disclose())
  expect(choices()).toHaveLength(count)
  if (!count) {
    expect(document.querySelector('.quick-switch__empty')?.textContent).toContain('No locations to choose')
    expect(document.querySelector('.quick-switch__footer')?.textContent).not.toContain('to open')
  }
  expect(selected()).toBe(before.workbenchSpaceSelection); expect(useAppStore.getState().tabs).toBe(before.tabs)
  for (const call of lifecycle.splice(0)) expect(call).not.toHaveBeenCalled()
})

it('an unknown source stays unknown and a changed Host cannot inherit an old picker', async () => {
  vi.mocked(api.spatial.read).mockRejectedValue(new Error('Controlled original spatial transport unavailable'))
  const dispose = await useAppStore.getState().initialize()
  const fixture = spatialFixtures[0]!
  spatialFixtures.push({ ...fixture, directory: '', dispose })
  await dom.render(surface()); await details(); expect(disclose()?.getAttribute('aria-label')).toContain('Locations unconfirmed')
  await click(disclose()); expect(document.querySelector('[role="dialog"]')?.textContent).toContain('not confirmed')
  expect(document.querySelector('.quick-switch__empty')).toBeNull()
  expect(document.querySelector('.quick-switch__footer')?.textContent).not.toContain('to open')
  const request = useAppStore.getState().sessionLocationRequest!, before = selected()
  await act(async () => expect(useAppStore.getState().chooseSessionLocation(request.requestId, { displayWorkspaceId: 'workspace', groupId: 'group-a', tabId: 'first', regionId: 'left' })).toBe(false))
  expect(selected()).toBe(before); expect(useAppStore.getState().sessionLocationRequest?.issue).toContain('binding at this location is unconfirmed')
  expect(useAppStore.getState().agentComposerDrafts[id]).toBe('Original unsent draft')
  await act(async () => useAppStore.setState({ sessions: [{ ...composerSession(id), hostId: 'remote', control: { ...composerSession(id).control, hostId: 'remote' } }] }))
  await act(async () => expect(useAppStore.getState().chooseSessionLocation(request.requestId, { displayWorkspaceId: 'workspace', groupId: 'group-a', tabId: 'first', regionId: 'left' })).toBe(false))
  expect(selected()).toBe(before); expect(useAppStore.getState().sessionLocationRequest?.issue).toContain('identity has changed')
})

it.each([1, 32, 100])('actual Roster does no location count work across %i Sessions and details count only their exact subject', async count => {
  arrange(count)
  const work = vi.spyOn(navigation, 'sessionWorkbenchLocationSummary'), build = vi.spyOn(quickSwitch, 'buildSessionLocationItems')
  await dom.render(<><AgentRoster total={count} />{picker}</>)
  const trigger = document.querySelector('.agent-roster__trigger')!
  await act(async () => trigger.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true })))
  expect(document.querySelector('.agent-roster__list')).not.toBeNull()
  expect(work).not.toHaveBeenCalled(); expect(build).not.toHaveBeenCalled()
  expect(document.querySelectorAll('.agent-roster__entry .agent-locations')).toHaveLength(0)
  work.mockClear()
  for (let n = 0; n < 3; n++) await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: {
    type: 'agent-status', agentSessionId: count === 1 ? id : 'unrelated-0', state: 'working', evidence: { source: 'native-hook', observedAt: n + 10 }
  } }))
  expect(work).not.toHaveBeenCalled(); expect(build).not.toHaveBeenCalled()
  await dom.render(surface()); await details()
  expect(work).toHaveBeenCalledTimes(1)
  expect(work.mock.calls[0]?.[2]).toBe(id)
  expect(work.mock.calls[0]?.[3]).toMatchObject({ hostId: 'local', agentSessionId: id })
  await click(disclose())
  expect(choices()).toHaveLength(3); expect(build).toHaveBeenCalledTimes(1)
})

it('the same canonical SID on another Host remains a distinct presentation and exact location', async () => {
  const original = composerSession(id), remote = { ...composerSession('remote-alias'), hostId: 'remote',
    control: { ...composerSession('remote-alias').control, hostId: 'remote', agentSessionId: id } }
  const workspace = { ...composerConfig.workspaces[0]!, id: 'remote-workspace', hostId: 'remote', name: 'Remote Project' }
  const remoteTab = createWorkbenchTab('remote-tab', { regionId: 'remote-region', workspaceId: workspace.id, kind: 'agent', phase: 'attached', sessionId: remote.id }, 'Same name')
  const state = useAppStore.getState()
  useAppStore.setState({ config: { ...composerConfig, hosts: [...composerConfig.hosts, { id: 'remote', kind: 'ssh', label: 'Other Mac', target: 'isolated-fixture' } as any], workspaces: [...composerConfig.workspaces, workspace] },
    sessions: [original, remote], tabs: { ...state.tabs, [remoteTab.id]: remoteTab },
    layouts: { ...state.layouts, [workspace.id]: createWorkspaceLayout('remote-group', [remoteTab.id]) } })
  await useAppStore.getState().retryWorkbenchSave()
  await dom.render(surface()); await details(); expect(disclose()?.getAttribute('aria-label')).toContain('3 locations')
  await click(disclose()); expect(choices()).toHaveLength(3)
  expect(choices().every(one => !one.title.includes('remote-tab'))).toBe(true)
  const request = useAppStore.getState().sessionLocationRequest!
  await act(async () => useAppStore.getState().dismissSessionLocationRequest(request.requestId))
  await act(async () => useAppStore.getState().requestSessionLocations(remote.id))
  expect(choices()).toHaveLength(1); expect(choices()[0]?.textContent).toContain('Other Mac')
  await click(choices()[0]); expect(selected()).toMatchObject({ workspaceId: workspace.id, groupId: 'remote-group', tabId: remoteTab.id, regionId: 'remote-region' })
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(remote.id)
})

it.each([1, 32, 100])('actual Focus keeps position membership cached across unrelated Native facts for %i contexts', async count => {
  arrange(count)
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue({ sources: [], warnings: [] })
  vi.spyOn(api.sessions, 'onEvent').mockReturnValue(() => {})
  vi.spyOn(api.sessions, 'messageEvents').mockImplementation(async (subject, options) => ({ ...subject, participantSessionId: subject.agentSessionId, latest: options?.latest ?? false,
    beforeSequence: null, afterSequence: options?.afterSequence ?? 0, throughSequence: 0, incarnation: 'location-journal', messageId: null, broadcastOperationId: null, events: [], nextAfterSequence: null, nextBeforeSequence: null }))
  vi.spyOn(api.sessions, 'spawns').mockImplementation(async (subject, options) => ({ ...subject, participantSessionId: subject.agentSessionId, direction: options.direction,
    creatorRuntimeId: null, records: [], nextCursor: null, coverage: { scope: 'selected-owner', history: 'recorded-creations' } }))
  const lookups = vi.spyOn(storeOwner, 'agentRegionExecution'), counts = vi.spyOn(navigation, 'sessionWorkbenchLocationSummary')
  await dom.render(<><GlobalFocusSurface />{picker}</>)
  expect(document.querySelectorAll('.global-focus-surface .agent-locations')).toHaveLength(0)
  expect(lookups.mock.calls.length).toBeGreaterThan(0); expect(counts).not.toHaveBeenCalled()
  lookups.mockClear()
  const session = count === 1 ? id : 'unrelated-0'
  for (let n = 0; n < 3; n++) await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: {
    type: 'agent-status', agentSessionId: session, state: 'working', evidence: { source: 'native-hook', observedAt: n + 100 }
  } }))
  expect(lookups).not.toHaveBeenCalled(); expect(counts).not.toHaveBeenCalled()
  expect(document.querySelector('.global-focus-surface .agent-locations')).toBeNull()
  expect(useAppStore.getState().agentComposerDrafts[id]).toBe('Original unsent draft')
})

it.each(['missing-execution', 'wrong-canonical', 'wrong-host'] as const)('actual details mark a partially unconfirmed Region unknown %s', async mode => {
  const held = useAppStore.getState(), originalTabs = held.tabs, originalDrafts = held.agentComposerDrafts
  spatialFixtures[0]!.holdNotifications()
  const current = (await api.spatial.read())!, graph = structuredClone(current.graph)
  const region = graph.regions.find(one => one.tabId === 'first' && one.regionId === 'right')!
  if (mode === 'missing-execution') region.execution = null
  else if (mode === 'wrong-canonical') region.agentSessionId = 'different-core-agent'
  else region.execution = { ...region.execution!, hostId: 'unrelated-host' }
  await api.spatial.commit({ expectedRevision: current.revision, graph })
  expect(await rereadAgentRegionExecution({ tabId: 'first', regionId: 'right', agentSessionId: id })).not.toMatchObject({ hostId: 'local' })
  expect(agentRegionLocationsKnown()).toBe(true)
  expect(useAppStore.getState().tabs).toBe(originalTabs)
  await dom.render(surface()); await details()
  const location = disclose()!
  expect(location.getAttribute('aria-label')).toContain('Locations unconfirmed')
  expect(location.textContent).toContain('Locations unconfirmed')
  expect(location.getAttribute('aria-label')).not.toContain('0 locations')
  await click(location)
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  const request = useAppStore.getState().sessionLocationRequest!, before = selected()
  await act(async () => expect(useAppStore.getState().chooseSessionLocation(request.requestId, { displayWorkspaceId: 'workspace', groupId: 'group-a', tabId: 'first', regionId: 'right' })).toBe(false))
  expect(selected()).toBe(before); expect(useAppStore.getState().sessionLocationRequest?.issue).toContain('unconfirmed')
  expect(useAppStore.getState().agentComposerDrafts).toBe(originalDrafts)
  await click(choices().find(one => one.title.includes('"regionId":"left"')))
  expect(selected()).toMatchObject({ tabId: 'first', regionId: 'left' })
  for (const call of lifecycle) expect(call).not.toHaveBeenCalled()
})
