// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StableWorkbenchView } from '../src/renderer/src/components/StableWorkbenchView'
import { committedSecondaryWorkbenchTarget, focusedPrimaryWorkbenchTarget, type WorkbenchViewTarget } from '../src/renderer/src/lib/workbench-presentation'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { workbenchRegionProjectionSlotId } from '../src/renderer/src/lib/workbench-projection'

const tab = createWorkbenchTab('opaque-tab', { kind: 'agent', phase: 'attached', workspaceId: 'resource', regionId: 'original-region', sessionId: 'original-session' })
const reference = { displayWorkspaceId: 'exact-display', groupId: 'exact-group', tabId: tab.id, regionId: 'original-region' }
const target: WorkbenchViewTarget = { hostId: 'original-host', active: false, visible: true, surface: 'mote', reference }
let root: Root, container: HTMLElement, destination: HTMLElement, input: HTMLTextAreaElement
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({}) })
  container = document.createElement('div'); destination = document.createElement('div'); destination.id = target.hostId
  document.body.append(container, destination); root = createRoot(container)
  await act(async () => root.render(createElement(StableWorkbenchView, {
    homeId: 'original-home', targetId: target.hostId, primaryTabId: tab.id, reference, active: true, retainedRegionId: null,
    children: createElement('section', { 'data-workbench-region-id': 'original-region' }, createElement('textarea', { defaultValue: 'Existing draft' }))
  })))
  input = destination.querySelector('textarea')!; input.focus()
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); destination.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('uses the connected visible primary input and its exact committed occurrence, even when logical selection is elsewhere', () => {
  expect(document.activeElement).toBe(input)
  const geometry = vi.spyOn(input, 'getBoundingClientRect')
  expect(focusedPrimaryWorkbenchTarget({ ...tab, id: 'unrelated-tab' }, [target])).toBeUndefined()
  expect(geometry).not.toHaveBeenCalled()
  expect(focusedPrimaryWorkbenchTarget(tab, [target])).toBe(target)
  expect(geometry).toHaveBeenCalled()
  expect(input.value).toBe('Existing draft')
})
it('rejects a different display, Group, Tab, Region or host and unknown presentation visibility', () => {
  const unknownVisible = { ...target }; delete unknownVisible.visible
  const mismatches: WorkbenchViewTarget[] = [
    { ...target, reference: { ...reference, displayWorkspaceId: 'another-display' } },
    { ...target, reference: { ...reference, groupId: 'another-group' } },
    { ...target, reference: { ...reference, tabId: 'another-tab' } },
    { ...target, reference: { ...reference, regionId: 'another-region' } },
    { ...target, hostId: 'another-host' }, unknownVisible, { ...target, visible: false }
  ]
  for (const mismatch of mismatches) expect(focusedPrimaryWorkbenchTarget(tab, [mismatch])).toBeUndefined()
  expect(focusedPrimaryWorkbenchTarget({ ...tab, regions: {} }, [target])).toBeUndefined()
  expect(focusedPrimaryWorkbenchTarget(tab, [])).toBeUndefined()
})
it('does not retain an inert, hidden, disconnected or noneditable input', () => {
  destination.setAttribute('inert', ''); expect(focusedPrimaryWorkbenchTarget(tab, [target])).toBeUndefined(); destination.removeAttribute('inert')
  destination.hidden = true; expect(focusedPrimaryWorkbenchTarget(tab, [target])).toBeUndefined(); destination.hidden = false
  destination.remove(); expect(focusedPrimaryWorkbenchTarget(tab, [target])).toBeUndefined(); document.body.append(destination)
  input.blur(); expect(focusedPrimaryWorkbenchTarget(tab, [target])).toBeUndefined()
})
it('does not promote an editable secondary Stable View to a primary input owner', async () => {
  await act(async () => root.render(createElement(StableWorkbenchView, {
    homeId: 'original-home', targetId: target.hostId, reference, active: true, retainedRegionId: null,
    children: createElement('section', { 'data-workbench-region-id': 'original-region' }, createElement('textarea', { defaultValue: 'Existing draft' }))
  })))
  input.focus(); expect(document.activeElement).toBe(input)
  expect(input.closest<HTMLElement>('[data-workbench-view-reference]')?.dataset.workbenchViewReference).toBe(workbenchRegionProjectionSlotId('view', reference))
  expect(focusedPrimaryWorkbenchTarget(tab, [target])).toBeUndefined()
})

