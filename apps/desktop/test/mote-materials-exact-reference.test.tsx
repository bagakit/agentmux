import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, useLayoutEffect } from 'react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { useMoteMaterialsActions } from '../src/renderer/src/lib/mote-materials-actions'
import type { MoteWorkfaceScope } from '../src/renderer/src/lib/mote-workface'
import type { WorkbenchProjectionSelection } from '../src/renderer/src/lib/workbench-projection'
import { readPmoTeamsTopicFloatingState, usePmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { createWorkbenchTab, documentKey, fileTabId } from '../src/renderer/src/lib/workbench-tabs'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicLogicalPath, scratchTopicIdentityPath } from '../src/shared/scratch-topics'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { defaultAgent, defaultTab, moteTopics, scratchWorkspace, seedMoteWorkface } from './fixtures/mote-workface'

const baseline = useAppStore.getState()
const topic = moteTopics.find(item => item.id === PMO_TEAMS_TOPIC_ID)!
const scope: MoteWorkfaceScope = { workspace: scratchWorkspace, topic, rootPath: scratchTopicLogicalPath(scratchWorkspace, topic)! }
const spaceId = directoryIdentity(scratchWorkspace.hostId, scratchTopicIdentityPath(scratchWorkspace, topic))
const space = { spaceId, zoneId: homeZoneId(spaceId) }
const reference = { displayWorkspaceId: 'display', groupId: 'second', tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
const path = scope.rootPath + '/idea.md'
let actions: ReturnType<typeof useMoteMaterialsActions>
let setFloating: ReturnType<typeof usePmoTeamsTopicFloatingState>[1], commits = 0
let container: HTMLDivElement, root: ReturnType<typeof createRoot>
const onTabSelect = vi.fn(), onOpened = vi.fn()
const onReferenceSelect = vi.fn()
const assertionCounts: { test: string; assertions: number }[] = []
function Host({ reference: held, destination, floating = false, exactCallback = false }: { reference?: WorkbenchProjectionSelection | null;
  destination?: Pick<WorkbenchProjectionSelection, 'displayWorkspaceId' | 'groupId'> | null; floating?: boolean; exactCallback?: boolean }) {
  const [, updateFloating] = usePmoTeamsTopicFloatingState()
  setFloating = updateFloating
  useLayoutEffect(() => { commits++ })
  actions = useMoteMaterialsActions(scope, { reference: held, destination, floating, onTabSelect, onOpened,
    ...(exactCallback ? { onReferenceSelect } : {}) })
  return <textarea aria-label="Original input" defaultValue="Original unsent draft" />
}
function selected(held = reference) { return { ...space, workspaceId: held.displayWorkspaceId,
  groupId: held.groupId, tabId: held.tabId, regionId: held.regionId, topicId: PMO_TEAMS_TOPIC_ID } }
function facts() {
  const state = useAppStore.getState()
  return { sessions: state.sessions, drafts: state.agentComposerDrafts, modes: state.viewModes,
    focus: state.agentFocus, selection: state.workbenchSpaceSelection, main: state.mainSurface,
    workspace: state.activeWorkspaceId }
}
async function mount(props: Parameters<typeof Host>[0] = {}) {
  await act(async () => root.render(<Host {...props} />))
}
function seedFile({ legacy = false, onlyFirst = false }: { legacy?: boolean; onlyFirst?: boolean } = {}) {
  const id = fileTabId(SCRATCH_WORKSPACE_ID, path)
  const tab = { ...createWorkbenchTab(id, { kind: 'file', workspaceId: SCRATCH_WORKSPACE_ID, path, regionId: 'region:' + id }),
    topicId: PMO_TEAMS_TOPIC_ID, ...(legacy ? {} : { space }) }
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [id]: tab }, layouts: { ...state.layouts,
    display: { ...state.layouts.display!, groups: state.layouts.display!.groups.map(group => ({ ...group,
      tabOrder: group.id === 'first' || !onlyFirst ? [...group.tabOrder, id] : group.tabOrder })) } },
    documents: { [documentKey(SCRATCH_WORKSPACE_ID, path)]: { path, content: 'Original dirty idea', revision: 'original-version' } },
    dirtyDocuments: { [documentKey(SCRATCH_WORKSPACE_ID, path)]: true } }))
  return tab
}
function seedEmptyMote() {
  useAppStore.setState(state => {
    const tabs = Object.fromEntries(Object.entries(state.tabs).filter(([, tab]) => tab.topicId !== PMO_TEAMS_TOPIC_ID))
    return { tabs, layouts: Object.fromEntries(Object.entries(state.layouts).map(([id, layout]) => [id, { ...layout,
      groups: layout.groups.map(group => ({ ...group, tabOrder: group.tabOrder.filter(id => tabs[id]),
        activeTabId: group.activeTabId && tabs[group.activeTabId] ? group.activeTabId : null })) }])),
      workbenchSpaceSelection: { ...space, workspaceId: 'display', groupId: 'second', tabId: null, regionId: null, topicId: PMO_TEAMS_TOPIC_ID } }
  })
}
beforeEach(() => {
  vi.restoreAllMocks(); localStorage.clear(); useAppStore.setState(baseline, true); seedMoteWorkface()
  onTabSelect.mockClear(); onOpened.mockClear(); onReferenceSelect.mockClear()
  commits = 0
  const first = createWorkspaceLayout('first', [defaultTab.id]), second = createWorkspaceLayout('second', [defaultTab.id])
  useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [...state.config!.workspaces,
    { id: 'display', hostId: 'local', path: _hygiene_fixturePath("display"), name: 'Display', kind: 'folder' }] },
    layouts: { ...state.layouts, display: { root: { type: 'split', direction: 'horizontal', ratio: 0.5,
      first: first.root, second: second.root }, groups: [...first.groups, ...second.groups], activeGroupId: 'second' } },
    activeWorkspaceId: 'display', mainSurface: 'workbench', workbenchSpaceSelection: selected(),
    spaceZoneBindings: {}, spatialRequests: {}, documents: {}, dirtyDocuments: {}, documentIssues: {},
    documentGenerations: {}, documentObservationGenerations: {}, savingDocuments: {}, documentRevealTargets: {},
    reportError: vi.fn() }))
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'read').mockImplementation(async (_workspace, originalPath) => ({ status: 'read', document: {
    path: originalPath, content: 'Original saved idea', revision: 'source-version' } }))
  vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  expect(api.sessions.stop).not.toHaveBeenCalled()
  const state = expect.getState()
  assertionCounts.push({ test: state.currentTestName!, assertions: state.assertionCalls })
  await act(async () => root.unmount()); container.remove()
  vi.restoreAllMocks(); useAppStore.setState(baseline, true); vi.unstubAllGlobals(); localStorage.clear()
})
afterAll(() => {
  if (process.env.AGENTMUX_MATERIALS_ASSERTION_RECEIPT) writeFileSync(process.env.AGENTMUX_MATERIALS_ASSERTION_RECEIPT,
    JSON.stringify({ tests: assertionCounts.length, assertions: assertionCounts.reduce((sum, item) => sum + item.assertions, 0),
      counts: assertionCounts }, null, 2) + '\n')
})

