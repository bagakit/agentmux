import type { BrowserProfileStorageClearInput, BrowserProfileStorageSnapshot, BrowserProfileStorageReceipt } from '@agentmux/core/control'
import type { BrowserProfileSummary } from '../../../src/shared/contracts'
export const offlineProfiles: BrowserProfileSummary[] = [
  { id: 'everyday-profile', revision: 'everyday-revision', label: 'Everyday browsing', createdAt: 1, isDefault: true, source: null },
  { id: 'research-profile', revision: 'research-revision', label: 'Research', createdAt: 2, isDefault: false, source: null }
]
const usage = (value: number) => ({ logicalBytes: value, allocatedBytes: value, complete: true })
export function offlineSnapshot(profileId = offlineProfiles[0]!.id): BrowserProfileStorageSnapshot {
  const profile = offlineProfiles.find(profile => profile.id === profileId)!
  const origins = ['https://documents.example.invalid', 'https://assets.example.invalid', 'https://very-long-offline-resource-origin-for-a-narrow-toolkit.example.invalid']
  const sites = origins.map((origin, i) => ({ origin, storageKeys: [origin + '/', ...(i === 0 ? [origin + '/^0https://embedding.example.invalid'] : [])], usage: usage(i === 0 ? 4637478912 : 702529536) }))
  return { profileId, profileRevision: profile.revision, observedAt: 1794839400000, usage: usage(sites.reduce((sum, site) => sum + site.usage.logicalBytes, 0)), sites, unattributed: usage(0), issues: [] }
}
export function offlineReceipt(input: BrowserProfileStorageClearInput, status: BrowserProfileStorageReceipt['status'] = 'completed'): BrowserProfileStorageReceipt {
  return { ...structuredClone(input), status, requestedAt: 1794839400001, finishedAt: status === 'pending' ? null : 1794839400002,
    before: offlineSnapshot(input.profileId), after: status === 'completed' ? offlineSnapshot(input.profileId) : null,
    results: input.sites.flatMap(site => site.storageKeys.map(storageKey => ({ storageKey, status: status === 'completed' ? 'acknowledged' as const : status === 'cancelled' ? 'not-dispatched' as const : 'unknown' as const }))), issues: [] }
}
