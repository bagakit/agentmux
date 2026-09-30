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
  SessionPane: ({ sessionId, linkOrigin, visible }: {
    sessionId: string
    visible: boolean
    linkOrigin: { workspaceId: string; tabGroupId: string; tabId: string; regionId: string }
  }) => {
    const key = `${linkOrigin.tabId}/${linkOrigin.regionId}`
    useEffect(() => { leaves.mounts.push(key); return () => { leaves.unmounts.push(key) } }, [key])
    const draft = useAppStore(state => state.agentComposerDrafts[sessionId] ?? '')
    const presentation = useWorkbenchBrowserPresentation()
    return createElement('section', { 'data-fixture-session': sessionId, 'data-fixture-visible': String(visible),
      'data-resource-workspace': linkOrigin.workspaceId, 'data-owner-group': linkOrigin.tabGroupId,
      'data-owner-tab': linkOrigin.tabId, 'data-owner-region': linkOrigin.regionId,
      'data-presentation-reference': presentation.reference ? JSON.stringify(presentation.reference) : undefined,
      'data-presentation-entity': presentation.projection ? JSON.stringify(presentation.projection.entity) : undefined },
    createElement('p', { 'data-original-reading': key }, 'Original selected reading passage'),
    createElement('textarea', { 'aria-label': `Original draft ${key}`, value: draft, readOnly: true }))
  }
}))
vi.mock('../src/renderer/src/components/FileSurfaceView', () => ({ FileSurfaceView: ({surface, visible}: { surface: {regionId:string}; visible:boolean }) => createElement('div',{'data-fixture-file':surface.regionId,'data-fixture-visible':String(visible)}, createElement('p',null,'Original unsaved document')) }))
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { documentKey, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { restoreAgentFocus, sanitizeAgentFocus } from '../src/renderer/src/lib/agent-focus'
import { workbenchProjectionSlotId } from '../src/renderer/src/lib/workbench-projection'
import { useWorkbenchBrowserPresentation } from '../src/renderer/src/lib/workbench-presentation'
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

/** Real App caller fixture; only its PTY painting leaf is isolated above. */
async function presentationFixture({ file = false }: { file?: boolean } = {}) {
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
  if (file) exact.regions['exact-r2'] = { regionId: 'exact-r2', workspaceId: resource.id, kind: 'file', path: 'unsaved.md' }
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
    agentComposerDrafts: { [session.id]: 'Unsent original draft' },
    dirtyDocuments: file ? { [documentKey(resource.id, 'unsaved.md')]: true } : {} }, true)
  const reference = { displayWorkspaceId: display.id, groupId: 'display-exact-group', tabId: exact.id, regionId: 'exact-r2' }
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(createElement(App)))
  expect(container.querySelector('main.main-shell')).not.toBeNull()
  expect(container.querySelectorAll('[data-fixture-session]')).toHaveLength(file ? 2 : 3)
  return { session, other, reference, exact, decoy, resource, display, container,
    async focus() { await act(async () => {
      useAppStore.getState().focusRegion(reference.displayWorkspaceId, reference.tabId, file ? 'exact-r1' : reference.regionId, 'pointer', reference.groupId)
      useAppStore.getState().setMainSurface('agents')
      if (file) useAppStore.getState().selectExecutionFocusReference(reference, useAppStore.getState().agentFocus.execution)
    }) },
    async close() { await act(async () => root.unmount()); container.remove(); restorePopover()
      useAppStore.setState(initial, true); window.localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() } }
}


