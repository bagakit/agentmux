// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { TopicCategory } from '@agentmux/core/control'
import type { AppConfig, ScratchTopicSnapshot, SessionSnapshot } from '../src/shared/contracts'
import { directoryIdentity, homeZoneId, type SpaceZoneBindings } from '../src/shared/space-addresses'
import { createClientUiRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { moteTopic, scratchWorkspace } from './fixtures/mote-workface'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { chooseFocusFilter, openFocusFilters } from './fixtures/focus-filter-menu'
import { focusProjectKey } from '../src/renderer/src/lib/focus-project-lanes'
import { formatSpaceAddress } from '@agentmux/core/sharing'

const observed = vi.hoisted(() => {
  const counts = { renders: 0, derive: 0, index: 0, project: 0, zones: 0, spaces: 0, bindings: 0, categories: 0, bindingEntries: 0, cachedIndexEntries: 0, indexLookups: 0, menuCategories: 0, categoryFindCalls: 0, categoryComparisons: 0 }
  const arrays = new WeakMap<object, Map<string, object>>(), objects = new WeakMap<object, Map<string, object>>()
  function counted<T extends object>(value: T, name: string): T {
    const cache = arrays.get(value) ?? new Map(); arrays.set(value, cache)
    if (cache.has(name)) return cache.get(name) as T
    const proxy = new Proxy(value, { get(target, key, receiver) {
      if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) counts[name as keyof typeof counts]++
      if (name === 'menuCategories' && key === 'find') return (predicate: (...args: unknown[]) => unknown, thisArg?: unknown) => {
        counts.categoryFindCalls++
        return Array.prototype.find.call(receiver, (entry, index, array) => { counts.categoryComparisons++; return predicate.call(thisArg, entry, index, array) })
      }
      return Reflect.get(target, key, receiver)
    } }); cache.set(name, proxy); return proxy
  }
  function inputs<T extends object>(value: T, category = false): T {
    const name = category ? 'content' : 'catalog', cache = objects.get(value) ?? new Map(); objects.set(value, cache)
    if (cache.has(name)) return cache.get(name) as T
    const proxy = new Proxy(value, { get(target, key, receiver) {
      const result = Reflect.get(target, key, receiver)
      if (category && key === 'bindings' && result && typeof result === 'object') {
        const saved = arrays.get(result) ?? new Map(); arrays.set(result, saved)
        if (!saved.has('record')) saved.set('record', new Proxy(result, { ownKeys(target) { const keys = Reflect.ownKeys(target); counts.bindingEntries += keys.length; return keys } }))
        return saved.get('record')
      }
      return ['zones', 'spaces', 'bindings', 'categories'].includes(String(key)) && Array.isArray(result) ? counted(result, String(key)) : result
    } }); cache.set(name, proxy); return proxy
  }
  function indexMaps(value: object) {
    return new Proxy(value, { get(target, key, receiver) {
      const map = Reflect.get(target, key, receiver)
      if (!(map instanceof Map)) return map
      const cache = objects.get(map) ?? new Map(); objects.set(map, cache)
      if (!cache.has('index-map')) cache.set('index-map', new Proxy(map, { get(target, key) {
        const method = Reflect.get(target, key, target)
        if (['get', 'has'].includes(String(key))) return (...args: unknown[]) => { counts.indexLookups++; return method.apply(target, args) }
        if (['entries', 'values', 'keys'].includes(String(key)) || key === Symbol.iterator) return (...args: unknown[]) => {
          const original = method.apply(target, args)
          return { next() { const next = original.next(); if (!next.done) counts.cachedIndexEntries++; return next }, [Symbol.iterator]() { return this } }
        }
        if (key === 'forEach') return (callback: (value: unknown, key: unknown, map: Map<unknown, unknown>) => void, thisArg?: unknown) => target.forEach((value, key) => { counts.cachedIndexEntries++; callback.call(thisArg, value, key, target) })
        return typeof method === 'function' ? method.bind(target) : method
      } }))
      return cache.get('index-map')
    } })
  }
  return { counts, counted, inputs, indexMaps, reset() { for (const key of Object.keys(counts)) counts[key as keyof typeof counts] = 0 }, snapshot() { return { ...counts } } }
})

// Transparent, identity-stable observation of the actual production exports.
// The originals compute every result; no lane, menu or semantic result is mocked.
vi.mock('../src/renderer/src/lib/focus-collection-lanes', async importOriginal => {
  const original = await importOriginal<typeof import('../src/renderer/src/lib/focus-collection-lanes')>()
  const builder = Reflect.get(original, 'createFocusCollectionIndex')
  const projector = Reflect.get(original, 'projectFocusCollectionLanes')
  return { ...original, deriveFocusCollectionLanes(...args: Parameters<typeof original.deriveFocusCollectionLanes>) {
    observed.counts.derive++; return original.deriveFocusCollectionLanes(args[0], observed.inputs(args[1]), observed.inputs(args[2], true))
  }, ...(typeof builder === 'function' ? { createFocusCollectionIndex(catalog: object, content: object) {
    observed.counts.index++; return observed.indexMaps(builder(observed.inputs(catalog), observed.inputs(content, true)))
  } } : {}), ...(typeof projector === 'function' ? { projectFocusCollectionLanes(...args: unknown[]) { observed.counts.project++; return projector(...args) } } : {}) }
})
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))

