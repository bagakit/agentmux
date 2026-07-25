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
