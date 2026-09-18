// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createWorkspaceLayout } from '@agentmux/layout'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts'

// Real Focus, Toolbar, Radix menus and Store navigation are consumed. These
// independent leaves do not qualify native geometry, PTY input or timeline data.
vi.mock('../src/renderer/src/lib/use-focus-hierarchy', () => ({ useFocusHierarchy: () => ({ facts: { topics: {}, worktrees: [] }, errors: [] }) }))
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'

const session = {
  id: 'original-terminal', kind: 'terminal', hostId: 'local', workspacePath: '/original', label: 'Original Terminal',
  createdAt: 1, updatedAt: 1, processState: 'running', latestOutputBytes: 0,
  status: { state: 'running', source: 'run-process', observedAt: 1 },
  control: { kind: 'terminal', hostId: 'local', runId: 'original-terminal', run: { runId: 'original-terminal' } }
} as SessionSnapshot
const terminal = { regionId: 'original-region', kind: 'terminal', phase: 'attached', workspaceId: 'original', sessionId: session.id } as const
// The stale pre-navigation active Region is a file. Continue must read the
// actual canonical destination after selectSession activates the Terminal.
const originalTab = addWorkbenchRegion(createWorkbenchTab('original-tab', terminal), terminal.regionId, 'right', {
  regionId: 'file-region', kind: 'file', workspaceId: 'original', path: 'notes.txt'
})
const originalLayout = createWorkspaceLayout('original-group', [originalTab.id])
const context = { execution: { sessionId: session.id, history: [{ sessionId: session.id, focusedAt: 1 }] }, pmo: { sessionId: null } }
const baseline = useAppStore.getState()
let root: Root, container: HTMLDivElement, outside: HTMLButtonElement
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); outside = document.createElement('button')
  outside.textContent = 'Other input owner'; document.body.append(container, outside)
  root = createRoot(container)
  useAppStore.setState({
    config: { workspaces: [{ id: 'original', name: 'Original workspace', hostId: 'local', path: '/original', kind: 'folder' }] } as never,
    sessions: [session], tabs: { [originalTab.id]: originalTab },
    layouts: { original: originalLayout, other: createWorkspaceLayout('other-group') },
    activeWorkspaceId: 'other', mainSurface: 'agents', agentFocus: context,
    agentComposerDrafts: { [session.id]: 'Keep original draft' }, closingWorkbenchViews: {}, regionCaretFocus: null
  })
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  expect(container.querySelectorAll('.focus-context')).toHaveLength(1)
  expect(container.querySelector('#focus-workspace-slot')).toBeTruthy()
})
afterEach(async () => {
  await act(async () => root.unmount()); await settle()
  container.remove(); outside.remove(); document.getElementById('agentmux-window-overlay-host')?.remove()
  useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

async function menu(kind: 'dropdown' | 'context' = 'dropdown') {
  const origin = container.querySelector<HTMLButtonElement>(kind === 'dropdown' ? '[aria-label="Focus context actions"]' : '.focus-toolbar__identity')!
  expect(origin).toBeTruthy(); origin.focus()
  await act(async () => origin.dispatchEvent(kind === 'dropdown'
    ? new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' })
    : new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 120, clientY: 18 })))
  await settle()
  expect(document.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0)
}
async function pick(label: string) {
  const matches = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(item => item.textContent === label)
  expect(matches).toHaveLength(1)
  await act(async () => matches[0]!.click()); await settle()
  expect(document.querySelector('[role="menu"]')).toBeNull()
}
function retainedWorkface() {
  const state = useAppStore.getState()
  expect(state.sessions).toEqual([session])
  expect(Object.keys(state.tabs)).toEqual([originalTab.id])
  expect(state.tabs[originalTab.id]?.regions).toEqual(originalTab.regions)
  expect(state.tabs[originalTab.id]?.layout.root).toEqual(originalTab.layout.root)
  expect(state.agentComposerDrafts).toEqual({ [session.id]: 'Keep original draft' })
}

