import type { DesktopWorkbenchObservation } from '../../../shared/client-observation'
import { mountedSpaceTarget, mountedSpaceInput, projectMountedSpaceView } from './space-mount-view'
import { originalSourceEntryForSelection, type OriginalSpaceSelectionState } from './original-space-navigation'
import { desktopElementVisible } from './desktop-presentation'

/** Display facts only. The original Core selection and Session authority remain separate. */
export function observeMountedSpaceWindow(input: OriginalSpaceSelectionState): DesktopWorkbenchObservation['mountedSpace'] {
  const key = originalSourceEntryForSelection(input)?.key
  const unknown = { target: null, selection: null, presentation: 'unknown' as const, input: { kind: 'unknown' as const } }
  if (key === undefined) return input.workbenchSpaceSelection?.spaceId && input.workbenchSpaceSelection.zoneId ? unknown : null
  if (typeof key !== 'string') return unknown
  let target: ReturnType<typeof mountedSpaceTarget>, selection: NonNullable<DesktopWorkbenchObservation['mountedSpace']>['selection'] = null
  try { target = mountedSpaceTarget(input.mountedSpaceInputs, key) } catch { return unknown }
  if (!target) return unknown
  try {
    const entry = mountedSpaceInput(input.mountedSpaceInputs, key), observed = input.mountedSpaceObservations?.[key]
    const snapshot = observed?.snapshot?.scope.space === null ? observed.lastPresentSnapshot ?? observed.snapshot : observed?.snapshot
    selection = (snapshot ? projectMountedSpaceView(entry?.view, snapshot) : entry?.view)?.selection ?? null
  } catch { /* Unreadable private view cannot erase its separately readable source target. */ }
  const fact: NonNullable<DesktopWorkbenchObservation['mountedSpace']> = {
    target: { hostId: target.hostId, reference: { runtimeId: target.reference.runtimeId, spaceId: target.reference.spaceId } }, selection, presentation: 'unknown', input: { kind: 'unknown' }
  }
  if (typeof document === 'undefined') return fact
  const matches = [...document.querySelectorAll<HTMLElement>('[data-original-source-space]')].filter(node => node.dataset.originalSourceSpace === key)
  if (matches.length !== 1) return { ...fact, presentation: matches.length ? 'unknown' : 'pending' }
  const root = matches[0]!, visible = desktopElementVisible(root)
  fact.presentation = visible ? 'visible' : 'hidden'
  const active = root.ownerDocument.activeElement
  if (!active || !root.contains(active)) fact.input = { kind: 'none' }
  else {
    const element = active as HTMLElement, kind = element.tagName === 'TEXTAREA' ? 'textarea' : element.tagName === 'INPUT' ? 'input' : element.isContentEditable ? 'content-editable' : 'other'
    fact.input = { kind, connected: element.isConnected, visible: desktopElementVisible(element), inert: !!element.closest('[inert]') }
  }
  return fact
}
