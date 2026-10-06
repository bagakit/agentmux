import { act } from 'react'
import { expect } from 'vitest'

/** happy-dom lacks the native popover algorithm; dispatch its actual state receipt. */
export async function toggleNotificationCenter(container: ParentNode, newState: 'open' | 'closed') {
  const details = container.querySelector<HTMLElement>('.global-system-notices__details')
  expect(details, 'The real notification center must be mounted').not.toBeNull()
  const event = new Event('toggle')
  Object.defineProperty(event, 'newState', { value: newState })
  await act(async () => { details!.dispatchEvent(event) })
}

export function currentNotificationRows(container: ParentNode) {
  return [...container.querySelectorAll<HTMLElement>('.notification-item[data-notice-id]')]
}

export function notificationEventRows(container: ParentNode) {
  return [...container.querySelectorAll<HTMLElement>('.notification-item[data-event-id]')]
}

export function notificationTrigger(container: ParentNode) {
  const trigger = container.querySelector<HTMLButtonElement>('.global-system-notices__trigger')
  expect(trigger, 'The window notification entry must be mounted').not.toBeNull()
  return trigger!
}
