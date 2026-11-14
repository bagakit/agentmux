// @vitest-environment happy-dom
import { act, useRef } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
import type { AgentMuxSpaceCatalog, TopicCategory } from '@agentmux/core/control'
import type { AppConfig, ScratchTopicSnapshot, SessionSnapshot } from '../src/shared/contracts'
import { directoryIdentity, homeZoneId, type SpaceZoneBindings } from '../src/shared/space-addresses'
import { UNCLASSIFIED_TOPIC_CATEGORY_ID } from '@agentmux/host/topic-categories'
import { createClientUiRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { moteTopic, scratchWorkspace } from './fixtures/mote-workface'
import { chooseFocusFilter, openFocusFilters } from './fixtures/focus-filter-menu'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { deriveFocusProjectLanes, focusProjectKey, type FocusProjectLane } from '../src/renderer/src/lib/focus-project-lanes'
import { deriveFocusCollectionLanes, filterFocusScanLanes, focusScanOrderKey, focusScanPreferenceKey, type FocusScanLane } from '../src/renderer/src/lib/focus-collection-lanes'
import { focusGroupTaskReference } from '../src/renderer/src/lib/focus-group-reference'
import { useFocusProjectOrder } from '../src/renderer/src/lib/use-focus-project-order'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { formatSessionAddress } from '../src/renderer/src/lib/agent-address'
import type { WorkbenchProjectionSelection } from '../src/renderer/src/lib/workbench-projection'
import { focusCollectionPreferenceKey, parseFocusProjects } from '../src/shared/focus-project-preferences'
import { applyConfigEdit } from '../src/shared/config-edit'

// Only adjacent history-timeline and PTY painting are outside this board proof.
// Global, the actual Store/source joins, grouping, shared cards and menus stay real.
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))