it('uses the actual Focus menu to move only the original exact Region and return its DOM without changing the Tab or Run', async () => {
  const budget: unknown[] = []
  vi.stubGlobal('__regionBudgetFacts', budget)
  const fixture = await presentationFixture()
  try {
    await fixture.focus()
    const before = useAppStore.getState()
    const original = fixture.container.querySelector<HTMLElement>(`[data-owner-tab="${fixture.exact.id}"][data-owner-region="${fixture.reference.regionId}"]`)!
    const sibling = fixture.container.querySelector<HTMLElement>(`[data-owner-tab="${fixture.exact.id}"][data-owner-region="exact-r1"]`)!
    expect(original).not.toBeNull(); expect(sibling).not.toBeNull()
    const textarea = original.querySelector<HTMLTextAreaElement>('textarea')!
    expect(textarea).not.toBeNull(); expect(textarea.value).toBe('Unsent original draft')
    textarea.focus(); textarea.setSelectionRange(2, 8)
    const selectedText = original.querySelector('[data-original-reading]')!.firstChild!
    const range = document.createRange(); range.setStart(selectedText, 3); range.setEnd(selectedText, 18)
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    const mountCount = [...leaves.mounts]
    const control = { stop: vi.spyOn(api.sessions, 'stop'), resume: vi.spyOn(api.sessions, 'resume'),
      launch: vi.spyOn(api.sessions, 'launchAgent'), write: vi.spyOn(api.sessions, 'write'), interrupt: vi.spyOn(api.sessions, 'interrupt') }
    async function selectLevel(label: string) {
      const button = fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Focus context actions"]')!
      expect(button).not.toBeNull()
      await act(async () => button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
      const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === label)!
      expect(action, `Actual Focus menu item ${label}`).not.toBeUndefined()
      await act(async () => action.click())
      await act(async () => {})
    }
    expect(fixture.container.querySelectorAll('.focused-tab-workspace [data-fixture-session]')).toHaveLength(2)
    await selectLevel('Show only this Region')
    const projected = fixture.container.querySelector<HTMLElement>('.focused-tab-workspace')!
    expect(projected).not.toBeNull()
    const actual = projected.querySelectorAll('[data-fixture-session]')
    expect([...actual].map(item => item.getAttribute('data-owner-region'))).toEqual([fixture.reference.regionId])
    expect(projected.querySelector('[data-fixture-session]')).toBe(original)
    expect(projected.querySelector('textarea')).toBe(textarea)
    expect([textarea.selectionStart,textarea.selectionEnd]).toEqual([2,8])
    expect(selection.toString()).toBe('ginal selected ')
    expect(selection.anchorNode).toBe(selectedText)
    const slot = projected.querySelector('.workspace-workbench > .workbench-region-slot')!
    expect(slot).not.toBeNull()
    expect(slot.id).toBe('focus-workbench-slot:' + JSON.stringify([fixture.reference.displayWorkspaceId, fixture.reference.groupId, fixture.reference.tabId, fixture.reference.regionId]))
    expect(original.dataset.fixtureVisible).toBe('true')
    expect(sibling.dataset.fixtureVisible).toBe('false')
    expect(budget.length).toBeGreaterThan(0)
    expect(budget.at(-1)).toEqual([{ id: 'decoy-region', visible: false },{ id: 'exact-r1', visible: false },{ id: 'exact-r2', visible: true }])
    expect(projected.contains(sibling)).toBe(false)
    expect(sibling.isConnected).toBe(true)
    expect(original.getAttribute('data-presentation-reference')).toBe(JSON.stringify(fixture.reference))
    expect(original.getAttribute('data-presentation-entity')).toBe(JSON.stringify({ kind: 'region', regionId: fixture.reference.regionId }))
    expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts)
    expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    await selectLevel('Show entire Tab')
    expect(fixture.container.querySelectorAll('.focused-tab-workspace [data-fixture-session]')).toHaveLength(2)
    expect(fixture.container.querySelector(`[data-owner-tab="${fixture.exact.id}"][data-owner-region="${fixture.reference.regionId}"]`)).toBe(original)
    expect(original.querySelector('textarea')).toBe(textarea)
    expect(textarea.value).toBe('Unsent original draft')
    expect(selection.toString()).toBe('ginal selected ')
    expect(selection.anchorNode).toBe(selectedText)
    expect(leaves.mounts).toEqual(mountCount); expect(leaves.unmounts).toEqual([])
    for (const call of Object.values(control)) expect(call).not.toHaveBeenCalled()
  } finally { await fixture.close() }
})

it('the borrowed Region uses its original dirty-file close confirmation and exact resource target', async () => {
  const fixture = await presentationFixture({file:true})
  try {
    await fixture.focus()
    const before=useAppStore.getState()
    const original=fixture.container.querySelector('[data-fixture-file="exact-r2"]')!
    expect(original).not.toBeNull()
    const close=vi.spyOn(before,'closeRegion')
    const menu=fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Focus context actions"]')!
    await act(async()=>menu.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})))
    const action=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent==='Show only this Region')!
    expect(action).not.toBeUndefined();await act(async()=>action.click())
    const projected=fixture.container.querySelector('.focused-tab-workspace')!
    if (!projected.contains(original)) writeFileSync('.tmp/region-level-qualification/dirty-observation.json', JSON.stringify({ beforeRef:before.agentFocus.execution.reference, afterRef:useAppStore.getState().agentFocus.execution.reference, target:projected.outerHTML, originalConnected:original.isConnected, originalParent:original.parentElement?.outerHTML },null,2))
    expect(projected.querySelector('[data-fixture-file="exact-r2"]')).toBe(original)
    const x=projected.querySelector<HTMLButtonElement>('[data-workbench-region-id="exact-r2"] button[aria-label="Close split"]')!
    expect(x).not.toBeNull();await act(async()=>x.click())
    const dialog=[...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(item=>item.textContent?.includes('Discard unsaved changes?'))!
    expect(dialog,'Original Leaf dirty confirmation remains in its moved Provider').not.toBeUndefined()
    expect(close).not.toHaveBeenCalled()
    const cancel=[...dialog.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent==='Cancel')!
    expect(cancel).not.toBeUndefined();await act(async()=>cancel.click())
    expect(projected.querySelector('[data-fixture-file="exact-r2"]')).toBe(original)
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    await act(async()=>x.click())
    const confirm=[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(item=>item.textContent==='Discard & Close')!
    expect(confirm).not.toBeUndefined();await act(async()=>confirm.click())
    expect(close).toHaveBeenCalledWith(fixture.resource.id,fixture.exact.id,fixture.reference.regionId)
    expect(useAppStore.getState().tabs[fixture.exact.id]!.regions['exact-r2']).toBeUndefined()
    expect(Object.keys(useAppStore.getState().tabs[fixture.exact.id]!.regions)).toEqual(['exact-r1'])
    expect(useAppStore.getState().sessions).toBe(before.sessions)
  } finally {await fixture.close()}
})
