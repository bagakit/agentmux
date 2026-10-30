// @vitest-environment happy-dom
import * as Menu from '@radix-ui/react-context-menu'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TerminalMenuTools, type TerminalMenuToolProps } from '../src/renderer/src/components/TerminalMenuTools'
import { terminalSelectionSuppressionHint } from '../src/renderer/src/lib/terminal-selection-mode'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'

const history = 'The full-screen buffer has no terminal scrollback. Earlier output depends on the application’s history controls.'
let root: Root, container: HTMLDivElement, props: TerminalMenuToolProps
const current = () => document.querySelector<HTMLElement>('[data-terminal-density-menu]')!
function item(label: string, scope: ParentNode = current()) {
  const found = [...scope.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => (node.getAttribute('aria-label') ?? node.textContent)?.trim() === label)
  expect(found, `Actual ${label} action`).toBeDefined()
  return found!
}
async function mount() {
  await act(async () => root.render(<Menu.Root><Menu.Trigger asChild><button>Original terminal</button></Menu.Trigger>
    <Menu.Portal><Menu.Content data-terminal-density-menu=""><TerminalMenuTools {...props} /></Menu.Content></Menu.Portal>
  </Menu.Root>))
  const trigger = container.querySelector('button')!
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 40 })) })
  await vi.waitFor(() => expect(current()).not.toBeNull())
}
async function information() {
  const trigger = item('Terminal info')
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })) })
  let content: HTMLElement | null = null
  await vi.waitFor(() => { content = document.getElementById(trigger.getAttribute('aria-controls')!); expect(content).not.toBeNull() })
  return { trigger, content: content! }
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  props = { hasSelection: false, mouseTrackingMode: 'any', historyBoundary: history, pathActions: [],
    onCopy: vi.fn(), onPaste: vi.fn(), onSelectAll: vi.fn(), onSearch: vi.fn(), onCopyViewport: vi.fn(),
    onCopyScrollback: vi.fn(), onScrollToBottom: vi.fn(), onClear: vi.fn() }
})
afterEach(async () => {
  await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

it('keeps complete selection and history explanations behind one keyboard-readable entry', async () => {
  await mount()
  expect(current().querySelector('[role="note"]')).toBeNull()
  expect(current().textContent).not.toContain(history)
  const info = await information()
  expect([...info.content.querySelectorAll('[role="note"]')].map(node => node.textContent)).toEqual([
    terminalSelectionSuppressionHint('any'), history
  ])
  await act(async () => info.content.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })))
  await vi.waitFor(() => expect(info.content.isConnected).toBe(false))
  expect(document.activeElement).toBe(info.trigger)
  await act(async () => item('Copy visible output').click())
  expect(props.onCopyViewport).toHaveBeenCalledOnce()
  expect(props.onCopy).not.toHaveBeenCalled()
})

it('omits the information entry when the original terminal has no contextual explanation', async () => {
  props = { ...props, mouseTrackingMode: 'none', historyBoundary: null }
  await mount()
  const labels = [...current().querySelectorAll('[role="menuitem"]')].map(node => node.getAttribute('aria-label') ?? node.textContent)
  expect(labels).toEqual(['Copy', 'Paste', 'Select all', 'Find', 'Copy visible output', 'Copy all output', 'Scroll to bottom', 'Clear terminal'])
  expect(current().querySelector('[role="note"]')).toBeNull()
})

it.each([
  ['Copy', 'onCopy'], ['Paste', 'onPaste'], ['Select all', 'onSelectAll'], ['Find', 'onSearch'],
  ['Copy visible output', 'onCopyViewport'], ['Copy all output', 'onCopyScrollback'],
  ['Scroll to bottom', 'onScrollToBottom'], ['Clear terminal', 'onClear']
] as const)('keeps %s at the root with its original callback', async (label, callback) => {
  props = { ...props, hasSelection: true }
  await mount()
  const action = item(label)
  expect(action.closest('[role="menu"]')).toBe(current())
  await act(async () => action.click())
  expect(props[callback]).toHaveBeenCalledOnce()
})

it('keeps the original path action direct and output copy available without a selection', async () => {
  const open = vi.fn()
  props.pathActions = [{ key: 'reveal', label: 'Reveal original file', title: 'src/original.txt', icon: () => <svg />, onSelect: open }]
  await mount()
  expect(item('Copy').hasAttribute('data-disabled')).toBe(true)
  expect(item('Copy visible output').hasAttribute('data-disabled')).toBe(false)
  const path = item('Reveal original file')
  expect(path.closest('[role="menu"]')).toBe(current())
  await act(async () => path.click())
  expect(open).toHaveBeenCalledOnce()
  expect(props.onCopy).not.toHaveBeenCalled()
})