const initial = useAppStore.getState(), select = vi.fn()
let root: Root, host: HTMLDivElement, later: HTMLInputElement
let topics: ScratchTopicSnapshot[], categories: TopicCategory[], bindings: SpaceZoneBindings, config: AppConfig
const topic = (suffix: string, title: string) => ({ ...moteTopic(`launcher:collection-${suffix}`, title, false), kind: 'topic' as const })
const source = (value: ScratchTopicSnapshot, hostId = 'local') => {
  const spaceId = directoryIdentity(hostId, value.identityDirectoryPath ?? value.directoryPath)
  return { spaceId, zoneId: homeZoneId(spaceId) }
}
const category = (id: string, title: string, hostId = 'local'): TopicCategory => {
  const directoryPath = fixturePath(`topics/category--${id}`)
  return { categoryId: id, hostId, directoryPath, title, revision: 'original-category-revision', spaceId: directoryIdentity(hostId, directoryPath) }
}
const topicBy = (suffix: string) => topics.find(value => value.id === `launcher:collection-${suffix}`)!
const topicIdentity = (suffix: string) => JSON.stringify(['local', scratchWorkspace.id, topicBy(suffix).id])
function agent(id: string, value: ScratchTopicSnapshot | null, entered: number, attention = false) {
  const state = attention ? 'waiting' as const : 'working' as const
  const observedAt = Date.now(), status = { state, source: 'native-hook' as const, observedAt }
  return { ...composerSession(id), label: `Task ${id}`, workspacePath: value?.directoryPath ?? composerConfig.workspaces[0]!.path,
    status, semanticStatus: { ...status, stateEnteredAt: entered },
    control: { ...composerSession(id).control, agentSessionId: `canonical-${id}` },
    ...(attention ? { pendingInteraction: { id: `permission-${id}`, kind: 'permission' as const, title: 'Allow editing original file?', operation: 'edit' } } : {}) }
}
function topicSnapshot(values = topics) {
  return { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), revision: 1, topics: values, error: null, reading: false } }
}
const card = (id: string) => host.querySelector<HTMLButtonElement>(`button.focus-context[data-session-id="${id}"]`)!
const rows = () => [...host.querySelectorAll<HTMLElement>('.focus-project-lanes__row[data-lane-id]')]
const laneFor = (id: string) => card(id)?.closest<HTMLElement>('.focus-project-lanes__row')!
const cardsIn = (element: Element) => [...element.querySelectorAll<HTMLElement>('button.focus-context[data-session-id]')].map(element => element.dataset.sessionId)
const mainCards = () => [...host.querySelectorAll<HTMLElement>('.focus-project-lanes__rows button.focus-context[data-session-id]')].map(element => element.dataset.sessionId)
const workingCards = (element: Element) => [...element.querySelectorAll<HTMLElement>('.focus-context-group[data-bucket="working"] button.focus-context')].map(element => element.dataset.sessionId)
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
async function render(reference: WorkbenchProjectionSelection | null = null, visible = true) {
  await act(async () => root.render(<GlobalFocusSurface currentReference={reference} visible={visible} workspaceOpen={false} onSelectContext={select} />))
}
async function mode(value: 'cards' | 'sections') {
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, focus: { ...state.config!.focus!, topicPresentation: value } } })))
}
async function search(value: string) {
  const input = host.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!
  expect(input).toBeTruthy()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function menu(id: string) {
  const original = card(id); expect(original).toBeTruthy()
  await act(async () => { original.focus(); original.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 40 })) }); await settle()
  const menu = document.querySelector<HTMLElement>('.focus-context-menu')!
  expect(menu).toBeTruthy(); expect(menu.dataset.agentSessionId).toBe(id)
  return menu
}
function readCollectionLanes() {
  const state = useAppStore.getState(), projection = createFocusProjectionSelector()(state)
  const lanes = deriveFocusProjectLanes(projection.laneContexts, config, undefined, undefined, Date.now(), state.scratchTopicSnapshots)
  return { state, lanes, catalog: spatialCatalog(state, topics), scan: deriveFocusCollectionLanes(lanes, spatialCatalog(state, topics), { bindings: state.spaceZoneBindings, categories: state.topicCategories }) }
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); select.mockClear()
  const base = Date.now() - 10_000
  topics = [topic('a', 'Alpha Topic — original source'), topic('b', 'Beta Topic — original source'), topic('c', 'Multiple C'), topic('d', 'Multiple D'), topic('unknown', 'Unknown classification Topic'), topic('unclassified', 'Confirmed unclassified Topic')]
  categories = [category('11111111-1111-4111-8111-111111111111', 'Research'), category('22222222-2222-4222-8222-222222222222', 'Engineering'), category(UNCLASSIFIED_TOPIC_CATEGORY_ID, '未分类')]
  bindings = {}
  for (const [index, value] of topics.entries()) {
    const original = source(value)
    const members = index < 2 ? [categories[0]!] : index === 2 ? [categories[0]!, categories[1]!] : index === 3 ? [categories[1]!, categories[0]!] : index === 5 ? [categories[2]!] : []
    bindings[original.zoneId] = { spaceId: original.spaceId, workspaceId: scratchWorkspace.id, topicId: value.id, directoryPath: value.directoryPath, contentKind: 'topic',
      relations: Object.fromEntries(members.map(member => [member.spaceId, true])),
      resource: { kind: 'home', hostId: 'local', directoryPath: value.directoryPath, branch: null } }
  }
  const project = composerConfig.workspaces[0]!
  config = { ...composerConfig, workspaces: [scratchWorkspace, project], focus: { recentActivityHours: 48, topicPresentation: 'cards' } }
  const sessions = [agent('a1', topics[0]!, base + 3000), agent('b1', topics[1]!, base + 2000), agent('a2', topics[0]!, base + 1000),
    agent('needs-you', topics[1]!, base + 500, true), agent('c1', topics[2]!, base), agent('d1', topics[3]!, base), agent('unknown', topics[4]!, base), agent('unclassified', topics[5]!, base), agent('project', null, base)]
  const tab = { ...createWorkbenchTab('original-topic-tab', { kind: 'agent', phase: 'attached', regionId: 'original-topic-region', workspaceId: scratchWorkspace.id, sessionId: 'a1' }),
    topicId: topics[0]!.id, space: source(topics[0]!) }
  const projectTab = createWorkbenchTab('original-project-tab', { kind: 'agent', phase: 'attached', regionId: 'project-region', workspaceId: project.id, sessionId: 'project' })
  useAppStore.setState({ ...initial, loading: false, config, sessions, tabs: { [tab.id]: tab, [projectTab.id]: projectTab },
    layouts: { [scratchWorkspace.id]: createWorkspaceLayout('original-topic-group', [tab.id]), [project.id]: createWorkspaceLayout('project-group', [projectTab.id]) },
    scratchTopicSnapshots: topicSnapshot(), spaceZoneBindings: bindings, topicCategories: categories,
    mainSurface: 'agents', activeWorkspaceId: project.id, timelines: {}, agentNames: Object.fromEntries(sessions.map(session => [session.id, session.label])),
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, agentComposerDrafts: { a1: 'Original unsent input', a2: 'Second original draft' } }, true)
  vi.spyOn(api.workspaces, 'listBranches').mockImplementation(async id => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: config.workspaces.find(workspace => workspace.id === id)?.path ?? fixturePath('unknown') }))
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: null })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(topics)
  vi.spyOn(api.spatial, 'read').mockResolvedValue({ schemaVersion: 1, revision: 1, graph: desktopSpatialGraph(useAppStore.getState(), topics) })
  await initializeSpatialControlFixture(topics)
  host = document.createElement('div'); later = document.createElement('input'); later.value = 'Original input and selection'; document.body.append(host, later)
  root = createClientUiRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); later.remove(); document.getElementById('agentmux-window-overlay-host')?.remove()
  useAppStore.setState(initial, true); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('actual Global Focus combines two Topics in one Collection without replacing Agent titles, states or independent Project rows', async () => {
  await render()
  const research = laneFor('a1')
  expect(research).toBeTruthy(); expect(laneFor('b1')).toBe(research); expect(laneFor('a2')).toBe(research)
  expect(research.textContent).toContain('Research'); expect(workingCards(research)).toEqual(['a1', 'b1', 'a2'])
  for (const [id, suffix] of [['a1', 'a'], ['b1', 'b'], ['a2', 'a']] as const) {
    expect(card(id).querySelector('.focus-context__identity strong')?.textContent).toBe(`Task ${id}`)
    expect(card(id).querySelector('[data-focus-topic-id]')).toBeNull()
    expect(card(id).closest('[data-focus-card-key]')!.querySelector('[data-focus-zone-footer] [data-focus-topic-id]')?.textContent).toBe(topicBy(suffix).title)
    expect(card(id).closest('[data-focus-card-key]')!.querySelector('[data-focus-zone-footer] [data-focus-topic-id]')?.getAttribute('data-focus-topic-id')).toBe(topicIdentity(suffix))
    expect(card(id).closest('[data-focus-card-key]')!.querySelector('[data-focus-zone-footer] [data-focus-topic-id]')?.getAttribute('title')).toContain(topicBy(suffix).title)
  }
  expect(card('needs-you').textContent).toContain('Allow editing original file?')
  expect(card('needs-you').dataset.bucket).toBe('attention')
  expect(laneFor('project')).not.toBe(research); expect(card('project').querySelector('[data-focus-topic-id]')).toBeNull()
  expect(research.querySelector('[data-focus-topic-section]')).toBeNull()
  expect(mainCards()).toHaveLength(9); expect(new Set(mainCards()).size).toBe(9)
})

it('sections uses original state order, first-appearance Topic order and stable card owners through mode changes', async () => {
  await render(); const original = new Map(['a1', 'b1', 'a2'].map(id => [id, card(id)]))
  const before = useAppStore.getState(); later.focus(); later.setSelectionRange(2, 8)
  await mode('sections')
  const research = laneFor('a1'), working = research.querySelector('.focus-context-group[data-bucket="working"]')!
  expect(workingCards(research)).toEqual(['a1', 'a2', 'b1'])
  expect([...working.querySelectorAll<HTMLElement>('[data-focus-topic-section]')].map(section => section.dataset.focusTopicSection)).toEqual([topicIdentity('a'), topicIdentity('b')])
  for (const [id, element] of original) expect(card(id)).toBe(element)
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => ({ ...session, latestOutputBytes: session.latestOutputBytes + 50, status: { ...session.status, observedAt: Date.now() } })) })))
  expect(workingCards(research)).toEqual(['a1', 'a2', 'b1'])
  await mode('cards'); expect(workingCards(laneFor('a1'))).toEqual(['a1', 'b1', 'a2'])
  for (const key of ['sessions', 'tabs', 'layouts', 'agentFocus', 'agentComposerDrafts'] as const) if (key !== 'sessions') expect(useAppStore.getState()[key]).toBe(before[key])
  expect(document.activeElement).toBe(later); expect([later.selectionStart, later.selectionEnd]).toEqual([2, 8])
})

