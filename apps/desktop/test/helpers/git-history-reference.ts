import { act } from 'react'
import { expect } from 'vitest'

export async function selectHistoryReference(host: ParentNode, value: string): Promise<void> {
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="History reference"]')!
  expect(trigger).not.toBeNull()
  if (trigger.getAttribute('aria-expanded') !== 'true') await act(async () => trigger.click())
  const document = trigger.ownerDocument
  const input = document.querySelector<HTMLInputElement>('[aria-label="Search history references"]')!
  expect(input).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(document.defaultView!.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"][data-value]')].find(option => option.dataset.value === value)
  expect(option, `Original history reference ${value || 'All branches'} is selectable`).toBeDefined()
  await act(async () => option!.click())
  expect(document.querySelector('[aria-label="History references"]')).toBeNull()
}
