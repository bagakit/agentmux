import type { SpaceSnapshot } from '@agentmux/core'
import type { SpaceMountRecord, SpaceMountView } from '../../../shared/space-mount'
import type { FolderSpaceRegistration, FolderSpaceResource } from '@agentmux/core/space-folder'
import { spaceMountKey } from '../../../shared/space-mount'
import { createWorkspaceLayout, createWorkbenchViewLayout, splitWorkbenchRegion, balanceWorkbenchRegionLayout, addTabOccurrence, groupIds, regionIds, type SplitTreeNode } from '@agentmux/layout'

/** Only this client's reference, composition and unsent input; the source owns membership. */
export type MountedSpaceInput = { kind?: 'space-member-input'; target: SpaceMountRecord; resource?: FolderSpaceResource | undefined; view?: SpaceMountView; drafts: Record<string, string>; launchers?: unknown; memberInputs?: unknown }
export type MountedSpaceObservation = { snapshot?: SpaceSnapshot; lastPresentSnapshot?: SpaceSnapshot; error?: string | undefined; reading: boolean }
export type MountedSpaceRegistrationInput = { kind: 'folder-registration'; hostId: string; registration: FolderSpaceRegistration; submitted: boolean; confirmed?: boolean; issue?: string }
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0')
const unreadable = (): never => { throw Error('The original Source view is unreadable. Its reference and input are retained; other work remains available.') }
export function mountedSpaceInputs(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  return object(value) ? value : unreadable()
}
function tree<Id extends 'groupId' | 'regionId'>(value: unknown, id: Id): value is SplitTreeNode<Record<Id, string>> {
  if (!object(value)) return false
  return value.type === 'leaf' ? text(value[id]) : value.type === 'split' && (value.direction === 'horizontal' || value.direction === 'vertical') &&
    typeof value.ratio === 'number' && Number.isFinite(value.ratio) && value.ratio >= .15 && value.ratio <= .85 && tree(value.first, id) && tree(value.second, id)
}
function view(value: unknown): value is SpaceMountView {
  if (!object(value) || !object(value.composition) || !tree(value.composition.root, 'groupId') || !Array.isArray(value.composition.groups) || !text(value.composition.activeGroupId) || !object(value.tabLayouts)) return false
  const groups = value.composition.groups
  if (!groups.every(group => object(group) && text(group.id) && (group.activeTabId === null || text(group.activeTabId)) && Array.isArray(group.tabOrder) && group.tabOrder.every(text) && Array.isArray(group.recentTabIds) && group.recentTabIds.every(text))) return false
  const ids = groupIds(value.composition.root)
  if (new Set(ids).size !== ids.length || ids.length !== groups.length || !groups.every(group => ids.includes(group.id as string)) || !ids.includes(value.composition.activeGroupId)) return false
  for (const layout of Object.values(value.tabLayouts)) if (!object(layout) || !tree(layout.root, 'regionId') || !text(layout.activeRegionId) || !regionIds(layout.root).includes(layout.activeRegionId)) return false
  const selection = value.selection
  return selection === null || object(selection) && ['tabId', 'regionId', 'groupId'].every(key => text(selection[key]))
}
/** A readable locator remains usable when a separate private view fragment is unreadable. */
export function memberSpaceInputTarget(value: unknown, key: string): SpaceMountRecord | undefined {
  const entry = mountedSpaceInputs(value)[key]
  if (entry === undefined) return undefined
  if (!object(entry) || entry.kind !== undefined && entry.kind !== 'space-member-input' || !object(entry.target) || !text(entry.target.hostId) || !text(entry.target.zoneId) || !text(entry.target.workspaceId) ||
    !object(entry.target.reference) || !text(entry.target.reference.runtimeId) || !text(entry.target.reference.spaceId) ||
    key !== spaceMountKey({ runtimeId: entry.target.reference.runtimeId, spaceId: entry.target.reference.spaceId })) return unreadable()
  return entry.target as SpaceMountRecord
}
/** A private member input is not an explicit mounted navigation destination. */
export function mountedSpaceTarget(value: unknown, key: string): SpaceMountRecord | undefined {
  const entry = mountedSpaceInputs(value)[key]
  if (object(entry) && entry.kind === 'space-member-input') return undefined
  return memberSpaceInputTarget(value, key)
}
export function mountedSpaceInput(value: unknown, key: string): MountedSpaceInput | undefined {
  const target = memberSpaceInputTarget(value, key)
  if (!target) return undefined
  const entry = mountedSpaceInputs(value)[key]
  if (!object(entry) || !object(entry.drafts) || !Object.values(entry.drafts).every(draft => typeof draft === 'string') || entry.view !== undefined && !view(entry.view)) return unreadable()
  return entry as MountedSpaceInput
}
/** Created only by a private edit/checkpoint, never by observing a Session. */
export function ensureMemberSpaceInput(value: unknown, key: string, target: SpaceMountRecord): Record<string, unknown> {
  const entries = mountedSpaceInputs(value)
  if (key !== spaceMountKey(target.reference)) return unreadable()
  if (entries[key] === undefined) return { ...entries, [key]: { kind: 'space-member-input', target, drafts: {} } satisfies MountedSpaceInput }
  const original = memberSpaceInputTarget(entries, key)
  if (!original || original.reference.runtimeId !== target.reference.runtimeId || original.reference.spaceId !== target.reference.spaceId) return unreadable()
  return entries
}
/** Retain only original-workface locator/resource data; it never selects a second navigation destination. */
export function openSourceFolderInput(value: unknown, target: SpaceMountRecord, resource?: FolderSpaceResource): Record<string, unknown> {
  const key = spaceMountKey(target.reference)
  return editMountedSpaceInput(value,key,current => {
    const retained = { ...current } as MountedSpaceInput & { navigation?: unknown }
    delete retained.kind
    delete retained.navigation
    return { ...retained, target: { ...current?.target,...target }, resource: resource ?? current?.resource, drafts: current?.drafts ?? {} }
  })
}
/** Malformed or other-source entries remain opaque; an edit replaces only its exact readable entry. */
export function editMountedSpaceInput(value: unknown, key: string, edit: (current: MountedSpaceInput | undefined) => MountedSpaceInput): Record<string, unknown> {
  const original = mountedSpaceInputs(value), current = mountedSpaceInput(original, key), next = edit(current)
  if (spaceMountKey(next.target.reference) !== key) return unreadable()
  return next === current ? original : { ...original, [key]: next }
}
/** An unreadable optional window layout cannot prevent an exact member draft edit. */
export function editMountedSpaceDraftInput(value: unknown, key: string, tabId: string, regionId: string, text: string, selectedView?: SpaceMountView, privateTarget?: SpaceMountRecord, zoneId?: string): Record<string, unknown> {
  const entries = privateTarget ? ensureMemberSpaceInput(value,key,privateTarget) : mountedSpaceInputs(value), target = memberSpaceInputTarget(entries,key), current = entries[key]
  if (!target || !object(current) || !object(current.drafts)) return unreadable()
  const draftKey = mountedRegionKey(target.reference,tabId,regionId,zoneId)
  return current.drafts[draftKey] === text && (!selectedView || current.view === selectedView) ? entries :
    { ...entries, [key]: { ...current, ...(selectedView ? { view: selectedView } : {}), drafts: { ...current.drafts, [draftKey]: text } } }
}
export function mountedRegistrationKey(input: Pick<MountedSpaceRegistrationInput, 'hostId' | 'registration'>): string {
  const { registration: r } = input
  return JSON.stringify(['folder-registration', input.hostId, r.runtimeId, r.workspaceId, r.expectedResource.hostId, r.expectedResource.workspacePath, r.expectedResource.projectRootPath])
}
export function mountedRegistrationInput(value: unknown, key: string): MountedSpaceRegistrationInput | undefined {
  const entry = mountedSpaceInputs(value)[key]
  if (entry === undefined) return undefined
  if (!object(entry) || entry.kind !== 'folder-registration' || !text(entry.hostId) || !object(entry.registration) || !text(entry.registration.runtimeId) || !text(entry.registration.workspaceId) || !object(entry.registration.expectedResource) ||
    typeof entry.submitted !== 'boolean' || entry.confirmed !== undefined && typeof entry.confirmed !== 'boolean' || entry.issue !== undefined && typeof entry.issue !== 'string') return unreadable()
  const expected = entry.registration.expectedResource
  if (!['hostId', 'workspacePath', 'projectRootPath'].every(field => text(expected[field]))) return unreadable()
  const input = entry as MountedSpaceRegistrationInput
  return mountedRegistrationKey(input) === key ? input : unreadable()
}
export function editMountedRegistration(value: unknown, key: string, edit: (current: MountedSpaceRegistrationInput | undefined) => MountedSpaceRegistrationInput | undefined): Record<string, unknown> {
  const entries = mountedSpaceInputs(value), current = mountedRegistrationInput(value, key), next = edit(current)
  if (next && mountedRegistrationKey(next) !== key) return unreadable()
  if (current === next) return entries
  const result = { ...entries }
  if (next) result[key] = next
  else delete result[key]
  return result
}
export const mountedRegionKey = (reference: SpaceMountRecord['reference'], tabId: string, regionId: string, zoneId?: string) => JSON.stringify(zoneId === undefined ? [reference.runtimeId, reference.spaceId, tabId, regionId] : [reference.runtimeId, reference.spaceId, zoneId, tabId, regionId])

