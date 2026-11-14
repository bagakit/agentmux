// @vitest-environment happy-dom
import { act } from 'react'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, mkdir, symlink, writeFile, readFile } from 'node:fs/promises'
import { readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve, relative, dirname } from 'node:path'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state'
import { composeSpatialTabs } from '../../../packages/core/src/spatial-tab-composition'
import { addTabOccurrence, createWorkspaceLayout } from '@agentmux/layout'
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { checkpointSpatialWorkbench, prepareRendererUpdate, useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab, addWorkbenchRegion, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph, desktopWorkbenchFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { restorePersistedWorkbench } from '../src/renderer/src/lib/workbench-persistence'
import { captureSurveyCompositionSource, planSurveyTabComposition } from '../src/renderer/src/lib/survey-tab-composition'
import { isSurveyCompositionRecovery, retainSurveyComposition, restoreSurveyCompositionRecoveries } from '../src/renderer/src/lib/survey-composition-recovery'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { createWorkbenchUserDocument, WORKBENCH_USER_STATE_KEY } from '../src/renderer/src/lib/workbench-user-storage'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { surveyInitialZoneSelection } from '../src/renderer/src/lib/survey-workface'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'
import type { Root } from 'react-dom/client'
import { providerCatalogReader } from './helpers/startup-observation-api-fixture'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { objectCliReceipt } from '../../../packages/core/test/helpers/object-cli-receipt'
import { privateEnvironment } from './helpers/workface-control-fixture'
import { surveyPageProjection } from '../src/renderer/src/lib/survey-page-references'
import { workbenchRegionProjectionSlotId } from '../src/renderer/src/lib/workbench-projection'
import { chooseField } from './helpers/selection-field'
import { scratchWorkspace, moteTopic } from './fixtures/mote-workface'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { moteDefaultConversation } from '../src/renderer/src/lib/mote-quick-preferences'
import { directoryIdentity } from '../src/shared/space-addresses'
import { scratchTopicIdentityPath } from '@agentmux/host/mote-model'
import { connectWorkbenchCloseApiOwner } from './helpers/workbench-close-api-owner'
import { agentCreationFixture } from './helpers/agent-creation-fixture'
import type { AgentLaunchResult } from '../src/shared/contracts'
import { prepareSourceCoreCli } from './helpers/source-core-cli.mjs'
import { parseAgentMuxControlRequest } from '../../../packages/core/src/control-codec'
import '../scripts/fixtures/survey-tab-composition/native-listener.setup'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => <textarea aria-label="Original Agent input" defaultValue="Unsent Agent input" /> }))
vi.mock('../src/renderer/src/components/EditorPane', () => ({ EditorPane: () => <textarea aria-label="Original file input" defaultValue="Unsent file input" /> }))


const initialStore = useAppStore.getState()
let restartFiles: WorkspaceFiles | undefined
let headerCloseOwner: Awaited<ReturnType<typeof connectWorkbenchCloseApiOwner>> | undefined
let placementRelease: (() => void) | undefined
let root: Root, container: HTMLDivElement, overlay: HTMLDivElement, dispose: (() => void) | undefined
const dom = { async render(element: React.ReactNode) { await act(async () => root.render(element)) } }
let suppressObservation = false
let directory: string, core: AgentMuxSpatialStateStore, zones: { source: string; target: string }, original: ReturnType<typeof useAppStore.getState>
const resource = { ...composerConfig.workspaces[0]!, id: 'composition-source', name: 'Source', path: '/private/composition/source' }
const target = { ...resource, id: 'composition-target', name: 'Target', hostId: 'other-host', path: '/private/composition/target' }
const display = { ...resource, id: 'composition-display', name: 'Other display', path: '/private/composition/display' }
const session = { ...composerSession('composition-agent'), workspacePath: resource.path }
const config = { ...composerConfig, hosts: [...composerConfig.hosts, { id: 'other-host', kind: 'ssh' as const, label: 'Other host', hostname: 'composition-remote-host' }], workspaces: [resource, target, display] }
const source = () => useAppStore.getState().tabs['composition-tab']!
const catalog = () => spatialCatalog(useAppStore.getState(), [])
const destination = () => ({ kind: 'existing' as const, zoneId: zones.target, workspaceId: target.id, displayWorkspaceId: target.id, groupId: 'target-group' })
const captured = (kind: 'tab' | 'page' = 'tab') => captureSurveyCompositionSource(useAppStore.getState(), catalog(), kind === 'tab'
  ? { kind, tabId: source().id } : { kind, regionId: 'composition-page', browserId: 'composition-page' })!
const request = (kind: 'tab' | 'page' = 'tab') => ({ requestId: 'original-composition-request', sources: [captured(kind)], target: destination() })
const click = async (element: HTMLElement) => { expect(element).toBeDefined(); await act(async () => element.click()) }
const named = (label: string) => [...document.querySelectorAll<HTMLElement>('button,[role=menuitem]')].find(element => element.getAttribute('aria-label') === label || element.textContent === label)!
const moveDialog = () => [...document.querySelectorAll<HTMLElement>('[role=dialog]')].find(element => element.querySelector('[aria-label="Destination research"]'))
async function menu(label: string) { const element = named(label); expect(element, document.body.textContent ?? '').toBeDefined(); await act(async () => element.focus()); await act(async () => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }))) }

beforeEach(async () => {
  localStorage.clear(); suppressObservation = false
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); overlay = document.createElement('div'); overlay.dataset.overlayHost = ''
  document.body.append(container, overlay); root = createClientUiRoot(container)
  directory = await mkdtemp(join(tmpdir(), 'amux-composition-'))
  const restart = process.env.SURVEY_COMPOSITION_RESTART_FILE
  resource.path = join(restart ? dirname(restart) : directory, 'original-files'); session.workspacePath = resource.path
  core = new AgentMuxSpatialStateStore(restart ? restart + '.spatial.json' : join(directory, 'spatial.json'))
  if (process.env.SURVEY_COMPOSITION_RESTART_PHASE === 'read') {
    if (process.env.SURVEY_DRAG_RESTART_OUTCOME) {
      const user = new WorkbenchUserStateStore(restart! + '.user.json')
      const document = createWorkbenchUserDocument({ readWorkbenchState: () => user.read(), importWorkbenchState: raw => user.importIfAbsent(raw), writeWorkbenchState: raw => user.write(raw) }, () => localStorage)
      await document.hydrate()
      localStorage.setItem(WORKBENCH_USER_STATE_KEY, JSON.stringify(await document.persistent.storage.getItem(WORKBENCH_USER_STATE_KEY)))
    } else localStorage.setItem(WORKBENCH_USER_STATE_KEY, JSON.parse(await readFile(restart!, 'utf8')).record)
  }
  vi.spyOn(api.spatial, 'read').mockImplementation(() => core.read())
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => core.commit(input))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => core.subscribe(value => { if (!suppressObservation) listener(value) }))
  const native = await api.browser.create('composition-page', 'https://source.example.test/', resource.id)
  let tab = createWorkbenchTab('composition-tab', { ...native, regionId: 'composition-page', kind: 'browser', workspaceId: resource.id,
    browserId: native.id, title: 'Original page' })
  tab = addWorkbenchRegion(tab, 'composition-page', 'right', { kind: 'file', workspaceId: resource.id, path: 'draft.txt', regionId: 'composition-file' })
  tab = addWorkbenchRegion(tab, 'composition-file', 'down', { kind: 'agent', phase: 'attached', workspaceId: resource.id, sessionId: session.id, regionId: 'composition-agent-region' })
  const other = createWorkbenchTab('target-tab', { kind: 'launcher', workspaceId: target.id, regionId: 'target-region' }, 'Target content')
  useAppStore.setState({ loading: false, config, sessions: [session], tabs: { [tab.id]: tab, [other.id]: other },
    layouts: { [resource.id]: createWorkspaceLayout('source-group', [tab.id]), [target.id]: createWorkspaceLayout('target-group', [other.id]),
      [display.id]: createWorkspaceLayout('other-group', [tab.id]) }, mainSurface: 'survey', activeWorkspaceId: display.id,
    spaceZoneBindings: {}, scratchTopicSnapshots: {}, spatialRequests: {}, timelines: {}, demands: {},
    surveyCollectedZones: {}, surveyPageReferences: [], surveyOrganization: { ungrouped: [], groups: [] }, surveyExplorationNames: {}, surveyZoneSelection: null,
    surveyProfileView: { kind: 'default' }, surveyProfileViewReadRecovery: null, surveyPageReadRecovery: null, surveySidebarWidth: 260, surveySidebarCollapsed: false,
    surveyToolsOpen: false, projectRailOpen: true, workspaceTool: 'agents', toolsOpen: false,
    agentComposerDrafts: { [session.id]: 'Unsent original Agent draft' }, documents: { [documentKey(resource.id, 'draft.txt')]: { path: 'draft.txt', content: 'Unsent file body', revision: 'original-file-revision' } },
    dirtyDocuments: { [documentKey(resource.id, 'draft.txt')]: true }, error: null, lastError: null, errorDismissed: true,
    workbenchSpaceSelection: null, closingWorkbenchViews: {}, notebookRecoveries: [], recallNotebookId: null, recallNoteId: null, recallZoneSelection: null })
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [session], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  if (process.env.SURVEY_COMPOSITION_RESTART_PHASE === 'read') restartFiles = (await originalFilePorts()).files
  if (process.env.SURVEY_COMPOSITION_RESTART_PHASE !== 'read') await core.commit({ expectedRevision: 0, graph: desktopSpatialGraph(useAppStore.getState(), []) })
  dispose = await useAppStore.getState().initialize()
  await checkpointSpatialWorkbench()
  const facts = catalog(); zones = { source: facts.tabs.find(tab => tab.tabId === 'composition-tab')!.zoneId!, target: facts.tabs.find(tab => tab.tabId === 'target-tab')!.zoneId! }
  useAppStore.setState({ initialize: vi.fn(async () => () => {}) })
  if (process.env.SURVEY_COMPOSITION_RESTART_PHASE !== 'read') useAppStore.setState({ surveyCollectedZones: { [zones.source]: true, [zones.target]: true },
    surveyExplorationNames: { [zones.source]: 'Source research', [zones.target]: 'Target research' },
    surveyZoneSelection: surveyInitialZoneSelection(facts, zones.source, useAppStore.getState().layouts, useAppStore.getState().tabs, resource.id) })
  original = useAppStore.getState()
})
afterEach(async () => {
  placementRelease?.(); placementRelease = undefined
  await headerCloseOwner?.dispose(); headerCloseOwner = undefined
  await act(async () => root.unmount())
  vi.mocked(api.ui.requestStorageFlush).mockResolvedValue(undefined)
  await prepareRendererUpdate(); dispose?.(); dispose = undefined
  await restartFiles?.dispose(); restartFiles = undefined
  container.remove(); overlay.remove(); vi.restoreAllMocks(); useAppStore.setState(initialStore, true)
  await rm(directory, { recursive: true, force: true })
})

it('[composition] actual App menu moves the exact Tab through Store and Core while preserving every original Region resource', async () => {
  const controls = ['launchAgent', 'stop', 'resume', 'recover', 'write'].map(name => vi.spyOn(api.sessions, name as 'stop'))
  const native = ['create', 'close', 'navigate', 'restore'].map(name => vi.spyOn(api.browser, name as 'close'))
  await dom.render(<App />)
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Original file input"]')).not.toBeNull())
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Browser address"]')).not.toBeNull())
  original = useAppStore.getState(); for (const control of [...controls, ...native]) control.mockClear()
  const editor = document.querySelector<HTMLTextAreaElement>('[aria-label="Original file input"]')!
  expect(editor).toBeDefined(); editor.value = 'Uncommitted editor composition'; editor.setSelectionRange(4, 12)
  await menu('Options for Source research'); await click(named('Move Tab to research…'))
  expect(moveDialog()?.textContent).toContain('Move Tab to research')
  const destination = named('Destination research')
  expect(destination.title).toBe('Choose a research…')
  expect(document.getElementById(destination.getAttribute('aria-describedby')!)?.textContent).toBe('Choose a research…')
  await act(async () => destination.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  await vi.waitFor(() => expect(document.querySelector('[role="menu"][aria-label="Destination research"]')).not.toBeNull())
  const choices = document.querySelector<HTMLElement>('[role="menu"][aria-label="Destination research"]')!
  expect(choices.textContent).not.toContain('Saved selection')
  expect(choices.querySelector('[data-value=""]')?.getAttribute('aria-disabled')).toBe('true')
  await click([...choices.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(item => item.dataset.value === JSON.stringify([zones.target, target.id, 'target-group']))!)
  await click(named('Move Tab'))
  await vi.waitFor(() => expect(catalog().tabs.find(tab => tab.tabId === source().id)?.zoneId).toBe(zones.target))
  await vi.waitFor(() => expect(moveDialog()).toBeUndefined())
  expect(document.querySelector('[aria-label="Original file input"]')).toBe(editor)
  expect(editor.value).toBe('Uncommitted editor composition'); expect([editor.selectionStart, editor.selectionEnd]).toEqual([4, 12])
  const current = useAppStore.getState(), graph = (await core.read())!.graph
  expect(source().workspaceId).toBe(target.id)
  for (const [id, surface] of Object.entries(original.tabs['composition-tab']!.regions)) {
    expect(source().regions[id]).toBe(surface)
    expect(graph.resources['region:' + id]).toEqual(desktopSpatialGraph(original, []).resources['region:' + id])
  }
  expect(current.layouts[resource.id]!.groups[0]!.tabOrder).toContain(source().id)
  expect(current.layouts[display.id]!.groups[0]!.tabOrder).toContain(source().id)
  expect(current.layouts[target.id]!.groups[0]!.tabOrder).toEqual(['target-tab', source().id])
  expect(current.sessions).toBe(original.sessions); expect(current.agentComposerDrafts).toBe(original.agentComposerDrafts)
  expect(current.documents).toBe(original.documents); expect(current.dirtyDocuments).toBe(original.dirtyDocuments)
  for (const control of [...controls, ...native]) expect(control).not.toHaveBeenCalled()
})

it('[composition] an exact page menu extracts only that original Region and preserves all source presentations and siblings', async () => {
  useAppStore.setState({ surveyPageReferences: [{ regionId: 'composition-page', browserId: 'composition-page' }], surveyCollectedZones: { [zones.target]: true },
    surveyZoneSelection: { kind: 'page', regionId: 'composition-page', browserId: 'composition-page' } })
  await dom.render(<App />)
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Browser address"]')).not.toBeNull())
  const address = document.querySelector<HTMLInputElement>('[aria-label="Browser address"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(address, 'Unsubmitted original address'); address.dispatchEvent(new Event('input', { bubbles: true })) })
  address.setSelectionRange(3, 11)
  const before = useAppStore.getState(), browser = source().regions['composition-page']
  const pageOptions = document.querySelector<HTMLElement>('[data-survey-page-region-id="composition-page"] [aria-haspopup="menu"]')
  expect(pageOptions, JSON.stringify({ references: useAppStore.getState().surveyPageReferences, page: source().regions['composition-page'], buttons: [...document.querySelectorAll('[aria-label]')].map(element => element.getAttribute('aria-label')) })).not.toBeNull()
  await menu(pageOptions!.getAttribute('aria-label')!); await click(named('Move page to research…'))
  await chooseField(named('Destination research'), JSON.stringify([zones.target, target.id, 'target-group'])); await click(named('Move page'))
  await vi.waitFor(() => expect(useAppStore.getState().surveyPageReferences).toEqual([]))
  const moved = catalog().regions.find(region => region.regionId === 'composition-page')!
  expect(moved.tabId).not.toBe('composition-tab')
  expect(document.querySelector('[aria-label="Browser address"]')).toBe(address)
  expect(address.value).toBe('Unsubmitted original address'); expect([address.selectionStart, address.selectionEnd]).toEqual([3, 11])
  const state = useAppStore.getState(), tab = state.tabs[moved.tabId]!
  expect(tab.regions['composition-page']).toBe(browser); expect(Object.keys(tab.regions)).toEqual(['composition-page'])
  expect(source().regions['composition-page']).toBeUndefined()
  expect(source().regions['composition-file']).toBe(before.tabs['composition-tab']!.regions['composition-file'])
  expect(source().regions['composition-agent-region']).toBe(before.tabs['composition-tab']!.regions['composition-agent-region'])
  for (const [workspaceId, groupId] of [[resource.id, 'source-group'], [display.id, 'other-group']])
    expect(state.layouts[workspaceId!]!.groups.find(group => group.id === groupId)!.tabOrder).toEqual(['composition-tab', tab.id])
  expect(tab.regions['composition-page']).toMatchObject({ browserId: 'composition-page', workspaceId: resource.id, profileId: (browser as { profileId: string }).profileId })
  expect(state.sessions).toBe(before.sessions); expect(state.documents).toBe(before.documents); expect(state.dirtyDocuments).toBe(before.dirtyDocuments)
})

it('[composition] checks the complete frozen set before any page promotion or Core write', async () => {
  const held = request('page'), other = captureSurveyCompositionSource(useAppStore.getState(), catalog(), { kind: 'tab', tabId: 'target-tab' })!
  const state = useAppStore.getState(); useAppStore.setState({ tabs: { ...state.tabs, 'target-tab': { ...state.tabs['target-tab']!, regions: {
    'target-region': { kind: 'file', regionId: 'target-region', workspaceId: target.id, path: 'replacement.txt' } } } } })
  await checkpointSpatialWorkbench(); const before = await core.read(), local = useAppStore.getState()
  const result = await local.composeSurveyTabs({ ...held, sources: [...held.sources, other] })
  expect(result.outcome).toBe('refused'); expect((await core.read())!.graph).toEqual(before!.graph)
  expect(useAppStore.getState().tabs).toBe(local.tabs); expect(source().regions['composition-page']).toBeDefined()
})

it('[composition] an unobserved Session does not block a pure composition move', async () => {
  const held = request(); useAppStore.setState({ sessions: [] }); await checkpointSpatialWorkbench()
  const result = await useAppStore.getState().composeSurveyTabs(held)
  expect(result.outcome).toBe('moved'); expect(source().regions['composition-agent-region']).toHaveProperty('sessionId', session.id)
})

it('[composition] the Core pure owner rejects changed original members and keeps all original bindings', async () => {
  const graph = (await core.read())!.graph, tab = graph.tabs.find(tab => tab.tabId === 'composition-tab')!
  const input = { target: { zoneId: zones.target, workspaceId: target.id }, tabs: [{ tabId: tab.tabId, zoneId: tab.zoneId, regionIds: ['wrong-region'] }] }
  expect(() => composeSpatialTabs(graph, input)).toThrow(/composition changed/)
  expect(() => composeSpatialTabs(graph, { ...input, tabs: [{ ...input.tabs[0]!, regionIds: ['composition-page', 'composition-file', 'composition-file'] }] })).toThrow(/composition changed/)
  const next = composeSpatialTabs(graph, { ...input, tabs: [{ ...input.tabs[0]!, regionIds: tab.regionIds }] })
  expect(next.layouts).toBe(graph.layouts); expect(next.resources).toBe(graph.resources); expect(next.regions).toBe(graph.regions)
})

it('[composition] acknowledged Core composition does not get replayed when the separate Survey save is unknown', async () => {
  vi.mocked(api.ui.requestStorageFlush).mockRejectedValue(new Error('Survey storage ACK unknown'))
  const result = await useAppStore.getState().composeSurveyTabs(request())
  expect(result.outcome).toBe('partial'); expect(result.issue).toContain('composition is committed')
  expect((await core.read())!.graph.tabs.find(tab => tab.tabId === 'composition-tab')!.zoneId).toBe(zones.target)
  vi.mocked(api.ui.requestStorageFlush).mockResolvedValue(undefined)
})

function motePin(targetRelation = false) {
  const state = useAppStore.getState(), base = moteTopic('launcher:composition-owner', 'Original owner', true)
  const conversation = { hostId: 'local', sessionId: session.id, displayWorkspaceId: resource.id, groupId: 'source-group', tabId: source().id, regionId: 'composition-agent-region' }
  const topic = { ...base, quickMode: { status: 'saved' as const, defaults: { conversation }, version: 'original-preference' } }
  const spaceId = directoryIdentity(scratchWorkspace.hostId, scratchTopicIdentityPath(scratchWorkspace, topic))
  useAppStore.setState({ config: { ...config, workspaces: [...config.workspaces, scratchWorkspace] },
    scratchTopicSnapshots: { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), revision: 0, topics: [topic], reading: false, error: null } },
    spaceZoneBindings: Object.fromEntries(Object.entries(state.spaceZoneBindings).map(([id, value]) => [id, id === zones.source || targetRelation && id === zones.target ? { ...value, relations: { ...value.relations, [spaceId]: true } } : value])) })
  vi.mocked(api.scratch.listTopics).mockResolvedValue([topic])
  expect(moteDefaultConversation(useAppStore.getState(), topic, scratchWorkspace.id).conversation).toEqual(conversation)
  return topic
}

it('[composition] refuses a move that would break the original confirmed Mote fixed conversation', async () => {
  motePin(); await checkpointSpatialWorkbench(); const before = await core.read(), held = request()
  const result = await useAppStore.getState().composeSurveyTabs(held)
  expect(result.outcome).toBe('refused'); expect(result.issue).toContain('fixed Mote conversation')
  expect((await core.read())!.graph).toEqual(before!.graph)
})

it('[composition] preserves a fixed Mote conversation when its exact original occurrence remains related at the target', async () => {
  const topic = motePin(true); await checkpointSpatialWorkbench()
  const result = await useAppStore.getState().composeSurveyTabs(request())
  expect(result.outcome).toBe('moved')
  expect(moteDefaultConversation(useAppStore.getState(), topic, scratchWorkspace.id).conversation).toBeDefined()
})

it('[composition] new authoritative source binding arriving before its notification is never overwritten by old renderer facts', async () => {
  const held = request(), original = (await core.read())!, graph = structuredClone(original.graph)
  const page = graph.regions.find(region => region.regionId === 'composition-page')!
  page.browserId = 'replacement-browser'
  graph.resources['region:composition-page'] = { ...(graph.resources['region:composition-page'] as object), browserId: 'replacement-browser' }
  suppressObservation = true; await core.commit({ expectedRevision: original.revision, graph })
  expect(source().regions['composition-page']).toHaveProperty('browserId', 'composition-page')
  const before = (await core.read())!, writes = vi.mocked(api.spatial.commit).mock.calls.length
  const result = await useAppStore.getState().composeSurveyTabs(held)
  expect(result.outcome).toBe('refused')
  expect((await core.read())!.graph).toEqual(before.graph)
  expect(vi.mocked(api.spatial.commit).mock.calls.length).toBe(writes)
  expect(source().regions['composition-page']).toHaveProperty('browserId', 'replacement-browser')
})

it('[composition] exact CAS conflict refuses once and keeps concurrent graph facts without replay', async () => {
  const held = request(), base = (await core.read())!
  vi.mocked(api.spatial.commit).mockImplementationOnce(async input => {
    const concurrent = structuredClone(base.graph); concurrent.resources['concurrent-owner'] = { original: true }
    await core.commit({ expectedRevision: base.revision, graph: concurrent })
    return core.commit(input)
  })
  const writes = vi.mocked(api.spatial.commit).mock.calls.length
  const result = await useAppStore.getState().composeSurveyTabs(held)
  expect(result.outcome).toBe('refused'); expect(result.requestId).toBe(held.requestId)
  expect(vi.mocked(api.spatial.commit).mock.calls.length - writes).toBe(1)
  expect((await core.read())!.graph.resources['concurrent-owner']).toEqual({ original: true })
  expect((await core.read())!.graph.tabs.find(tab => tab.tabId === source().id)!.zoneId).toBe(zones.source)
})

it('[composition] an unknown commit acknowledgement preserves the request identity and never automatically repeats a committed move', async () => {
  const held = request(), writes = vi.mocked(api.spatial.commit).mock.calls.length
  vi.mocked(api.spatial.commit).mockImplementationOnce(async input => { await core.commit(input); throw new Error('Original CAS acknowledgement unknown') })
  const result = await useAppStore.getState().composeSurveyTabs(held)
  expect(result.outcome).toBe('unknown'); expect(result.requestId).toBe(held.requestId)
  expect(vi.mocked(api.spatial.commit).mock.calls.length - writes).toBe(1)
  expect((await core.read())!.graph.tabs.find(tab => tab.tabId === source().id)!.zoneId).toBe(zones.target)
})

it('[composition-public] source-built public CLI reads, commits and discovers the same original graph and resources', async () => {
  const nodeRequire = createRequire(resolve('packages/core/package.json'))
  const { browserSourceBuild } = nodeRequire('../browser/scripts/source-build.mjs')
  const { build } = browserSourceBuild(nodeRequire('esbuild'))
  const cli = join(directory, 'amux.mjs'), socketDirectory = await mkdtemp('/tmp/acmp-')
  await symlink(resolve('packages/core/node_modules'), join(directory, 'node_modules'), 'dir')
  await build({ entryPoints: ['packages/core/src/agentmux.ts'], outfile: cli, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent',
    plugins: [{ name: 'composition-cli-source', setup(builder: any) { builder.onLoad({ filter: /\.ts$/ }, (args: { path: string }) => {
      const file = relative(process.cwd(), args.path), code = readFileSync(args.path, 'utf8')
      if (!file.startsWith('packages/core/src/')) return null
      if (process.env.SURVEY_COMPOSITION_LOADED) appendFileSync(process.env.SURVEY_COMPOSITION_LOADED,
        JSON.stringify({ consumer: 'compiled-cli', file, original: createHash('sha256').update(code).digest('hex'), loaded: createHash('sha256').update(code).digest('hex') }) + '\n')
      return { contents: code, loader: 'ts' }
    }) } }] })
  const socketPath = join(socketDirectory, 'control.sock'), server = new AgentMuxControlServer({ socketPath, spatialState: core, coreClients: () => [] })
  const env = privateEnvironment({ AGENTMUX_RUNTIME_DIRECTORY: socketDirectory, AGENTMUX_STATE_DIRECTORY: join(socketDirectory, 'state'), AGENTMUX_RPC_ENDPOINT: 'unix:' + socketPath })
  const command = (args: string[], input = '', expected = 0) => new Promise<any>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', error = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { error += chunk })
    child.once('error', reject); child.once('close', code => { try { expect(code, error + output).toBe(expected); resolve(objectCliReceipt(JSON.parse(output || error.split('\n').find(line => line.startsWith('{'))!))) } catch (error) { reject(error) } })
    child.stdin.end(input)
  })
  try {
    await server.start()
    const original = (await command(['space', 'state'])).result.state
    expect(original.graph).toEqual((await core.read())!.graph)
    const planned = planSurveyTabComposition(useAppStore.getState(), [], original.graph, request('page'))
    const committed = (await command(['space', 'commit', '--revision', String(original.revision)], JSON.stringify(planned.graph))).result.state
    expect(committed.revision).toBe(original.revision + 1)
    const read = (await command(['space', 'state'])).result.state
    expect(read.graph).toEqual(planned.graph)
    const catalog = (await command(['space', 'ls', '--zone', zones.target])).result.catalog
    expect(catalog.regions.find((region: any) => region.regionId === 'composition-page')).toMatchObject({ browserId: 'composition-page', tabId: planned.tabIds[0] })
    expect(read.graph.resources['region:composition-page']).toEqual(original.graph.resources['region:composition-page'])
    const stale = await command(['space', 'commit', '--revision', String(original.revision)], JSON.stringify(original.graph), 1)
    expect(stale.ok).toBe(false); expect((await core.read())!.graph).toEqual(planned.graph)
  } finally { await server.stop(); await rm(socketDirectory, { recursive: true, force: true }) }
})

