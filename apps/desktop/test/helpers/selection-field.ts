import { act } from 'react'
import { expect } from 'vitest'

export async function chooseField(trigger: HTMLElement, value: string): Promise<void> {
  expect(trigger).not.toBeNull()
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!
  expect(menu).not.toBeNull()
  const item = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(item => item.dataset.value === value)!
  expect(item).not.toBeUndefined()
  await act(async () => item.click())
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
}
