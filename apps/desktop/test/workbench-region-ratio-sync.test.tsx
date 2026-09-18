// @vitest-environment happy-dom
import { act, createElement, forwardRef, useEffect, useId, useImperativeHandle, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ImperativePanelGroupHandle, PanelGroupProps, PanelResizeHandleProps } from 'react-resizable-panels'
import { addTabPlacement, createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'

const observed = vi.hoisted(() => ({
  groups: new Map<string, ImperativePanelGroupHandle>(),
  dragging: new Map<string, NonNullable<PanelResizeHandleProps['onDragging']>>(),
  setLayouts: [] as Array<{ id: string; sizes: number[] }>,
  mounts: 0, unmounts: 0
}))
// Delegate to the installed real library. Only its public imperative calls are counted.
vi.mock('react-resizable-panels', async () => {
  // happy-dom needs the actual browser primary, including its layout effects.
  const actual = await vi.importActual<typeof import('react-resizable-panels')>(
    '../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.esm.js'
  )
  return { ...actual,
    PanelGroup: forwardRef<ImperativePanelGroupHandle, PanelGroupProps>((props, forwarded) => {
      const real = useRef<ImperativePanelGroupHandle>(null)
      useImperativeHandle(forwarded, () => ({
        getId: () => real.current!.getId(), getLayout: () => real.current!.getLayout(),
        setLayout: sizes => { observed.setLayouts.push({ id: real.current!.getId(), sizes }); real.current!.setLayout(sizes) }
      }), [])
      useEffect(() => { const group = real.current!; observed.groups.set(group.getId(), group); return () => { observed.groups.delete(group.getId()) } }, [])
      return createElement(actual.PanelGroup, { ...props, ref: real })
    }),
    PanelResizeHandle: (props: PanelResizeHandleProps) => {
      const id = useId()
      useEffect(() => { if (props.onDragging) observed.dragging.set(id, props.onDragging); return () => { observed.dragging.delete(id) } }, [id, props.onDragging])
      return createElement(actual.PanelResizeHandle, { ...props, id })
    }
  }
})
// The heavy Session/xterm leaf is a lifetime sentinel here; the GUI test uses the real leaf.
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: ({ sessionId }: { sessionId: string }) => {
  const owner = useRef({})
  useEffect(() => { observed.mounts++; return () => { observed.unmounts++ } }, [])
  return createElement('div', { 'data-leaf-session': sessionId, ref: element => { if (element) Object.assign(element, { leafOwner: owner.current }) } })
} }))
vi.mock('../src/renderer/src/components/NewTabSurface', () => ({ NewTabSurface: () => createElement('div', { 'data-launcher-leaf': true }) }))
vi.mock('../src/renderer/src/components/TopRowChrome', () => ({ TopRowLeadingChrome: () => null }))
vi.mock('../src/renderer/src/components/WorkbenchTabMarks', () => ({ WorkbenchTabMarks: () => null }))
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'