it('Continue sends the existing caret intent to the actual canonical active Region after navigation', async () => {
  expect(originalTab.layout.activeRegionId).toBe('file-region')
  await menu(); await pick('Continue in Space')
  const state = useAppStore.getState()
  expect(state.mainSurface).toBe('workbench'); expect(state.activeWorkspaceId).toBe('original')
  expect(state.layouts.original?.groups.find(group => group.id === state.layouts.original?.activeGroupId)?.activeTabId).toBe(originalTab.id)
  expect(state.tabs[originalTab.id]?.layout.activeRegionId).toBe(terminal.regionId)
  expect(state.regionCaretFocus).toEqual({ regionId: terminal.regionId, nonce: expect.any(Number) })
  expect(state.agentFocus.execution.sessionId).toBe(session.id)
  retainedWorkface()
})

it('Continue for an awaiting recovery identity does not hand input to another healthy Session', async () => {
  await act(async () => {
    useAppStore.setState({ activeWorkspaceId: 'original' })
    useAppStore.getState().focusRegion('original', originalTab.id, terminal.regionId, 'pointer')
    useAppStore.getState().focusExecutionSession('awaiting-recovery')
  })
  expect(useAppStore.getState().sessions.map(item => item.id)).toEqual([session.id])
  expect(container.querySelector('.focus-toolbar__identity')?.textContent).toContain('Session awaiting recovery')
  expect(container.querySelector('.global-session-workspace__empty')).toBeTruthy()
  await menu(); await pick('Continue in Space')
  const state = useAppStore.getState()
  expect(state.mainSurface).toBe('workbench')
  expect(state.tabs[originalTab.id]?.layout.activeRegionId).toBe(terminal.regionId)
  expect(state.regionCaretFocus).toBeNull()
  expect(state.agentFocus.execution.sessionId).toBe('awaiting-recovery')
  retainedWorkface()
})

it.each(['dropdown', 'context', 'button'] as const)('explicit %s Close returns to the surviving search input after the Context unmounts', async kind => {
  if (kind === 'button') {
    const close = container.querySelector<HTMLButtonElement>('[aria-label="Close Focus workspace"]')!
    expect(close).toBeTruthy(); close.focus(); await act(async () => close.click()); await settle()
  } else { await menu(kind); await pick('Close Focus workspace') }
  const search = container.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!
  expect(search).toBeTruthy(); expect(document.activeElement).toBe(search)
  expect(container.querySelector('.focus-toolbar__context')).toBeNull()
  expect(container.querySelector('#focus-workspace-slot')).toBeNull()
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBeNull()
  expect(useAppStore.getState().mainSurface).toBe('agents')
  expect(useAppStore.getState().regionCaretFocus).toBeNull()
  retainedWorkface()
})

it('a different owner clearing the selection does not move its input focus to Search', async () => {
  outside.focus()
  await act(async () => useAppStore.getState().focusExecutionSession(null)); await settle()
  expect(container.querySelector('.focus-toolbar__context')).toBeNull()
  expect(document.activeElement).toBe(outside)
  retainedWorkface()
})

it('ordinary pointer selection and low-level Space navigation keep their existing no-caret contract', async () => {
  await act(async () => useAppStore.getState().setMainSurface('workbench'))
  expect(useAppStore.getState().tabs[originalTab.id]?.layout.activeRegionId).toBe(terminal.regionId)
  expect(useAppStore.getState().regionCaretFocus).toBeNull()
  await act(async () => useAppStore.getState().focusRegion('original', originalTab.id, 'file-region', 'pointer'))
  expect(useAppStore.getState().tabs[originalTab.id]?.layout.activeRegionId).toBe('file-region')
  expect(useAppStore.getState().regionCaretFocus).toBeNull()
  retainedWorkface()
})