it('[composition] an ordered multi-source request preserves every explicit resource kind and its public projection', async () => {
  let tab = source()
  const surfaces = [
    { kind: 'terminal' as const, regionId: 'composition-terminal', phase: 'attached' as const, workspaceId: resource.id, sessionId: 'original-terminal-session' },
    { kind: 'git' as const, regionId: 'composition-git', workspaceId: resource.id, scope: { hostId: resource.hostId, repoPath: resource.path, workspacePath: resource.path }, selection: { commitOid: 'original-commit', parentOid: 'original-parent' }, file: { path: 'draft.txt', origPath: 'old-draft.txt' } },
    { kind: 'git-diff' as const, regionId: 'composition-diff', workspaceId: resource.id, comparison: { kind: 'commit' as const, snapshot: { hostId: resource.hostId, repoPath: resource.path, commitOid: 'original-commit', parentOid: 'original-parent' }, file: { path: 'draft.txt', origPath: 'old-draft.txt' } } },
    { kind: 'launcher' as const, regionId: 'composition-launcher', workspaceId: resource.id, agentWorkspaceId: display.id, agentExecutor: { hostId: 'other-host', executorId: 'original-executor', executorRevision: 'original-revision' } }
  ]
  for (const surface of surfaces) tab = addWorkbenchRegion(tab, 'composition-agent-region', 'down', surface)
  const neighbor = createWorkbenchTab('ordered-original-tab', { kind: 'launcher', workspaceId: resource.id, regionId: 'ordered-original-region' })
  const state = useAppStore.getState(); useAppStore.setState({ tabs: { ...state.tabs, [tab.id]: tab, [neighbor.id]: neighbor },
    layouts: { ...state.layouts, [resource.id]: createWorkspaceLayout('source-group', [tab.id, neighbor.id]) } })
  await checkpointSpatialWorkbench()
  const original = (await core.read())!.graph
  const sources = [captureSurveyCompositionSource(useAppStore.getState(), catalog(), { kind: 'tab', tabId: neighbor.id })!, captured()]
  const result = await useAppStore.getState().composeSurveyTabs({ ...request(), sources })
  expect(result.outcome).toBe('moved'); expect(result.tabIds).toEqual([neighbor.id, tab.id])
  const graph = (await core.read())!.graph
  expect(useAppStore.getState().layouts[target.id]!.groups[0]!.tabOrder).toEqual(['target-tab', neighbor.id, tab.id])
  for (const surface of Object.values(tab.regions)) {
    expect(graph.resources['region:' + surface.regionId]).toEqual(original.resources['region:' + surface.regionId])
    const after = graph.regions.find(region => region.regionId === surface.regionId)!, before = original.regions.find(region => region.regionId === surface.regionId)!
    if (surface.kind === 'file') {
      const { file: _oldFile, ...oldFact } = before, { file, ...currentFact } = after
      expect(currentFact).toEqual(oldFact); expect(file).toMatchObject({ workspaceId: surface.workspaceId, path: surface.path })
      expect(file?.zoneRelativePath).toBeUndefined(); expect(file?.issue).toBeTruthy()
    } else expect(after).toEqual(before)
  }
  const restored = desktopWorkbenchFromSpatial(graph).tabs[tab.id]!
  for (const surface of surfaces) expect(restored.regions[surface.regionId]).toMatchObject(surface)
})

it('[composition] original Work, Survey and Recall choices follow the same exact Region while input focus and unrelated display choices stay put', async () => {
  const facts = catalog(), originalSpace = facts.bindings.find(binding => binding.zoneId === zones.source)!.spaceId
  const active = { tabId: source().id, regionId: 'composition-page' }
  const research = { zoneId: zones.source, selection: [active, { tabId: source().id, regionId: 'composition-file' }], active }
  const state = useAppStore.getState()
  const work = { spaceId: originalSpace, zoneId: zones.source, workspaceId: display.id, groupId: 'other-group', tabId: source().id, regionId: active.regionId, topicId: null }
  useAppStore.setState({ workbenchSpaceSelection: work, surveyZoneSelection: research, recallZoneSelection: research })
  const result = await useAppStore.getState().composeSurveyTabs(request('page'))
  expect(result.outcome).toBe('moved')
  const current = useAppStore.getState(), moved = result.tabIds[0]!
  expect(current.workbenchSpaceSelection).toMatchObject({ workspaceId: display.id, groupId: 'other-group', regionId: active.regionId, tabId: moved, zoneId: zones.target })
  for (const choice of [current.surveyZoneSelection, current.recallZoneSelection]) expect(choice).toEqual({ zoneId: zones.target, selection: [{ ...active, tabId: moved }], active: { ...active, tabId: moved } })
  expect(current.activeWorkspaceId).toBe(state.activeWorkspaceId); expect(current.mainSurface).toBe(state.mainSurface)
  expect(current.agentFocus).toBe(state.agentFocus); expect(current.regionCaretFocus).toBe(state.regionCaretFocus)
  for (const id of [resource.id, display.id, target.id]) expect(current.layouts[id]!.groups[0]!.activeTabId).toBe(state.layouts[id]!.groups[0]!.activeTabId)
})

it('[composition] direct pure planning refuses a newer Core graph before rewriting any unconsumed owner or unrelated fact', async () => {
  const original = (await core.read())!.graph, fresh = structuredClone(original)
  fresh.tabs.find(tab => tab.tabId === source().id)!.zoneId = zones.target
  expect(() => planSurveyTabComposition(useAppStore.getState(), [], fresh, request())).toThrow(/has not consumed/)
})

it.runIf(Boolean(process.env.SURVEY_COMPOSITION_RESTART_PHASE))('[composition-restart] second actual App process restores the original moved Region, all display bindings and saved input', async () => {
  const path = process.env.SURVEY_COMPOSITION_RESTART_FILE!
  if (process.env.SURVEY_COMPOSITION_RESTART_PHASE === 'write') {
    await mkdir(resource.path, { recursive: true }); await writeFile(join(resource.path, 'draft.txt'), 'Original restart file')
    const { files } = await originalFilePorts()
    const opened = await files.read(resource, 'draft.txt'); expect(opened.status).toBe('read')
    if (opened.status !== 'read') throw new Error('Original restart file missing')
    useAppStore.setState({ documents: { [documentKey(resource.id, 'draft.txt')]: { ...opened.document, content: 'Original unsaved restart draft' } }, documentIssues: {}, dirtyDocuments: { [documentKey(resource.id, 'draft.txt')]: true } })
    await files.dispose()
    useAppStore.setState({ surveyPageReferences: [{ regionId: 'composition-page', browserId: 'composition-page' }], surveyCollectedZones: { [zones.source]: true, [zones.target]: true },
      surveyZoneSelection: { kind: 'page', regionId: 'composition-page', browserId: 'composition-page' } })
    await dom.render(<App />)
    if (process.env.SURVEY_COMPOSITION_RESTART_SCOPE === 'whole') {
      await menu('Options for Source research'); await click(named('Move Tab to research…'))
    } else {
      const pageOptions = document.querySelector<HTMLElement>('[data-survey-page-region-id="composition-page"] [aria-haspopup="menu"]')!
      await menu(pageOptions.getAttribute('aria-label')!); await click(named('Move page to research…'))
    }
    await chooseField(named('Destination research'), JSON.stringify([zones.target, target.id, 'target-group'])); await click(named(process.env.SURVEY_COMPOSITION_RESTART_SCOPE === 'whole' ? 'Move Tab' : 'Move page'))
    await vi.waitFor(() => expect(useAppStore.getState().surveyPageReferences).toEqual([]))
    await vi.waitFor(() => expect(moveDialog()).toBeUndefined())
    await prepareRendererUpdate()
    const state = useAppStore.getState(), graph = (await core.read())!.graph
    await writeFile(path, JSON.stringify({ pid: process.pid, record: localStorage.getItem('agentmux-workbench-v1'), graph,
      selection: state.surveyZoneSelection, sessions: state.sessions, drafts: state.agentComposerDrafts, documents: state.documents, dirty: state.dirtyDocuments,
      browser: catalog().regions.find(region => region.regionId === 'composition-page'), zones }))
  } else {
    const saved = JSON.parse(await readFile(path, 'utf8')); expect(saved.pid).not.toBe(process.pid)
    const state = useAppStore.getState(), graph = (await core.read())!.graph
    expect(graph).toEqual(saved.graph)
    expect(state.layouts).toEqual(saved.graph.layouts)
    expect(state.tabs[saved.browser.tabId]!.regions['composition-page']).toMatchObject({ browserId: 'composition-page', workspaceId: resource.id,
      profileId: saved.graph.resources['region:composition-page'].profileId })
    if (process.env.SURVEY_COMPOSITION_RESTART_SCOPE === 'whole') {
      expect(source().workspaceId).toBe(target.id); expect(source().regions['composition-page']).toHaveProperty('browserId', 'composition-page')
      expect(catalog().regions.find(region => region.regionId === 'composition-file')!.file?.issue).toBeTruthy()
    } else expect(source().regions['composition-page']).toBeUndefined()
    expect(source().regions['composition-file']).toHaveProperty('workspaceId', resource.id)
    expect(state.surveyZoneSelection).toEqual(saved.selection); expect(state.agentComposerDrafts).toEqual(saved.drafts)
    expect(state.documents).toEqual(saved.documents); expect(state.dirtyDocuments).toEqual(saved.dirty)
    const region = graph.regions.find(region => region.regionId === 'composition-agent-region')!
    expect(region.agentSessionId).toBe(session.control.agentSessionId); expect(region.runId).toBe(session.control.run.runId)
    await dom.render(<App />)
    await vi.waitFor(() => expect(document.querySelector('[aria-label="Browser address"]')).not.toBeNull())
    await vi.waitFor(() => expect(document.querySelector('[aria-label="Original file input"]')).not.toBeNull())
    expect(document.querySelector('[aria-label="Original Agent input"]')).not.toBeNull()
    const { files, write } = await originalFilePorts()
    try {
      await useAppStore.getState().saveDocument(source().id, 'composition-file')
      expect(write).toHaveBeenCalledOnce(); expect(await readFile(join(resource.path, 'draft.txt'), 'utf8')).toBe('Original unsaved restart draft')
      expect(useAppStore.getState().dirtyDocuments[documentKey(resource.id, 'draft.txt')]).not.toBe(true)
    } finally { await files.dispose() }
    await writeFile(path + '.read-proof.json', JSON.stringify({ pid: process.pid, writerPid: saved.pid, selection: state.surveyZoneSelection,
      browser: saved.browser, zones: saved.zones, sessions: state.sessions.map(session => session.id), graph }))
  }
})

async function originalFilePorts() {
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never)
  const read = vi.spyOn(api.files, 'read').mockImplementation((workspaceId, path) => { expect(workspaceId).toBe(resource.id); return files.read(resource, path) })
  const write = vi.spyOn(api.files, 'write').mockImplementation((workspaceId, input) => { expect(workspaceId).toBe(resource.id); return files.write(resource, input) })
  return { files, read, write }
}
it('[composition-files] original real filesystem read and save remain available through Store after moving the Tab container', async () => {
  await mkdir(resource.path, { recursive: true }); await writeFile(join(resource.path, 'draft.txt'), 'Original physical file')
  const { files, read, write } = await originalFilePorts()
  try {
    const opened = await files.read(resource, 'draft.txt'); expect(opened.status).toBe('read')
    if (opened.status !== 'read') throw new Error('Original physical file not read')
    const key = documentKey(resource.id, 'draft.txt')
    useAppStore.setState({ documents: { [key]: opened.document }, dirtyDocuments: {}, documentIssues: {}, documentGenerations: {}, savingDocuments: {} })
    const result = await useAppStore.getState().composeSurveyTabs(request()); expect(result.outcome).toBe('moved')
    expect(catalog().regions.find(region => region.regionId === 'composition-file')!.file?.issue).toBeTruthy()
    useAppStore.getState().updateDocument(source().id, 'Saved through the original file owner', 'composition-file')
    await useAppStore.getState().saveDocument(source().id, 'composition-file')
    expect(write).toHaveBeenCalledOnce(); expect(await readFile(join(resource.path, 'draft.txt'), 'utf8')).toBe('Saved through the original file owner')
    expect(useAppStore.getState().dirtyDocuments[key]).not.toBe(true)
    await writeFile(join(resource.path, 'draft.txt'), 'External original file edit')
    await useAppStore.getState().refreshDocument(resource.id, 'draft.txt')
    expect(read).toHaveBeenCalledWith(resource.id, 'draft.txt'); expect(useAppStore.getState().documents[key]!.content).toBe('External original file edit')
  } finally { await files.dispose() }
})

it.runIf(Boolean(process.env.SURVEY_COMPOSITION_COST))('[composition-cost] original App does not fan out unrelated Session output into content owners', async () => {
  let tab = source()
  for (let index = 0; index < 24; index++) tab = addWorkbenchRegion(tab, 'composition-file', 'down', { kind: 'launcher', workspaceId: resource.id, regionId: 'cost-region-' + index })
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [tab.id]: tab } }))
  await checkpointSpatialWorkbench(); (globalThis as any).__regionCost = { copies: 0, visited: 0 }
  await dom.render(<App />)
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Original file input"]')).not.toBeNull())
  const initial = { ...(globalThis as any).__regionCost }; (globalThis as any).__regionCost = { copies: 0, visited: 0 }
  await act(async () => useAppStore.setState(state => ({ sessions: [...state.sessions, composerSession('unrelated-session-output')] })))
  const unrelated = { ...(globalThis as any).__regionCost }
  expect(unrelated).toEqual({ copies: 0, visited: 0 })
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(value => value.id === session.id ? { ...value, label: 'Related Agent label update', updatedAt: 2 } : value) })))
  const related = { ...(globalThis as any).__regionCost }
  expect(related.registrations ?? []).toEqual([])
  expect((related.updates ?? []).every((id: string) => Object.hasOwn(tab.regions, id))).toBe(true)
  await writeFile(process.env.SURVEY_COMPOSITION_COST!, JSON.stringify({ initial, unrelated, related, regionCount: 28 }))
})

it('[composition-page-occurrence] a clicked page keeps its same original display Group after promotion among multiple target-workspace occurrences', async () => {
  const state = useAppStore.getState(), targetLayout = state.layouts[target.id]!
  const extra = createWorkspaceLayout('target-extra-original-group', [source().id]).groups[0]!
  useAppStore.setState({ layouts: { ...state.layouts, [target.id]: { ...targetLayout,
    root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: targetLayout.root, second: { type: 'leaf', groupId: extra.id } }, groups: [...targetLayout.groups, extra] } },
    surveyPageReferences: [{ regionId: 'composition-page', browserId: 'composition-page' }], surveyCollectedZones: { [zones.target]: true },
    surveyZoneSelection: { kind: 'page', regionId: 'composition-page', browserId: 'composition-page' } })
  await checkpointSpatialWorkbench(); await dom.render(<App />)
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Browser address"]')).not.toBeNull())
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Original file input"]')).not.toBeNull())
  const address = document.querySelector<HTMLInputElement>('[aria-label="Browser address"]')!, file = document.querySelector<HTMLTextAreaElement>('[aria-label="Original file input"]')!
  file.value = 'Uncommitted original sibling'
  const original = { displayWorkspaceId: resource.id, groupId: 'source-group', tabId: source().id, regionId: 'composition-page' }
  expect(address.closest('[data-workbench-region-reference]')?.getAttribute('data-workbench-region-reference')).toBe(workbenchRegionProjectionSlotId('primary', original))
  await act(async () => address.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 9, button: 0 })))
  const options = document.querySelector<HTMLElement>('[data-survey-page-region-id="composition-page"] [aria-haspopup="menu"]')!
  await menu(options.getAttribute('aria-label')!); await click(named('Move page to research…'))
  await chooseField(named('Destination research'), JSON.stringify([zones.target, target.id, 'target-group'])); await click(named('Move page'))
  await vi.waitFor(() => expect(useAppStore.getState().surveyPageReferences).toEqual([]))
  const current = useAppStore.getState(), moved = catalog().regions.find(region => region.regionId === original.regionId)!, reference = { ...original, tabId: moved.tabId }
  await vi.waitFor(() => expect(address.closest('[data-workbench-region-reference]')?.getAttribute('data-workbench-region-reference')).toBe(workbenchRegionProjectionSlotId('primary', reference)))
  expect(address.closest('.global-survey-surface')).not.toBeNull()
  expect(document.querySelector('[aria-label="Browser address"]')).toBe(address)
  expect(document.querySelector('[aria-label="Original file input"]')).toBe(file); expect(file.value).toBe('Uncommitted original sibling')
  const facts = catalog(), page = { regionId: original.regionId, browserId: 'composition-page' }
  expect(surveyPageProjection(page, facts, current.tabs, () => {}, original)?.selection).toEqual([reference])
  expect(surveyPageProjection(page, { ...facts, locations: facts.locations.filter(location => !(location.displayWorkspaceId === original.displayWorkspaceId && location.groupId === original.groupId)) }, current.tabs, () => {}, original)).toBeNull()
  const unique = facts.locations.filter(location => location.regionId === page.regionId && location.displayWorkspaceId === target.id && location.groupId === 'target-group')
  expect(unique).toHaveLength(1)
  expect(surveyPageProjection(page, { ...facts, locations: unique }, current.tabs, () => {}, original)?.selection).toEqual([{ displayWorkspaceId: target.id, groupId: 'target-group', tabId: moved.tabId, regionId: page.regionId }])
})


it('[composition-browser-cross-resource] original page menu preserves the same visible Browser input while extracting from an all-Browser Tab', async () => {
  const native = await api.browser.create('secondary-sibling', 'https://sibling.example.test/', resource.id)
  const state = useAppStore.getState(), page = source().regions['composition-page']!
  const paired = addWorkbenchRegion(createWorkbenchTab(source().id, page), page.regionId, 'right', {
    ...native, kind: 'browser', regionId: 'secondary-sibling', browserId: native.id, workspaceId: resource.id })
  useAppStore.setState({ tabs: { ...state.tabs, [paired.id]: paired }, surveyPageReferences: [{ regionId: page.regionId, browserId: 'composition-page' }],
    surveyZoneSelection: { kind: 'page', regionId: page.regionId, browserId: 'composition-page' } })
  await checkpointSpatialWorkbench(); await dom.render(<App />)
  await vi.waitFor(() => expect(document.querySelector('.global-survey-surface [data-workbench-region-id="composition-page"] [aria-label="Browser address"]')).not.toBeNull())
  const input = document.querySelector<HTMLInputElement>('.global-survey-surface [data-workbench-region-id="composition-page"] [aria-label="Browser address"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Unsubmitted original secondary address'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 9, button: 0 })))
  input.setSelectionRange(3, 12)
  const originalPage = useAppStore.getState().tabs[paired.id]!.regions[page.regionId]
  const options = document.querySelector<HTMLElement>('[data-survey-page-region-id="composition-page"] [aria-haspopup="menu"]')!
  await menu(options.getAttribute('aria-label')!); await click(named('Move page to research…'))
  await chooseField(named('Destination research'), JSON.stringify([zones.target, target.id, 'target-group']))
  vi.mocked(api.spatial.commit).mockClear(); await click(named('Move page'))
  await vi.waitFor(() => expect(useAppStore.getState().surveyPageReferences).toEqual([]))
  const moved = catalog().regions.find(region => region.regionId === page.regionId)!
  expect(catalog().tabs.find(tab => tab.tabId === moved.tabId)!.zoneId).toBe(zones.target)
  expect(useAppStore.getState().tabs[moved.tabId]!.regions[page.regionId]).toBe(originalPage)
  expect(Object.keys(source().regions)).toEqual(['secondary-sibling'])
  expect(document.querySelector('.global-survey-surface [data-workbench-region-id="composition-page"] [aria-label="Browser address"]')).toBe(input)
  expect(input.value).toBe('Unsubmitted original secondary address'); expect([input.selectionStart, input.selectionEnd]).toEqual([3, 12])
  expect(vi.mocked(api.spatial.commit)).toHaveBeenCalledOnce()
})

function dragGeometry() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    if (this.closest('[hidden],[inert]')) return new DOMRect()
    if (this.matches('[data-survey-independent-target]')) return new DOMRect(10, 900, 230, 38)
    if (this.matches('[data-survey-list-target]')) return new DOMRect(10, 720 + [...document.querySelectorAll('[data-survey-list-target]')].indexOf(this) * 44, 230, this.querySelector('.survey-list-empty') ? 60 : 36)
    const pages = [...document.querySelectorAll<HTMLElement>('[data-survey-page-region-id]')]
    const page = this.closest<HTMLElement>('[data-survey-page-region-id]')
    if (page) return new DOMRect(10, 80 + pages.indexOf(page) * 44, 230, 36)
    const items = [...document.querySelectorAll<HTMLElement>('.survey-list-item')], item = this.closest<HTMLElement>('.survey-list-item')
    if (item) {
      const top = 80 + pages.length * 44 + items.indexOf(item) * 130
      const tab = this.closest<HTMLElement>('.survey-tab-cell')
      if (tab) return new DOMRect(14, top + 34 + [...item.querySelectorAll('.survey-tab-cell')].indexOf(tab) * 34, 220, 30)
      return new DOMRect(10, top, 230, 120)
    }
    if (this.matches('.survey-list-ungrouped,.survey-page-list')) return new DOMRect(0, 75, 250, 420)
    return new DOMRect()
  })
}
async function dragPointer(element: HTMLElement, destination: { x: number; y: number }, during?: () => Promise<void>) {
  const rect = element.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2
  const pointer = async (target: EventTarget, type: string, px: number, py: number) => act(async () => target.dispatchEvent(new PointerEvent(type,
    { bubbles: true, cancelable: true, pointerId: 5, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: px, clientY: py })))
  await pointer(element, 'pointerdown', x, y); await pointer(document, 'pointermove', x + 7, y)
  await vi.waitFor(() => expect(document.querySelector('.survey-page-list')?.getAttribute('data-dragging')).toBe('true'))
  await during?.()
  await new Promise(resolve => setTimeout(resolve, 30)); await pointer(document, 'pointermove', destination.x, destination.y)
  await new Promise(resolve => setTimeout(resolve, 30)); await pointer(document, 'pointerup', destination.x, destination.y)
  await vi.waitFor(() => expect(document.querySelector('.survey-page-list')?.hasAttribute('data-dragging')).toBe(false))
}

it('[drag-composition] actual PointerSensor drags an exact saved page onto another into one new independent research', async () => {
  const native = await api.browser.create('target-page', 'https://target.example.test/', target.id)
  const current = useAppStore.getState(), targetTab = addWorkbenchRegion(current.tabs['target-tab']!, 'target-region', 'right', {
    ...native, kind: 'browser', regionId: 'target-page', browserId: native.id, workspaceId: target.id })
  useAppStore.setState({ tabs: { ...current.tabs, [targetTab.id]: targetTab }, surveyCollectedZones: { [zones.source]: true, [zones.target]: true },
    surveyPageReferences: [{ regionId: 'composition-page', browserId: 'composition-page' }, { regionId: 'target-page', browserId: 'target-page' }] })
  await checkpointSpatialWorkbench(); dragGeometry(); await dom.render(<App />)
  await vi.waitFor(() => expect(document.querySelectorAll('[data-survey-page-region-id]')).toHaveLength(2))
  const before = (await core.read())!.graph, lifecycle = ['create', 'navigate', 'close'].map(name => vi.spyOn(api.browser, name as 'create'))
  const sourceButton = document.querySelector<HTMLElement>('[data-survey-page-region-id="composition-page"] [data-survey-content-key]')!
  const targetRow = document.querySelector<HTMLElement>('[data-survey-page-region-id="target-page"]')!, rect = targetRow.getBoundingClientRect()
  vi.mocked(api.spatial.commit).mockClear()
  await dragPointer(sourceButton, { x: rect.left + 90, y: rect.top + rect.height / 2 })
  await vi.waitFor(() => expect(useAppStore.getState().surveyPageReferences).toEqual([]))
  const graph = (await core.read())!.graph, research = graph.zones.filter(zone => !before.zones.some(original => original.zoneId === zone.zoneId))
  expect(research).toHaveLength(1); const zone = research[0]!
  expect(zone.workspaceId).toBe(target.id); expect(graph.resources['zone:' + zone.zoneId]).toMatchObject({ workspaceId: target.id })
  expect(graph.bindings.filter(binding => binding.zoneId === zone.zoneId)).toEqual([])
  const members = graph.tabs.filter(tab => tab.zoneId === zone.zoneId)
  expect(members).toHaveLength(2); expect(members.flatMap(tab => tab.regionIds).sort()).toEqual(['composition-page', 'target-page'])
  expect(useAppStore.getState().tabs['target-tab']!.regions['target-region']).toBeDefined()
  expect(source().regions['composition-file']).toBeDefined(); expect(source().regions['composition-agent-region']).toBeDefined()
  expect(vi.mocked(api.spatial.commit)).toHaveBeenCalledOnce()
  for (const call of lifecycle) expect(call).not.toHaveBeenCalled()
})

