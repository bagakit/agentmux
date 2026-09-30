// @vitest-environment happy-dom
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { act, createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { createWorkspaceLayout, splitWorkbenchRegion, type WorkspaceLayout } from '@agentmux/layout'
// Use the installed browser primary, as in the existing mounted Workbench fixtures.
// This retains real Panel/PanelGroup registration and layout behavior in happy-dom.
vi.mock('react-resizable-panels', () => createRequire(import.meta.url)(
  '../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
const leaves = vi.hoisted(() => ({ mounts: [] as string[], unmounts: [] as string[] }))
// Only the PTY/Agent painting leaf is isolated. App, GlobalFocusSurface, Store,
// WorkspaceWorkbench, StableWorkbenchView and their projection callers are real.
vi.mock('../src/renderer/src/components/SessionPane', () => ({
  SessionPane: ({ sessionId, linkOrigin }: {
    sessionId: string
    linkOrigin: { workspaceId: string; tabGroupId: string; tabId: string; regionId: string }
  }) => {
    const key = `${linkOrigin.tabId}/${linkOrigin.regionId}`
    useEffect(() => { leaves.mounts.push(key); return () => { leaves.unmounts.push(key) } }, [key])
    const draft = useAppStore(state => state.agentComposerDrafts[sessionId] ?? '')
    return createElement('section', { 'data-fixture-session': sessionId,
      'data-resource-workspace': linkOrigin.workspaceId, 'data-owner-group': linkOrigin.tabGroupId,
      'data-owner-tab': linkOrigin.tabId, 'data-owner-region': linkOrigin.regionId },
    createElement('textarea', { 'aria-label': `Original draft ${key}`, value: draft, readOnly: true }))
  }
}))
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { restoreAgentFocus, sanitizeAgentFocus } from '../src/renderer/src/lib/agent-focus'
import { workbenchProjectionSlotId } from '../src/renderer/src/lib/workbench-projection'
import { installNativePopover } from './fixtures/mote-workface'

const initial = useAppStore.getState()
const owningSources = [
  'apps/desktop/src/renderer/src/App.tsx',
  'apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx',
  'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx',
  'apps/desktop/src/renderer/src/components/StableWorkbenchView.tsx',
  'apps/desktop/src/renderer/src/lib/focus-tab-projection.ts',
  'apps/desktop/src/renderer/src/store.ts'
] as const
const identity = () => Object.fromEntries(owningSources.map(path => [path,
  createHash('sha256').update(readFileSync(resolve(process.cwd(), path))).digest('hex')]))

it('actual App → Focus retains the explicit non-first Tab/Group/Region occurrence without navigating primary Space', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.localStorage.clear()
  leaves.mounts = []; leaves.unmounts = []
  const restorePopover = installNativePopover()
  const sourceBefore = identity()
  const originalConfig = await api.config.get()
  const snapshot = await api.sessions.snapshot()
  const previewSession = snapshot.sessions.find(item => item.id === 'session-codex')!
  expect(previewSession).toBeDefined()
  expect(previewSession.kind).toBe('agent')
  const previewResource = originalConfig.workspaces.find(item => item.id === 'workspace-demo')!
  expect(previewResource).toBeDefined()
  // The web preview's "home//agentmux" is a preview-relative path. Arrange an
  // explicit absolute private resource for the existing public Space contract;
  // retain this typed preview Session's original control/Run, not a new Runtime.
  const resource = { ...previewResource, path: '/private/resource-a' }
  const session = { ...previewSession, workspacePath: resource.path }
  const display = { ...resource, id: 'display-b', name: 'Display B', path: '/private/display-b', kind: 'folder' as const }
  const config = { ...originalConfig, workspaces: [resource, display] }
  const decoy = createWorkbenchTab('decoy-first-tab', {
    regionId: 'decoy-region', workspaceId: resource.id, kind: 'agent', phase: 'attached', sessionId: session.id
  }, 'Inserted first, same Session')
  const exact = createWorkbenchTab('explicit-exact-tab', {
    regionId: 'exact-r1', workspaceId: resource.id, kind: 'agent', phase: 'attached', sessionId: session.id
  }, 'Exact occurrence')
  exact.regions['exact-r2'] = { regionId: 'exact-r2', workspaceId: resource.id,
    kind: 'agent', phase: 'attached', sessionId: session.id }
  exact.layout = splitWorkbenchRegion(exact.layout, 'exact-r1', 'right', 'exact-r2')
  const firstDisplay = createWorkspaceLayout('display-first-group', [exact.id])
  const displayLayout: WorkspaceLayout = { ...firstDisplay,
    root: { type: 'split', direction: 'horizontal', ratio: 0.5,
      first: firstDisplay.root, second: { type: 'leaf', groupId: 'display-exact-group' } },
    groups: [...firstDisplay.groups, { ...firstDisplay.groups[0]!, id: 'display-exact-group' }],
    activeGroupId: 'display-first-group' }
  useAppStore.setState({ ...initial, initialize: async () => () => {}, loading: false, config,
    sessions: [session], tabs: { [decoy.id]: decoy, [exact.id]: exact },
    layouts: { [resource.id]: createWorkspaceLayout('resource-home-group', [decoy.id, exact.id]),
      [display.id]: displayLayout },
    mainSurface: 'workbench', activeWorkspaceId: resource.id,
    toolsOpen: false, projectRailOpen: false,
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } },
    agentComposerDrafts: { [session.id]: 'Unsent original draft' } }, true)
  const requested = { displayWorkspaceId: display.id, groupId: 'display-exact-group',
    tabId: exact.id, regionId: 'exact-r2' }
  const catalogBefore = spatialCatalog(useAppStore.getState(), [])
  // Real catalog inputs contain both exact locations and both Regions. The test
  // does not pass a guessed projection prop or replace the production projection.
  expect(catalogBefore.locations.filter(item => item.tabId === exact.id && item.displayWorkspaceId === display.id)
    .map(item => [item.groupId, item.regionId])).toEqual([
      ['display-first-group', 'exact-r1'], ['display-first-group', 'exact-r2'],
      ['display-exact-group', 'exact-r1'], ['display-exact-group', 'exact-r2']
    ])
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const controls = { stop: vi.spyOn(api.sessions, 'stop'), resume: vi.spyOn(api.sessions, 'resume'),
    launch: vi.spyOn(api.sessions, 'launchAgent'), write: vi.spyOn(api.sessions, 'write'),
    interrupt: vi.spyOn(api.sessions, 'interrupt') }
  const reads = { page: vi.spyOn(api.sessions, 'historyPage'), timeline: vi.spyOn(api.sessions, 'timeline'),
    sources: vi.spyOn(api.sessions, 'historySources') }
  let actual: unknown = null
  let preservation: unknown = null
  let phase = 'prepare'
  try {
    await act(async () => root.render(createElement(App)))
    expect(container.querySelector('main.main-shell')).not.toBeNull()
    expect(container.querySelectorAll('[data-fixture-session]')).toHaveLength(3)
    phase = 'existing-exact-entry'
    // These are existing production user operations, not proposed Store fields.
    await act(async () => useAppStore.getState().focusRegion(display.id, exact.id, requested.regionId, 'pointer', requested.groupId))
    const primary = useAppStore.getState()
    expect(primary.layouts[display.id]!.activeGroupId).toBe(requested.groupId)
    expect(primary.tabs[exact.id]!.layout.activeRegionId).toBe(requested.regionId)
    expect(primary.activeWorkspaceId).toBe(resource.id)
    const originalMounts = [...leaves.mounts]
    const originalDraft = container.querySelector<HTMLTextAreaElement>(`[data-owner-tab="${exact.id}"][data-owner-region="${requested.regionId}"] textarea`)!
    expect(originalDraft).not.toBeNull()
    expect(originalDraft.value).toBe('Unsent original draft')
    phase = 'focus-entry'
    await act(async () => { useAppStore.getState().focusExecutionSession(session.id); useAppStore.getState().setMainSurface('agents') })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    const focus = container.querySelector<HTMLElement>('.global-focus-surface')!
    const focusSlot = focus?.querySelector<HTMLElement>('.focused-tab-workspace')!
    expect(focus).not.toBeNull()
    expect(focusSlot).not.toBeNull()
    const content = focusSlot.querySelectorAll<HTMLElement>('[data-fixture-session]')
    expect(content.length).toBeGreaterThan(0)
    actual = { selectedTabId: focusSlot.dataset.focusTabId,
      leafAddresses: [...content].map(leaf => ({ resourceWorkspaceId: leaf.dataset.resourceWorkspace,
        groupId: leaf.dataset.ownerGroup, tabId: leaf.dataset.ownerTab, regionId: leaf.dataset.ownerRegion })),
      sourceParent: content[0]!.closest('.retained-workbench-view')?.parentElement?.id,
      executionSessionId: useAppStore.getState().agentFocus.execution.sessionId }
    expect((actual as { sourceParent: string }).sourceParent).toBe(workbenchProjectionSlotId('focus-workbench-slot', requested))
    expect([...focusSlot.querySelectorAll('[data-pane-group-id]')].map(group => group.getAttribute('data-pane-group-id'))).toEqual([requested.groupId])
    expect(focusSlot.querySelector(`[data-pane-group-id="${requested.groupId}"] [data-workbench-region-id="${requested.regionId}"]`)?.classList.contains('workbench-region--active')).toBe(true)
    const focused = useAppStore.getState()
    expect(focused.layouts).toBe(primary.layouts)
    expect(focused.tabs).toBe(primary.tabs)
    expect(focused.activeWorkspaceId).toBe(primary.activeWorkspaceId)
    expect(focused.sessions).toBe(primary.sessions)
    expect(focused.sessions[0]!.control.run.runId).toBe(session.control.run.runId)
    expect(focused.agentComposerDrafts).toBe(primary.agentComposerDrafts)
    expect(leaves.mounts).toEqual(originalMounts)
    expect(leaves.unmounts).toEqual([])
    // Existing Focus close must remove only this presentation, not the entity.
    phase = 'close-focus-only'
    const close = focus.querySelector<HTMLButtonElement>('button[aria-label="Close Focus workspace"]')!
    expect(close).not.toBeNull()
    await act(async () => close.click())
    const afterClose = useAppStore.getState()
    expect(afterClose.agentFocus.execution.sessionId).toBeNull()
    expect(afterClose.layouts).toBe(primary.layouts)
    expect(afterClose.tabs).toBe(primary.tabs)
    expect(afterClose.activeWorkspaceId).toBe(primary.activeWorkspaceId)
    expect(afterClose.sessions).toBe(primary.sessions)
    expect(afterClose.agentComposerDrafts).toBe(primary.agentComposerDrafts)
    expect(originalDraft.isConnected).toBe(true)
    expect(originalDraft.value).toBe('Unsent original draft')
    expect(leaves.mounts).toEqual(originalMounts)
    expect(leaves.unmounts).toEqual([])
    for (const call of Object.values(controls)) expect(call).not.toHaveBeenCalled()
    preservation = { primaryWorkspaceId: primary.activeWorkspaceId,
      displayActiveGroup: primary.layouts[display.id]!.activeGroupId,
      exactTabActiveRegion: primary.tabs[exact.id]!.layout.activeRegionId,
      originalRunId: session.control.run.runId, originalDraft: originalDraft.value,
      sameTabs: afterClose.tabs === primary.tabs, sameLayouts: afterClose.layouts === primary.layouts,
      sameSessions: afterClose.sessions === primary.sessions, sameDrafts: afterClose.agentComposerDrafts === primary.agentComposerDrafts,
      mounts: [...leaves.mounts], unmounts: [...leaves.unmounts] }
    phase = 'semantic-exact-tab-oracle'
    // The first original counter selected the first Tab with this Session.
    expect((actual as { selectedTabId: string }).selectedTabId,
      'Focus must consume the existing exact non-first location instead of the first same-Session Tab').toBe(requested.tabId)
  } finally {
    const sourceAfter = identity()
    if (process.env.AGENTMUX_BINDING_PRESENTATION_REPORT) writeFileSync(process.env.AGENTMUX_BINDING_PRESENTATION_REPORT,
      JSON.stringify({ schema: 'agentmux.shared-workbench-presentation-counter.v1',
        candidateCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        requested, actual, preservation, phase, sourceBefore, sourceAfter,
        sourceUnchanged: JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter),
        controls: Object.fromEntries(Object.entries(controls).map(([key, fn]) => [key, fn.mock.calls.length])),
        reads: Object.fromEntries(Object.entries(reads).map(([key, fn]) => [key, fn.mock.calls.length])),
        conditions: { actualApp: true, actualGlobalFocusSurface: true, actualWorkspaceWorkbench: true,
          actualStableWorkbenchView: true, actualStoreOperations: true, isolatedLeaves: ['SessionPane PTY/Agent painting'],
          browserPanelPrimary: 'installed browser development CJS', webPreviewAPI: true,
          realPTY: false, realRuntime: false, nativeParallelPresentation: false,
          runtimeControls: false, userWorkSurfaceControlled: false } }, null, 2) + '\n')
    await act(async () => root.unmount()); container.remove(); restorePopover()
    useAppStore.setState(initial, true); window.localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  }
})

