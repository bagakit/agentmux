// @vitest-environment happy-dom
import { act, Profiler } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { GoalPlanRequest } from '../src/renderer/src/components/GoalPlanRequest'
import { GoalProperties } from '../src/renderer/src/components/GoalProperties'
import type { DemandProjection } from '../src/renderer/src/lib/global-demand-board'
import type { AgentTimelineSnapshot, SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM(), noop = () => {}, canonical = 'original-manager'
const goal = (): DemandProjection => ({ id: 'original-goal', title: 'Original work', description: '', status: 'in_progress', priority: 'normal', projectId: null,
  projectName: null, workspacePath: null, sessions: [], source: 'default-topic', sessionIds: [canonical], assigneeSessionIds: [canonical], supervisorSessionId: canonical, createdAt: 1, updatedAt: 1 })
function session(id: string, actor = canonical, hostId = 'owner-host', runId = 'current-run'): Extract<SessionSnapshot, { kind: 'agent' }> {
  return { ...composerSession(id), hostId, label: 'Original fallback', control: { kind: 'agent', hostId, agentSessionId: actor, run: { runId } } }
}
function watched(count: number) {
  const costs = { sessionReads: 0, timelineWalks: 0, commits: 0 }
  const actual = [session('original-presentation'), ...Array.from({ length: count - 1 }, (_, index) => session('unrelated-' + index, 'other-' + index))]
  const sessions = new Proxy(actual, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/u.test(key)) costs.sessionReads++; return Reflect.get(target, key, receiver) } })
  const raw = [{ id: 'context', kind: 'system', content: 'Original context' }, { id: 'original-message', kind: 'user_message', content: 'Original planning context' }]
  const items = new Proxy(raw, { get(target, key, receiver) { if (key === 'find') costs.timelineWalks++; return Reflect.get(target, key, receiver) } })
  const timeline = { agentSessionId: canonical, revision: 1, items } as unknown as AgentTimelineSnapshot
  return { sessions, timeline, raw, costs, reset() { costs.sessionReads = 0; costs.timelineWalks = 0; costs.commits = 0 } }
}
function seed(record: DemandProjection, sessions: SessionSnapshot[], timeline?: AgentTimelineSnapshot) {
  useAppStore.setState({ sessions, demands: { [record.id]: record }, goalDiscussionRequests: {}, agentNames: {},
    timelines: timeline ? { 'original-presentation': timeline } : {} })
}
async function unrelated() {
  for (let revision = 1; revision <= 4; revision++) await act(async () => useAppStore.setState(state => ({
    timelines: { ...state.timelines, 'unrelated-terminal': { agentSessionId: 'unrelated-terminal', revision, items: [] } as unknown as AgentTimelineSnapshot }
  })))
}
async function openProperties() {
  const details = dom.container.querySelector<HTMLDetailsElement>('.goals-properties')!
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
  expect(details.open).toBe(true); expect(details.querySelector('[aria-label="Goal batch"]')).not.toBeNull()
}
beforeEach(() => {
  vi.spyOn(api.demands, 'onChanged').mockReturnValue(() => {})
  vi.spyOn(api.demands, 'delegation').mockImplementation(async (_method, input) => ({ goalId: input.goalId, goalUpdatedAt: 1, delegations: [], diskDurability: 'confirmed' }))
})

it('the mounted planning request visits no Session inventory or target history on unrelated updates with 1 or 1000 Sessions', async () => {
  const evidence = []
  for (const count of [1, 1000]) {
    const f = watched(count), record = { ...goal(), creationOrigin: { operationId: 'original-create', requesterAsSupervisor: true, requesterParticipationId: 'original-requester', supervisorDefaultPending: false },
      participations: [{ id: 'original-requester', operationId: 'original-create', kind: 'create' as const, agentSessionId: canonical, hostId: 'owner-host', entryPoint: 'goal.create', recordedAt: 1 }] }; seed(record, f.sessions, f.timeline)
    await dom.render(<Profiler id="planning" onRender={() => f.costs.commits++}><GoalPlanRequest demand={record} onRequest={noop} pending={false} busy={false} /></Profiler>)
    expect(dom.container.textContent).toContain('Original planning context')
    f.reset(); await unrelated(); evidence.push({ sessions: count, ...f.costs })
    expect(f.costs).toEqual({ sessionReads: 0, timelineWalks: 0, commits: 0 })
    // A preview may append in place; the original selector's revision still changes its name.
    await act(async () => { f.raw[1]!.content = 'Updated planning context'; f.timeline.revision++
      useAppStore.setState(state => ({ timelines: { ...state.timelines } })) })
    expect(dom.container.textContent).toContain('Updated planning context')
    await act(async () => useAppStore.setState(state => ({ agentNames: { ...state.agentNames, 'original-presentation': 'Explicit original name' } })))
    expect(dom.container.textContent).toContain('Explicit original name')
    await dom.render(<div />)
  }
  if (process.env.GOAL_CONSUMER_COST_EVIDENCE) await (await import('node:fs/promises')).writeFile(process.env.GOAL_CONSUMER_COST_EVIDENCE + '-planning.json', JSON.stringify(evidence, null, 2))
})

