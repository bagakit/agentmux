// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FocusContext } from '../src/renderer/src/lib/focus-context'

// The actual Toolbar and Radix focus scopes are mounted. Only the external
// action owners are mocked; this suite does not assert Core/Run authority.
const owners = vi.hoisted(() => ({ renameAgent: vi.fn(), renameTab: vi.fn(), setMainSurface: vi.fn(), focusExecutionSession: vi.fn() }))
vi.mock('../src/renderer/src/store', () => ({ useAppStore: Object.assign((selector: (state: typeof owners) => unknown) => selector(owners), { getState: () => ({ activeWorkspaceId: null, layouts: {}, tabs: {} }) }) }))
import { FocusToolbar } from '../src/renderer/src/components/FocusToolbar'

const selected: FocusContext = {
  id: 'original-context', name: 'Original Focus context', detail: 'Review the original request', state: 'blocked', stateLabel: 'Blocked',
  bucket: 'attention', kind: 'agent', providerId: null, hostId: 'local', topicId: null, workspaceId: 'original-workspace',
  workspaceName: 'Original workspace', workspacePath: '/fixture/original', workspace: undefined,
  liveAgent: true, actionable: true, lastActivityAt: null, processState: 'running', runId: 'original-run', workingEnteredAt: null
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
  await act(async () => root.render(createElement(FocusToolbar, { children: createElement('input', { 'aria-label': 'Search contexts' }), selectedId: selected.id, selected, tab: null, onReview: review, onCloseWorkspace: () => owners.focusExecutionSession(null) })))
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

it('a mouse-only hover after an identity keyboard Escape preserves the newly focused editor through Escape', async () => {
  await open('keyboard'); await escapeMenu(); expect(document.activeElement).toBe(identity())
  const editor = container.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!
  expect(editor).toBeTruthy(); editor.focus()
  const more = trigger()
  await act(async () => more.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, cancelable: true, pointerType: 'mouse', buttons: 0, button: 0 })))
  await settle()
  expect(document.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0)
  expect(document.querySelector('[role="menu"]')).toBeTruthy()
  expect(document.activeElement).toBe(editor)
  await escapeMenu()
  expect(document.activeElement).toBe(editor)
})
it('the identity ContextMenu key uses the controlled existing dropdown and restores the identity', async () => {
  const origin=identity(); origin.focus()
  await act(async () => origin.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ContextMenu' })))
  await settle()
  expect(document.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0)
  await escapeMenu(); expect(document.activeElement).toBe(origin)
})
it('a mouse-only hover action keeps its selected destination without a second opening click', async () => {
  const editor = container.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!
  expect(editor).toBeTruthy(); editor.focus()
  await act(async () => trigger().dispatchEvent(new PointerEvent('pointerover', { bubbles: true, cancelable: true, pointerType: 'mouse', buttons: 0, button: 0 })))
  await settle()
  expect(document.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0)
  expect(document.activeElement).toBe(editor)
  await pick('Review request')
  expect(review).toHaveBeenCalledTimes(1); expect(document.activeElement).toBe(destination)
})

it.each(['F10', 'ContextMenu'] as const)('natural hover close followed by identity %s opens a keyboard-operable focused menu', async key => {
  const editor = container.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!
  expect(editor).toBeTruthy(); editor.focus()
  const more=trigger()
  await act(async () => more.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, cancelable: true, pointerType: 'mouse', buttons: 0, button: 0 })))
  await settle()
  const content=document.querySelector<HTMLElement>('[role="menu"]')!
  expect(content).toBeTruthy(); expect(document.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0)
  await act(async () => {
    more.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', buttons: 0, relatedTarget: content }))
    content.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0, relatedTarget: more }))
    content.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', buttons: 0, relatedTarget: editor }))
    await new Promise(resolve => setTimeout(resolve, 220))
  })
  await settle(); expect(document.querySelector('[role="menu"]')).toBeNull(); expect(document.activeElement).toBe(editor)
  const origin=identity(); origin.focus()
  await act(async () => origin.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, shiftKey: key==='F10' })))
  await settle()
  const keyboardMenu=document.querySelector<HTMLElement>('[role="menu"]')!
  const items=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  expect(keyboardMenu).toBeTruthy(); expect(items.length).toBeGreaterThan(0)
  expect([keyboardMenu,...items]).toContain(document.activeElement)
  const initial=document.activeElement
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key:'ArrowDown' })))
  await settle()
  expect(items).toContain(document.activeElement)
  expect(document.activeElement).not.toBe(initial)
})
