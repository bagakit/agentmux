import { fixtureCivil as _hygiene_fixtureCivil, fixtureYear as _hygiene_fixtureYear } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
beforeEach(() => vi.stubEnv('TZ', 'Asia/Shanghai'))
afterEach(() => vi.unstubAllEnvs())
it('keeps both local civil dates through the actual Goal properties transaction and a redraw', async () => {
  const id = 'goal:civil-date'
  let record = { id, title: 'Keep the original local dates', description: 'Original Goal', status: 'backlog' as const, priority: 'normal' as const,
    sessionIds: [], tags: [], plannedStartAt: null as number | null, targetAt: null as number | null, projectId: null, projectName: null,
    parentDemandId: null, phaseIndex: null, revision: 1, activities: [], decisions: [], createdAt: 1, updatedAt: 1, source: 'default-topic' as const }
  const update = vi.spyOn(api.demands, 'update').mockImplementation(async (goalId, patch) => {
    expect(goalId).toBe(id)
    record = { ...record, ...patch, revision: record.revision + 1, updatedAt: record.updatedAt + 1 } as typeof record
    return { schema: 'agentmux.demand-receipt.v1', operation: 'update', operationId: 'private-observed-update', revision: record.revision, demand: record } as never
  })
  useAppStore.setState({ demands: { [id]: record }, selectedDemandId: id, mainSurface: 'board', sessions: [] })
  await dom.render(<GlobalBoardSurface />)
  const edit = async (label: string, value: string) => {
    const field = dom.container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
    expect(field.type).toBe('date')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await dom.render(<GlobalBoardSurface />)
    expect(field.value).toBe(value)
  }
  await edit('Goal planned start', _hygiene_fixtureCivil(2, 14, 1))
  await edit('Goal target date', _hygiene_fixtureCivil(3, 15, 1))
  expect(update.mock.calls.map(args => args.slice(0, 2))).toEqual([
    [id, { plannedStartAt: Date.UTC(_hygiene_fixtureYear + 1, 1, 13, 16) }],
    [id, { targetAt: Date.UTC(_hygiene_fixtureYear + 1, 2, 14, 16) }]
  ])
  expect(useAppStore.getState().demands[id]).toMatchObject({ plannedStartAt: Date.UTC(_hygiene_fixtureYear + 1, 1, 13, 16), targetAt: Date.UTC(_hygiene_fixtureYear + 1, 2, 14, 16) })
  await edit('Goal planned start', '')
  expect(update.mock.calls[2]!.slice(0, 2)).toEqual([id, { plannedStartAt: null }])
  expect(Object.keys(useAppStore.getState().demands)).toEqual([id])
})