it('keeps the actual rename input and original semantic menu target across presentation changes', async () => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await render(); const targetMenu = await menu('a2')
  const rename = [...targetMenu.querySelectorAll<HTMLElement>('[role=menuitem]')].find(item => item.textContent === 'Rename Agent')!
  expect(rename).toBeTruthy(); await act(async () => rename.click()); await settle()
  const input = host.querySelector<HTMLInputElement>('[aria-label="Rename Agent Task a2"]')!
  expect(input).toBeTruthy()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Unsent rename'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await mode('sections'); expect(host.querySelector('[aria-label="Rename Agent Task a2"]')).toBe(input); expect(input.value).toBe('Unsent rename')
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))); await settle()
  await menu('a2'); await mode('cards')
  const keptMenu = document.querySelector<HTMLElement>('.focus-context-menu')!
  expect(keptMenu.dataset.agentSessionId).toBe('a2')
  await act(async () => keptMenu.querySelector<HTMLElement>('[aria-label="Copy Agent Link"]')!.click()); await settle()
  expect(copy).toHaveBeenCalledExactlyOnceWith(formatSessionAddress('canonical-a2'))
  expect(useAppStore.getState().agentComposerDrafts.a2).toBe('Second original draft')
})

it('maps the current exact Topic Region to its Collection while original filtering, Agent selection and Project keys retain their scope', async () => {
  const reference = { displayWorkspaceId: scratchWorkspace.id, groupId: 'original-topic-group', tabId: 'original-topic-tab', regionId: 'original-topic-region' }
  await render(reference)
  const current = rows().filter(row => row.dataset.focusCurrent === 'true')
  expect(current).toHaveLength(1); expect(current[0]).toBe(laneFor('a1'))
  const heading = laneFor('a1').querySelector<HTMLElement>('.focus-project-lanes__axis')!
  expect(heading).toBeTruthy(); await act(async () => heading.click())
  expect(host.querySelector('[aria-label="Remove Project filter"]')).toBeNull(); expect(mainCards()).toHaveLength(9)
  await act(async () => card('b1').click()); expect(select).toHaveBeenLastCalledWith('b1', undefined)
  await search('Task b1'); expect(mainCards()).toEqual(['b1']); await search('')
  await chooseFocusFilter(host, 'state', 'working'); expect(card('needs-you')).toBeNull(); expect(card('a1')).toBeTruthy()
  await chooseFocusFilter(host, 'state', 'all')
  await chooseFocusFilter(host, 'project', focusProjectKey('local', composerConfig.workspaces[0]!.id))
  expect(mainCards()).toEqual(['project']); expect(rows().filter(row => row.dataset.focusCurrent === 'true')).toHaveLength(0)
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBeNull()
})

it('canonicalizes all Category membership without copying cards, and keeps confirmed unclassified distinct from unknown', async () => {
  await render()
  const multiple = laneFor('c1')
  expect(laneFor('d1')).toBe(multiple); expect(multiple.textContent).toContain('Research'); expect(multiple.textContent).toContain('Engineering')
  expect(cardsIn(multiple)).toHaveLength(2); expect(laneFor('unknown')).not.toBe(laneFor('unclassified'))
  expect(laneFor('unclassified').textContent).toContain('未分类')
  const before = useAppStore.getState()
  await act(async () => useAppStore.setState({ topicCategories: [...categories].reverse(), spaceZoneBindings: Object.fromEntries(Object.entries(bindings).map(([zone, binding]) => [zone,
    { ...binding, relations: Object.fromEntries(Object.entries(binding.relations ?? {}).reverse()) }])) }))
  expect(laneFor('c1')).toBe(multiple); expect(laneFor('d1')).toBe(multiple); expect(mainCards()).toHaveLength(9)
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})

it('late Category metadata can resolve unknown presentation without losing original cards, drafts or precise workface identity', async () => {
  useAppStore.setState({ topicCategories: [] })
  await render(); expect(card('a1')).toBeTruthy(); expect(card('a2')).toBeTruthy()
  const before = useAppStore.getState()
  await act(async () => useAppStore.setState({ topicCategories: categories }))
  expect(laneFor('a1')).toBe(laneFor('b1')); expect(laneFor('a1').textContent).toContain('Research')
  for (const key of ['sessions', 'tabs', 'layouts', 'agentFocus', 'agentComposerDrafts'] as const) expect(useAppStore.getState()[key]).toBe(before[key])
})

it('Collection header counts only original Topic members that passed the active filters', async () => {
  await render(); await chooseFocusFilter(host, 'state', 'attention')
  expect(mainCards()).toEqual(['needs-you'])
  const research = laneFor('needs-you')
  expect(research.querySelector('.focus-project-lanes__collection-count')?.textContent).toBe('1 Topic · 1 Agent')
  expect(research.querySelector('.focus-project-lanes__collection')?.getAttribute('aria-label')).toBe('Research · 1 Topic · 1 Agent')
  expect(research.querySelectorAll('[data-focus-topic-id]')).toHaveLength(1)
})

it('counts one exact Topic across its confirmed directory lanes while keeping every original Agent', async () => {
  const alias = fixturePath('confirmed-topic-execution/alpha')
  topics[0] = { ...topics[0]!, confirmedDirectoryPaths: [topics[0]!.directoryPath, alias] }
  useAppStore.setState(state => ({ scratchTopicSnapshots: topicSnapshot(), sessions: state.sessions.map(session => session.id === 'a2' ? { ...session, workspacePath: alias } : session) }))
  await render()
  const research = laneFor('a1')
  expect(laneFor('a2')).toBe(research); expect(laneFor('b1')).toBe(research)
  expect(research.querySelector('.focus-project-lanes__collection-count')?.textContent).toBe('2 Topics · 4 Agents')
  expect(cardsIn(research)).toHaveLength(4); expect(new Set(mainCards()).size).toBe(9)
  expect(card('a2').closest('[data-focus-card-key]')!.querySelector('[data-focus-zone-footer] [data-focus-topic-id]')?.getAttribute('data-focus-topic-id')).toBe(topicIdentity('a'))
  await mode('sections')
  expect(workingCards(laneFor('a1'))).toEqual(['a1', 'a2', 'b1'])
})

it('keeps confirmed membership usable and exposes the original Collection read failure in its real header and tooltip', async () => {
  const issue = 'Original Collection document could not be read'
  categories[0] = { ...categories[0]!, readError: issue }
  useAppStore.setState({ topicCategories: categories })
  await render()
  const research = laneFor('a1'), heading = research.querySelector<HTMLElement>('.focus-project-lanes__heading')!
  expect(laneFor('b1')).toBe(research); expect(cardsIn(research)).toHaveLength(4)
  const service = [...research.querySelectorAll<HTMLElement>('[role=status]')].find(element => element.textContent === 'Details unconfirmed')
  expect(service).toBeTruthy(); expect(service!.title).toContain(issue)
  await act(async () => heading.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))); await settle()
  expect(document.querySelector('.workbench-tab-name-tooltip')?.textContent).toContain(issue)
  expect(document.querySelector('.workbench-tab-name-tooltip')?.textContent).toContain('Research')
  await act(async () => card('a1').click()); expect(select).toHaveBeenLastCalledWith('a1', undefined)
  expect(mainCards()).toHaveLength(9)
})

