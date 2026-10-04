// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { resolve } from 'node:path'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { FocusToolbar } from '../src/renderer/src/components/FocusToolbar'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { executionFocusPresentation } from '../src/renderer/src/lib/focus-tab-projection'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
const baseline = useAppStore.getState()
let root: Root, container: HTMLDivElement, id: string
const tabId = 'accurate-focus-tab', originalTabName = 'Working surface · release review'
function FocusFixture() {
  const state = useAppStore()
  const presentation = executionFocusPresentation(state.agentFocus.execution, state.tabs, spatialCatalog(state, []), reference => useAppStore.getState().selectExecutionFocusReference(reference, state.agentFocus.execution))
  return createElement(GlobalFocusSurface, { presentation })
}
function ToolbarFixture({ regionOnly = false }: { regionOnly?: boolean }) {
  const tab = useAppStore(state => state.tabs[tabId])
  return createElement(FocusToolbar, { children: null, selectedId: id, selected: undefined, tab: tab ?? null, regionOnly, onReview() {}, onCloseWorkspace() {} })
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const input = await api.config.get(), snapshot = await api.sessions.snapshot()
  const config = { ...input, workspaces: input.workspaces.map(workspace => ({ ...workspace, path: resolve(workspace.path) })) }
  const sessions = snapshot.sessions.map(session => ({ ...session, workspacePath: resolve(session.workspacePath) }))
  id = sessions.find(session => session.kind === 'agent')!.id
  const workspace = config.workspaces.find(workspace => workspace.path === sessions.find(session => session.id === id)!.workspacePath)!
  const tab = createWorkbenchTab(tabId, { regionId: 'accurate-region', kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: id }, originalTabName)
  const decoy = createWorkbenchTab('decoy-tab', { regionId: 'decoy-region', kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: id }, 'Neighbor Tab')
  useAppStore.setState({ ...baseline, config, sessions, timelines: {}, tabs: { [tab.id]: tab, [decoy.id]: decoy }, layouts: { [workspace.id]: createWorkspaceLayout('exact-group', [decoy.id, tab.id]) }, activeWorkspaceId: workspace.id, agentNames: { [id]: 'Agent task · distinct from Tab' }, mainSurface: 'agents', agentFocus: { execution: { sessionId: id, history: [], reference: { displayWorkspaceId: workspace.id, groupId: 'exact-group', tabId, regionId: 'accurate-region' } }, pmo: { sessionId: null } } }, true)
  await act(async () => root.render(createElement(FocusFixture)))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(baseline, true); vi.restoreAllMocks() })
