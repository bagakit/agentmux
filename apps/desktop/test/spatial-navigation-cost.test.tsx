// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { TopicCategory } from '@agentmux/core/control'
import type { AppConfig, ScratchTopicSnapshot } from '../src/shared/contracts'
import { directoryIdentity, homeZoneId, originalTopicAddress, spatialCategorySeeds, spatialSources, topicSpatialAddress, type SpaceZoneBindings } from '../src/shared/space-addresses'
import { desktopSpatialGraph, desktopBindingsFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { workbenchSelectionCatalog } from '../src/renderer/src/lib/desktop-focus-navigation'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'
import { moteTopic, scratchWorkspace } from './fixtures/mote-workface'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { UNCLASSIFIED_TOPIC_CATEGORY_ID } from '@agentmux/host/topic-categories'

vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))

const initial = useAppStore.getState()
declare const __AGENTMUX_SPATIAL_FOCUS_HASHES__: Record<string, string>
const counts = { seedBuilds: 0, seedComparisons: 0, allCategoryComparisons: 0, categoryEntries: 0, relationReads: 0, relationKeys: 0, renders: 0 }
const clear = () => { for (const key of Object.keys(counts)) counts[key as keyof typeof counts] = 0 }
let root: Root, host: HTMLDivElement, config: AppConfig, topics: ScratchTopicSnapshot[], categories: TopicCategory[]
let originalBindings: SpaceZoneBindings, observedBindings: SpaceZoneBindings
function observedCategories(values: readonly TopicCategory[]) {
  return new Proxy(values as TopicCategory[], { get(target, key, receiver) {
    if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) counts.categoryEntries++
    if (key === 'find') return (predicate: (entry: TopicCategory, index: number, array: TopicCategory[]) => unknown, thisArg?: unknown) =>
      Array.prototype.find.call(receiver, (entry: TopicCategory, index: number, array: TopicCategory[]) => { counts.allCategoryComparisons++; return predicate.call(thisArg, entry, index, array) })
    return Reflect.get(target, key, receiver)
  } })
}
function observedRelations(bindings: SpaceZoneBindings): SpaceZoneBindings {
  return Object.fromEntries(Object.entries(bindings).map(([id, binding]) => [id, { ...binding, relations: new Proxy(binding.relations ?? {}, {
    get(target, key, receiver) { if (typeof key === 'string') counts.relationReads++; return Reflect.get(target, key, receiver) },
    ownKeys(target) { const keys = Reflect.ownKeys(target); counts.relationKeys += keys.length; return keys }
  }) }]))
}
function seed(noise: number) {
  categories = [...Array.from({ length: noise }, (_, index) => `noise-${index}`), 'alpha', 'beta'].map(id => {
    const directoryPath = fixturePath(`navigation-category-${id}`)
    return { categoryId: id, hostId: 'local', title: `Category ${id}`, directoryPath, spaceId: directoryIdentity('local', directoryPath), revision: 'original' }
  })
  topics = categories.map((category, index) => ({ ...moteTopic(`launcher:navigation-${index}`, category.title + ' Topic', false), kind: 'topic' as const }))
  const sparse: SpaceZoneBindings = {}
  topics.forEach((topic, index) => {
    const spaceId = directoryIdentity('local', topic.identityDirectoryPath ?? topic.directoryPath), zoneId = homeZoneId(spaceId)
    sparse[zoneId] = { spaceId, workspaceId: scratchWorkspace.id, topicId: topic.id, contentKind: 'topic', directoryPath: topic.directoryPath,
      relations: { [categories[index]!.spaceId]: true }, resource: { kind: 'home', hostId: 'local', directoryPath: topic.directoryPath, branch: null } }
  })
  config = { ...composerConfig, workspaces: [scratchWorkspace, composerConfig.workspaces[0]!], focus: { recentActivityHours: 48, topicPresentation: 'cards' } }
  const sessions = ['alpha', 'beta'].map((id, index) => ({ ...composerSession(id), workspacePath: topics.at(index - 2)!.directoryPath, label: `Original ${id}` }))
  const original = topics.at(-2)!, spaceId = directoryIdentity('local', original.identityDirectoryPath ?? original.directoryPath)
  const tab = { ...createWorkbenchTab('navigation-original-tab', { kind: 'agent', phase: 'attached', regionId: 'navigation-original-region', workspaceId: scratchWorkspace.id, sessionId: 'alpha' }),
    topicId: original.id, space: { spaceId, zoneId: homeZoneId(spaceId) } }
  const work = { config, sessions, topicCategories: categories, spaceZoneBindings: sparse, spatialRequests: {},
    tabs: { [tab.id]: tab }, layouts: { [scratchWorkspace.id]: createWorkspaceLayout('navigation-original-group', [tab.id]), [composerConfig.workspaces[0]!.id]: createWorkspaceLayout('navigation-other-group', []) } }
  // Use the original graph projector/hydrator. Its explicit false entries are
  // consequential data; a hand-written sparse stand-in would hide the workload.
  const graph = desktopSpatialGraph(work, topics)
  originalBindings = desktopBindingsFromSpatial(graph, config)
  expect(Object.values(originalBindings).some(binding => Object.values(binding.relations ?? {}).includes(false))).toBe(true)
  observedBindings = observedRelations(originalBindings)
  useAppStore.setState({ ...initial, ...work, loading: false, spaceZoneBindings: observedBindings, topicCategories: observedCategories(categories),
    scratchTopicSnapshots: { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), revision: 1, topics, error: null, reading: false } },
    mainSurface: 'agents', focusView: 'list', activeWorkspaceId: composerConfig.workspaces[0]!.id,
    agentNames: { alpha: 'Original alpha', beta: 'Original beta' }, timelines: {}, agentComposerDrafts: { alpha: 'Original unsent draft' },
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } }, true)
}
function CatalogConsumer() {
  const catalog = useAppStore(workbenchSelectionCatalog); counts.renders++
  return <output data-original-navigation-catalog>{catalog.spaces.length} Spaces / {catalog.zones.length} Zones / {catalog.bindings.length} bindings</output>
}
async function mount(visible = false) {
  await act(async () => root.render(<><CatalogConsumer /><GlobalFocusSurface visible={visible} currentReference={null} workspaceOpen={false} /></>))
  const loaded = (globalThis as { __agentmuxSpatialLoadedSources?: Record<string, string> }).__agentmuxSpatialLoadedSources
  for (const file of ['lib/use-focus-collection-lanes.ts', 'lib/focus-collection-lanes.ts', 'components/FocusLaneHeadingMenu.tsx',
    'lib/use-focus-context-placements.ts', 'components/FocusScanLaneContent.tsx', 'components/FocusLaneGroups.tsx', 'components/FocusContextRow.tsx'])
    expect(loaded?.[file], `Actual Focus module must load: ${file}`).toMatch(/^[0-9a-f]{64}$/)
  expect(loaded).toEqual(__AGENTMUX_SPATIAL_FOCUS_HASHES__)
  console.log('SPATIAL_LOADED_SOURCES ' + JSON.stringify(loaded))
}
function expectOriginalCatalog() {
  const state = useAppStore.getState()
  const actual = workbenchSelectionCatalog(state)
  // The independent non-cache production entry retains the original algorithm.
  // Check full arrays and their order, including locations and original issues.
  expect(actual).toEqual(spatialCatalog({ ...state, sessions: [] }, topics))
  return actual
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('__agentmuxSpatialNavigationCost', (key: 'seedBuilds' | 'seedComparisons') => counts[key]++)
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: null })
  vi.spyOn(api.workspaces, 'listBranches').mockImplementation(async id => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: config?.workspaces.find(workspace => workspace.id === id)?.path ?? fixturePath('unknown') }))
  vi.spyOn(api.scratch, 'listTopics').mockImplementation(async () => topics)
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
  clear()
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); document.getElementById('agentmux-window-overlay-host')?.remove()
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it.each([0, 100, 1000])('actual navigation and hidden Focus reuse original classification seeds across separate Tab/layout updates (%i unrelated sources)', async noise => {
  seed(noise); clear(); await mount()
  expect(host.querySelector('[data-original-navigation-catalog]')).toBeTruthy()
  expect(counts.seedBuilds).toBeGreaterThan(0); expect(counts.seedComparisons).toBeGreaterThan(0)
  const before = useAppStore.getState(), original = before.tabs['navigation-original-tab'], drafts = before.agentComposerDrafts
  console.log('SPATIAL_COST ' + JSON.stringify({ phase: 'cold', noise, counts: { ...counts } }))
  const updates = [
    () => useAppStore.setState(state => ({ tabs: { ...state.tabs, 'navigation-unrelated-tab': createWorkbenchTab('navigation-unrelated-tab', { kind: 'launcher', workspaceId: composerConfig.workspaces[0]!.id, regionId: 'navigation-unrelated-region' }) } })),
    () => useAppStore.setState(state => ({ layouts: { ...state.layouts, [composerConfig.workspaces[0]!.id]: createWorkspaceLayout('navigation-changed-group', ['navigation-unrelated-tab']) } }))
  ]
  const warm: typeof counts[] = []
  for (const [update, apply] of updates.entries()) {
    clear(); await act(async () => apply())
    console.log('SPATIAL_COST ' + JSON.stringify({ phase: 'warm-unrelated', noise, update, counts: { ...counts } }))
    expect(counts.renders).toBeGreaterThan(0)
    warm.push({ ...counts })
  }
  expect(warm.map(count => count.seedBuilds), 'Original classification seed builder must not repeat on unrelated Tab and layout changes').toEqual([0, 0])
  expect(warm.map(count => count.seedComparisons)).toEqual([0, 0])
  expect(useAppStore.getState().tabs['navigation-original-tab']).toBe(original)
  expect(useAppStore.getState().sessions).toBe(before.sessions); expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
})

