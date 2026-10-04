// @vitest-environment happy-dom
import { act, createElement, useEffect, useMemo } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout, moveTabToNewGroup, addTabOccurrence, activateTab } from '@agentmux/layout'
import type { SessionSnapshot } from '../src/shared/contracts'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { absoluteFocusFixtureInputs } from './fixtures/focus-workbench'
const paint = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }))
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})
// Native terminal/browser painting is isolated; Global, Workspace, stable hosts,
// exact spatial projection, SessionPane, input and Store remain production owners.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ session }: { session: SessionSnapshot }) => {
  useEffect(() => { paint.mounts++; return () => { paint.unmounts++ } }, [])
  return createElement('div', { 'data-native-terminal-paint': session.id }, createElement('p', {}, 'Original readable terminal content'))
} }))
vi.mock('../src/renderer/src/components/BrowserPane', () => ({ BrowserPane: () => createElement('div', { 'data-native-browser-paint': '' }) }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab, addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import { executionFocusPresentation } from '../src/renderer/src/lib/focus-tab-projection'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { workbenchProjectionSlotId, workbenchRegionProjectionSlotId } from '../src/renderer/src/lib/workbench-projection'
import { workbenchBrowserStageHostId, type WorkbenchViewTarget, type WorkbenchViewTargets } from '../src/renderer/src/lib/workbench-presentation'

const initial = useAppStore.getState(), workspaceId = 'workspace-demo', tabId = 'original-shared-tab'
const selectedRegion = 'selected-original-region', neighborRegion = 'same-session-neighbor-region'
const reference = { displayWorkspaceId: workspaceId, groupId: 'exact-second-group', tabId, regionId: selectedRegion }
let root: Root, container: HTMLDivElement, agentId: string
function Scene({ regionOnly, anotherTarget }: { regionOnly: boolean; anotherTarget?: WorkbenchViewTarget }) {
  const state = useAppStore()
  const presentation = useMemo(() => executionFocusPresentation(state.agentFocus.execution, state.tabs, spatialCatalog(state, []),
    selected => useAppStore.getState().selectMainRegion(selected, state.workbenchSpaceSelection), regionOnly ? 'region' : 'tab'),
  [state.agentFocus.execution, state.tabs, state.layouts, state.config, regionOnly])
  const projection = presentation.projection, selected = projection?.selection[0]
  const targets: WorkbenchViewTargets = selected && projection ? { [tabId]: [
    ...(anotherTarget ? [anotherTarget] : []),
    { hostId: (projection.entity.kind === 'region' ? workbenchRegionProjectionSlotId : workbenchProjectionSlotId)(`${projection.presentationId}-slot`, selected),
      active: true, visible: true, surface: 'focus', retainedRegionId: selected.regionId,
      projection, reference: selected, onSelectRegion: regionId => projection.onSelect({ ...selected, regionId }) }
  ] } : {}
  return <><GlobalFocusSurface presentation={presentation} viewTargets={targets} regionOnly={regionOnly} />
    <div data-original-registry=""><WorkspaceWorkbench workspaceId={workspaceId} visible={false} viewTargets={targets} /></div></>
}
const render = (regionOnly: boolean, anotherTarget?: WorkbenchViewTarget) => act(async () => {
  root.render(createElement(Scene, { regionOnly, ...(anotherTarget ? { anotherTarget } : {}) }))
  await new Promise(resolve => setTimeout(resolve, 0))
})
const focus = () => container.querySelector<HTMLElement>('.focused-tab-workspace')!
const region = (scope: ParentNode, id: string) => [...scope.querySelectorAll<HTMLElement>('[data-workbench-region-id]')].find(node => node.dataset.workbenchRegionId === id)

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const snapshot = await api.sessions.snapshot(), config = await api.config.get()
  const { pendingInteraction: _pending, ...agent } = snapshot.sessions.find((item): item is Extract<SessionSnapshot, { kind: 'agent' }> => item.kind === 'agent')!
  const input = absoluteFocusFixtureInputs(config, [{ ...agent, processState: 'running' as const, status: { state: 'working' as const, source: 'native-hook' as const, observedAt: 2 } }])
  agentId = agent.id
  const source = addWorkbenchRegion(createWorkbenchTab(tabId, { kind: 'agent', phase: 'attached', workspaceId, regionId: selectedRegion, sessionId: agentId }, 'Same Tab name'),
    selectedRegion, 'right', { kind: 'agent', phase: 'attached', workspaceId, regionId: neighborRegion, sessionId: agentId })
  const decoy = createWorkbenchTab('same-name-decoy', { kind: 'agent', phase: 'attached', workspaceId, regionId: 'decoy-region', sessionId: agentId }, 'Same Tab name')
  const split = moveTabToNewGroup(createWorkspaceLayout('ordinary-first-group', [decoy.id, source.id]), source.id, 'ordinary-first-group', 'ordinary-first-group', 'right', reference.groupId)!
  const layout = activateTab(addTabOccurrence(split, 'ordinary-first-group', source.id)!, 'ordinary-first-group', source.id)
  useAppStore.setState({ ...initial, config: input.config, sessions: input.sessions, tabs: { [source.id]: source, [decoy.id]: decoy },
    layouts: { [workspaceId]: layout }, activeWorkspaceId: workspaceId, mainSurface: 'agents', loading: false,
    agentFocus: { execution: { sessionId: agentId, history: [], reference }, pmo: { sessionId: null } },
    agentComposerDrafts: { [agentId]: 'Original unsent draft' }, viewModes: { [agentId]: 'terminal' }, timelines: {}, scratchTopicSnapshots: {} }, true)
  paint.mounts = 0; paint.unmounts = 0
  vi.spyOn(api.sessions, 'stop'); vi.spyOn(api.sessions, 'resume'); vi.spyOn(api.sessions, 'write')
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); document.getElementById('agentmux-window-overlay-host')?.remove()
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('switches the exact multi-Group Tab to one native Region and back without borrowing its neighbor or remounting its original input', async () => {
  await render(false)
  expect(focus()).not.toBeNull()
  expect(focus().querySelectorAll('[data-workbench-region-id]')).toHaveLength(2)
  const before = useAppStore.getState(), original = region(focus(), selectedRegion)!, neighbor = region(focus(), neighborRegion)!
  const nativePaint = original.querySelector('[data-native-terminal-paint]'), input = original.querySelector('[contenteditable="true"]')!
  expect(nativePaint).not.toBeNull(); expect(input).not.toBeNull(); expect(input.textContent).toContain('Original unsent draft')
  const text = nativePaint!.querySelector('p')!.firstChild!, reading = document.createRange(), selection = window.getSelection()!
  reading.setStart(text, 9); reading.setEnd(text, 17); selection.removeAllRanges(); selection.addRange(reading)
  expect(selection.toString()).toBe('readable')
  const mounts = paint.mounts, tabHost = original.closest('.retained-workbench-view')!
  await render(true)
  expect([...focus().querySelectorAll<HTMLElement>('[data-workbench-region-id]')].map(node => node.dataset.workbenchRegionId)).toEqual([selectedRegion])
  expect(focus().querySelector('[data-session-occurrence-slot]')).toBeNull()
  expect(region(focus(), selectedRegion)).toBe(original)
  expect(original.querySelector('[data-native-terminal-paint]')).toBe(nativePaint)
  expect(original.querySelector('[contenteditable="true"]')).toBe(input)
  expect(selection.toString()).toBe('readable'); expect(selection.getRangeAt(0).startContainer).toBe(text)
  expect(selection.getRangeAt(0).startOffset).toBe(9); expect(selection.getRangeAt(0).endOffset).toBe(17)
  expect(container.contains(neighbor)).toBe(true); expect(focus().contains(neighbor)).toBe(false)
  expect(container.contains(tabHost)).toBe(true)
  const primaryRegionHost = original.closest('.retained-workbench-region')!
  expect(primaryRegionHost.parentElement?.id).toBe(workbenchRegionProjectionSlotId('focus-workbench-slot', reference))
  await render(false)
  expect(focus().querySelectorAll('[data-workbench-region-id]')).toHaveLength(2)
  expect(region(focus(), selectedRegion)).toBe(original); expect(region(focus(), neighborRegion)).toBe(neighbor)
  expect(original.closest('.retained-workbench-view')).toBe(tabHost)
  expect(original.querySelector('[contenteditable="true"]')).toBe(input)
  expect(input.textContent).toContain('Original unsent draft')
  expect(selection.toString()).toBe('readable'); expect(selection.getRangeAt(0).startContainer).toBe(text)
  const after = useAppStore.getState()
  expect(after.tabs).toBe(before.tabs); expect(after.layouts).toBe(before.layouts); expect(after.sessions).toBe(before.sessions)
  expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts); expect(after.agentFocus).toBe(before.agentFocus)
  expect(paint.mounts).toBe(mounts); expect(paint.unmounts).toBe(0)
  expect(api.sessions.stop).not.toHaveBeenCalled(); expect(api.sessions.resume).not.toHaveBeenCalled(); expect(api.sessions.write).not.toHaveBeenCalled()
})

