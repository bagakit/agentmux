// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { composerDOM } from './helpers/composer-dom-fixture'
import * as Menu from '../src/renderer/src/components/HoverDropdownMenu'
import { AgentRegionMenuActions } from '../src/renderer/src/components/AgentRegionMenuActions'
import type { RegionMenuEntry } from '../src/renderer/src/components/RegionContextMenu'

const dom = composerDOM()
function item(root: ParentNode, label: string) {
  const found = [...root.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => (node.getAttribute('aria-label') ?? node.textContent)?.trim() === label)
  expect(found, `Actual ${label} menu item`).toBeDefined()
  return found!
}
async function disclose(root: ParentNode, label: string) {
  const trigger = item(root, label)
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
  const child = document.getElementById(trigger.getAttribute('aria-controls')!)
  expect(child, `Actual ${label} submenu`).not.toBeNull()
  return child!
}
async function mount(entries: RegionMenuEntry[]) {
  await dom.render(<Menu.Root open><Menu.Trigger>Actions</Menu.Trigger><Menu.Content data-product-menu="">
    <AgentRegionMenuActions entries={entries} details={<Menu.Item>Session details</Menu.Item>} />
  </Menu.Content></Menu.Root>)
  return document.querySelector<HTMLElement>('[data-product-menu]')!
}
it('groups typed actions without duplicating implementation separators or exposing layout commands in the root', async () => {
  const split = vi.fn(), promote = vi.fn(), restart = vi.fn()
  const root = await mount([
    { kind: 'layout', entries: [{ kind: 'split', direction: 'right', label: 'Split Right', onSelect: split }] },
    { kind: 'separator' }, { kind: 'separator' }, { kind: 'promote', onSelect: promote },
    { kind: 'restart', onSelect: restart }
  ])
  expect([...root.querySelectorAll('[role="menuitem"]')].map(node => node.textContent?.trim())).toEqual(['Split and layout', 'Move to New Tab', 'Session details', 'Restart Session…'])
  expect(root.querySelectorAll('[role="separator"]')).toHaveLength(3)
  const layout = await disclose(root, 'Split and layout')
  await act(async () => item(layout, 'Split Right').click())
  expect(split).toHaveBeenCalledOnce(); expect(promote).not.toHaveBeenCalled(); expect(restart).not.toHaveBeenCalled()
})
it('keeps exact link names and connector recovery issues inside their named submenus', async () => {
  const agent = vi.fn(async () => {}), region = vi.fn(async () => {}), connect = vi.fn()
  const root = await mount([
    { kind: 'action', action: { label: 'Copy Agent Link', onSelect: agent } },
    { kind: 'action', action: { label: 'Copy Region Link', onSelect: region } },
    { kind: 'connector-group', group: { label: 'Team chat', entries: [{ label: 'Bind existing group chat', onSelect: connect }], issue: 'Connection observation unavailable. Retry from this group.' } }
  ])
  expect(root.textContent).not.toContain('Copy Agent Link')
  const links = await disclose(root, 'Copy link')
  expect([...links.querySelectorAll('[role="menuitem"]')].map(node => node.textContent?.trim())).toEqual(['Copy Agent Link', 'Copy Region Link'])
  await act(async () => links.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
  const chat = await disclose(root, 'Team chat')
  expect(chat.querySelector('[role="status"]')?.textContent).toContain('observation unavailable')
  await act(async () => item(chat, 'Bind existing group chat').click())
  expect(connect).toHaveBeenCalledOnce(); expect(agent).not.toHaveBeenCalled(); expect(region).not.toHaveBeenCalled()
})
