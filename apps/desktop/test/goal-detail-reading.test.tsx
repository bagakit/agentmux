// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { formatGoalAddress } from '@agentmux/core/sharing'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { api } from '../src/renderer/src/lib/api'
import { editGoalDraft } from '../src/renderer/src/lib/goal-edit-drafts'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'
import { chooseField } from './helpers/selection-field'

const dom = composerDOM()
const record = (): DemandRecord => ({ id: 'detail-reading', title: 'One continuous original Goal', description: 'Keep this original brief.  ', status: 'in_progress', priority: 'normal', projectId: null, projectName: null,
  source: 'session', sessionIds: [], createdAt: 1, updatedAt: 1, address: formatGoalAddress('detail-reading', 'original-runtime', 'original-namespace') })
async function mount() {
  const goal = record()
  useAppStore.setState({ demands: { [goal.id]: goal }, selectedDemandId: goal.id, mainSurface: 'board', goalReadingEntry: null })
  await dom.render(<GlobalBoardSurface />)
  return goal
}
const button = (text: string) => [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)!
const selected = () => dom.container.querySelector('[aria-label="Goal reading sections"] [aria-current="location"]')?.textContent

/** These measured positions stand in for layout only; the original scroll consumer and editors are mounted. */
function measure(positions = { overview: 200, plan: 900, activity: 1800 }, total = 2400) {
  const detail = dom.container.querySelector<HTMLElement>('.goals-detail')!
  vi.spyOn(detail, 'getBoundingClientRect').mockImplementation(() => ({ top: 20, bottom: 620, height: 600 } as DOMRect))
  Object.defineProperty(detail, 'clientHeight', { configurable: true, value: 600 })
  Object.defineProperty(detail, 'scrollHeight', { configurable: true, value: total })
  for (const [id, top] of Object.entries(positions)) {
    const section = detail.querySelector<HTMLElement>(`[data-goal-reading-section="${id}"]`)!
    section.style.scrollMarginTop = '52px'
    vi.spyOn(section, 'getBoundingClientRect').mockImplementation(() => ({ top: 20 + top - detail.scrollTop, bottom: 500 + top - detail.scrollTop, height: 480 } as DOMRect))
  }
  return detail
}
async function scroll(detail: HTMLElement, top: number) {
  await act(async () => { detail.scrollTop = top; detail.dispatchEvent(new Event('scroll')); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) })
}

it('the mounted workspace tracks explicit reading and manual scroll without replacing the original editor or draft', async () => {
  const goal = await mount()
  await act(async () => editGoalDraft(goal.id, 'description', 'Keep the unsaved original draft.  '))
  const editor = dom.container.querySelector('[aria-label="Goal description"]')!
  const plan = dom.container.querySelector('[data-goal-reading-section="plan"]')!
  const detail = measure()
  expect(selected()).toBe('Overview')
  await act(async () => button('Plan').click())
  expect(selected()).toBe('Plan'); expect(detail.scrollTop).toBe(848); expect(document.activeElement).toBe(plan)
  await scroll(detail, 1800)
  expect(selected()).toBe('Activity')
  await scroll(detail, 1000)
  expect(selected()).toBe('Plan')
  await scroll(detail, 0)
  expect(selected()).toBe('Overview')
  expect(dom.container.querySelector('[aria-label="Goal description"]')).toBe(editor)
  expect(dom.container.querySelector('[data-goal-reading-section="plan"]')).toBe(plan)
  expect(useAppStore.getState().goalEditDrafts[goal.id]?.description?.value).toBe('Keep the unsaved original draft.  ')
  expect(dom.container.querySelectorAll('[data-goal-reading-section]')).toHaveLength(3)
})

it('keeps a chosen plan current when brief and plan share a row and marks a visible Activity at the document end', async () => {
  await mount()
  const detail = measure({ overview: 200, plan: 200, activity: 1050 }, 1400)
  await act(async () => button('Plan').click())
  await scroll(detail, 200)
  expect(selected()).toBe('Plan')
  await scroll(detail, 800)
  expect(selected()).toBe('Activity')
  await scroll(detail, 0)
  expect(selected()).toBe('Overview')
})

it('the exact original plan entry sets the reading signal without moving focus, and copying keeps owner addresses', async () => {
  const goal = await mount()
  const write = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  measure()
  const title = dom.container.querySelector<HTMLElement>('[aria-label="Goal title"]')!
  title.focus()
  await act(async () => useAppStore.setState({ goalReadingEntry: { goalId: goal.id, runtimeId: goal.address!.runtimeId, namespace: goal.address!.namespace, section: 'plan', phase: 'ready', token: 'original-plan-reading' } }))
  expect(selected()).toBe('Plan'); expect(document.activeElement).toBe(title)
  await act(async () => button('Copy goal link').click())
  expect(write).toHaveBeenLastCalledWith(goal.address!.goalUrl)
  await act(async () => button('Copy plan link').click())
  expect(write).toHaveBeenLastCalledWith(goal.address!.planUrl)
})

it('discloses original properties on demand, preserves their nodes, and edits through the original Store action', async () => {
  const goal = await mount()
  const update = vi.spyOn(useAppStore.getState(), 'updateDemand').mockResolvedValue(undefined)
  // Re-render after installing the real Store action spy, as its hook captures the action.
  await dom.render(<GlobalBoardSurface />)
  const properties = dom.container.querySelector<HTMLDetailsElement>('[aria-label="Goal properties"]')!
  expect(properties.tagName).toBe('DETAILS'); expect(properties.open).toBe(false)
  const priority = properties.querySelector<HTMLElement>('[aria-label="Goal priority"]')!
  expect(priority).not.toBeNull()
  expect(properties.closest('[aria-label="Goal team and properties"]')?.querySelector('.goal-collaboration')).not.toBeNull()
  await act(async () => properties.querySelector('summary')!.click())
  expect(properties.open).toBe(true)
  await chooseField(priority, 'high')
  expect(update).toHaveBeenCalledWith(goal.id, { priority: 'high' }, undefined, undefined, undefined)
  await act(async () => properties.querySelector('summary')!.click())
  expect(properties.open).toBe(false)
  expect(properties.querySelector('[aria-label="Goal priority"]')).toBe(priority)
  expect(useAppStore.getState().selectedDemandId).toBe(goal.id)
})