it('retains Browser stage destinations and another exact presentation while excluding only the native Agent target already consumed', async () => {
  const state = useAppStore.getState(), original = state.tabs[tabId]!
  useAppStore.setState({ tabs: { ...state.tabs, [tabId]: { ...original, regions: { ...original.regions,
    [selectedRegion]: { kind: 'browser', regionId: selectedRegion, workspaceId, browserId: 'original-browser', id: 'original-browser', navigationId: 'original-navigation',
      profileId: 'original-profile', url: 'about:blank', title: 'Original Browser', loading: false, canGoBack: false, canGoForward: false,
      viewport: 'responsive', error: null, driving: false, appLinkPrompt: null } } } } })
  const anotherTarget: WorkbenchViewTarget = { hostId: 'another-exact-presentation', surface: 'survey', active: false, visible: true, reference }
  const anotherSlot = document.createElement('div'); anotherSlot.id = anotherTarget.hostId; container.append(anotherSlot)
  await render(false, anotherTarget)
  const before = useAppStore.getState(), browser = region(focus(), selectedRegion)!
  expect(browser.querySelector('[data-native-browser-paint]')).not.toBeNull()
  await render(true, anotherTarget)
  const target: WorkbenchViewTarget = { hostId: workbenchRegionProjectionSlotId('focus-workbench-slot', reference), active: true, reference }
  const stage = document.getElementById(workbenchBrowserStageHostId(target, selectedRegion))
  expect(stage, 'A Browser still needs its own native stage in this exact Region target').not.toBeNull()
  expect(focus().contains(stage)).toBe(true)
  expect(document.getElementById(workbenchBrowserStageHostId(anotherTarget, selectedRegion))).not.toBeNull()
  expect(region(focus(), selectedRegion)).toBe(browser)
  expect(focus().contains(region(container, neighborRegion)!)).toBe(false)
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})
