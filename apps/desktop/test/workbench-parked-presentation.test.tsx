// @vitest-environment happy-dom
import { act, createElement, forwardRef, useContext, useImperativeHandle, useLayoutEffect, useRef, type ContextType } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ImperativePanelGroupHandle, PanelGroupProps } from 'react-resizable-panels'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultTab, fixtureMoteProjection, neighborTab, savedMoteKey } from './fixtures/mote-workface'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { useAppStore } from '../src/renderer/src/store'
import { readPmoTeamsTopicFloatingState, usePmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import * as workbenchProjection from '../src/renderer/src/lib/workbench-projection'
import { WorkbenchProjectionContext } from '../src/renderer/src/lib/workbench-projection'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'

const observed = vi.hoisted(() => ({ groups: new Map<string, {
  handle: ImperativePanelGroupHandle; onLayout: NonNullable<PanelGroupProps['onLayout']>
  context: ContextType<typeof WorkbenchProjectionContext>
}>() }))
// Forward the installed browser library and the original Source callbacks.
// Recording its public handle/onLayout does not replace Panels, their layout,
// the SplitRatioCommitter or the original Store writer.
vi.mock('react-resizable-panels', async () => {
  const actual = await vi.importActual<typeof import('react-resizable-panels')>(
    '../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.esm.js'
  )
  return { ...actual, PanelGroup: forwardRef<ImperativePanelGroupHandle, PanelGroupProps>((props, forwarded) => {
    const real = useRef<ImperativePanelGroupHandle>(null)
    const context = useContext(WorkbenchProjectionContext)
    useImperativeHandle(forwarded, () => ({
      getId: () => real.current!.getId(), getLayout: () => real.current!.getLayout(),
      setLayout: sizes => real.current!.setLayout(sizes)
    }), [])
    useLayoutEffect(() => {
      const handle = real.current!
      if (!props.onLayout) return
      const entry = { handle, onLayout: props.onLayout, context }
      observed.groups.set(handle.getId(), entry)
      return () => { if (observed.groups.get(handle.getId()) === entry) observed.groups.delete(handle.getId()) }
    }, [props.onLayout, context])
    return createElement(actual.PanelGroup, { ...props, ref: real })
  }) }
})

let app: MoteAppFixture
let updateFloating: ReturnType<typeof usePmoTeamsTopicFloatingState>[1]
function ReferenceActions() { [, updateFloating] = usePmoTeamsTopicFloatingState(); return null }
const groupId = 'parked-second-location'
const reference = { displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId,
  tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
beforeEach(() => { observed.groups.clear(); app = createMoteApp() })
afterEach(async () => { await app.dispose(); observed.groups.clear() })

function durableRatio() {
  const node = useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]!.root
  expect(node.type).toBe('split')
  if (node.type !== 'split') throw new Error('An original nonempty Workspace split is required')
  return node.ratio
}
function originalSplit() {
  const element = app.panel().querySelector<HTMLElement>('.workbench-layout-body > .pane-split')!
  expect(element).not.toBeNull()
  const entry = observed.groups.get(element.dataset.panelGroupId!)
  expect(entry).toBeDefined()
  expect(entry!.handle.getLayout()).toHaveLength(2)
  return { ...entry!, element }
}
async function knownThenUnknown(beforeUnknown?: () => void) {
  const state = useAppStore.getState(), first = state.layouts[SCRATCH_WORKSPACE_ID]!
  const second = createWorkspaceLayout(groupId, [defaultTab.id])
  useAppStore.setState({ layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: { ...first,
    root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: first.root, second: second.root },
    groups: [...first.groups, ...second.groups] } } })
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID,
    targetTabId: defaultTab.id, reference }))
  await app.mount(createElement(ReferenceActions))
  const split = originalSplit(), input = app.panel().querySelector<HTMLElement>('[aria-label="Message Agent"]')!
  expect(input).not.toBeNull()
  expect(input.closest<HTMLElement>('[data-workbench-group-id]')?.dataset.workbenchGroupId).toBe(groupId)
  const originalGroup = split.element.querySelector<HTMLElement>(`[data-pane-group-id="${groupId}"]`)!
  const originalSlot = input.closest<HTMLElement>('[data-workbench-group-id]')!
  expect(originalGroup).not.toBeNull()
  expect(originalGroup.contains(input)).toBe(true)
  beforeUnknown?.()
  const rawReference = { ...reference, groupId: 'missing-group' }
  await act(async () => updateFloating({ reference: rawReference })); await settleMoteApp()
  expect(originalSplit().element).toBe(split.element)
  expect(split.element.closest('[inert], [hidden], [aria-hidden="true"]')).toBeNull()
  expect(split.element.querySelector(`[data-pane-group-id="${groupId}"]`)).toBe(originalGroup)
  expect(originalGroup.contains(input)).toBe(true)
  expect(input.closest('[data-workbench-group-id]')).toBe(originalSlot)
  expect(app.panel().querySelector('.workbench-reference-body')).toBeNull()
  expect(originalSplit().context?.placementConfirmed).toBe(false)
  expect(originalSplit().context?.selection).toEqual([reference])
  expect(app.panel().querySelector('[aria-label="Message Agent"]')).toBe(input)
  expect(input.closest('[hidden], [inert]')).toBeNull()
  // Original physical content remains usable without turning its old Group
  // placement into a new action address on input focus.
  await act(async () => input.focus()); await settleMoteApp()
  expect(document.activeElement).toBe(input)
  expect(readPmoTeamsTopicFloatingState().reference).toEqual(rawReference)
  expect(originalSplit().context?.placementConfirmed).toBe(false)
  await act(async () => useAppStore.setState(current => {
    const layout = current.layouts[SCRATCH_WORKSPACE_ID]!
    if (layout.root.type !== 'split') throw new Error('The current durable split must remain present')
    return { layouts: { ...current.layouts, [SCRATCH_WORKSPACE_ID]: { ...layout,
      root: { ...layout.root, ratio: 0.65 } } } }
  })); await settleMoteApp()
  expect(durableRatio()).toBe(0.65)
  return { split, input, rawReference }
}