it('late classification preserves an active Rename and regroups only after the original interaction safely ends', async () => {
  useAppStore.setState({ topicCategories: [] }); await render()
  const unknown = laneFor('a2'), before = useAppStore.getState(), targetMenu = await menu('a2')
  const rename = [...targetMenu.querySelectorAll<HTMLElement>('[role=menuitem]')].find(item => item.textContent === 'Rename Agent')!
  await act(async () => rename.click()); await settle()
  const input = host.querySelector<HTMLInputElement>('[aria-label="Rename Agent Task a2"]')!
  expect(input).toBeTruthy()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Original unfinished rename'); input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); input.setSelectionRange(3, 12) })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await act(async () => useAppStore.setState({ topicCategories: categories }))
  await act(async () => vi.advanceTimersByTime(3100))
  expect(host.querySelector('[aria-label="Rename Agent Task a2"]')).toBe(input)
  expect(input.closest('.focus-project-lanes__row')).toBe(unknown)
  expect(input.value).toBe('Original unfinished rename'); expect(document.activeElement).toBe(input)
  expect([input.selectionStart, input.selectionEnd]).toEqual([3, 12])
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })))
  await act(async () => later.focus())
  await act(async () => vi.advanceTimersByTime(3100))
  expect(host.querySelector('[aria-label="Rename Agent Task a2"]')).toBeNull()
  expect(laneFor('a2')).toBe(laneFor('b1')); expect(laneFor('a2').textContent).toContain('Research')
  expect(laneFor('a2')).not.toBe(laneFor('unknown')); expect(card('a2').textContent).toContain('Task a2')
  expect(document.activeElement).toBe(later)
  for (const key of ['sessions', 'tabs', 'layouts', 'agentFocus', 'agentComposerDrafts'] as const) expect(useAppStore.getState()[key]).toBe(before[key])
})

it('keeps original Survey membership and independent Mote coordination before Collection aggregation', async () => {
  const mote = { ...moteTopic('launcher:collection-mote', 'Original Mote coordination', true), kind: 'mote' as const }
  topics.push(mote)
  const home = source(mote), alpha = source(topicBy('a'))
  useAppStore.setState(state => ({ sessions: [...state.sessions, agent('mote', mote, Date.now())],
    scratchTopicSnapshots: topicSnapshot(), spaceZoneBindings: { ...state.spaceZoneBindings,
      [home.zoneId]: { spaceId: home.spaceId, workspaceId: scratchWorkspace.id, topicId: mote.id, directoryPath: mote.directoryPath,
        contentKind: 'mote', relations: { [categories[0]!.spaceId]: true } } },
    surveyCollectedZones: { [alpha.zoneId]: true, [home.zoneId]: true }, surveyOrganization: { ungrouped: [alpha.zoneId, home.zoneId], groups: [] } }))
  await render()
  expect(card('mote')).toBeNull(); expect(mainCards()).toHaveLength(9)
  const chooseType = async (value: string) => {
    const menu = await openFocusFilters(host)
    await act(async () => menu.querySelector<HTMLElement>('[data-focus-type="all"]')!.click())
    const item = menu.querySelector<HTMLElement>(`[data-focus-type="${value}"]`)
    expect(item).toBeTruthy(); await act(async () => item!.click())
    await act(async () => menu.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })))
  }
  await chooseType('survey')
  expect(mainCards()).toEqual(['mote', 'a1', 'a2']); expect(laneFor('a1').textContent).toContain('Research')
  expect(card('b1')).toBeNull(); expect(card('mote').closest('.focus-coordination-results')).toBeTruthy()
  expect(card('mote').querySelector('[data-focus-topic-id]')).toBeNull()
  await chooseType('mote')
  expect(mainCards()).toEqual(['mote']); expect(card('mote').closest('.focus-coordination-results')).toBeTruthy()
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBeNull()
})

it('the typed source join isolates same-name Hosts and rejects a display Zone masquerading as the original Topic home', () => {
  const { lanes, catalog } = readCollectionLanes(), alpha = lanes.find(lane => lane.topicId === topicBy('a').id)!
  const remote = category('33333333-3333-4333-8333-333333333333', categories[0]!.title, 'remote')
  const remotePath = fixturePath('remote-topics/original'), remoteContent = directoryIdentity('remote', remotePath), remoteZone = homeZoneId(remoteContent)
  const remoteLane: FocusProjectLane = { ...alpha, id: 'exact-remote-topic-lane', hostId: 'remote',  workspaceId: 'remote-topics', projectId: 'remote-project', path: remotePath, topicId: 'remote-topic', contextRefs: (['remote-agent']).map(id => ({ hostId: 'remote', id })), activeAgentRefs: (['remote-agent']).map(id => ({ hostId: 'remote', id })) }
  const otherCatalog: AgentMuxSpaceCatalog = { ...catalog, spaces: [...catalog.spaces, { spaceId: remote.spaceId, hostId: 'remote', kind: 'container', name: remote.title, directoryPath: remote.directoryPath, projectId: null }],
    zones: [...catalog.zones, { zoneId: remoteZone, workspaceId: remoteLane.workspaceId, hostId: 'remote', kind: 'home', directoryPath: remotePath, branch: null }],
    bindings: [...catalog.bindings, { zoneId: remoteZone, spaceId: remote.spaceId }] }
  const all = deriveFocusCollectionLanes([alpha, remoteLane], otherCatalog, { categories: [...categories, remote], bindings: { ...bindings,
    [remoteZone]: { spaceId: remoteContent, workspaceId: remoteLane.workspaceId, topicId: remoteLane.topicId!, directoryPath: remotePath, contentKind: 'topic', relations: { [remote.spaceId]: true } } } })
  expect(all).toHaveLength(2); expect(all.every(lane => lane.collection?.confirmed)).toBe(true)
  expect(all.map(lane => lane.contextRefs)).toEqual([alpha.contextRefs, [{ hostId: 'remote', id: 'remote-agent' }]])
  const original = source(topicBy('a')), decoyZone = JSON.stringify([original.spaceId, 'display-only'])
  const badBindings = { [decoyZone]: bindings[original.zoneId]! }
  const displayCatalog = { ...catalog, zones: [...catalog.zones, { ...catalog.zones.find(zone => zone.zoneId === original.zoneId)!, zoneId: decoyZone }],
    bindings: catalog.bindings.filter(binding => binding.zoneId !== original.zoneId).concat({ zoneId: decoyZone, spaceId: categories[0]!.spaceId }) }
  const unknown = deriveFocusCollectionLanes([alpha], displayCatalog, { categories, bindings: badBindings })
  expect(unknown).toHaveLength(1); expect(unknown[0]!.collection?.confirmed).toBe(false); expect(unknown[0]!.contextRefs).toEqual(alpha.contextRefs)
})