const initial = useAppStore.getState(), selected = vi.fn()
let root: Root, host: HTMLDivElement, topics: ScratchTopicSnapshot[], categories: TopicCategory[], config: AppConfig
const reads = () => observed.counts.zones + observed.counts.spaces + observed.counts.bindings + observed.counts.categories + observed.counts.bindingEntries + observed.counts.cachedIndexEntries
const card = (id: string) => host.querySelector<HTMLButtonElement>(`button.focus-context[data-session-id="${id}"]`)
const lane = (id: string) => card(id)!.closest<HTMLElement>('.focus-project-lanes__row')!
const source = (topic: ScratchTopicSnapshot) => { const spaceId = directoryIdentity('local', topic.identityDirectoryPath ?? topic.directoryPath); return { spaceId, zoneId: homeZoneId(spaceId) } }
function seed(noise: number) {
  const category = (id: string): TopicCategory => { const directoryPath = fixturePath(`cost-category-${id}`); return { categoryId: id, hostId: 'local', directoryPath, title: `Category ${id}`, revision: 'original', spaceId: directoryIdentity('local', directoryPath) } }
  categories = [...Array.from({ length: noise }, (_, index) => category(`noise-${index}`)), category('alpha'), category('beta')]
  topics = [...Array.from({ length: noise }, (_, index) => ({ ...moteTopic(`launcher:cost-noise-${index}`, `Independent Topic ${index}`, false), kind: 'topic' as const })),
    ...['alpha', 'beta'].map(id => ({ ...moteTopic(`launcher:cost-${id}`, `${id} Topic`, false), kind: 'topic' as const }))]
  const bindings: SpaceZoneBindings = {}
  for (const [index, topic] of topics.entries()) { const original = source(topic), category = categories[index]!
    bindings[original.zoneId] = { ...original, workspaceId: scratchWorkspace.id, topicId: topic.id, directoryPath: topic.directoryPath, contentKind: 'topic', relations: { [category.spaceId]: true },
      resource: { kind: 'home', hostId: 'local', directoryPath: topic.directoryPath, branch: null } }
  }
  const sessions: SessionSnapshot[] = ['alpha', 'beta'].map(id => { const base = composerSession(id), topic = topics.find(topic => topic.id === `launcher:cost-${id}`)!, status = { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() }
    return { ...base, label: `Task ${id}`, workspacePath: topic.directoryPath, status, semanticStatus: { ...status, stateEnteredAt: Date.now() - 1000 } }
  })
  sessions.push(composerSession('outside-board'), { ...composerSession('outside-terminal'), kind: 'terminal', providerId: null,
    control: { kind: 'terminal', hostId: 'local', runId: 'cost-original-terminal-run', run: { runId: 'cost-original-terminal-run' } } })
  const tab = { ...createWorkbenchTab('cost-original-tab', { kind: 'agent', phase: 'attached', regionId: 'cost-original-region', workspaceId: scratchWorkspace.id, sessionId: 'alpha' }), topicId: topics.at(-2)!.id, space: source(topics.at(-2)!) }
  config = { ...composerConfig, workspaces: [scratchWorkspace, composerConfig.workspaces[0]!], focus: { topicPresentation: 'cards', recentActivityHours: 48 } }
  useAppStore.setState({ ...initial, loading: false, config, sessions, topicCategories: observed.counted(categories, 'menuCategories'), spaceZoneBindings: bindings,
    scratchTopicSnapshots: { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), revision: 1, topics, error: null, reading: false } },
    tabs: { [tab.id]: tab }, layouts: { [scratchWorkspace.id]: createWorkspaceLayout('cost-original-group', [tab.id]), [composerConfig.workspaces[0]!.id]: createWorkspaceLayout('cost-project-group', []) },
    mainSurface: 'agents', focusView: 'list', activeWorkspaceId: composerConfig.workspaces[0]!.id, timelines: {}, agentNames: { alpha: 'Task alpha', beta: 'Task beta' },
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, agentComposerDrafts: { alpha: 'Original unsent draft' } }, true)
}
async function render(visible = true) { await act(async () => root.render(<GlobalFocusSurface visible={visible} currentReference={null} workspaceOpen={false} onSelectContext={selected} />)) }
async function until(predicate: () => boolean) { for (let count = 0; count < 100 && !predicate(); count++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }); expect(predicate()).toBe(true) }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('__agentmuxFocusCostRender', () => observed.counts.renders++)
  observed.reset(); selected.mockClear(); seed(0)
  vi.spyOn(api.workspaces, 'listBranches').mockImplementation(async id => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: config.workspaces.find(workspace => workspace.id === id)?.path ?? fixturePath('unknown') }))
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: null })
  vi.spyOn(api.scratch, 'listTopics').mockImplementation(async () => topics)
  vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); document.getElementById('agentmux-window-overlay-host')?.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each([0, 100, 1000])('hidden original Global Focus avoids full aggregation during separate unrelated updates (%i extra sources)', async noise => {
  seed(noise); await render(); expect(card('alpha')).toBeTruthy(); expect(card('beta')).toBeTruthy()
  expect(reads()).toBeGreaterThan(0); expect(observed.counts.derive + observed.counts.index).toBeGreaterThan(0); expect(observed.counts.renders).toBeGreaterThan(0)
  console.log('FOCUS_COST ' + JSON.stringify({ phase: 'initial-index', noise, counts: observed.snapshot() }))
  const original = useAppStore.getState(), draft = original.agentComposerDrafts
  const readers = [vi.spyOn(api.sessions, 'historyPage'), vi.spyOn(api.sessions, 'timeline'), vi.spyOn(api.sessions, 'historySources'), vi.spyOn(api.conversation, 'readAgentConversation')]
  const readerCounts = readers.map(spy => spy.mock.calls.length)
  const controls = [vi.spyOn(api.sessions, 'stop'), vi.spyOn(api.sessions, 'launchAgent'), vi.spyOn(api.sessions, 'write')]
  await render(false)
  const updates = [
    () => useAppStore.setState(state => ({ tabs: { ...state.tabs, unrelated: createWorkbenchTab('unrelated', { kind: 'file', regionId: 'unrelated-file', workspaceId: composerConfig.workspaces[0]!.id, path: 'other.txt' }) } })),
    () => useAppStore.setState(state => ({ layouts: { ...state.layouts, [composerConfig.workspaces[0]!.id]: createWorkspaceLayout('unrelated-new-group', ['unrelated']) } })),
    () => {
      const directoryPath = fixturePath('new-independent-category'), category = { ...categories[0]!, categoryId: 'new-independent', title: 'Independent discovery', directoryPath, spaceId: directoryIdentity('local', directoryPath) }
      const topic = { ...moteTopic('launcher:cost-added-independent', 'New independent directory', false), kind: 'topic' as const }, original = source(topic)
      useAppStore.setState(state => ({ topicCategories: observed.counted([...state.topicCategories, category], 'menuCategories'),
        scratchTopicSnapshots: { ...state.scratchTopicSnapshots, [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), revision: 2, topics: [...topics, topic], error: null, reading: false } },
        spaceZoneBindings: { ...state.spaceZoneBindings, [original.zoneId]: { ...original, workspaceId: scratchWorkspace.id, topicId: topic.id, directoryPath: topic.directoryPath, contentKind: 'topic', relations: { [category.spaceId]: true }, resource: { kind: 'home', hostId: 'local', directoryPath: topic.directoryPath, branch: null } } } }))
    }
  ]
  for (const [index, update] of updates.entries()) { observed.reset(); await act(async () => update()); const counts = observed.snapshot(); console.log('FOCUS_COST ' + JSON.stringify({ phase: 'hidden', noise, update: index, counts })); expect(reads(), JSON.stringify(counts)).toBe(0) }
  expect(useAppStore.getState().sessions).toBe(original.sessions); expect(useAppStore.getState().agentComposerDrafts).toBe(draft)
  expect(useAppStore.getState().agentFocus).toBe(original.agentFocus); expect(useAppStore.getState().activeWorkspaceId).toBe(original.activeWorkspaceId)
  expect(useAppStore.getState().layouts[scratchWorkspace.id]).toBe(original.layouts[scratchWorkspace.id]); expect(selected).not.toHaveBeenCalled()
  expect(readers.map(spy => spy.mock.calls.length)).toEqual(readerCounts); expect(controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0])
  await render(); expect(card('alpha')).toBeTruthy(); expect(useAppStore.getState().tabs['cost-original-tab']).toBe(original.tabs['cost-original-tab'])
})