it('[drag-composition] actual PointerSensor moves only the dragged Tab into an existing research', async () => {
  const state = useAppStore.getState(), neighbor = createWorkbenchTab('source-neighbor', { kind: 'launcher', workspaceId: resource.id, regionId: 'source-neighbor-region' })
  useAppStore.setState({ tabs: { ...state.tabs, [neighbor.id]: neighbor }, layouts: { ...state.layouts,
    [resource.id]: addTabOccurrence(state.layouts[resource.id]!, 'source-group', neighbor.id)! } })
  await checkpointSpatialWorkbench(); dragGeometry(); await dom.render(<App />)
  const tab = document.querySelector<HTMLElement>('[data-survey-tab-id="composition-tab"]')!, row = [...document.querySelectorAll<HTMLElement>('[data-survey-zone-id]')].find(row => row.dataset.surveyZoneId === zones.target)!
  expect(tab).not.toBeNull(); const rect = row.getBoundingClientRect(), before = (await core.read())!.graph
  vi.mocked(api.spatial.commit).mockClear()
  await dragPointer(tab, { x: rect.left + 100, y: rect.top + 15 })
  await vi.waitFor(() => expect(catalog().tabs.find(tab => tab.tabId === 'composition-tab')!.zoneId).toBe(zones.target))
  expect(catalog().tabs.find(tab => tab.tabId === neighbor.id)!.zoneId).toBe(zones.source)
  expect((await core.read())!.graph.zones).toEqual(before.zones)
  expect(vi.mocked(api.spatial.commit)).toHaveBeenCalledOnce()
})

it.each(['occupied Zone', 'missing resource'] as const)('[drag-composition] new-research %s refuses before any composition submission', async failure => {
  const held = request('page'), before = await core.read()
  vi.mocked(api.spatial.commit).mockClear()
  const result = await useAppStore.getState().composeSurveyTabs({ ...held, target: { ...held.target, kind: 'new-research',
    zoneId: failure === 'occupied Zone' ? zones.target : 'reserved-independent-research', workspaceId: failure === 'missing resource' ? 'missing-original-resource' : target.id } })
  expect(vi.mocked(api.spatial.commit)).not.toHaveBeenCalled()
  expect(result.outcome).toBe('refused'); expect(result.targetZoneId).toBe(failure === 'occupied Zone' ? zones.target : 'reserved-independent-research')
  expect((await core.read())!.graph).toEqual(before!.graph)
})

async function dragPagePair(options: { sameTab?: boolean; pagesOnly?: boolean } = {}) {
  const native = await api.browser.create('target-page', 'https://target.example.test/', options.sameTab ? resource.id : target.id)
  const state = useAppStore.getState(), originalTab = options.sameTab ? source() : state.tabs['target-tab']!
  const first = options.pagesOnly ? createWorkbenchTab(source().id, source().regions['composition-page']!) : originalTab
  const paired = addWorkbenchRegion(first, Object.keys(first.regions)[0]!, 'right', {
    ...native, kind: 'browser', regionId: 'target-page', browserId: native.id, workspaceId: options.sameTab ? resource.id : target.id, title: 'Second exact page' })
  useAppStore.setState({ tabs: { ...state.tabs, [paired.id]: paired },
    surveyPageReferences: [{ regionId: 'composition-page', browserId: 'composition-page' }, { regionId: 'target-page', browserId: 'target-page' }],
    surveyZoneSelection: { kind: 'page', regionId: 'composition-page', browserId: 'composition-page' } })
  await checkpointSpatialWorkbench(); dragGeometry(); await dom.render(<App />)
  await new Promise(resolve => setTimeout(resolve, 80)); await checkpointSpatialWorkbench()
  const from = document.querySelector<HTMLElement>('[data-survey-page-region-id="composition-page"] [data-survey-content-key]')!
  const to = document.querySelector<HTMLElement>('[data-survey-page-region-id="target-page"]')!, rect = to.getBoundingClientRect()
  return { from, to, destination: { x: rect.left + 90, y: rect.top + rect.height / 2 } }
}

it.each(['unknown ACK', 'partial Survey save'] as const)('[drag-composition] actual pointer %s retains its original intent and repairs only references', async failure => {
  const { from, destination } = await dragPagePair(), before = await core.read()
  vi.mocked(api.spatial.commit).mockClear()
  if (failure === 'unknown ACK') vi.mocked(api.spatial.commit).mockImplementationOnce(async input => { await core.commit(input); throw new Error('Original CAS ACK lost') })
  else vi.mocked(api.ui.requestStorageFlush).mockImplementation(async () => {
    if ((await core.read())!.graph.zones.length > before!.graph.zones.length) throw new Error('Original Survey save ACK lost')
  })
  await dragPointer(from, destination)
  await vi.waitFor(() => expect(document.querySelector('[data-survey-composition-request]')).not.toBeNull())
  const retained = useAppStore.getState().surveyCompositionRecoveries.filter(isSurveyCompositionRecovery)
  expect(retained).toHaveLength(1); const operation = retained[0]!
  expect(operation.report.outcome).toBe(failure === 'unknown ACK' ? 'unknown' : 'partial')
  expect(operation.sources.flatMap(source => source.owners.map(owner => owner.regionId))).toEqual(['composition-page', 'target-page'])
  expect(operation.sources.map(source => source.tabId)).toEqual(['composition-tab', 'target-tab'])
  const graph = (await core.read())!.graph
  expect(graph.zones.filter(zone => !before!.graph.zones.some(original => original.zoneId === zone.zoneId)).map(zone => zone.zoneId)).toEqual([operation.target.zoneId])
  expect(document.querySelector('[data-survey-composition-request]')?.getAttribute('data-survey-composition-request')).toBe(operation.requestId)
  await click(named('Keep working'))
  await click([...document.querySelectorAll<HTMLElement>('.survey-composition-recovery button')][0]!)
  expect(named('Repair Survey references').hasAttribute('disabled')).toBe(true)
  await click(named('Check current target'))
  await vi.waitFor(() => expect(named('Repair Survey references').hasAttribute('disabled')).toBe(false))
  expect(document.querySelector('[data-survey-composition-request]')?.textContent).toContain('does not confirm the earlier acknowledgement')
  expect(vi.mocked(api.spatial.commit)).toHaveBeenCalledOnce()
  vi.mocked(api.ui.requestStorageFlush).mockResolvedValue(undefined)
  await prepareRendererUpdate()
  expect(JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state.surveyCompositionRecoveries).toEqual(retained)
  await click(named('Repair Survey references'))
  await vi.waitFor(() => expect(useAppStore.getState().surveyCompositionRecoveries).toEqual([]))
  expect(useAppStore.getState().surveyPageReferences).toEqual([])
  expect(useAppStore.getState().surveyCollectedZones[operation.target.zoneId]).toBe(true)
  expect((await core.read())!.graph).toEqual(graph); expect(vi.mocked(api.spatial.commit)).toHaveBeenCalledOnce()
})

it.each([false, true])('[drag-composition] both exact pages from the same mixed Tab (pages only=%s) compose without including siblings or empty Tabs', async pagesOnly => {
  const { from, destination } = await dragPagePair({ sameTab: true, pagesOnly })
  const before = (await core.read())!.graph, address = document.querySelector<HTMLInputElement>('.global-survey-surface [data-workbench-region-id="composition-page"] [aria-label="Browser address"]')!
  expect(address).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(address, 'Unsubmitted page address'); address.dispatchEvent(new Event('input', { bubbles: true })) })
  address.setSelectionRange(2, 7)
  vi.mocked(api.spatial.commit).mockClear(); await dragPointer(from, destination)
  // The exact page has two original display locations. No first/active Group is selected implicitly.
  await vi.waitFor(() => expect(named('Research location'), document.body.textContent ?? '').toBeDefined())
  const chooser = named('Research location')
  await act(async () => chooser.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  const choices = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].filter(item => item.dataset.value)
  expect(choices).toHaveLength(2)
  const choice = choices.find(item => { const value = JSON.parse(item.dataset.value!); return value[2] === display.id })!
  await click(choice); await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  expect(named('Create research').hasAttribute('disabled')).toBe(false)
  await click(named('Create research'))
  await vi.waitFor(() => expect(useAppStore.getState().surveyPageReferences, document.body.textContent ?? '').toEqual([]))
  const graph = (await core.read())!.graph, added = graph.zones.filter(zone => !before.zones.some(zoneBefore => zoneBefore.zoneId === zone.zoneId))
  expect(added).toHaveLength(1)
  expect(graph.tabs.filter(tab => tab.zoneId === added[0]!.zoneId).flatMap(tab => tab.regionIds).sort()).toEqual(['composition-page', 'target-page'])
  expect(graph.tabs.every(tab => tab.regionIds.length > 0)).toBe(true)
  if (!pagesOnly) expect(Object.keys(source().regions).sort()).toEqual(['composition-agent-region', 'composition-file'])
  expect(document.querySelector('.global-survey-surface [data-workbench-region-id="composition-page"] [aria-label="Browser address"]'), JSON.stringify({ connected: address.isConnected, current: [...document.querySelectorAll<HTMLInputElement>('[aria-label="Browser address"]')].map(input => ({ same: input === address, value: input.value, region: input.closest('[data-workbench-region-id]')?.getAttribute('data-workbench-region-id'), survey: Boolean(input.closest('.global-survey-surface')), selection: [input.selectionStart, input.selectionEnd] })) })).toBe(address)
  expect(address.value).toBe('Unsubmitted page address'); expect([address.selectionStart, address.selectionEnd]).toEqual([2, 7])
  expect(document.querySelector<HTMLElement>('[data-survey-tab-id][aria-current="true"]')?.getAttribute('data-survey-tab-id')).toBe(graph.regions.find(region => region.regionId === 'composition-page')!.tabId)
  expect(vi.mocked(api.spatial.commit)).toHaveBeenCalledOnce()
})

it('[drag-composition] outside, original-position and keyboard pickup cancellation preserve original content and organization', async () => {
  const { from } = await dragPagePair()
  await new Promise(resolve => setTimeout(resolve, 80)); await checkpointSpatialWorkbench()
  const before = await core.read(), state = useAppStore.getState()
  vi.mocked(api.spatial.commit).mockClear()
  await dragPointer(from, { x: 850, y: 850 })
  const bounds = from.getBoundingClientRect(); await dragPointer(from, { x: bounds.left + 80, y: bounds.top + 15 })
  await act(async () => { from.focus(); from.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true })) })
  await vi.waitFor(() => expect(document.querySelector('.survey-page-list')?.getAttribute('data-dragging')).toBe('true'))
  await act(async () => from.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true })))
  await vi.waitFor(() => expect(document.querySelector('.survey-page-list')?.hasAttribute('data-dragging')).toBe(false))
  expect(vi.mocked(api.spatial.commit)).not.toHaveBeenCalled(); expect((await core.read())!.graph).toEqual(before!.graph)
  expect(useAppStore.getState().surveyOrganization).toBe(state.surveyOrganization)
  expect(useAppStore.getState().surveyZoneSelection).toBe(state.surveyZoneSelection)
  expect(useAppStore.getState().agentComposerDrafts).toBe(state.agentComposerDrafts)
  expect(useAppStore.getState().surveyCompositionRecoveries).toEqual([])
})

it('[drag-composition] explicit mixed selection drags exactly the selected page and whole Tab without changing navigation', async () => {
  const state = useAppStore.getState(), extra = createWorkbenchTab('source-neighbor', { kind: 'launcher', workspaceId: resource.id, regionId: 'neighbor-region' }, 'Selected complete note Tab')
  useAppStore.setState({ tabs: { ...state.tabs, [extra.id]: extra }, layouts: { ...state.layouts,
    [resource.id]: addTabOccurrence(state.layouts[resource.id]!, 'source-group', extra.id)! }, surveyPageReferences: [{ regionId: 'composition-page', browserId: 'composition-page' }] })
  await checkpointSpatialWorkbench(); dragGeometry(); await dom.render(<App />)
  const before = useAppStore.getState()
  await menu('Options for Source research'); await click(named('Select content to combine…'))
  const page = document.querySelector<HTMLElement>('[data-survey-page-region-id="composition-page"] input')!
  const whole = document.querySelector<HTMLElement>('[data-survey-tab-id="source-neighbor"]')!.closest('.survey-tab-cell')!.querySelector<HTMLElement>('input')!
  await click(page); await click(whole)
  expect(document.querySelector('.survey-composition-toolbar')?.textContent).toContain('2 selected')
  expect(useAppStore.getState().surveyZoneSelection).toBe(before.surveyZoneSelection)
  const targetRow = [...document.querySelectorAll<HTMLElement>('[data-survey-zone-id]')].find(row => row.dataset.surveyZoneId === zones.target)!, rect = targetRow.getBoundingClientRect()
  const from = document.querySelector<HTMLElement>('[data-survey-page-region-id="composition-page"] [data-survey-content-key]')!
  vi.mocked(api.spatial.commit).mockClear(); await dragPointer(from, { x: rect.left + 100, y: rect.top + 15 })
  await vi.waitFor(() => expect(useAppStore.getState().surveyPageReferences).toEqual([]))
  const graph = (await core.read())!.graph
  expect(graph.tabs.find(tab => tab.tabId === extra.id)!.zoneId).toBe(zones.target)
  expect(graph.tabs.find(tab => tab.regionIds.includes('composition-page'))!.zoneId).toBe(zones.target)
  expect(graph.tabs.find(tab => tab.tabId === 'composition-tab')!.regionIds.sort()).toEqual(['composition-agent-region', 'composition-file'])
  expect(document.querySelector('.survey-composition-toolbar')?.textContent).toContain('0 selected')
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(vi.mocked(api.spatial.commit)).toHaveBeenCalledOnce()
  await click(named('Cancel content selection'))
  expect(document.querySelector('.survey-composition-toolbar')).toBeNull()
})

it('[drag-composition] explicit selection narrows overlapping whole Tab into an exact page and offers the same keyboard and touch menu action', async () => {
  const { from } = await dragPagePair(), before = useAppStore.getState()
  await menu('Options for Source research'); await click(named('Select content to combine…'))
  await click(document.querySelector<HTMLElement>('[aria-label="Select all Tabs in Source research"]')!)
  expect(document.querySelector('.survey-composition-toolbar')?.textContent).toContain('1 selected')
  await click(from.closest('[data-survey-page-region-id]')!.querySelector<HTMLElement>('input')!)
  expect(document.querySelector('[aria-label="Select all Tabs in Source research"]')?.getAttribute('aria-checked')).toBe('mixed')
  expect(document.querySelector('.survey-composition-toolbar')?.textContent).toContain('1 selected')
  await menu('Actions for selected content'); await click(named('Move selected to research…'))
  await chooseField(named('Destination research'), JSON.stringify([zones.target, target.id, 'target-group']))
  vi.mocked(api.spatial.commit).mockClear(); await click(named('Move page'))
  await vi.waitFor(() => expect(useAppStore.getState().surveyPageReferences).toEqual([{ regionId: 'target-page', browserId: 'target-page' }]))
  expect(Object.keys(source().regions).sort()).toEqual(['composition-agent-region', 'composition-file'])
  expect(useAppStore.getState().surveyZoneSelection).toEqual(before.surveyZoneSelection)
  expect(vi.mocked(api.spatial.commit)).toHaveBeenCalledOnce()
})

it('[drag-composition] keyboard direct movement and Escape use the same valid-target predicate', async () => {
  const { from } = await dragPagePair()
  const key = async (value: string, code = value) => { await act(async () => from.dispatchEvent(new KeyboardEvent('keydown', { key: value, code, bubbles: true }))); await new Promise(resolve => setTimeout(resolve, 30)) }
  await act(async () => from.focus()); vi.mocked(api.spatial.commit).mockClear()
  await key(' ', 'Space'); await key('ArrowDown'); await key('Escape')
  expect(vi.mocked(api.spatial.commit)).not.toHaveBeenCalled()
  await key(' ', 'Space'); await key('ArrowDown'); await key(' ', 'Space')
  await vi.waitFor(() => expect(useAppStore.getState().surveyPageReferences).toEqual([]))
  expect(vi.mocked(api.spatial.commit)).toHaveBeenCalledOnce()
})

it('[drag-composition] unread saved recovery records remain visible and do not prevent healthy content composition', async () => {
  const unread = { requestId: 'unread-original', originalData: ['keep exact bytes'] }
  useAppStore.setState({ surveyCompositionRecoveries: [unread] })
  const { from, destination } = await dragPagePair()
  expect(document.querySelector('.survey-composition-recovery')?.textContent).toContain('could not be read')
  await dragPointer(from, destination)
  await vi.waitFor(() => expect(useAppStore.getState().surveyPageReferences).toEqual([]))
  expect(useAppStore.getState().surveyCompositionRecoveries).toEqual([unread])
  await prepareRendererUpdate()
  expect(JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state.surveyCompositionRecoveries).toEqual([unread])
})

it.runIf(Boolean(process.env.SURVEY_DRAG_RESTART_OUTCOME))('[drag-restart] two real processes preserve a newly composed research and unresolved exact intent through the original native user document', async () => {
  const path = process.env.SURVEY_COMPOSITION_RESTART_FILE!, outcome = process.env.SURVEY_DRAG_RESTART_OUTCOME
  if (process.env.SURVEY_COMPOSITION_RESTART_PHASE === 'write') {
    const splitDuringIntent = Boolean(process.env.SURVEY_DRAG_RESTART_SPLIT)
    if (splitDuringIntent) useAppStore.setState(state => ({ tabs: { ...state.tabs,
      'composition-tab': createWorkbenchTab('composition-tab', source().regions['composition-page']!) } }))
    const { from, destination } = await dragPagePair(), before = (await core.read())!.graph
    let laterSibling: string | undefined
    if (outcome === 'unknown') vi.mocked(api.spatial.commit).mockImplementation(async input => {
      const saved = await core.commit(input)
      if (input.graph.zones.some(zone => !before.zones.some(original => original.zoneId === zone.zoneId))) throw new Error('Original composition ACK lost')
      return saved
    })
    if (splitDuringIntent) vi.mocked(api.ui.requestStorageFlush).mockImplementation(async () => {
      if (!laterSibling && useAppStore.getState().surveyCompositionRecoveries.length) {
        await act(async () => { laterSibling = useAppStore.getState().splitRegion(resource.id, 'composition-tab', 'composition-page', 'right') })
      }
    })
    if (outcome === 'partial') vi.mocked(api.ui.requestStorageFlush).mockImplementation(async () => {
      if ((await core.read())!.graph.zones.length > before.zones.length) throw new Error('Original preference ACK lost')
    })
    await dragPointer(from, destination)
    if (outcome === 'moved') await vi.waitFor(() => { expect(useAppStore.getState().surveyPageReferences).toEqual([]); expect(useAppStore.getState().surveyCompositionRecoveries).toEqual([]) })
    else await vi.waitFor(() => { expect(document.querySelector('[data-survey-composition-request]')).not.toBeNull(); expect(useAppStore.getState().surveyCompositionRecoveries.filter(isSurveyCompositionRecovery)[0]?.report.outcome).toBe(outcome) })
    vi.mocked(api.ui.requestStorageFlush).mockResolvedValue(undefined); await prepareRendererUpdate()
    const user = new WorkbenchUserStateStore(path + '.user.json')
    await user.write(JSON.stringify({ state: {}, version: 1 }))
    const nativeDocument = createWorkbenchUserDocument({ readWorkbenchState: () => user.read(), importWorkbenchState: raw => user.importIfAbsent(raw), writeWorkbenchState: raw => user.write(raw) }, () => localStorage)
    await nativeDocument.hydrate()
    // This is an explicit host-boundary segment: original Store projection -> original document writer -> Main durable file.
    const projection = JSON.parse(localStorage.getItem(WORKBENCH_USER_STATE_KEY)!)
    await nativeDocument.persistent.checkpoint(WORKBENCH_USER_STATE_KEY, projection)
    const saved = JSON.parse((await user.read())!)
    expect(saved.state.surveyCompositionRecoveries).toEqual(useAppStore.getState().surveyCompositionRecoveries)
    const graph = (await core.read())!.graph, added = graph.zones.filter(zone => !before.zones.some(original => original.zoneId === zone.zoneId))
    expect(added).toHaveLength(1)
    await writeFile(path, JSON.stringify({ pid: process.pid, graph, targetZoneId: added[0]!.zoneId,
      laterSibling, pending: saved.state.surveyCompositionRecoveries, references: saved.state.surveyPageReferences, drafts: saved.state.agentComposerDrafts, selection: saved.state.surveyZoneSelection,
      nativeDocument: path + '.user.json', hostBoundary: 'Store preview projection -> createWorkbenchUserDocument -> WorkbenchUserStateStore private file; read process uses original document read then Store hydrate' }))
  } else {
    const saved = JSON.parse(await readFile(path, 'utf8')), state = useAppStore.getState()
    expect(saved.pid).not.toBe(process.pid); expect((await core.read())!.graph).toEqual(saved.graph)
    expect(state.surveyCompositionRecoveries).toEqual(saved.pending)
    expect(state.surveyPageReferences).toEqual(saved.references); expect(state.agentComposerDrafts).toEqual(saved.drafts)
    expect(state.surveyZoneSelection).toEqual(saved.selection)
    const members = catalog().tabs.filter(tab => tab.zoneId === saved.targetZoneId)
    expect(members.flatMap(tab => tab.regionIds).sort()).toEqual(['composition-page', 'target-page'])
    expect(state.spaceZoneBindings[saved.targetZoneId]).toMatchObject({ workspaceId: target.id })
    if (saved.laterSibling) expect(source().regions[saved.laterSibling]).toMatchObject({ kind: 'launcher', regionId: saved.laterSibling })
    else { expect(source().regions['composition-file']).toBeDefined(); expect(source().regions['composition-agent-region']).toHaveProperty('sessionId', session.id) }
    vi.mocked(api.spatial.commit).mockClear(); await dom.render(<App />)
    await vi.waitFor(() => expect(document.querySelector('[aria-label="Browser address"]')).not.toBeNull())
    if (outcome !== 'moved') {
      expect(state.surveyCompositionRecoveries.filter(isSurveyCompositionRecovery)[0]!.report.outcome).toBe(outcome)
      expect(document.querySelector('.survey-composition-recovery')?.textContent).toContain('Review combination')
      await click(document.querySelector<HTMLElement>('.survey-composition-recovery button')!)
      expect(document.querySelector('[data-survey-composition-request]')?.getAttribute('data-survey-composition-request')).toBe(saved.pending[0].requestId)
      await click(named('Check current target'))
      await vi.waitFor(() => expect(named('Repair Survey references').hasAttribute('disabled')).toBe(false))
      expect(useAppStore.getState().surveyCompositionRecoveries).toEqual(saved.pending)
    } else expect(state.surveyCollectedZones[saved.targetZoneId]).toBe(true)
    expect(vi.mocked(api.spatial.commit)).not.toHaveBeenCalled()
  }
})

it('[drag-composition] a changed current Region resource cannot repair an old unacknowledged move', async () => {
  const { from, destination } = await dragPagePair()
  vi.mocked(api.spatial.commit).mockImplementationOnce(async input => { await core.commit(input); throw new Error('Original CAS ACK lost') })
  await dragPointer(from, destination)
  await vi.waitFor(() => expect(document.querySelector('[data-survey-composition-request]')).not.toBeNull())
  const saved = (await core.read())!, originalIntent = useAppStore.getState().surveyCompositionRecoveries
  await core.commit({ expectedRevision: saved.revision, graph: { ...saved.graph,
    regions: saved.graph.regions.map(region => region.regionId === 'composition-page' ? { ...region, browserId: 'different-current-browser' } : region),
    resources: { ...saved.graph.resources, 'region:composition-page': { ...saved.graph.resources['region:composition-page'] as object, browserId: 'different-current-browser' } } } })
  const before = useAppStore.getState().surveyPageReferences
  vi.mocked(api.spatial.commit).mockClear(); await click(named('Check current target'))
  await vi.waitFor(() => expect(document.querySelector('[data-survey-composition-request]')?.textContent).toContain('not confirmed together'))
  expect(named('Repair Survey references').hasAttribute('disabled')).toBe(true)
  expect(useAppStore.getState().surveyCompositionRecoveries).toEqual(originalIntent)
  expect(useAppStore.getState().surveyPageReferences).toBe(before)
  expect(vi.mocked(api.spatial.commit)).not.toHaveBeenCalled()
})

it('[drag-composition] a later original split during intent saving survives the single composition CAS', async () => {
  const { from, destination } = await dragPagePair(), before = (await core.read())!.graph
  let release!: () => void, entered!: () => void, paused = false
  const held = new Promise<void>(resolve => { release = resolve }), saving = new Promise<void>(resolve => { entered = resolve })
  vi.mocked(api.ui.requestStorageFlush).mockImplementation(async () => {
    if (!paused && useAppStore.getState().surveyCompositionRecoveries.length) { paused = true; entered(); await held }
  })
  vi.mocked(api.spatial.commit).mockClear()
  try {
    await dragPointer(from, destination); await saving
    let sibling: string | undefined
    await act(async () => { sibling = useAppStore.getState().splitRegion(resource.id, 'composition-tab', 'composition-file', 'down') })
    expect(sibling).toBeDefined(); release()
    await vi.waitFor(() => expect(useAppStore.getState().surveyPageReferences).toEqual([]))
    await checkpointSpatialWorkbench()
    const graph = (await core.read())!.graph
    expect(source().regions[sibling!]).toMatchObject({ kind: 'launcher', regionId: sibling })
    expect(graph.regions.find(region => region.regionId === sibling)).toMatchObject({ tabId: 'composition-tab', kind: 'launcher' })
    const compositions = vi.mocked(api.spatial.commit).mock.calls.filter(([input]) => input.graph.zones.some(zone => !before.zones.some(original => original.zoneId === zone.zoneId)))
    // Later ordinary saves may retain the accepted new Zone; only its first appearance is the composition.
    expect(compositions[0]![0].graph.regions.some(region => region.regionId === sibling)).toBe(true)
  } finally { release(); vi.mocked(api.ui.requestStorageFlush).mockResolvedValue(undefined) }
})


