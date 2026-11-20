import { act } from 'react'
import { expect } from 'vitest'

export async function focusScanAction(container: ParentNode, label: string) {
  const trigger = container.querySelector('[aria-label="Focus actions"]')
  expect(trigger).not.toBeNull()
  await act(async () => trigger!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  const menu = document.querySelector('.focus-scan-actions__menu')
  expect(menu).not.toBeNull()
  const item = [...menu!.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')].find(node => node.textContent === label)
  expect(item).toBeDefined()
  await act(async () => item!.click())
}
