import { seedStoredDemand } from '../../../test/fixtures/stored-demand.mjs'
import { fixtureCivil as _hygiene_fixtureCivil, fixtureYear as _hygiene_fixtureYear } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { openHostGoalTransport, type HostGoalTransport } from './helpers/host-goal-transport'

const dom = composerDOM()
let host: HostGoalTransport
beforeEach(async () => {
  vi.stubEnv('TZ', 'Asia/Shanghai')
  // Only Electron IPC is substituted: the property transaction reaches the original Host Goal owner.
  host = await openHostGoalTransport({ config: composerConfig })
})
afterEach(async () => { await host.dispose(); vi.unstubAllEnvs() })
it('keeps both local civil dates through the actual Goal properties transaction and a redraw', async () => {
  const id = 'goal:civil-date'
  const saved = (await seedStoredDemand(host.demands, { id, title: 'Keep the original local dates', description: 'Original Goal', status: 'backlog', priority: 'normal', sessionIds: [] })).demand
  const record = { ...saved, source: 'default-topic' as const }
  useAppStore.setState({ demands: { [id]: record }, selectedDemandId: id, mainSurface: 'board', sessions: [] })
  const updates = () => host.bodies('demand.update').map(({ demandId, patch }) => [demandId, patch])
  await dom.render(<GlobalBoardSurface />)
  // Planning dates live in the closed "More properties" disclosure, which mounts its fields only while open.
  const properties = dom.container.querySelector<HTMLDetailsElement>('.goals-properties')!
  expect(properties.open).toBe(false); expect(properties.querySelector('[aria-label="Goal planned start"]')).toBeNull()
  await act(async () => { properties.open = true; properties.dispatchEvent(new Event('toggle')) })
  const edit = async (label: string, value: string) => {
    const field = dom.container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
    expect(field).not.toBeNull(); expect(field.type).toBe('date')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
      field.dispatchEvent(new Event('input', { bubbles: true }))
      await host.settle()
    })
    await dom.render(<GlobalBoardSurface />)
    expect(field.value).toBe(value)
  }
  await edit('Goal planned start', _hygiene_fixtureCivil(2, 14, 1))
  await edit('Goal target date', _hygiene_fixtureCivil(3, 15, 1))
  expect(updates()).toEqual([
    [id, { plannedStartAt: Date.UTC(_hygiene_fixtureYear + 1, 1, 13, 16) }],
    [id, { targetAt: Date.UTC(_hygiene_fixtureYear + 1, 2, 14, 16) }]
  ])
  expect(useAppStore.getState().demands[id]).toMatchObject({ plannedStartAt: Date.UTC(_hygiene_fixtureYear + 1, 1, 13, 16), targetAt: Date.UTC(_hygiene_fixtureYear + 1, 2, 14, 16) })
  expect(await host.demands.get(id)).toMatchObject({ plannedStartAt: Date.UTC(_hygiene_fixtureYear + 1, 1, 13, 16), targetAt: Date.UTC(_hygiene_fixtureYear + 1, 2, 14, 16) })
  await edit('Goal planned start', '')
  expect(updates()[2]).toEqual([id, { plannedStartAt: null }])
  expect(Object.keys(useAppStore.getState().demands)).toEqual([id])
})
