// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultAgent, defaultTab, savedMoteKey } from './fixtures/mote-workface'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { useAppStore } from '../src/renderer/src/store'
import { readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingOpen, usePmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import * as workbenchProjection from '../src/renderer/src/lib/workbench-projection'

let app: MoteAppFixture
beforeEach(() => { app = createMoteApp() })
afterEach(async () => { await app.dispose() })
let updateFloating: ReturnType<typeof usePmoTeamsTopicFloatingState>[1]
function ReferenceActions() { [, updateFloating] = usePmoTeamsTopicFloatingState(); return null }
async function open() {
  await app.mount(createElement(ReferenceActions))
  const originalInput = app.container.querySelector('[aria-label="Message Agent"]')
  await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id }))
  await settleMoteApp()
  return originalInput
}
function addOccurrence() {
  useAppStore.setState(state => ({ layouts: { ...state.layouts, project: createWorkspaceLayout('other-location', [defaultTab.id]) } }))
}
function locations() {
  return [...app.panel().querySelectorAll<HTMLButtonElement>('.mote-context-notice button')].filter(button => button.textContent?.includes('Location'))
}
describe('actual Mote caller uses the shared Space workbench frame', () => {
  it('shows the healthy original input at its second exact Group without borrowing that address for the first', async () => {
    const state = useAppStore.getState(), first = state.layouts[SCRATCH_WORKSPACE_ID]!
    const second = createWorkspaceLayout('second-original-location', [defaultTab.id])
    useAppStore.setState({ layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: { ...first,
      root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: first.root, second: second.root },
      groups: [...first.groups, ...second.groups] } } })
    const reference = { displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'second-original-location', tabId: defaultTab.id, regionId: 'default-region' }
    localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id, reference }))
    const before = useAppStore.getState()
    await app.mount()
    const input = app.panel().querySelector<HTMLElement>('[aria-label="Message Agent"]')!
    expect(input).not.toBeNull()
    expect(input.closest('[hidden], [inert]')).toBeNull()
    expect(input.textContent).toContain('Default unsent')
    expect(input.closest<HTMLElement>('[data-workbench-group-id]')?.dataset.workbenchGroupId).toBe(reference.groupId)
    expect(readPmoTeamsTopicFloatingState().reference).toEqual(reference)
    expect(useAppStore.getState().layouts).toBe(before.layouts)
    expect(useAppStore.getState().sessions.map(session => [session.id, session.hostId, session.workspacePath, session.processState]))
      .toEqual(before.sessions.map(session => [session.id, session.hostId, session.workspacePath, session.processState]))
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })

  it('selects the newly created discussion at its exact original Group before the next catalog render', async () => {
    const state = useAppStore.getState(), first = state.layouts[SCRATCH_WORKSPACE_ID]!
    const second = createWorkspaceLayout('new-discussion-location', [])
    useAppStore.setState({ layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: { ...first,
      root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: first.root, second: second.root },
      groups: [...first.groups, ...second.groups], activeGroupId: second.activeGroupId } } })
    localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: null, reference: null }))
    await app.mount()
    const before = useAppStore.getState()
    const create = app.panel().querySelector<HTMLButtonElement>('[aria-label="New discussion"]')!
    expect(create).not.toBeNull()
    await moteClick(create)
    const current = useAppStore.getState(), selected = readPmoTeamsTopicFloatingState()
    const tab = selected.targetTabId ? current.tabs[selected.targetTabId] : undefined
    expect(tab).toBeDefined()
    expect(tab!.topicId).toBe(PMO_TEAMS_TOPIC_ID)
    expect(selected.reference).toEqual({ displayWorkspaceId: SCRATCH_WORKSPACE_ID,
      groupId: first.groups[0]!.id, tabId: tab!.id, regionId: tab!.layout.activeRegionId })
    // Original Topic composition omits the empty second Group; this empty
    // workface creates in its rendered first Group without moving background focus.
    expect(current.layouts[SCRATCH_WORKSPACE_ID]!.groups.find(group => group.id === first.groups[0]!.id)?.tabOrder).toContain(tab!.id)
    expect(current.layouts[SCRATCH_WORKSPACE_ID]!.activeGroupId).toBe(second.activeGroupId)
    expect(current.layouts[SCRATCH_WORKSPACE_ID]!.groups.find(group => group.id === first.groups[0]!.id)?.activeTabId)
      .toBe(before.layouts[SCRATCH_WORKSPACE_ID]!.groups[0]!.activeTabId)
    expect(current.workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
    expect(current.sessions).toBe(before.sessions)
    expect(current.agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(app.panel().querySelector('[aria-label="Agent prompt"]')).not.toBeNull()
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })

  it('creates a new discussion from the second original Group Tabbar and selects only that occurrence', async () => {
    const state = useAppStore.getState(), first = state.layouts[SCRATCH_WORKSPACE_ID]!
    const second = createWorkspaceLayout('new-discussion-second', [defaultTab.id])
    useAppStore.setState({ layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: { ...first,
      root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: first.root, second: second.root },
      groups: [...first.groups, ...second.groups] } } })
    const reference = { displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: second.activeGroupId, tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
    localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id, reference }))
    await app.mount()
    const before = useAppStore.getState()
    const group = [...app.panel().querySelectorAll<HTMLElement>('[data-pane-group-id]')].find(element => element.dataset.paneGroupId === second.activeGroupId)!
    expect(group).not.toBeNull()
    await moteClick(group.querySelector<HTMLButtonElement>('[aria-label="New discussion"]')!)
    const current = useAppStore.getState(), selected = readPmoTeamsTopicFloatingState()
    const tab = selected.targetTabId ? current.tabs[selected.targetTabId] : undefined
    expect(tab).toBeDefined(); expect(tab!.id).not.toBe(defaultTab.id)
    expect(selected.reference).toEqual({ displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: second.activeGroupId, tabId: tab!.id, regionId: tab!.layout.activeRegionId })
    expect(current.layouts[SCRATCH_WORKSPACE_ID]!.groups.find(value => value.id === second.activeGroupId)?.tabOrder).toContain(tab!.id)
    expect(current.layouts[SCRATCH_WORKSPACE_ID]!.activeGroupId).toBe(before.layouts[SCRATCH_WORKSPACE_ID]!.activeGroupId)
    expect(current.sessions).toBe(before.sessions); expect(current.agentComposerDrafts).toBe(before.agentComposerDrafts)
    const input = app.panel().querySelector<HTMLElement>('[aria-label="Agent prompt"]')!
    expect(input).not.toBeNull()
    expect(input.closest<HTMLElement>('[data-workbench-group-id]')?.dataset.workbenchGroupId).toBe(second.activeGroupId)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })

  it('keeps one original sidebar in a narrow Space without rewriting the wide preference or workface', async () => {
    const originalWidth = window.innerWidth
    const resize = async (width: number) => {
      await act(async () => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: width }); window.dispatchEvent(new Event('resize')) })
      await settleMoteApp()
    }
    try {
      await resize(1100)
      useAppStore.setState({ projectRailOpen: true, toolsOpen: true, toolDockWidth: 300 })
      await app.mount()
      const before = useAppStore.getState()
      const input = app.container.querySelector('[aria-label="Message Agent"]')
      expect(app.container.querySelector('.project-rail-shell')).not.toBeNull()
      expect(app.container.querySelector('[data-surface-tool-dock]')).not.toBeNull()
      await resize(600)
      expect(app.container.querySelector('.project-rail-shell')).toBeNull()
      const tools = app.container.querySelector<HTMLElement>('[data-surface-tool-dock]')!
      expect(tools).not.toBeNull()
      expect(parseFloat(tools.style.width)).toBeLessThanOrEqual(280)
      expect(app.container.querySelector('[data-project-rail-toggle]')?.getAttribute('aria-expanded')).toBe('false')
      expect(app.container.querySelector('[data-surface-tools-toggle]')?.getAttribute('aria-pressed')).toBe('true')
      await moteClick(app.container.querySelector<HTMLElement>('[data-project-rail-toggle]')!)
      expect(app.container.querySelector('.project-rail-shell')).not.toBeNull()
      expect(app.container.querySelector('[data-surface-tool-dock]')).toBeNull()
      await moteClick(app.container.querySelector<HTMLElement>('[data-surface-tools-toggle]')!)
      expect(app.container.querySelector('.project-rail-shell')).toBeNull()
      expect(app.container.querySelector('[data-surface-tool-dock]')).not.toBeNull()
      expect(useAppStore.getState().projectRailOpen).toBe(true)
      expect(useAppStore.getState().toolsOpen).toBe(true)
      expect(useAppStore.getState().toolDockWidth).toBe(300)
      await resize(1100)
      expect(app.container.querySelector('.project-rail-shell')).not.toBeNull()
      expect(app.container.querySelector('[data-surface-tool-dock]')).not.toBeNull()
      expect(app.container.querySelector<HTMLElement>('[data-surface-tool-dock]')?.style.width).toBe('300px')
      expect(app.container.querySelector('[aria-label="Message Agent"]')).toBe(input)
      expect(useAppStore.getState().layouts).toBe(before.layouts)
      expect(useAppStore.getState().tabs).toBe(before.tabs)
      expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
      expect(useAppStore.getState().sessions).toBe(before.sessions)
      expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
    } finally { await resize(originalWidth) }
  })

  it('keeps the original input with an explicit occurrence choice and restores that full tuple', async () => {
    useAppStore.setState({ activeWorkspaceId: 'project', mainSurface: 'board' })
    const originalInput = await open()
    const input = app.panel().querySelector('[aria-label="Message Agent"]')
    expect(input).not.toBeNull()
    const originalFrame = app.panel().querySelector('.mote-workface__original > .workspace-workbench')
    expect(originalFrame).not.toBeNull()
    await act(async () => addOccurrence()); await settleMoteApp()
    expect(app.panel().querySelector('.mote-workface__original > .workspace-workbench')).toBe(originalFrame)
    const before = useAppStore.getState()
    expect(locations()).toHaveLength(2)
    expect(app.panel().querySelector('[data-workbench-retained-reference]')).not.toBeNull()
    expect(app.panel().querySelector('[aria-label="Message Agent"]')).toBe(input)
    expect(readPmoTeamsTopicFloatingState()?.open).toBe(true)
    expect(app.panel().querySelector('[aria-label="Message Agent"]')?.textContent).toContain('Default unsent')
    expect(input?.textContent).toContain('Default unsent')
    await moteClick(locations().find(button => button.textContent?.startsWith('Project'))!)
    expect(readPmoTeamsTopicFloatingState().reference).toEqual({ displayWorkspaceId: 'project', groupId: 'other-location', tabId: defaultTab.id, regionId: 'default-region' })
    expect(app.panel().querySelector('.mote-workface__original > .workspace-workbench')).toBe(originalFrame)
    expect(app.panel().querySelector('.workbench-tab-strip')).not.toBeNull()
    expect(app.panel().querySelector('[aria-label="Message Agent"]')?.textContent).toContain('Default unsent')
    expect(app.panel().querySelector('.mote-conversations')).toBeNull()
    expect(useAppStore.getState().layouts).toBe(before.layouts)
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    await app.remount()
    expect(readPmoTeamsTopicFloatingState().reference?.groupId).toBe('other-location')
    expect(app.panel().querySelector('[aria-label="Message Agent"]')?.textContent).toContain('Default unsent')
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })
  it('keeps a healthy original View when its saved reference is wrong although a legal home remains', async () => {
    const originalInput = await open()
    const input = app.panel().querySelector('[aria-label="Message Agent"]')
    const body = app.panel().querySelector<HTMLElement>('.workbench-layout-body')!
    const originalLayout = body.firstElementChild
    const originalInputSlot = input?.parentElement
    expect(originalLayout).not.toBeNull()
    expect(body.hidden).toBe(false)
    const before = useAppStore.getState()
    const rawReference = { displayWorkspaceId: 'project', groupId: 'missing-group', tabId: defaultTab.id, regionId: 'default-region' }
    await act(async () => updateFloating({ reference: rawReference }))
    await settleMoteApp()
    expect(app.panel().querySelector('[data-workbench-retained-reference]')).not.toBeNull()
    expect(app.panel().querySelector('[aria-label="Message Agent"]')).toBe(input)
    expect(body.firstElementChild).toBe(originalLayout)
    expect(originalLayout?.isConnected).toBe(true)
    expect(body.hidden).toBe(false)
    expect(body.dataset.workbenchLayoutState).toBeUndefined()
    expect(body.hasAttribute('aria-hidden')).toBe(false)
    expect(body.hasAttribute('inert')).toBe(false)
    expect(app.panel().querySelector('.workbench-reference-body')).toBeNull()
    expect(input?.parentElement).toBe(originalInputSlot)
    expect(input?.closest('[hidden], [inert]')).toBeNull()
    expect(readPmoTeamsTopicFloatingState()?.open).toBe(true)
    expect(app.panel().querySelector('[aria-label="Message Agent"]')?.textContent).toContain('Default unsent')
    expect(app.panel().textContent).toContain('not confirmed')
    expect(locations()).toHaveLength(1)
    // Reading or typing in the healthy retained input is not a new placement
    // choice. The original, unconfirmed tuple must survive its native events.
    await act(async () => (input as HTMLElement).focus()); await settleMoteApp()
    expect(readPmoTeamsTopicFloatingState().reference).toEqual(rawReference)
    await moteClick(input as HTMLElement)
    expect(readPmoTeamsTopicFloatingState().reference).toEqual(rawReference)
    expect(useAppStore.getState().layouts).toBe(before.layouts)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
    expect(useAppStore.getState().retainedSpatialFocus).toBe(before.retainedSpatialFocus)
    await moteClick(locations()[0]!)
    expect(readPmoTeamsTopicFloatingState().reference?.displayWorkspaceId).toBe(SCRATCH_WORKSPACE_ID)
    expect(app.panel().querySelector('.workbench-layout-body')).toBe(body)
    expect(body.firstElementChild).toBe(originalLayout)
    expect(body.hidden).toBe(false)
    expect(body.dataset.workbenchLayoutState).toBeUndefined()
    expect(body.hasAttribute('aria-hidden')).toBe(false)
    expect(body.hasAttribute('inert')).toBe(false)
    expect(app.panel().querySelector('[aria-label="Message Agent"]')).toBe(originalInput)
    expect(app.panel().querySelector('[aria-label="Message Agent"]')?.textContent).toContain('Default unsent')
  })
  it('keeps the confirmed Group presentation while its action address is unconfirmed', async () => {
    const state = useAppStore.getState(), first = state.layouts[SCRATCH_WORKSPACE_ID]!
    const second = createWorkspaceLayout('retained-second-location', [defaultTab.id])
    useAppStore.setState({ layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: { ...first,
      root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: first.root, second: second.root },
      groups: [...first.groups, ...second.groups] } } })
    const selected = { displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: second.activeGroupId,
      tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
    localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID,
      targetTabId: defaultTab.id, reference: selected }))
    await app.mount(createElement(ReferenceActions))
    const body = app.panel().querySelector<HTMLElement>('.workbench-layout-body')!
    const firstGroup = body.querySelector<HTMLElement>(`[data-pane-group-id="${first.activeGroupId}"]`)!
    const placeholder = firstGroup.querySelector('.pane-state')!
    expect(placeholder?.textContent).toContain('Choose a Tab')
    const oldTabButton = firstGroup.querySelector<HTMLButtonElement>(`button[data-workbench-tab-id="${defaultTab.id}"]`)!
    const oldCreateButton = firstGroup.querySelector<HTMLButtonElement>('[aria-label="New discussion"]')!
    const selectionCalls = vi.spyOn(workbenchProjection, 'selectWorkbenchProjectionTab')
    const selectedGroup = body.querySelector<HTMLElement>(`[data-pane-group-id="${second.activeGroupId}"]`)!
    await moteClick(selectedGroup.querySelector<HTMLButtonElement>(`button[data-workbench-tab-id="${defaultTab.id}"]`)!)
    const originalSelection = selectionCalls.mock.calls.at(-1)![0].onSelect
    expect(originalSelection).toBeTypeOf('function')
    const before = useAppStore.getState()
    const rawReference = { ...selected, groupId: 'missing-group' }
    await act(async () => updateFloating({ reference: rawReference })); await settleMoteApp()
    expect(firstGroup.querySelector('.pane-state')).toBe(placeholder)
    expect(placeholder.isConnected).toBe(true)
    expect(body.hasAttribute('inert')).toBe(false)
    // A pending menu/callback can outlive native inert. Neither a placement
    // selection nor creation may execute against the parked presentation.
    await moteClick(oldCreateButton)
    await act(async () => originalSelection(selected)); await settleMoteApp()
    expect(readPmoTeamsTopicFloatingState().reference).toEqual(rawReference)
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().layouts).toBe(before.layouts)
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(useAppStore.getState().reportError).toHaveBeenCalled()
    const input = app.panel().querySelector<HTMLElement>('[aria-label="Message Agent"]')!
    expect(input.closest('[hidden], [inert]')).toBeNull()
    expect(input.textContent).toContain('Default unsent')
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
    // This is an explicit current button gesture. It carries the rendered
    // display/Group to the original fresh authority; cached catalog is not it.
    await moteClick(oldTabButton)
    expect(readPmoTeamsTopicFloatingState().reference).toEqual({ ...selected, groupId: first.activeGroupId })
  })
  it('recovers an unknown placement through the original Group Tab button without a second legacy selection', async () => {
    await open()
    // Group IDs are scoped by their display Workspace. A foreign occurrence
    // with the same Group ID cannot make this rendered Tab button ambiguous.
    await act(async () => useAppStore.setState(state => ({ layouts: { ...state.layouts,
      project: createWorkspaceLayout(state.layouts[SCRATCH_WORKSPACE_ID]!.groups[0]!.id, [defaultTab.id]) } })))
    await act(async () => updateFloating({ reference: { displayWorkspaceId: 'project', groupId: 'missing-group', tabId: defaultTab.id, regionId: 'default-region' } }))
    await settleMoteApp()
    const before = useAppStore.getState()
    const button = [...app.panel().querySelectorAll<HTMLButtonElement>(`button[data-workbench-tab-id="${defaultTab.id}"]`)]
      .find(element => !element.closest('[hidden], [inert]'))!
    expect(button).not.toBeNull()
    const group = button.closest<HTMLElement>('[data-workbench-group-id], [data-pane-group-id]')!
    const groupId = group.dataset.workbenchGroupId ?? group.dataset.paneGroupId!
    await moteClick(button)
    expect(readPmoTeamsTopicFloatingState().reference).toEqual({ displayWorkspaceId: SCRATCH_WORKSPACE_ID,
      groupId, tabId: defaultTab.id, regionId: 'default-region' })
    expect(app.panel().querySelector('.workbench-reference-body')).toBeNull()
    expect(useAppStore.getState().layouts).toBe(before.layouts)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })
  it('does not turn an explicitly empty Mote into a new Session after restoring the full preference', async () => {
    localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: null, reference: null }))
    await app.mount()
    expect(app.panel().dataset.moteTargetTab).toBeUndefined()
    expect(app.panel().querySelector('[aria-label="Message Agent"]')).toBeNull()
    expect(Object.keys(useAppStore.getState().tabs)).toContain(defaultTab.id)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })
  it('keeps current typing focus and caret when an additional location makes selection ambiguous', async () => {
    await open()
    const input = app.panel().querySelector<HTMLElement>('[aria-label="Message Agent"]')!
    expect(input.closest('[inert], [hidden], [aria-hidden="true"]')).toBeNull()
    await act(async () => { input.focus(); const text = input.querySelector('p')!.firstChild!; const range = document.createRange(); range.setStart(text, 4); range.collapse(true); const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range) })
    const before = useAppStore.getState()
    await act(async () => addOccurrence()); await settleMoteApp()
    expect(app.panel().querySelector('[aria-label="Message Agent"]')).toBe(input)
    expect(input.closest('[inert], [hidden], [aria-hidden="true"]')).toBeNull()
    expect(document.activeElement).toBe(input)
    expect(document.getSelection()?.anchorOffset).toBe(4)
    expect(readPmoTeamsTopicFloatingState()?.open).toBe(true)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })

  it('lets an open inner popover own Escape while its invoker holds focus', async () => {
    await open()
    await act(async () => updateFloating({ reference: { displayWorkspaceId: 'project', groupId: 'missing-group', tabId: defaultTab.id, regionId: 'default-region' } }))
    await settleMoteApp()
    const panel = app.panel(), input = panel.querySelector('[aria-label="Message Agent"]')
    const trigger = panel.querySelector<HTMLButtonElement>('.service-disclosure__trigger')!
    const details = panel.querySelector<HTMLElement>('.service-disclosure__details')!
    expect(trigger).not.toBeNull(); expect(details).not.toBeNull()
    await act(async () => { trigger.focus(); details.showPopover() })
    expect(document.activeElement).toBe(trigger)
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => trigger.dispatchEvent(event)); await settleMoteApp()
    expect(event.defaultPrevented).toBe(false)
    expect(readPmoTeamsTopicFloatingState()?.open).toBe(true)
    expect(panel.querySelector('[aria-label="Message Agent"]')).toBe(input)
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
    // The DOM fixture supplies no native Escape default; real Chromium proves
    // inner dismissal separately. The outer owner must leave that default free.
    await act(async () => details.hidePopover()); await settleMoteApp()
    expect(readPmoTeamsTopicFloatingState()?.open).toBe(true)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })

  it('keeps retained-reference details readable when the input occupies the original reading area', async () => {
    await open()
    await act(async () => updateFloating({ reference: { displayWorkspaceId: 'project', groupId: 'missing-group', tabId: defaultTab.id, regionId: 'default-region' } }))
    await settleMoteApp()
    const panel = app.panel(), surface = panel.querySelector<HTMLElement>('[data-workbench-retained-reference]')!
    const trigger = surface.querySelector<HTMLButtonElement>('.service-disclosure__trigger')!
    const details = surface.querySelector<HTMLElement>('.service-disclosure__details')!
    const body = surface.querySelector<HTMLElement>('.pane-body')!
    const composer = surface.querySelector<HTMLElement>('.agent-input-stack')!
    const input = surface.querySelector<HTMLElement>('[aria-label="Message Agent"]')!
    const bounds = new DOMRect(20, 272, 600, 442)
    const spies = [vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(bounds),
      vi.spyOn(body, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 360, 600, 354)),
      vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 372, 600, 342))]
    const before = useAppStore.getState()
    try {
      await moteClick(trigger)
      const top = parseFloat(details.style.top), height = parseFloat(details.style.maxHeight)
      // Enough room for the heading, close control and scrollable facts, inside
      // this original work surface rather than at the application corner.
      expect(height).toBeGreaterThan(100)
      expect(top).toBeGreaterThanOrEqual(bounds.top)
      expect(top + height).toBeLessThanOrEqual(bounds.bottom)
      expect(parseFloat(details.style.left)).toBeGreaterThanOrEqual(bounds.left)
      expect(surface.querySelector('[aria-label="Message Agent"]')).toBe(input)
      expect(input.closest('[inert], [hidden], [aria-hidden="true"]')).toBeNull()
      expect(readPmoTeamsTopicFloatingState()?.open).toBe(true)
      expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
      expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
    } finally { spies.forEach(spy => spy.mockRestore()) }
  })

})