it.each([0, 100, 1000])('closed real Collection menus avoid per-heading full Category lookup (%i independent Categories)', async noise => {
  seed(noise); await render(); expect(lane('alpha')).not.toBe(lane('beta'))
  observed.reset()
  await act(async () => lane('alpha').querySelector<HTMLButtonElement>('.focus-project-lanes__axis')!.click())
  expect(lane('alpha').dataset.collapsed).toBe('true')
  const counts = observed.snapshot(); console.log('FOCUS_COST ' + JSON.stringify({ phase: 'closed-menus', noise, counts }))
  expect(counts.categoryComparisons).toBe(0)
})

it.each([0, 100, 1000])('visible original Focus ignores separate terminal and filtered-out Session output for aggregation (%i extra sources)', async noise => {
  seed(noise); await render(); await chooseFocusFilter(host, 'project', focusProjectKey('local', scratchWorkspace.id))
  expect(card('alpha')).toBeTruthy(); expect(card('outside-board')).toBeNull()
  const original = card('alpha'), state = useAppStore.getState(), originalTab = state.tabs['cost-original-tab'], drafts = state.agentComposerDrafts
  const readers = [vi.spyOn(api.sessions, 'historyPage'), vi.spyOn(api.sessions, 'timeline'), vi.spyOn(api.sessions, 'historySources'), vi.spyOn(api.conversation, 'readAgentConversation')]
  const readerCounts = readers.map(spy => spy.mock.calls.length)
  const controls = [vi.spyOn(api.sessions, 'stop'), vi.spyOn(api.sessions, 'launchAgent'), vi.spyOn(api.sessions, 'write')]
  for (const id of ['outside-terminal', 'outside-board']) for (let update = 0; update < 2; update++) {
    observed.reset()
    await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === id ? { ...session, latestOutputBytes: session.latestOutputBytes + 1 } : session) })))
    const counts = observed.snapshot(); console.log('FOCUS_COST ' + JSON.stringify({ phase: 'visible-unrelated', noise, id, update, counts }))
    expect(reads(), JSON.stringify(counts)).toBe(0); expect(card('alpha')).toBe(original)
  }
  for (const id of ['outside-terminal', 'outside-board']) expect(useAppStore.getState().sessions.find(session => session.id === id)!.latestOutputBytes).toBe(state.sessions.find(session => session.id === id)!.latestOutputBytes + 2)
  expect(useAppStore.getState().tabs['cost-original-tab']).toBe(originalTab); expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
  expect(readers.map(spy => spy.mock.calls.length)).toEqual(readerCounts); expect(controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0])
})