/** Real App caller fixture; only its PTY painting leaf is isolated above. */
async function presentationFixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.localStorage.clear(); leaves.mounts = []; leaves.unmounts = []
  const restorePopover = installNativePopover()
  const previewConfig = await api.config.get(), snapshot = await api.sessions.snapshot()
  const resource = { ...previewConfig.workspaces.find(item => item.id === 'workspace-demo')!, path: '/private/resource-a' }
  const display = { ...resource, id: 'display-b', name: 'Display B', path: '/private/display-b' }
  const session = { ...snapshot.sessions.find(item => item.id === 'session-codex')!, workspacePath: resource.path }
  const other = snapshot.sessions.find(item => item.id === 'session-claude')!
  expect(session).toBeDefined(); expect(other).toBeDefined()
  const decoy = createWorkbenchTab('decoy-first-tab', { regionId: 'decoy-region', workspaceId: resource.id,
    kind: 'agent', phase: 'attached', sessionId: session.id }, 'Inserted first, same Session')
  const exact = createWorkbenchTab('explicit-exact-tab', { regionId: 'exact-r1', workspaceId: resource.id,
    kind: 'agent', phase: 'attached', sessionId: session.id }, 'Exact occurrence')
  exact.regions['exact-r2'] = { regionId: 'exact-r2', workspaceId: resource.id,
    kind: 'agent', phase: 'attached', sessionId: session.id }
  exact.layout = splitWorkbenchRegion(exact.layout, 'exact-r1', 'right', 'exact-r2')
  const first = createWorkspaceLayout('display-first-group', [exact.id])
  const displayLayout: WorkspaceLayout = { ...first,
    root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: first.root,
      second: { type: 'leaf', groupId: 'display-exact-group' } },
    groups: [...first.groups, { ...first.groups[0]!, id: 'display-exact-group' }], activeGroupId: first.activeGroupId }
  useAppStore.setState({ ...initial, initialize: async () => () => {}, loading: false,
    config: { ...previewConfig, workspaces: [resource, display] }, sessions: [session, other],
    tabs: { [decoy.id]: decoy, [exact.id]: exact },
    layouts: { [resource.id]: createWorkspaceLayout('resource-home-group', [decoy.id, exact.id]), [display.id]: displayLayout },
    mainSurface: 'workbench', activeWorkspaceId: resource.id, toolsOpen: false, projectRailOpen: false,
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } },
    agentComposerDrafts: { [session.id]: 'Unsent original draft' } }, true)
  const reference = { displayWorkspaceId: display.id, groupId: 'display-exact-group', tabId: exact.id, regionId: 'exact-r2' }
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(createElement(App)))
  expect(container.querySelector('main.main-shell')).not.toBeNull()
  expect(container.querySelectorAll('[data-fixture-session]')).toHaveLength(3)
  return { session, other, reference, exact, decoy, resource, display, container,
    async focus() { await act(async () => {
      useAppStore.getState().focusRegion(reference.displayWorkspaceId, reference.tabId, reference.regionId, 'pointer', reference.groupId)
      useAppStore.getState().setMainSurface('agents')
    }) },
    async close() { await act(async () => root.unmount()); container.remove(); restorePopover()
      useAppStore.setState(initial, true); window.localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() } }
}

