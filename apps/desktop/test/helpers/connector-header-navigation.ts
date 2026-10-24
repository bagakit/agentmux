import { act } from 'react'
import { expect, vi } from 'vitest'

/** Exercise the original workface menu, including its real focus-scope handoff. */
export async function openConnectionsMenu(regionId = 'original-region', channel?: string) {
  const region = document.querySelector<HTMLElement>(`[data-workbench-region-id="${regionId}"]`)
  expect(region, 'original workface Region').not.toBeNull()
  const trigger = region!.querySelector<HTMLButtonElement>(channel ? `.agent-region-header__connector[data-channel-entry="${channel}"]` : '.agent-region-header__connector')
  expect(trigger, 'original Agent Connections entry').not.toBeNull()
  await act(async () => { trigger!.focus(); trigger!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('.connector-header-menu')).not.toBeNull() })
  return trigger!
}

export async function openConnectedGroup(externalConversationId: string, regionId = 'original-region', channel?: string) {
  await openConnectionsMenu(regionId, channel)
  let item: HTMLElement | undefined
  await vi.waitFor(async () => {
    await act(async () => {})
    item = [...document.querySelectorAll<HTMLElement>('.connector-header-menu__item')].find(node => node.title.split(' · ').includes(externalConversationId))
    expect(item, 'the exact original group, independent of its displayed name').toBeDefined()
  })
  await act(async () => item!.click())
  await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('.connector-header-menu')).toBeNull(); expect(document.querySelector('[role="dialog"]')).not.toBeNull() })
}
