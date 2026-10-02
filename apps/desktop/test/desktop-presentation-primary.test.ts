// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxDesktopSelection } from '@agentmux/core'
import { installDesktopPresentationOwner, readDesktopPresentation } from '../src/renderer/src/lib/desktop-presentation'
import { workbenchRegionProjectionSlotId, type WorkbenchProjectionSelection } from '../src/renderer/src/lib/workbench-projection'
import type { WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'

const reference: WorkbenchProjectionSelection = { displayWorkspaceId: 'display', groupId: 'group', tabId: 'tab', regionId: 'region' }
const selection: AgentMuxDesktopSelection = { surface: 'space', mainSurface: 'workbench', goalId: null,
  space: { workspaceId: reference.displayWorkspaceId, groupId: reference.groupId, tabId: reference.tabId,
    regionId: reference.regionId, spaceId: 'space', zoneId: 'zone', topicId: null } }
const tab: WorkbenchTab = { id: 'tab', workspaceId: 'resource', titleRegionId: 'region',
  layout: { root: { type: 'leaf', regionId: 'region' }, activeRegionId: 'region' },
  regions: { region: { kind: 'agent', phase: 'attached', regionId: 'region', workspaceId: 'resource', sessionId: 'session' },
    sibling: { kind: 'launcher', regionId: 'sibling', workspaceId: 'resource' } } }
const tabs = { tab }
let main: HTMLElement, panel: HTMLElement, dispose: () => void
beforeEach(() => {
  // Finite reader tests control layout geometry; this is not a Native visibility receipt.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0,
    right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({}) })
  main = document.createElement('main'); main.dataset.desktopSurface = 'space'
  panel = document.createElement('aside'); panel.setAttribute('data-pmo-teams-topic-floating', '')
  document.body.append(main, panel)
  dispose = installDesktopPresentationOwner(() => ({ loading: false, overlays: { settings: false, quickSwitcher: false },
    floating: { state: 'pinned', topicId: 'topic', tabId: 'tab' } }))
})
afterEach(() => { dispose(); main.remove(); panel.remove(); vi.restoreAllMocks() })

function addRegion(parent: HTMLElement, role: 'primary' | 'native' | 'secondary', address = reference): HTMLElement {
  const slot = document.createElement('div'); slot.dataset.workbenchTabId = address.tabId
  const host = document.createElement('div')
  if (role === 'primary') {
    host.dataset.workbenchPrimaryTabId = address.tabId
    host.dataset.workbenchPrimaryReference = workbenchRegionProjectionSlotId('primary', address)
  } else if (role === 'native') {
    host.className = 'retained-workbench-region'
    host.dataset.workbenchRegionReference = workbenchRegionProjectionSlotId('primary', address)
  }
  const region = document.createElement('section'); region.dataset.workbenchRegionId = 'region'
  host.append(region); slot.append(host); parent.append(slot)
  return region
}

describe('exact primary presentation observation', () => {
  it.each([true, false])('reports the original borrowed View independently of secondary-first DOM order (%s)', secondaryFirst => {
    const secondary = addRegion(main, 'secondary'), primary = addRegion(panel, 'primary')
    if (!secondaryFirst) document.body.prepend(panel)
    const fact = readDesktopPresentation(selection, tabs)
    expect(fact.presentation.state).toBe('floating')
    expect(fact.floating.presentation).toBe('visible')
    expect(main.contains(secondary)).toBe(true); expect(panel.contains(primary)).toBe(true)
  })

  it('keeps a visible secondary floating presentation separate from the original primary in main', () => {
    addRegion(main, 'primary'); addRegion(panel, 'secondary')
    const fact = readDesktopPresentation(selection, tabs)
    expect(fact.presentation.state).toBe('main-visible')
    expect(fact.floating.presentation).toBe('visible')
  })

  it('uses the exact native Region occurrence after it leaves the original Tab host', () => {
    addRegion(main, 'secondary'); addRegion(panel, 'native')
    expect(readDesktopPresentation(selection, tabs).presentation.state).toBe('floating')
  })

  it('accepts a sibling Region in the same primary Tab occurrence without changing the selected Region', () => {
    addRegion(panel, 'primary', { ...reference, regionId: 'sibling' })
    const fact = readDesktopPresentation(selection, tabs)
    expect(fact.presentation).toMatchObject({ state: 'floating', regionId: 'region', tabId: 'tab' })
  })

  it.each(['displayWorkspaceId', 'groupId', 'tabId'] as const)('does not substitute another %s occurrence or a secondary for the selected primary', key => {
    addRegion(main, 'secondary'); addRegion(panel, 'primary', { ...reference, [key]: 'other' })
    expect(readDesktopPresentation(selection, tabs).presentation.state).toBe('pending')
  })

  it('does not let an outer primary Tab overwrite the exact address of its relocated native Region', () => {
    const region = addRegion(panel, 'native', { ...reference, groupId: 'other' })
    const outer = document.createElement('div'); outer.dataset.workbenchPrimaryTabId = 'tab'
    outer.dataset.workbenchPrimaryReference = workbenchRegionProjectionSlotId('primary', reference)
    const slot = region.parentElement!.parentElement!
    slot.replaceWith(outer); outer.append(slot)
    expect(readDesktopPresentation(selection, tabs).presentation.state).toBe('pending')
  })

  it('reports pending for ambiguous primary owners and hidden original content', () => {
    const a = addRegion(main, 'primary'), b = addRegion(panel, 'primary')
    expect(readDesktopPresentation(selection, tabs).presentation.state).toBe('pending')
    b.parentElement!.parentElement!.remove(); a.hidden = true
    expect(readDesktopPresentation(selection, tabs).presentation.state).toBe('pending')
  })

  it('reads presentation without moving the original input or changing its caret and draft', () => {
    addRegion(main, 'secondary')
    const region = addRegion(panel, 'primary'), input = document.createElement('textarea')
    input.value = 'Unsent draft'; region.append(input); input.focus(); input.setSelectionRange(2, 5)
    const focus = vi.spyOn(input, 'focus'), blur = vi.spyOn(input, 'blur'), events: string[] = []
    const listen = (event: Event): void => { events.push(event.type) }
    document.addEventListener('focusout', listen); document.addEventListener('focusin', listen)
    try {
      const fact = readDesktopPresentation(selection, tabs)
      expect(fact.presentation.state).toBe('floating')
      expect(fact.input).toMatchObject({ scope: 'floating', tabId: 'tab', regionId: 'region', sessionId: 'session' })
      expect(document.activeElement).toBe(input)
      expect([input.value, input.selectionStart, input.selectionEnd]).toEqual(['Unsent draft', 2, 5])
      expect(focus).not.toHaveBeenCalled(); expect(blur).not.toHaveBeenCalled(); expect(events).toEqual([])
    } finally { document.removeEventListener('focusout', listen); document.removeEventListener('focusin', listen) }
  })
})
