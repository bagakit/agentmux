// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import * as relations from '@agentmux/demand/relations'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
import { api } from '../src/renderer/src/lib/api'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { agentRegionExecution, useAppStore } from '../src/renderer/src/store'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { RegionCurrentDemand } from '../src/renderer/src/components/RegionCurrentDemand'
import { currentDemandIndex, currentDemandKey } from '../src/renderer/src/lib/goal-current-work'
import * as linksOwner from '../src/renderer/src/lib/focus-goal-links'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/contracts'
import { fixturePath } from '../../../test/fixture-values.mjs'

const dom = composerDOM(), workspace = composerConfig.workspaces[0]!
const first = { ...composerSession('shared-session'), label: 'Original Agent', status: { state: 'running' as const, source: 'run-process' as const, observedAt: fixtureEpoch(0, 0, 1) } }
const other = { ...composerSession('remote-presentation'), label: 'Other Host Agent', hostId: 'other-host',
  control: { ...first.control, hostId: 'other-host', agentSessionId: first.control.agentSessionId, run: { runId: 'other-run' } } }
const tab = createWorkbenchTab('original-tab', { kind: 'agent', phase: 'attached', regionId: 'original-region', workspaceId: workspace.id, sessionId: first.id })
const goal = (id: string, extra: Partial<DemandRecord> = {}): DemandRecord => ({ id, title: `Original ${id}`, description: '', status: 'in_progress',
  priority: 'normal', projectId: null, projectName: null, sessionIds: [], source: 'default-topic', createdAt: fixtureEpoch(0, 0, 1), updatedAt: fixtureEpoch(0, 0, 1), ...extra })
const participation = (id: string, hostId = 'local', kind: 'create' | 'discussion' | 'requirements' = 'discussion', agentSessionId = first.control.agentSessionId) => ({
  id, operationId: id, hostId, agentSessionId, kind, entryPoint: 'original-goal-entry', recordedAt: fixtureEpoch(0, 0, 1) })
const dispatch = { operationId: 'original-dispatch', hostId: 'local', agentSessionId: first.control.agentSessionId, runId: first.control.run.runId,
  execution: 'finite' as const, prompt: 'Original request', stage: 'unknown' as const, preparedAt: fixtureEpoch(0, 0, 1) }
const forbidden = ['readHistory', 'historyPage', 'historyResource', 'launchAgent', 'recover', 'resume', 'stop', 'write', 'interrupt'] as const
const card = (id = first.id) => dom.container.querySelector<HTMLButtonElement>(`.focus-context[data-session-id="${id}"]`)!
const trigger = (id = first.id) => card(id)?.parentElement?.querySelector<HTMLButtonElement>('.focus-goal__trigger')!
const menu = () => document.querySelector<HTMLElement>('.focus-goal__menu')!
async function showSources() { await act(async () => menu().querySelector<HTMLElement>('.focus-goal__references')!.click()) }
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 35)) })
function Scene() {
  const surface = useAppStore(state => state.mainSurface)
  return <><GlobalFocusSurface workspaceOpen={false} />{surface === 'board' ? <GlobalBoardSurface /> : null}</>
}
async function mount() { await dom.render(<Scene />); for (const name of forbidden) vi.mocked(api.sessions[name]).mockClear() }
async function inspect(id = first.id) {
  expect(trigger(id)).not.toBeNull()
  await act(async () => trigger(id).dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
  expect(menu()).not.toBeNull()
}
function unchanged(before: ReturnType<typeof useAppStore.getState>) {
  const after = useAppStore.getState()
  for (const key of ['tabs', 'layouts', 'agentFocus', 'agentComposerDrafts'] as const) expect(after[key]).toBe(before[key])
  for (const name of forbidden) expect(api.sessions[name]).not.toHaveBeenCalled()
}
beforeEach(async () => {
  useAppStore.setState({ config: { ...composerConfig, hosts: [...composerConfig.hosts, { id: 'other-host', kind: 'ssh', label: 'Other Host', hostname: 'fixture.invalid' }] },
    sessions: [first, other], tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('original-group', [tab.id]) },
    agentNames: {}, timelines: Object.fromEntries([first, other].map(session => [session.id, { agentSessionId: session.id, revision: 1, items: [] }])), scratchTopicSnapshots: {}, spaceZoneBindings: {}, spatialRequests: {}, mainSurface: 'agents', demands: {},
    agentFocus: { execution: { sessionId: first.id, history: [] }, pmo: { sessionId: null } }, agentComposerDrafts: { [first.id]: 'Original unsent draft' } })
  vi.spyOn(api.spatial, 'read').mockResolvedValue({ schemaVersion: 1, revision: 1, graph: desktopSpatialGraph(useAppStore.getState(), []) })
  await initializeSpatialControlFixture()
  expect(agentRegionExecution({ tabId: tab.id, regionId: 'original-region', agentSessionId: first.id })?.hostId).toBe('local')
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: workspace.path })
  for (const name of forbidden) vi.spyOn(api.sessions, name)
})