it.each([0, 100, 1000])('a real local filter inspection rerenders visible Focus while reusing its warm directory index (%i extra sources)', async noise => {
  seed(noise); await render(); expect(reads()).toBeGreaterThan(0)
  const original = card('alpha'), before = useAppStore.getState()
  observed.reset(); await openFocusFilters(host)
  const counts = observed.snapshot(); console.log('FOCUS_COST ' + JSON.stringify({ phase: 'warm-visible-render', noise, counts }))
  expect(counts.renders).toBeGreaterThan(0); expect(counts.project).toBeGreaterThan(0); expect(counts.index).toBe(0); expect(reads()).toBe(0)
  expect(card('alpha')).toBe(original); expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})

it.each([0, 100, 1000])('initial hidden Focus preserves inputs and consumes the latest related metadata on reveal (%i extra sources)', async noise => {
  seed(noise); const before = useAppStore.getState()
  observed.reset(); await render(false); expect(observed.counts.renders).toBeGreaterThan(0); expect(reads()).toBe(0)
  console.log('FOCUS_COST ' + JSON.stringify({ phase: 'initial-hidden', noise, counts: observed.snapshot() }))
  await act(async () => useAppStore.setState(state => ({ topicCategories: observed.counted(state.topicCategories.map(category => category.categoryId === 'alpha' ? { ...category, title: 'Latest original Category' } : category), 'menuCategories') })))
  const nextTopics = topics.map(topic => topic.id === 'launcher:cost-alpha' ? { ...topic, title: 'Latest original Topic' } : topic)
  await act(async () => useAppStore.setState({ scratchTopicSnapshots: { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), revision: 2, topics: nextTopics, error: null, reading: false } } }))
  expect(reads()).toBe(0); expect(useAppStore.getState().sessions).toBe(before.sessions); expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  observed.reset(); await render(); expect(reads()).toBeGreaterThan(0)
  console.log('FOCUS_COST ' + JSON.stringify({ phase: 'reveal', noise, counts: observed.snapshot() }))
  expect(lane('alpha').querySelector('.focus-project-lanes__axis')?.textContent).toContain('Latest original Category')
  expect(card('alpha')?.querySelector('[data-focus-topic-id]')?.textContent).toBe('Latest original Topic')
})

it.each([0, 100, 1000])('visible Focus with no Topic Context never builds a Collection directory index (%i extra sources)', async noise => {
  seed(noise); useAppStore.setState(state => ({ sessions: state.sessions.filter(session => session.id.startsWith('outside-')) }))
  observed.reset(); await render(); expect(card('outside-board')).toBeTruthy(); expect(observed.counts.renders).toBeGreaterThan(0)
  expect(reads()).toBe(0); expect(observed.counts.index).toBe(0)
  console.log('FOCUS_COST ' + JSON.stringify({ phase: 'no-topic', noise, counts: observed.snapshot() }))
})