it('marks the original native Region with its actual body identity and full committed occurrence, rather than the selected sibling', async () => {
  await act(async () => root.render(createElement(StableWorkbenchView, {
    key: 'native-region', kind: 'region', nativeRegionId: 'original-region', homeId: 'original-home', targetId: target.hostId,
    reference: { ...reference, regionId: 'selected-sibling' }, active: true, retainedRegionId: null,
    children: createElement('section', { 'data-workbench-region-id': 'original-region' }, createElement('textarea', { defaultValue: 'Existing draft' }))
  })))
  const native = destination.querySelector<HTMLElement>('.retained-workbench-region')!
  expect(native).toBeTruthy()
  expect(native.dataset.workbenchRegionReference).toBe(workbenchRegionProjectionSlotId('primary', reference))
  expect(native.dataset.workbenchPrimaryTabId).toBeUndefined()
  expect(native.querySelector<HTMLTextAreaElement>('[data-workbench-region-id="original-region"] textarea')!.value).toBe('Existing draft')
})

it('keeps the unique committed home when logical selection changes to a valid sibling, and rejects an invalid home occurrence', async () => {
  const split = addWorkbenchRegion(tab, 'original-region', 'right', { kind: 'agent', phase: 'attached', workspaceId: 'resource',
    regionId: 'selected-sibling', sessionId: 'sibling-session' })
  const secondaryHome = document.createElement('div'); secondaryHome.id = 'secondary-host'; document.body.append(secondaryHome)
  const secondaryTarget = { ...target, hostId: secondaryHome.id }
  const homeReference = { ...reference, regionId: 'selected-sibling' }
  const homeHost = destination.querySelector<HTMLElement>('[data-workbench-primary-tab-id]')!
  const secondary = document.createElement('div'); secondary.dataset.workbenchViewReference = workbenchRegionProjectionSlotId('view', reference)
  secondaryHome.append(secondary)
  try {
    expect(committedSecondaryWorkbenchTarget(split, secondaryTarget, target.hostId, homeReference)).toBe(secondaryTarget)
    expect(homeHost.dataset.workbenchPrimaryReference).toBe(workbenchRegionProjectionSlotId('primary', reference))
    for (const invalid of [{ ...reference, regionId: 'missing-region' }, { ...reference, groupId: 'another-group' },
      { ...reference, displayWorkspaceId: 'another-display' }]) {
      homeHost.dataset.workbenchPrimaryReference = workbenchRegionProjectionSlotId('primary', invalid)
      expect(committedSecondaryWorkbenchTarget(split, secondaryTarget, target.hostId, homeReference)).toBeUndefined()
    }
    homeHost.dataset.workbenchPrimaryReference = workbenchRegionProjectionSlotId('primary', reference)
    for (const invalid of [{ ...reference, regionId: 'missing-region' }, { ...reference, groupId: 'another-group' },
      { ...reference, displayWorkspaceId: 'another-display' }]) {
      secondary.dataset.workbenchViewReference = workbenchRegionProjectionSlotId('view', invalid)
      expect(committedSecondaryWorkbenchTarget(split, secondaryTarget, target.hostId, homeReference)).toBeUndefined()
    }
    secondary.dataset.workbenchViewReference = workbenchRegionProjectionSlotId('view', reference)
    const duplicate = homeHost.cloneNode(false); destination.append(duplicate)
    expect(committedSecondaryWorkbenchTarget(split, secondaryTarget, target.hostId, homeReference)).toBeUndefined(); destination.removeChild(duplicate)
    secondaryHome.hidden = true
    expect(committedSecondaryWorkbenchTarget(split, secondaryTarget, target.hostId, homeReference)).toBeUndefined()
  } finally { secondaryHome.remove() }
})
