// @vitest-environment happy-dom
import { seedStoredDemand } from '../../../test/fixtures/stored-demand.mjs'
import { act } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { openHostGoalTransport, type HostGoalTransport } from './helpers/host-goal-transport'

const dom = composerDOM()
let host: HostGoalTransport
beforeEach(async () => { host = await openHostGoalTransport({ config: composerConfig }) })
afterEach(async () => { await host.dispose() })

it('edits the original Goal batch through mounted properties, public RPC, Host and the durable owner', async () => {
  const originalSessions = useAppStore.getState().sessions
  await seedStoredDemand(host.demands, { id: 'batched', title: 'Original batch', description: '', status: 'todo', priority: 'normal', projectId: null, projectName: null, sessionIds: [], phaseIndex: 2 })
  await useAppStore.getState().refreshDemand('batched')
  useAppStore.setState({ selectedDemandId: 'batched', mainSurface: 'board' })
  await dom.render(<GlobalBoardSurface />)
  const properties = dom.container.querySelector<HTMLDetailsElement>('.goals-properties')!
  await act(async () => { properties.open = true; properties.dispatchEvent(new Event('toggle')) })
  const field = () => dom.container.querySelector<HTMLInputElement>('[aria-label="Goal batch"]')!
  expect(field()).not.toBeNull(); expect(field().value).toBe('2')
  expect((await host.rpc.call('goal.inspect', { goalId: 'batched' })).goal?.phaseIndex).toBe(2)
  const edit = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), value)
      field().dispatchEvent(new Event('input', { bubbles: true })); await host.settle()
    })
  }
  await edit('4')
  expect((await host.demands.get('batched'))?.phaseIndex).toBe(4)
  expect(useAppStore.getState().demands.batched?.phaseIndex).toBe(4)
  await useAppStore.getState().updateDemand('batched', { description: 'The same original work.' })
  expect((await host.rpc.call('goal.inspect', { goalId: 'batched' })).goal?.phaseIndex).toBe(4)
  await edit('')
  expect((await host.demands.get('batched'))?.phaseIndex).toBeNull()
  expect((await host.rpc.call('goal.ls', { all: true })).goals.map(goal => goal.id)).toEqual(['batched'])
  expect(useAppStore.getState().sessions).toBe(originalSessions)
})
