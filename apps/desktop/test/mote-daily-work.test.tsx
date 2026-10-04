import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { chooseField } from './helpers/selection-field'
import { act, createElement } from 'react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDemandStore } from '@agentmux/demand'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { customMoteId, defaultTab, defaultAgent, neighborAgent, customAgent, ordinaryAgent, scratchWorkspace, moteTopics } from './fixtures/mote-workface'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { moteGoalContext, goalsForMote, moteGoalSummary } from '../src/renderer/src/lib/mote-goals'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
vi.mock('../src/renderer/src/components/EditorPane', () => ({ EditorPane: () => createElement('div') }))
let app: MoteAppFixture
const scope = (id = PMO_TEAMS_TOPIC_ID) => ({ workspace: scratchWorkspace, topic: moteTopics.find(item => item.id === id)!, rootPath: scratchTopicDirectoryName(id) })
const goal = (id: string, sessionIds: string[]): DemandRecord => ({ id, title: 'Goal ' + id, description: '', status: 'in_progress', priority: 'normal',
  projectId: null, projectName: null, sessionIds, createdAt: 1, updatedAt: 2, source: 'session' })
const records = () => Object.fromEntries([goal('ours', [defaultAgent.id]), goal('neighbor', [neighborAgent.id]), goal('custom', [customAgent.id]),
  goal('ordinary', [ordinaryAgent.id]), goal('unlinked', [])].map(item => [item.id, item]))
