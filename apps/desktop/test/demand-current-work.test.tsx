// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { parseDemandDispatch, parseDemandDispatches, parseDemandDispatchIntent } from '../../../packages/demand/src/dispatch'
const intent = { operationId: 'original', agentSessionId: 'canonical', hostId: 'local', runId: 'original-run', execution: 'finite' as const, prompt: 'Build the useful output.' }
it('Current Demand: stored confirmation requires the original Core prompt reference and cannot be supplied as an intent', () => {
  expect(parseDemandDispatchIntent(intent)).toEqual(intent)
  expect(() => parseDemandDispatchIntent({ ...intent, stage: 'confirmed' })).toThrow('unknown')
  expect(() => parseDemandDispatch({ ...intent, stage: 'confirmed', preparedAt: 1, submittedAt: 2 })).toThrow('evidence')
  expect(() => parseDemandDispatch({ ...intent, stage: 'confirmed', preparedAt: 1, submittedAt: 2, receipt: { kind: 'core-prompt', itemId: 'prompt:other', createdAt: 3 } })).toThrow('another input')
  const confirmed = { ...intent, stage: 'confirmed', preparedAt: 1, submittedAt: 2, receipt: { kind: 'core-prompt', itemId: 'prompt:original', createdAt: 3 } }
  expect(parseDemandDispatch(confirmed)).toEqual(confirmed)
  expect(() => parseDemandDispatches([confirmed, confirmed])).toThrow('duplicate')
})

import { currentDemandIndex, currentDemandKey } from '../src/renderer/src/lib/goal-current-work'
it('Current Demand: only exact confirmed business input selects work; unrelated Goal changes preserve target references', () => {
  const receipt = { kind: 'core-prompt' as const, itemId: 'prompt:original', createdAt: 3 }
  const dispatch = { ...intent, stage: 'confirmed' as const, preparedAt: 1, submittedAt: 2, receipt }
  const goal = { id: 'goal', title: 'Original useful work', status: 'in_progress' as const, dispatches: [dispatch], sessionIds: ['historical'] }
  const key = currentDemandKey('local', 'canonical'), first = currentDemandIndex({ goal }).get(key)
  expect(first).toMatchObject({ state: 'current', goals: [{ goalId: 'goal', title: goal.title, confirmed: true }] })
  expect(currentDemandIndex({ goal: { ...goal, dispatches: [] } }).has(key)).toBe(false)
  const restored = currentDemandIndex({ goal }).get(key)
  for (let index = 0; index < 20; index++) expect(currentDemandIndex({ goal, unrelated: { id: 'unrelated', title: `Unrelated ${index}`, status: 'in_progress', dispatches: [{ ...dispatch, agentSessionId: 'other' }] } }).get(key)).toBe(restored)
  const ambiguous = currentDemandIndex({ goal, second: { ...goal, id: 'second', title: 'Second confirmed work' } }).get(key)
  expect(ambiguous).toMatchObject({ state: 'ambiguous', goals: [{ goalId: 'goal' }, { goalId: 'second' }] })
  const unknown = currentDemandIndex({ goal, second: { ...goal, id: 'second', title: 'Unknown input', dispatches: [{ ...intent, operationId: 'unknown', stage: 'unknown', preparedAt: 4, submittedAt: 5 }] } }).get(key)
  expect(unknown).toMatchObject({ state: 'unconfirmed', goals: [{ goalId: 'goal', confirmed: true }, { goalId: 'second', confirmed: false, pending: 'unknown' }] })
  expect(currentDemandIndex({ goal: { ...goal, status: 'done' } }).has(key)).toBe(false)
  expect(currentDemandIndex({ goal }).has(currentDemandKey('other-host', 'canonical'))).toBe(false)
  expect(currentDemandIndex({ goal: { ...goal, dispatches: [{ ...dispatch, receipt: { ...receipt, itemId: 'prompt:forged' } }] } }).get(key)).toMatchObject({ state: 'unconfirmed' })
})
