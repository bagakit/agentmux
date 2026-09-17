// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
const baseline = useAppStore.getState()
let root: Root, container: HTMLDivElement, id: string
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const config = await api.config.get(), { sessions } = await api.sessions.snapshot()
  id = sessions.find(session => session.kind === 'agent')!.id
  useAppStore.setState({ config, sessions, timelines: {}, tabs: {}, agentNames: {}, mainSurface: 'agents', agentFocus: { execution: { sessionId: id, history: [] }, pmo: { sessionId: null } } })
  await act(async () => root.render(createElement(GlobalFocusSurface)))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(baseline, true); vi.restoreAllMocks() })
async function pick(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === label)!
  expect(item, label).toBeTruthy(); await act(async () => item.click())
}
async function inputValue(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Rename Focus context"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
  return input
}
it('places filters and selected identity in one toolbar, right-click renames through the original owner', async () => {
  const toolbar = container.querySelector('.focus-toolbar')!
  expect(toolbar.parentElement).toBe(container.querySelector('.global-focus-surface'))
  expect(toolbar.querySelector('[aria-label="Search contexts"]')).toBeTruthy()
  const identity = toolbar.querySelector<HTMLButtonElement>('.focus-toolbar__identity')!
  expect(identity).toBeTruthy(); expect(container.querySelector('.global-focus-layout header.focus-toolbar')).toBeNull()
  const beforeFocus = useAppStore.getState().agentFocus
  await act(async () => identity.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 200, clientY: 18 })))
  await pick('Rename Agent')
  const input = await inputValue('Fix scroll and loading')
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })))
  expect(useAppStore.getState().agentNames[id]).toBe('Fix scroll and loading')
  expect(container.querySelector('.focus-toolbar__identity strong')!.textContent).toBe('Fix scroll and loading')
  expect(container.querySelector(`[data-session-id="${id}"] strong`)!.textContent).toBe('Fix scroll and loading')
  expect(useAppStore.getState().agentFocus).toBe(beforeFocus)
})
it('keyboard menu continues in Space through the existing navigation owner and close only dismisses observation', async () => {
  const identity = container.querySelector<HTMLButtonElement>('.focus-toolbar__identity')!
  const selectSession = vi.fn(); await act(async () => useAppStore.setState({ selectSession }))
  await act(async () => identity.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'F10', shiftKey: true })))
  await pick('Continue in Space')
  expect(useAppStore.getState().mainSurface).toBe('workbench'); expect(selectSession).toHaveBeenCalledWith(id)
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(id)
  const sessions = useAppStore.getState().sessions
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close Focus workspace"]')!.click())
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBeNull(); expect(useAppStore.getState().sessions).toBe(sessions)
})
it('Escape cancels inline rename while blur commits a user name including spaces', async () => {
  const open = async () => { await act(async () => container.querySelector<HTMLButtonElement>('.focus-toolbar__identity')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ContextMenu' }))); await pick('Rename Agent') }
  await open(); let input = await inputValue('Discard this')
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })))
  expect(useAppStore.getState().agentNames[id]).toBeUndefined()
  await open(); input = await inputValue('Keep this name')
  await act(async () => input.blur())
  expect(useAppStore.getState().agentNames[id]).toBe('Keep this name')
})
