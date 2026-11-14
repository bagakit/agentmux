import { act } from 'react'
import { expect, vi } from 'vitest'

export const goalOutlineTrigger = (scope: ParentNode) => scope.querySelector<HTMLButtonElement>('[data-goal-outline-trigger]')!

export async function pressGoalMenuKey(target: HTMLElement, key: string) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
}

export async function openGoalMenu(trigger: HTMLElement): Promise<HTMLElement> {
  await act(async () => trigger.focus())
  await pressGoalMenuKey(trigger, 'ArrowDown')
  let menu: HTMLElement | null = null
  await vi.waitFor(() => {
    menu = document.getElementById(trigger.getAttribute('aria-controls') ?? '')
    expect(menu?.getAttribute('role'), 'the original trigger opens its own menu').toBe('menu')
  })
  return menu!
}

export async function chooseGoalSection(scope: ParentNode, section: 'plan' | 'overview' | 'activity') {
  const menu = await openGoalMenu(goalOutlineTrigger(scope))
  const item = menu.querySelector<HTMLElement>(`[data-goal-destination="${section}"]`)
  expect(item, `the original outline offers ${section}`).not.toBeNull()
  await act(async () => item!.click())
  await vi.waitFor(() => expect(menu.isConnected).toBe(false))
}

export async function copyOriginalGoalLink(scope: ParentNode) {
  const menu = await openGoalMenu(scope.querySelector<HTMLElement>('button[aria-label="Goal actions"]')!)
  const action = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === 'Copy goal link')
  expect(action, 'the selected Goal exposes its own link').toBeDefined()
  await act(async () => action!.click())
  await vi.waitFor(() => expect(menu.isConnected).toBe(false))
}