beforeEach(() => {
  app = createMoteApp()
  useAppStore.setState({ demands: records() })
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.continuousProgress, 'goals').mockResolvedValue([])
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
  vi.spyOn(api.files, 'readPublic').mockResolvedValue({ resource: null, result: { status: 'unknown', code: 'PRIVATE_OBSERVATION', message: 'Saved profile unconfirmed.' } })
})
afterEach(async () => { await app.dispose() })
const profile = async () => {
  useAppStore.setState({ toolsOpen: true, explorerCollapsed: { [SCRATCH_WORKSPACE_ID]: false } }); await app.mount()
  const panel = app.container.querySelector<HTMLElement>('[aria-label="This Mote’s work"]')!
  expect(panel).not.toBeNull(); return panel
}
describe('original Mote Goal composition and current-work caller', () => {
  it('includes all own discussions and excludes another Mote, ordinary Topic and unlinked Goal', () => {
    const context = moteGoalContext(useAppStore.getState(), scope())
    expect(context.sessionIds.sort()).toEqual([defaultAgent.id, neighborAgent.id].sort())
    expect(context.selectedSessionId).toBe(defaultAgent.id)
    expect(goalsForMote(records(), context.sessionIds).map(item => item.id).sort()).toEqual(['neighbor', 'ours'])
    expect(goalsForMote(records(), moteGoalContext(useAppStore.getState(), scope(customMoteId)).sessionIds).map(item => item.id)).toEqual(['custom'])
  })
  it('actual Profile keeps durable content-linked results after discussion removal and temporary resource observation loss', async () => {
    const context = moteGoalContext(useAppStore.getState(), scope())
    expect(context.contentRef).not.toBeNull()
    const record = { ...goal('retained-content', ['closed-old-discussion']), contentRefs: [context.contentRef!], status: 'done' as const }
    useAppStore.setState({ demands: { retained: record } })
    const panel = await profile()
    expect(panel.querySelector('[data-mote-goal="retained-content"]')).not.toBeNull()
    const original = useAppStore.getState().config!
    await act(async () => useAppStore.setState({ config: { ...original, workspaces: [] } })); await settleMoteApp()
    expect(panel.textContent).toContain('Goal retained-content')
    expect(useAppStore.getState().demands.retained).toBe(record)
  })
  it('keeps original unplaced and unloaded Agent Region references without choosing an executor', () => {
    useAppStore.setState(state => ({ sessions: state.sessions.filter(item => item.id !== neighborAgent.id),
      layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: { ...state.layouts[SCRATCH_WORKSPACE_ID]!, groups: state.layouts[SCRATCH_WORKSPACE_ID]!.groups.map(group => ({ ...group, tabOrder: group.tabOrder.filter(id => id !== 'neighbor-tab') })) } } }))
    const context = moteGoalContext(useAppStore.getState(), scope(), null)
    expect(context.sessionIds).toContain(neighborAgent.id); expect(context.selectedSessionId).toBeUndefined()
    expect(goalsForMote(records(), context.sessionIds).map(item => item.id)).toContain('neighbor')
  })
  it('does not borrow background selection for a foreign or invalid occurrence', () => {
    const current = useAppStore.getState()
    expect(moteGoalContext(current, scope(), { displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'missing', tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }).selectedSessionId).toBeUndefined()
    expect(moteGoalContext(current, scope(customMoteId)).selectedSessionId).toBeUndefined()
    expect(moteGoalContext(current, { ...scope(), rootPath: 'foreign' }).sessionIds).toEqual([])
    expect(moteGoalContext({ ...current, config: { ...current.config!, workspaces: [{ ...scratchWorkspace, hostId: 'foreign' }] } }, scope()).issue).toContain('unconfirmed')
  })
  it('includes another original Zone only when its actual binding belongs to this Mote, including a cross-Workspace display', () => {
    const leaderSpace = directoryIdentity('local', _hygiene_fixturePath("topics/") + scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID))
    const customSpace = directoryIdentity('local', _hygiene_fixturePath("topics/") + scratchTopicDirectoryName(customMoteId)), customZone = homeZoneId(customSpace)
    useAppStore.setState(state => ({ spaceZoneBindings: { [customZone]: { workspaceId: SCRATCH_WORKSPACE_ID, spaceId: customSpace,
      topicId: customMoteId, contentKind: 'mote', directoryPath: _hygiene_fixturePath("topics/") + scratchTopicDirectoryName(customMoteId), relations: { [leaderSpace]: true } } },
      layouts: { ...state.layouts, project: { ...state.layouts.project!, groups: state.layouts.project!.groups.map(group => ({ ...group, tabOrder: ['custom-tab'], activeTabId: 'custom-tab' })) } } }))
    const context = moteGoalContext(useAppStore.getState(), scope(), { displayWorkspaceId: 'project', groupId: 'project-group', tabId: 'custom-tab', regionId: 'custom-region' })
    expect(context.sessionIds).toContain(customAgent.id); expect(context.selectedSessionId).toBe(customAgent.id)
    expect(context.sessionIds).not.toContain(ordinaryAgent.id)
    expect(goalsForMote(records(), context.sessionIds).map(item => item.id)).toContain('custom')
  })
  it('does not turn idle, host acceptance or a partial report into completed work', () => {
    const record = { ...goal('result', [defaultAgent.id]), alignment: { revision: 1, confirmedAt: 1, summary: 'A real goal', criteria: [{ id: 'c', text: 'Observable result' }], openQuestions: [] },
      activities: [{ id: 'a', kind: 'work', message: 'A first attempt is saved.', actorId: defaultAgent.id, createdAt: 10 }],
      decisions: [{ id: 'd', question: 'How?', decision: 'Check the remaining case.', rationale: '', actorId: null, createdAt: 20 }] }
    expect(moteGoalSummary(record)).toEqual({ next: 'Goal agreed · No result report', detail: 'Check the remaining case.' })
    expect(moteGoalSummary({ ...record, grounding: { alignmentRevision: 1, submissionId: 's', acceptedAt: null, summary: 'Some results remain unknown.', checks: [{ criterionId: 'c', outcome: 'unknown', evidence: [], note: '' }] } })).toEqual({ next: 'Results need checking', detail: 'Some results remain unknown.' })
  })
  it('consumes real Profile rows, expands the original Goal control and preserves Composer inputs', async () => {
    const before = useAppStore.getState().agentComposerDrafts, panel = await profile()
    expect([...panel.querySelectorAll('[data-mote-goal]')].map(item => item.getAttribute('data-mote-goal')).sort()).toEqual(['neighbor', 'ours'])
    await moteClick(panel.querySelector('[data-mote-goal="ours"] .mote-current-work__copy')!)
    expect(panel.querySelector('[aria-label="Goal continuous progress"]')).not.toBeNull()
    expect((panel.querySelector('[aria-label="Goal continuation Agent"]') as HTMLElement).dataset.value).toBe(defaultAgent.id)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before); expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
  })
  it('opens original Goal/results navigation without selecting a foreign Topic or starting an Agent', async () => {
    const tabs = useAppStore.getState().tabs, panel = await profile()
    await moteClick(panel.querySelector('[aria-label="Open goal and results: Goal ours"]')!)
    expect(useAppStore.getState().selectedDemandId).toBe('ours'); expect(useAppStore.getState().mainSurface).toBe('board')
    expect(useAppStore.getState().tabs).toBe(tabs); expect(app.launch).not.toHaveBeenCalled()
  })
  it('retains confirmed rows and unsent inputs when the original Goal read fails', async () => {
    vi.mocked(api.demands.list).mockRejectedValue(new Error('Goal disk temporarily unavailable.'))
    const drafts = useAppStore.getState().agentComposerDrafts, panel = await profile()
    expect(panel.textContent).toContain('Goal disk temporarily unavailable'); expect(panel.querySelector('[data-mote-goal="ours"]')).not.toBeNull()
    expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
  })
  it('keeps an unknown Mote resource visible as last confirmed facts while rejecting new association', async () => {
    const panel = await profile(), original = useAppStore.getState().config!
    await act(async () => useAppStore.setState({ config: { ...original, workspaces: [] } })); await settleMoteApp()
    // The original full App may retain its Mote scope through the durable binding owner.
    expect(useAppStore.getState().demands.ours!.sessionIds).toContain(defaultAgent.id)
    expect(moteGoalContext(useAppStore.getState(), scope()).sessionIds).toEqual([])
    expect(panel.textContent).toContain('Goal ours')
  })
  it('keeps later Goal and discussion choices after the original durable association returns', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mote-current-work-'))
    const owner = openDemandStore({ root: directory })
    let finish!: () => void
    try {
      await owner.create({ id: 'first-real', title: 'First real goal', sessionIds: [defaultAgent.id] })
      await owner.create({ id: 'later-real', title: 'Later real goal', sessionIds: [defaultAgent.id] })
      vi.mocked(api.demands.list).mockImplementation(() => owner.list())
      vi.spyOn(api.demands, 'linkSession').mockImplementation((id, sid) => owner.linkSession(id, sid))
      const pending = new Promise<void>(resolve => { finish = resolve })
      vi.spyOn(api.demands, 'update').mockImplementationOnce(async (id, patch) => { await pending; return owner.update(id, patch) })
      const panel = await profile()
      const select = async (label: string, value: string) => {
        const input = panel.querySelector<HTMLElement>('[aria-label="' + label + '"]')!
        expect(input).not.toBeNull(); await chooseField(input, value)
      }
      await moteClick(panel.querySelector('[aria-label="Choose or create a goal"]')!)
      await select('Goal to associate with this Mote', 'first-real'); await select('Mote discussion for the goal', neighborAgent.id)
      await moteClick([...panel.querySelectorAll('button')].find(item => item.textContent?.startsWith('Link this discussion'))!)
      await select('Goal to associate with this Mote', 'later-real'); await select('Mote discussion for the goal', defaultAgent.id)
      await moteClick(panel.querySelector('[data-mote-goal="later-real"] .mote-current-work__copy')!)
      await act(async () => finish()); await settleMoteApp()
      await expect.poll(async () => (await owner.list()).find(goal => goal.id === 'first-real')!.sessionIds, { timeout: 3000 }).toContain(neighborAgent.id)
      expect(panel.querySelector<HTMLElement>('[aria-label="Goal to associate with this Mote"]')?.dataset.value).toBe('later-real')
      expect(panel.querySelector<HTMLElement>('[aria-label="Mote discussion for the goal"]')?.dataset.value).toBe(defaultAgent.id)
      expect((await owner.list()).find(goal => goal.id === 'first-real')!.sessionIds).toContain(neighborAgent.id)
      expect((await owner.list()).find(goal => goal.id === 'first-real')!.contentRefs).toEqual([moteGoalContext(useAppStore.getState(), scope()).contentRef])
      expect((await owner.list()).find(goal => goal.id === 'later-real')!.sessionIds).toEqual([defaultAgent.id])
      expect(panel.querySelector('[data-mote-goal="later-real"] .mote-current-work__copy')?.getAttribute('aria-expanded')).toBe('true')
      expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
    } finally { finish?.(); await rm(directory, { recursive: true, force: true }) }
  })
  it('does not apply an older cold Goal navigation after Mote A to B to A or later typing', async () => {
    const panel = await profile(), original = useAppStore.getState()
    let finish!: (value: typeof moteTopics) => void
    vi.mocked(api.scratch.listTopics).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await moteClick(panel.querySelector('[aria-label="Open goal and results: Goal ours"]')!)
    await act(async () => { useAppStore.getState().activateTab(SCRATCH_WORKSPACE_ID, 'mote-group', 'custom-tab'); useAppStore.getState().activateTab(SCRATCH_WORKSPACE_ID, 'mote-group', defaultTab.id) })
    await act(async () => finish(moteTopics)); await settleMoteApp()
    expect(useAppStore.getState().mainSurface).toBe('workbench'); expect(useAppStore.getState().selectedDemandId).toBe(original.selectedDemandId)
    expect(useAppStore.getState().agentComposerDrafts).toBe(original.agentComposerDrafts)
  })
})


