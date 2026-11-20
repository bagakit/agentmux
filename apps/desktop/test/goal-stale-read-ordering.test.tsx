// @vitest-environment happy-dom
import { seedStoredDemand } from '../../../test/fixtures/stored-demand.mjs'
import { act } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { openHostGoalTransport, type HostGoalTransport } from './helpers/host-goal-transport'

/**
 * A Goal read that started before a confirmation must not roll the Renderer back after the
 * confirmation's receipt was published. The Host owner already holds the newer record.
 */
composerDOM()
let host: HostGoalTransport
const proposal = { summary: 'Agreed direction', criteria: [{ id: 'a', text: 'First outcome' }], openQuestions: [] }
beforeEach(async () => { host = await openHostGoalTransport({ config: composerConfig }) })
afterEach(async () => { await host.dispose() })

it('keeps a published confirmation when an older public Goal read returns later', async () => {
  await seedStoredDemand(host.demands, { id: 'goal', title: 'Keep my confirmation', status: 'in_progress', sessionIds: [] })
  await host.demands.proposeAlignment('goal', proposal)
  await act(async () => { await useAppStore.getState().refreshDemand('goal') })
  expect(useAppStore.getState().demands.goal?.alignment?.confirmedAt).toBeNull()

  const read = host.once('demand.show', { kind: 'hold-receipt' })
  const lateRead = useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, operation: 'demand.show', requestId: 'late-read', demandId: 'goal' })
  await read.committed
  // The held read was admitted before the confirmation and will return the pre-confirmation record.
  await act(async () => { await useAppStore.getState().confirmDemandGoal('goal', 1) })
  const confirmed = useAppStore.getState().demands.goal!
  expect(confirmed.alignment?.confirmedAt).toBeGreaterThan(0)

  await act(async () => { read.release(); await lateRead })
  expect(useAppStore.getState().demands.goal?.alignment?.confirmedAt).toBe(confirmed.alignment!.confirmedAt)
  expect(useAppStore.getState().demands.goal?.updatedAt).toBe(confirmed.updatedAt)
})

it('a late Goal write receipt never republishes an older Goal over a newer owner read', async () => {
  await seedStoredDemand(host.demands, { id: 'goal', title: 'Original title', status: 'in_progress', sessionIds: [] })
  await act(async () => useAppStore.getState().refreshDemand('goal'))
  const held = host.once('demand.update', { kind: 'hold-receipt' })
  const write = useAppStore.getState().updateDemand('goal', { title: 'First committed title' })
  await held.committed
  const newer = await host.demands.update('goal', { title: 'Newer authoritative title' })
  await act(async () => useAppStore.getState().refreshDemand('goal'))
  const current = useAppStore.getState().demands.goal!
  expect(current.title).toBe('Newer authoritative title')
  expect(current.delegationReadCut).toBeUndefined()
  const published: Array<{ title: string; at: number }> = []
  const release = useAppStore.subscribe(state => { const goal = state.demands.goal; if (goal) published.push({ title: goal.title, at: goal.updatedAt }) })
  try {
    await act(async () => { held.release(); await write; await host.settle() })
    expect(published.length).toBeGreaterThan(0)
    expect(published.every(goal => goal.at >= newer.demand.updatedAt && goal.title === 'Newer authoritative title')).toBe(true)
    expect(useAppStore.getState().demands.goal?.updatedAt).toBe(newer.demand.updatedAt)
    expect(host.executed('demand.update')).toHaveLength(1)
    expect((await host.demands.get('goal'))!.title).toBe('Newer authoritative title')
  } finally { release() }
})
