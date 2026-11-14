// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { api } from '../src/renderer/src/lib/api'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const goal: DemandRecord = { id: 'original-start-goal', title: 'Original Goal', description: 'Keep this brief', status: 'backlog', priority: 'normal', source: 'session', projectId: null, projectName: null, sessionIds: [], createdAt: 1, updatedAt: 1 }
const prompt = '  Read the original request.\nKeep spacing and source.  '
async function mount() {
  useAppStore.setState({ config: { ...composerConfig, composerShortcuts: [{ id: 'original-request', keyword: 'original', label: 'Original request', body: prompt }], goalsCommonActions: { items: [{ kind: 'prompt', id: 'original-request' }], collapsed: false } },
    demands: { [goal.id]: goal }, selectedDemandId: null, mainSurface: 'board' })
  await dom.render(<GlobalBoardSurface />)
}

it('the real Goals banner contains one original common-action surface and its complete request and target facts', async () => {
  await mount()
  const banner = dom.container.querySelector('.goals-page-header')!
  const common = banner.querySelector('[aria-label="Common actions"]')!
  expect(common).not.toBeNull()
  expect(dom.container.querySelectorAll('[aria-label="Common actions"]')).toHaveLength(1)
  expect(common.querySelector('.goals-entry__request')!.textContent).toBe(prompt)
  expect(common.querySelector('.goals-common__facts')!.textContent).toBe('Primary Mote Agent unconfirmed')
  expect(banner.querySelectorAll('[aria-label="New Goal"]')).toHaveLength(1)
  expect(dom.container.querySelector('.goals-collection')).not.toBeNull()
})

it('detail and return keep the original action nodes and unsent conversation draft', async () => {
  await mount()
  const common = dom.container.querySelector<HTMLElement>('[aria-label="Common actions"]')!
  const action = common.querySelector<HTMLElement>('[data-common-action]')!
  await act(async () => useAppStore.setState({ selectedDemandId: goal.id }))
  expect(dom.container.querySelector('[aria-label="Common actions"]')).toBe(common)
  expect(common.closest('.goals-page-header')).not.toBeNull()
  expect(common.dataset.commonContext).toBe('compact')
  expect(common.querySelector('.goals-common__content')?.hasAttribute('hidden')).toBe(true)
  await act(async () => common.querySelector<HTMLButtonElement>('[aria-label="Back to common actions"]')!.click())
  expect(useAppStore.getState().selectedDemandId).toBeNull()
  expect(common.querySelector('[data-common-action]')).toBe(action)
  expect(common.dataset.commonContext).toBe('full')
  expect(useAppStore.getState().agentComposerDrafts['agent-1']).toBe('Keep my draft')
})

it('a visibility save failure remains inside the unified banner with its original request and no launch', async () => {
  await mount()
  const save = vi.spyOn(api.config, 'configureGoalsCommonActions').mockRejectedValue(new Error('Original configuration receipt unavailable'))
  const launch = vi.spyOn(useAppStore.getState(), 'openScratchTopic')
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[aria-label="Collapse common actions"]')!.click())
  expect(save).toHaveBeenCalledOnce()
  const common = dom.container.querySelector('[aria-label="Common actions"]')!
  expect(common.closest('.goals-page-header')).not.toBeNull()
  expect(common.querySelector('[role="alert"]')?.textContent).toContain('Original configuration receipt unavailable')
  expect(common.querySelector('.goals-entry__request')!.textContent).toBe(prompt)
  expect(common.getAttribute('data-common-collapsed')).toBe('false')
  expect(launch).not.toHaveBeenCalled()
})
