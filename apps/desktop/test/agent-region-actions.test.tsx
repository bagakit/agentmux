// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
// Mount the installed client implementation, as the split-ratio owning suite does.
// The Node primary omits Panel registration effects and cannot exercise a mounted split.
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)(
    '../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'
  )
})
// Geometry is proved in actual Electron. These mocks isolate resource rendering while keeping the
// actual Workbench/SessionPane, Region intent, dirty confirmation and Store close path mounted.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Original terminal</div> }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: () => <textarea aria-label="Original composer" /> }))
vi.mock('../src/renderer/src/components/EditorPane', () => ({ EditorPane: () => <div>Original editor</div> }))
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab, addWorkbenchRegion, documentKey } from '../src/renderer/src/lib/workbench-tabs'

const initial = useAppStore.getState()
const workspaceId = 'private-region-workspace', tabId = 'private-region-tab', targetId = 'private-region-target', survivorId = 'private-region-survivor'
let root: Root, container: HTMLDivElement
let sessionIds: string[]
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const sessions = (await api.sessions.snapshot()).sessions.filter(session => session.kind === 'agent').slice(0, 2)
  expect(sessions).toHaveLength(2)
  sessionIds = sessions.map(session => session.id)
  const config = await api.config.get()
  let tab = createWorkbenchTab(tabId, { regionId: targetId, kind: 'agent', phase: 'attached', workspaceId, sessionId: sessionIds[0]! })
  tab = addWorkbenchRegion(tab, targetId, 'right', { regionId: survivorId, kind: 'agent', phase: 'attached', workspaceId, sessionId: sessionIds[1]! })
  useAppStore.setState({ ...initial, config, sessions, tabs: { [tabId]: tab },
    layouts: { [workspaceId]: createWorkspaceLayout('private-group', [tabId]) }, activeWorkspaceId: workspaceId,
    viewModes: Object.fromEntries(sessionIds.map(id => [id, 'terminal'])),
    agentComposerDrafts: { [sessionIds[1]!]: 'Surviving draft' } }, true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); useAppStore.setState(initial, true); vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function mount() { await act(async () => root.render(<WorkspaceWorkbench workspaceId={workspaceId} />)) }
function closeTarget() {
  const button = container.querySelector<HTMLButtonElement>(`[data-workbench-region-id="${targetId}"] button[aria-label="Close split"]`)
  expect(button).not.toBeNull(); return button!
}

it('the actual X closes its own Agent Region, preserves the Tab, other Session and draft, and does not stop a Run', async () => {
  const stop = vi.spyOn(api.sessions, 'stop')
  await mount()
  expect(container.querySelectorAll('[data-workbench-region-id]')).toHaveLength(2)
  const before = structuredClone(useAppStore.getState().sessions)
  await act(async () => closeTarget().click())
  const state = useAppStore.getState()
  expect(Object.keys(state.tabs)).toEqual([tabId])
  expect(Object.keys(state.tabs[tabId]!.regions)).toEqual([survivorId])
  expect(state.tabs[tabId]!.layout.root).toEqual({ type: 'leaf', regionId: survivorId })
  expect(state.sessions).toEqual(before)
  expect(state.agentComposerDrafts[sessionIds[1]!]).toBe('Surviving draft')
  expect(stop).not.toHaveBeenCalled()
})

it('the targeted keyboard close intent consumes the same mounted Region path, independent of the active neighbor', async () => {
  await mount()
  await act(async () => useAppStore.getState().focusRegion(workspaceId, tabId, survivorId, 'pointer'))
  await act(async () => useAppStore.getState().requestCloseRegion(workspaceId, tabId, targetId))
  expect(Object.keys(useAppStore.getState().tabs[tabId]!.regions)).toEqual([survivorId])
  expect(useAppStore.getState().closeRegionRequest).toBeNull()
})

it('X and keyboard intent both preserve dirty content until the existing discard confirmation is accepted', async () => {
  const path = 'unsaved.txt'
  useAppStore.setState(state => ({ tabs: { [tabId]: { ...state.tabs[tabId]!, regions: { ...state.tabs[tabId]!.regions,
    [targetId]: { kind: 'file', regionId: targetId, workspaceId, path } } } }, dirtyDocuments: { [documentKey(workspaceId, path)]: true } }))
  await mount()
  await act(async () => closeTarget().click())
  expect(Object.keys(useAppStore.getState().tabs[tabId]!.regions)).toEqual([targetId, survivorId])
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Discard unsaved changes?')
  const button = (label: string) => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(candidate => candidate.textContent === label)
    expect(found).toBeDefined(); return found!
  }
  await act(async () => button('Cancel').click())
  await act(async () => useAppStore.getState().requestCloseRegion(workspaceId, tabId, targetId))
  expect(Object.keys(useAppStore.getState().tabs[tabId]!.regions)).toEqual([targetId, survivorId])
  await act(async () => button('Discard & Close').click())
  expect(Object.keys(useAppStore.getState().tabs[tabId]!.regions)).toEqual([survivorId])
})