// T7: original App / close owners, with the same typed Native and painted Agent/File leaves as this fixture.
const horizontalPageClose = () => document.querySelector<HTMLButtonElement>('[data-survey-page-region-id="composition-page"] .survey-item-tab-close')!
async function confirmHorizontalClose() {
  await vi.waitFor(() => expect(named('Close')).toBeDefined())
  await click(named('Close'))
}
async function horizontalPages(extra: { regionId: string; browserId: string }[] = []) {
  const page = { regionId: 'composition-page', browserId: 'composition-page' }
  useAppStore.setState({ surveyPageReferences: [page, ...extra] })
  await checkpointSpatialWorkbench()
  await dom.render(<App />)
  await vi.waitFor(() => expect(horizontalPageClose(), document.body.textContent ?? '').not.toBeNull())
  return page
}
it('[horizontal-close] background exact page closes only its original Region, removes its reference and keeps unknown references', async () => {
  const missing = { regionId: 'retained-missing-region', browserId: 'retained-missing-browser' }
  const page = await horizontalPages([missing]), before = useAppStore.getState(), selected = before.surveyZoneSelection
  const file = source().regions['composition-file'], agent = source().regions['composition-agent-region'], sessions = before.sessions
  const close = vi.spyOn(api.browser, 'close').mockResolvedValue(undefined)
  await click(horizontalPageClose()); await confirmHorizontalClose()
  await vi.waitFor(() => expect(source().regions[page.regionId]).toBeUndefined())
  expect(close).toHaveBeenCalledExactlyOnceWith(page.browserId)
  expect(source().regions['composition-file']).toBe(file); expect(source().regions['composition-agent-region']).toBe(agent)
  expect(useAppStore.getState().sessions).toBe(sessions)
  expect(useAppStore.getState().surveyPageReferences).toEqual([missing])
  expect(useAppStore.getState().surveyZoneSelection).toEqual(selected)
})
it('[horizontal-close] closing the current exact page clears only its own page choice', async () => {
  const page = await horizontalPages()
  await act(async () => useAppStore.setState({ surveyZoneSelection: { kind: 'page', ...page } }))
  vi.spyOn(api.browser, 'close').mockResolvedValue(undefined)
  await click(horizontalPageClose()); await confirmHorizontalClose()
  await vi.waitFor(() => expect(useAppStore.getState().surveyPageReferences).toEqual([]))
  expect(useAppStore.getState().surveyZoneSelection).toBeNull()
})
it('[horizontal-close] a Native close failure keeps the original Browser, exact reference, selection and sibling input', async () => {
  const page = await horizontalPages(), before = useAppStore.getState(), browser = source().regions[page.regionId]
  const file = document.querySelector<HTMLTextAreaElement>('[aria-label="Original file input"]')!; file.value = 'Original unsaved file text'
  const close = vi.spyOn(api.browser, 'close').mockRejectedValue(new Error('Close receipt unknown'))
  await click(horizontalPageClose()); await confirmHorizontalClose()
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(source().regions[page.regionId]).toBe(browser); expect(useAppStore.getState().surveyPageReferences).toEqual([page])
  expect(useAppStore.getState().surveyZoneSelection).toEqual(before.surveyZoneSelection)
  expect(document.querySelector('[aria-label="Original file input"]')).toBe(file); expect(file.value).toBe('Original unsaved file text')
})
it('[horizontal-close] a sole Browser uses the original Tab owner and leaves other Tabs untouched', async () => {
  const native = await api.browser.create('horizontal-single', 'https://single.example.test/', resource.id)
  const tab = createWorkbenchTab('horizontal-single-tab', { ...native, kind: 'browser', browserId: native.id, regionId: 'horizontal-single-region', workspaceId: resource.id, title: 'Single page' })
  const state = useAppStore.getState(), page = { regionId: 'horizontal-single-region', browserId: native.id }
  useAppStore.setState({ tabs: { ...state.tabs, [tab.id]: tab }, layouts: { ...state.layouts, [resource.id]: addTabOccurrence(state.layouts[resource.id]!, 'source-group', tab.id)! }, surveyPageReferences: [page] })
  await checkpointSpatialWorkbench(); await dom.render(<App />)
  const close = vi.spyOn(api.browser, 'close').mockResolvedValue(undefined), original = source()
  await vi.waitFor(() => expect(named('Close survey page: Single page')).toBeDefined()); await click(named('Close survey page: Single page')); await confirmHorizontalClose()
  await vi.waitFor(() => expect(useAppStore.getState().tabs[tab.id], JSON.stringify({error:useAppStore.getState().error,dialogs:[...document.querySelectorAll('[role=dialog]')].map(e=>e.textContent)})).toBeUndefined())
  expect(close).toHaveBeenCalledExactlyOnceWith(native.id); expect(source()).toBe(original)
  expect(useAppStore.getState().surveyPageReferences).toEqual([])
})
it('[horizontal-close] a retained page can remove its exact reference without a source or Native close', async () => {
  const missing = { regionId: 'retained-page', browserId: 'retained-browser' }; await horizontalPages([missing])
  const close = vi.spyOn(api.browser, 'close'), before = source()
  await menu('Options for Retained page'); await click(named('Remove page from Survey'))
  await vi.waitFor(() => expect(useAppStore.getState().surveyPageReferences).toEqual([{ regionId: 'composition-page', browserId: 'composition-page' }]))
  expect(close).not.toHaveBeenCalled(); expect(source()).toBe(before)
})
it('[horizontal-close] a retained research can remove only its saved reference without inventing a Zone', async () => {
  const unknown = 'retained-unknown-zone', state = useAppStore.getState()
  useAppStore.setState({ surveyCollectedZones: { ...state.surveyCollectedZones, [unknown]: true } })
  await dom.render(<App />); const before = (await core.read())!.graph
  await vi.waitFor(() => expect(named('Remove retained exploration from Survey')).toBeDefined())
  await click(named('Remove retained exploration from Survey'))
  await vi.waitFor(() => expect(useAppStore.getState().surveyCollectedZones[unknown]).toBeUndefined())
  expect((await core.read())!.graph).toEqual(before)
})
it('[horizontal-close] confirmed close preserves unread original page preference bytes', async () => {
  const page = await horizontalPages(), raw = [page, { unread: 'original bytes kept' }]
  useAppStore.setState({ surveyPageReadRecovery: { source: raw, issue: 'Original page references partially unread' } })
  vi.spyOn(api.browser, 'close').mockResolvedValue(undefined)
  await click(horizontalPageClose()); await confirmHorizontalClose()
  await vi.waitFor(() => expect(source().regions[page.regionId]).toBeUndefined())
  expect(useAppStore.getState().surveyPageReadRecovery?.source).toBe(raw)
  expect(useAppStore.getState().surveyPageReadRecovery?.source).toEqual([page, { unread: 'original bytes kept' }])
  await prepareRendererUpdate()
  expect(JSON.parse(localStorage.getItem(WORKBENCH_USER_STATE_KEY)!).state.surveyPageReferences).toEqual(raw)
})

it('[horizontal-close] canceling the original unknown-Agent close preserves content and does not call Native', async () => {
  const page = await horizontalPages(), before = useAppStore.getState(), browser = source().regions[page.regionId]
  const close = vi.spyOn(api.browser, 'close')
  await click(horizontalPageClose())
  await vi.waitFor(() => expect(named('Cancel')).toBeDefined())
  expect(document.body.textContent).toContain('Close without confirming the Agent?')
  expect(close).not.toHaveBeenCalled(); await click(named('Cancel'))
  expect(close).not.toHaveBeenCalled(); expect(source().regions[page.regionId]).toBe(browser)
  expect(useAppStore.getState().surveyPageReferences).toEqual([page]); expect(useAppStore.getState().surveyZoneSelection).toEqual(before.surveyZoneSelection)
})
it('[horizontal-close] a sole page with several real display Groups requires an exact choice and only detaches that binding', async () => {
  const native = await api.browser.create('horizontal-many', 'https://many.example.test/', resource.id)
  const tab = createWorkbenchTab('horizontal-many-tab', { ...native, kind: 'browser', browserId: native.id, regionId: 'horizontal-many-region', workspaceId: resource.id, title: 'Several positions' })
  const state = useAppStore.getState(), page = { regionId: 'horizontal-many-region', browserId: native.id }
  useAppStore.setState({ tabs: { ...state.tabs, [tab.id]: tab }, layouts: { ...state.layouts,
    [resource.id]: addTabOccurrence(state.layouts[resource.id]!, 'source-group', tab.id)!,
    [display.id]: addTabOccurrence(state.layouts[display.id]!, 'other-group', tab.id)! }, surveyPageReferences: [page] })
  await checkpointSpatialWorkbench(); await dom.render(<App />)
  const close = vi.spyOn(api.browser, 'close')
  await vi.waitFor(() => expect(named('Close survey page: Several positions')).toBeDefined()); await click(named('Close survey page: Several positions'))
  await vi.waitFor(() => expect(document.querySelectorAll('[data-survey-panel-reference]')).toHaveLength(2))
  expect(close).not.toHaveBeenCalled()
  const chosen = [...document.querySelectorAll<HTMLElement>('[data-survey-panel-reference]')].find(element => JSON.parse(element.dataset.surveyPanelReference!).displayWorkspaceId === display.id)!
  await click(chosen); await confirmHorizontalClose()
  await vi.waitFor(() => expect(useAppStore.getState().layouts[display.id]!.groups.find(group => group.id === 'other-group')!.tabOrder).not.toContain(tab.id))
  expect(useAppStore.getState().layouts[resource.id]!.groups.find(group => group.id === 'source-group')!.tabOrder).toContain(tab.id)
  expect(useAppStore.getState().tabs[tab.id]!.regions[page.regionId]).toBeDefined()
  expect(useAppStore.getState().surveyPageReferences).toEqual([page]); expect(close).not.toHaveBeenCalled()
})

it('[horizontal-close] the page menu closes the same exact Region through the original confirmation owner', async () => {
  const page = await horizontalPages(), close = vi.spyOn(api.browser, 'close').mockResolvedValue(undefined)
  const options = document.querySelector<HTMLElement>('[data-survey-page-region-id="composition-page"] .survey-item-options')!
  await menu(options.getAttribute('aria-label')!); await click(named('Close page')); await confirmHorizontalClose()
  await vi.waitFor(() => expect(source().regions[page.regionId]).toBeUndefined())
  expect(close).toHaveBeenCalledExactlyOnceWith(page.browserId)
  expect(source().regions['composition-file']).toBeDefined(); expect(source().regions['composition-agent-region']).toBeDefined()
})

it.runIf(Boolean(process.env.HORIZONTAL_CLOSE_RESTART))('[horizontal-restart] a second actual App process restores the surviving workface and exact retained reference after page close', async () => {
  const path = process.env.SURVEY_COMPOSITION_RESTART_FILE!, missing = { regionId: 'retained-after-restart', browserId: 'retained-browser-after-restart' }
  if (process.env.SURVEY_COMPOSITION_RESTART_PHASE === 'write') {
    await mkdir(resource.path, { recursive: true }); await writeFile(join(resource.path, 'draft.txt'), 'Original close-surviving file')
    const { files } = await originalFilePorts(), opened = await files.read(resource, 'draft.txt')
    expect(opened.status).toBe('read'); if (opened.status !== 'read') throw new Error('Original close-surviving file missing')
    useAppStore.setState({ documents: { [documentKey(resource.id, 'draft.txt')]: { ...opened.document, content: 'Unsent close-surviving draft' } }, documentIssues: {}, dirtyDocuments: { [documentKey(resource.id, 'draft.txt')]: true } })
    await files.dispose()
    const page = await horizontalPages([missing])
    await act(async () => useAppStore.setState({ surveyZoneSelection: { kind: 'page', ...page } }))
    vi.spyOn(api.browser, 'close').mockResolvedValue(undefined)
    await click(horizontalPageClose()); await confirmHorizontalClose()
    await vi.waitFor(() => expect(source().regions[page.regionId]).toBeUndefined())
    await checkpointSpatialWorkbench(); await prepareRendererUpdate()
    const state = useAppStore.getState()
    await writeFile(path, JSON.stringify({ pid: process.pid, record: localStorage.getItem(WORKBENCH_USER_STATE_KEY), graph: (await core.read())!.graph,
      selection: state.surveyZoneSelection, references: state.surveyPageReferences, drafts: state.agentComposerDrafts, documents: state.documents, dirty: state.dirtyDocuments }))
  } else {
    const saved = JSON.parse(await readFile(path, 'utf8')), state = useAppStore.getState()
    expect(saved.pid).not.toBe(process.pid); expect((await core.read())!.graph).toEqual(saved.graph)
    expect(state.surveyPageReferences).toEqual([missing]); expect(state.surveyZoneSelection).toBeNull()
    expect(source().regions['composition-page']).toBeUndefined()
    expect(source().regions['composition-file']).toMatchObject({ kind: 'file', workspaceId: resource.id, path: 'draft.txt' })
    expect(source().regions['composition-agent-region']).toMatchObject({ kind: 'agent', sessionId: session.id })
    expect(state.agentComposerDrafts).toEqual(saved.drafts); expect(state.documents).toEqual(saved.documents); expect(state.dirtyDocuments).toEqual(saved.dirty)
    await dom.render(<App />)
    await vi.waitFor(() => expect(document.querySelector('[aria-label="Original file input"]')).not.toBeNull())
    expect(document.querySelector('[aria-label="Original Agent input"]')).not.toBeNull()
    expect(document.querySelector('[data-survey-page-region-id="composition-page"]')).toBeNull()
    expect(document.querySelector('[data-survey-page-region-id="retained-after-restart"]')).not.toBeNull()
    await writeFile(path + '.read-proof.json', JSON.stringify({ pid: process.pid, writerPid: saved.pid, graph: (await core.read())!.graph,
      references: state.surveyPageReferences, selection: state.surveyZoneSelection, draft: state.agentComposerDrafts[session.id], fileDraft: state.documents[documentKey(resource.id, 'draft.txt')], visibleFile: true, visibleAgent: true }))
  }
})


it('[drag-intent-split] a sole page split during intent save keeps its reserved identity after a lost composition ACK', async () => {
  const state = useAppStore.getState(), page = source().regions['composition-page']!
  useAppStore.setState({ tabs: { ...state.tabs, 'composition-tab': createWorkbenchTab('composition-tab', page) } })
  const { from, destination } = await dragPagePair(), before = (await core.read())!.graph
  let release!: () => void, entered!: () => void, paused = false, compositionSubmissions = 0
  const held = new Promise<void>(resolve => { release = resolve }), saving = new Promise<void>(resolve => { entered = resolve })
  vi.mocked(api.ui.requestStorageFlush).mockImplementation(async () => {
    if (!paused && useAppStore.getState().surveyCompositionRecoveries.length) { paused = true; entered(); await held }
  })
  vi.mocked(api.spatial.commit).mockImplementation(async input => {
    const composing = input.graph.zones.some(zone => !before.zones.some(original => original.zoneId === zone.zoneId))
    const saved = await core.commit(input)
    if (composing) { ++compositionSubmissions; throw new Error('This original composition wrote but its ACK was lost') }
    return saved
  })
  try {
    await dragPointer(from, destination); await saving
    const initial = useAppStore.getState().surveyCompositionRecoveries.filter(isSurveyCompositionRecovery)[0]!
    expect(initial.report.tabIds[0]).toBe('composition-tab')
    let sibling: string | undefined
    await act(async () => { sibling = useAppStore.getState().splitRegion(resource.id, 'composition-tab', 'composition-page', 'right') })
    expect(sibling).toBeDefined(); release()
    await vi.waitFor(() => expect(document.querySelector('[data-survey-composition-request]')).not.toBeNull())
    const retained = useAppStore.getState().surveyCompositionRecoveries.filter(isSurveyCompositionRecovery)[0]!
    expect(retained.requestId).toBe(initial.requestId); expect(retained.target).toEqual(initial.target)
    expect(retained.report.outcome).toBe('unknown'); expect(compositionSubmissions).toBe(1)
    const moved = catalog().regions.find(region => region.regionId === 'composition-page')!
    expect(moved.tabId).not.toBe('composition-tab')
    const original = retained.sources.find(source => source.tabId === 'composition-tab')!
    expect(original.kind).toBe('page')
    if (original.kind !== 'page') throw new Error('Expected the original exact page intent')
    expect(original.promotedTabId).toBe(moved.tabId)
    expect(source().regions[sibling!]).toMatchObject({ kind: 'launcher', regionId: sibling })
    await click(named('Check current target'))
    await vi.waitFor(() => expect(named('Repair Survey references').hasAttribute('disabled')).toBe(false))
    expect(document.querySelector('[data-survey-composition-request]')?.textContent).toContain('does not confirm the earlier acknowledgement')
    vi.mocked(api.ui.requestStorageFlush).mockResolvedValue(undefined)
    await prepareRendererUpdate()
    expect(JSON.parse(localStorage.getItem(WORKBENCH_USER_STATE_KEY)!).state.surveyCompositionRecoveries).toEqual([retained])
    vi.mocked(api.spatial.commit).mockClear()
    await click(named('Repair Survey references'))
    await vi.waitFor(() => expect(useAppStore.getState().surveyCompositionRecoveries).toEqual([]))
    expect(useAppStore.getState().surveyPageReferences).toEqual([])
    expect(source().regions[sibling!]).toBeDefined()
    expect(vi.mocked(api.spatial.commit)).not.toHaveBeenCalled(); expect(compositionSubmissions).toBe(1)
  } finally { release(); vi.mocked(api.ui.requestStorageFlush).mockResolvedValue(undefined) }
})

it('[composition-browser-secondary-same-resource] original page menu keeps the same visible Browser input in a separate existing research on the same resource', async () => {
  const native = await api.browser.create('secondary-sibling', 'https://sibling.example.test/', resource.id)
  const state = useAppStore.getState(), page = source().regions['composition-page']!
  const paired = addWorkbenchRegion(createWorkbenchTab(source().id, page), page.regionId, 'right', {
    ...native, kind: 'browser', regionId: 'secondary-sibling', browserId: native.id, workspaceId: resource.id })
  const nearby = await state.createWorkbenchZone({ workspaceId: resource.id, spaceIds: [] })
  expect(nearby.save.clientStateWritten).toBe(true)
  useAppStore.setState({ surveyCollectedZones: { ...useAppStore.getState().surveyCollectedZones, [nearby.zone.zoneId]: true } })
  useAppStore.setState({ tabs: { ...state.tabs, [paired.id]: paired }, surveyPageReferences: [{ regionId: page.regionId, browserId: 'composition-page' }],
    surveyZoneSelection: { kind: 'page', regionId: page.regionId, browserId: 'composition-page' } })
  await checkpointSpatialWorkbench(); await dom.render(<App />)
  await vi.waitFor(() => expect(document.querySelector('.global-survey-surface [data-workbench-region-id="composition-page"] [aria-label="Browser address"]')).not.toBeNull())
  const input = document.querySelector<HTMLInputElement>('.global-survey-surface [data-workbench-region-id="composition-page"] [aria-label="Browser address"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Unsubmitted original secondary address'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 9, button: 0 })))
  input.setSelectionRange(3, 12)
  const originalPage = useAppStore.getState().tabs[paired.id]!.regions[page.regionId]
  const options = document.querySelector<HTMLElement>('[data-survey-page-region-id="composition-page"] [aria-haspopup="menu"]')!
  await menu(options.getAttribute('aria-label')!); await click(named('Move page to research…'))
  await chooseField(named('Destination research'), JSON.stringify([nearby.zone.zoneId, resource.id, 'source-group']))
  vi.mocked(api.spatial.commit).mockClear(); await click(named('Move page'))
  await vi.waitFor(() => expect(useAppStore.getState().surveyPageReferences).toEqual([]))
  const moved = catalog().regions.find(region => region.regionId === page.regionId)!
  expect(catalog().tabs.find(tab => tab.tabId === moved.tabId)!.zoneId).toBe(nearby.zone.zoneId)
  expect(useAppStore.getState().tabs[moved.tabId]!.regions[page.regionId]).toBe(originalPage)
  expect(Object.keys(source().regions)).toEqual(['secondary-sibling'])
  expect(document.querySelector('.global-survey-surface [data-workbench-region-id="composition-page"] [aria-label="Browser address"]')).toBe(input)
  expect(input.value).toBe('Unsubmitted original secondary address'); expect([input.selectionStart, input.selectionEnd]).toEqual([3, 12])
  expect(vi.mocked(api.spatial.commit)).toHaveBeenCalledOnce()
})

it('[survey-pin-ui] original row menu pins and unpins research while preserving its original group, order and input', async () => {
  await dom.render(<App />)
  const state = useAppStore.getState(), organization = state.surveyOrganization, membership = state.surveyCollectedZones, tabs = state.tabs
  const initial = [...document.querySelectorAll<HTMLElement>('[data-survey-zone-id]')].map(row => row.dataset.surveyZoneId)
  expect(document.querySelector('[aria-label="Pinned Survey items"]')).toBeNull()
  await menu('Options for Target research'); await click(named('Pin'))
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Pinned Survey items"] [data-survey-zone-id]')?.getAttribute('data-survey-zone-id')).toBe(zones.target))
  expect(document.querySelector('[aria-label="Pinned Survey items"] .survey-pin-mark')).not.toBeNull()
  expect([...document.querySelectorAll<HTMLElement>('[data-survey-zone-id]')].filter(row => row.dataset.surveyZoneId === zones.target)).toHaveLength(1)
  expect(useAppStore.getState().surveyOrganization).toBe(organization); expect(useAppStore.getState().surveyCollectedZones).toBe(membership)
  expect(useAppStore.getState().tabs).toBe(tabs); expect(useAppStore.getState().surveyZoneSelection).toBe(state.surveyZoneSelection)
  const read = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'read-menu-pin', operation: 'space.survey-list' })
  expect(read).toMatchObject({ pinnedReferences: [{ kind: 'zone', zoneId: zones.target }] })
  await menu('Options for Target research'); await click(named('Unpin'))
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Pinned Survey items"]')).toBeNull())
  expect([...document.querySelectorAll<HTMLElement>('[data-survey-zone-id]')].map(row => row.dataset.surveyZoneId)).toEqual(initial)
  expect(useAppStore.getState().tabs).toBe(tabs)
})

it('[survey-pin-ui] an ordinary page remains unpinned until its menu action and keeps its exact Close while pinned', async () => {
  headerCloseOwner = await connectWorkbenchCloseApiOwner()
  const page = await horizontalPages(), before = useAppStore.getState(), oldFile = source().regions['composition-file'], oldAgent = source().regions['composition-agent-region']
  expect(document.querySelector('[aria-label="Pinned Survey items"]')).toBeNull()
  const options = document.querySelector<HTMLElement>('[data-survey-page-region-id="composition-page"] .survey-item-options')!
  await menu(options.getAttribute('aria-label')!); await click(named('Pin'))
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Pinned Survey items"] [data-survey-page-region-id="composition-page"] .survey-item-tab-close')).not.toBeNull())
  const read = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'read-exact-menu-pin', operation: 'space.survey-list' })
  expect(read).toMatchObject({ pinnedReferences: [{ kind: 'page', ...page }] })
  const close = vi.spyOn(api.browser, 'close').mockResolvedValue(undefined)
  await click(horizontalPageClose()); await confirmHorizontalClose()
  await vi.waitFor(() => expect(useAppStore.getState().surveyPageReferences).toEqual([]))
  expect(close).toHaveBeenCalledWith(page.browserId)
  expect(source().regions['composition-file']).toBe(oldFile); expect(source().regions['composition-agent-region']).toBe(oldAgent)
  expect(useAppStore.getState().sessions).toBe(before.sessions); expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(document.querySelector('[aria-label="Pinned Survey items"] [data-survey-page-region-id="composition-page"]')).toBeNull()
})

it('[survey-pin-ui] a retained unavailable research can be unpinned without deleting its reference or other preferences', async () => {
  const state = useAppStore.getState(), key = JSON.stringify(['zone', 'retained-missing-zone'])
  useAppStore.setState({ surveyCollectedZones: { ...state.surveyCollectedZones, 'retained-missing-zone': true },
    pinnedItems: { ...state.pinnedItems, 'survey-workbench': [key] } })
  await dom.render(<App />)
  const beforeUnpin = useAppStore.getState()
  const row = document.querySelector<HTMLElement>('[data-survey-zone-id="retained-missing-zone"]')!
  expect(row).not.toBeNull()
  const options = row.querySelector<HTMLElement>('[aria-haspopup="menu"]')!
  await menu(options.getAttribute('aria-label')!); await click(named('Unpin'))
  await vi.waitFor(() => expect(useAppStore.getState().pinnedItems['survey-workbench']).toBeUndefined())
  expect(useAppStore.getState().surveyCollectedZones['retained-missing-zone']).toBe(true)
  expect(useAppStore.getState().tabs).toBe(beforeUnpin.tabs)
  expect(useAppStore.getState().agentComposerDrafts).toBe(state.agentComposerDrafts)
})

async function prepareDetach(includeNeighbor = true) {
  const state = useAppStore.getState(), neighbor = createWorkbenchTab('detach-neighbor', { kind: 'launcher', workspaceId: resource.id, regionId: 'detach-neighbor-region' })
  useAppStore.setState({ tabs: includeNeighbor ? { ...state.tabs, [neighbor.id]: neighbor } : state.tabs, layouts: includeNeighbor ? { ...state.layouts,
    [resource.id]: addTabOccurrence(state.layouts[resource.id]!, 'source-group', neighbor.id)! } : state.layouts,
    surveyOrganization: { ungrouped: [zones.source, zones.target], groups: [{ groupId: 'reading-group', name: 'Reading', collapsed: false, zoneIds: [] }] } })
  await checkpointSpatialWorkbench(); dragGeometry(); await dom.render(<App />)
  if (includeNeighbor) await vi.waitFor(() => expect(document.querySelector('[data-survey-tab-id="composition-tab"]')).not.toBeNull())
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Original file input"]')).not.toBeNull())
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Browser address"]')).not.toBeNull())
  await checkpointSpatialWorkbench()
  return document.querySelector<HTMLElement>('[data-survey-tab-id="composition-tab"]')!
}
async function chooseDetachLocation() {
  const trigger = document.querySelector<HTMLElement>('[aria-label="Research location"]')
  if (!trigger) return
  await menu('Research location')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"][data-value]')].find(item => {
    if (!item.dataset.value) return false
    const tuple = JSON.parse(item.dataset.value)
    return tuple[1] === resource.id && tuple[2] === resource.id && tuple[3] === 'source-group'
  })!
  expect(item).toBeDefined(); const value = item.dataset.value!; await click(item)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  await vi.waitFor(() => expect(trigger.dataset.value).toBe(value))
  await click(named('Create research'))
}

