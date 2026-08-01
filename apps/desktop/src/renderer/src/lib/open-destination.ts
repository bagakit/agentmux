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
 * The one scheme gate every link surface shares: normalise `rawUrl` if it is http(s), else return null.
 *
 * Both the Terminal and the conversation turn text into things a click can open, and both must make the
 * SAME decision about which schemes are openable — a `mailto:`/`file:`/`javascript:` URI is not. Kept
 * here, next to `dismissOpenDestinationRequest`, for the same reason: this is the surface a component
 * that must not pull in xterm at module load can still import. A second copy of this whitelist would
 * drift, and the drift only ever shows up as "one surface makes a dead link clickable and the other
 * does not" — a mismatch nobody files a bug for.
 */
export function parseHttpLinkUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
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