it('actual related Agent state, Topic title, Topic membership and Category membership each reach the original consumer', async () => {
  seed(100); await render(); const originalControl = useAppStore.getState().sessions.find(session => session.id === 'alpha')!.control, initialTab = useAppStore.getState().tabs['cost-original-tab'], drafts = useAppStore.getState().agentComposerDrafts
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id !== 'alpha' ? session : { ...session,
    status: { state: 'waiting', source: 'native-hook', observedAt: Date.now() }, semanticStatus: { state: 'waiting', source: 'native-hook', observedAt: Date.now(), stateEnteredAt: Date.now() },
    pendingInteraction: { id: 'cost-original-permission', kind: 'permission', title: 'Original permission request', operation: 'edit' } }) })))
  expect(card('alpha')?.dataset.bucket).toBe('attention'); expect(useAppStore.getState().sessions.find(session => session.id === 'alpha')!.control).toBe(originalControl)
  const original = card('alpha')
  topics = topics.map(topic => topic.id === 'launcher:cost-alpha' ? { ...topic, title: 'Updated original Topic' } : topic)
  await act(async () => useAppStore.setState({ scratchTopicSnapshots: { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), revision: 2, topics, error: null, reading: false } } }))
  expect(card('alpha')?.querySelector('[data-focus-topic-id]')?.textContent).toBe('Updated original Topic')
  expect(card('alpha')).toBe(original)
  const gamma = { ...moteTopic('launcher:cost-gamma', 'Gamma Topic', false), kind: 'topic' as const }, gammaSource = source(gamma), base = composerSession('gamma'), alphaCategory = categories.at(-2)!
  topics = [...topics, gamma]
  await act(async () => useAppStore.setState(state => ({ sessions: [...state.sessions, { ...base, workspacePath: gamma.directoryPath }],
    scratchTopicSnapshots: { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), revision: 3, topics, error: null, reading: false } },
    spaceZoneBindings: { ...state.spaceZoneBindings, [gammaSource.zoneId]: { ...gammaSource, workspaceId: scratchWorkspace.id, topicId: gamma.id, directoryPath: gamma.directoryPath, contentKind: 'topic', relations: { [alphaCategory.spaceId]: true }, resource: { kind: 'home', hostId: 'local', directoryPath: gamma.directoryPath, branch: null } } } })))
  expect(card('gamma')).toBeTruthy(); expect(lane('gamma')).toBe(lane('alpha'))
  expect(lane('alpha').querySelector('.focus-project-lanes__collection-count')?.textContent).toBe('2 Topics · 2 Agents')
  const alphaSource = source(topics.find(topic => topic.id === 'launcher:cost-alpha')!), betaCategory = categories.at(-1)!
  observed.reset()
  await act(async () => useAppStore.setState(state => ({ spaceZoneBindings: { ...state.spaceZoneBindings, [alphaSource.zoneId]: { ...state.spaceZoneBindings[alphaSource.zoneId]!, relations: { [betaCategory.spaceId]: true } } } })))
  expect(lane('alpha')).toBe(lane('beta')); expect(lane('gamma')).not.toBe(lane('alpha')); expect(reads()).toBeGreaterThan(0)
  console.log('FOCUS_COST ' + JSON.stringify({ phase: 'related-membership', noise: 100, counts: observed.snapshot() }))
  expect(useAppStore.getState().tabs['cost-original-tab']).toBe(initialTab); expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
})

it('held reparenting preserves the actual Agent editor, draft, selection and focus until release', async () => {
  seed(100); await render(); const original = card('alpha')!, originalLane = lane('alpha'), drafts = useAppStore.getState().agentComposerDrafts
  await act(async () => { original.focus(); original.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 30, clientY: 30 })) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  const rename = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === 'Rename Agent')!; expect(rename).toBeTruthy()
  await act(async () => rename.click()); await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  const input = host.querySelector<HTMLInputElement>('.focus-context--renaming input')!; expect(input).toBeTruthy()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Original pending name'); input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); input.setSelectionRange(2, 10) })
  const alphaSource = source(topics.find(topic => topic.id === 'launcher:cost-alpha')!)
  await act(async () => useAppStore.setState(state => ({ spaceZoneBindings: { ...state.spaceZoneBindings, [alphaSource.zoneId]: { ...state.spaceZoneBindings[alphaSource.zoneId]!, relations: { [categories.at(-1)!.spaceId]: true } } } })))
  expect(originalLane.contains(input)).toBe(true); expect(host.querySelector('.focus-context--renaming input')).toBe(input)
  expect(input.value).toBe('Original pending name'); expect([input.selectionStart, input.selectionEnd]).toEqual([2, 10]); expect(document.activeElement).toBe(input)
  expect(originalLane.querySelector('[role="status"]')?.textContent).toBe('Update pending')
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })))
  const later = document.createElement('input'); document.body.append(later)
  await act(async () => { later.focus(); document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Tab' })) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  expect(lane('alpha')).toBe(lane('beta')); expect(useAppStore.getState().agentComposerDrafts).toBe(drafts); later.remove()
})

