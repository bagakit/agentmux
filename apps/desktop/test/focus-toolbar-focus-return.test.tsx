// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FocusContext } from '../src/renderer/src/lib/focus-context'

// The actual Toolbar and Radix focus scopes are mounted. Only the external
// action owners are mocked; this suite does not assert Core/Run authority.
const owners = vi.hoisted(() => ({ renameAgent: vi.fn(), renameTab: vi.fn(), setMainSurface: vi.fn(), focusExecutionSession: vi.fn() }))
vi.mock('../src/renderer/src/store', () => ({ useAppStore: (selector: (state: typeof owners) => unknown) => selector(owners) }))
import { FocusToolbar } from '../src/renderer/src/components/FocusToolbar'

const selected: FocusContext = {
  id: 'original-context', name: 'Original Focus context', detail: 'Review the original request', state: 'blocked', stateLabel: 'Blocked',
  bucket: 'attention', kind: 'agent', providerId: null, hostId: 'local', topicId: null, workspaceId: 'original-workspace',
  workspaceName: 'Original workspace', workspacePath: '/fixture/original', workspace: undefined,
  liveAgent: true, actionable: true, lastActivityAt: null
}
let root: Root, container: HTMLDivElement, destination: HTMLButtonElement, review: ReturnType<typeof vi.fn>
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
const identity = () => container.querySelector<HTMLButtonElement>('.focus-toolbar__identity')!
const trigger = () => container.querySelector<HTMLButtonElement>('[aria-label="Focus context actions"]')!
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); destination = document.createElement('button')
  destination.textContent = 'Selected action destination'; document.body.append(container, destination)
  review = vi.fn(() => destination.focus())
  owners.setMainSurface.mockImplementation(() => destination.focus())
  owners.focusExecutionSession.mockImplementation(() => destination.focus())
  root = createRoot(container)
  await act(async () => root.render(createElement(FocusToolbar, { children: createElement('input', { 'aria-label': 'Search contexts' }), selectedId: selected.id, selected, tab: null, onReview: review })))
})
afterEach(async () => {
  await act(async () => root.unmount()); await settle()
  container.remove(); destination.remove(); document.getElementById('agentmux-window-overlay-host')?.remove()
  vi.clearAllMocks(); vi.unstubAllGlobals()
})
async function open(kind: 'dropdown' | 'context' | 'keyboard') {
  const origin = kind === 'dropdown' ? trigger() : identity()
  expect(origin).toBeTruthy(); origin.focus()
  await act(async () => {
    if (kind === 'dropdown') origin.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }))
    else if (kind === 'context') origin.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 120, clientY: 18 }))
    else origin.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'F10', shiftKey: true }))
  })
  await settle()
  expect(document.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0)
  expect(document.querySelector('[role="menu"]')).toBeTruthy()
  expect(document.activeElement).not.toBe(document.body)
  return origin
}
async function escapeMenu() {
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!
  expect(menu).toBeTruthy()
  await act(async () => menu.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' })))
  await settle(); expect(document.querySelector('[role="menu"]')).toBeNull()
}
async function pick(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === label)
  expect(item, label).toBeTruthy()
  await act(async () => item!.click()); await settle()
  expect(document.querySelector('[role="menu"]')).toBeNull()
}

it.each(['dropdown', 'context', 'keyboard'] as const)('Escape returns to the original %s menu trigger', async kind => {
  const origin = await open(kind); await escapeMenu()
  expect(document.activeElement).toBe(origin)
})
it('Rename keeps input focus after menu cleanup, then Escape returns to the current identity without committing', async () => {
  await open('dropdown'); await pick('Rename Agent')
  const input = container.querySelector<HTMLInputElement>('[aria-label="Rename Focus context"]')!
  expect(input).toBeTruthy(); expect(document.activeElement).toBe(input)
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' })))
  await settle()
  expect(container.querySelector('[aria-label="Rename Focus context"]')).toBeNull()
  expect(owners.renameAgent).not.toHaveBeenCalled(); expect(owners.renameTab).not.toHaveBeenCalled()
  expect(identity().textContent).toContain(selected.name)
  expect(document.activeElement).toBe(identity())
})
it.each(['Continue in Space', 'Close Focus workspace', 'Review request'])('%s leaves focus with the selected action owner after menu cleanup', async label => {
  await open('dropdown'); await pick(label)
  if (label === 'Continue in Space') expect(owners.setMainSurface).toHaveBeenCalledExactlyOnceWith('workbench')
  else if (label === 'Close Focus workspace') expect(owners.focusExecutionSession).toHaveBeenCalledExactlyOnceWith(null)
  else expect(review).toHaveBeenCalledTimes(1)
  expect(document.activeElement).toBe(destination)
})
it('Outside interaction after a previous Escape keeps the newly chosen target', async () => {
  await open('keyboard'); await escapeMenu(); expect(document.activeElement).toBe(identity())
  await open('dropdown')
  await act(async () => {
    destination.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }))
    destination.focus()
  })
  await settle()
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(document.activeElement).toBe(destination)
})
it('Rename blur commits through the existing owner and keeps the newly focused target', async () => {
  await open('dropdown'); await pick('Rename Agent')
  const input = container.querySelector<HTMLInputElement>('[aria-label="Rename Focus context"]')!
  expect(input).toBeTruthy(); expect(document.activeElement).toBe(input)
  await act(async () => destination.focus()); await settle()
  expect(owners.renameAgent).toHaveBeenCalledExactlyOnceWith(selected.id, selected.name)
  expect(container.querySelector('[aria-label="Rename Focus context"]')).toBeNull()
  expect(identity()).toBeTruthy()
  expect(document.activeElement).toBe(destination)
})