it('closed or unrelated updates add no history/native/terminal reads and retain real card identity', async () => {
  const reads = [vi.spyOn(api.sessions, 'historyPage'), vi.spyOn(api.sessions, 'timeline'), vi.spyOn(api.sessions, 'historySources'), vi.spyOn(api.conversation, 'readAgentConversation')]
  const controls = [vi.spyOn(api.sessions, 'stop'), vi.spyOn(api.sessions, 'launchAgent'), vi.spyOn(api.sessions, 'write')]
  await render(); const original = card('a1'), seen = reads.map(read => read.mock.calls.length)
  const unrelated: SessionSnapshot = { ...composerSession('unrelated-shell'), kind: 'terminal', providerId: null,
    control: { kind: 'terminal', hostId: 'local', runId: 'private-unrelated-shell', run: { runId: 'private-unrelated-shell' } } }
  await act(async () => {
    for (let index = 0; index < 30; index++) useAppStore.setState(state => ({ sessions: [...state.sessions.filter(session => session.id !== unrelated.id), { ...unrelated, latestOutputBytes: index + 1 }] }))
  })
  expect(card('a1')).toBe(original); expect(reads.map(read => read.mock.calls.length)).toEqual(seen)
  await render(null, false)
  const closed = reads.map(read => read.mock.calls.length)
  await mode('sections'); await act(async () => useAppStore.setState({ errorDismissed: true }))
  expect(reads.map(read => read.mock.calls.length)).toEqual(closed); expect(controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0])
})

it('offscreen original pending cards still show their exact Topic without mounting a Reader', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, this.classList.contains('focus-context-group__cards') || this.hasAttribute('data-focus-card-body') ? 5000 : 0, 800, 500)
  })
  const read = vi.spyOn(api.conversation, 'readAgentConversation')
  await render()
  const pending = host.querySelector<HTMLElement>('[data-focus-presentation-session="a1"]')!
  expect(pending).toBeTruthy(); expect(pending.dataset.focusCardBody).toBe('pending')
  expect(pending.querySelector('[data-focus-topic-id]')?.textContent).toBe(topicBy('a').title)
  expect(pending.querySelector('strong')?.textContent).toBe('Task a1'); expect(read).not.toHaveBeenCalled()
})

it('keeps the original Collection discussion chooser while portaled focus defers a confirmed regroup', async () => {
  await render()
  const research = laneFor('a1'), originalCard = card('a1'), before = useAppStore.getState()
  const trigger = research.querySelector<HTMLButtonElement>('[aria-label="Collection preferences · Research"]')!
  expect(trigger).toBeTruthy(); await act(async () => trigger.click()); await settle()
  const panel = document.querySelector<HTMLElement>('[data-focus-project-preferences]')!
  const chooser = panel.querySelector<HTMLButtonElement>('[aria-label^="Choose recipient:"]')!
  expect(chooser).toBeTruthy()
  await act(async () => chooser.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })))
  const recipient = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('新 Agent'))!
  expect(recipient).toBeTruthy(); await act(async () => recipient.focus())
  expect(panel.contains(recipient)).toBe(true) // The submenu keeps this exact discussion host.
  expect(host.contains(recipient)).toBe(false) // Both original menu surfaces remain outside the board.
  const next = Object.fromEntries(Object.entries(bindings).map(([zone, binding]) => [zone,
    binding.topicId === topicBy('a').id || binding.topicId === topicBy('b').id
      ? { ...binding, relations: { [categories[1]!.spaceId]: true } } : binding]))
  await act(async () => useAppStore.setState({ spaceZoneBindings: next }))
  expect(document.querySelector('[data-focus-project-preferences]')).toBe(panel)
  expect(panel.querySelector('[aria-label^="Choose recipient:"]')).toBe(chooser)
  expect(recipient.isConnected).toBe(true)
  expect(document.activeElement).toBe(recipient); expect(card('a1')).toBe(originalCard); expect(laneFor('a1')).toBe(research)
  expect(research.textContent).toContain('Update pending')
  for (const key of ['sessions', 'tabs', 'layouts', 'agentFocus', 'agentComposerDrafts'] as const) expect(useAppStore.getState()[key]).toBe(before[key])
  await act(async () => trigger.click()); await act(async () => { later.focus(); later.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })) }); await settle()
  expect(laneFor('a1')).not.toBe(research); expect(laneFor('a1').textContent).toContain('Engineering')
})