describe('Mote materials consume the exact original display occurrence', () => {
  it('uses the complete Space selection to reuse a File in its second occurrence without moving its first', async () => {
    const file = seedFile(), doc = useAppStore.getState().documents[documentKey(SCRATCH_WORKSPACE_ID, path)]
    expect(new Set(spatialCatalog(useAppStore.getState(), moteTopics).locations.filter(location =>
      location.tabId === defaultTab.id && location.displayWorkspaceId === 'display').map(location => location.groupId)))
      .toEqual(new Set(['first', 'second']))
    const first = useAppStore.getState().layouts.display!.groups[0]!, before = facts()
    const original = vi.spyOn(useAppStore.getState(), 'openFile')
    await mount(); await act(async () => actions.open(path))
    expect(original).toHaveBeenCalledTimes(1)
    expect(original.mock.calls[0]!.slice(0, 5)).toEqual([path, 'second', undefined, SCRATCH_WORKSPACE_ID, true])
    expect(original.mock.calls[0]![5]).toMatchObject({ displayWorkspaceId: 'display', focus: false,
      resource: { hostId: 'local', path: _hygiene_fixturePath("topics") }, reference: { ...reference, tabId: file.id, regionId: file.layout.activeRegionId } })
    expect(useAppStore.getState().layouts.display!.groups[0]).toBe(first)
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ workspaceId: 'display', groupId: 'second', tabId: file.id })
    expect(useAppStore.getState().documents[documentKey(SCRATCH_WORKSPACE_ID, path)]).toBe(doc)
    expect(useAppStore.getState().dirtyDocuments[documentKey(SCRATCH_WORKSPACE_ID, path)]).toBe(true)
    expect(useAppStore.getState().sessions).toBe(before.sessions); expect(useAppStore.getState().agentComposerDrafts).toBe(before.drafts)
    expect(api.files.read).not.toHaveBeenCalled()
  })
  it('uses only the actual active Group/Tab/Region when the Space selection is unset', async () => {
    useAppStore.setState({ workbenchSpaceSelection: null })
    await mount(); await act(async () => actions.open(path))
    const id = fileTabId(SCRATCH_WORKSPACE_ID, path), state = useAppStore.getState()
    expect(state.layouts.display!.groups[0]!.tabOrder).toEqual([defaultTab.id])
    expect(state.layouts.display!.groups[1]!.tabOrder).toContain(id)
    expect(state.workbenchSpaceSelection).toMatchObject({ workspaceId: 'display', groupId: 'second', tabId: id })
    expect(api.files.read).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, path)
    expect(state.tabs[id]!.workspaceId).toBe(SCRATCH_WORKSPACE_ID)
  })
  it.each([false, true])('adds the existing File to the requested occurrence, legacy Space=%s, without picking its first Group', async legacy => {
    const file = seedFile({ legacy, onlyFirst: true }), before = useAppStore.getState()
    await mount({ floating: true, reference }); await act(async () => actions.open(path))
    const state = useAppStore.getState()
    expect(state.layouts.display!.groups[1]!.tabOrder).toContain(file.id)
    expect(state.layouts.display!.groups[0]).toBe(before.layouts.display!.groups[0])
    expect(state.tabs[file.id]).toBe(file)
    expect(state.tabs[file.id]!.space).toEqual(legacy ? undefined : space)
    expect(onTabSelect).toHaveBeenCalledExactlyOnceWith(file.id)
    expect(state.workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
    expect(state.agentComposerDrafts).toBe(before.agentComposerDrafts)
  })
  it('floating File open preserves the background selection and original input focus', async () => {
    useAppStore.setState({ activeWorkspaceId: 'project', mainSurface: 'board', workbenchSpaceSelection: null })
    await mount({ floating: true, reference })
    const input = container.querySelector('textarea')!; input.focus(); const before = facts()
    await act(async () => actions.open(path))
    const state = useAppStore.getState(), id = fileTabId(SCRATCH_WORKSPACE_ID, path)
    expect(state.layouts.display!.groups[1]!.tabOrder).toContain(id)
    expect(facts()).toEqual(before)
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('Original unsent draft')
    expect(onTabSelect).toHaveBeenCalledExactlyOnceWith(id)
    expect(onOpened).toHaveBeenCalledTimes(1)
    expect(api.files.read).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, path)
  })
  it('returns the actual new File tuple through the preferred callback without guessing a catalog occurrence', async () => {
    useAppStore.setState({ activeWorkspaceId: 'project', mainSurface: 'board', workbenchSpaceSelection: null })
    const before = facts(), original = vi.spyOn(useAppStore.getState(), 'openFile')
    await mount({ floating: true, reference, exactCallback: true }); await act(async () => actions.open(path))
    const id = fileTabId(SCRATCH_WORKSPACE_ID, path), tab = useAppStore.getState().tabs[id]!
    expect(original).toHaveBeenCalledTimes(1)
    expect(onReferenceSelect).toHaveBeenCalledExactlyOnceWith({ displayWorkspaceId: 'display', groupId: 'second',
      tabId: tab.id, regionId: tab.layout.activeRegionId })
    expect(onTabSelect).not.toHaveBeenCalled(); expect(onOpened).toHaveBeenCalledTimes(1)
    expect(facts()).toEqual(before)
    expect(useAppStore.getState().layouts.display!.groups[1]!.tabOrder).toContain(id)
    expect(api.files.read).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, path)
  })
  it('returns an existing File in the selected second occurrence through the preferred callback', async () => {
    const file = seedFile(), before = facts()
    await mount({ floating: true, reference, exactCallback: true }); await act(async () => actions.open(path))
    expect(onReferenceSelect).toHaveBeenCalledExactlyOnceWith({ ...reference, tabId: file.id, regionId: file.layout.activeRegionId })
    expect(onTabSelect).not.toHaveBeenCalled(); expect(onOpened).toHaveBeenCalledTimes(1)
    expect(facts()).toEqual(before); expect(api.files.read).not.toHaveBeenCalled()
  })
  it.each(['missing Group', 'missing Region', 'wrong Mote'] as const)('refuses only the unconfirmed %s action without borrowing a healthy neighbor', async kind => {
    const held = kind === 'missing Group' ? { ...reference, groupId: 'absent' }
      : kind === 'missing Region' ? { ...reference, regionId: 'absent' }
        : { ...reference, tabId: 'custom-tab', regionId: 'custom-region' }
    const before = useAppStore.getState(), launch = vi.spyOn(api.sessions, 'launchTerminal')
    await mount({ floating: true, reference: held })
    await act(async () => { await actions.open(path); await actions.terminal(scope.rootPath) })
    const state = useAppStore.getState()
    expect(state.reportError).toHaveBeenCalledTimes(2)
    expect(state.tabs).toBe(before.tabs); expect(state.layouts).toBe(before.layouts)
    expect(state.sessions).toBe(before.sessions); expect(state.agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(state.workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
    expect(api.files.read).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled()
    expect(onTabSelect).not.toHaveBeenCalled(); expect(onReferenceSelect).not.toHaveBeenCalled(); expect(onOpened).not.toHaveBeenCalled()
  })
  it.each([undefined, null])('does not borrow the background Mote Space selection for a floating caller with reference=%s', async reference => {
    const before = facts(); await mount({ floating: true, reference }); await act(async () => actions.open(path))
    expect(useAppStore.getState().reportError).toHaveBeenCalledTimes(1)
    expect(api.files.read).not.toHaveBeenCalled(); expect(facts()).toEqual(before)
    expect(onTabSelect).not.toHaveBeenCalled()
  })
  it('keeps an explicitly unconfirmed Main reference instead of borrowing the active Mote occurrence', async () => {
    const before = facts(); await mount({ reference: null }); await act(async () => actions.open(path))
    expect(useAppStore.getState().reportError).toHaveBeenCalledTimes(1)
    expect(api.files.read).not.toHaveBeenCalled(); expect(facts()).toEqual(before)
    expect(onOpened).not.toHaveBeenCalled()
  })
  it('creates and launches a Terminal through the original owner at the exact display Group and resource cwd', async () => {
    useAppStore.setState({ activeWorkspaceId: 'project', mainSurface: 'board', workbenchSpaceSelection: null })
    const launch = vi.spyOn(api.sessions, 'launchTerminal').mockResolvedValue({ ...defaultAgent,
      id: 'new-private-terminal', kind: 'terminal', providerId: null, hostId: 'local', workspacePath: topic.directoryPath,
      control: { kind: 'terminal', hostId: 'local', runId: 'private-terminal-run', run: { runId: 'private-terminal-run' } }
    } as Awaited<ReturnType<typeof api.sessions.launchTerminal>>)
    const original = vi.spyOn(useAppStore.getState(), 'openLauncher'), before = facts()
    await mount({ floating: true, reference }); await act(async () => actions.terminal(scope.rootPath))
    const state = useAppStore.getState(), id = onTabSelect.mock.calls[0]![0]
    expect(original).toHaveBeenCalledExactlyOnceWith({ workspaceId: SCRATCH_WORKSPACE_ID, displayWorkspaceId: 'display',
      tabGroupId: 'second', zoneId: space.zoneId, reveal: false })
    expect(launch).toHaveBeenCalledTimes(1)
    expect(launch.mock.calls[0]![0]).toMatchObject({ hostId: 'local', workspacePath: topic.directoryPath })
    expect(state.layouts.display!.groups[1]!.tabOrder).toContain(id)
    expect(state.tabs[id]!.regions[state.tabs[id]!.layout.activeRegionId]!.kind).toBe('terminal')
    expect(state.activeWorkspaceId).toBe(before.workspace); expect(state.mainSurface).toBe(before.main)
    expect(state.workbenchSpaceSelection).toBe(before.selection); expect(state.agentComposerDrafts).toBe(before.drafts)
    expect(before.sessions.every(session => state.sessions.includes(session))).toBe(true)
  })
  it('returns the actual new Launcher tuple through the preferred callback before the original terminal owner consumes it', async () => {
    const launch = vi.spyOn(api.sessions, 'launchTerminal').mockResolvedValue({ ...defaultAgent,
      id: 'new-private-terminal', kind: 'terminal', providerId: null, hostId: 'local', workspacePath: topic.directoryPath,
      control: { kind: 'terminal', hostId: 'local', runId: 'private-terminal-run', run: { runId: 'private-terminal-run' } }
    } as Awaited<ReturnType<typeof api.sessions.launchTerminal>>)
    const owner = vi.spyOn(useAppStore.getState(), 'launchTerminal'), before = facts()
    await mount({ floating: true, reference, exactCallback: true }); await act(async () => actions.terminal(scope.rootPath))
    expect(onReferenceSelect).toHaveBeenCalledTimes(1)
    const held = onReferenceSelect.mock.calls[0]![0]
    expect(held).toMatchObject({ displayWorkspaceId: 'display', groupId: 'second' })
    expect(owner).toHaveBeenCalledExactlyOnceWith('second', { tabId: held.tabId, regionId: held.regionId }, topic.directoryPath)
    expect(useAppStore.getState().tabs[held.tabId]!.regions[held.regionId]!.kind).toBe('terminal')
    expect(onTabSelect).not.toHaveBeenCalled(); expect(onOpened).toHaveBeenCalledTimes(1)
    expect(launch).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.selection)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.drafts)
  })
  it.each(['Space A-B-A', 'later input', 'reference A-B-A'] as const)('retains the File read but cancels its reveal after %s', async intent => {
    let finish!: (result: Awaited<ReturnType<typeof api.files.read>>) => void
    vi.mocked(api.files.read).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await mount({ floating: true, reference, exactCallback: intent === 'later input' })
    const input = container.querySelector('textarea')!; input.focus()
    let pending!: Promise<void>; await act(async () => { pending = actions.open(path) })
    expect(finish).toBeTypeOf('function')
    if (intent === 'Space A-B-A') {
      const original = useAppStore.getState().workbenchSpaceSelection
      useAppStore.setState({ workbenchSpaceSelection: selected({ ...reference, groupId: 'first' }) })
      useAppStore.setState({ workbenchSpaceSelection: original })
    } else if (intent === 'reference A-B-A') {
      await mount({ floating: true, reference: { ...reference, groupId: 'first' } })
      await mount({ floating: true, reference })
    } else input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'Newer input' }))
    const before = facts()
    await act(async () => { finish({ status: 'read', document: { path, content: 'Late original data', revision: 'late' } }); await pending })
    expect(useAppStore.getState().documents[documentKey(SCRATCH_WORKSPACE_ID, path)]!.content).toBe('Late original data')
    expect(facts()).toEqual(before); expect(document.activeElement).toBe(input)
    expect(onTabSelect).not.toHaveBeenCalled(); expect(onReferenceSelect).not.toHaveBeenCalled(); expect(onOpened).not.toHaveBeenCalled()
  })
  it('latches a same-Tab occurrence A-B-A from the actual floating Store in one batch before React commits', async () => {
    let finish!: (result: Awaited<ReturnType<typeof api.files.read>>) => void
    vi.mocked(api.files.read).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await mount({ floating: true, reference, exactCallback: true })
    await act(async () => setFloating({ open: true, preview: false, targetTopicId: PMO_TEAMS_TOPIC_ID,
      targetTabId: defaultTab.id, reference }))
    const input = container.querySelector('textarea')!; input.focus()
    let pending!: Promise<void>; await act(async () => { pending = actions.open(path) })
    expect(finish).toBeTypeOf('function')
    const beforeCommits = commits
    await act(async () => {
      setFloating({ reference: { ...reference, groupId: 'first' } })
      setFloating({ reference })
      expect(commits).toBe(beforeCommits)
      expect(readPmoTeamsTopicFloatingState()?.reference).toEqual(reference)
    })
    const before = facts()
    await act(async () => { finish({ status: 'read', document: { path, content: 'Late original occurrence data', revision: 'late-occurrence' } }); await pending })
    expect(useAppStore.getState().documents[documentKey(SCRATCH_WORKSPACE_ID, path)]!.content).toBe('Late original occurrence data')
    expect(facts()).toEqual(before); expect(document.activeElement).toBe(input)
    expect(readPmoTeamsTopicFloatingState()?.reference).toEqual(reference)
    expect(onReferenceSelect).not.toHaveBeenCalled(); expect(onTabSelect).not.toHaveBeenCalled()
    expect(onOpened).not.toHaveBeenCalled()
  })
  it('rejects a changed resource Host before dispatch while keeping the original graph and healthy sessions', async () => {
    useAppStore.setState(state => ({ config: { ...state.config!, workspaces: state.config!.workspaces.map(workspace =>
      workspace.id === SCRATCH_WORKSPACE_ID ? { ...workspace, hostId: 'different-host' } : workspace) } }))
    const before = facts(), tabs = useAppStore.getState().tabs
    await mount({ reference }); await act(async () => actions.open(path))
    expect(useAppStore.getState().reportError).toHaveBeenCalledTimes(1)
    expect(api.files.read).not.toHaveBeenCalled(); expect(facts()).toEqual(before)
    expect(useAppStore.getState().tabs).toBe(tabs)
  })
})