async function pick(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === label)!
  expect(item, label).toBeTruthy(); await act(async () => item.click())
}
async function inputValue(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Rename Tab"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
  return input
}
it('titles and renames the exact Tab through its owner while preserving Agent and neighbor identities', async () => {
  const toolbar = container.querySelector('.focus-toolbar')!
  expect(toolbar.parentElement).toBe(container.querySelector('.global-focus-surface'))
  expect(toolbar.querySelector('[aria-label="Search contexts"]')).toBeTruthy()
  const identity = toolbar.querySelector<HTMLButtonElement>('.focus-toolbar__identity')!
  expect(identity).toBeTruthy(); expect(container.querySelector('.global-focus-layout header.focus-toolbar')).toBeNull()
  expect(identity.querySelector('strong')!.textContent).toBe(originalTabName)
  const before = useAppStore.getState(), beforeFocus = before.agentFocus
  await act(async () => identity.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 200, clientY: 18 })))
  await pick('Rename Tab')
  const input = await inputValue('Fix scroll and loading')
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })))
  expect(useAppStore.getState().tabs[tabId]!.name).toBe('Fix scroll and loading')
  expect(useAppStore.getState().tabs['decoy-tab']).toBe(before.tabs['decoy-tab'])
  expect(useAppStore.getState().agentNames).toBe(before.agentNames)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(container.querySelector('.focus-toolbar__identity strong')!.textContent).toBe('Fix scroll and loading')
  expect(container.querySelector(`[data-session-id="${id}"] strong`)!.textContent).toBe('Agent task · distinct from Tab')
  expect(useAppStore.getState().agentFocus).toBe(beforeFocus)
})
it('direct Space control uses the existing navigation owner and close only dismisses observation', async () => {
  const selectSession = vi.fn(); await act(async () => useAppStore.setState({ selectSession }))
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="View in Space"]')!.click())
  expect(useAppStore.getState().mainSurface).toBe('workbench'); expect(selectSession).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentFocus.execution.reference?.tabId).toBe(tabId)
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(id)
  const sessions = useAppStore.getState().sessions
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close Focus workspace"]')!.click())
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBeNull(); expect(useAppStore.getState().sessions).toBe(sessions)
})
it('Escape cancels inline rename while blur commits a user name including spaces', async () => {
  const open = async () => { await act(async () => container.querySelector<HTMLButtonElement>('.focus-toolbar__identity')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ContextMenu' }))); await pick('Rename Tab') }
  await open(); let input = await inputValue('Discard this')
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })))
  expect(useAppStore.getState().tabs[tabId]!.name).toBe(originalTabName)
  await open(); input = await inputValue('Keep this name')
  await act(async () => input.blur())
  expect(useAppStore.getState().tabs[tabId]!.name).toBe('Keep this name')
})
it('clearing the search restores the same nonempty card set without changing execution focus', async () => {
  const originalIds = [...container.querySelectorAll<HTMLElement>('.focus-context[data-session-id]')].map(card => card.dataset.sessionId)
  expect(originalIds.length).toBeGreaterThan(0)
  const originalFocus = useAppStore.getState().agentFocus
  const originalSessions = useAppStore.getState().sessions
  const originalWorkspace = container.querySelector('.focused-tab-workspace')
  expect(originalWorkspace).not.toBeNull()
  const search = container.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!
  expect(search).not.toBeNull()
  async function query(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, value)
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  await query('no-context-matches-this-query')
  expect(container.querySelectorAll('.focus-context[data-session-id]')).toHaveLength(0)
  expect(container.querySelector('.focus-project-lanes__empty')?.textContent).toBe('No matching contexts')
  expect(useAppStore.getState().agentFocus).toBe(originalFocus)
  await query('')
  expect(search.value).toBe('')
  expect([...container.querySelectorAll<HTMLElement>('.focus-context[data-session-id]')].map(card => card.dataset.sessionId)).toEqual(originalIds)
  expect(container.querySelector('.focus-project-lanes__empty')).toBeNull()
  expect(useAppStore.getState().agentFocus).toBe(originalFocus)
  expect(useAppStore.getState().sessions).toBe(originalSessions)
  expect(container.querySelector('.focused-tab-workspace')).toBe(originalWorkspace)
})
it('keeps an explicit Tab title through Agent rename and clearing restores the single-Agent derivation', async () => {
  await act(async () => useAppStore.getState().renameAgent(id, 'Current Agent task'))
  expect(container.querySelector('.focus-toolbar__identity strong')!.textContent).toBe(originalTabName)
  await act(async () => container.querySelector<HTMLButtonElement>('.focus-toolbar__identity')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ContextMenu' })))
  await pick('Rename Tab')
  const input = await inputValue('   ')
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })))
  expect(useAppStore.getState().tabs[tabId]!.name).toBeUndefined()
  expect(container.querySelector('.focus-toolbar__identity strong')!.textContent).toBe('Current Agent task')
})
it('uses the multi-Agent family name and retains Tab identity in an explicit single-Region presentation', async () => {
  const state = useAppStore.getState(), other = state.sessions.find(session => session.kind === 'agent' && session.id !== id)!
  const { name: _name, ...unnamed } = state.tabs[tabId]!
  const tab = addWorkbenchRegion(unnamed, 'accurate-region', 'right', { regionId: 'second-agent-region', kind: 'agent', phase: 'attached', workspaceId: unnamed.workspaceId, sessionId: other.id })
  await act(async () => { useAppStore.setState({ tabs: { ...state.tabs, [tabId]: tab }, agentNames: { ...state.agentNames, [other.id]: 'Second review task' } }); root.render(createElement(ToolbarFixture, { regionOnly: true })) })
  expect(container.querySelector('.focus-toolbar__identity strong')!.textContent).toBe('Claude · Codex')
  await act(async () => useAppStore.getState().renameTab(tabId, 'Full Tab in a Region view'))
  expect(container.querySelector('.focus-toolbar__identity strong')!.textContent).toBe('Full Tab in a Region view')
})
it('derives a non-Agent Tab title from its File while the execution Agent remains held', async () => {
  const state = useAppStore.getState(), tab = createWorkbenchTab(tabId, { regionId: 'file-region', kind: 'file', workspaceId: state.tabs[tabId]!.workspaceId, path: 'notes/release-review.md' })
  await act(async () => { useAppStore.setState({ tabs: { ...state.tabs, [tabId]: tab } }); root.render(createElement(ToolbarFixture)) })
  expect(container.querySelector('.focus-toolbar__identity strong')!.textContent).toBe('release-review.md')
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(id)
})
it('keeps the service identity readable without offering an unproven Tab rename', async () => {
  await act(async () => { useAppStore.setState({ tabs: {} }); root.render(createElement(ToolbarFixture)) })
  expect(container.querySelector('.focus-toolbar__identity strong')!.textContent).toBe('Session awaiting recovery')
  await act(async () => container.querySelector<HTMLButtonElement>('.focus-toolbar__identity')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ContextMenu' })))
  expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).not.toContain('Rename Tab')
})