it.each(['independent', 'list group'] as const)('[detach] actual pointer moves one complete Tab to %s and preserves its original input tree and siblings', async targetKind => {
  const from = await prepareDetach(), before = useAppStore.getState(), graphBefore = (await core.read())!.graph
  const editor = document.querySelector<HTMLTextAreaElement>('[aria-label="Original file input"]')!
  const address = document.querySelector<HTMLInputElement>('[aria-label="Browser address"]')!
  expect(editor).not.toBeNull(); expect(address).not.toBeNull()
  editor.value = 'Original unsaved detach editor'; editor.setSelectionRange(2, 8)
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(address, 'https://unsubmitted-detach.example.test/'); address.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => address.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 9, button: 0 })))
  address.setSelectionRange(8, 19)
  const lifecycle = ['create', 'navigate', 'close'].map(name => vi.spyOn(api.browser, name as 'create'))
  expect(document.querySelector('[data-survey-independent-target]')).toBeNull()
  vi.mocked(api.spatial.commit).mockClear()
  const groupBounds = document.querySelector<HTMLElement>('[data-survey-list-target="reading-group"]')!.getBoundingClientRect()
  await dragPointer(from, targetKind === 'independent' ? { x: 100, y: 918 } : { x: groupBounds.left + 90, y: groupBounds.top + 18 })
  await vi.waitFor(() => expect(Boolean(document.querySelector('[aria-label="Research location"]')) || catalog().tabs.find(tab => tab.tabId === 'composition-tab')!.zoneId !== zones.source).toBe(true))
  await chooseDetachLocation()
  await vi.waitFor(() => expect(catalog().tabs.find(tab => tab.tabId === 'composition-tab')!.zoneId).not.toBe(zones.source))
  const graph = (await core.read())!.graph, added = graph.zones.filter(zone => !graphBefore.zones.some(original => original.zoneId === zone.zoneId))
  expect(added).toHaveLength(1); const detached = added[0]!
  expect(graph.tabs.filter(tab => tab.zoneId === detached.zoneId).map(tab => tab.tabId)).toEqual(['composition-tab'])
  expect(catalog().tabs.find(tab => tab.tabId === 'detach-neighbor')!.zoneId).toBe(zones.source)
  await vi.waitFor(() => expect(useAppStore.getState().surveyCollectedZones[detached.zoneId]).toBe(true))
  await vi.waitFor(() => expect(useAppStore.getState().surveyCompositionRecoveries).toEqual([]))
  expect(graph.resources['zone:' + detached.zoneId]).toHaveProperty('workspaceId', resource.id)
  for (const region of Object.values(before.tabs['composition-tab']!.regions)) {
    expect(source().regions[region.regionId]).toBe(region)
    expect(graph.resources['region:' + region.regionId]).toEqual(graphBefore.resources['region:' + region.regionId])
  }
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(document.querySelector('[aria-label="Original file input"]')).toBe(editor)
  expect(editor.value).toBe('Original unsaved detach editor'); expect([editor.selectionStart, editor.selectionEnd]).toEqual([2, 8])
  expect(document.querySelector('[aria-label="Browser address"]')).toBe(address)
  expect(address.value).toBe('https://unsubmitted-detach.example.test/'); expect([address.selectionStart, address.selectionEnd]).toEqual([8, 19])
  expect(vi.mocked(api.spatial.commit)).toHaveBeenCalledOnce()
  for (const call of lifecycle) expect(call).not.toHaveBeenCalled()
  expect(document.querySelector('[data-survey-independent-target]')).toBeNull()
  if (targetKind === 'list group') expect(useAppStore.getState().surveyOrganization.groups[0]!.zoneIds).toEqual([detached.zoneId])
})

it('[detach] actual research-body pointer drop on a list heading changes only the original organization', async () => {
  await prepareDetach()
  const before = useAppStore.getState(), graph = (await core.read())!.graph
  const from = [...document.querySelectorAll<HTMLElement>('[data-survey-content-key]')].find(element => element.dataset.surveyContentKey === JSON.stringify(['research', zones.source]))!
  expect(from).toBeDefined(); vi.mocked(api.spatial.commit).mockClear()
  await dragPointer(from, { x: 100, y: 782 })
  await vi.waitFor(() => expect(useAppStore.getState().surveyOrganization.groups[0]!.zoneIds).toEqual([zones.source]))
  expect((await core.read())!.graph).toEqual(graph)
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().surveyCollectedZones).toBe(before.surveyCollectedZones)
  expect(useAppStore.getState().surveyZoneSelection).toBe(before.surveyZoneSelection)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(vi.mocked(api.spatial.commit)).not.toHaveBeenCalled()
})

async function detachIntoGroup(from: HTMLElement) {
  const rect = document.querySelector<HTMLElement>('[data-survey-list-target="reading-group"]')!.getBoundingClientRect()
  await dragPointer(from, { x: rect.left + 90, y: rect.top + 18 })
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Research location"]')).not.toBeNull())
  await chooseDetachLocation()
}

it.each(['unknown', 'partial'] as const)('[detach] pointer %s preserves its exact list group and repairs only preferences without replay', async outcome => {
  const from = await prepareDetach(), before = (await core.read())!.graph
  if (outcome === 'unknown') vi.mocked(api.spatial.commit).mockImplementation(async input => {
    const saved = await core.commit(input)
    if (input.graph.zones.some(zone => !before.zones.some(original => original.zoneId === zone.zoneId))) throw new Error('Original detach CAS ACK lost')
    return saved
  })
  else vi.mocked(api.ui.requestStorageFlush).mockImplementation(async () => {
    if ((await core.read())!.graph.zones.length > before.zones.length) throw new Error('Original combined Survey save ACK lost')
  })
  vi.mocked(api.spatial.commit).mockClear(); await detachIntoGroup(from)
  await vi.waitFor(() => expect(useAppStore.getState().surveyCompositionRecoveries.filter(isSurveyCompositionRecovery)[0]?.report.outcome).toBe(outcome))
  const held = useAppStore.getState().surveyCompositionRecoveries.filter(isSurveyCompositionRecovery)[0]!
  expect(held.surveyGroupId).toBe('reading-group'); expect(held.sources).toHaveLength(1); expect(held.sources[0]!.tabId).toBe('composition-tab')
  expect(vi.mocked(api.spatial.commit)).toHaveBeenCalledOnce()
  expect(catalog().tabs.find(tab => tab.tabId === 'detach-neighbor')!.zoneId).toBe(zones.source)
  vi.mocked(api.ui.requestStorageFlush).mockResolvedValue(undefined)
  const state = useAppStore.getState(), unrelated = { groupId: 'later-user-group', name: 'Later user organization', collapsed: true, zoneIds: [zones.target] }
  await act(async () => { await state.setSurveyOrganization({ ungrouped: state.surveyOrganization.ungrouped.filter(id => id !== zones.target),
    groups: [...state.surveyOrganization.groups.map(group => ({ ...group, name: 'Renamed destination' })), unrelated] }, state.surveyOrganization) })
  vi.mocked(api.spatial.commit).mockClear()
  await vi.waitFor(() => expect(document.querySelector('[data-survey-composition-request]')?.getAttribute('data-survey-composition-request')).toBe(held.requestId))
  expect(document.querySelector('[data-survey-composition-request]')!.textContent).toContain('reading-group')
  await click(named('Check current target')); await vi.waitFor(() => expect(named('Repair Survey references').hasAttribute('disabled')).toBe(false))
  expect(useAppStore.getState().surveyCompositionRecoveries.filter(isSurveyCompositionRecovery)[0]!.requestId).toBe(held.requestId)
  await click(named('Repair Survey references'))
  await vi.waitFor(() => expect(useAppStore.getState().surveyCompositionRecoveries).toEqual([]))
  expect(useAppStore.getState().surveyOrganization.groups.find(group => group.groupId === 'reading-group')!.zoneIds).toEqual([held.target.zoneId])
  expect(useAppStore.getState().surveyOrganization.groups.find(group => group.groupId === unrelated.groupId)).toEqual(unrelated)
  expect(useAppStore.getState().surveyCollectedZones[held.target.zoneId]).toBe(true)
  expect(vi.mocked(api.spatial.commit)).not.toHaveBeenCalled()
})

it('[detach] a list group deleted while the intent saves refuses before the first composition CAS', async () => {
  const from = await prepareDetach(), before = (await core.read())!.graph
  let deleted = false
  vi.mocked(api.ui.requestStorageFlush).mockImplementation(async () => {
    if (!deleted && useAppStore.getState().surveyCompositionRecoveries.length) {
      deleted = true; await act(async () => useAppStore.setState(state => ({ surveyOrganization: { ...state.surveyOrganization, groups: [] } })))
    }
  })
  vi.mocked(api.spatial.commit).mockClear(); await detachIntoGroup(from)
  await vi.waitFor(() => expect(document.body.textContent).toContain('list group no longer exists'))
  expect(deleted).toBe(true); expect((await core.read())!.graph).toEqual(before)
  expect(useAppStore.getState().surveyCompositionRecoveries).toEqual([])
  expect(vi.mocked(api.spatial.commit)).not.toHaveBeenCalled()
})

it('[detach] a list group deleted after Core commit stays partial and never silently falls into Ungrouped', async () => {
  const from = await prepareDetach(), before = (await core.read())!.graph
  vi.mocked(api.spatial.commit).mockImplementation(async input => {
    const saved = await core.commit(input)
    if (input.graph.zones.some(zone => !before.zones.some(original => original.zoneId === zone.zoneId)))
      await act(async () => useAppStore.setState(state => ({ surveyOrganization: { ...state.surveyOrganization, groups: [] } })))
    return saved
  })
  await detachIntoGroup(from)
  await vi.waitFor(() => expect(useAppStore.getState().surveyCompositionRecoveries.filter(isSurveyCompositionRecovery)[0]?.report.outcome).toBe('partial'))
  const held = useAppStore.getState().surveyCompositionRecoveries.filter(isSurveyCompositionRecovery)[0]!
  expect(held.surveyGroupId).toBe('reading-group')
  expect(useAppStore.getState().surveyCollectedZones[held.target.zoneId]).toBeUndefined()
  expect(useAppStore.getState().surveyOrganization.ungrouped).not.toContain(held.target.zoneId)
  vi.mocked(api.spatial.commit).mockClear()
  const checked = await useAppStore.getState().reviewSurveyComposition(held.requestId, true)
  expect(checked).toMatchObject({ targetConfirmed: true, referencesRepaired: false }); expect(checked.issue).toContain('group no longer exists')
  expect(useAppStore.getState().surveyCompositionRecoveries.filter(isSurveyCompositionRecovery)[0]!.requestId).toBe(held.requestId)
  const current = useAppStore.getState()
  await current.setSurveyOrganization({ ...current.surveyOrganization, groups: [{ groupId: 'another-reading-group', name: 'Reading', collapsed: false, zoneIds: [] }] }, current.surveyOrganization)
  expect((await useAppStore.getState().reviewSurveyComposition(held.requestId, true)).referencesRepaired).toBe(false)
  const changed = useAppStore.getState()
  await changed.setSurveyOrganization({ ...changed.surveyOrganization, groups: [...changed.surveyOrganization.groups, { groupId: 'reading-group', name: 'Original destination restored', collapsed: true, zoneIds: [] }] }, changed.surveyOrganization)
  expect((await useAppStore.getState().reviewSurveyComposition(held.requestId, true)).referencesRepaired).toBe(true)
  expect(useAppStore.getState().surveyOrganization.groups.find(group => group.groupId === 'reading-group')!.zoneIds).toEqual([held.target.zoneId])
  expect(vi.mocked(api.spatial.commit)).not.toHaveBeenCalled()
})

it('[detach] the named group ID ungrouped and the actual Ungrouped target stay distinct for real pointer drops', async () => {
  await prepareDetach()
  await act(async () => useAppStore.setState(state => ({ surveyOrganization: { ...state.surveyOrganization,
    groups: [{ groupId: 'ungrouped', name: 'Named ungrouped group', collapsed: true, zoneIds: [] }] } })))
  const sourceButton = () => [...document.querySelectorAll<HTMLElement>('[data-survey-content-key]')].find(element => element.dataset.surveyContentKey === JSON.stringify(['research', zones.source]))!
  const actual = document.querySelector<HTMLElement>('[data-survey-list-target="ungrouped"][data-survey-list-target-kind="ungrouped"]')!
  const namedGroup = document.querySelector<HTMLElement>('[data-survey-list-target="ungrouped"][data-survey-list-target-kind="group"]')!
  expect(actual).not.toBeNull(); expect(namedGroup).not.toBeNull(); expect(actual).not.toBe(namedGroup)
  vi.mocked(api.spatial.commit).mockClear()
  const first = namedGroup.getBoundingClientRect(); await dragPointer(sourceButton(), { x: first.left + 90, y: first.top + 18 })
  await vi.waitFor(() => expect(useAppStore.getState().surveyOrganization.groups[0]!.zoneIds).toEqual([zones.source]))
  expect(useAppStore.getState().surveyOrganization.ungrouped).not.toContain(zones.source)
  // Expand through the original owner so the original source is a reachable second drag source.
  const state = useAppStore.getState(); await act(async () => { await state.setSurveyOrganization({ ...state.surveyOrganization,
    groups: state.surveyOrganization.groups.map(group => ({ ...group, collapsed: false })) }, state.surveyOrganization) })
  const second = actual.getBoundingClientRect(); await dragPointer(sourceButton(), { x: second.left + 90, y: second.top + 18 })
  await vi.waitFor(() => expect(useAppStore.getState().surveyOrganization.groups[0]!.zoneIds).toEqual([]))
  expect(useAppStore.getState().surveyOrganization.ungrouped).toContain(zones.source)
  expect(vi.mocked(api.spatial.commit)).not.toHaveBeenCalled()
})

it.each(['research', 'tab'] as const)('[detach] a %s gesture keeps its original scope when the original owner adds a sibling during pickup', async kind => {
  const tab = await prepareDetach(kind === 'tab')
  const research = [...document.querySelectorAll<HTMLElement>('[data-survey-content-key]')].find(element => element.dataset.surveyContentKey === JSON.stringify(['research', zones.source]))!
  const from = kind === 'research' ? research : tab, targetRect = document.querySelector<HTMLElement>('[data-survey-list-target="reading-group"]')!.getBoundingClientRect()
  let sibling: string | undefined, afterSibling: import('../../../packages/core/src/spatial-graph').AgentMuxSpatialGraph | undefined
  await dragPointer(from, { x: targetRect.left + 90, y: targetRect.top + 18 }, async () => {
    if (kind === 'research') expect(document.querySelector('[data-survey-independent-target]')).toBeNull()
    await act(async () => { sibling = useAppStore.getState().openLauncher({ workspaceId: resource.id, displayWorkspaceId: resource.id, tabGroupId: 'source-group', zoneId: zones.source, reveal: false }) })
    expect(sibling).toBeDefined(); await checkpointSpatialWorkbench(); afterSibling = (await core.read())!.graph
    if (kind === 'research') expect(document.querySelector('[data-survey-independent-target]')).toBeNull()
    vi.mocked(api.spatial.commit).mockClear()
  })
  if (kind === 'research') {
    await vi.waitFor(() => expect(useAppStore.getState().surveyOrganization.groups[0]!.zoneIds).toEqual([zones.source]))
    expect((await core.read())!.graph).toEqual(afterSibling); expect(vi.mocked(api.spatial.commit)).not.toHaveBeenCalled()
  } else {
    await vi.waitFor(() => expect(document.querySelector('[aria-label="Research location"]')).not.toBeNull()); await chooseDetachLocation()
    await vi.waitFor(() => expect(useAppStore.getState().surveyCompositionRecoveries).toEqual([]))
    await vi.waitFor(() => expect(catalog().tabs.find(tab => tab.tabId === 'composition-tab')!.zoneId).not.toBe(zones.source))
    expect(vi.mocked(api.spatial.commit)).toHaveBeenCalledOnce()
  }
  expect(catalog().tabs.find(tab => tab.tabId === sibling)!.zoneId).toBe(zones.source)
})

it('[detach] explicit selection of several researches cannot silently combine into one artificial list-group item', async () => {
  const from = await prepareDetach(), before = useAppStore.getState(), graph = (await core.read())!.graph
  await menu('Options for Source research'); await click(named('Select content to combine…'))
  await click(document.querySelector<HTMLElement>('[aria-label="Select all Tabs in Source research"]')!)
  await click(document.querySelector<HTMLElement>('[aria-label="Select all Tabs in Target research"]')!)
  expect(document.querySelector('.survey-composition-toolbar')?.textContent).toContain('3 selected')
  const rect = document.querySelector<HTMLElement>('[data-survey-list-target="reading-group"]')!.getBoundingClientRect()
  vi.mocked(api.spatial.commit).mockClear(); await dragPointer(from, { x: rect.left + 90, y: rect.top + 18 })
  expect(document.querySelector('[aria-label="Research location"]')).toBeNull()
  expect(useAppStore.getState().surveyOrganization).toBe(before.surveyOrganization)
  expect((await core.read())!.graph).toEqual(graph); expect(vi.mocked(api.spatial.commit)).not.toHaveBeenCalled()
  expect(document.querySelector('.survey-composition-toolbar')?.textContent).toContain('3 selected')
  await menu('Actions for selected content')
  const groupAction = named('Move selected to list group')
  expect(groupAction.getAttribute('aria-disabled')).toBe('true')
  expect(named('Move selected to research…').getAttribute('aria-disabled')).not.toBe('true')
})

it('[detach] exact single-Tab selection has the same reachable list-group menu action', async () => {
  const from = await prepareDetach()
  await menu('Options for Source research'); await click(named('Select content to combine…'))
  await click(from.closest('.survey-tab-cell')!.querySelector<HTMLElement>('input')!)
  expect(document.querySelector('.survey-composition-toolbar')?.textContent).toContain('1 selected')
  await menu('Actions for selected content')
  const sub = named('Move selected to list group'); await act(async () => { sub.focus(); sub.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true })) })
  await vi.waitFor(() => expect(named('Reading')).toBeDefined()); await click(named('Reading'))
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Research location"]')).not.toBeNull()); vi.mocked(api.spatial.commit).mockClear(); await chooseDetachLocation()
  await vi.waitFor(() => expect(useAppStore.getState().surveyOrganization.groups[0]!.zoneIds).toHaveLength(1))
  const zoneId = useAppStore.getState().surveyOrganization.groups[0]!.zoneIds[0]!
  expect(catalog().tabs.filter(tab => tab.zoneId === zoneId).map(tab => tab.tabId)).toEqual(['composition-tab'])
  expect(catalog().tabs.find(tab => tab.tabId === 'detach-neighbor')!.zoneId).toBe(zones.source)
  expect(vi.mocked(api.spatial.commit)).toHaveBeenCalledOnce()
})

it('[detach] outside and keyboard cancellation keep the source when the explicit independent target exists', async () => {
  const from = await prepareDetach(), before = useAppStore.getState(), graph = (await core.read())!.graph
  vi.mocked(api.spatial.commit).mockClear(); await dragPointer(from, { x: 850, y: 850 }, async () => {
    expect(document.querySelector('[data-survey-independent-target]')).not.toBeNull()
  })
  expect(document.querySelector('[aria-label="Research location"]')).toBeNull()
  await act(async () => { from.focus(); from.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true })) })
  await vi.waitFor(() => expect(document.querySelector('[data-survey-independent-target]')).not.toBeNull())
  await act(async () => from.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })))
  await vi.waitFor(() => expect(document.querySelector('[data-survey-independent-target]')).toBeNull())
  expect(useAppStore.getState().surveyOrganization).toBe(before.surveyOrganization); expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().surveyZoneSelection).toBe(before.surveyZoneSelection); expect((await core.read())!.graph).toEqual(graph)
  expect(vi.mocked(api.spatial.commit)).not.toHaveBeenCalled()
})

it.runIf(Boolean(process.env.SURVEY_DETACH_RESTART))('[detach-restart] a second actual process restores the original grouped intent from the native user document and repairs without composition', async () => {
  const path = process.env.SURVEY_COMPOSITION_RESTART_FILE!, outcome = process.env.SURVEY_DRAG_RESTART_OUTCOME!
  if (process.env.SURVEY_COMPOSITION_RESTART_PHASE === 'write') {
    await mkdir(resource.path, { recursive: true }); await writeFile(join(resource.path, 'draft.txt'), 'Original file retained across detach')
    const from = await prepareDetach(), before = (await core.read())!.graph
    if (outcome === 'unknown') vi.mocked(api.spatial.commit).mockImplementation(async input => {
      const saved = await core.commit(input)
      if (input.graph.zones.some(zone => !before.zones.some(original => original.zoneId === zone.zoneId))) throw new Error('Original detach ACK unknown')
      return saved
    })
    else vi.mocked(api.ui.requestStorageFlush).mockImplementation(async () => { if ((await core.read())!.graph.zones.length > before.zones.length) throw new Error('Original grouped save ACK lost') })
    await detachIntoGroup(from)
    await vi.waitFor(() => expect(document.querySelector('[data-survey-composition-request]')).not.toBeNull())
    await vi.waitFor(() => expect(useAppStore.getState().surveyCompositionRecoveries.filter(isSurveyCompositionRecovery)[0]?.report.outcome).toBe(outcome))
    const pending = useAppStore.getState().surveyCompositionRecoveries.filter(isSurveyCompositionRecovery)[0]!
    expect(pending.surveyGroupId).toBe('reading-group')
    vi.mocked(api.ui.requestStorageFlush).mockResolvedValue(undefined); await prepareRendererUpdate()
    const user = new WorkbenchUserStateStore(path + '.user.json'); await user.write(JSON.stringify({ state: {}, version: 1 }))
    const nativeDocument = createWorkbenchUserDocument({ readWorkbenchState: () => user.read(), importWorkbenchState: raw => user.importIfAbsent(raw), writeWorkbenchState: raw => user.write(raw) }, () => localStorage)
    await nativeDocument.hydrate(); await nativeDocument.persistent.checkpoint(WORKBENCH_USER_STATE_KEY, JSON.parse(localStorage.getItem(WORKBENCH_USER_STATE_KEY)!))
    const saved = JSON.parse((await user.read())!)
    expect(saved.state.surveyCompositionRecoveries[0]).toEqual(pending)
    await writeFile(path, JSON.stringify({ pid: process.pid, graph: (await core.read())!.graph, pending, organization: saved.state.surveyOrganization,
      drafts: saved.state.agentComposerDrafts, selection: saved.state.surveyZoneSelection,
      hostBoundary: 'Actual Pointer/App/Store -> preview serialized projection -> original createWorkbenchUserDocument -> Main WorkbenchUserStateStore private file; reader hydrates original document in a fresh process. No installed/native Runtime claim.' }))
  } else {
    const saved = JSON.parse(await readFile(path, 'utf8')), state = useAppStore.getState()
    expect(saved.pid).not.toBe(process.pid); expect((await core.read())!.graph).toEqual(saved.graph)
    expect(state.surveyCompositionRecoveries.filter(isSurveyCompositionRecovery)[0]).toEqual(saved.pending)
    expect(state.surveyOrganization).toEqual(saved.organization); expect(state.agentComposerDrafts).toEqual(saved.drafts); expect(state.surveyZoneSelection).toEqual(saved.selection)
    const file = await restartFiles!.read(resource, 'draft.txt'); expect(file.status).toBe('read')
    if (file.status === 'read') expect(file.document.content).toBe('Original file retained across detach')
    expect(catalog().tabs.find(tab => tab.tabId === 'composition-tab')!.zoneId).toBe(saved.pending.target.zoneId)
    expect(catalog().tabs.find(tab => tab.tabId === 'detach-neighbor')!.zoneId).not.toBe(saved.pending.target.zoneId)
    await dom.render(<App />); await vi.waitFor(() => expect(document.querySelector('.survey-composition-recovery button')).not.toBeNull())
    vi.mocked(api.spatial.commit).mockClear(); await click(document.querySelector<HTMLElement>('.survey-composition-recovery button')!)
    expect(document.querySelector('[data-survey-composition-request]')?.getAttribute('data-survey-composition-request')).toBe(saved.pending.requestId)
    await click(named('Check current target')); await vi.waitFor(() => expect(named('Repair Survey references').hasAttribute('disabled')).toBe(false))
    expect(useAppStore.getState().surveyCompositionRecoveries.filter(isSurveyCompositionRecovery)[0]).toEqual(saved.pending)
    await click(named('Repair Survey references')); await vi.waitFor(() => expect(useAppStore.getState().surveyCompositionRecoveries).toEqual([]))
    expect(useAppStore.getState().surveyOrganization.groups.find(group => group.groupId === 'reading-group')!.zoneIds).toEqual([saved.pending.target.zoneId])
    expect(vi.mocked(api.spatial.commit)).not.toHaveBeenCalled()
    await writeFile(path + '.read-proof.json', JSON.stringify({ pid: process.pid, writerPid: saved.pid, requestId: saved.pending.requestId, surveyGroupId: saved.pending.surveyGroupId, originalTarget: saved.pending.target, originalSources: saved.pending.sources, referencesRepaired: true, compositionCommits: 0 }))
  }
})

it('[detach-public] the actual source-built CLI discovers the same GUI-created independent research and exact manual group', async () => {
  const from = await prepareDetach(); await detachIntoGroup(from)
  await vi.waitFor(() => expect(useAppStore.getState().surveyOrganization.groups[0]!.zoneIds).toHaveLength(1))
  const zoneId = useAppStore.getState().surveyOrganization.groups[0]!.zoneIds[0]!
  expect((await core.read())!.graph.tabs.find(tab => tab.tabId === 'composition-tab')!.zoneId).toBe(zoneId)
  const nodeRequire = createRequire(resolve('packages/core/package.json'))
  const { browserSourceBuild } = nodeRequire('../browser/scripts/source-build.mjs')
  const { build } = browserSourceBuild(nodeRequire('esbuild'))
  const cli = join(directory, 'amux.mjs'), socketDirectory = await mkdtemp('/tmp/acmp-')
  await symlink(resolve('packages/core/node_modules'), join(directory, 'node_modules'), 'dir')
  await build({ entryPoints: ['packages/core/src/agentmux.ts'], outfile: cli, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent',
    plugins: [{ name: 'composition-cli-source', setup(builder: any) { builder.onLoad({ filter: /\.ts$/ }, (args: { path: string }) => {
      const file = relative(process.cwd(), args.path), code = readFileSync(args.path, 'utf8')
      if (!file.startsWith('packages/core/src/')) return null
      if (process.env.SURVEY_COMPOSITION_LOADED) appendFileSync(process.env.SURVEY_COMPOSITION_LOADED,
        JSON.stringify({ consumer: 'compiled-cli', file, original: createHash('sha256').update(code).digest('hex'), loaded: createHash('sha256').update(code).digest('hex') }) + '\n')
      return { contents: code, loader: 'ts' }
    }) } }] })
  const socketPath = join(socketDirectory, 'control.sock'), server = new AgentMuxControlServer({ socketPath, execute: request => useAppStore.getState().executeControl(request) })
  const env = privateEnvironment({ AGENTMUX_RUNTIME_DIRECTORY: socketDirectory, AGENTMUX_STATE_DIRECTORY: join(socketDirectory, 'state'), AGENTMUX_RPC_ENDPOINT: 'unix:' + socketPath })
  const command = (args: string[], input = '', expected = 0) => new Promise<any>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', error = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { error += chunk })
    child.once('error', reject); child.once('close', code => { try { expect(code, error + output).toBe(expected); resolve(objectCliReceipt(JSON.parse(output || error.split('\n').find(line => line.startsWith('{'))!))) } catch (error) { reject(error) } })
    child.stdin.end(input)
  })
  try {
    await server.start()
    const list = (await command(['space', 'survey-list'])).result
    expect(list.scope).toBe('survey-list'); expect(list.collectedZoneIds).toContain(zoneId)
    expect(list.storedOrganization.groups.find((group: any) => group.groupId === 'reading-group').zoneIds).toEqual([zoneId])
    const discovery = (await command(['space', 'ls', '--presentation'])).result.catalog.survey
    expect(discovery.organization).toEqual(useAppStore.getState().surveyOrganization)
    expect(discovery.items.some((item: any) => item.zoneId === zoneId)).toBe(true)
    expect(discovery.organization.groups.find((group: any) => group.groupId === 'reading-group').zoneIds).toEqual([zoneId])
  } finally { await server.stop(); await rm(socketDirectory, { recursive: true, force: true }) }
})

