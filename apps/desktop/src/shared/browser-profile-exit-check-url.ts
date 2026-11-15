export const BROWSER_PROFILE_EXIT_CHECK_URL_LIMIT = 2048

/** An empty address disables the optional check. */
export function validBrowserProfileExitCheckUrl(value: string): boolean {
  if (!value) return true
  if (value.length > BROWSER_PROFILE_EXIT_CHECK_URL_LIMIT) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch { return false }
}
