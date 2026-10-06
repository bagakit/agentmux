// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Root } from 'react-dom/client'
import { createClientUiRoot } from './helpers/client-ui-render'
import { GoalDetail } from '../src/renderer/src/components/GoalDetail'
import { EMPTY_GOAL_ACKNOWLEDGEMENT } from '../src/renderer/src/components/GoalAlignment'
import type { DemandProjection } from '../src/renderer/src/lib/global-demand-board'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'

let host: HTMLDivElement, root: Root
const decision = { id: 'original-decision', question: 'Which original work should continue?', decision: 'Continue the original Agent',
  rationale: 'Its confirmed work and unsent draft belong to this task.', actorId: 'recorded-author', createdAt: fixtureEpoch(1) }
const goal: DemandProjection = { id: 'original-goal', title: 'Keep the original work', description: '', status: 'todo', priority: 'normal',
  projectId: null, projectName: null, sessionIds: [], createdAt: fixtureEpoch(1), updatedAt: fixtureEpoch(1), source: 'default-topic',
  sessions: [], workspacePath: null, decisions: [decision], activities: [{ id: decision.id, kind: 'note', message: 'An ordinary note with the same local ID.', createdAt: fixtureEpoch(1, 1), actorId: null }] }
async function render(demand = goal) {
  await act(async () => root.render(<GoalDetail demand={demand} onClose={() => {}} onOpenMote={() => {}} onGrill={() => {}} onGrounding={() => {}}
    acknowledgementFeedback={EMPTY_GOAL_ACKNOWLEDGEMENT} onAcknowledgementFeedbackChange={() => {}} moteError={null} onRetryMote={() => {}} />))
}
const activity = () => host.querySelector<HTMLDetailsElement>('.goals-activity')!
const details = () => host.querySelector<HTMLDetailsElement>('.goals-activity__decision')!
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges() })

it('the real GoalDetail renders original decision fields and keeps ordinary activity separate', async () => {
  await render(); expect(activity()).not.toBeNull(); expect(host.querySelectorAll('.goals-activity__row')).toHaveLength(2)
  expect(host.querySelectorAll('.goals-activity__decision')).toHaveLength(1)
  expect(details().dataset.decisionId).toBe(decision.id)
  expect([...details().querySelectorAll('dd')].map(node => node.textContent)).toEqual([decision.question, decision.rationale, decision.actorId])
  expect(details().parentElement!.textContent).toContain(decision.decision)
  expect(host.querySelector('.goals-activity__row')!.textContent).toContain('ordinary note')
  expect(host.querySelector('.goals-activity__row')!.querySelector('.goals-activity__decision')).toBeNull()
})

it('retains original disclosure nodes, expansion and selected text through activity arrival and decision updates', async () => {
  await render(); activity().open = true; details().open = true
  const original = details(), question = original.querySelector('dd')!, range = document.createRange()
  range.selectNodeContents(question); window.getSelection()!.addRange(range)
  await render({ ...goal, decisions: [{ ...decision, decision: 'Continue the same original Agent after review' }],
    activities: [...goal.activities!, { ...goal.activities![0]!, id: 'new-note', createdAt: fixtureEpoch(1, 2) }] })
  expect(details()).toBe(original); expect(details().open).toBe(true); expect(activity().open).toBe(true)
  expect(window.getSelection()!.toString()).toBe(decision.question)
})

it('does not transfer expansion to another Goal that reuses a local decision ID', async () => {
  await render(); activity().open = true; details().open = true; const original = details()
  await render({ ...goal, id: 'another-goal', decisions: [{ ...decision, rationale: 'A separate original reason.' }] })
  expect(details()).not.toBe(original); expect(details().open).toBe(false); expect(activity().open).toBe(false)
  expect(details().textContent).toContain('A separate original reason.')
})

it('states missing recorded fields without inventing an actor or reason and omits an empty timeline', async () => {
  await render({ ...goal, decisions: [{ ...decision, question: '', rationale: '', actorId: null }] })
  expect([...details().querySelectorAll('dd')].map(node => node.textContent)).toEqual(['Not recorded', 'Not recorded', 'Unknown'])
  await render({ ...goal, activities: [], decisions: [] }); expect(host.querySelector('.goals-activity')).toBeNull()
})
