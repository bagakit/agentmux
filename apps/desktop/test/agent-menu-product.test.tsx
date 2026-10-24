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
async function mount(entries: RegionMenuEntry[]) {
  await dom.render(<Menu.Root open><Menu.Trigger>Actions</Menu.Trigger><Menu.Content data-product-menu="">
    <AgentRegionMenuActions entries={entries} controls={<Menu.Item>Take over</Menu.Item>} conversation={<><Menu.Item>Conversation history</Menu.Item><Menu.Item>Session details</Menu.Item></>} />
  </Menu.Content></Menu.Root>)
  return document.querySelector<HTMLElement>('[data-product-menu]')!
}
it('groups typed actions without implementation separators and exposes layout commands directly', async () => {
  const split = vi.fn(), promote = vi.fn(), restart = vi.fn()
  const root = await mount([
    { kind: 'layout', entries: [{ kind: 'split', direction: 'right', label: 'Split Right', onSelect: split }] },
    { kind: 'separator' }, { kind: 'separator' }, { kind: 'promote', onSelect: promote },
    { kind: 'restart', onSelect: restart }
  ])
  expect([...root.querySelectorAll('[role="menuitem"]')].map(node => (node.getAttribute('aria-label') ?? node.textContent)?.trim())).toEqual(['Conversation history', 'Session details', 'Take over', 'Restart Session…', 'Split Right', 'Move to New Tab'])
  expect(root.querySelectorAll('[role="separator"]')).toHaveLength(2)
  expect(item(root, 'Split Right').getAttribute('aria-haspopup')).toBeNull()
  await act(async () => item(root, 'Split Right').click())
  expect(split).toHaveBeenCalledOnce(); expect(promote).not.toHaveBeenCalled(); expect(restart).not.toHaveBeenCalled()
})
it('keeps compact exact link actions and connector recovery issues directly in the root', async () => {
  const agent = vi.fn(async () => {}), region = vi.fn(async () => {}), connect = vi.fn()
  const root = await mount([
    { kind: 'action', action: { label: 'Copy Agent Link', onSelect: agent } },
    { kind: 'action', action: { label: 'Copy Region Link', onSelect: region } },
    { kind: 'connector-group', group: { label: 'Team chat', entries: [{ label: 'Bind existing group chat', onSelect: connect }], issue: 'Connection observation unavailable. Retry from this group.' } }
  ])
  expect(root.textContent).not.toContain('Copy Agent Link')
  expect([...root.querySelectorAll('[role="menuitem"]')].slice(0, 2).map(node => node.getAttribute('aria-label'))).toEqual(['Copy Agent Link', 'Copy Region Link'])
  const links = root.querySelector('[role="group"][aria-label="Copy link"]')!
  expect([...links.querySelectorAll('[role="menuitem"]')].map(node => node.getAttribute('aria-label'))).toEqual(['Copy Agent Link', 'Copy Region Link'])
  expect(links.querySelector('[aria-haspopup]')).toBeNull()
  const chat = root.querySelector('[data-connector-menu-group]')!
  expect(chat.textContent).not.toContain('observation unavailable')
  const notice = item(chat, 'Team chat service notice')
  await act(async () => { notice.focus(); notice.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })) })
  const details = document.getElementById(notice.getAttribute('aria-controls')!)!
  expect(details.querySelector('[role="status"]')?.textContent).toContain('observation unavailable')
  await act(async () => details.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })))
  await act(async () => item(chat, 'Bind existing group chat').click())
  expect(connect).toHaveBeenCalledOnce(); expect(agent).not.toHaveBeenCalled(); expect(region).not.toHaveBeenCalled()
})
it('copy shortcuts keep horizontal keyboard navigation and execute only the chosen object', async () => {
  const agent = vi.fn(async () => {}), region = vi.fn(async () => {})
  const root = await mount([
    { kind: 'action', action: { label: 'Copy Agent Link', onSelect: agent } },
    { kind: 'action', action: { label: 'Copy Region Link', onSelect: region } }
  ])
  await act(async () => {
    item(root, 'Copy Agent Link').focus()
    item(root, 'Copy Agent Link').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
  })
  expect(document.activeElement).toBe(item(root, 'Copy Region Link'))
  expect(root.querySelector('.workbench-menu-row__label-text')?.textContent).toBe('Copy Region Link')
  await act(async () => item(root, 'Copy Region Link').click())
  expect(region).toHaveBeenCalledOnce(); expect(agent).not.toHaveBeenCalled()
})
