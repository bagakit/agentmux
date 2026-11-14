import { api } from './api'
import { checkpointMountedSpaceInputs, fileNavigationSelection, useAppStore } from '../store'
import { mountedAgentOpenInput, mountedAgentOpenKey, type MountedAgentOpenInput } from './space-mount-launch'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { acceptsMountedSnapshot, mountedSpaceInputs } from './space-mount-view'
import { applyOriginalLaunchNames } from './original-launch-names'
import { originalSpaceResource } from './original-space-navigation'

/** A changed Source carrier/selection never hides this original ordinary slot's request. */
export function ordinarySourceLauncherRequests(value: unknown, launcherId: string): MountedAgentOpenInput[] {
  const entries = mountedSpaceInputs(value), result: MountedAgentOpenInput[] = []
  for (const [key, raw] of Object.entries(entries)) {
    if (!raw || typeof raw !== 'object' || !('kind' in raw) || raw.kind !== 'agent-open' || !('origin' in raw) ||
      !raw.origin || typeof raw.origin !== 'object' || !('launcherId' in raw.origin) || raw.origin.launcherId !== launcherId) continue
    const input = mountedAgentOpenInput(entries, key)
    if (input) result.push(input)
  }
  return result
}

/** Same original Space admission owner as mounted work, with a private ordinary-slot origin. */
export async function sendSourceLauncherRequest(input: MountedAgentOpenInput, continueOriginal = false) {
  const key = mountedAgentOpenKey(input.target, input.slot), store = useAppStore.getState()
  if (input.submitted && !continueOriginal) throw Error('Check this original request before explicitly continuing it. It has not been sent again.')
  const before = mountedAgentOpenInput(store.mountedSpaceInputs, key)
  if (before && before.request !== input.request) throw Error('Another original request occupies this Launcher. Its complete input is retained.')
  let dispatched = false
  store.retainSpaceMountAgentOpen(key, current => {
    if (current && current.request !== input.request) return current
    const retained = { ...(current ?? input), submitted: true }; delete retained.issue
    return retained
  })
  try {
    await checkpointMountedSpaceInputs()
    if (mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, key)?.request !== input.request) throw Error('The original request changed before dispatch. No substitute was sent.')
    dispatched = true
    const receipt = await api.spaceMounts.call('open', { hostId: input.target.hostId, reference: input.target.reference, request: input.request })
    if (receipt.operationId !== input.request.operationId) throw Error('This receipt belongs to another original operation. Keep the original request and check its owner.')
    store.retainSpaceMountAgentOpen(key, current => current?.request === input.request ? { ...current, receipt } : current)
    const retained = mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, key)
    if (retained?.request === input.request) void applyOriginalLaunchNames({ kind: 'source', input: retained })
    return receipt
  } catch (cause) {
    store.retainSpaceMountAgentOpen(key, current => current?.request === input.request ? { ...current, submitted: input.submitted || dispatched,
      issue: `${dispatched ? 'The original Source task result is unknown.' : input.submitted ? 'The original task was not continued; its earlier result remains unknown.' : 'This task was not sent.'} ${presentError(cause)}` } : current)
    throw cause
  }
}

/** Explicit presentation handoff. The ACK and current Source occurrence must agree;
 * this does not copy business graph or Sessions into the observer's local workbench. */
export async function openSourceLauncherWork(input: MountedAgentOpenInput, report: NonNullable<MountedAgentOpenInput['receipt']>) {
  const address = report.to
  if (report.operationId !== input.request.operationId || !address || address.spaceId !== input.target.reference.spaceId || address.zoneId !== input.target.zoneId)
    throw Error('The original Source location is unconfirmed. Keep this request and check its original result.')
  const navigation = fileNavigationSelection(useAppStore.getState())
  const snapshot = await api.spaceMounts.call('snapshot', { hostId: input.target.hostId, reference: input.target.reference })
  if (!acceptsMountedSnapshot(input.target, snapshot) || !snapshot.scope.tabs.some(tab => tab.tabId === address.tabId && tab.regionIds.includes(address.regionId)) ||
    !snapshot.scope.regions.some(region => region.regionId === address.regionId && region.creationOperationId === input.request.operationId))
    throw Error('The original Source occurrence is not currently confirmed. Its request and your Launcher remain available.')
  if (fileNavigationSelection(useAppStore.getState()) !== navigation) return
  const store = useAppStore.getState()
  store.mountSpace(input.target, false)
  store.observeSpaceMount(input.target, { snapshot, reading: false })
  const resource = originalSpaceResource(useAppStore.getState(), input.target)
  store.openOriginalSpaceLocation({ target: input.target, resource,
    occurrence: { tabId: address.tabId, regionId: address.regionId, displayWorkspaceId: address.displayWorkspaceId, groupId: address.groupId } })
}
