import { spaceMountKey } from '../../../shared/space-mount'
import type { AppState } from '../store'
import { mountedSpaceTarget } from './space-mount-view'
import type { WorkbenchProjectionSelection } from './workbench-projection'

type State = Pick<AppState, 'tabs'> & Partial<Pick<AppState, 'mountedSpaceInputs' | 'mountedSpaceObservations'>>

/** A Source member projection never grants deletion of the original entity. */
export function requiresSourceWorkbenchClose(state: State, tabId: string, regionId?: string): boolean {
  const source = state.tabs[tabId]?.source
  if (!source || source.tabId.startsWith('new-work:')) return false
  const snapshot = state.mountedSpaceObservations?.[spaceMountKey(source.reference)]?.snapshot
  const region = regionId ? state.tabs[tabId]?.regions[regionId]?.source : undefined
  if (snapshot && region && 'reference' in region && !snapshot.scope.regions.some(member => member.tabId === region.tabId && member.regionId === region.regionId)) return false
  return !snapshot || snapshot.scope.tabs.some(tab => tab.tabId === source.tabId)
}

export function sourceWorkbenchCloseReference(state: State, reference: WorkbenchProjectionSelection, scope: 'tab' | 'region') {
  const tab = state.tabs[reference.tabId], source = tab?.source
  if (!source || !requiresSourceWorkbenchClose(state, reference.tabId, scope === 'region' ? reference.regionId : undefined)) return undefined
  const snapshot = state.mountedSpaceObservations?.[spaceMountKey(source.reference)]?.snapshot
  const surface = scope === 'tab' && snapshot ? Object.values(tab.regions).find(surface => {
    const member = surface.source
    return member && 'reference' in member && snapshot.scope.regions.some(original => original.tabId === source.tabId && original.regionId === member.regionId)
  }) : tab.regions[reference.regionId]
  const member = surface?.source
  if (!surface || !member || !('reference' in member)) throw Error('The original Source member is unconfirmed. Keep this workface and inputs; reconnect its original Source before closing.')
  const target = mountedSpaceTarget(state.mountedSpaceInputs, spaceMountKey(source.reference))
  if (!target || spaceMountKey(member.reference) !== spaceMountKey(source.reference) || member.tabId !== source.tabId)
    throw Error('The original Source route or Region is unconfirmed. Keep this workface and inputs; reconnect its original Source before closing.')
  return { destination: structuredClone({ hostId: target.hostId, reference: target.reference }),
    member: { tabId: member.tabId, regionId: member.regionId, kind: surface.kind, agentSessionId: member.agentSessionId ?? null, scope } }
}

export function sourceWorkbenchCloseHost(state: State, tabId: string): string | undefined {
  const source = state.tabs[tabId]?.source
  return source && mountedSpaceTarget(state.mountedSpaceInputs, spaceMountKey(source.reference))?.hostId
}
