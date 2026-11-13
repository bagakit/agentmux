import type { Session } from 'electron'
import { isIP } from 'node:net'
import { getDomain } from 'tldts'
import type { BrowserProfileClearSiteApproval, BrowserProfileSite } from '../shared/contracts.js'

/**
 * One site's sign-ins and site data inside one Profile.
 *
 * A "site" is the registrable domain (example.co.uk, not www.example.co.uk): Chromium clears every
 * cookie under it for one origin, so naming anything narrower would promise to keep sign-ins it removes.
 * Site storage is per origin, so the clear names every origin of the site that holds cookies.
 * The list shows site names and counts only, never cookie names or values.
 */
export type BrowserProfileSiteDataPorts = {
  /** The Profile's own session; throws for an unknown Profile. */
  session(profileId: string): Session
}

function siteOf(rawDomain: string): string | null {
  const host = rawDomain.replace(/^\./, '').toLowerCase()
  if (!host) return null
  if (host === 'localhost' || isIP(host) > 0) return host
  return getDomain(host, { allowPrivateDomains: true }) ?? null
}

function clearError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

export function createBrowserProfileSiteData(ports: BrowserProfileSiteDataPorts) {
  async function hosts(profileId: string): Promise<Map<string, { hosts: Set<string>; cookies: number }>> {
    const sites = new Map<string, { hosts: Set<string>; cookies: number }>()
    for (const cookie of await ports.session(profileId).cookies.get({})) {
      const site = cookie.domain ? siteOf(cookie.domain) : null
      if (!site) continue
      const entry = sites.get(site) ?? { hosts: new Set<string>(), cookies: 0 }
      entry.hosts.add(cookie.domain!.replace(/^\./, '').toLowerCase())
      entry.cookies += 1
      sites.set(site, entry)
    }
    return sites
  }

  return {
    /** Sites with cookies in this Profile, most cookies first. */
    async list(profileId: string): Promise<BrowserProfileSite[]> {
      return [...(await hosts(profileId)).entries()]
        .map(([site, entry]) => ({ site, cookies: entry.cookies }))
        .sort((a, b) => b.cookies - a.cookies || a.site.localeCompare(b.site))
    },

    /** Clears one site after the person confirmed exactly this Profile and site. */
    async clear(profileId: string, site: string, approval: BrowserProfileClearSiteApproval): Promise<void> {
      if (approval?.kind !== 'user-confirmed' || approval.operation !== 'clear-site-data' || approval.scope !== 'profile-site' ||
        approval.profileId !== profileId || approval.site !== site) {
        throw clearError('Clearing a site’s data requires your confirmation for this Profile and site.', 'BROWSER_DESTRUCTIVE_APPROVAL_REQUIRED')
      }
      if (siteOf(site) !== site) throw clearError(`“${site}” is not a site name. Choose a site from the list.`, 'BROWSER_PROFILE_SITE_INVALID')
      const target = ports.session(profileId)
      const origins = new Set([`https://${site}`, `http://${site}`])
      const entry = (await hosts(profileId)).get(site)
      for (const host of entry?.hosts ?? []) { origins.add(`https://${host}`); origins.add(`http://${host}`) }
      await target.clearData({ origins: [...origins] })
      await target.flushStorageData()
    }
  }
}
export type BrowserProfileSiteData = ReturnType<typeof createBrowserProfileSiteData>
