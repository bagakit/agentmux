// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxRpcGoal } from '@agentmux/core'
import { demandAgentReferenceKey, type DemandSpaceMemberReference } from '@agentmux/demand/relations'
import type { DemandProjection } from '../src/renderer/src/lib/global-demand-board'
import { GoalPlanRequest } from '../src/renderer/src/components/GoalPlanRequest'
import { GoalRow } from '../src/renderer/src/components/GoalsCollection'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { MobileGoalActions } from '../../mobile/src/goals/MobileGoalActions'
import { MobileGoalSessions } from '../../mobile/src/goals/MobileGoalSessions'
import { GoalExecution } from '../src/renderer/src/components/GoalExecution'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const qualified: DemandSpaceMemberReference = { kind: 'space-member', source: { runtimeId: 'B', spaceId: 'Space', regionId: 'Region', admission: { kind: 'creation', operationId: 'C' } }, execution: { runtimeId: 'D', agentSessionId: 'same-SID' } }
const raw = demandAgentReferenceKey(qualified)
const goal = (): DemandProjection => ({ id: 'goal', title: 'Original Goal', description: '', status: 'todo', priority: 'normal', projectId: null, projectName: null,
  sessionIds: [raw, qualified], assigneeSessionIds: [raw, qualified], supervisorSessionId: qualified, createdAt: 1, updatedAt: 1, source: 'default-topic', sessions: [], workspacePath: null })
beforeEach(() => {
  useAppStore.setState({ config: composerConfig, sessions: [composerSession('same-SID')], demands: { goal: goal() }, selectedDemandId: null, timelines: {}, agentNames: {}, goalFiniteStartIntents: {} })
  vi.spyOn(api.demands, 'onChanged').mockImplementation(() => () => {})
})

it('real planning and collection views display a qualified reference without selecting a local namesake or sending a planning request', async () => {
  const onRequest = vi.fn()
  await dom.render(<><GoalPlanRequest demand={goal()} onRequest={onRequest} pending={false} busy={false} /><GoalRow demand={goal()} selected={false} selectedSessionId={null} acknowledgementFailed={false} stageChanged={false} onSelect={() => {}} /></>)
  expect(dom.container.textContent).toContain('same-SID @ D')
  expect(dom.container.textContent).not.toContain('[object Object]')
  expect(dom.container.textContent).toContain('2 linked Sessions unconfirmed')
  expect(dom.container.querySelector('[data-goal-plan-request]')).toBeNull()
  expect(onRequest).not.toHaveBeenCalled()
})

it('the real board assignee filter preserves raw and qualified references with disjoint option identities', async () => {
  await dom.render(<GlobalBoardSurface />)
  const filter = dom.container.querySelector<HTMLButtonElement>('[aria-label="Goal filters"]')!
  await act(async () => filter.click())
  const chooser = dom.container.querySelector<HTMLButtonElement>('[aria-label="Filter assignee"]')!
  await act(async () => chooser.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  const options = [...document.querySelectorAll('[role="menuitemradio"]')]
  expect(chooser.getAttribute('aria-expanded')).toBe('true')
  expect(options.some(option => option.textContent?.includes('same-SID @ D'))).toBe(true)
  expect(options.some(option => option.textContent?.includes(raw))).toBe(true)
  expect(options.map(option => option.getAttribute('data-value'))).toContain(demandAgentReferenceKey(raw))
  expect(options.map(option => option.getAttribute('data-value'))).toContain(demandAgentReferenceKey(qualified))
  expect(document.body.textContent).not.toContain('[object Object]')
})

it('real Mobile assignment preserves saved qualified relations while editing raw relations instead of serializing objects into SID inputs', async () => {
  const updated = vi.fn(), forwardRpc = vi.fn(async (method: string, params: unknown) => {
    if (method !== 'goal.assign') throw Error('Unexpected operation: ' + method)
    return { goal: goal(), receipt: {} }
  })
  const client = { forwardRpc } as unknown as AgentMuxHostedClient
  const original: AgentMuxRpcGoal = { ...goal(), assigneeSessionIds: [raw, qualified], supervisorSessionId: qualified, participations: [] }
  await dom.render(<MobileGoalActions client={client} goal={original} visible={false} updated={updated} deleted={() => {}} />)
  const assignee = dom.container.querySelector<HTMLInputElement>('[aria-label="负责人会话 ID"]')!
  expect(assignee.value).toBe(raw)
  expect(dom.container.textContent).toContain('same-SID @ D')
  expect(dom.container.textContent).not.toContain('[object Object]')
  const save = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '保存负责人分配')!
  await act(async () => save.click())
  expect(forwardRpc).toHaveBeenCalledTimes(1)
  expect(forwardRpc.mock.calls[0]?.[1]).toMatchObject({ assigneeSessionIds: [raw, qualified], supervisorSessionId: qualified })
  expect(updated).toHaveBeenCalledTimes(1)
})