it.each(['permission', 'connection'] as const)('a relevant Agent bucket transition preserves its active rename input, draft, selection and focus (%s)', async kind => {
  seed(0); await render(); const original = card('alpha')!, state = useAppStore.getState()
  await act(async () => { original.focus(); original.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 30, clientY: 30 })) })
  await until(() => Boolean(document.querySelector('.focus-context-menu')))
  const rename = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === 'Rename Agent')!; expect(rename).toBeTruthy()
  await act(async () => rename.click()); await until(() => Boolean(host.querySelector('.focus-context--renaming input')))
  const input = host.querySelector<HTMLInputElement>('.focus-context--renaming input')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Pending through state transition'); input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); input.setSelectionRange(2, 11) })
  const controls = [vi.spyOn(api.sessions, 'respondInteraction'), vi.spyOn(api.sessions, 'stop'), vi.spyOn(api.sessions, 'launchAgent'), vi.spyOn(api.sessions, 'write')]
  const detail = kind === 'permission' ? 'Original permission request' : 'Original Run connection observation failed'
  await act(async () => useAppStore.setState(current => ({ sessions: current.sessions.map(session => session.id !== 'alpha' ? session : kind === 'connection' ? { ...session,
    status: { state: 'disconnected', source: 'run-process', observedAt: Date.now(), detail }, runUnobserved: true, pendingInteraction: undefined } : { ...session,
    status: { state: 'waiting', source: 'native-hook', observedAt: Date.now() }, semanticStatus: { state: 'waiting', source: 'native-hook', observedAt: Date.now(), stateEnteredAt: Date.now() },
    pendingInteraction: { id: 'original-bucket-permission', kind: 'permission', title: 'Original permission request', operation: 'edit' } }) })))
  expect(host.querySelector('.focus-context--renaming input')).toBe(input)
  expect(input.value).toBe('Pending through state transition'); expect([input.selectionStart, input.selectionEnd]).toEqual([2, 11]); expect(document.activeElement).toBe(input)
  expect(useAppStore.getState().agentComposerDrafts).toBe(state.agentComposerDrafts); expect(useAppStore.getState().tabs).toBe(state.tabs)
  const current = useAppStore.getState().sessions.find(session => session.id === 'alpha')!
  expect(current.control).toBe(state.sessions.find(session => session.id === 'alpha')!.control)
  expect(current.pendingInteraction?.id).toBe(kind === 'permission' ? 'original-bucket-permission' : undefined)
  const editor = host.querySelector('.focus-context--renaming')!
  expect(editor.querySelector('[role="status"]')?.textContent).toContain(detail)
  expect(editor.closest('.global-agents-group')?.querySelector('.focus-context-group__pending')?.textContent).toBe('Position held until interaction ends')
  expect(editor.closest('.focus-project-lanes__row')?.querySelector(`.focus-project-lanes__status-rail [data-bucket="${kind === 'permission' ? 'attention' : 'idle'}"] .focus-context-group__count`)?.textContent).toBe('1')
  const openAgent = [...editor.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Open Agent' || button.getAttribute('aria-label') === 'Open Agent')!
  expect(openAgent).toBeTruthy()
  // happy-dom needs explicit focus for Tab's browser default; this invokes the
  // original relatedTarget blur handler, then the original button activation.
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab' })); openAgent.focus() })
  expect(document.activeElement).toBe(openAgent); expect(host.querySelector('.focus-context--renaming input')).toBe(input)
  expect(input.value).toBe('Pending through state transition'); expect([input.selectionStart, input.selectionEnd]).toEqual([2, 11])
  await act(async () => openAgent.click())
  expect(selected).toHaveBeenCalledExactlyOnceWith('alpha', undefined); selected.mockClear()
  expect(useAppStore.getState().sessions.find(session => session.id === 'alpha')!.pendingInteraction).toBe(current.pendingInteraction)
  expect(controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0])
  await act(async () => { input.focus(); input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })) })
  await until(() => Boolean(card('alpha')))
  expect(card('alpha')?.dataset.state).toBe(kind === 'permission' ? 'waiting' : 'disconnected'); expect(card('alpha')?.dataset.bucket).toBe(kind === 'permission' ? 'attention' : 'idle')
  expect(card('alpha')?.textContent).toContain(detail)
  const later = document.createElement('input'); document.body.append(later)
  await act(async () => { later.focus(); document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Tab' })) })
  await until(() => card('alpha')?.closest<HTMLElement>('.global-agents-group')?.dataset.bucket === (kind === 'permission' ? 'attention' : 'idle'))
  expect(lane('alpha').querySelector('.focus-context-group__pending')).toBeNull(); later.remove()
  await act(async () => card('alpha')!.click()); expect(selected).toHaveBeenCalledExactlyOnceWith('alpha', undefined)
})

