// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { act, createElement } from 'react'
import { expect, it, vi } from 'vitest'
import { createWorkspaceLayout, type WorkspaceLayout } from '@agentmux/layout'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { spaceNewTabFixture } from './fixtures/space-new-tab'
import { installNativePopover } from './fixtures/mote-workface'
vi.mock('react-resizable-panels', () => createRequire(import.meta.url)(
  '../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
// Isolate PTY painting only. Selection, projection, placement and Store remain production consumers.
vi.mock('../src/renderer/src/components/SessionPane', () => ({
  SessionPane: ({ sessionId, linkOrigin }: { sessionId: string; linkOrigin: { tabGroupId?: string } }) => {
    const draft = useAppStore(state => state.agentComposerDrafts[sessionId] ?? '')
    const presentation = useWorkbenchBrowserPresentation()
    return <section data-original-link-group={linkOrigin.tabGroupId} data-original-session={sessionId} data-original-reference={JSON.stringify(presentation.reference)}>
      <p>Original conversation content</p><textarea aria-label="Original draft" value={draft} readOnly />
    </section>
  }
}))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { App } from '../src/renderer/src/App'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { openSourceFolderInput } from '../src/renderer/src/lib/space-mount-view'
import { originalSourceEntryForSelection } from '../src/renderer/src/lib/original-space-navigation'
import { useWorkbenchBrowserPresentation } from '../src/renderer/src/lib/workbench-presentation'
const initial = useAppStore.getState(), initialLauncher = useLauncherState.getState()

it.each([
  { registered: false, repeated: false }, { registered: true, repeated: false },
  { registered: false, repeated: true }, { registered: true, repeated: true }
])('actual App projects the exact ordinary Tab: $registered Source context, $repeated repeated occurrence', async ({ registered, repeated }) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.localStorage.clear()
  const restorePopover = installNativePopover()
  const f = spaceNewTabFixture(composerConfig, composerSession(), 'original-runtime')
  const neighbor = createWorkbenchTab('neighbor-tab', { kind: 'launcher', regionId: 'neighbor-region', workspaceId: f.tab.workspaceId })
  neighbor.space = { spaceId: f.spaceId, zoneId: f.zoneId }
  const first = createWorkspaceLayout('original-group', [neighbor.id, f.tab.id])
  const layout: WorkspaceLayout = repeated ? { ...first,
    root: { type: 'split', direction: 'horizontal', ratio: .5, first: first.root, second: { type: 'leaf', groupId: 'exact-group' } },
    groups: [...first.groups, { ...first.groups[0]!, id: 'exact-group' }] } : first
  const reference = { displayWorkspaceId: f.tab.workspaceId, groupId: repeated ? 'exact-group' : 'original-group', tabId: f.tab.id, regionId: f.tab.layout.activeRegionId }
  useAppStore.setState({ ...initial, initialize: async () => () => {}, loading: false,
    config: composerConfig, sessions: [f.session], tabs: { [neighbor.id]: neighbor, [f.tab.id]: f.tab },
    layouts: { [f.tab.workspaceId]: layout }, mainSurface: 'workbench', activeWorkspaceId: f.tab.workspaceId,
    mountedSpaceInputs: registered ? openSourceFolderInput({}, f.target) : {}, mountedSpaceObservations: {},
    workbenchSpaceSelection: { ...f.state.workbenchSpaceSelection, tabId: neighbor.id, regionId: 'neighbor-region' },
    toolsOpen: false, projectRailOpen: false, agentComposerDrafts: { [f.session.id]: 'Original unsent draft' },
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } },
    scratchTopicSnapshots: {}, prewarmTerminal: async () => {} }, true)
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    expect(Boolean(originalSourceEntryForSelection(useAppStore.getState(), f.tab.workspaceId))).toBe(registered)
    expect(f.tab.source).toBeUndefined()
    await act(async () => root.render(createElement(App)))
    await act(async () => {
      expect(useAppStore.getState().selectMainRegion(reference)).toBe(true)
    })
    const ordinary = container.querySelector('.workspace-workbench-slot[data-visible="true"]')!
    const activeSlot = ordinary.querySelector(`[data-active="true"] > [data-workbench-tab-id="${f.tab.id}"][data-workbench-group-id="${reference.groupId}"]`)
    expect(activeSlot, 'Exact choice must also reach the ordinary Space slot').not.toBeNull()
    await act(async () => useAppStore.getState().setMainSurface('agents'))
    const before = useAppStore.getState()
    expect(before.layouts[f.tab.workspaceId]).toBe(layout)
    expect(layout.groups[0]!.activeTabId).toBe(neighbor.id)
    expect(before.workbenchSpaceSelection).toMatchObject({ tabId: reference.tabId, groupId: reference.groupId, regionId: reference.regionId })
    const focus = container.querySelector('.focused-tab-workspace')!
    expect(focus).not.toBeNull()
    expect(focus.getAttribute('data-focus-tab-id')).toBe(f.tab.id)
    const slot = focus.querySelector(`[data-workbench-tab-id="${f.tab.id}"][data-workbench-group-id="${reference.groupId}"]`)
    expect(slot, 'Exact selected occurrence must have its Focus slot').not.toBeNull()
    const content = focus.querySelector<HTMLElement>(`[data-original-session="${f.session.id}"]`)
    expect(content, 'Original content must reach the selected slot').not.toBeNull()
    expect(content?.dataset.originalLinkGroup).toBe(reference.groupId)
    expect(JSON.parse(content!.dataset.originalReference!)).toEqual(reference)
    expect(content?.textContent).toContain('Original conversation content')
    expect(content?.querySelector('textarea')?.value).toBe('Original unsent draft')
    expect(container.querySelectorAll(`[data-original-session="${f.session.id}"]`)).toHaveLength(1)
    const later = document.createElement('input'); container.append(later)
    await act(async () => {
      later.focus()
      expect(useAppStore.getState().selectMainRegion({ ...reference, groupId: 'unconfirmed-group' })).toBe(false)
      expect(useAppStore.getState().selectMainRegion({ ...reference, regionId: 'unconfirmed-region' })).toBe(false)
    })
    expect(document.activeElement).toBe(later)
    expect(focus.querySelector(`[data-original-session="${f.session.id}"]`)).toBe(content)
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
    expect(useAppStore.getState().layouts).toBe(before.layouts)
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  } finally {
    await act(async () => root.unmount()); container.remove(); restorePopover()
    useAppStore.setState(initial, true); useLauncherState.setState(initialLauncher, true)
    window.localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  }
})