it('[detach-files] the original filesystem owner reads and saves the same File after actual independent pointer composition', async () => {
  await mkdir(resource.path, { recursive: true }); await writeFile(join(resource.path, 'draft.txt'), 'Original physical detach file')
  const { files, read, write } = await originalFilePorts()
  try {
    const opened = await files.read(resource, 'draft.txt'); expect(opened.status).toBe('read')
    if (opened.status !== 'read') throw new Error('Original detach file not read')
    const key = documentKey(resource.id, 'draft.txt')
    useAppStore.setState({ documents: { [key]: opened.document }, dirtyDocuments: {}, documentIssues: {}, documentGenerations: {}, savingDocuments: {} })
    const from = await prepareDetach(); await dragPointer(from, { x: 100, y: 918 }); await vi.waitFor(() => expect(document.querySelector('[aria-label="Research location"]')).not.toBeNull()); await chooseDetachLocation()
    await vi.waitFor(() => expect(catalog().tabs.find(tab => tab.tabId === 'composition-tab')!.zoneId).not.toBe(zones.source))
    await vi.waitFor(() => expect(useAppStore.getState().surveyCompositionRecoveries).toEqual([]))
    expect(source().regions['composition-file']).toMatchObject({ workspaceId: resource.id, path: 'draft.txt' })
    useAppStore.getState().updateDocument(source().id, 'Saved through the original File after detach', 'composition-file')
    await useAppStore.getState().saveDocument(source().id, 'composition-file')
    expect(write).toHaveBeenCalledOnce(); expect(await readFile(join(resource.path, 'draft.txt'), 'utf8')).toBe('Saved through the original File after detach')
    expect(useAppStore.getState().dirtyDocuments[key]).not.toBe(true)
    await writeFile(join(resource.path, 'draft.txt'), 'External original file edit after detach')
    await useAppStore.getState().refreshDocument(resource.id, 'draft.txt')
    expect(read).toHaveBeenCalledWith(resource.id, 'draft.txt'); expect(useAppStore.getState().documents[key]!.content).toBe('External original file edit after detach')
  } finally { await files.dispose() }
})

it('[detach] malformed group intent stays unread with its original bytes instead of becoming an unscoped operation', async () => {
  await prepareDetach()
  const held = request(), valid = retainSurveyComposition({ ...held, surveyGroupId: 'reading-group' }, {
    requestId: held.requestId, targetZoneId: held.target.zoneId, outcome: 'unknown', tabIds: ['composition-tab'] })
  expect(isSurveyCompositionRecovery({ ...valid, surveyGroupId: null })).toBe(true)
  const bad = { ...valid, surveyGroupId: { originalUnreadGroup: 'reading-group' } }, raw = [bad, { retainedUnknownRecord: true }]
  expect(isSurveyCompositionRecovery(bad)).toBe(false)
  await act(async () => useAppStore.setState({ surveyCompositionRecoveries: restoreSurveyCompositionRecoveries(raw) }))
  await prepareRendererUpdate()
  expect(JSON.parse(localStorage.getItem(WORKBENCH_USER_STATE_KEY)!).state.surveyCompositionRecoveries).toEqual(raw)
  expect(useAppStore.getState().surveyCompositionRecoveries).toEqual(raw)
  expect(document.querySelector('.survey-composition-recovery')?.textContent).toContain('could not be read')
})

it('[detach] keyboard arrows can reach the same exact list-group destination and submit the same original Tab', async () => {
  const from = await prepareDetach(), key = async (key: string, code = key) => {
    await act(async () => from.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true })))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  }
  await act(async () => from.focus()); await key(' ', 'Space')
  const target = document.querySelector<HTMLElement>('[data-survey-list-target="reading-group"]')!
  for (let i = 0; i < document.querySelectorAll('.survey-list-item,[data-survey-list-target]').length + 2 && target.dataset.composeOver !== 'true'; ++i) await key('ArrowDown')
  expect(target.dataset.composeOver).toBe('true'); vi.mocked(api.spatial.commit).mockClear(); await key(' ', 'Space')
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Research location"]')).not.toBeNull()); await chooseDetachLocation()
  await vi.waitFor(() => expect(useAppStore.getState().surveyOrganization.groups[0]!.zoneIds).toHaveLength(1))
  expect(catalog().tabs.find(tab => tab.tabId === 'composition-tab')!.zoneId).toBe(useAppStore.getState().surveyOrganization.groups[0]!.zoneIds[0])
  expect(vi.mocked(api.spatial.commit)).toHaveBeenCalledOnce()
})

// Survey header consumes the same actual App, Core file owner and original close confirmation.
async function showHeaderPage() {
  headerCloseOwner = await connectWorkbenchCloseApiOwner()
  const page = { regionId: 'composition-page', browserId: 'composition-page' }
  useAppStore.setState({ surveyPageReferences: [page], surveyZoneSelection: { kind: 'page', ...page } })
  await checkpointSpatialWorkbench()
  await dom.render(<App />)
  await vi.waitFor(() => expect(document.querySelector('.survey-page-tab-header')).not.toBeNull())
  return page
}
const pageHeader = () => document.querySelector<HTMLElement>('.survey-page-tab-header')!
const headerClose = () => pageHeader().querySelector<HTMLButtonElement>('[aria-label^="Close page:"]')!

it('[survey-header] original research strip selects every actual member without changing the original Work selection or content', async () => {
  const native = await api.browser.create('header-second-browser', 'https://header.example.test/second', resource.id)
  const second = createWorkbenchTab('header-second-tab', { ...native, kind: 'browser', browserId: native.id,
    regionId: 'header-second-region', workspaceId: resource.id, title: 'Second source' })
  second.space = source().space!
  const state = useAppStore.getState()
  useAppStore.setState({ tabs: { ...state.tabs, [second.id]: second }, layouts: { ...state.layouts,
    [resource.id]: addTabOccurrence(state.layouts[resource.id]!, 'source-group', second.id)! } })
  await checkpointSpatialWorkbench(); await dom.render(<App />)
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Original file input"]')).not.toBeNull())
  const before = useAppStore.getState(), file = document.querySelector('[aria-label="Original file input"]')
  const strip = document.querySelector('.global-survey-surface .workbench-zone .workbench-tab-strip')!
  expect(strip).not.toBeNull()
  const tabs = [...strip.querySelectorAll<HTMLButtonElement>('button[data-workbench-tab-id]')]
  expect(tabs.map(tab => tab.dataset.workbenchTabId)).toEqual([source().id, second.id])
  await click(tabs[1]!)
  expect(useAppStore.getState().surveyZoneSelection?.active).toEqual({ tabId: second.id, regionId: 'header-second-region' })
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(document.querySelector('[aria-label="Original file input"]')).toBe(file)
})

it('[survey-header] exact mixed page has one accurate header and its original Region slot, and closes only that Browser', async () => {
  const page = await showHeaderPage(), before = useAppStore.getState()
  const original = source(), file = original.regions['composition-file'], agent = original.regions['composition-agent-region']
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Original file input"]')).not.toBeNull())
  const fileInput = document.querySelector<HTMLTextAreaElement>('[aria-label="Original file input"]')!
  fileInput.value = 'Original header-surviving draft'
  const projection = surveyPageProjection(page, catalog(), before.tabs, () => {})!
  const reference = projection.selection[0]!
  expect(projection.entity).toEqual({ kind: 'region', regionId: page.regionId })
  expect(document.getElementById(workbenchRegionProjectionSlotId('survey-workbench-slot', reference))).not.toBeNull()
  expect(pageHeader().querySelectorAll('.workbench-tab')).toHaveLength(1)
  const browser = original.regions[page.regionId]!
  expect(pageHeader().querySelector('.workbench-tab__label')!.textContent).toBe(browser.kind === 'browser' ? browser.title : '')
  expect(pageHeader().querySelector('button button')).toBeNull()
  const closeTab = vi.spyOn(before, 'closeTab'), close = vi.spyOn(api.browser, 'close').mockResolvedValue(undefined)
  await click(headerClose())
  await vi.waitFor(() => expect(named('Close')).toBeDefined()); await click(named('Close'))
  await vi.waitFor(() => expect(source().regions[page.regionId]).toBeUndefined())
  expect(close).toHaveBeenCalledExactlyOnceWith(page.browserId); expect(closeTab).not.toHaveBeenCalled()
  expect(source().regions['composition-file']).toBe(file); expect(source().regions['composition-agent-region']).toBe(agent)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().dirtyDocuments[documentKey(resource.id, 'draft.txt')]).toBe(true)
  expect(document.querySelector('[aria-label="Original file input"]')).toBe(fileInput)
  expect(fileInput.value).toBe('Original header-surviving draft')
  expect(useAppStore.getState().surveyPageReferences).toEqual([])
})

it('[survey-header] an unconfirmed Native close keeps the same header, page choice and sibling input', async () => {
  const page = await showHeaderPage(), before = useAppStore.getState(), original = source()
  const header = pageHeader(), field = document.querySelector<HTMLTextAreaElement>('[aria-label="Original file input"]')!
  field.value = 'Keep this draft after close failure'
  const close = vi.spyOn(api.browser, 'close').mockRejectedValue(new Error('Original close receipt unknown'))
  await click(headerClose())
  await vi.waitFor(() => expect(named('Close')).toBeDefined()); await click(named('Close'))
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(source()).toBe(original); expect(pageHeader()).toBe(header)
  expect(useAppStore.getState().surveyPageReferences).toEqual([page])
  expect(useAppStore.getState().surveyZoneSelection).toBe(before.surveyZoneSelection)
  expect(document.querySelector('[aria-label="Original file input"]')).toBe(field)
  expect(field.value).toBe('Keep this draft after close failure')
})

it('[survey-header] exact page creation uses the current browsing environment and keeps its source mixed Tab untouched', async () => {
  const scratch = { ...scratchWorkspace, path: join(directory, 'header-scratch') }, state = useAppStore.getState()
  useAppStore.setState({ config: { ...state.config!, workspaces: [...state.config!.workspaces, scratch] },
    layouts: { ...state.layouts, [scratch.id]: createWorkspaceLayout('header-scratch-group') } })
  const page = await showHeaderPage(), original = source(), native = vi.spyOn(api.browser, 'create')
  await click(pageHeader().querySelector<HTMLButtonElement>('[aria-label="New webpage"]')!)
  await vi.waitFor(() => expect(native).toHaveBeenCalledOnce())
  await vi.waitFor(() => expect(useAppStore.getState().surveyPageReferences).toHaveLength(2))
  expect(native.mock.calls[0]![1]).toBe('about:blank'); expect(native.mock.calls[0]![2]).toBe(scratch.id)
  expect(source()).toBe(original)
  expect(useAppStore.getState().surveyPageReferences).toContainEqual(page)
  expect(useAppStore.getState().surveyZoneSelection).toMatchObject({ kind: 'page', regionId: native.mock.calls[0]![0] })
})

it.each(['none', 'save', 'launch'] as const)('[survey-agent-placement] the actual exact-page Browser entry preserves the original Tab and later %s navigation', async later => {
  const originalBrowser = source().regions['composition-page']!
  if (originalBrowser.kind !== 'browser') throw Error('The fixture must retain its original Browser.')
  const native = await api.browser.restore(originalBrowser.browserId, { workspaceId: resource.id, profileId: originalBrowser.profileId,
    mode: originalBrowser.mode, viewport: originalBrowser.viewport })
  const confirmedBrowser = { ...native, control: { owner: 'human' as const, agent: null, activeOperationId: null, revision: 3, inputIsolation: 'inactive' as const } }
  vi.spyOn(api.browser, 'restore').mockResolvedValue(confirmedBrowser)
  const page = await showHeaderPage()
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Original file input"]')).not.toBeNull())
  await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: confirmedBrowser }))
  const before = useAppStore.getState(), browser = source().regions[page.regionId]!
  if (browser.kind !== 'browser') throw Error('The fixture must retain its original Browser.')
  const heldWork = structuredClone(before.workbenchSpaceSelection), heldWorkspace = before.activeWorkspaceId
  const originalFile = document.querySelector<HTMLTextAreaElement>('[aria-label="Original file input"]')!
  originalFile.value = 'Original sibling input survives Agent creation'
  let saved = false, launching = false
  const gate = new Promise<void>(resolve => { placementRelease = resolve })
  vi.spyOn(api.ui, 'requestStorageFlush').mockImplementation(async () => {
    if (later === 'save' && !saved && Object.values(source().regions).some(region => region.kind === 'agent' && region.sessionId !== session.id)) {
      saved = true; await gate
    }
  })
  const launch = vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async input => {
    launching = true
    if (later === 'launch') await gate
    const session = { ...composerSession(input.agentSessionId!), workspacePath: input.workspacePath, executorId: input.executorId }
    const result: AgentLaunchResult = { created: { ...agentCreationFixture(session), creation: { createOperationId: input.createOperationId!, initialPrompt: 'unknown' } },
      creation: { createOperationId: input.createOperationId!, initialPrompt: 'confirmed' }, session,
      timeline: { agentSessionId: session.id, revision: 0, items: [] }, projectionFailures: [] }
    return result
  })
  const handoff = vi.spyOn(api.browser, 'returnControl').mockImplementation(async (_id, input) => ({ ...browser,
    control: { ...browser.control!, owner: 'agent', revision: browser.control!.revision + 1,
      agent: 'agent' in input! ? { hostId: input.agent.hostId, agentSessionId: input.agent.agentSessionId } : browser.control!.agent ?? null } }))
  const send = vi.spyOn(before, 'sendQueuedAgentSteer').mockResolvedValue('submitted')
  const activity = document.querySelector<HTMLElement>('.global-survey-surface [aria-label^="Browser activity:"]')!
  expect(activity).not.toBeNull()
  await act(async () => { activity.focus(); activity.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true })) })
  await vi.waitFor(() => expect(document.querySelector('[role="menuitem"][aria-label="在右侧创建 Agent"]')).not.toBeNull())
  const create = document.querySelector<HTMLButtonElement>('[role="menuitem"][aria-label="在右侧创建 Agent"]')
  expect(create, document.body.textContent ?? '').not.toBeNull()
  await click(create!)
  if (later !== 'none') {
    await vi.waitFor(() => expect(later === 'save' ? saved : launching).toBe(true))
    await act(async () => {
      useAppStore.getState().setMainSurface('board'); useAppStore.getState().setMainSurface('survey')
      useAppStore.getState().setSurveyZoneSelection({ kind: 'page', ...page })
      placementRelease!()
    })
  }
  await vi.waitFor(() => expect(send, JSON.stringify({ error: useAppStore.getState().error,
    requests: Object.values(useAppStore.getState().spatialRequests), launches: launch.mock.calls.length,
    surface: document.querySelector('.global-survey-surface')?.textContent?.slice(-1500) })).toHaveBeenCalledOnce())
  const state = useAppStore.getState(), record = Object.values(state.spatialRequests).find(record => record.purpose === 'browser-agent')!
  const region = Object.values(source().regions).find(region => region.kind === 'agent' && region.sessionId === record.agentSessionId)!
  expect(state.surveyZoneSelection).toEqual(later === 'none' ? { kind: 'page', ...page,
    presentation: { kind: 'tab', displayWorkspaceId: resource.id, groupId: 'source-group', tabId: source().id, regionId: region.regionId } } : { kind: 'page', ...page })
  expect(state.workbenchSpaceSelection).toEqual(heldWork); expect(state.activeWorkspaceId).toBe(heldWorkspace)
  expect(state.mainSurface).toBe('survey'); expect(state.surveyCollectedZones).toEqual(before.surveyCollectedZones)
  const presentedAgent = document.querySelector('.global-survey-surface [data-workbench-region-id="' + region.regionId + '"]')
  if (later === 'none') expect(presentedAgent).not.toBeNull()
  else expect(presentedAgent).toBeNull()
  expect(pageHeader()).not.toBeNull()
  expect(pageHeader().querySelectorAll('[data-workbench-tab-id]')).toHaveLength(1)
  expect(document.querySelector('[aria-label="Original file input"]')).toBe(originalFile)
  expect(originalFile.value).toBe('Original sibling input survives Agent creation')
  expect(launch).toHaveBeenCalledOnce(); expect(handoff).toHaveBeenCalledOnce()
  expect(source().regions[page.regionId]?.kind).toBe('browser')
  if (later === 'none') {
    const address = document.querySelector<HTMLInputElement>('.global-survey-surface [data-workbench-region-id="' + page.regionId + '"] [aria-label="Browser address"]')!
    expect(address).not.toBeNull()
    await act(async () => address.focus())
    await vi.waitFor(() => expect(useAppStore.getState().surveyZoneSelection).toMatchObject({ presentation: { regionId: page.regionId } }))
    expect(useAppStore.getState().workbenchSpaceSelection).toEqual(heldWork)
    const agentInput = document.querySelector<HTMLTextAreaElement>('.global-survey-surface [data-workbench-region-id="' + region.regionId + '"] [aria-label="Original Agent input"]')!
    expect(agentInput).not.toBeNull()
    await act(async () => agentInput.focus())
    await vi.waitFor(() => expect(useAppStore.getState().surveyZoneSelection).toMatchObject({ presentation: { regionId: region.regionId } }))
    expect(useAppStore.getState().workbenchSpaceSelection).toEqual(heldWork)
    const cli = await prepareSourceCoreCli(), socketDirectory = await mkdtemp('/tmp/asel-')
    const server = new AgentMuxControlServer({ socketPath: join(socketDirectory, 'control.sock'), execute: request => useAppStore.getState().executeControl(request) })
    try {
      await server.start()
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [cli.cliPath, 'space', 'ls', '--presentation'], { env: privateEnvironment({
          AGENTMUX_RUNTIME_DIRECTORY: socketDirectory, AGENTMUX_STATE_DIRECTORY: join(socketDirectory, 'state'),
          AGENTMUX_RPC_ENDPOINT: 'unix:' + join(socketDirectory, 'control.sock') }), stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = '', stderr = ''; child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
        child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }))
      })
      expect(result.code, result.stderr).toBe(0)
      expect(objectCliReceipt(JSON.parse(result.stdout)).result.catalog.survey.selection).toEqual(state.surveyZoneSelection)
    } finally { await server.stop(); await cli.cleanup(); await rm(socketDirectory, { recursive: true, force: true }) }
    const originalAgent = source().regions[region.regionId], originalSessions = useAppStore.getState().sessions
    const closeTab = vi.spyOn(useAppStore.getState(), 'closeTab'), close = vi.spyOn(api.browser, 'close').mockResolvedValue(undefined)
    await click(headerClose())
    await vi.waitFor(() => expect(Boolean(named('Close')) || !source().regions[page.regionId], JSON.stringify({ error: useAppStore.getState().error, body: document.body.textContent?.slice(-1000) })).toBe(true))
    if (named('Close')) await click(named('Close'))
    await vi.waitFor(() => expect(source().regions[page.regionId]).toBeUndefined())
    expect(close).toHaveBeenCalledExactlyOnceWith(page.browserId); expect(closeTab).not.toHaveBeenCalled()
    expect(source().regions[region.regionId]).toBe(originalAgent)
    expect(useAppStore.getState().sessions).toBe(originalSessions)
    expect(source().regions['composition-file']).toBe(before.tabs[source().id]!.regions['composition-file'])
    expect(document.querySelector('[aria-label="Original file input"]')).toBe(originalFile)
    expect(originalFile.value).toBe('Original sibling input survives Agent creation')
  }
}, 20_000)

async function pageContext(reference: { regionId: string; browserId: string }, gesture: 'pointer' | 'key' | 'shift-f10' = 'pointer') {
  const button = document.querySelector<HTMLElement>(`[data-survey-page-region-id="${reference.regionId}"] .survey-item`)!
  expect(button).not.toBeNull()
  await act(async () => {
    button.focus()
    if (gesture === 'pointer') expect(button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 60, clientY: 100 }))).toBe(false)
    else button.dispatchEvent(new KeyboardEvent('keydown', { key: gesture === 'key' ? 'ContextMenu' : 'F10', shiftKey: gesture === 'shift-f10', bubbles: true, cancelable: true }))
  })
  await vi.waitFor(() => expect(document.querySelector('[data-survey-context-page-region-id]')?.getAttribute('data-survey-context-page-region-id')).toBe(reference.regionId))
  return button
}
async function pageContextAction(label: string) {
  const menu = document.querySelector('[data-survey-context-page-region-id]')!
  const item = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === label)
  expect(item, label).toBeDefined()
  await click(item!)
}
async function pageMenuFile() {
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Original file input"]')).toBeInstanceOf(HTMLTextAreaElement))
  return document.querySelector<HTMLTextAreaElement>('[aria-label="Original file input"]')!
}
async function otherContextPage() {
  const native = await api.browser.create('page-menu-other-browser', 'https://other.example.test/', resource.id)
  const page = { regionId: 'page-menu-other-region', browserId: native.id }
  const tab = createWorkbenchTab('page-menu-other-tab', { ...native, kind: 'browser', ...page, workspaceId: resource.id, title: 'Other exact page' })
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [tab.id]: tab }, layouts: { ...state.layouts,
    [resource.id]: addTabOccurrence(state.layouts[resource.id]!, 'source-group', tab.id)! } }))
  return page
}

it.each(['pointer', 'key', 'shift-f10'] as const)('[survey-page-menu] exact page opens its application menu and Escape restores the invoker (%s)', async gesture => {
  const page = await horizontalPages(), before = useAppStore.getState(), file = await pageMenuFile()
  file.value = 'Keep the context-menu draft'
  const button = await pageContext(page, gesture)
  const menu = document.querySelector('[data-survey-context-page-region-id]')!
  expect(menu.textContent).toContain('Close page'); expect(menu.textContent).toContain('Remove page from Survey')
  expect(menu.textContent).not.toContain('Rename exploration'); expect(menu.textContent).not.toContain('Keep in Survey')
  expect(useAppStore.getState().surveyZoneSelection).toBe(before.surveyZoneSelection)
  await act(async () => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await vi.waitFor(() => expect(document.querySelector('[data-survey-context-page-region-id]')).toBeNull())
  await vi.waitFor(() => expect(document.activeElement).toBe(button))
  expect(useAppStore.getState().tabs).toEqual(before.tabs); expect(useAppStore.getState().layouts).toEqual(before.layouts)
  expect(document.querySelector('[aria-label="Original file input"]')).toBe(file)
  expect(file.value).toBe('Keep the context-menu draft')
})

it('[survey-page-menu] consecutive page right-clicks remove only the last exact reference without selecting or closing content', async () => {
  const other = await otherContextPage(), page = await horizontalPages([other]), before = useAppStore.getState()
  const file = await pageMenuFile()
  file.value = 'Keep the original draft when removing only a page reference'
  const close = vi.spyOn(api.browser, 'close')
  await pageContext(page); await pageContext(other); await pageContextAction('Remove page from Survey')
  await vi.waitFor(() => expect(useAppStore.getState().surveyPageReferences).toEqual([page]))
  expect(useAppStore.getState().tabs).toEqual(before.tabs); expect(useAppStore.getState().layouts).toEqual(before.layouts)
  expect(useAppStore.getState().surveyZoneSelection).toBe(before.surveyZoneSelection); expect(close).not.toHaveBeenCalled()
  expect(document.querySelector('[aria-label="Original file input"]')).toBe(file)
  expect(file.value).toBe('Keep the original draft when removing only a page reference')
})

it('[survey-page-menu] exact page context Close uses the original Main plan and preserves mixed siblings and input', async () => {
  headerCloseOwner = await connectWorkbenchCloseApiOwner()
  const page = await horizontalPages(), before = useAppStore.getState(), original = source()
  const file = await pageMenuFile()
  file.value = 'Keep the original page-menu sibling input'
  const close = vi.spyOn(api.browser, 'close').mockResolvedValue(undefined)
  await pageContext(page); await pageContextAction('Close page'); await confirmHorizontalClose()
  await vi.waitFor(() => expect(source().regions[page.regionId]).toBeUndefined())
  expect(close).toHaveBeenCalledExactlyOnceWith(page.browserId)
  expect(source().regions['composition-file']).toBe(original.regions['composition-file'])
  expect(source().regions['composition-agent-region']).toBe(original.regions['composition-agent-region'])
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(document.querySelector('[aria-label="Original file input"]')).toBe(file); expect(file.value).toBe('Keep the original page-menu sibling input')
})

it('[survey-page-menu] background sole page closes its own Browser through Main without closing the first reference', async () => {
  headerCloseOwner = await connectWorkbenchCloseApiOwner()
  const other = await otherContextPage(), page = await horizontalPages([other]), original = source()
  const close = vi.spyOn(api.browser, 'close').mockResolvedValue(undefined)
  await pageContext(other); await pageContextAction('Close page'); await confirmHorizontalClose()
  await vi.waitFor(() => expect(useAppStore.getState().tabs['page-menu-other-tab']).toBeUndefined())
  expect(close).toHaveBeenCalledExactlyOnceWith(other.browserId)
  expect(source().regions[page.regionId]).toBe(original.regions[page.regionId])
  expect(useAppStore.getState().surveyPageReferences).toEqual([page])
})

// T007 ordinary exact-page order: the original reference owner, not a new topology.
async function pageOrderFixture() {
  await dragPagePair()
  const old = vi.mocked(HTMLElement.prototype.getBoundingClientRect).getMockImplementation()!
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function(this: HTMLElement) {
    const wrapper = this.closest<HTMLElement>('[data-survey-page-order]')
    if (wrapper) {
      const rows = [...document.querySelectorAll('[data-survey-page-order]')]
      return new DOMRect(10, 80 + rows.indexOf(wrapper) * 44, 230, 36)
    }
    return old.call(this)
  })
  return { first: { regionId: 'composition-page', browserId: 'composition-page' }, second: { regionId: 'target-page', browserId: 'target-page' },
    grip: () => document.querySelector<HTMLElement>('[data-survey-page-region-id="composition-page"] .survey-drag-handle')!,
    secondRow: () => document.querySelector<HTMLElement>('[data-survey-page-order="target-page"]')! }
}

