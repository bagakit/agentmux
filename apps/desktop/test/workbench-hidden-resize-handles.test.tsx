// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createMoteApp, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultAgent, defaultTab, neighborTab } from './fixtures/mote-workface'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { useAppStore } from '../src/renderer/src/store'

// Exercise the installed browser library and its actual registration effects.
// No Panel, handle, layout writer or input owner is replaced by a test double.
vi.mock('react-resizable-panels', async () => vi.importActual<typeof import('react-resizable-panels')>(
  '../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.esm.js'
))

let app: MoteAppFixture
beforeEach(() => { app = createMoteApp() })
afterEach(async () => { await app.dispose() })

function ratios() {
  const state = useAppStore.getState(), outer = state.layouts[SCRATCH_WORKSPACE_ID]!.root
  const inner = state.tabs[defaultTab.id]!.layout.root
  expect(outer.type).toBe('split'); expect(inner.type).toBe('split')
  if (outer.type !== 'split' || inner.type !== 'split') throw new Error('Expected both actual nonempty public splits')
  return { outer: outer.ratio, inner: inner.ratio }
}
async function arrow(handle: HTMLElement) {
  const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
  await act(async () => handle.dispatchEvent(event)); await settleMoteApp()
  return event
}

it('unregisters hidden public Group and Region resize handles and restores their original visible keyboard controls', async () => {
  const state = useAppStore.getState(), first = state.layouts[SCRATCH_WORKSPACE_ID]!
  const second = createWorkspaceLayout('second-visible-group', [neighborTab.id])
  useAppStore.setState({ layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: { ...first,
    root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: first.root, second: second.root },
    groups: [...first.groups.map(group => ({ ...group, tabOrder: group.tabOrder.filter(id => id !== neighborTab.id) })), ...second.groups] } } })
  // The production Store makes the original Tab's real Region split.
  useAppStore.getState().splitRegion(SCRATCH_WORKSPACE_ID, defaultTab.id, defaultTab.layout.activeRegionId, 'right')
  await app.mount()
  const scope = app.container.querySelector<HTMLElement>('.workspace-workbench-slot[data-workspace-id="' + SCRATCH_WORKSPACE_ID + '"]')!
  expect(scope).not.toBeNull()
  const outer = scope.querySelector<HTMLElement>('.pane-resize-handle')!
  const inner = scope.querySelector<HTMLElement>('.workbench-region-resize-handle')!
  const input = scope.querySelector<HTMLElement>('[aria-label="Message Agent"]')!
  expect(outer).not.toBeNull(); expect(inner).not.toBeNull(); expect(input).not.toBeNull()
  expect(input.textContent).toContain('Default unsent')
  const original = useAppStore.getState(), drafts = original.agentComposerDrafts, sessions = original.sessions
  const runs = sessions.map(session => session.control.run), before = ratios()
  expect(outer.dataset.panelResizeHandleEnabled).toBe('true')
  expect(inner.dataset.panelResizeHandleEnabled).toBe('true')

  await act(async () => useAppStore.getState().setMainSurface('board')); await settleMoteApp()
  expect(scope.getAttribute('aria-hidden')).toBe('true')
  expect(scope.hasAttribute('inert')).toBe(true)
  for (const handle of [outer, inner]) {
    expect(handle.isConnected).toBe(true)
    // The real library's disabled effect removes keyboard registration as well
    // as pointer registration. Chromium proves the actual pointer hit boundary.
    expect((await arrow(handle)).defaultPrevented).toBe(false)
    expect(handle.dataset.panelResizeHandleEnabled).toBe('false')
  }
  expect(ratios()).toEqual(before)
  expect(scope.querySelector('[aria-label="Message Agent"]')).toBe(input)

  await act(async () => useAppStore.getState().selectSession(defaultAgent.id)); await settleMoteApp()
  expect(scope.getAttribute('aria-hidden')).toBe('false')
  expect(scope.hasAttribute('inert')).toBe(false)
  expect(scope.querySelector('.pane-resize-handle')).toBe(outer)
  expect(scope.querySelector('.workbench-region-resize-handle')).toBe(inner)
  for (const handle of [outer, inner]) {
    expect(handle.dataset.panelResizeHandleEnabled).toBe('true')
    expect((await arrow(handle)).defaultPrevented).toBe(true)
  }
  const after = ratios()
  expect(after.outer).toBeGreaterThan(before.outer); expect(after.inner).toBeGreaterThan(before.inner)
  expect(scope.querySelector('[aria-label="Message Agent"]')).toBe(input)
  expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
  expect(useAppStore.getState().sessions).toBe(sessions)
  expect(useAppStore.getState().sessions.map(session => session.control.run)).toEqual(runs)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})
