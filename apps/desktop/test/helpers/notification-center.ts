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

export async function toggleNotificationDetails(row: ParentNode, open = true) {
  const details = row.querySelector<HTMLDetailsElement>('.notification-item__details')
  expect(details, 'The original notification Details must be mounted').not.toBeNull()
  await act(async () => {
    details!.open = open
    details!.dispatchEvent(new Event('toggle'))
  })
}

/** View changes are explicit user actions; opening the center never chooses one for a test. */
export async function selectNotificationView(container: ParentNode, view: 'current' | 'history') {
  const button = container.querySelector<HTMLButtonElement>(`[role="tab"][data-section="${view}"]`)
  expect(button, `The ${view} notification tab must be visible`).not.toBeNull()
  await act(async () => { button!.click() })
  expect(button!.getAttribute('aria-selected')).toBe('true')
}

export async function expandNotificationGroups(container: ParentNode) {
  const groups = container.querySelectorAll('.notification-group')
  expect(groups.length, 'Expanding groups must inspect a nonempty notification collection').toBeGreaterThan(0)
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('.notification-group__more[aria-expanded="false"]')]
  await act(async () => { for (const button of buttons) button.click() })
  expect(container.querySelectorAll('.notification-group__more[aria-expanded="false"]')).toHaveLength(0)
}

export async function markShownNotificationsRead(container: ParentNode) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('.global-system-notices__footer button')]
    .find(candidate => candidate.textContent === 'Mark shown read')
  expect(button, 'A nonempty unread selection must expose Mark shown read').toBeDefined()
  await act(async () => { button!.click() })
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
