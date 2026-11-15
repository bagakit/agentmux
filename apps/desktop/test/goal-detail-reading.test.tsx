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
import { chooseGoalSection, copyOriginalGoalLink, goalOutlineTrigger, openGoalMenu, pressGoalMenuKey } from './helpers/goal-reading-menu'
import { chooseField } from './helpers/selection-field'

const dom = composerDOM()
const record = (): DemandRecord => ({ id: 'detail-reading', title: 'One continuous original Goal', description: 'Keep this original brief.  ', status: 'in_progress', priority: 'normal', projectId: null, projectName: null,
  activities: [{ id: 'original-progress', kind: 'progress', message: 'Read the original brief', createdAt: 1, actorId: 'worker' }],
  source: 'session', sessionIds: [], createdAt: 1, updatedAt: 1, address: formatGoalAddress('detail-reading', 'original-runtime', 'original-namespace') })
async function mount() {
  const goal = record()
  useAppStore.setState({ demands: { [goal.id]: goal }, selectedDemandId: goal.id, mainSurface: 'board', goalReadingEntry: null })
  await dom.render(<GlobalBoardSurface />)
  return goal
}
const button = (text: string) => [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)!
const selected = () => goalOutlineTrigger(dom.container).getAttribute('aria-label')

/** These measured positions stand in for layout only; the original scroll consumer and editors are mounted. */
function measure(positions = { plan: 200, overview: 900, execution: 1450, activity: 1800 }, total = 2400) {
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
  expect(editor).not.toBeNull()
  const plan = dom.container.querySelector('[data-goal-reading-section="plan"]')!
  const detail = measure()
  const trigger = goalOutlineTrigger(detail)
  expect(trigger.closest('.goals-detail__toolbar')).not.toBeNull()
  expect(selected()).toBe('Jump to section: Execution plan')
  expect(detail.querySelectorAll('[data-goal-outline-trigger]')).toHaveLength(1)
  const menu = await openGoalMenu(trigger)
  expect([...menu.querySelectorAll('[data-goal-destination]')].map(item => item.textContent?.trim()))
    .toEqual(['Execution plan', 'Goal overview', 'Execution records', 'Activity'])
  expect(menu.querySelector('[aria-current="location"]')?.getAttribute('data-goal-destination')).toBe('plan')
  await pressGoalMenuKey(menu, 'Escape')
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger))
  expect(detail.scrollTop).toBe(0)
  await chooseGoalSection(detail, 'plan')
  expect(detail.scrollTop).toBe(148)
  expect(document.activeElement).toBe(plan)
  await chooseGoalSection(detail, 'overview')
  expect(document.activeElement, 'choosing Goal brief focuses the original brief').toBe(detail.querySelector('[data-goal-reading-section="overview"]'))
  expect(detail.scrollTop).toBe(848)
  expect(goalOutlineTrigger(detail)).toBe(trigger)
  const overview = detail.querySelector('[data-goal-reading-section="overview"]')!
  expect(overview.querySelector('[aria-label="Goal brief"]')).not.toBeNull()
  expect(overview.querySelector('[aria-label="Criteria and results"]')).not.toBeNull()
  const discussions = detail.querySelectorAll('[aria-label^="Open discussion for "]')
  expect(discussions).toHaveLength(1)
  expect(discussions[0]!.parentElement, 'Goal discussion belongs beside the overview heading').toBe(overview.querySelector('.goals-detail__overview-heading'))
  expect(discussions[0]!.querySelector('img[src][alt=""]'), 'The original discussion button carries its illustration').not.toBeNull()
  await chooseGoalSection(detail, 'execution')
  expect(document.activeElement).toBe(detail.querySelector('[data-goal-reading-section="execution"]'))
  expect(selected()).toBe('Jump to section: Execution records')
  expect([...detail.querySelector('.goals-detail__main')!.children].map(section => (section as HTMLElement).dataset.goalReadingSection))
    .toEqual(['plan', 'overview', 'execution', 'activity'])
  await scroll(detail, 1800)
  expect(selected()).toBe('Jump to section: Activity')
  await scroll(detail, 1000)
  expect(selected()).toBe('Jump to section: Goal overview')
  await scroll(detail, 0)
  expect(selected()).toBe('Jump to section: Execution plan')
  expect(dom.container.querySelector('[aria-label="Goal description"]')).toBe(editor)
  expect(dom.container.querySelector('[data-goal-reading-section="plan"]')).toBe(plan)
  expect(useAppStore.getState().goalEditDrafts[goal.id]?.description?.value).toBe('Keep the unsaved original draft.  ')
  expect(dom.container.querySelectorAll('[data-goal-reading-section]')).toHaveLength(4)
})

it('uses the keyboard to move among document sections and read the chosen destination', async () => {
  await mount()
  const detail = measure()
  const menu = await openGoalMenu(goalOutlineTrigger(detail))
  const first = menu.querySelector<HTMLElement>('[data-goal-destination="plan"]')!
  const next = menu.querySelector<HTMLElement>('[data-goal-destination="overview"]')!
  await vi.waitFor(() => expect(document.activeElement).toBe(first))
  await pressGoalMenuKey(first, 'ArrowDown')
  await vi.waitFor(() => expect(document.activeElement).toBe(next))
  await pressGoalMenuKey(next, 'Enter')
  await vi.waitFor(() => expect(menu.isConnected).toBe(false))
  expect(document.activeElement).toBe(detail.querySelector('[data-goal-reading-section="overview"]'))
  expect(selected()).toBe('Jump to section: Goal overview')
})

it('keeps a chosen plan current when brief and plan share a row and marks a visible Activity at the document end', async () => {
  await mount()
  const detail = measure({ plan: 200, overview: 200, execution: 750, activity: 1050 }, 1400)
  await chooseGoalSection(detail, 'plan')
  await scroll(detail, 200)
  expect(selected()).toBe('Jump to section: Execution plan')
  await scroll(detail, 800)
  expect(selected()).toBe('Jump to section: Activity')
  await scroll(detail, 0)
  expect(selected()).toBe('Jump to section: Execution plan')
})

it('the exact original plan entry sets the reading signal without moving focus, and copying keeps owner addresses', async () => {
  const goal = await mount()
  const write = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  measure()
  const title = dom.container.querySelector<HTMLElement>('[aria-label="Goal title"]')!
  title.focus()
  await act(async () => useAppStore.setState({ goalReadingEntry: { goalId: goal.id, runtimeId: goal.address!.runtimeId, namespace: goal.address!.namespace, section: 'plan', phase: 'ready', token: 'original-plan-reading' } }))
  expect(selected()).toBe('Jump to section: Execution plan'); expect(document.activeElement).toBe(title)
  await copyOriginalGoalLink(dom.container)
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