async function independentContainerScene(visible = true, initialIds?: readonly string[]) {
  const at = Date.now() - 20_000, firstProject = composerConfig.workspaces[0]!
  const secondProject = { ...firstProject, id: 'second-project', name: 'Second project', path: fixturePath('second-project') }
  const checkout = { ...firstProject, id: 'project-checkout', path: fixturePath('project-checkout'), repoPath: firstProject.path, branch: 'review' }
  config = { ...config, workspaces: [scratchWorkspace, firstProject, secondProject, checkout], focus: { recentActivityHours: 48 } }
  const originalB = source(topicBy('b')).zoneId
  bindings[originalB] = { ...bindings[originalB]!, relations: { [categories[1]!.spaceId]: true } }
  const sessions = [agent('hot-topic', topicBy('a'), at + 4000), agent('project', null, at + 3000),
    { ...agent('second-project', null, at + 2000), workspacePath: secondProject.path },
    { ...agent('checkout', null, at + 1000), workspacePath: checkout.path }, agent('cold-topic', topicBy('b'), at)]
  const tabs = Object.fromEntries(sessions.map(session => {
    const value = session.id === 'hot-topic' ? topicBy('a') : session.id === 'cold-topic' ? topicBy('b') : null
    const workspace = value ? scratchWorkspace : session.id === 'second-project' ? secondProject : session.id === 'checkout' ? checkout : firstProject
    const tab = { ...createWorkbenchTab('tab-' + session.id, { kind: 'agent', phase: 'attached', regionId: 'region-' + session.id,
      workspaceId: workspace.id, sessionId: session.id }), ...(value ? { topicId: value.id, space: source(value) } : {}) }
    return [tab.id, tab]
  }))
  useAppStore.setState({ config, sessions, tabs, spaceZoneBindings: bindings,
    layouts: Object.fromEntries(config.workspaces.map(workspace => [workspace.id, createWorkspaceLayout('group-' + workspace.id,
      Object.values(tabs).filter(tab => tab.workspaceId === workspace.id).map(tab => tab.id))])),
    agentNames: Object.fromEntries(sessions.map(session => [session.id, session.label])),
    agentComposerDrafts: { 'hot-topic': 'Original Topic draft', project: 'Original project draft' },
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
  vi.mocked(api.spatial.read).mockResolvedValue({ schemaVersion: 1, revision: 1, graph: desktopSpatialGraph(useAppStore.getState(), topics) })
  await initializeSpatialControlFixture(topics)
  // Core still owns every registered Session/Region; only this client's loaded snapshot arrives in parts.
  if (initialIds) useAppStore.setState({ sessions: sessions.filter(session => initialIds.includes(session.id)) })
  await render(null, visible)
  return { at, firstProject, sessions, before: useAppStore.getState() }
}
function containerOrder() {
  return [...host.querySelectorAll<HTMLElement>('.focus-project-lanes__rows > div')].map(frame => {
    const row = frame.querySelector<HTMLElement>('[data-lane-id]')!
    return row.dataset.focusSource === 'collection' ? row.querySelector('.focus-project-lanes__collection strong')!.textContent : row.dataset.projectId
  })
}
async function arrange() {
  const control = host.querySelector<HTMLButtonElement>('[aria-label="Arrange projects by recent activity"]')!
  expect(control).not.toBeNull()
  await act(async () => control.click())
}
function OriginalFocusRoute({ lanes, visible }: { lanes: readonly FocusScanLane[]; visible: boolean }) {
  const rows = useRef<HTMLOListElement>(null), ordered = useFocusProjectOrder(lanes, visible, rows)
  return <ol ref={rows}>{ordered.map(lane => <li key={lane.id} data-original-route-key={focusScanOrderKey(lane)}>{lane.name}</li>)}</ol>
}
const renderedRouteKeys = () => [...new Set([...host.querySelectorAll<HTMLElement>('[data-original-route-key]')].map(element => element.dataset.originalRouteKey))]

it('actual Global activity order keeps cold sibling Collections behind active Projects and changes routes only on Arrange', async () => {
  const { firstProject, before } = await independentContainerScene()
  const expected = ['Research', firstProject.id, 'second-project', 'Engineering']
  expect(containerOrder(), JSON.stringify({ order: containerOrder(), lanes: readCollectionLanes().lanes.map(lane => ({name:lane.name, projectId:lane.projectId, refs:lane.contextRefs})) })).toEqual(expected)
  expect(laneFor('checkout')).toBe(laneFor('project'))
  const bodies = new Map(['hot-topic', 'cold-topic', 'project', 'second-project', 'checkout'].map(id => [id, card(id)]))
  expect([...bodies.values()].every(Boolean)).toBe(true)
  const newer = Date.now() - 1
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'cold-topic' && session.kind === 'agent'
    ? { ...session, semanticStatus: { ...session.semanticStatus!, stateEnteredAt: newer } } : session) })))
  expect(containerOrder()).toEqual(expected)
  expect(laneFor('cold-topic').querySelector('time')?.dateTime).toBe(new Date(newer).toISOString())
  await render(null, false); await render(null, true)
  expect(containerOrder()).toEqual(['Engineering', 'Research', firstProject.id, 'second-project'])
  await arrange()
  expect(containerOrder()).toEqual(['Engineering', 'Research', firstProject.id, 'second-project'])
  for (const [id, body] of bodies) expect(card(id)).toBe(body)
  for (const field of ['tabs', 'layouts', 'agentComposerDrafts', 'agentFocus'] as const) expect(useAppStore.getState()[field]).toBe(before[field])
  expect(useAppStore.getState().sessions.map(session => session.control)).toEqual(before.sessions.map(session => session.control))
})

it('actual Global pins keep their authored Project order without lending that rank to Topics in the same workspace', async () => {
  const { firstProject, before } = await independentContainerScene()
  const pin = (id: string) => ({ key: focusProjectKey('local', id), pinned: true, note: '', color: 'default' as const, collapsed: null })
  // A retained preference for the Topic storage Project must not promote its Collections.
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, focus: { ...state.config!.focus!,
    projects: [pin(scratchWorkspace.id), pin('second-project'), pin(firstProject.id)] } } })))
  expect(containerOrder(), JSON.stringify(containerOrder())).toEqual(['second-project', firstProject.id, 'Research', 'Engineering'])
  await arrange()
  expect(containerOrder()).toEqual(['second-project', firstProject.id, 'Research', 'Engineering'])
  expect(laneFor('checkout')).toBe(laneFor('project'))
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
})

it('actual Global shares Collection and Project pin order and keyboard movement without replacing cards', async () => {
  const { firstProject, before } = await independentContainerScene()
  const key = focusCollectionPreferenceKey('local', [categories[0]!.spaceId])
  const projectPin = { key: focusProjectKey('local', firstProject.id), pinned: true, note: 'Original note', color: 'violet' as const, collapsed: null }
  const collectionPin = { key, pinned: true, note: '', color: 'default' as const, collapsed: null }
  const body = card('hot-topic')
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, focus: { ...state.config!.focus!, projects: [projectPin, collectionPin] } } })))
  expect(containerOrder()).toEqual([firstProject.id, 'Research', 'second-project', 'Engineering'])
  vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => applyConfigEdit(useAppStore.getState().config!, expected!, next))
  const handle = document.querySelector<HTMLButtonElement>('[aria-label="Reorder pinned collection · Research"]')!
  expect(handle).not.toBeNull()
  await act(async () => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true })))
  expect(containerOrder()).toEqual(['Research', firstProject.id, 'second-project', 'Engineering'])
  expect(useAppStore.getState().config?.focus?.projects).toEqual([collectionPin, projectPin])
  await arrange()
  expect(containerOrder()).toEqual(['Research', firstProject.id, 'second-project', 'Engineering'])
  const destination = laneFor('project').parentElement!
  vi.spyOn(destination, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 100, width: 300, height: 100, top: 100, left: 0, right: 300, bottom: 200, toJSON() {} })
  const dataTransfer = new DataTransfer()
  const drag = (type: string) => { const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY: 175 }); Object.defineProperty(event, 'dataTransfer', { value: dataTransfer }); return event }
  await act(async () => handle.dispatchEvent(drag('dragstart')))
  await act(async () => destination.dispatchEvent(drag('dragover')))
  expect(destination.dataset.projectDropTarget).toBe('after')
  await act(async () => destination.dispatchEvent(drag('drop')))
  expect(containerOrder()).toEqual([firstProject.id, 'Research', 'second-project', 'Engineering'])
  expect(useAppStore.getState().config?.focus?.projects).toEqual([projectPin, collectionPin])
  expect(card('hot-topic')).toBe(body)
  for (const field of ['tabs', 'layouts', 'sessions', 'agentComposerDrafts', 'agentFocus'] as const) expect(useAppStore.getState()[field]).toBe(before[field])
})