describe('actual Focus Goal relationships', () => {
  it('keeps actual card Goal authority separate when two Hosts share the presentation SID', async () => {
    const remote = { ...other, id: first.id }
    useAppStore.setState({ sessions: [first, remote], demands: { remote: goal('remote', { participations: [participation('remote-record', 'other-host')] }) } })
    await mount()
    const cards = [...dom.container.querySelectorAll<HTMLButtonElement>('.focus-context[data-session-id]')]
    const localCard = cards.find(card => card.getAttribute('aria-label')?.startsWith('Original Agent ·'))!
    const remoteCard = cards.find(card => card.getAttribute('aria-label')?.startsWith('Other Host Agent ·'))!
    expect(localCard).toBeDefined(); expect(remoteCard).toBeDefined()
    expect(localCard.parentElement?.querySelector('.focus-goal__trigger')).toBeNull()
    expect(remoteCard.parentElement?.querySelector('.focus-goal__trigger')).not.toBeNull()
    await act(async () => useAppStore.setState({ demands: { local: goal('local', { participations: [participation('local-record')] }) } }))
    expect([...dom.container.querySelectorAll('.focus-context')].find(card => card.getAttribute('aria-label')?.startsWith('Original Agent ·'))).toBe(localCard)
    expect(localCard.parentElement?.querySelector('.focus-goal__trigger')).not.toBeNull()
    expect(remoteCard.parentElement?.querySelector('.focus-goal__trigger')).toBeNull()
  })
  it('keeps an absent relation slot absent and a historical exact relation readable despite unknown activity', async () => {
    useAppStore.setState({ demands: { closed: goal('closed', { status: 'done', participations: [participation('requirements-record', 'local', 'requirements')] }) } })
    await mount()
    expect(trigger(other.id)).toBeNull(); expect(trigger()?.getAttribute('aria-label')).toBe('1 Goal')
    expect(card().querySelector('button')).toBeNull(); expect(trigger().parentElement).toBe(card().parentElement)
    expect(card().querySelector('.focus-context__copy > .focus-context__detail')).not.toBeNull()
    expect(card().querySelector('.focus-context__identity .focus-context__state')).not.toBeNull()
    const before = useAppStore.getState(); await inspect()
    expect(menu().textContent).toContain('Historical Goal'); expect(menu().textContent).toContain('Requirements')
    await showSources(); expect(menu().textContent).toContain('participation · requirements-record'); expect(menu().textContent).not.toContain('Executing')
    unchanged(before); expect(useAppStore.getState().mainSurface).toBe('agents')
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(menu()).toBeNull()
    await act(async () => trigger().focus()); expect(menu()).not.toBeNull()
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); await settle()
    expect(menu()).toBeNull(); expect(document.activeElement).toBe(trigger()); unchanged(before)
  })

  it('keeps bare roles unknown on both Hosts and merges exact roles only at the original canonical subject', async () => {
    useAppStore.setState({ demands: { mixed: goal('mixed', { sessionIds: [first.id], assigneeSessionIds: [first.id], supervisorSessionId: first.id,
      participations: [participation('create-a', 'local', 'create'), participation('discussion-a')], dispatches: [dispatch] }) } })
    await mount()
    expect(trigger().getAttribute('data-goal-host-unconfirmed')).toBeNull()
    expect(trigger(other.id).getAttribute('data-goal-host-unconfirmed')).toBe('true')
    expect(trigger(other.id).getAttribute('aria-label')).toBe('Possible Goal links · Session Host unconfirmed')
    expect(trigger(other.id).querySelector('.focus-goal__unknown')?.textContent).toBe('?')
    await inspect(); expect(menu().querySelectorAll('[data-goal-id="mixed"]')).toHaveLength(1)
    const exact = menu().querySelector('[data-goal-roles="confirmed"]')!, bare = menu().querySelector('[data-goal-roles="unconfirmed"]')!
    expect(exact).not.toBeNull(); expect(bare).not.toBeNull()
    expect(exact.textContent).toContain('Created with'); expect(exact.textContent).toContain('Execution reference')
    expect(exact.textContent).not.toContain('Assignee'); expect(bare.textContent).toContain('Session Host unconfirmed · Related Session · Assignee · Supervisor')
    expect(bare.textContent).toContain('Supervisor')
    await inspect(other.id)
    expect(menu().querySelector('[data-goal-roles="confirmed"]')).toBeNull()
    expect(menu().querySelector('[data-goal-roles="unconfirmed"]')?.textContent).toBe('Related Session · Assignee · Supervisor')
    expect(menu().textContent?.match(/Session Host unconfirmed/gu)).toHaveLength(1); expect(menu().textContent).not.toContain('discussion-a')
  })

  it('keeps a sole bare role unknown and permits only exact Goal viewing', async () => {
    useAppStore.setState({ sessions: [first], demands: { candidate: goal('candidate', { assigneeSessionIds: [first.id] }) } })
    await mount()
    expect(trigger().querySelector('.focus-goal__unknown')).not.toBeNull()
    const before = useAppStore.getState(); await inspect()
    expect(menu().textContent).toContain('Session Host unconfirmed'); unchanged(before)
    await act(async () => trigger().click()); await settle()
    expect(useAppStore.getState().selectedDemandId).toBe('candidate')
    expect(dom.container.querySelector('[data-goal-detail-id="candidate"]')).not.toBeNull(); unchanged(before)
  })

  it('matches a remote presentation alias through its original control Host and canonical Session', async () => {
    useAppStore.setState({ demands: { remote: goal('remote', { participations: [participation('remote-record', 'other-host')] }) } })
    await mount()
    expect(trigger(other.id)).not.toBeNull()
    expect(trigger()).toBeNull(); expect(trigger(other.id).getAttribute('aria-label')).toBe('1 Goal')
    expect(trigger(other.id).querySelector('.focus-goal__unknown')).toBeNull()
    await inspect(other.id); await showSources()
    expect(menu().textContent).toContain('remote-record'); expect(menu().querySelectorAll('[data-goal-id]')).toHaveLength(1)
  })

  it('counts unique confirmed Goals, preserves all provenance and requires explicit choice among confirmed and possible targets', async () => {
    const demands = { first: goal('first', { participations: [participation('first-create', 'local', 'create'), participation('first-discussion')] }),
      second: goal('second', { status: 'cancelled', participations: [participation('second-requirements', 'local', 'requirements')] }),
      possible: goal('possible', { sessionIds: [first.id] }) }
    useAppStore.setState({ demands }); await mount()
    expect(trigger().querySelector('.focus-goal__count')?.textContent).toBe('2')
    const before = useAppStore.getState(); await act(async () => trigger().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))); await settle()
    expect(useAppStore.getState().mainSurface).toBe('agents'); expect(menu().querySelectorAll('[data-goal-id]')).toHaveLength(3)
    await showSources(); expect(menu().textContent).toContain('first-create'); expect(menu().textContent).toContain('first-discussion')
    expect(menu().textContent).toContain('Possible Goal links'); expect(menu().textContent).toContain('Historical Goal')
    await act(async () => menu().querySelector<HTMLElement>('[data-goal-id="second"]')!.click()); await settle()
    expect(useAppStore.getState().selectedDemandId).toBe('second')
    expect(dom.container.querySelector('[data-goal-detail-id="second"]')).not.toBeNull(); unchanged(before)
    expect(currentDemandIndex(demands).has(currentDemandKey('local', first.id))).toBe(false)
  })

  it('projects business facts once for many cards and retains links and DOM across unrelated bytes, statuses and browser updates', async () => {
    const subjects = Array.from({ length: 48 }, (_, index) => composerSession(`cost-subject-${index}`))
    const demands = Object.fromEntries(subjects.map((session, index) => [`cost-goal-${index}`, goal(`cost-goal-${index}`, {
      participations: [participation(`cost-record-${index}`, 'local', 'discussion', session.control.agentSessionId)] })]))
    const project = vi.spyOn(relations, 'projectDemandRelations'), original = linksOwner.createFocusGoalLinksSelector, outputs: ReadonlyMap<string, linksOwner.FocusGoalLinks>[] = []
    vi.spyOn(linksOwner, 'createFocusGoalLinksSelector').mockImplementation(() => { const select = original(); return (input, active) => {
      const value = select(input, active); outputs.push(value); return value
    } })
    useAppStore.setState({ sessions: subjects, demands, timelines: Object.fromEntries(subjects.map(session => [session.id, { agentSessionId: session.id, revision: 1, items: [] }])) }); await mount()
    expect(dom.container.querySelectorAll('.focus-goal__trigger')).toHaveLength(subjects.length); expect(project).toHaveBeenCalledTimes(subjects.length)
    const held = outputs[outputs.length - 1]!, button = trigger(subjects[0]!.id), originalCard = card(subjects[0]!.id)
    for (let revision = 0; revision < 6; revision++) await act(async () => useAppStore.setState({ sessions: subjects.map((session, index) => ({ ...session,
      latestOutputBytes: revision * 4096, status: { ...session.status, state: index === subjects.length - 1 && revision % 2 ? 'error' : 'running' } })), browserAnnotationsByBrowserId: {} }))
    expect(project).toHaveBeenCalledTimes(subjects.length); expect(outputs[outputs.length - 1]).toBe(held)
    expect(trigger(subjects[0]!.id)).toBe(button); expect(card(subjects[0]!.id)).toBe(originalCard)
    const firstKey = linksOwner.focusGoalCardKey('local', subjects[0]!.id), secondKey = linksOwner.focusGoalCardKey('local', subjects[1]!.id)
    expect(held.get(firstKey)).toBeDefined(); expect(held.get(firstKey)).toBe(outputs[outputs.length - 1]!.get(firstKey))
    const related = held.get(secondKey)
    await act(async () => useAppStore.setState({ demands: { ...demands, 'cost-goal-0': { ...demands['cost-goal-0']!, title: 'Updated original Goal' } } }))
    expect(project).toHaveBeenCalledTimes(subjects.length + 1)
    const changed = outputs[outputs.length - 1]!
    expect(changed.get(secondKey)).toBe(related); expect(changed.get(firstKey)?.items[0]?.title).toBe('Updated original Goal')
    for (const name of forbidden) expect(api.sessions[name]).not.toHaveBeenCalled()
  })

  it('reports a rejected disappearing Goal even after its old control unmounts and keeps the later workface healthy', async () => {
    useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [...state.config!.workspaces,
      { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: fixturePath('scratch-goals'), name: 'Topics', kind: 'folder' }] },
      demands: { original: goal('original', { participations: [participation('original-discussion')] }) } }))
    await mount(); await inspect()
    let finish!: (topics: []) => void
    vi.mocked(api.scratch.listTopics).mockImplementationOnce(() => new Promise<[]>(resolve => { finish = resolve }))
    await act(async () => trigger().click()); expect(finish).toBeDefined()
    await act(async () => useAppStore.setState({ demands: {} }))
    expect(trigger()).toBeNull(); const before = useAppStore.getState()
    await act(async () => finish([])); await settle()
    expect(useAppStore.getState().error).not.toBeNull(); expect(useAppStore.getState().error).toContain('exact Goal')
    expect(useAppStore.getState().mainSurface).toBe('agents'); unchanged(before)
  })

  it('reports the original rejected navigation receipt without repeating an old Goal over a later surface', async () => {
    useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [...state.config!.workspaces,
      { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: fixturePath('scratch-goals'), name: 'Topics', kind: 'folder' }] },
      demands: { original: goal('original', { participations: [participation('original-discussion')] }) } }))
    await mount(); await inspect()
    let finish!: (topics: []) => void
    vi.mocked(api.scratch.listTopics).mockImplementationOnce(() => new Promise<[]>(resolve => { finish = resolve }))
    await act(async () => trigger().click()); expect(finish).toBeDefined()
    await act(async () => useAppStore.getState().setMainSurface('survey'))
    const before = useAppStore.getState(); await act(async () => finish([])); await settle()
    expect(useAppStore.getState().mainSurface).toBe('survey'); expect(useAppStore.getState().error).not.toBeNull(); expect(useAppStore.getState().error).toContain('newer navigation')
    expect(useAppStore.getState().selectedDemandId).toBe(before.selectedDemandId); unchanged(before)
  })

  it('shares the original Region current-Goal navigation feedback without broadening current work to participation', async () => {
    const active = { ...dispatch, stage: 'confirmed' as const, receipt: { kind: 'core-prompt' as const, itemId: `prompt:${dispatch.operationId}`, createdAt: fixtureEpoch(0, 0, 1) } }
    useAppStore.setState({ demands: { current: goal('current', { dispatches: [active] }), discussion: goal('discussion', { participations: [participation('discussion-only')] }) } })
    await dom.render(<RegionCurrentDemand hostId="local" agentSessionId={first.id} />)
    expect(dom.container.textContent).toContain('Original current'); expect(dom.container.textContent).not.toContain('Original discussion')
    const button = dom.container.querySelector<HTMLButtonElement>('button')!
    let finish!: (topics: []) => void
    useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [...state.config!.workspaces,
      { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: fixturePath('scratch-goals'), name: 'Topics', kind: 'folder' }] } }))
    vi.mocked(api.scratch.listTopics).mockImplementationOnce(() => new Promise<[]>(resolve => { finish = resolve }))
    await act(async () => button.click()); expect(finish).toBeDefined()
    await act(async () => useAppStore.setState({ demands: {} }))
    await act(async () => finish([])); await settle()
    expect(useAppStore.getState().error).not.toBeNull(); expect(useAppStore.getState().error).toContain('exact Goal')
    expect(useAppStore.getState().mainSurface).toBe('agents')
  })
})
