/**
 * Why a cookie from another browser was not imported. Only these counts are kept with an imported
 * Profile; cookie names and values never leave the importer.
 */
export const BROWSER_PROFILE_COOKIE_SKIP_REASONS = [
  'expired',
  'invalid-cookie',
  'app-bound-encryption',
  'undecryptable',
  'non-transplantable',
  'partition-unreadable',
  'partition-family-unreadable'
] as const

export type BrowserProfileCookieSkipReason = (typeof BROWSER_PROFILE_COOKIE_SKIP_REASONS)[number]

/** Skipped cookies per reason. A reason with no skipped cookie is left out. */
export type BrowserProfileCookieSkipCounts = Partial<Record<BrowserProfileCookieSkipReason, number>>

/** Drop zero counts, so a stored record names only the reasons that actually happened. */
export function presentSkipCounts(counts: Readonly<Record<BrowserProfileCookieSkipReason, number>>): BrowserProfileCookieSkipCounts {
  const present: BrowserProfileCookieSkipCounts = {}
  for (const reason of BROWSER_PROFILE_COOKIE_SKIP_REASONS) if (counts[reason] > 0) present[reason] = counts[reason]
  return present
}