it('the real navigation consumer invalidates exact Category order and binding changes, including an original Topic observation gap', async () => {
  seed(0)
  const alpha = topics[0]!, alphaSpace = directoryIdentity('local', alpha.identityDirectoryPath ?? alpha.directoryPath), zoneId = homeZoneId(alphaSpace)
  const a = categories[0]!, b = categories[1]!
  topics = topics.slice(1)
  useAppStore.setState(state => ({ spaceZoneBindings: observedRelations({ ...originalBindings,
    [zoneId]: { ...originalBindings[zoneId]!, relations: { [a.spaceId]: true, [b.spaceId]: true } } }),
    scratchTopicSnapshots: { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), revision: 2, topics, error: null, reading: false } } }))
  await mount()
  const before = useAppStore.getState(), originalTab = before.tabs['navigation-original-tab']
  const first = expectOriginalCatalog()
  expect(first.bindings.filter(binding => binding.zoneId === zoneId).map(binding => binding.spaceId)).toEqual([a.spaceId, b.spaceId])
  clear()
  await act(async () => useAppStore.setState(state => ({ topicCategories: observedCategories([...state.topicCategories].reverse()) })))
  const reordered = workbenchSelectionCatalog(useAppStore.getState())
  expect(reordered.bindings.filter(binding => binding.zoneId === zoneId).map(binding => binding.spaceId)).toEqual([b.spaceId, a.spaceId])
  expect(counts.seedBuilds).toBeGreaterThan(0)
  expectOriginalCatalog()
  clear()
  await act(async () => useAppStore.setState(state => ({ spaceZoneBindings: { ...state.spaceZoneBindings,
    [zoneId]: { ...state.spaceZoneBindings[zoneId]!, relations: { [a.spaceId]: true, [b.spaceId]: false } } } })))
  expect(counts.seedBuilds).toBeGreaterThan(0)
  expect(expectOriginalCatalog().bindings.filter(binding => binding.zoneId === zoneId).map(binding => binding.spaceId)).toEqual([a.spaceId])
  expect(useAppStore.getState().tabs['navigation-original-tab']).toBe(originalTab)
  expect(useAppStore.getState().sessions).toBe(before.sessions); expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})

