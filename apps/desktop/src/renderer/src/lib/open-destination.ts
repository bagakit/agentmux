export const OPEN_DESTINATIONS = ['system', 'tab', 'left', 'right', 'up', 'down'] as const

export type OpenDestination = (typeof OPEN_DESTINATIONS)[number]

export type OpenHttpLinkOrigin = {
  workspaceId: string
  tabGroupId: string
  tabId?: string
  regionId?: string
}

export function openDestinationNeedsRegion(
  destination: OpenDestination
): destination is Exclude<OpenDestination, 'system' | 'tab'> {
  return destination !== 'system' && destination !== 'tab'
}

/**
 * Clear a pending destination-menu request only when the dismissal names the request still showing.
 *
 * Both link surfaces — the Terminal and the conversation — raise one menu at a time and identify each
 * open by a monotonic id, so a late close from a menu that was already superseded must not wipe the
 * newer one. Generic over the richer request shapes each surface carries; it only ever reads the id.
 * Lives here, not in a component, so it can be shared: the Terminal view pulls in xterm at module load
 * and cannot be imported from a surface that must not.
 */
export function dismissOpenDestinationRequest<T extends { id: number }>(
  current: T | null,
  requestId: number
): T | null {
  return current?.id === requestId ? null : current
}
