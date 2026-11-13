// @vitest-environment happy-dom
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
  await host.demands.create({ id: 'goal', title: 'Keep my confirmation', status: 'in_progress', sessionIds: [] })
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