it('[page-order] filtered page slots preserve hidden, pinned and unavailable originals', async () => {
  const { reorderSurveyPages } = await import('../src/renderer/src/lib/survey-page-order')
  const a = { regionId: 'visible-a', browserId: 'browser-a' }, b = { regionId: 'visible-b', browserId: 'browser-b' }
  const hidden = { regionId: 'other-profile', browserId: 'hidden-browser' }, retained = { regionId: 'unavailable', browserId: 'original-browser' }
  const base = [hidden, a, retained, b]
  expect(reorderSurveyPages(base, [a, b], a, b)).toEqual([hidden, b, retained, a])
  expect(reorderSurveyPages(base, [a, b], a, a)).toBe(base)
  expect(reorderSurveyPages(base, [a, b], a, retained)).toBe(base)
})

it('[page-order] actual PointerSensor grip reorders once through the public owner and keeps the same Browser input and graph', async () => {
  const f = await pageOrderFixture(), before = useAppStore.getState(), graph = (await core.read())!.graph
  const input = document.querySelector<HTMLInputElement>('.global-survey-surface [data-workbench-region-id="composition-page"] [aria-label="Browser address"]')!
  expect(input).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Unsubmitted same original address'); input.dispatchEvent(new Event('input', { bubbles: true })) }); input.setSelectionRange(3, 12)
  const requests = vi.spyOn(useAppStore.getState(), 'executeControl'), close = vi.spyOn(api.browser, 'close'), navigate = vi.spyOn(api.browser, 'navigate')
  const rect = f.secondRow().getBoundingClientRect()
  await dragPointer(f.grip(), { x: rect.left + 35, y: rect.top + 20 })
  await vi.waitFor(() => expect(useAppStore.getState().surveyPageReferences).toEqual([f.second, f.first]))
  expect(requests.mock.calls.filter(([request]) => request.operation === 'space.survey-list' && request.collection?.pageReferences)).toHaveLength(1)
  expect(useAppStore.getState().surveyZoneSelection).toEqual(before.surveyZoneSelection)
  expect(useAppStore.getState().tabs).toEqual(before.tabs); expect((await core.read())!.graph).toEqual(graph)
  expect(document.querySelector('.global-survey-surface [data-workbench-region-id="composition-page"] [aria-label="Browser address"]')).toBe(input)
  expect(input.value).toBe('Unsubmitted same original address'); expect([input.selectionStart, input.selectionEnd]).toEqual([3, 12])
  expect(close).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled()
  await prepareRendererUpdate()
  expect(JSON.parse(localStorage.getItem(WORKBENCH_USER_STATE_KEY)!).state.surveyPageReferences).toEqual([f.second, f.first])
})

it('[page-order] original KeyboardSensor reorders; Escape, same row and invalid release never save', async () => {
  const f = await pageOrderFixture(), requests = vi.spyOn(useAppStore.getState(), 'executeControl')
  const key = async (value: string, code = value) => { await act(async () => f.grip().dispatchEvent(new KeyboardEvent('keydown', { key: value, code, bubbles: true }))); await new Promise(resolve => setTimeout(resolve, 30)) }
  await act(async () => f.grip().focus()); await key(' ', 'Space'); await key('ArrowDown'); await key('Escape')
  await key(' ', 'Space'); await key(' ', 'Space')
  expect(useAppStore.getState().surveyPageReferences).toEqual([f.first, f.second]); expect(requests).not.toHaveBeenCalled()
  await dragPointer(f.grip(), { x: 1200, y: 1200 })
  expect(requests).not.toHaveBeenCalled()
  await act(async () => f.grip().focus()); await key(' ', 'Space'); await key('ArrowDown'); await key(' ', 'Space')
  await vi.waitFor(() => expect(useAppStore.getState().surveyPageReferences).toEqual([f.second, f.first]))
  expect(requests.mock.calls.filter(([request]) => request.operation === 'space.survey-list' && request.collection?.pageReferences)).toHaveLength(1)
})

it('[page-order] the same ordered owner rejects stale order, preserves unread references and reports an unknown save without rolling back later preferences', async () => {
  const f = await pageOrderFixture(), state = useAppStore.getState(), originalPages = state.surveyPageReferences
  const change = (pages: typeof originalPages, expected: typeof originalPages) => useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'page-order-original', operation: 'space.survey-list', collection: { pageReferences: pages, expectedPageReferences: expected } })
  const retained = { regionId: 'missing-original-region', browserId: 'missing-original-browser' }
  useAppStore.setState({ surveyPageReferences: [f.first, retained, f.second] })
  const report = await change([f.second, retained, f.first], [f.first, retained, f.second])
  expect(report.operation).toBe('space.survey-list'); if (report.operation !== 'space.survey-list') throw Error('Wrong ordered owner')
  expect(report.changed).toBe(true); expect(report.outcome).toBe('changed'); expect(report.pageReferences).toEqual([f.second, retained, f.first])
  const stale = await change([f.first, retained, f.second], [f.first, retained, f.second])
  expect(stale.operation === 'space.survey-list' && stale.outcome).toBe('refused')
  expect(useAppStore.getState().surveyPageReferences).toEqual([f.second, retained, f.first])
  const raw = [f.second, { unread: 'original bytes' }, retained, f.first]
  useAppStore.setState({ surveyPageReadRecovery: { source: raw, issue: 'Original source unread' } })
  const unread = await change([f.first, retained, f.second], [f.second, retained, f.first])
  expect(unread.operation === 'space.survey-list' && unread.outcome).toBe('unknown')
  expect(useAppStore.getState().surveyPageReadRecovery?.source).toBe(raw)
  useAppStore.setState({ surveyPageReadRecovery: null })
  let release!: () => void
  vi.mocked(api.ui.requestStorageFlush).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
  const pending = change([f.first, retained, f.second], [f.second, retained, f.first])
  await vi.waitFor(() => expect(release).toBeDefined())
  await change([f.second, f.first, retained], [f.first, retained, f.second])
  release(); await pending
  expect(useAppStore.getState().surveyPageReferences).toEqual([f.second, f.first, retained])
  await prepareRendererUpdate()
  vi.mocked(api.ui.requestStorageFlush).mockRejectedValue(Error('Original order save ACK unknown'))
  const unknown = await change([f.first, retained, f.second], [f.second, f.first, retained])
  expect(unknown.operation === 'space.survey-list' && unknown.outcome).toBe('partial')
  expect(useAppStore.getState().surveyPageReferences).toEqual([f.first, retained, f.second])
})

it('[page-order] actual Source CLI changes and reads exact order, refuses a stale same-members request, and a second process reads original Main file', async () => {
  const f = await pageOrderFixture(), cli = await prepareSourceCoreCli(), socketDirectory = await mkdtemp('/tmp/apgo-')
  const socketPath = join(socketDirectory, 'control.sock'), server = new AgentMuxControlServer({ socketPath, execute: request => useAppStore.getState().executeControl(request) })
  const env = privateEnvironment({ AGENTMUX_RUNTIME_DIRECTORY: socketDirectory, AGENTMUX_STATE_DIRECTORY: join(socketDirectory, 'state'), AGENTMUX_RPC_ENDPOINT: 'unix:' + socketPath })
  const command = (input?: object, expected = 0) => new Promise<any>((resolve, reject) => {
    const child = spawn(process.execPath, [cli.cliPath, 'space', 'survey-list', ...(input ? ['--input', '-'] : [])], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; child.stdout.on('data', part => { stdout += part }); child.stderr.on('data', part => { stderr += part })
    child.once('error', reject); child.once('close', code => { try { expect(code, stderr + stdout).toBe(expected); resolve(objectCliReceipt(JSON.parse(stdout)).result) } catch (error) { reject(error) } }); child.stdin.end(input ? JSON.stringify(input) : '')
  })
  try {
    await server.start()
    const guide = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [cli.cliPath, 'space', '--skill'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''; child.stdout.on('data', part => { stdout += part }); child.stderr.on('data', part => { stderr += part })
      child.once('error', reject); child.once('close', code => code === 0 ? resolve(stdout) : reject(Error(stderr)))
    })
    expect(guide).toContain('Page arrays are ordered: reordering the same members is a change')
    expect((await command()).pageReferences).toEqual([f.first, f.second])
    const changed = await command({ collection: { pageReferences: [f.second, f.first], expectedPageReferences: [f.first, f.second] } })
    expect(changed.changed).toBe(true); expect(changed.outcome).toBe('changed'); expect((await command()).pageReferences).toEqual([f.second, f.first])
    const stale = await command({ collection: { pageReferences: [f.first, f.second], expectedPageReferences: [f.first, f.second] } }, 1)
    expect(stale.outcome).toBe('refused'); expect(stale.pageReferences).toEqual([f.second, f.first])
    await prepareRendererUpdate()
    const userPath = join(directory, 'ordered-user.json'), user = new WorkbenchUserStateStore(userPath)
    await user.write(JSON.stringify({ state: {}, version: 1 }))
    const document = createWorkbenchUserDocument({ readWorkbenchState: () => user.read(), importWorkbenchState: raw => user.importIfAbsent(raw), writeWorkbenchState: raw => user.write(raw) }, () => localStorage)
    await document.hydrate(); await document.persistent.checkpoint(WORKBENCH_USER_STATE_KEY, JSON.parse(localStorage.getItem(WORKBENCH_USER_STATE_KEY)!))
    const saved = JSON.parse((await user.read())!); expect(saved.state.surveyPageReferences).toEqual([f.second, f.first])
    const reader = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({pid:process.pid,record:JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))}))', userPath], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''; child.stdout.on('data', part => { output += part }); child.once('error', reject)
      child.once('close', code => code === 0 ? resolve(output) : reject(Error('Original file readback failed')))
    })
    const actual = JSON.parse(reader)
    expect(actual.pid).not.toBe(process.pid); expect(actual.record.state.surveyPageReferences).toEqual([f.second, f.first])
  } finally { await server.stop(); await cli.cleanup(); await rm(socketDirectory, { recursive: true, force: true }) }
}, 60_000)

it('[page-order] actual Profile-filtered list reorders only its visible slots and can reorder a retained reference without a Native owner', async () => {
  const f = await pageOrderFixture(), state = useAppStore.getState(), firstTab = state.tabs['composition-tab']!, secondTab = state.tabs['target-tab']!
  const hidden = { regionId: 'other-profile-page', browserId: 'other-profile-browser' }, retained = { regionId: 'retained-order-region', browserId: 'retained-order-browser' }
  const hiddenNative = await api.browser.create(hidden.browserId, 'https://other.example.test/', resource.id)
  const hiddenTab = createWorkbenchTab('hidden-order-tab', { ...hiddenNative, kind: 'browser', workspaceId: resource.id, browserId: hidden.browserId, regionId: hidden.regionId, url: 'https://other.example.test/', title: 'Other Profile page', mode: 'normal', profileId: 'profile-b' })
  const first = firstTab.regions[f.first.regionId]!, second = secondTab.regions[f.second.regionId]!
  if (first.kind !== 'browser' || second.kind !== 'browser') throw Error('Original Browser fixture required')
  await act(async () => useAppStore.setState({ tabs: { ...state.tabs,
    [firstTab.id]: { ...firstTab, regions: { ...firstTab.regions, [first.regionId]: { ...first, profileId: 'profile-a', mode: 'normal' } } },
    [secondTab.id]: { ...secondTab, regions: { ...secondTab.regions, [second.regionId]: { ...second, profileId: 'profile-a', mode: 'normal' } } },
    [hiddenTab.id]: hiddenTab }, layouts: { ...state.layouts, [resource.id]: addTabOccurrence(state.layouts[resource.id]!, 'source-group', hiddenTab.id)! },
    surveyPageReferences: [f.first, hidden, f.second, retained], surveyProfileView: { kind: 'profile', profileId: 'profile-a' } }))
  await checkpointSpatialWorkbench()
  await vi.waitFor(() => expect(document.querySelector('[data-survey-page-region-id="other-profile-page"]')).toBeNull())
  const rect = f.secondRow().getBoundingClientRect()
  await dragPointer(f.grip(), { x: rect.left + 30, y: rect.top + 20 })
  await vi.waitFor(() => expect(useAppStore.getState().surveyPageReferences).toEqual([f.second, hidden, f.first, retained]))
  const handle = document.querySelector<HTMLElement>('[data-survey-page-region-id="retained-order-region"] .survey-drag-handle')!
  expect(handle).not.toBeNull()
  const close = vi.spyOn(api.browser, 'close'), navigate = vi.spyOn(api.browser, 'navigate')
  const target = f.secondRow().getBoundingClientRect()
  await dragPointer(handle, { x: target.left + 30, y: target.top + 15 })
  await vi.waitFor(() => expect(useAppStore.getState().surveyPageReferences).toEqual([retained, hidden, f.second, f.first]))
  expect(close).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled()
})

it('[page-order] repeated exact page admission preserves the user order while still saving through the original owner', async () => {
  const f = await pageOrderFixture(), originalPages = [f.second, f.first]
  useAppStore.setState({ surveyPageReferences: originalPages })
  const before = useAppStore.getState(), graph = (await core.read())!.graph
  const report = await before.setSurveyPageCollected(f.second, true)
  expect(report.outcome).toBe('unchanged'); expect(report.changed).toBe(false)
  expect(report.pageReferences).toEqual(originalPages); expect(report.save?.clientStateWritten).toBe(true)
  expect(useAppStore.getState().surveyPageReferences).toEqual(originalPages)
  expect(useAppStore.getState().surveyZoneSelection).toEqual(before.surveyZoneSelection)
  expect((await core.read())!.graph).toEqual(graph)
})


it.each([false, true, 'focus-local'] as const)('[window-return-app] original exact-page host returns to its Survey unless later navigation supersedes it: %s', async later => {
  let requestListener: ((request: import('../src/shared/workbench-windows').WorkbenchWindowRequest) => void) | undefined
  vi.spyOn(api.ui.workbenchWindows, 'onRequest').mockImplementation(listener => { requestListener = listener; return () => { requestListener = undefined } })
  const response = vi.spyOn(api.ui.workbenchWindows, 'respond').mockImplementation(() => {})
  vi.spyOn(api.ui.workbenchWindows, 'ready').mockResolvedValue({ windowId: 'return-app-main', documentGeneration: 'return-app-main-document' })
  const frame = document.createElement('iframe'); document.body.append(frame)
  const child = frame.contentWindow!, childDocument = frame.contentDocument!
  // happy-dom adoptNode makes ownerDocument non-configurable, so it cannot return
  // an already adopted node. Mirror that platform move only; real cross-document
  // Guest/DOM preservation is covered by the independent Electron consumer.
  for (const owner of [document, childDocument]) vi.spyOn(owner, 'adoptNode').mockImplementation(<T extends Node>(node: T): T => {
    node.parentNode?.removeChild(node)
    Object.defineProperty(node, 'ownerDocument', { value: owner, configurable: true })
    return node
  })
  const slot = childDocument.createElement('div'); slot.id = 'workbench-window-root'; childDocument.body.append(slot)
  Object.defineProperty(childDocument, 'readyState', { configurable: true, value: 'complete' })
  vi.spyOn(window, 'open').mockReturnValue(child)
  try {
    const page = await showHeaderPage(), before = useAppStore.getState()
    const projection = surveyPageProjection(page, catalog(), before.tabs, () => {})!, reference = projection.selection[0]!
    const target = { kind: 'region' as const, ...reference }, identity = { windowId: 'return-app-child', documentGeneration: 'return-app-child-document' }
    const dispatch = async (action: object, id: string) => {
      expect(requestListener).toBeDefined()
      await act(async () => requestListener!({ requestId: id, ...identity, target, ...action } as import('../src/shared/workbench-windows').WorkbenchWindowRequest))
      await vi.waitFor(() => expect(response.mock.calls.some(([reply]) => reply.requestId === id)).toBe(true))
      return response.mock.calls.find(([reply]) => reply.requestId === id)![0]
    }
    const prepared = await dispatch({ action: 'prepare' }, 'prepare-original-return')
    expect(prepared).toMatchObject({ outcome: 'applied', returnContext: { surface: 'survey', reference, selection: { kind: 'page', ...page } } })
    const context = prepared.returnContext!
    expect(await dispatch({ action: 'open', returnContext: context, url: 'about:blank', frameName: 'exact-original-shell' }, 'open-original-return')).toMatchObject({ outcome: 'applied' })
    expect(childDocument.querySelector('.browser-surface')).not.toBeNull()
    expect(childDocument.querySelector('.workbench-window-toolbar')?.textContent).toContain('Return to Survey')
    await act(async () => useAppStore.getState().setMainSurface('workbench'))
    const work = useAppStore.getState().workbenchSpaceSelection
    if (!later) {
      expect(await dispatch({ action: 'return', returnContext: context, navigate: true }, 'explicit-original-return')).toMatchObject({ outcome: 'applied' })
      expect(useAppStore.getState().mainSurface).toBe('survey')
      expect(useAppStore.getState().surveyZoneSelection).toEqual({ kind: 'page', ...page })
      expect(useAppStore.getState().workbenchSpaceSelection).toBe(work)
    } else {
      if (later === 'focus-local') await act(async () => useAppStore.getState().setMainSurface('agents'))
      childDocument.dispatchEvent(new Event('compositionstart', { bubbles: true }))
      await act(async () => requestListener!({ requestId: 'later-original-return', ...identity, target, action: 'return', returnContext: context, navigate: true }))
      expect(response.mock.calls.some(([reply]) => reply.requestId === 'later-original-return')).toBe(false)
      if (later === 'focus-local') {
        const beforeClose = useAppStore.getState()
        await click(named('Close Focus workspace'))
        expect(useAppStore.getState().mainSurface).toBe(beforeClose.mainSurface)
        expect(useAppStore.getState().workbenchSpaceSelection).toBe(beforeClose.workbenchSpaceSelection)
        expect(document.querySelector('.global-focus-surface')?.classList.contains('global-board-surface--session-open')).toBe(false)
      } else await act(async () => useAppStore.getState().setMainSurface('agents'))
      await act(async () => childDocument.dispatchEvent(new Event('compositionend', { bubbles: true })))
      await vi.waitFor(() => expect(response.mock.calls.some(([reply]) => reply.requestId === 'later-original-return' && reply.outcome === 'applied')).toBe(true))
      expect(useAppStore.getState().mainSurface).toBe('agents')
      if (later === 'focus-local') expect(document.querySelector('.global-focus-surface')?.classList.contains('global-board-surface--session-open')).toBe(false)
    }
    expect(useAppStore.getState().tabs[reference.tabId]!.regions[reference.regionId]).toBe(before.tabs[reference.tabId]!.regions[reference.regionId])
  } finally { frame.remove() }
})


it('[window-return-app] one automatic native-window intent retains its exact context without lending it to a concurrent public open', async () => {
  let listener: ((request: import('../src/shared/workbench-windows').WorkbenchWindowRequest) => void) | undefined
  vi.spyOn(api.ui.workbenchWindows, 'onRequest').mockImplementation(value => { listener = value; return () => { listener = undefined } })
  vi.spyOn(api.ui.workbenchWindows, 'ready').mockResolvedValue({ windowId: 'intent-main', documentGeneration: 'intent-document' })
  const replies = vi.spyOn(api.ui.workbenchWindows, 'respond').mockImplementation(() => {})
  const page = await showHeaderPage(), state = useAppStore.getState(), reference = surveyPageProjection(page, catalog(), state.tabs, () => {})!.selection[0]!
  const target = { kind: 'region' as const, ...reference }, context = { surface: 'focus' as const, reference, view: 'region' as const }
  let finish!: (value: import('@agentmux/core/control').AppWindowPage) => void
  const calls = vi.spyOn(api.ui.workbenchWindows, 'call').mockImplementation(() => new Promise(resolve => { finish = resolve as typeof finish }))
  const { openWorkbenchWindow } = await import('../src/renderer/src/lib/workbench-windows')
  const pending = openWorkbenchWindow(target, { focus: false, returnContext: context })
  await vi.waitFor(() => expect(calls).toHaveBeenCalledOnce())
  const original = calls.mock.calls[0]![1] as import('@agentmux/core/control').AppWindowParamsMap['app.window.open']
  expect(original).toEqual({ operationId: expect.any(String), target, focus: false })
  const prepare = async (requestId: string, operationId: string) => {
    await act(async () => listener!({ requestId, windowId: 'intent-child', documentGeneration: 'intent-child-document', action: 'prepare', operationId, target }))
    await vi.waitFor(() => expect(replies.mock.calls.some(([reply]) => reply.requestId === requestId)).toBe(true))
    return replies.mock.calls.find(([reply]) => reply.requestId === requestId)![0]
  }
  expect((await prepare('exact-intent-prepare', original.operationId)).returnContext).toEqual(context)
  expect((await prepare('other-public-prepare', 'another-original-operation')).returnContext).toMatchObject({ surface: 'survey' })
  finish({ windows: [], recordedOperation: { method: 'app.window.open', input: original, actor: { kind: 'user', id: 'desktop' },
    state: 'unknown', windowId: 'intent-child', documentGeneration: 'intent-child-document', message: 'Original acknowledgement unknown' } })
  await act(async () => pending)
  expect((await prepare('same-unknown-intent', original.operationId)).returnContext).toEqual(context)
  const inspect = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Inspect original open')
  expect(inspect).toBeDefined()
  const unknown = openWorkbenchWindow(target, { focus: false, returnContext: null })
  await vi.waitFor(() => expect(calls).toHaveBeenCalledTimes(2))
  const unknownInput = calls.mock.calls[1]![1] as import('@agentmux/core/control').AppWindowParamsMap['app.window.open']
  expect((await prepare('known-unknown-origin', unknownInput.operationId)).returnContext).toBeNull()
  finish({ windows: [], recordedOperation: { method: 'app.window.open', input: unknownInput, actor: { kind: 'user', id: 'desktop' },
    state: 'rejected', windowId: null, documentGeneration: null, message: 'Fixture original operation declined before launch' } })
  await act(async () => unknown)
})

it('[window-return-app] an existing old research cannot reclaim the same occurrence after its Tab moves to another research', async () => {
  const state = useAppStore.getState(), tab = source()
  const neighbor = createWorkbenchTab('return-old-zone-sibling', { kind: 'launcher', workspaceId: resource.id, regionId: 'return-old-zone-sibling-region' })
  useAppStore.setState({ tabs: { ...state.tabs, [neighbor.id]: neighbor }, layouts: { ...state.layouts,
    [resource.id]: addTabOccurrence(state.layouts[resource.id]!, 'source-group', neighbor.id)! } })
  await checkpointSpatialWorkbench()
  const beforeCatalog = catalog(), reference = beforeCatalog.locations.find(row => row.tabId === tab.id && row.groupId === 'source-group' && row.regionId === 'composition-page')!
  const original = { surface: 'survey' as const, reference: { displayWorkspaceId: reference.displayWorkspaceId, groupId: reference.groupId, tabId: reference.tabId, regionId: reference.regionId },
    selection: { zoneId: zones.source, selection: [{ tabId: tab.id, regionId: reference.regionId }], active: { tabId: tab.id, regionId: reference.regionId } } }
  await dom.render(<App />)
  const nearby = await useAppStore.getState().createWorkbenchZone({ workspaceId: resource.id, spaceIds: [] })
  const moved = await useAppStore.getState().composeSurveyTabs({ ...request(), target: { kind: 'existing', zoneId: nearby.zone.zoneId,
    workspaceId: resource.id, displayWorkspaceId: resource.id, groupId: 'source-group' } })
  expect(moved.outcome).toBe('moved')
  expect(catalog().tabs.find(row => row.tabId === neighbor.id)?.zoneId).toBe(zones.source)
  expect(catalog().tabs.find(row => row.tabId === tab.id)?.zoneId).toBe(nearby.zone.zoneId)
  expect(catalog().locations.some(row => ['displayWorkspaceId', 'groupId', 'tabId', 'regionId'].every(key => row[key as keyof typeof row] === original.reference[key as keyof typeof original.reference]))).toBe(true)
  await act(async () => useAppStore.getState().setMainSurface('agents'))
  const held = useAppStore.getState()
  const { revealWorkbenchContext } = await import('../src/renderer/src/lib/workbench-windows')
  expect(() => revealWorkbenchContext(original)).toThrow('original Survey return location')
  expect(useAppStore.getState().mainSurface).toBe(held.mainSurface)
  expect(useAppStore.getState().surveyZoneSelection).toBe(held.surveyZoneSelection)
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(held.workbenchSpaceSelection)
  expect(useAppStore.getState().tabs[tab.id]!.regions[reference.regionId]).toBe(held.tabs[tab.id]!.regions[reference.regionId])
})