describe('An exact empty Mote destination uses the original new-content owners', () => {
  const destination = { displayWorkspaceId: 'display', groupId: 'second' }
  it.each(['SOUL.md', 'note.md'])('opens %s directly at the Main Space selection Group without creating a discussion', async name => {
    seedEmptyMote()
    const originalPath = scope.rootPath + '/' + name, before = useAppStore.getState()
    const launcher = vi.spyOn(before, 'openLauncher'), file = vi.spyOn(before, 'openFile')
    expect(spatialCatalog(before, moteTopics).tabs.filter(tab => tab.zoneId === space.zoneId)).toEqual([])
    await mount(); await act(async () => actions.open(originalPath))
    const state = useAppStore.getState(), id = fileTabId(SCRATCH_WORKSPACE_ID, originalPath), tab = state.tabs[id]!
    expect(file).toHaveBeenCalledTimes(1)
    expect(file.mock.calls[0]!.slice(0, 5)).toEqual([originalPath, 'second', undefined, SCRATCH_WORKSPACE_ID, true])
    expect(file.mock.calls[0]![5]).toMatchObject({ displayWorkspaceId: 'display', space, focus: false,
      resource: { hostId: 'local', path: _hygiene_fixturePath("topics") } })
    expect(state.layouts.display!.groups[0]).toEqual(before.layouts.display!.groups[0])
    expect(state.layouts.display!.groups[1]!.tabOrder).toEqual([id])
    expect(tab.workspaceId).toBe(SCRATCH_WORKSPACE_ID); expect(tab.space).toEqual(space)
    expect(tab.regions[tab.layout.activeRegionId]).toMatchObject({ kind: 'file', path: originalPath, workspaceId: SCRATCH_WORKSPACE_ID })
    expect(state.workbenchSpaceSelection).toMatchObject({ ...space, workspaceId: 'display', groupId: 'second', tabId: id, regionId: tab.layout.activeRegionId })
    expect(api.files.read).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, originalPath)
    expect(launcher).not.toHaveBeenCalled(); expect(state.sessions).toBe(before.sessions)
    expect(state.agentComposerDrafts).toBe(before.agentComposerDrafts)
  })
  it('opens a File at the explicit empty floating Group while preserving background and original input', async () => {
    seedEmptyMote(); useAppStore.setState({ activeWorkspaceId: 'project', mainSurface: 'board', workbenchSpaceSelection: null })
    await mount({ floating: true, reference: null, destination, exactCallback: true })
    await act(async () => setFloating({ open: true, preview: false, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: null, reference: null }))
    const input = container.querySelector('textarea')!; input.focus()
    const before = facts(), first = useAppStore.getState().layouts.display!.groups[0]
    await act(async () => actions.open(path))
    const state = useAppStore.getState(), tab = state.tabs[fileTabId(SCRATCH_WORKSPACE_ID, path)]!
    expect(onReferenceSelect).toHaveBeenCalledExactlyOnceWith({ ...destination, tabId: tab.id, regionId: tab.layout.activeRegionId })
    expect(onTabSelect).not.toHaveBeenCalled(); expect(onOpened).toHaveBeenCalledTimes(1)
    expect(state.layouts.display!.groups[0]).toEqual(first)
    expect(state.layouts.display!.groups[1]!.tabOrder).toEqual([tab.id])
    expect(api.files.read).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, path)
    expect(facts()).toEqual(before); expect(document.activeElement).toBe(input)
    expect(input.value).toBe('Original unsent draft')
  })
  it('accepts an explicitly chosen Main empty destination without borrowing the active Group', async () => {
    seedEmptyMote(); useAppStore.setState({ workbenchSpaceSelection: null })
    useAppStore.setState(state => ({ layouts: { ...state.layouts, display: { ...state.layouts.display!, activeGroupId: 'first' } } }))
    const before = useAppStore.getState()
    await mount({ reference: null, destination }); await act(async () => actions.open(path))
    expect(useAppStore.getState().layouts.display!.groups[0]).toEqual(before.layouts.display!.groups[0])
    expect(useAppStore.getState().layouts.display!.groups[1]!.tabOrder).toEqual([fileTabId(SCRATCH_WORKSPACE_ID, path)])
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ workspaceId: 'display', groupId: 'second' })
    expect(useAppStore.getState().sessions).toBe(before.sessions)
  })
  it('creates only the original Launcher and Terminal at the exact empty Group and Mote cwd', async () => {
    seedEmptyMote(); useAppStore.setState({ workbenchSpaceSelection: null })
    const launch = vi.spyOn(api.sessions, 'launchTerminal').mockResolvedValue({ ...defaultAgent,
      id: 'empty-mote-terminal', kind: 'terminal', providerId: null, hostId: 'local', workspacePath: topic.directoryPath,
      control: { kind: 'terminal', hostId: 'local', runId: 'empty-terminal-run', run: { runId: 'empty-terminal-run' } }
    } as Awaited<ReturnType<typeof api.sessions.launchTerminal>>)
    await mount({ floating: true, reference: null, destination, exactCallback: true })
    await act(async () => setFloating({ open: true, preview: false, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: null, reference: null }))
    const before = facts(), original = vi.spyOn(useAppStore.getState(), 'openLauncher'), first = useAppStore.getState().layouts.display!.groups[0]
    await act(async () => actions.terminal(scope.rootPath))
    const state = useAppStore.getState(), held = onReferenceSelect.mock.calls[0]![0]
    expect(original).toHaveBeenCalledExactlyOnceWith({ workspaceId: SCRATCH_WORKSPACE_ID, displayWorkspaceId: 'display',
      tabGroupId: 'second', zoneId: space.zoneId, reveal: false })
    expect(held).toMatchObject(destination)
    expect(state.tabs[held.tabId]!.regions[held.regionId]).toMatchObject({ kind: 'terminal', sessionId: 'empty-mote-terminal' })
    expect(state.layouts.display!.groups[0]).toEqual(first)
    expect(state.layouts.display!.groups[1]!.tabOrder).toEqual([held.tabId])
    expect(launch).toHaveBeenCalledTimes(1); expect(launch.mock.calls[0]![0]).toMatchObject({ hostId: 'local', workspacePath: topic.directoryPath })
    expect(before.sessions.every(session => state.sessions.includes(session))).toBe(true)
    expect(state.agentComposerDrafts).toBe(before.drafts); expect(state.workbenchSpaceSelection).toBe(before.selection)
    expect(onTabSelect).not.toHaveBeenCalled(); expect(onOpened).toHaveBeenCalledTimes(1)
  })
  it.each([false, true])('rejects one empty action without an explicit Group among multiple leaves, floating=%s', async floating => {
    seedEmptyMote(); useAppStore.setState({ workbenchSpaceSelection: null })
    await mount({ floating, reference: null })
    await act(async () => setFloating({ open: true, preview: false, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: null, reference: null }))
    const before = useAppStore.getState()
    await act(async () => actions.open(path))
    expect(useAppStore.getState().reportError).toHaveBeenCalledTimes(1)
    expect(api.files.read).not.toHaveBeenCalled(); expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().layouts).toBe(before.layouts); expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(onReferenceSelect).not.toHaveBeenCalled(); expect(onOpened).not.toHaveBeenCalled()
  })
  it.each([false, true])('does not use an empty destination to replace a saved unknown Tab, floating=%s', async floating => {
    seedEmptyMote(); useAppStore.setState({ workbenchSpaceSelection: { ...selected(), tabId: 'retained-unconfirmed-tab' } })
    await mount({ floating, reference: null, destination, exactCallback: true })
    await act(async () => setFloating({ open: true, preview: false, targetTopicId: PMO_TEAMS_TOPIC_ID,
      targetTabId: 'retained-unconfirmed-tab', reference: null }))
    const before = useAppStore.getState()
    await act(async () => actions.open(path))
    expect(useAppStore.getState().reportError).toHaveBeenCalledTimes(1)
    expect(api.files.read).not.toHaveBeenCalled(); expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
    expect(useAppStore.getState().sessions).toBe(before.sessions); expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(onReferenceSelect).not.toHaveBeenCalled(); expect(onOpened).not.toHaveBeenCalled()
  })
  it.each([false, true])('keeps a retained Mote Tab without a visible occurrence instead of declaring empty, unknown Zone=%s', async unknown => {
    seedEmptyMote()
    useAppStore.setState(state => ({ tabs: { ...state.tabs, [defaultTab.id]: { ...defaultTab,
      ...(unknown ? { space: { spaceId, zoneId: 'retained-unconfirmed-zone' } } : {}) } },
      ...(unknown ? { spaceZoneBindings: { 'retained-unconfirmed-zone': { spaceId, workspaceId: 'project' } } } : {}) }))
    if (unknown) {
      expect(spatialCatalog(useAppStore.getState(), moteTopics).zones.find(zone => zone.zoneId === 'retained-unconfirmed-zone')?.kind).toBe('unknown')
      expect(spatialCatalog(useAppStore.getState(), moteTopics).tabs.find(tab => tab.tabId === defaultTab.id)?.zoneId).toBe(null)
    }
    expect(spatialCatalog(useAppStore.getState(), moteTopics).locations.filter(location => location.tabId === defaultTab.id)).toEqual([])
    await mount({ reference: null, destination })
    const before = useAppStore.getState()
    await act(async () => actions.open(path))
    expect(useAppStore.getState().reportError).toHaveBeenCalledTimes(1)
    expect(api.files.read).not.toHaveBeenCalled(); expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().sessions).toBe(before.sessions); expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(onOpened).not.toHaveBeenCalled()
  })
  it('refuses an off-tree Group record as an empty destination instead of using hidden placement', async () => {
    seedEmptyMote()
    useAppStore.setState(state => ({ layouts: { ...state.layouts, display: { ...state.layouts.display!, root: { type: 'leaf', groupId: 'first' } } } }))
    const before = useAppStore.getState()
    await mount({ reference: null, destination }); await act(async () => actions.open(path))
    expect(useAppStore.getState().reportError).toHaveBeenCalledTimes(1)
    expect(api.files.read).not.toHaveBeenCalled(); expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().layouts).toBe(before.layouts); expect(onOpened).not.toHaveBeenCalled()
  })
  it.each(['later input', 'saved unknown A-B-A'] as const)('retains empty-Mote FileData but does not reveal after %s', async intent => {
    seedEmptyMote(); useAppStore.setState({ workbenchSpaceSelection: null })
    let finish!: (result: Awaited<ReturnType<typeof api.files.read>>) => void
    vi.mocked(api.files.read).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await mount({ floating: true, reference: null, destination, exactCallback: true })
    await act(async () => setFloating({ open: true, preview: false, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: null, reference: null }))
    const input = container.querySelector('textarea')!; input.focus()
    let pending!: Promise<void>; await act(async () => { pending = actions.open(path) })
    expect(finish).toBeTypeOf('function')
    if (intent === 'later input') input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'Newer input' }))
    else await act(async () => {
      const beforeCommits = commits
      setFloating({ targetTabId: 'retained-unknown-later-intent' }); setFloating({ targetTabId: null })
      expect(commits).toBe(beforeCommits)
    })
    const before = facts()
    await act(async () => { finish({ status: 'read', document: { path, content: 'Late empty Mote data', revision: 'late-empty' } }); await pending })
    expect(useAppStore.getState().documents[documentKey(SCRATCH_WORKSPACE_ID, path)]!.content).toBe('Late empty Mote data')
    expect(facts()).toEqual(before); expect(document.activeElement).toBe(input)
    expect(input.value).toBe('Original unsent draft')
    expect(readPmoTeamsTopicFloatingState()?.targetTabId).toBe(null)
    expect(onReferenceSelect).not.toHaveBeenCalled(); expect(onTabSelect).not.toHaveBeenCalled(); expect(onOpened).not.toHaveBeenCalled()
  })
})