describe('bounded original Profile current work', () => {
  for (const count of [0, 1, 12, 50]) it(`keeps Profile context reachable with ${count} original Goals and all work accessible`, async () => {
    const goals = Array.from({ length: count }, (_, i) => ({ ...goal('bounded-' + i, [defaultAgent.id]), updatedAt: i,
      status: i === 0 ? 'blocked' as const : i === count - 1 && count > 1 ? 'cancelled' as const : 'in_progress' as const }))
    useAppStore.setState({ demands: Object.fromEntries(goals.map(goal => [goal.id, goal])) })
    const drafts = useAppStore.getState().agentComposerDrafts, panel = await profile()
    expect(panel.querySelectorAll('[data-mote-goal]').length).toBe(Math.min(3, count > 1 ? count - 1 : count))
    expect(app.container.textContent).toContain('Recent ideas'); expect(app.container.textContent).toContain('Behavior')
    if (count) expect(panel.querySelector('[data-mote-goal="bounded-0"]')).not.toBeNull()
    if (count > 3) {
      const all = panel.querySelector<HTMLButtonElement>('.mote-current-work__all')!
      expect(all.textContent).toContain(String(count)); await moteClick(all)
      expect(panel.querySelectorAll('[data-mote-goal]').length).toBe(count)
      await moteClick(panel.querySelector(`[data-mote-goal="bounded-${count - 1}"] .mote-current-work__copy`)!)
      expect(panel.querySelector('[aria-label="Goal continuous progress"]')).not.toBeNull()
      await moteClick(panel.querySelector('.mote-current-work__all')!)
      expect(panel.querySelectorAll('[data-mote-goal]').length).toBe(3)
    }
    expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
  })
})