it('does not let the original unconfirmed Split callback overwrite a background durable ratio', async () => {
  const { split, input, rawReference } = await knownThenUnknown()
  const current = useAppStore.getState()
  // This retained callback is the actual original SplitBranch onLayout. Its
  // commitRef still belongs to the original mounted Source owner.
  await act(async () => split.onLayout([20, 80])); await settleMoteApp()
  expect(durableRatio()).toBe(0.65)
  expect(useAppStore.getState().layouts).toBe(current.layouts)
  expect(useAppStore.getState().tabs).toBe(current.tabs)
  expect(useAppStore.getState().sessions).toBe(current.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(current.agentComposerDrafts)
  expect(readPmoTeamsTopicFloatingState().reference).toEqual(rawReference)
  expect(app.panel().querySelector('[aria-label="Message Agent"]')).toBe(input)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('continues the original visible Split writer after confirming the current Group', async () => {
  const { split, input } = await knownThenUnknown()
  const recovery = [...app.panel().querySelectorAll<HTMLButtonElement>(`button[data-workbench-tab-id="${defaultTab.id}"]`)]
    .find(button => !button.closest('[inert], [hidden]') && button.closest<HTMLElement>('[data-pane-group-id]')?.dataset.paneGroupId === groupId)!
  expect(recovery).not.toBeNull()
  await moteClick(recovery)
  expect(readPmoTeamsTopicFloatingState().reference).toEqual(reference)
  const current = originalSplit(), state = useAppStore.getState()
  expect(current.element).toBe(split.element)
  expect(current.element.closest('[inert], [hidden]')).toBeNull()
  expect(current.context?.placementConfirmed).not.toBe(false)
  expect(current.handle.getLayout()).toEqual([65, 35])
  await act(async () => current.handle.setLayout([60, 40])); await settleMoteApp()
  expect(durableRatio()).toBe(0.6)
  expect(useAppStore.getState().layouts).not.toBe(state.layouts)
  expect(useAppStore.getState().tabs).toBe(state.tabs)
  expect(useAppStore.getState().sessions).toBe(state.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(state.agentComposerDrafts)
  expect(app.panel().querySelector('[aria-label="Message Agent"]')).toBe(input)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('refuses a previously held original selection after its Workbench unmounts', async () => {
  await knownThenUnknown()
  await act(async () => updateFloating({ reference })); await settleMoteApp()
  const selection = vi.spyOn(workbenchProjection, 'selectWorkbenchProjectionTab')
  const button = app.panel().querySelector<HTMLButtonElement>(`.workbench-layout-body [data-pane-group-id="${groupId}"] button[data-workbench-tab-id="${defaultTab.id}"]`)!
  expect(button).not.toBeNull()
  await moteClick(button)
  const held = selection.mock.calls.at(-1)?.[0].onSelect
  expect(held).toBeTypeOf('function')
  await app.remount()
  const state = useAppStore.getState(), selected = readPmoTeamsTopicFloatingState()
  await act(async () => held!({ ...reference, groupId: 'mote-group' })); await settleMoteApp()
  expect(readPmoTeamsTopicFloatingState().reference).toEqual(selected.reference)
  expect(useAppStore.getState().layouts).toBe(state.layouts)
  expect(useAppStore.getState().tabs).toBe(state.tabs)
  expect(useAppStore.getState().sessions).toBe(state.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(state.agentComposerDrafts)
  expect(useAppStore.getState().reportError).toHaveBeenCalled()
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('keeps the same original placement notice controls across known and repeated unknown', async () => {
  const selector = 'button[aria-label="View service notice: Original Tab retained"]'
  const { split, input, rawReference } = await knownThenUnknown(() => {
    expect(app.panel().querySelector(selector)).toBeNull()
  })
  const panel = app.panel(), before = useAppStore.getState()
  const trigger = panel.querySelector<HTMLButtonElement>(selector)!
  expect(panel.querySelectorAll(selector)).toHaveLength(1)
  expect(trigger.closest('[hidden], [inert], [aria-hidden="true"]')).toBeNull()
  const disclosure = trigger.closest<HTMLElement>('.service-disclosure')!
  const details = disclosure.querySelector<HTMLElement>('.service-disclosure__details')!
  expect(details.id).toBe(trigger.getAttribute('aria-controls'))
  expect(details.getAttribute('popover')).toBe('hint')
  expect(details.textContent).toContain('Original Tab retained')
  expect(details.textContent).toContain('Its Group placement is not confirmed')
  // Consume the original DOM-popover fixture boundary and actual original
  // disclosure handlers/read receipt, without claiming Native layout or hit.
  await moteClick(trigger)
  await act(async () => details.showPopover()); await settleMoteApp()
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  await moteClick(details.querySelector<HTMLButtonElement>('button[aria-label="Collapse service details: Original Tab retained"]')!)
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(disclosure.dataset.unread).toBe('false')
  expect(readPmoTeamsTopicFloatingState().reference).toEqual(rawReference)
  await act(async () => updateFloating({ reference })); await settleMoteApp()
  expect(panel.querySelector(selector)).toBe(trigger)
  const hiddenOwner = trigger.closest<HTMLElement>('[hidden]')!
  expect(hiddenOwner).not.toBeNull()
  expect(hiddenOwner.hidden).toBe(true)
  expect(details.matches(':popover-open')).toBe(false)
  expect(readPmoTeamsTopicFloatingState().reference).toEqual(reference)
  expect(originalSplit().element).toBe(split.element)
  expect(panel.querySelector('[aria-label="Message Agent"]')).toBe(input)
  await act(async () => updateFloating({ reference: rawReference })); await settleMoteApp()
  expect(panel.querySelectorAll(selector)).toHaveLength(1)
  expect(panel.querySelector(selector)).toBe(trigger)
  expect(trigger.closest('[hidden], [inert], [aria-hidden="true"]')).toBeNull()
  expect(disclosure.querySelector('.service-disclosure__details')).toBe(details)
  expect(disclosure.dataset.unread).toBe('false')
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(readPmoTeamsTopicFloatingState().reference).toEqual(rawReference)
  expect(originalSplit().element).toBe(split.element)
  expect(originalSplit().context?.placementConfirmed).toBe(false)
  expect(panel.querySelector('[aria-label="Message Agent"]')).toBe(input)
  expect(input.closest('[hidden], [inert], [aria-hidden="true"]')).toBeNull()
  expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(useAppStore.getState().viewModes).toBe(before.viewModes)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it.each(['target', 'prefix'] as const)('refuses a held cached selection after its public %s scope changes with the same callback', async change => {
  const state = useAppStore.getState(), first = state.layouts[SCRATCH_WORKSPACE_ID]!
  const second = createWorkspaceLayout(groupId, [defaultTab.id])
  useAppStore.setState({ layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: { ...first,
    root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: first.root, second: second.root },
    groups: [...first.groups, ...second.groups] } } })
  const projection = fixtureMoteProjection({ open: true, preview: false, targetTopicId: PMO_TEAMS_TOPIC_ID,
    targetTabId: defaultTab.id, reference }, vi.fn()).projection!
  expect(projection).not.toBeNull()
  // This is one stable public consumer of the original Workbench callback. It
  // forwards to the actual Store action; it is not an App callback recreated
  // by a new target or a replacement selector/committer.
  const select = vi.fn((tabId: string, selectedGroup?: string, displayWorkspaceId?: string) => {
    if (selectedGroup && displayWorkspaceId) useAppStore.getState().activateTab(displayWorkspaceId, selectedGroup, tabId)
  })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const render = (known: boolean, retainedTabId = defaultTab.id, viewHostPrefix = 'public-retained-scope') =>
    createElement(WorkspaceWorkbench, { workspaceId: SCRATCH_WORKSPACE_ID, topicId: PMO_TEAMS_TOPIC_ID,
      visible: true, viewOwnership: 'projection', retainedTabId, viewHostPrefix,
      onTabSelect: select, ...(known ? { projection } : {}) })
  try {
    await act(async () => root.render(render(true))); await settleMoteApp()
    const split = container.querySelector<HTMLElement>('.workbench-layout-body > .pane-split')!
    expect(split).not.toBeNull()
    await act(async () => root.render(render(false))); await settleMoteApp()
    expect(container.querySelector('.workbench-layout-body > .pane-split')).toBe(split)
    const context = observed.groups.get(split.dataset.panelGroupId!)!.context!
    expect(context.placementConfirmed).toBe(false)
    const held = context.onSelect
    // The current explicit cached choice still reaches the stable public
    // consumer and its original Store writer before the scope changes.
    await act(async () => held(reference)); await settleMoteApp()
    expect(select).toHaveBeenCalledExactlyOnceWith(defaultTab.id, groupId, SCRATCH_WORKSPACE_ID)
    select.mockClear()
    await act(async () => root.render(render(false,
      change === 'target' ? neighborTab.id : defaultTab.id,
      change === 'prefix' ? 'public-retained-scope-next' : 'public-retained-scope')))
    await settleMoteApp()
    const before = useAppStore.getState()
    const publicRoot = container.querySelector<HTMLElement>('.workspace-workbench')!
    expect(publicRoot.isConnected).toBe(true)
    const report = vi.mocked(before.reportError); report.mockClear()
    await act(async () => held(reference)); await settleMoteApp()
    expect(select).not.toHaveBeenCalled()
    expect(report).toHaveBeenCalledOnce()
    expect(useAppStore.getState().layouts).toBe(before.layouts)
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); container.remove() }
})