it('keeps ambiguous occurrences visible as choices, then consumes the actual non-first location button', async () => {
  const fixture = await presentationFixture()
  try {
    const primary = useAppStore.getState()
    await act(async () => { primary.focusExecutionSession(fixture.session.id); primary.setMainSurface('agents') })
    expect(fixture.container.querySelector('.focused-tab-workspace')).toBeNull()
    const choices = fixture.container.querySelectorAll<HTMLButtonElement>('[aria-label="Choose Focus location"] button')
    expect(choices).toHaveLength(7)
    const chosen = [...choices].find(button => button.title === 'display-b / display-exact-group / explicit-exact-tab / exact-r2')!
    expect(chosen).toBeDefined()
    await act(async () => chosen.click())
    expect(useAppStore.getState().agentFocus.execution.reference).toEqual(fixture.reference)
    expect(fixture.container.querySelector('.focused-tab-workspace')?.getAttribute('data-focus-tab-id')).toBe(fixture.exact.id)
    expect(useAppStore.getState().layouts).toBe(primary.layouts)
    expect(useAppStore.getState().tabs).toBe(primary.tabs)
    expect(useAppStore.getState().agentComposerDrafts).toBe(primary.agentComposerDrafts)
    expect(leaves.mounts).toHaveLength(3); expect(leaves.unmounts).toEqual([])
  } finally { await fixture.close() }
})

