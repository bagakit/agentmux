import type { BrowserProfileSummary } from '../../../shared/contracts'
import type { BrowserDirectoryRow } from './browser-resource-view'

export type BrowserProfileUseCount = { open: number; saved: number; unconfirmed: number }

/** One Main directory observation, aggregated once for all Profiles; positions never multiply a Browser. */
export function browserProfileUseCounts(rows: readonly BrowserDirectoryRow[], coverage: 'complete' | 'partial' | null) {
  const counts = new Map<string, BrowserProfileUseCount>()
  let complete = coverage === 'complete'
  for (const row of new Map(rows.map(row => [row.target.id, row])).values()) {
    const { target } = row
    if (!target.profile) {
      // Unconfirmed normal storage is never attributed to the default Profile.
      if (target.source === 'embedded' && target.mode !== 'private') complete = false
      continue
    }
    const count = counts.get(target.profile.id) ?? { open: 0, saved: 0, unconfirmed: 0 }
    if (!row.current || !target.resource || target.resource.state === 'unknown') { count.unconfirmed++; complete = false }
    else if (target.resource.state === 'live') count.open++
    else count.saved++
    counts.set(target.profile.id, count)
  }
  return { counts, complete }
}

export function browserProfileUseDescription(count: BrowserProfileUseCount | undefined, complete: boolean): string {
  if (!count || !count.open && !count.saved && !count.unconfirmed) return complete ? 'No open or saved Browsers' : 'Browser use unconfirmed'
  return [count.open ? `${count.open} ${complete ? '' : 'observed '}open` : '', count.saved ? `${count.saved} saved` : '',
    count.unconfirmed ? `${count.unconfirmed} unconfirmed` : ''].filter(Boolean).join(' · ')
}

/** Saved overrides, not a native application or complete-fingerprint claim. */
export function browserProfileEnvironmentDescription(profile: BrowserProfileSummary): string {
  const value = profile.environment
  const parts = [value?.acceptLanguages ? `Languages ${value.acceptLanguages.join(', ')}` : '', value?.timeZone ? `Time zone ${value.timeZone}` : '',
    value?.locale ? `Locale ${value.locale}` : '', value?.screen ? `Screen ${value.screen.width}×${value.screen.height}` : '',
    value?.hardwareConcurrency !== undefined ? `${value.hardwareConcurrency} CPU cores` : '', value?.geolocation ? 'Location' : '',
    value?.userAgent ? 'User agent' : '', value?.userAgentMetadata ? 'Client hints' : ''].filter(Boolean)
  return parts.length ? `Configured: ${parts.join(' · ')}` : 'Browser defaults'
}