it('the actual owner consumes an explicit member composition even when its context has a Source registration', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const restorePopover = installNativePopover()
  const f = spaceNewTabFixture(composerConfig, composerSession(), 'original-runtime')
  const neighbor = createWorkbenchTab('composition-neighbor', { kind: 'launcher', regionId: 'composition-neighbor-region', workspaceId: f.tab.workspaceId })
  neighbor.space = { spaceId: f.spaceId, zoneId: f.zoneId }
  const layout = createWorkspaceLayout('original-group', [neighbor.id, f.tab.id])
  useAppStore.setState({ ...initial, ...f.state, tabs: { [neighbor.id]: neighbor, [f.tab.id]: f.tab },
    layouts: { [f.tab.workspaceId]: layout }, mountedSpaceInputs: openSourceFolderInput({}, f.target),
    loading: false, scratchTopicSnapshots: {}, prewarmTerminal: async () => {} }, true)
  const { WorkspaceWorkbench } = await import('../src/renderer/src/components/WorkspaceWorkbench')
  const { workbenchSelectionCatalog } = await import('../src/renderer/src/lib/desktop-focus-navigation')
  const { workbenchProjectionSlotId } = await import('../src/renderer/src/lib/workbench-projection')
  const reference = { displayWorkspaceId: f.tab.workspaceId, groupId: 'original-group', tabId: f.tab.id, regionId: f.tab.layout.activeRegionId }
  const projection = { entity: { kind: 'tab' as const, tabId: f.tab.id }, presentationId: 'member-composition',
    displayWorkspaceId: f.tab.workspaceId, composition: layout, catalog: workbenchSelectionCatalog(useAppStore.getState()), selection: [reference], onSelect: vi.fn() }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    expect(originalSourceEntryForSelection(useAppStore.getState(), f.tab.workspaceId)).toBeDefined()
    await act(async () => root.render(<WorkspaceWorkbench workspaceId={f.tab.workspaceId} projection={projection}
      viewTargets={{ [f.tab.id]: [{ hostId: workbenchProjectionSlotId('member-composition-slot', reference), surface: 'space', visible: true, reference, projection }] }} />))
    const slot = container.querySelector(`[data-active="true"] > [data-workbench-tab-id="${f.tab.id}"][data-workbench-group-id="${reference.groupId}"]`)
    expect(slot, 'An explicit member composition must select its exact owner slot').not.toBeNull()
    expect(slot?.querySelector('[data-original-session]')?.textContent).toContain('Original conversation content')
    expect(layout.groups[0]!.activeTabId).toBe(neighbor.id)
    expect(useAppStore.getState().layouts[f.tab.workspaceId]).toBe(layout)
  } finally {
    await act(async () => root.unmount()); container.remove(); restorePopover()
    useAppStore.setState(initial, true); useLauncherState.setState(initialLauncher, true)
    window.localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  }
})