it('cached seeds do not hide current Topic text, new retained unknown Zones or resource changes from actual Focus and navigation', async () => {
  seed(0); await mount(true)
  const original = useAppStore.getState(), alpha = topics[0]!
  const card = () => host.querySelector<HTMLElement>('button.focus-context[data-session-id="alpha"]')
  expect(card()).toBeTruthy()
  clear(); topics = topics.map(topic => topic.id === alpha.id ? { ...topic, title: 'Latest original navigation Topic' } : topic)
  await act(async () => useAppStore.setState({ scratchTopicSnapshots: { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), revision: 2, topics, error: null, reading: false } } }))
  expect(counts.seedBuilds).toBe(0)
  expect(card()?.querySelector('[data-focus-topic-id]')?.textContent).toBe('Latest original navigation Topic')
  expectOriginalCatalog()
  clear()
  const missingSpace = directoryIdentity('remote', fixturePath('retained-foreign-space')), missingZone = 'original-unavailable-retained-zone'
  const retained = { ...createWorkbenchTab('navigation-retained-tab', { kind: 'launcher', regionId: 'navigation-retained-region', workspaceId: 'unavailable-workspace' }), space: { spaceId: missingSpace, zoneId: missingZone } }
  await act(async () => useAppStore.setState(state => ({ tabs: { ...state.tabs, [retained.id]: retained } })))
  expect(counts.seedBuilds).toBe(0)
  let catalog = expectOriginalCatalog()
  expect(catalog.zones.find(zone => zone.zoneId === missingZone)).toMatchObject({ kind: 'unknown', hostId: null, directoryPath: null })
  expect(catalog.bindings).toContainEqual({ zoneId: missingZone, spaceId: missingSpace })
  expect(catalog.spaces.find(space => space.spaceId === missingSpace)).toMatchObject({ hostId: 'remote', issue: expect.any(String) })
  clear()
  const project = config.workspaces.find(workspace => workspace.id !== scratchWorkspace.id)!, nextPath = fixturePath('latest-original-navigation-resource')
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, workspaces: state.config!.workspaces.map(workspace => workspace.id === project.id ? { ...workspace, path: nextPath } : workspace) } })))
  expect(counts.seedBuilds).toBe(0)
  catalog = expectOriginalCatalog()
  expect(catalog.spaces.some(space => space.kind === 'folder' && space.directoryPath === nextPath)).toBe(true)
  expect(useAppStore.getState().sessions).toBe(original.sessions); expect(useAppStore.getState().agentComposerDrafts).toBe(original.agentComposerDrafts)
  expect(useAppStore.getState().tabs['navigation-original-tab']).toBe(original.tabs['navigation-original-tab'])
})