/** Default composition is a view only. Never submit it to either Core's spatial graph. */
export function initialMountedSpaceView(snapshot: SpaceSnapshot): SpaceMountView {
  const groupId = JSON.stringify(['mounted-space-view', snapshot.reference.runtimeId, snapshot.reference.spaceId])
  const tabs = snapshot.scope.tabs, first = tabs[0], firstRegion = first?.regionIds[0]
  const tabLayouts = Object.fromEntries(tabs.flatMap(tab => {
    const first = tab.regionIds[0]
    if (!first) return []
    let layout = createWorkbenchViewLayout(first)
    for (const id of tab.regionIds.slice(1)) layout = splitWorkbenchRegion(layout, layout.activeRegionId, 'right', id)
    return [[tab.tabId, { ...balanceWorkbenchRegionLayout(layout), activeRegionId: first }]]
  }))
  return { composition: createWorkspaceLayout(groupId, tabs.map(tab => tab.tabId)),
    tabLayouts,
    selection: first && firstRegion ? { groupId, tabId: first.tabId, regionId: firstRegion } : null }
}
/** Source additions become visible without replacing any saved focus, ratio or input. */
export function projectMountedSpaceView(saved: SpaceMountView | undefined, snapshot: SpaceSnapshot): SpaceMountView {
  if (!saved) return initialMountedSpaceView(snapshot)
  let composition = saved.composition, tabLayouts = saved.tabLayouts
  const known = new Set(composition.groups.flatMap(group => group.tabOrder))
  for (const tab of snapshot.scope.tabs) {
    if (!known.has(tab.tabId)) composition = addTabOccurrence(composition, composition.activeGroupId, tab.tabId) ?? composition
    let layout = tabLayouts[tab.tabId]
    if (!layout && tab.regionIds[0]) layout = createWorkbenchViewLayout(tab.regionIds[0])
    if (!layout) continue
    const originalActive = layout.activeRegionId, regions = new Set(regionIds(layout.root))
    for (const region of tab.regionIds) if (!regions.has(region)) layout = splitWorkbenchRegion(layout, originalActive, 'right', region)
    if (layout !== tabLayouts[tab.tabId]) tabLayouts = { ...tabLayouts, [tab.tabId]: { ...layout, activeRegionId: originalActive } }
  }
  return composition === saved.composition && tabLayouts === saved.tabLayouts ? saved : { ...saved, composition, tabLayouts }
}
/** Both namespace and original semantic Runtime must agree; a route alias never becomes identity. */
export function acceptsMountedSnapshot(target: SpaceMountRecord, snapshot: SpaceSnapshot): boolean {
  return snapshot.reference.runtimeId === target.reference.runtimeId && snapshot.reference.spaceId === target.reference.spaceId &&
    snapshot.source.runtimeId === target.reference.runtimeId && (snapshot.scope.space === null || snapshot.scope.space.spaceId === target.reference.spaceId)
}

export type MountedSpaceRegion = {
  key: string
  reference: SpaceSnapshot['reference']
  region: SpaceSnapshot['scope']['regions'][number]
  tab: SpaceSnapshot['scope']['tabs'][number]
  zone: SpaceSnapshot['scope']['zones'][number] | undefined
}
/** One relevant source snapshot index; no local Session/layout lookup or alias normalization. */
export function mountedSpaceRegions(snapshot: SpaceSnapshot): MountedSpaceRegion[] {
  const tabs = new Map(snapshot.scope.tabs.map(tab => [tab.tabId, tab]))
  const zones = new Map(snapshot.scope.zones.map(zone => [zone.zoneId, zone]))
  return snapshot.scope.regions.flatMap(region => {
    const tab = tabs.get(region.tabId)
    return tab ? [{ key: mountedRegionKey(snapshot.reference, tab.tabId, region.regionId), reference: snapshot.reference, region, tab, zone: tab.zoneId === null ? undefined : zones.get(tab.zoneId) }] : []
  })
}