it('Collection Pin save failure retains its exact draft and Project preferences for explicit retry', async () => {
  const { firstProject } = await independentContainerScene()
  const projectPin = { key: focusProjectKey('local', firstProject.id), pinned: true, note: 'Keep this route', color: 'green' as const, collapsed: false }
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, focus: { ...state.config!.focus!, projects: [projectPin] } } })))
  const save = vi.spyOn(api.config, 'save').mockRejectedValueOnce(Error('Original configuration disk failed'))
    .mockImplementation(async (next, expected) => applyConfigEdit(useAppStore.getState().config!, expected!, next))
  async function press(label: string) {
    const button = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
    expect(button, label).not.toBeNull(); await act(async () => button.click())
  }
  await press('Collection preferences · Research'); await press('Collection appearance')
  const checkbox = document.querySelector<HTMLInputElement>('[aria-label="Pin collection"]')!
  expect(checkbox).not.toBeNull(); await act(async () => checkbox.click())
  expect(document.querySelector('[aria-label="Project note"]')).toBeNull()
  await press('Save collection preferences')
  expect(document.querySelector('[data-focus-project-preferences]')?.textContent).toContain('Original configuration disk failed')
  expect(checkbox.checked).toBe(true); expect(useAppStore.getState().config?.focus?.projects).toEqual([projectPin])
  await press('Save collection preferences')
  expect(save).toHaveBeenCalledTimes(2)
  expect(useAppStore.getState().config?.focus?.projects).toEqual([projectPin, { key: focusCollectionPreferenceKey('local', [categories[0]!.spaceId]), pinned: true, note: '', color: 'default', collapsed: null }])
  expect(document.querySelector('[data-focus-project-preferences]')).toBeNull()
})

it('Collection preference identity retains complete canonical membership and legacy authored values', () => {
  const old = { key: focusProjectKey('local', 'original'), pinned: true, note: 'Original note', color: 'rose' as const, collapsed: false }
  const key = focusCollectionPreferenceKey('local', ['category-b', 'category-a', 'category-b'])
  expect(key).toBe(JSON.stringify(['collection', 'local', ['category-a', 'category-b']]))
  const saved = { ...old, key }
  expect(parseFocusProjects([old, saved])).toEqual([old, saved])
  expect(focusCollectionPreferenceKey('remote', ['category-a', 'category-b'])).not.toBe(key)
  for (const key of [JSON.stringify(['collection', 'local', []]), JSON.stringify(['collection', 'local', ['category-b', 'category-a']]),
    JSON.stringify(['collection', 'local', ['category-a', 'category-a']]), JSON.stringify(['collection', '', ['category-a']]), JSON.stringify(['collection', 'local', 'unknown'])]) {
    expect(() => parseFocusProjects([{ ...old, key }])).toThrow()
  }
  expect(() => parseFocusProjects([old, old])).toThrow()
})

it('actual Global ranks a Collection by minimum member priority and maximum trusted activity from different Topics', async () => {
  const at = Date.now() - 10_000, newer = at + 3000, firstProject = composerConfig.workspaces[0]!
  const idle = { state: 'done' as const, source: 'native-hook' as const, observedAt: Date.now(), stateEnteredAt: newer }
  const sessions = [agent('a1', topicBy('a'), at + 1000), agent('project', null, at + 2000),
    { ...agent('b1', topicBy('b'), newer), status: idle, semanticStatus: idle }]
  const preferences = [{ key: focusProjectKey('local', 'retained-project'), pinned: true, note: 'Retained route', color: 'rose' as const, collapsed: false },
    { key: focusCollectionPreferenceKey('local', [categories[0]!.spaceId]), pinned: false, note: '', color: 'default' as const, collapsed: null }]
  useAppStore.setState({ sessions, config: { ...config, focus: { ...config.focus!, projects: preferences } } })
  await render()
  expect(card('a1').dataset.bucket).toBe('working'); expect(card('b1').dataset.bucket).toBe('idle')
  expect(laneFor('a1')).toBe(laneFor('b1'))
  const scope = laneFor('a1').dataset.focusCollection
  expect(laneFor('a1').querySelector('time')?.dateTime).toBe(new Date(newer).toISOString())
  expect(containerOrder()).toEqual(['Research', firstProject.id])
  const original = [card('a1'), card('b1'), card('project')]
  await arrange()
  expect(containerOrder()).toEqual(['Research', firstProject.id])
  expect([card('a1'), card('b1'), card('project')]).toEqual(original)
  expect(useAppStore.getState().sessions).toBe(sessions)
  await chooseFocusFilter(host, 'state', 'working')
  expect(card('b1')).toBeNull()
  expect(laneFor('a1').dataset.focusCollection).toBe(scope)
  expect(useAppStore.getState().config?.focus?.projects).toBe(preferences)
  expect(laneFor('a1').querySelector('time')?.dateTime).toBe(new Date(newer).toISOString())
  expect(containerOrder()).toEqual(['Research', firstProject.id])
  await chooseFocusFilter(host, 'state', 'all')
  expect(laneFor('a1').querySelector('time')?.dateTime).toBe(new Date(newer).toISOString())
})