it('retains a late invalid occurrence without selecting another Group or accepting its stale callback', async () => {
  const fixture = await presentationFixture()
  try {
    await fixture.focus()
    const held = useAppStore.getState().agentFocus.execution.reference!
    const layout = useAppStore.getState().layouts[fixture.display.id]!
    await act(async () => useAppStore.setState(state => ({ layouts: { ...state.layouts,
      [fixture.display.id]: { ...layout, groups: layout.groups.map(group => group.id === held.groupId
        ? { ...group, tabOrder: [], activeTabId: null, recentTabIds: [] } : group) } } })))
    const primary = useAppStore.getState()
    expect(primary.agentFocus.execution.reference).toBe(held)
    expect(fixture.container.querySelector('.focused-tab-workspace')).toBeNull()
    expect(fixture.container.textContent).toContain('selected Tab or Region occurrence is no longer confirmed')
    expect(fixture.container.querySelectorAll('[aria-label="Choose Focus location"] button')).toHaveLength(5)
    await act(async () => primary.focusExecutionSession(fixture.session.id, held))
    expect(useAppStore.getState().agentFocus).toBe(primary.agentFocus)
    expect(useAppStore.getState().layouts).toBe(primary.layouts)
    expect(leaves.mounts).toHaveLength(3); expect(leaves.unmounts).toEqual([])
  } finally { await fixture.close() }
})

