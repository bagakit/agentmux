// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
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
import { deriveFocusCollectionLanes } from '../src/renderer/src/lib/focus-collection-lanes'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { formatSessionAddress } from '../src/renderer/src/lib/agent-address'
import type { WorkbenchProjectionSelection } from '../src/renderer/src/lib/workbench-projection'

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
  const lanes = deriveFocusProjectLanes(projection.laneContexts, config, undefined, state.tabs, Date.now(), state.scratchTopicSnapshots)
  return { state, lanes, catalog: spatialCatalog(state, topics), scan: deriveFocusCollectionLanes(lanes, spatialCatalog(state, topics), { bindings: state.spaceZoneBindings, categories: state.topicCategories }) }
}

beforeEach(() => {
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
  useAppStore.setState({ ...initial, loading: false, config, sessions, tabs: { [tab.id]: tab },
    layouts: { [scratchWorkspace.id]: createWorkspaceLayout('original-topic-group', [tab.id]), [project.id]: createWorkspaceLayout('project-group', []) },
    scratchTopicSnapshots: topicSnapshot(), spaceZoneBindings: bindings, topicCategories: categories,
    mainSurface: 'agents', activeWorkspaceId: project.id, timelines: {}, agentNames: Object.fromEntries(sessions.map(session => [session.id, session.label])),
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, agentComposerDrafts: { a1: 'Original unsent input', a2: 'Second original draft' } }, true)
  vi.spyOn(api.workspaces, 'listBranches').mockImplementation(async id => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: config.workspaces.find(workspace => workspace.id === id)?.path ?? fixturePath('unknown') }))
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: null })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(topics)
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
    expect(card(id).querySelector('[data-focus-topic-id]')?.textContent).toBe(topicBy(suffix).title)
    expect(card(id).querySelector('[data-focus-topic-id]')?.getAttribute('data-focus-topic-id')).toBe(topicIdentity(suffix))
    expect(card(id).querySelector('[data-focus-topic-id]')?.getAttribute('title')).toContain(topicBy(suffix).title)
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
  expect(card('a2').querySelector('[data-focus-topic-id]')?.getAttribute('data-focus-topic-id')).toBe(topicIdentity('a'))
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
  const remoteLane: FocusProjectLane = { ...alpha, id: 'exact-remote-topic-lane', hostId: 'remote', workspaceId: 'remote-topics', projectId: 'remote-project', path: remotePath, topicId: 'remote-topic', contextIds: ['remote-agent'], activeAgentIds: ['remote-agent'] }
  const otherCatalog: AgentMuxSpaceCatalog = { ...catalog, spaces: [...catalog.spaces, { spaceId: remote.spaceId, hostId: 'remote', kind: 'container', name: remote.title, directoryPath: remote.directoryPath, projectId: null }],
    zones: [...catalog.zones, { zoneId: remoteZone, workspaceId: remoteLane.workspaceId, hostId: 'remote', kind: 'home', directoryPath: remotePath, branch: null }],
    bindings: [...catalog.bindings, { zoneId: remoteZone, spaceId: remote.spaceId }] }
  const all = deriveFocusCollectionLanes([alpha, remoteLane], otherCatalog, { categories: [...categories, remote], bindings: { ...bindings,
    [remoteZone]: { spaceId: remoteContent, workspaceId: remoteLane.workspaceId, topicId: remoteLane.topicId!, directoryPath: remotePath, contentKind: 'topic', relations: { [remote.spaceId]: true } } } })
  expect(all).toHaveLength(2); expect(all.every(lane => lane.collection?.confirmed)).toBe(true)
  expect(all.map(lane => lane.contextIds)).toEqual([alpha.contextIds, ['remote-agent']])
  const original = source(topicBy('a')), decoyZone = JSON.stringify([original.spaceId, 'display-only'])
  const badBindings = { [decoyZone]: bindings[original.zoneId]! }
  const displayCatalog = { ...catalog, zones: [...catalog.zones, { ...catalog.zones.find(zone => zone.zoneId === original.zoneId)!, zoneId: decoyZone }],
    bindings: catalog.bindings.filter(binding => binding.zoneId !== original.zoneId).concat({ zoneId: decoyZone, spaceId: categories[0]!.spaceId }) }
  const unknown = deriveFocusCollectionLanes([alpha], displayCatalog, { categories, bindings: badBindings })
  expect(unknown).toHaveLength(1); expect(unknown[0]!.collection?.confirmed).toBe(false); expect(unknown[0]!.contextIds).toEqual(alpha.contextIds)
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