it('the shared source function copies supplied seeds before Topic overrides and non-cache calls keep current in-place inputs', () => {
  seed(0)
  const alpha = topics[0]!, spaceId = directoryIdentity('local', alpha.identityDirectoryPath ?? alpha.directoryPath), zoneId = homeZoneId(spaceId)
  const bindings = { ...originalBindings, [zoneId]: { ...originalBindings[zoneId]!, relations: { [spaceId]: true } } }
  const seeds = spatialCategorySeeds(bindings, categories), original = [...seeds]
  expect(seeds.has(spaceId)).toBe(false)
  const cached = spatialSources(config, topics, bindings, [], categories, seeds)
  expect(cached).toEqual(spatialSources(config, topics, bindings, [], categories))
  expect([...seeds]).toEqual(original)
  bindings[zoneId]!.relations = { [categories[0]!.spaceId]: true }
  expect(spatialCategorySeeds(bindings, categories).get(spaceId)).toBe(categories[0]!.spaceId)
  bindings[zoneId]!.relations = { [categories[1]!.spaceId]: true }
  const current = spatialSources(config, [], bindings, [], categories)
  expect(current.bindings.filter(binding => binding.zoneId === zoneId).map(binding => binding.spaceId)).toEqual([categories[1]!.spaceId])
})