it('real Mobile related-session reading keeps a qualified relation visible without reading a local namesake or offering its raw-SID open action', async () => {
  const forwardRpc = vi.fn(), openSession = vi.fn()
  const client = { forwardRpc } as unknown as AgentMuxHostedClient
  const original: AgentMuxRpcGoal = { ...goal(), assigneeSessionIds: [qualified], supervisorSessionId: qualified, participations: [], sessionIds: [qualified] }
  await dom.render(<MobileGoalSessions client={client} sessionIds={original.sessionIds} goal={original} visible openSession={openSession} />)
  expect(dom.container.textContent).toContain('same-SID @ D')
  expect(dom.container.textContent).not.toContain('[object Object]')
  expect([...dom.container.querySelectorAll('button')].some(button => button.textContent?.includes('打开关联会话'))).toBe(false)
  expect(forwardRpc).not.toHaveBeenCalled(); expect(openSession).not.toHaveBeenCalled()
})

it('real Team and Mobile primary summaries abbreviate long identities while retaining every full reference in details and original view keys', async () => {
  const reference: DemandSpaceMemberReference = { ...qualified, source: { ...qualified.source, runtimeId: 'source-runtime-0123456789-abcdef', admission: { kind: 'creation', operationId: 'original-creation-0123456789' } }, execution: { runtimeId: 'execution-runtime-0123456789-abcdef', agentSessionId: 'original-session-0123456789-abcdef' } }
  const original = { ...goal(), sessionIds: [reference], assigneeSessionIds: [reference], supervisorSessionId: reference }
  await dom.render(<WorkbenchPresentationContext.Provider value={{ active: false, retainedRegionId: null }}><GoalExecution demand={original} onUpdate={async () => false} /></WorkbenchPresentationContext.Provider>)
  const group = dom.container.querySelector<HTMLElement>('[data-goal-team-reference]')!
  expect(group.dataset.goalTeamReference).toBe(demandAgentReferenceKey(reference))
  const primary = group.querySelector('.goal-team__unresolved strong')!
  expect(primary.textContent).toContain('…'); expect(primary.textContent!.length).toBeLessThan(reference.execution.agentSessionId.length)
  expect(JSON.parse(group.querySelector('details code')!.textContent!)).toEqual(reference)
  const mobile: AgentMuxRpcGoal = { ...original, participations: [] }
  await dom.render(<MobileGoalActions client={null} goal={mobile} visible={false} updated={() => {}} deleted={() => {}} />)
  const identities = [...dom.container.querySelectorAll('details pre')].map(pre => JSON.parse(pre.textContent!))
  expect(identities).toEqual([reference, reference])
  const firstRole = dom.container.querySelector('details > div > p')
  expect(firstRole).not.toBeNull(); expect(firstRole!.textContent).not.toContain(reference.execution.runtimeId)
})
