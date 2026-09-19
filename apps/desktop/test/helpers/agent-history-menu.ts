import { act } from 'react'
import { expect, vi } from 'vitest'

/** Follow the public disclosure before reading/selecting History; Portal items live outside the pane. */
export async function agentHistoryMenuEntry(scope: ParentNode = document): Promise<HTMLElement> {
  const trigger = scope.querySelector<HTMLButtonElement>('.agent-region-header__more')
  expect(trigger, 'actual Agent More trigger').not.toBeNull()
  if (trigger!.dataset.state !== 'open') {
    await act(async () => {
      trigger!.focus()
      trigger!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
  }
  await act(async () => await vi.waitFor(() => expect(document.querySelectorAll('.agent-region-menu [role="menuitem"]').length).toBeGreaterThan(0)))
  const entries = [...document.querySelectorAll<HTMLElement>('.agent-region-menu [role="menuitem"]')]
  expect(entries.length, 'actual nonempty More menu').toBeGreaterThan(0)
  const item = entries.find(entry => entry.textContent?.trim() === 'Conversation history')
  expect(item, 'single History action from SessionPane').toBeDefined()
  return item!
}

export async function openAgentHistory(scope: ParentNode = document): Promise<void> {
  const item = await agentHistoryMenuEntry(scope)
  await act(async () => item.click())
}
