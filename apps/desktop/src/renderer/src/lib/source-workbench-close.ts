import { applySpaceChange } from '@agentmux/core/space-authority-codec'
import type { SpaceApplyReceipt } from '@agentmux/core'
import { spaceCloseDigest, type SpaceCloseProjection } from '@agentmux/core/space-close'
import { spaceMountKey } from '../../../shared/space-mount'
import type { AppState } from '../store'
import type { WorkbenchViewClosePlan } from './workbench-view-close'
import { mountedSpaceTarget } from './space-mount-view'

type State = Pick<AppState, 'tabs'> & Partial<Pick<AppState, 'mountedSpaceInputs' | 'mountedSpaceObservations'>>

/** Source routing contributes to the common close plan; it owns no lifecycle or ledger. */
export function sourceWorkbenchClose(state: State, plan: WorkbenchViewClosePlan): SpaceCloseProjection['source'] {
  const tab = state.tabs[plan.tabId], source = tab?.source
  if (!source || !plan.closesView || source.tabId.startsWith('new-work:')) return undefined
  const key = spaceMountKey(source.reference), target = mountedSpaceTarget(state.mountedSpaceInputs, key)
  const snapshot = state.mountedSpaceObservations?.[key]?.snapshot
  const original = snapshot?.scope.tabs.find(tab => tab.tabId === source.tabId && tab.zoneId === source.zoneId && tab.workspaceId === source.workspaceId)
  if (!target || !snapshot?.scope.space || target.zoneId !== source.zoneId || target.workspaceId !== source.workspaceId)
    throw Error('The original Space membership is unavailable. Keep this workface and retry its Space observation; Agent state is not required to close it.')
  // A confirmed Source close can leave a newer local editor buffer to review.
  // Closing that retained View again needs no second write to the absent entity.
  if (!original) return undefined
  const selected = plan.surfaces.flatMap(({ owner }) => {
    const current = tab.regions[owner.regionId]?.source
    const member = current && 'reference' in current && snapshot.scope.regions.find(region => region.regionId === current.regionId && region.tabId === source.tabId)
    if (!current || !('reference' in current) || spaceMountKey(current.reference) !== key || current.tabId !== source.tabId ||
      member && (current.agentSessionId ?? null) !== member.agentSessionId)
      throw Error('The original Region binding changed. Its current workface and inputs are retained; review its close again.')
    return member ? [current.regionId] : []
  })
  if (!selected.length) return undefined
  const removed = new Set(selected), remaining = original.regionIds.filter(id => !removed.has(id))
  return { hostId: target.hostId, edit: { reference: source.reference, expectedRevision: snapshot.revision,
    changes: remaining.length ? { tabs: [{ ...original, regionIds: remaining }], remove: { regions: selected } }
      : { remove: { tabs: [original.tabId], regions: selected } } } }
}

export function sourceWorkbenchCloseHost(state: State, plan: WorkbenchViewClosePlan): string | undefined {
  const source = state.tabs[plan.tabId]?.source
  return source && mountedSpaceTarget(state.mountedSpaceInputs, spaceMountKey(source.reference))?.hostId
}

/** A confirmed write advances only its exact observed revision, never a newer observation. */
export function sourceCloseObservation(state: State, source: NonNullable<SpaceCloseProjection['source']>, receipt: SpaceApplyReceipt) {
  const target = mountedSpaceTarget(state.mountedSpaceInputs, spaceMountKey(source.edit.reference))
  const snapshot = state.mountedSpaceObservations?.[spaceMountKey(source.edit.reference)]?.snapshot
  if (spaceCloseDigest(receipt.reference) !== spaceCloseDigest(source.edit.reference) || receipt.diskDurability !== 'confirmed' || receipt.revision <= source.edit.expectedRevision)
    throw Error('The original Space close acknowledgement is unconfirmed. Keep the close operation and inspect it; do not repeat the write.')
  if (!target || target.hostId !== source.hostId || !snapshot || snapshot.revision !== source.edit.expectedRevision) return undefined
  return { target, snapshot: applySpaceChange({ ...snapshot, source: receipt.source }, { reference: receipt.reference, source: receipt.source,
    fromRevision: snapshot.revision, revision: receipt.revision, delta: source.edit.changes }) }
}