it('the last original Topic becoming unknown keeps its active editor and healthy original control until release', async () => {
  seed(100); useAppStore.setState(state => ({ sessions: state.sessions.filter(session => session.id !== 'beta') }))
  await render(); const original = card('alpha')!, originalLane = lane('alpha'), originalControl = useAppStore.getState().sessions.find(session => session.id === 'alpha')!.control
  await act(async () => { original.focus(); original.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 30, clientY: 30 })) })
  await until(() => Boolean(document.querySelector('.focus-context-menu')))
  const rename = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === 'Rename Agent')!; expect(rename).toBeTruthy()
  await act(async () => rename.click()); await until(() => Boolean(host.querySelector('.focus-context--renaming input')))
  const input = host.querySelector<HTMLInputElement>('.focus-context--renaming input')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Pending through metadata loss'); input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); input.setSelectionRange(1, 9) })
  topics = topics.map(topic => topic.id === 'launcher:cost-alpha' ? { ...topic, readError: 'Original metadata observation is unconfirmed' } : topic)
  await act(async () => useAppStore.setState(state => ({ scratchTopicSnapshots: { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), revision: 2, topics, error: null, reading: false } },
    sessions: [...state.sessions, { ...composerSession('arrived-after-unknown'), workspacePath: state.sessions.find(session => session.id === 'alpha')!.workspacePath }],
    tabs: { ...state.tabs, 'new-original-tab': { ...createWorkbenchTab('new-original-tab', { kind: 'agent', phase: 'attached', regionId: 'new-original-region', workspaceId: scratchWorkspace.id, sessionId: 'arrived-after-unknown' }), topicId: topics.find(topic => topic.id === 'launcher:cost-alpha')!.id, space: source(topics.find(topic => topic.id === 'launcher:cost-alpha')!) } } })))
  expect(originalLane.contains(input)).toBe(true); expect(host.querySelector('.focus-context--renaming input')).toBe(input)
  expect(input.value).toBe('Pending through metadata loss'); expect([input.selectionStart, input.selectionEnd]).toEqual([1, 9]); expect(document.activeElement).toBe(input)
  expect(card('arrived-after-unknown')).toBeTruthy(); expect(host.querySelectorAll('button.focus-context[data-session-id="arrived-after-unknown"]')).toHaveLength(1)
  expect(lane('arrived-after-unknown')).not.toBe(originalLane); expect(lane('arrived-after-unknown').hasAttribute('data-focus-collection')).toBe(false)
  expect(useAppStore.getState().sessions.find(session => session.id === 'alpha')!.control).toBe(originalControl)
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })))
  const later = document.createElement('input'); document.body.append(later)
  await act(async () => { later.focus(); document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Tab' })) })
  await until(() => Boolean(card('alpha')) && !lane('alpha').hasAttribute('data-focus-collection'))
  expect(lane('alpha')).toBe(lane('arrived-after-unknown')); expect(host.querySelectorAll('button.focus-context[data-session-id="arrived-after-unknown"]')).toHaveLength(1)
  expect(useAppStore.getState().agentComposerDrafts.alpha).toBe('Original unsent draft'); later.remove()
})

