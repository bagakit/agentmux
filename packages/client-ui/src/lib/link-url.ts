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
