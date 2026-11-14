// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, mkdir, symlink, writeFile, readFile } from 'node:fs/promises'
import { readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve, relative, dirname } from 'node:path'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state'
import { composeSpatialTabs } from '../../../packages/core/src/spatial-tab-composition'
import { createWorkspaceLayout } from '@agentmux/layout'
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { checkpointSpatialWorkbench, prepareRendererUpdate, useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab, addWorkbenchRegion, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph, desktopWorkbenchFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { restorePersistedWorkbench } from '../src/renderer/src/lib/workbench-persistence'
import { captureSurveyCompositionSource, planSurveyTabComposition } from '../src/renderer/src/lib/survey-tab-composition'
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

// Keep the real listener process and protocol; resolve its shipped asset to this candidate's Source.
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, fork: ((path: string | URL, args: readonly string[], options: import('node:child_process').ForkOptions) =>
    actual.fork(String(path).endsWith('/control-endpoint-listener-worker.js')
      ? resolve('packages/core/src/control-endpoint-listener-worker.ts') : path, args, options)) as typeof actual.fork }
})
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => <textarea aria-label="Original Agent input" defaultValue="Unsent Agent input" /> }))
vi.mock('../src/renderer/src/components/EditorPane', () => ({ EditorPane: () => <textarea aria-label="Original file input" defaultValue="Unsent file input" /> }))


const initialStore = useAppStore.getState()
let restartFiles: WorkspaceFiles | undefined
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
const destination = () => ({ zoneId: zones.target, workspaceId: target.id, displayWorkspaceId: target.id, groupId: 'target-group' })
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
  if (process.env.SURVEY_COMPOSITION_RESTART_PHASE === 'read') localStorage.setItem('agentmux-workbench-v1', JSON.parse(await readFile(restart!, 'utf8')).record)
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
  await server.start()
  const env = privateEnvironment({ AGENTMUX_RUNTIME_DIRECTORY: socketDirectory, AGENTMUX_STATE_DIRECTORY: join(socketDirectory, 'state'), AGENTMUX_RPC_ENDPOINT: 'unix:' + socketPath })
  const command = (args: string[], input = '', expected = 0) => new Promise<any>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', error = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { error += chunk })
    child.once('error', reject); child.once('close', code => { try { expect(code, error + output).toBe(expected); resolve(objectCliReceipt(JSON.parse(output || error.split('\n').find(line => line.startsWith('{'))!))) } catch (error) { reject(error) } })
    child.stdin.end(input)
  })
  try {
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