const initial = useAppStore.getState()
let root: Root, container: HTMLDivElement, workspaceId: string
function panelGroup(selector = '.workbench-region-split') {
  const element = container.querySelector<HTMLElement>(selector)
  expect(element).not.toBeNull()
  const handle = observed.groups.get(element!.dataset.panelGroupId!)
  expect(handle).toBeDefined()
  expect(handle!.getLayout()).toHaveLength(2)
  const panels = [...element!.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.hasAttribute('data-panel-id'))
  expect(panels).toHaveLength(2)
  return { element: element!, handle: handle!, panels }
}
function ratio() {
  const node = useAppStore.getState().tabs.original!.layout.root
  expect(node.type).toBe('split')
  if (node.type !== 'split') throw new Error('Expected an actual nonempty split')
  return node.ratio
}
function leaf() {
  const element = container.querySelector<HTMLElement>('[data-leaf-session="original-session"]')
  expect(element).not.toBeNull()
  return element!
}
async function firstSplit() {
  await act(async () => useAppStore.getState().splitRegion(workspaceId, 'original', 'original-region', 'right'))
  expect(ratio()).toBe(0.5)
  expect(panelGroup().handle.getLayout()).toEqual([50, 50])
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const config = await api.config.get(), { sessions } = await api.sessions.snapshot(), workspace = config.workspaces[0]!
  workspaceId = workspace.id
  const session = { ...sessions[0]!, id: 'original-session' }
  const tab = createWorkbenchTab('original', { kind: 'agent', phase: 'attached', regionId: 'original-region', sessionId: session.id, workspaceId })
  const layout = addTabPlacement(createWorkspaceLayout('original-group'), 'original-group', tab.id)!
  useAppStore.setState({ config, sessions: [session], timelines: {}, tabs: { original: tab }, layouts: { [workspaceId]: layout }, activeWorkspaceId: workspaceId, providerCatalog: [], closingWorkbenchViews: {} })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  observed.groups.clear(); observed.dragging.clear(); observed.setLayouts = []; observed.mounts = 0; observed.unmounts = 0
  await act(async () => root.render(createElement(WorkspaceWorkbench, { workspaceId })))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('projects the second public split into the already mounted real Panel and preserves the original leaf', async () => {
  await firstSplit()
  const before = panelGroup(), content = leaf(), owner = (content as HTMLElement & { leafOwner: object }).leafOwner
  const lifecycle = { mounts: observed.mounts, unmounts: observed.unmounts }, run = useAppStore.getState().sessions[0]!.control.run
  const added = Object.keys(useAppStore.getState().tabs.original!.regions).find(id => id !== 'original-region')!
  expect(added).toBeTruthy()
  await act(async () => useAppStore.getState().splitRegion(workspaceId, 'original', added, 'down'))
  expect(ratio()).toBe(1 / 3)
  const current = panelGroup()
  expect(current.handle.getLayout()[0]).toBeCloseTo(100 / 3, 8)
  expect(Number(current.panels[0]!.style.flexGrow)).toBe(33.3)
  expect(leaf()).toBe(content)
  expect(current.element).toBe(before.element)
  expect((leaf() as HTMLElement & { leafOwner: object }).leafOwner).toBe(owner)
  expect({ mounts: observed.mounts, unmounts: observed.unmounts }).toEqual(lifecycle)
  expect(useAppStore.getState().sessions[0]!.control.run).toBe(run)
})

it('does no extra imperative or persisted write for initial and repeated accepted ratios', async () => {
  const writes = vi.spyOn(useAppStore.getState(), 'updateRegionSplitRatio')
  await firstSplit()
  expect(observed.setLayouts).toEqual([])
  expect(writes).not.toHaveBeenCalled()
  const original = leaf(), group = panelGroup().element
  await act(async () => useAppStore.getState().updateRegionSplitRatio(workspaceId, 'original', '', 0.4))
  expect(panelGroup().handle.getLayout()).toEqual([40, 60])
  expect(writes).toHaveBeenCalledTimes(1)
  expect(observed.setLayouts).toHaveLength(1)
  observed.setLayouts = []; writes.mockClear()
  await act(async () => useAppStore.setState(state => ({ tabs: { ...state.tabs, original: { ...state.tabs.original! } } })))
  await act(async () => useAppStore.getState().setAgentComposerDraft('unrelated', 'Draft'))
  expect(panelGroup().element).toBe(group)
  expect(leaf()).toBe(original)
  expect(observed.setLayouts).toEqual([])
  expect(writes).not.toHaveBeenCalled()
})

it('keeps real layout preview during a drag and commits its final intent through the existing writer', async () => {
  await firstSplit()
  const group = panelGroup(), handleId = group.element.querySelector<HTMLElement>(':scope > .workbench-region-resize-handle')!.dataset.panelResizeHandleId!
  const onDragging = observed.dragging.get(handleId)
  expect(onDragging).toBeDefined()
  const writes = vi.spyOn(useAppStore.getState(), 'updateRegionSplitRatio')
  await act(async () => onDragging!(true))
  await act(async () => group.handle.setLayout([70, 30]))
  expect(ratio()).toBe(0.5)
  expect(writes).not.toHaveBeenCalled()
  await act(async () => useAppStore.getState().updateRegionSplitRatio(workspaceId, 'original', '', 0.4))
  expect(group.handle.getLayout()).toEqual([70, 30])
  observed.setLayouts = []; writes.mockClear()
  await act(async () => onDragging!(false))
  expect(ratio()).toBe(0.7)
  expect(group.handle.getLayout()).toEqual([70, 30])
  expect(writes).toHaveBeenCalledTimes(1)
  expect(observed.setLayouts).toEqual([])
})

it('uses the same real Panel synchronization for the adjacent Tab Group branch', async () => {
  const other = createWorkbenchTab('other', { kind: 'launcher', regionId: 'other-region', workspaceId })
  await act(async () => useAppStore.setState(state => ({ tabs: { ...state.tabs, other }, layouts: { ...state.layouts, [workspaceId]: addTabPlacement(state.layouts[workspaceId]!, 'original-group', 'other')! } })))
  await act(async () => useAppStore.getState().moveTabToNewGroup(workspaceId, 'other', 'original-group', 'original-group', 'right'))
  // Establish this adjacent branch as a startup scene; only its ratio changes below.
  await act(async () => root.unmount())
  root = createRoot(container)
  await act(async () => root.render(createElement(WorkspaceWorkbench, { workspaceId })))
  const before = panelGroup('.pane-split'), content = leaf()
  const writes = vi.spyOn(useAppStore.getState(), 'updateSplitRatio')
  await act(async () => useAppStore.getState().updateSplitRatio(workspaceId, '', 0.4))
  const current = panelGroup('.pane-split')
  expect(current.handle.getLayout()).toEqual([40, 60])
  expect(Number(current.panels[0]!.style.flexGrow)).toBe(40)
  expect(current.element).toBe(before.element)
  expect(leaf()).toBe(content)
  expect(writes).toHaveBeenCalledTimes(1)
})