it('expanded real Goal properties visit no unrelated inventory or timelines while relevant participant naming still changes', async () => {
  const evidence = []
  for (const count of [1, 1000]) {
    const f = watched(count), record = { ...goal(), participations: [{ id: 'original-source', operationId: 'original-source-op', kind: 'discussion' as const,
      agentSessionId: canonical, hostId: 'owner-host', entryPoint: 'goal.discuss', recordedAt: 1 }] }; seed(record, f.sessions, f.timeline)
    await dom.render(<Profiler id="properties" onRender={() => f.costs.commits++}><GoalProperties demand={record} onUpdate={noop} /></Profiler>)
    await openProperties(); expect(dom.container.textContent).toContain('Original planning context')
    f.reset(); await unrelated(); evidence.push({ sessions: count, ...f.costs })
    expect(f.costs).toEqual({ sessionReads: 0, timelineWalks: 0, commits: 0 })
    await act(async () => { f.raw[1]!.content = 'Changed participant context'; f.timeline.revision++
      useAppStore.setState(state => ({ timelines: { ...state.timelines } })) })
    expect(dom.container.textContent).toContain('Changed participant context')
    await act(async () => useAppStore.setState(state => ({ agentNames: { ...state.agentNames, 'original-presentation': 'Chosen participant name' } })))
    expect(dom.container.textContent).toContain('Chosen participant name')
    expect(dom.container.querySelector<HTMLDetailsElement>('.goals-properties')!.open).toBe(true)
    await dom.render(<div />)
  }
  if (process.env.GOAL_CONSUMER_COST_EVIDENCE) await (await import('node:fs/promises')).writeFile(process.env.GOAL_CONSUMER_COST_EVIDENCE + '-properties.json', JSON.stringify(evidence, null, 2))
})

it('the original planning Host and Run remain exact with cross-Host namesakes and ambiguous presentations', async () => {
  const record = { ...goal(), patrols: [{ purpose: 'plan' as const, planRevision: 0, operationId: 'original-planning', expectedScope: 'frozen-scope', executions: [],
    supervisorAgentSessionId: canonical, context: '{}', requestedBy: { kind: 'user' as const, id: 'original-person' }, requestedAt: 1, attempts: [{
      operationId: 'original-input', actionOperationId: 'original-planning', intentId: 'original-input', preparedAt: 1, agentMuxNote: 'Original planning input',
      target: { agentSessionId: canonical, hostId: 'owner-host', runId: 'old-original-run', providerId: 'codex', workspacePath: '/original' } }] }] }
  const original = session('original-presentation'), namesake = session('other-host-presentation', canonical, 'other-host', 'foreign-run')
  seed(record, [original, namesake]); useAppStore.setState({ agentNames: { 'original-presentation': 'Exact original manager', 'other-host-presentation': 'Unrelated namesake' } })
  await dom.render(<GoalPlanRequest demand={record} onRequest={noop} pending={false} busy={false} />)
  const continuation = () => [...dom.container.querySelectorAll('button')].find(button => button.textContent === 'Continue original planning request')
  expect(dom.container.textContent).toContain('Check request to Exact original manager'); expect(continuation()).toBeDefined()
  await act(async () => useAppStore.setState({ sessions: [{ ...original, control: { ...original.control, run: { runId: 'old-original-run' } } }, namesake] }))
  expect(continuation()).toBeUndefined()
  await act(async () => useAppStore.setState({ sessions: [original, session('second-original-presentation'), namesake] }))
  expect(continuation()).toBeUndefined(); expect(dom.container.textContent).toContain('Check request to original Supervisor')
  await act(async () => useAppStore.setState({ sessions: [namesake] }))
  expect(continuation()).toBeUndefined(); expect(dom.container.textContent).not.toContain('Check request to Unrelated namesake')
})

it('participant names keep accurate Host identity, missing sources and multiple presentations unknown', async () => {
  const record = { ...goal(), participations: [{ id: 'known', operationId: 'known-source', kind: 'discussion' as const, agentSessionId: canonical, hostId: 'owner-host', entryPoint: 'goal.discuss', recordedAt: 1 },
    { id: 'missing', operationId: 'missing-source', kind: 'create' as const, agentSessionId: 'missing-agent', hostId: 'missing-host', entryPoint: 'goal.create', recordedAt: 1 }] }
  const original = session('original-presentation'), namesake = session('other-host-presentation', canonical, 'other-host')
  seed(record, [original, namesake]); useAppStore.setState({ agentNames: { 'original-presentation': 'Exact participant', 'other-host-presentation': 'Other Host name' } })
  await dom.render(<GoalProperties demand={record} onUpdate={noop} />); await openProperties()
  expect(dom.container.textContent).toContain('Exact participant'); expect(dom.container.textContent).not.toContain('Other Host name')
  expect(dom.container.textContent).toContain('missing-agent · missing-host · Presentation unavailable')
  await act(async () => useAppStore.setState({ sessions: [original, session('second-original-presentation'), namesake] }))
  expect(dom.container.textContent).toContain(canonical + ' · owner-host · Presentation unavailable')
})