it('actual Global first entry ignores a hidden partial arrival route and uses current trusted group activity', async () => {
  const { firstProject, sessions } = await independentContainerScene(false, ['hot-topic'])
  const original = useAppStore.getState().sessions.find(session => session.id === 'hot-topic')!
  expect(original).toBeDefined()
  const newer = Date.now() - 1
  await act(async () => useAppStore.setState({ sessions: sessions.map(session => session.id === 'cold-topic'
    ? { ...session, semanticStatus: { ...session.semanticStatus!, stateEnteredAt: newer } } : session) }))
  const before = useAppStore.getState()
  await render(null, true)
  expect(containerOrder(), JSON.stringify({ order: containerOrder(), shown: mainCards() })).toEqual(['Engineering', 'Research', firstProject.id, 'second-project'])
  // First visibility also confirms the Collection index; that legitimate initial classification may reparent its pending slot.
  expect(card('hot-topic')).not.toBeNull()
  expect(laneFor('hot-topic').textContent).toContain('Research')
  expect(host.querySelectorAll('[data-focus-presentation-session="hot-topic"]')).toHaveLength(1)
  expect(useAppStore.getState().sessions.find(session => session.id === 'hot-topic')).toBe(original)
  for (const field of ['tabs', 'layouts', 'sessions', 'agentComposerDrafts', 'agentSteerQueues', 'agentFocus'] as const) expect(useAppStore.getState()[field]).toBe(before[field])
})

it('the actual route hook does not freeze confirmed partial group facts received while hidden', async () => {
  const { firstProject, sessions } = await independentContainerScene(false, ['hot-topic'])
  const initial = readCollectionLanes().scan
  const research = focusCollectionPreferenceKey('local', [categories[0]!.spaceId])
  expect(initial.map(focusScanOrderKey)).toEqual([research])
  await act(async () => root.render(<OriginalFocusRoute lanes={initial} visible={false} />))
  const original = host.querySelector('[data-original-route-key]')
  const newer = Date.now() - 1
  await act(async () => useAppStore.setState({ sessions: sessions.map(session => session.id === 'cold-topic'
    ? { ...session, semanticStatus: { ...session.semanticStatus!, stateEnteredAt: newer } } : session) }))
  const current = readCollectionLanes().scan
  await act(async () => root.render(<OriginalFocusRoute lanes={current} visible={false} />))
  await act(async () => root.render(<OriginalFocusRoute lanes={current} visible />))
  expect(renderedRouteKeys()).toEqual([focusCollectionPreferenceKey('local', [categories[1]!.spaceId]), research,
    focusProjectKey('local', firstProject.id), focusProjectKey('local', 'second-project')])
  expect([...host.querySelectorAll('[data-original-route-key]')].find(element => element.getAttribute('data-original-route-key') === research)).toBe(original)
})

it('the actual route hook arranges its first confirmed aggregate batch after an empty visible frame', async () => {
  const at = Date.now() - 10_000, idle = { state: 'done' as const, source: 'native-hook' as const, observedAt: Date.now(), stateEnteredAt: at + 3000 }
  useAppStore.setState({ sessions: [agent('a1', topicBy('a'), at + 1000), agent('project', null, at + 2000),
    { ...agent('b1', topicBy('b'), at + 3000), status: idle, semanticStatus: idle }] })
  const lanes = readCollectionLanes().scan, collection = lanes.find(lane => lane.collection)!, project = lanes.find(lane => !lane.collection)!
  expect(lanes).toHaveLength(2); expect(collection.orderPriority).toBe(project.orderPriority)
  expect(collection.lastActivityAt).toBeGreaterThan(project.lastActivityAt!)
  await act(async () => root.render(<OriginalFocusRoute lanes={[]} visible />))
  expect(renderedRouteKeys()).toEqual([])
  await act(async () => root.render(<OriginalFocusRoute lanes={lanes} visible />))
  expect(renderedRouteKeys()).toEqual([focusCollectionPreferenceKey('local', [categories[0]!.spaceId]), focusProjectKey('local', composerConfig.workspaces[0]!.id)])
})

it('the original filtered Collection projection keeps complete Pin and task scope with only displayed presentation references', () => {
  const { state, scan } = readCollectionLanes(), complete = scan.find(lane => lane.collection?.categories.length === 2)!
  expect(complete).toBeDefined()
  const filtered = filterFocusScanLanes([complete], () => true, new Set([JSON.stringify(['local', 'c1'])]))
  expect(filtered).toHaveLength(1)
  const shown = filtered[0]!
  expect(shown.collection?.categories).toBe(complete.collection!.categories)
  expect(focusScanPreferenceKey(shown)).toBe(focusCollectionPreferenceKey('local', categories.slice(0, 2).map(category => category.spaceId)))
  expect(shown.lastActivityAt).toBe(complete.lastActivityAt); expect(shown.orderPriority).toBe(complete.orderPriority)
  const task = focusGroupTaskReference(shown, state.config!.workspaces)
  expect(task.scope).toEqual({ kind: 'collection', hostId: 'local', categorySpaceIds: categories.slice(0, 2).map(category => category.spaceId).sort() })
  expect(task.selection).toEqual({ kind: 'members', references: [{ hostId: 'local', contextId: 'c1' }] })
  expect(shown.collection?.topics.flatMap(topic => topic.contextRefs)).toEqual([{ hostId: 'local', id: 'c1' }])
})

it('actual Global keeps one visible route through filtering and resets only at real reentry without replacing original work', async () => {
  const { firstProject } = await independentContainerScene()
  const reference = { displayWorkspaceId: scratchWorkspace.id, groupId: 'group-' + scratchWorkspace.id, tabId: 'tab-hot-topic', regionId: 'region-hot-topic' }
  await render(reference)
  const expected = ['Research', firstProject.id, 'second-project', 'Engineering'], kept = card('hot-topic')
  const newer = Date.now() - 1
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'cold-topic' && session.kind === 'agent'
    ? { ...session, semanticStatus: { ...session.semanticStatus!, stateEnteredAt: newer } } : session) })))
  expect(containerOrder()).toEqual(expected)
  await search('Task hot-topic'); expect(containerOrder()).toEqual(['Research'])
  await search(''); expect(containerOrder()).toEqual(expected); expect(card('hot-topic')).toBe(kept)
  const bodies = new Map(['hot-topic', 'cold-topic', 'project', 'second-project', 'checkout'].map(id => [id, card(id)]))
  const rows = host.querySelector<HTMLElement>('.focus-project-lanes__rows')!; rows.scrollTop = 73
  const before = useAppStore.getState()
  await render(reference, false); await render(reference, true)
  expect(containerOrder()).toEqual(['Engineering', 'Research', firstProject.id, 'second-project'])
  expect(rows.scrollTop).toBe(73)
  expect(laneFor('hot-topic').dataset.focusCurrent).toBe('true')
  for (const [id, body] of bodies) expect(card(id)).toBe(body)
  for (const field of ['tabs', 'layouts', 'sessions', 'agentComposerDrafts', 'agentSteerQueues', 'agentFocus'] as const) expect(useAppStore.getState()[field]).toBe(before[field])
})
