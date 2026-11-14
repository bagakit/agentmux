// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { DemandSpaceMemberReference } from '@agentmux/demand/relations'
import { demandAgentReferenceKey } from '@agentmux/demand/relations'
import type { DemandProjection } from '../src/renderer/src/lib/global-demand-board'
import { GoalExecution } from '../src/renderer/src/components/GoalExecution'
import { GoalFiniteStartControl } from '../src/renderer/src/components/GoalFiniteStartControl'
import { GoalPatrolControl } from '../src/renderer/src/components/GoalPatrolControl'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const ref = (runtimeId: string): DemandSpaceMemberReference => ({ kind: 'space-member',
  source: { runtimeId: 'source-B', spaceId: 'source-space', regionId: `region-${runtimeId}`, admission: { kind: 'association', operationId: `L-${runtimeId}` } },
  execution: { runtimeId, agentSessionId: 'namesake-SID' } })
const goal = (): DemandProjection => ({ id: 'qualified-goal', title: 'Original Goal', description: '', status: 'todo', priority: 'normal', projectId: null, projectName: null,
  sessionIds: [ref('runtime-D'), ref('runtime-E')], assigneeSessionIds: [ref('runtime-D'), ref('runtime-E')], supervisorSessionId: ref('runtime-D'),
  createdAt: 1, updatedAt: 1, source: 'default-topic', sessions: [], workspacePath: null })
beforeEach(() => {
  useAppStore.setState({ config: composerConfig, sessions: [composerSession('namesake-SID')], timelines: {}, agentNames: {},
    goalAgentCreationDrafts: {}, goalAgentSelectionDrafts: {}, goalFiniteStartIntents: {}, agentComposerDrafts: { 'namesake-SID': 'Keep original local input' } })
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(() => () => {})
  vi.spyOn(useAppStore.getState(), 'executeControl').mockResolvedValue({ operation: 'demand.show', goalContinuations: [] } as never)
})

it('the real Team and picker retain each Source-qualified relation without borrowing a local namesake or rendering an object', async () => {
  const original = goal(), input = useAppStore.getState().agentComposerDrafts
  const lookup = vi.spyOn(api.sessions, 'historySource')
  const save = vi.fn(async () => false)
  await dom.render(<GoalExecution demand={original} onUpdate={save} />)
  expect(dom.container.textContent).not.toContain('[object Object]')
  expect(dom.container.textContent).toContain('Runtime runtime-D'); expect(dom.container.textContent).toContain('Runtime runtime-E')
  expect(dom.container.querySelectorAll('[data-goal-team-actor]')).toHaveLength(0)
  const groups = [...dom.container.querySelectorAll('[data-goal-team-reference]')]
  expect(groups.map(group => group.getAttribute('data-goal-team-reference'))).toEqual([demandAgentReferenceKey(ref('runtime-D')), demandAgentReferenceKey(ref('runtime-E'))])
  const choose = dom.container.querySelector<HTMLButtonElement>('[aria-label="Choose Goal Supervisor"]')!
  await act(async () => choose.click())
  const rows = [...document.querySelectorAll<HTMLElement>('.goal-agent-picker__row[data-goal-agent-key]')]
  expect(rows).toHaveLength(2)
  expect(rows.filter(row => row.querySelector<HTMLInputElement>('input')?.checked)).toHaveLength(1)
  expect(rows.find(row => row.querySelector<HTMLInputElement>('input')?.checked)?.textContent).toContain('runtime-D')
  expect(document.body.textContent).not.toContain('[object Object]')
  expect(lookup).not.toHaveBeenCalled(); expect(useAppStore.getState().agentComposerDrafts).toBe(input)
  const other = rows.find(row => row.textContent?.includes('runtime-E'))!.querySelector<HTMLInputElement>('input')!
  await act(async () => other.click())
  const submit = document.querySelector<HTMLButtonElement>('.goal-agent-picker button[type="submit"]')!
  await act(async () => submit.click())
  expect(save).toHaveBeenCalledWith({ supervisorSessionId: ref('runtime-E') }, original.updatedAt)
  expect(document.body.textContent).toContain('Relationships are not saved')
  expect(Object.values(useAppStore.getState().goalAgentSelectionDrafts)).toEqual([{goalId:original.id,role:'supervisor',selected:[ref('runtime-E')],expectedUpdatedAt:original.updatedAt}])
  expect(useAppStore.getState().agentComposerDrafts).toBe(input)
})

it('a qualified task without current Source access never uses its UI key or namesake SID as legacy Start', async () => {
  const original = goal(); original.assigneeSessionIds = [ref('runtime-D')]
  const execute = useAppStore.getState().executeControl
  await dom.render(<GoalFiniteStartControl demand={original} />)
  expect(dom.container.textContent).toContain('Runtime runtime-D')
  const start = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.startsWith('Start with'))!
  await act(async () => start.click())
  expect(dom.container.textContent).toContain('original current execution access')
  expect(execute).not.toHaveBeenCalled(); expect(useAppStore.getState().goalFiniteStartIntents).toEqual({})
})

it('a changed qualified Supervisor retains the old patrol original recipient without borrowing a namesake', async () => {
  const original = goal()
  useAppStore.setState({ sessions: [composerSession('namesake-SID'), composerSession('old-manager')], agentNames: { 'old-manager': 'Original manager' } })
  original.patrols = [{ operationId: 'original-patrol', expectedScope: 'original-cut', executions: [], supervisorAgentSessionId: 'old-manager',
    context: 'Original inspection', requestedBy: { kind: 'user', id: 'original-user' }, requestedAt: 1,
    attempts: [{ operationId: 'original-input', actionOperationId: 'original-click', intentId: 'original-intent', agentMuxNote: 'Original context', preparedAt: 1, attemptedAt: 2,
      target: { agentSessionId: 'old-manager', hostId: 'local', runId: 'original-run', providerId: 'codex', workspacePath: '/original' } }] }]
  const lookup = vi.spyOn(api.sessions, 'historySource')
  await dom.render(<GoalPatrolControl demand={original} />)
  expect(dom.container.textContent).toContain('Check original inspection')
  expect(dom.container.textContent).toContain('Open Original manager conversation')
  expect(dom.container.textContent).not.toContain('[object Object]')
  expect(lookup).not.toHaveBeenCalled(); expect(original.patrols[0]!.attempts[0]!.operationId).toBe('original-input')
  expect(useAppStore.getState().executeControl).not.toHaveBeenCalled()
})