it.each([8, 32, 128])('held merging visits Topic entries linearly and preserves original content (%i related Topics)', async width => {
  seed(0)
  const extra = Array.from({ length: width - 1 }, (_, index) => ({ ...moteTopic(`launcher:held-cost-${index}`, `Held Topic ${index}`, false), kind: 'topic' as const, summary: `Original Topic summary ${index}` }))
  topics = [...topics, ...extra]
  const originalAlpha = useAppStore.getState().sessions.find(session => session.id === 'alpha')!
  useAppStore.setState(state => ({
    sessions: [...state.sessions, ...extra.map((topic, index) => ({ ...composerSession(`held-agent-${index}`), workspacePath: topic.directoryPath, status: originalAlpha.status, semanticStatus: originalAlpha.kind === 'agent' ? originalAlpha.semanticStatus : undefined }))],
    scratchTopicSnapshots: { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), revision: 2, topics, error: null, reading: false } },
    topicCategories: observed.counted(categories.map(category => category.categoryId === 'alpha' ? { ...category, readError: 'Original Category diagnostic\nOriginal second diagnostic line' } : category), 'menuCategories'),
    spaceZoneBindings: { ...state.spaceZoneBindings, ...Object.fromEntries(extra.map(topic => { const original = source(topic); return [original.zoneId, { ...original, workspaceId: scratchWorkspace.id, topicId: topic.id, directoryPath: topic.directoryPath, contentKind: 'topic' as const, relations: { [categories[0]!.spaceId]: true }, resource: { kind: 'home' as const, hostId: 'local', directoryPath: topic.directoryPath, branch: null } }] })) }
  }))
  await render(); const originalLane = lane('alpha'), original = card('alpha')!
  expect(originalLane.querySelector('.focus-project-lanes__collection-count')?.textContent).toBe(`${width} Topics · ${width} Agents`)
  await act(async () => { original.focus(); original.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 30, clientY: 30 })) })
  await until(() => Boolean(document.querySelector('.focus-context-menu')))
  const rename = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === 'Rename Agent')!; expect(rename).toBeTruthy()
  await act(async () => rename.click()); await until(() => Boolean(host.querySelector('.focus-context--renaming input')))
  const input = host.querySelector<HTMLInputElement>('.focus-context--renaming input')!
  await act(async () => input.focus())
  const contextIds = new Set(['alpha', ...extra.map((_, index) => `held-agent-${index}`)])
  let topicEntries = 0
  const iterator = Array.prototype[Symbol.iterator]
  const observation = vi.spyOn(Array.prototype, Symbol.iterator).mockImplementation(function (this: unknown[]) {
    const original = iterator.call(this)
    return { next() { const next = original.next(); const value = next.value as { contextRefs?: { hostId: string; id: string }[] } | undefined
      if (!next.done && Array.isArray(value?.contextRefs) && value.contextRefs.some(ref => ref.hostId === 'local' && contextIds.has(ref.id))) topicEntries++
      return next }, [Symbol.iterator]() { return this } }
  })
  try {
    observed.reset()
    await act(async () => useAppStore.setState(state => ({ spaceZoneBindings: Object.fromEntries(Object.entries(state.spaceZoneBindings).map(([id, binding]) => [id, binding.relations?.[categories[0]!.spaceId] ? { ...binding, relations: { [categories[1]!.spaceId]: true } } : binding])) })))
  } finally { observation.mockRestore() }
  console.log('FOCUS_HELD_COST ' + JSON.stringify({ width, topicEntries }))
  expect(topicEntries).toBeGreaterThan(0); expect(topicEntries).toBeLessThanOrEqual(width * 24)
  expect(host.querySelector('.focus-context--renaming input')).toBe(input); expect(originalLane.contains(input)).toBe(true)
  expect(originalLane.querySelector('.focus-project-lanes__collection-count')?.textContent).toBe(`${width} Topics · ${width} Agents`)
  expect(originalLane.querySelector('[role="status"][title*="Original Category diagnostic"]')?.getAttribute('title')).toBe('Category alpha: Original Category diagnostic\nOriginal second diagnostic line')
  for (const [index, topic] of extra.entries()) {
    const rendered = card(`held-agent-${index}`)!; expect(rendered).toBeTruthy(); expect(rendered.closest('.focus-project-lanes__row')).toBe(originalLane)
    expect(host.querySelectorAll(`button.focus-context[data-session-id="held-agent-${index}"]`)).toHaveLength(1)
    expect(rendered.querySelector('[data-focus-topic-id]')?.getAttribute('title')).toBe(`${topic.title}\n${topic.summary}`)
  }
  expect(document.activeElement).toBe(input); expect(useAppStore.getState().agentComposerDrafts.alpha).toBe('Original unsent draft')
})

it('opened actual Category menu performs nonzero guarded lookup and the original clipboard action', async () => {
  seed(100); await render(); const heading = lane('alpha').querySelector<HTMLElement>('.focus-project-lanes__axis')!
  observed.reset()
  await act(async () => { heading.focus(); heading.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, shiftKey: true, key: 'F10' })) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  const menu = document.querySelector<HTMLElement>('[role="menu"]'); expect(menu).toBeTruthy(); expect(observed.counts.categoryComparisons).toBeGreaterThan(0)
  console.log('FOCUS_COST ' + JSON.stringify({ phase: 'opened-menu', noise: 100, counts: observed.snapshot() }))
  const copy = [...menu!.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === 'Copy Category link')!
  expect(copy).toBeTruthy(); await act(async () => copy.click())
  expect(api.ui.writeClipboardText).toHaveBeenCalledExactlyOnceWith(formatSpaceAddress({ spaceId: categories.at(-2)!.spaceId }))
  await until(() => !document.querySelector('[role="menu"]') && document.activeElement === heading)
  await act(async () => heading.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 30, clientY: 30 })))
  await until(() => Boolean(document.querySelector('[role="menu"]')))
  await act(async () => document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })))
  await until(() => !document.querySelector('[role="menu"]') && document.activeElement === heading)
})