it('pointer selection inside the original projected Region changes only its exact Focus reference and no new history event', async () => {
  const fixture = await presentationFixture()
  try {
    await fixture.focus()
    const primary = useAppStore.getState(), history = primary.agentFocus.execution.history
    const region = fixture.container.querySelector<HTMLElement>('.focused-tab-workspace [data-workbench-region-id="exact-r1"]')!
    expect(region).not.toBeNull()
    const originalDraft = region.querySelector('textarea')!
    await act(async () => region.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
    const after = useAppStore.getState()
    expect(after.agentFocus.execution.reference).toEqual({ ...fixture.reference, regionId: 'exact-r1' })
    expect(after.agentFocus.execution.history).toBe(history)
    expect(after.tabs).toBe(primary.tabs); expect(after.layouts).toBe(primary.layouts)
    expect(after.activeWorkspaceId).toBe(primary.activeWorkspaceId)
    expect(region.classList.contains('workbench-region--active')).toBe(true)
    expect(region.querySelector('textarea')).toBe(originalDraft)
    expect(leaves.mounts).toHaveLength(3); expect(leaves.unmounts).toEqual([])
    await act(async () => after.focusExecutionSession(fixture.session.id, { ...fixture.reference, groupId: 'display-first-group' }))
    expect(useAppStore.getState().agentFocus.execution.history).toBe(history)
    expect(useAppStore.getState().layouts).toBe(primary.layouts)
    expect(fixture.container.querySelector('.focused-tab-workspace .retained-workbench-view')?.parentElement?.id)
      .toBe(workbenchProjectionSlotId('focus-workbench-slot', { ...fixture.reference, groupId: 'display-first-group' }))
  } finally { await fixture.close() }
})

it('another Session cannot inherit the previous Session spatial reference or revive it on a later identity-only return', async () => {
  const fixture = await presentationFixture()
  try {
    await fixture.focus()
    expect(useAppStore.getState().agentFocus.execution.reference).toEqual(fixture.reference)
    await act(async () => useAppStore.getState().focusExecutionSession(fixture.other.id))
    expect(useAppStore.getState().agentFocus.execution.reference).toBeUndefined()
    expect(fixture.container.querySelector('.focused-tab-workspace')).toBeNull()
    expect(fixture.container.textContent).toContain('No work surface occurrence is currently confirmed')
    await act(async () => useAppStore.getState().focusExecutionSession(fixture.session.id))
    expect(useAppStore.getState().agentFocus.execution.reference).toBeUndefined()
    expect(fixture.container.querySelectorAll('[aria-label="Choose Focus location"] button')).toHaveLength(7)
    expect(leaves.mounts).toHaveLength(3); expect(leaves.unmounts).toEqual([])
  } finally { await fixture.close() }
})

it('the original durable focus owner restores the exact occurrence and retains it while Session facts remain unknown', async () => {
  const fixture = await presentationFixture()
  try {
    await fixture.focus()
    const primary = useAppStore.getState()
    const saved = JSON.parse(JSON.stringify(primary.agentFocus))
    const restored = sanitizeAgentFocus(restoreAgentFocus(saved), primary.sessions, () => 'execution')
    await act(async () => useAppStore.setState({ agentFocus: restored }))
    expect(useAppStore.getState().agentFocus.execution.reference).toEqual(fixture.reference)
    expect(fixture.container.querySelector('.focused-tab-workspace')?.getAttribute('data-focus-tab-id')).toBe(fixture.exact.id)
    const unknown = sanitizeAgentFocus(restoreAgentFocus(saved), [], () => 'execution', new Set([fixture.session.id]))
    expect(unknown.execution.reference).toEqual(fixture.reference)
    await act(async () => useAppStore.setState({ agentFocus: unknown, sessions: [] }))
    expect(fixture.container.querySelector('.focused-tab-workspace')?.getAttribute('data-focus-tab-id')).toBe(fixture.exact.id)
    expect(useAppStore.getState().tabs).toBe(primary.tabs)
    expect(useAppStore.getState().layouts).toBe(primary.layouts)
    expect(leaves.mounts).toHaveLength(3); expect(leaves.unmounts).toEqual([])
    expect(restoreAgentFocus({ execution: { ...saved.execution, reference: { ...fixture.reference, groupId: null } } }).execution.reference).toBeUndefined()
  } finally { await fixture.close() }
})

it('rejects a semantic mismatch and a Group record outside the actual layout root without primary writes', async () => {
  const fixture = await presentationFixture()
  try {
    await fixture.focus()
    const before = useAppStore.getState()
    await act(async () => before.focusExecutionSession(fixture.other.id, fixture.reference))
    expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
    const layout = before.layouts[fixture.display.id]!
    await act(async () => useAppStore.setState({ layouts: { ...before.layouts, [fixture.display.id]: {
      ...layout, root: { type: 'leaf', groupId: 'display-first-group' } } } }))
    const changed = useAppStore.getState()
    await act(async () => changed.focusExecutionSession(fixture.session.id, fixture.reference))
    expect(useAppStore.getState().agentFocus).toBe(changed.agentFocus)
    expect(useAppStore.getState().layouts).toBe(changed.layouts)
    expect(fixture.container.querySelector('.focused-tab-workspace')).toBeNull()
    expect(fixture.container.querySelectorAll('[aria-label="Choose Focus location"] button')).toHaveLength(5)
  } finally { await fixture.close() }
})

it('the existing exact Tab activation records its confirmed Group and active Region before entering Focus', async () => {
  const fixture = await presentationFixture()
  try {
    await act(async () => useAppStore.getState().activateTab(fixture.display.id, fixture.reference.groupId, fixture.exact.id))
    const primary = useAppStore.getState()
    expect(primary.agentFocus.execution.reference).toEqual(fixture.reference)
    await act(async () => primary.setMainSurface('agents'))
    expect(fixture.container.querySelector('.focused-tab-workspace')?.getAttribute('data-focus-tab-id')).toBe(fixture.exact.id)
    expect(useAppStore.getState().layouts).toBe(primary.layouts)
    expect(useAppStore.getState().tabs).toBe(primary.tabs)
    expect(leaves.mounts).toHaveLength(3); expect(leaves.unmounts).toEqual([])
  } finally { await fixture.close() }
})


it('Settings hides the exact Focus projection without mounting a second observation instance', async () => {
  const fixture = await presentationFixture()
  try {
    await fixture.focus()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    const primary = useAppStore.getState()
    const mounts = [...leaves.mounts]
    const original = fixture.container.querySelector<HTMLTextAreaElement>('[data-owner-tab="explicit-exact-tab"][data-owner-region="exact-r2"] textarea')
    expect(original).not.toBeNull()
    original!.setSelectionRange(7, 15)
    const reads = { page: vi.spyOn(api.sessions, 'historyPage'), timeline: vi.spyOn(api.sessions, 'timeline'),
      sources: vi.spyOn(api.sessions, 'historySources') }
    const controls = { stop: vi.spyOn(api.sessions, 'stop'), resume: vi.spyOn(api.sessions, 'resume'),
      launch: vi.spyOn(api.sessions, 'launchAgent'), write: vi.spyOn(api.sessions, 'write'), interrupt: vi.spyOn(api.sessions, 'interrupt') }
    const settings = fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')
    expect(settings).not.toBeNull()
    await act(async () => settings!.click())
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(fixture.container.querySelector('.settings-page')).not.toBeNull()
    expect(leaves.mounts).toEqual(mounts)
    expect(leaves.unmounts).toEqual([])
    expect(original!.isConnected).toBe(true)
    expect(useAppStore.getState().agentFocus.execution.reference).toEqual(fixture.reference)
    expect(useAppStore.getState().layouts).toBe(primary.layouts)
    expect(useAppStore.getState().tabs).toBe(primary.tabs)
    expect(useAppStore.getState().sessions).toBe(primary.sessions)
    expect(useAppStore.getState().sessions[0]!.control.run.runId).toBe(fixture.session.control.run.runId)
    expect(useAppStore.getState().agentComposerDrafts).toBe(primary.agentComposerDrafts)
    expect([original!.selectionStart, original!.selectionEnd]).toEqual([7, 15])
    expect(original!.value).toBe('Unsent original draft')
    for (const read of Object.values(reads)) expect(read).not.toHaveBeenCalled()
    for (const call of Object.values(controls)) expect(call).not.toHaveBeenCalled()
    await act(async () => settings!.click())
    expect(fixture.container.querySelector('.settings-page')).toBeNull()
    expect(leaves.mounts).toEqual(mounts)
    expect(leaves.unmounts).toEqual([])
    expect(fixture.container.querySelector('.focused-tab-workspace')?.getAttribute('data-focus-tab-id')).toBe(fixture.exact.id)
    expect(original!.isConnected).toBe(true)
    expect([original!.selectionStart, original!.selectionEnd]).toEqual([7, 15])
    expect(original!.value).toBe('Unsent original draft')
  } finally { await fixture.close() }
})