it('original category order, duplicate IDs, last metadata, same-content overwrite, Mote and unknown seeds retain complete ordered facts', () => {
  seed(0)
  const [a, b] = categories as [TopicCategory, TopicCategory]
  const duplicate = { ...a, title: 'Last original A metadata' }, remote = { ...a, hostId: 'remote', spaceId: directoryIdentity('remote', a.directoryPath), title: 'Same category ID on another Host' }
  const values = [a, b, duplicate, remote]
  const content = directoryIdentity('local', fixturePath('retained-observed-content')), unknown = directoryIdentity('local', fixturePath('retained-unknown-content'))
  const binding = (spaceId: string, relations: Record<string, boolean>, contentKind: 'topic' | 'mote' = 'topic') => ({ spaceId, workspaceId: scratchWorkspace.id, topicId: 'original-topic', contentKind, relations })
  const bindings: SpaceZoneBindings = { 'original-first-zone': binding(content, { [b.spaceId]: true, [a.spaceId]: true }),
    'original-later-zone': binding(content, { [remote.spaceId]: true }),
    'original-skipped-mote': binding(content, { [a.spaceId]: true }, 'mote'), 'original-unknown-zone': binding(unknown, {}) }
  const seeds = spatialCategorySeeds(bindings, values)
  expect([...seeds]).toEqual([[content, remote.spaceId], [unknown, null]])
  const firstOnly = { 'original-first-zone': bindings['original-first-zone']! }
  expect(spatialCategorySeeds(firstOnly, values).get(content)).toBe(a.spaceId)
  const result = spatialSources(config, [], firstOnly, [], values, spatialCategorySeeds(firstOnly, values))
  expect(result).toEqual(spatialSources(config, [], firstOnly, [], values))
  expect(result.spaces.find(space => space.spaceId === a.spaceId)?.name).toBe(duplicate.title)
  expect(result.spaces.find(space => space.spaceId === remote.spaceId)?.hostId).toBe('remote')
  expect(result.bindings.filter(value => value.zoneId === 'original-first-zone').map(value => value.spaceId)).toEqual([a.spaceId, b.spaceId])
  const absent = spatialSources(config, [], bindings, [], values, seeds)
  expect(absent.bindings.some(value => value.zoneId === 'original-unknown-zone')).toBe(false)
  expect(absent.zones.some(value => value.zoneId === 'original-unknown-zone')).toBe(true)
})

it('true, false and missing unclassified relationships and ambiguous original identities keep their original distinctions', () => {
  seed(0)
  const topic = topics[0]!, spaceId = directoryIdentity('local', topic.identityDirectoryPath ?? topic.directoryPath), zoneId = homeZoneId(spaceId)
  const fallback = { ...categories[0]!, categoryId: UNCLASSIFIED_TOPIC_CATEGORY_ID }
  const original = { ...originalBindings[zoneId]!, relations: {} as Record<string, boolean> }
  expect(topicSpatialAddress(config, topic, { [zoneId]: original }, [fallback])).toEqual({ spaceId: fallback.spaceId, zoneId })
  expect(topicSpatialAddress(config, topic, { [zoneId]: { ...original, relations: { [fallback.spaceId]: false } } }, [fallback])).toBeNull()
  expect(topicSpatialAddress(config, topic, { [zoneId]: { ...original, topicId: 'another-original-topic' } }, [fallback])).toEqual({ spaceId, zoneId })
  expect(topicSpatialAddress(config, topic, { [zoneId]: { ...original, contentKind: 'mote' } }, [fallback])).toEqual({ spaceId, zoneId })
  expect(topicSpatialAddress(config, topic, { [zoneId]: original }, [])).toEqual({ spaceId, zoneId })
  const { identityDirectoryPath: _identity, ...metadata } = topic
  const failed = { ...metadata, readError: 'Original metadata unavailable' }
  expect(originalTopicAddress(scratchWorkspace, failed, {})).toBeNull()
  expect(originalTopicAddress(scratchWorkspace, failed, { first: original })).toEqual({ spaceId, zoneId: 'first' })
  expect(originalTopicAddress(scratchWorkspace, failed, { first: original, second: { ...original } })).toBeNull()
})