it('[window-return-app] a sole Browser borrows the unique visible Survey occurrence while its canonical Space host stays parked', async () => {
  let listener: ((request: import('../src/shared/workbench-windows').WorkbenchWindowRequest) => void) | undefined
  let changes: ((value: import('../src/shared/workbench-windows').WorkbenchWindowSnapshot) => void) | undefined
  vi.spyOn(api.ui.workbenchWindows, 'onRequest').mockImplementation(value => { listener = value; return () => { listener = undefined } })
  vi.spyOn(api.ui.workbenchWindows, 'onChanged').mockImplementation(value => { changes = value; return () => { changes = undefined } })
  vi.spyOn(api.ui.workbenchWindows, 'ready').mockResolvedValue({ windowId: 'plain-return-main', documentGeneration: 'plain-return-document' })
  const replies = vi.spyOn(api.ui.workbenchWindows, 'respond').mockImplementation(() => {})
  const native = await api.browser.create('plain-return-sibling', 'https://return.example.test/sibling', resource.id)
  const state = useAppStore.getState(), browser = source().regions['composition-page']!
  const sibling = createWorkbenchTab('plain-return-sibling-tab', { ...native, kind: 'browser', browserId: native.id,
    regionId: 'plain-return-sibling-region', workspaceId: resource.id })
  sibling.space = source().space!
  useAppStore.setState({ tabs: { ...state.tabs, [source().id]: createWorkbenchTab(source().id, browser), [sibling.id]: sibling }, layouts: { ...state.layouts,
    [resource.id]: addTabOccurrence(state.layouts[resource.id]!, 'source-group', sibling.id)! } })
  state.selectMainRegion({ displayWorkspaceId: resource.id, groupId: 'source-group', tabId: sibling.id, regionId: 'plain-return-sibling-region' })
  const page = await showHeaderPage(), reference = surveyPageProjection(page, catalog(), useAppStore.getState().tabs, () => {})!.selection[0]!
  const originalTarget = { kind: 'region' as const, ...reference }
  await act(async () => changes!({ issue: null, windows: [{ windowId: 'plain-return-shell', documentGeneration: 'plain-return-shell-document', target: originalTarget,
    presentation: 'pending', bounds: null, focused: null }] }))
  await act(async () => listener!({ action: 'prepare', requestId: 'plain-survey-prepare', operationId: 'plain-survey-public-open',
    windowId: 'plain-return-shell', documentGeneration: 'plain-return-shell-document', target: originalTarget }))
  await vi.waitFor(() => expect(replies.mock.calls.some(([reply]) => reply.requestId === 'plain-survey-prepare')).toBe(true))
  expect(replies.mock.calls.find(([reply]) => reply.requestId === 'plain-survey-prepare')![0]).toMatchObject({ outcome: 'applied',
    returnContext: { surface: 'survey', reference, selection: { kind: 'page', ...page } } })
})

async function prepareHeaderlessResearch() {
  const restores = vi.spyOn(api.browser, 'restore')
  const state = useAppStore.getState(), extra = createWorkbenchTab('headerless-second-tab', { kind: 'file', workspaceId: resource.id, path: 'second-original.md', regionId: 'headerless-second-region' })
  useAppStore.setState({ tabs: { ...state.tabs, [extra.id]: extra }, layouts: { ...state.layouts,
    [resource.id]: addTabOccurrence(state.layouts[resource.id]!, 'source-group', extra.id)! }, surveyExplorationNames: {},
    surveyOrganization: { ungrouped: [zones.source, zones.target], groups: [] } })
  await checkpointSpatialWorkbench(); dragGeometry(); await dom.render(<App />)
  const row = () => [...document.querySelectorAll<HTMLElement>('[data-survey-zone-id]')].find(node => node.dataset.surveyZoneId === zones.source)!
  await vi.waitFor(() => expect(row()?.dataset.headerless).toBe('true'))
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Original file input"]')).not.toBeNull())
  // The original Browser restore can publish its actual title after mount. Settle that ACK before the topology baseline.
  await act(async () => { await Promise.all(restores.mock.results.map(result => result.value)) })
  await checkpointSpatialWorkbench()
  expect(useAppStore.getState().surveyOrganization.groups).toEqual([])
  expect(row().querySelector('.survey-item')).toBeNull()
  expect(row().querySelectorAll('.survey-tab-column')).toHaveLength(2)
  return row()
}

it.each(['frame', 'grid gap'] as const)('[headerless-drag] original compact %s moves the complete research through the original Core owner', async surface => {
  const row = await prepareHeaderlessResearch(), before = useAppStore.getState(), graphBefore = (await core.read())!.graph
  const editor = document.querySelector<HTMLTextAreaElement>('[aria-label="Original file input"]')!; editor.value = 'Original compact research draft'
  const originalRegions = Object.values(before.tabs['composition-tab']!.regions)
  const destination = [...document.querySelectorAll<HTMLElement>('[data-survey-zone-id]')].find(node => node.dataset.surveyZoneId === zones.target)!.getBoundingClientRect()
  vi.mocked(api.spatial.commit).mockClear()
  await dragPointer(surface === 'frame' ? row : row.querySelector<HTMLElement>('.survey-item-tabs')!, { x: destination.left + 90, y: destination.top + 45 })
  await vi.waitFor(() => expect(catalog().tabs.filter(tab => ['composition-tab', 'headerless-second-tab'].includes(tab.tabId)).every(tab => tab.zoneId === zones.target)).toBe(true))
  expect(vi.mocked(api.spatial.commit)).toHaveBeenCalledOnce()
  const graph = (await core.read())!.graph
  for (const region of originalRegions) {
    expect(graph.resources['region:' + region.regionId]).toEqual(graphBefore.resources['region:' + region.regionId])
    expect(useAppStore.getState().tabs['composition-tab']!.regions[region.regionId]).toEqual(region)
  }
  expect(useAppStore.getState().tabs['headerless-second-tab']!.regions['headerless-second-region']).toEqual(before.tabs['headerless-second-tab']!.regions['headerless-second-region'])
  expect(document.querySelector('[aria-label="Original file input"]')).toBe(editor); expect(editor.value).toBe('Original compact research draft')
  expect(useAppStore.getState().agentComposerDrafts).toEqual(before.agentComposerDrafts)
})

it('[headerless-drag] its independent grip changes only original list order and saves without a Core composition', async () => {
  const commit = vi.spyOn(useAppStore.getState(), 'setSurveyOrganization'), row = await prepareHeaderlessResearch(), before = useAppStore.getState(), graph = await core.read()
  const destination = [...document.querySelectorAll<HTMLElement>('[data-survey-zone-id]')].find(node => node.dataset.surveyZoneId === zones.target)!.getBoundingClientRect()
  vi.mocked(api.spatial.commit).mockClear()
  await dragPointer(row.querySelector<HTMLElement>('.survey-drag-handle')!, { x: destination.left + 90, y: destination.top + 45 })
  await vi.waitFor(() => expect(useAppStore.getState().surveyOrganization.ungrouped).toEqual([zones.target, zones.source]))
  expect(commit).toHaveBeenCalledOnce(); expect(await commit.mock.results[0]!.value).toMatchObject({ changed: true, save: { clientStateWritten: true, storageFlushRequested: true } })
  expect(vi.mocked(api.spatial.commit)).not.toHaveBeenCalled(); expect(await core.read()).toEqual(graph)
  expect(useAppStore.getState().tabs).toEqual(before.tabs); expect(useAppStore.getState().surveyZoneSelection).toEqual(before.surveyZoneSelection)
})

it('[headerless-drag] a child thumbnail moves only its own complete Tab and keeps the research sibling', async () => {
  const row = await prepareHeaderlessResearch(), before = useAppStore.getState()
  const destination = [...document.querySelectorAll<HTMLElement>('[data-survey-zone-id]')].find(node => node.dataset.surveyZoneId === zones.target)!.getBoundingClientRect()
  await dragPointer(row.querySelector<HTMLElement>('[data-survey-tab-id="composition-tab"]')!, { x: destination.left + 90, y: destination.top + 45 })
  await vi.waitFor(() => expect(catalog().tabs.find(tab => tab.tabId === 'composition-tab')!.zoneId).toBe(zones.target))
  expect(catalog().tabs.find(tab => tab.tabId === 'headerless-second-tab')!.zoneId).toBe(zones.source)
  expect(useAppStore.getState().tabs['headerless-second-tab']).toEqual(before.tabs['headerless-second-tab'])
  expect(useAppStore.getState().tabs['composition-tab']!.regions).toEqual(before.tabs['composition-tab']!.regions)
})

it.each(['Escape', 'outside'] as const)('[headerless-drag] %s cancels the original whole-research pointer without any write', async cancellation => {
  const row = await prepareHeaderlessResearch(), graph = await core.read(), before = useAppStore.getState(), commit = vi.spyOn(before, 'setSurveyOrganization')
  const rect = row.getBoundingClientRect(), pointer = async (target: EventTarget, type: string, x: number, y: number) => act(async () => target.dispatchEvent(new PointerEvent(type,
    { bubbles: true, cancelable: true, pointerId: 5, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y })))
  vi.mocked(api.spatial.commit).mockClear()
  await pointer(row, 'pointerdown', rect.left + 90, rect.top + 8); await pointer(document, 'pointermove', rect.left + 100, rect.top + 8)
  await vi.waitFor(() => expect(document.querySelector('.survey-page-list')?.getAttribute('data-dragging')).toBe('true'))
  await pointer(document, 'pointermove', 700, 700)
  if (cancellation === 'Escape') await act(async () => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })))
  await pointer(document, 'pointerup', 700, 700)
  expect(commit).not.toHaveBeenCalled(); expect(vi.mocked(api.spatial.commit)).not.toHaveBeenCalled(); expect(await core.read()).toEqual(graph)
  expect(useAppStore.getState().surveyOrganization).toEqual(before.surveyOrganization); expect(useAppStore.getState().surveyZoneSelection).toEqual(before.surveyZoneSelection)
})

it.each(['research', 'tab'] as const)('[headerless-drag] keyboard pickup keeps the exact %s scope through the original Core owner', async scope => {
  const row = await prepareHeaderlessResearch(), before = useAppStore.getState()
  const activator = scope === 'research' ? row : row.querySelector<HTMLElement>('[data-survey-tab-id="composition-tab"]')!
  if (scope === 'research') { expect(row.tabIndex).toBe(0); expect(row.getAttribute('role')).toBe('group') }
  await act(async () => activator.focus()); expect(document.activeElement).toBe(activator)
  const key = async (value: string, code: string) => act(async () => activator.dispatchEvent(new KeyboardEvent('keydown', { key: value, code, bubbles: true, cancelable: true })))
  await key(' ', 'Space'); await vi.waitFor(() => expect(document.querySelector('.survey-page-list')?.getAttribute('data-dragging')).toBe('true'))
  await new Promise(resolve => setTimeout(resolve, 30)); await key('ArrowDown', 'ArrowDown')
  await new Promise(resolve => setTimeout(resolve, 30)); await key(' ', 'Space')
  await vi.waitFor(() => expect(catalog().tabs.find(tab => tab.tabId === 'composition-tab')!.zoneId).toBe(zones.target))
  expect(catalog().tabs.find(tab => tab.tabId === 'headerless-second-tab')!.zoneId).toBe(scope === 'research' ? zones.target : zones.source)
  expect(useAppStore.getState().tabs['composition-tab']!.regions).toEqual(before.tabs['composition-tab']!.regions)
})

it('[headerless-drag] Portal menu, close and rename controls retain their own pointer scopes', async () => {
  const row = await prepareHeaderlessResearch(), before = useAppStore.getState(), graph = await core.read()
  const pointer = async (target: EventTarget, type: string) => act(async () => target.dispatchEvent(new PointerEvent(type,
    { bubbles: true, cancelable: true, pointerId: 5, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: type === 'pointerdown' ? 100 : 112, clientY: 140 })))
  const close = row.querySelector<HTMLElement>('.survey-tab-close')!
  await pointer(close, 'pointerdown'); await pointer(document, 'pointermove'); expect(document.querySelector('.survey-page-list')?.hasAttribute('data-dragging')).toBe(false); await pointer(close, 'pointerup')
  const options = row.querySelector<HTMLElement>('[aria-haspopup="menu"]')!; await menu(options.getAttribute('aria-label')!)
  const rename = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Rename exploration')!
  expect(row.contains(rename)).toBe(false)
  await pointer(rename, 'pointerdown'); await pointer(document, 'pointermove'); expect(document.querySelector('.survey-page-list')?.hasAttribute('data-dragging')).toBe(false)
  await pointer(rename, 'pointerup'); await act(async () => rename.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })))
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Exploration name"]')).not.toBeNull())
  const editor = document.querySelector<HTMLInputElement>('[aria-label="Exploration name"]')!
  await pointer(editor, 'pointerdown'); await pointer(document, 'pointermove'); expect(document.querySelector('.survey-page-list')?.hasAttribute('data-dragging')).toBe(false); await pointer(editor, 'pointerup')
  await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })))
  expect(await core.read()).toEqual(graph); expect(useAppStore.getState().surveyOrganization).toEqual(before.surveyOrganization)
})

// The public Survey path consumes the original App navigator and the same private Core/file owner.
let surveyPageCli: Awaited<ReturnType<typeof prepareSourceCoreCli>> | undefined
let surveyPageCliBuilding: ReturnType<typeof prepareSourceCoreCli> | undefined
afterAll(async () => { await surveyPageCli?.cleanup() })
async function withSurveyPageCli(run: (command: (args: string[]) => Promise<{ code: number | null; receipt: ReturnType<typeof objectCliReceipt> }>) => Promise<void>) {
  surveyPageCliBuilding ??= prepareSourceCoreCli()
  surveyPageCli = await surveyPageCliBuilding
  const socketDirectory = await mkdtemp('/tmp/asvc-'), socketPath = join(socketDirectory, 'control.sock')
  const server = new AgentMuxControlServer({ socketPath, execute: request => useAppStore.getState().executeControl(request) })
  const command = (args: string[]) => new Promise<{ code: number | null; receipt: ReturnType<typeof objectCliReceipt> }>((accept, reject) => {
    const child = spawn(process.execPath, [surveyPageCli!.cliPath, ...args], { env: privateEnvironment({
      AGENTMUX_RUNTIME_DIRECTORY: socketDirectory, AGENTMUX_STATE_DIRECTORY: join(socketDirectory, 'state'), AGENTMUX_RPC_ENDPOINT: 'unix:' + socketPath }), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
    const timeout = setTimeout(() => { child.kill(); reject(Error('Original private Survey CLI timed out')) }, 15_000)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('close', code => { clearTimeout(timeout); try {
      const raw = stdout.trim() || stderr.split('\n').find(line => line.startsWith('{'))
      expect(raw, stderr).toBeTruthy(); accept({ code, receipt: objectCliReceipt(JSON.parse(raw!)) })
    } catch (error) { reject(error) } })
  })
  try { await server.start(); await run(command) } finally { await server.stop(); await rm(socketDirectory, { recursive: true, force: true }) }
}
async function showSurveyCliApp() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 700,
    width: 1000, height: 700, toJSON: () => ({}) })
  const page = { regionId: 'composition-page', browserId: 'composition-page' }
  await useAppStore.getState().setSurveyPageCollected(page, true)
  useAppStore.getState().setMainSurface('board')
  await dom.render(<App />)
  return page
}

it('[survey-cli] source CLI opens one default page with explicit registration without choosing it or collecting mixed task siblings', async () => {
  await showSurveyCliApp()
  const before = useAppStore.getState(), create = vi.spyOn(api.browser, 'create'), close = vi.spyOn(api.browser, 'close')
  await withSurveyPageCli(async command => {
    const output = await command(['browser', 'open', '--url', 'https://public.example.test/survey', '--in-region', 'target-region', '--survey', '--operation-id', 'survey-explicit-open'])
    expect(output.code).toBe(0); expect(output.receipt.ok, JSON.stringify(output.receipt)).toBe(true)
    if (!output.receipt.ok) throw Error('Original public creation receipt required')
    const result = output.receipt.result as import('@agentmux/core/control').AgentMuxControlResult & { operation: 'open.browser' }
    expect(result.survey).toMatchObject({ outcome: 'registered', reference: { regionId: result.region.regionId, browserId: result.region.browserId } })
    expect(result.region.tabId).toBe('target-tab'); expect(result.region.regionId).toBe('target-region')
    const current = useAppStore.getState()
    expect(current.surveyCollectedZones).toEqual(before.surveyCollectedZones)
    expect(current.surveyPageReferences).toEqual([...before.surveyPageReferences, result.survey.reference])
    expect(current.surveyZoneSelection).toEqual(before.surveyZoneSelection)
    expect(current.mainSurface).toBe(before.mainSurface); expect(current.workbenchSpaceSelection).toEqual(before.workbenchSpaceSelection)
    expect(source().regions['composition-file']).toBe(before.tabs[source().id]!.regions['composition-file'])
    expect(source().regions['composition-agent-region']).toBe(before.tabs[source().id]!.regions['composition-agent-region'])
    const listed = await command(['space', 'survey-list'])
    expect(listed.receipt.ok).toBe(true)
    if (listed.receipt.ok) expect(listed.receipt.result).toMatchObject({ pageReferences: current.surveyPageReferences })
  })
  expect(create).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled()
})

it('[survey-cli] source CLI selects an exact saved page in the actual App while retaining Work choice, Browser and sibling drafts', async () => {
  const page = await showSurveyCliApp(), before = useAppStore.getState()
  await withSurveyPageCli(async command => {
    const pending = command(['app', 'focus', '--surface', 'survey', '--browser', page.browserId, '--region', page.regionId,
      '--display-workspace', resource.id, '--group', 'source-group', '--tab', source().id])
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 160)) })
    const output = await pending
    expect(output.receipt.ok, JSON.stringify(output.receipt)).toBe(true)
    if (!output.receipt.ok) throw Error('Original focus receipt required')
    expect(output.receipt.result).toMatchObject({ navigation: { state: 'applied', selection: { surface: 'survey', survey: { kind: 'page', ...page } } },
      presentation: { state: 'main-visible', tabId: source().id, regionId: page.regionId } })
    const current = useAppStore.getState()
    expect(current.surveyZoneSelection).toEqual({ kind: 'page', ...page })
    expect(current.workbenchSpaceSelection).toEqual(before.workbenchSpaceSelection); expect(current.activeWorkspaceId).toBe(before.activeWorkspaceId)
    const originalPage = before.tabs[source().id]!.regions[page.regionId]!
    expect(current.tabs[source().id]!.regions[page.regionId]).toMatchObject({ kind: 'browser', regionId: page.regionId,
      browserId: page.browserId, workspaceId: originalPage.workspaceId })
    expect(current.tabs[source().id]!.regions['composition-file']).toEqual(before.tabs[source().id]!.regions['composition-file'])
    expect(current.tabs[source().id]!.regions['composition-agent-region']).toEqual(before.tabs[source().id]!.regions['composition-agent-region'])
    expect(current.sessions).toEqual(before.sessions); expect(current.agentComposerDrafts).toEqual(before.agentComposerDrafts)
    expect(document.querySelector('.global-survey-surface .survey-page-tab-header')).not.toBeNull()
    expect(document.querySelector('.global-survey-surface [data-workbench-region-id="composition-page"]')).not.toBeNull()
  })
})

it('[survey-cli] source CLI selects the saved research and its accurate File Region without importing membership or changing execution', async () => {
  await showSurveyCliApp(); const before = useAppStore.getState()
  await withSurveyPageCli(async command => {
    const pending = command(['app', 'focus', '--surface', 'survey', '--zone', zones.source, '--display-workspace', resource.id,
      '--group', 'source-group', '--tab', source().id, '--region', 'composition-file'])
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 160)) })
    const output = await pending
    expect(output.receipt.ok, JSON.stringify(output.receipt)).toBe(true)
    if (!output.receipt.ok) throw Error('Original focus receipt required')
    expect(output.receipt.result).toMatchObject({ navigation: { state: 'applied', selection: { surface: 'survey', survey: { zoneId: zones.source,
      active: { tabId: source().id, regionId: 'composition-file' } } } }, presentation: { regionId: 'composition-file', state: 'main-visible' } })
    expect(useAppStore.getState().workbenchSpaceSelection).toEqual(before.workbenchSpaceSelection)
    expect(useAppStore.getState().surveyCollectedZones).toEqual(before.surveyCollectedZones)
    expect(document.querySelector('.global-survey-surface [aria-label="Original file input"]')).not.toBeNull()
    expect(useAppStore.getState().agentComposerDrafts).toEqual(before.agentComposerDrafts)
  })
})

it('[survey-cli] wrong saved Browser pair and foreign research occurrence refuse only that navigation and never collect a target', async () => {
  const page = await showSurveyCliApp(), before = useAppStore.getState()
  await withSurveyPageCli(async command => {
    for (const args of [ ['--browser', 'different-browser', '--region', page.regionId],
      ['--zone', zones.target, '--display-workspace', resource.id, '--group', 'source-group', '--tab', source().id, '--region', page.regionId] ]) {
      const output = await command(['app', 'focus', '--surface', 'survey', ...args])
      expect(output.receipt.ok, JSON.stringify(output.receipt)).toBe(true)
      if (output.receipt.ok) expect(output.receipt.result).toMatchObject({ navigation: { state: 'rejected' }, issues: [expect.objectContaining({ code: 'SURVEY_TARGET_UNCONFIRMED' })] })
      expect(useAppStore.getState().surveyZoneSelection).toEqual(before.surveyZoneSelection)
      expect(useAppStore.getState().mainSurface).toBe(before.mainSurface)
      expect(useAppStore.getState().surveyPageReferences).toEqual(before.surveyPageReferences)
      expect(useAppStore.getState().surveyCollectedZones).toEqual(before.surveyCollectedZones)
    }
  })
})

it('[survey-cli] a later choice during the original save is retained and the CLI does not claim its older Survey navigation still current', async () => {
  const page = await showSurveyCliApp()
  await withSurveyPageCli(async command => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
    vi.mocked(api.ui.requestStorageFlush).mockImplementation(() => gate)
    const pending = command(['app', 'focus', '--surface', 'survey', '--browser', page.browserId, '--region', page.regionId])
    await vi.waitFor(() => expect(useAppStore.getState().mainSurface).toBe('survey'))
    await act(async () => useAppStore.getState().setMainSurface('board'))
    release()
    const output = await pending
    expect(output.receipt.ok, JSON.stringify(output.receipt)).toBe(true)
    if (output.receipt.ok) expect(output.receipt.result).toMatchObject({ navigation: { state: 'unconfirmed', selection: { surface: 'goals' } },
      issues: expect.arrayContaining([expect.objectContaining({ code: 'NAVIGATION_CHANGED' })]) })
    expect(useAppStore.getState().mainSurface).toBe('board')
  })
})

it('[survey-cli] strict public input rejects false registration, incomplete occurrences and mismatched navigation fields before effects', () => {
  const before = useAppStore.getState()
  expect(() => parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'invalid-register', operation: 'open.browser',
    url: 'https://public.example.test/', survey: false, destination: { kind: 'launcher', regionId: 'target-region' } })).toThrow()
  expect(() => parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'invalid-selection', operation: 'focus', inputPolicy: 'preserve',
    target: { kind: 'survey', selection: { kind: 'page', regionId: 'composition-page', browserId: 'composition-page' }, reference: { tabId: source().id } } })).toThrow()
  expect(() => parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'invalid-extra', operation: 'focus', inputPolicy: 'preserve',
    target: { kind: 'survey', selection: { kind: 'zone', zoneId: zones.source }, surface: 'space' } })).toThrow()
  expect(useAppStore.getState()).toBe(before)
})

it('[survey-cli] selecting a saved page from another actual Profile reveals its row without rebinding the page environment', async () => {
  await showSurveyCliApp()
  const profileId = '11111111-1111-4111-8111-111111111111'
  useAppStore.setState({ surveyProfileView: { kind: 'profile', profileId: '22222222-2222-4222-8222-222222222222' } })
  const rebind = vi.spyOn(api.browser, 'switchProfile'), originalView = useAppStore.getState().surveyProfileView
  await withSurveyPageCli(async command => {
    const opened = await command(['browser', 'open', '--url', 'https://public.example.test/profile', '--in-region', 'target-region',
      '--profile', profileId, '--survey', '--operation-id', 'survey-profile-open'])
    expect(opened.receipt.ok, JSON.stringify(opened.receipt)).toBe(true)
    if (!opened.receipt.ok) throw Error('Original page creation required')
    const result = opened.receipt.result as Extract<import('@agentmux/core/control').AgentMuxControlResult, { operation: 'open.browser' }>
    expect(result.region.profileId).toBe(profileId)
    expect(useAppStore.getState().surveyProfileView).toEqual(originalView)
    const pending = command(['app', 'focus', '--surface', 'survey', '--browser', result.region.browserId, '--region', result.region.regionId])
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 160)) })
    const focused = await pending
    expect(focused.receipt.ok, JSON.stringify(focused.receipt)).toBe(true)
    expect(useAppStore.getState().surveyZoneSelection).toMatchObject({ kind: 'page', regionId: result.region.regionId, browserId: result.region.browserId })
    await vi.waitFor(() => expect(document.querySelector(`[data-survey-page-region-id="${result.region.regionId}"]`)).not.toBeNull())
    expect(useAppStore.getState().surveyProfileView).toEqual({ kind: 'profile', profileId })
    expect(useAppStore.getState().tabs[result.region.tabId]!.regions[result.region.regionId]).toMatchObject({ browserId: result.region.browserId, profileId })
  })
  expect(rebind).not.toHaveBeenCalled()
})

it('[survey-cli] selecting a saved single-Profile research reveals its row without rebinding any member', async () => {
  await showSurveyCliApp()
  const profileId = '11111111-1111-4111-8111-111111111111'
  useAppStore.setState({ surveyProfileView: { kind: 'profile', profileId: '22222222-2222-4222-8222-222222222222' } })
  const rebind = vi.spyOn(api.browser, 'switchProfile'), originalView = useAppStore.getState().surveyProfileView
  await withSurveyPageCli(async command => {
    const opened = await command(['browser', 'open', '--url', 'https://public.example.test/research-profile', '--in-region', 'target-region',
      '--profile', profileId, '--survey', '--operation-id', 'survey-research-profile-open'])
    expect(opened.receipt.ok, JSON.stringify(opened.receipt)).toBe(true)
    if (!opened.receipt.ok) throw Error('Original page creation required')
    const result = opened.receipt.result as Extract<import('@agentmux/core/control').AgentMuxControlResult, { operation: 'open.browser' }>
    expect(useAppStore.getState().surveyProfileView).toEqual(originalView)
    const current = useAppStore.getState()
    current.setSurveyZoneSelection({ ...surveyInitialZoneSelection(catalog(), zones.target, current.layouts, current.tabs, current.activeWorkspaceId), active: null })
    const pending = command(['app', 'focus', '--surface', 'survey', '--zone', zones.target])
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 160)) })
    const focused = await pending
    expect(focused.receipt.ok, JSON.stringify(focused.receipt)).toBe(true)
    expect(useAppStore.getState().surveyZoneSelection).toMatchObject({ zoneId: zones.target })
    expect(useAppStore.getState().surveyProfileView).toEqual({ kind: 'profile', profileId })
    await vi.waitFor(() => expect([...document.querySelectorAll('.survey-page-list [data-survey-zone-id]')]
      .find(element => element.getAttribute('data-survey-zone-id') === zones.target)).toBeDefined())
    expect(useAppStore.getState().tabs[result.region.tabId]!.regions[result.region.regionId]).toMatchObject({ browserId: result.region.browserId, profileId })
  })
  expect(rebind).not.toHaveBeenCalled()
})
