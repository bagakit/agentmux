import { describe, expect, it, vi } from 'vitest'
import { createBrowserProfileSiteData } from '../src/main/browser-profile-site-data.js'

/**
 * Clearing one site's data inside one Profile. The approval must name exactly this Profile and site,
 * the clear stays inside that Profile's own session, and it covers every origin of the site that holds
 * cookies, because Chromium clears all cookies under the site anyway while storage is per origin.
 */
function fakeSession(cookies: { domain: string; name: string; value: string }[]) {
  return {
    cookies: { get: vi.fn(async () => cookies.map(cookie => ({ ...cookie }))) },
    clearData: vi.fn(async (_options: { origins: string[] }) => {}),
    flushStorageData: vi.fn(async () => {})
  }
}

const approval = (profileId: string, site: string) => ({ kind: 'user-confirmed' as const, operation: 'clear-site-data' as const, scope: 'profile-site' as const, profileId, site })

describe('Browser Profile site data', () => {
  const cookies = [
    { domain: 'github.com', name: 'a', value: 'secret-1' },
    { domain: '.github.com', name: 'b', value: 'secret-2' },
    { domain: 'gist.github.com', name: 'c', value: 'secret-3' },
    { domain: 'www.example.co.uk', name: 'd', value: 'secret-4' },
    { domain: 'localhost', name: 'e', value: 'secret-5' }
  ]

  it('lists sites by registrable domain with counts only, most cookies first', async () => {
    const work = fakeSession(cookies)
    const sites = createBrowserProfileSiteData({ session: () => work as never })
    const listed = await sites.list('p-work')
    expect(listed).toEqual([{ site: 'github.com', cookies: 3 }, { site: 'example.co.uk', cookies: 1 }, { site: 'localhost', cookies: 1 }])
    expect(JSON.stringify(listed)).not.toContain('secret')
  })

  it('clears every origin of that site in that Profile only, then flushes', async () => {
    const work = fakeSession(cookies), other = fakeSession(cookies)
    const sessionFor = vi.fn((profileId: string) => (profileId === 'p-work' ? work : other) as never)
    const sites = createBrowserProfileSiteData({ session: sessionFor })
    await sites.clear('p-work', 'github.com', approval('p-work', 'github.com'))
    expect(new Set(work.clearData.mock.calls[0]![0].origins)).toEqual(new Set([
      'https://github.com', 'http://github.com', 'https://gist.github.com', 'http://gist.github.com']))
    expect(work.flushStorageData).toHaveBeenCalledOnce()
    expect(other.clearData).not.toHaveBeenCalled()
    expect(sessionFor.mock.calls.every(([id]) => id === 'p-work')).toBe(true)
  })

  it('refuses without an approval for exactly this Profile and site, and clears nothing', async () => {
    const work = fakeSession(cookies)
    const sites = createBrowserProfileSiteData({ session: () => work as never })
    for (const wrong of [undefined, approval('p-other', 'github.com'), approval('p-work', 'example.co.uk'),
      { ...approval('p-work', 'github.com'), operation: 'delete-profile' }, { ...approval('p-work', 'github.com'), kind: 'agent' }]) {
      await expect(sites.clear('p-work', 'github.com', wrong as never)).rejects.toMatchObject({ code: 'BROWSER_DESTRUCTIVE_APPROVAL_REQUIRED' })
    }
    expect(work.clearData).not.toHaveBeenCalled()
  })

  it('refuses a name narrower or wider than a site, so the result is never smaller than promised', async () => {
    const work = fakeSession(cookies)
    const sites = createBrowserProfileSiteData({ session: () => work as never })
    for (const name of ['gist.github.com', 'co.uk', 'https://github.com', '']) {
      await expect(sites.clear('p-work', name, approval('p-work', name))).rejects.toMatchObject({ code: 'BROWSER_PROFILE_SITE_INVALID' })
    }
    expect(work.clearData).not.toHaveBeenCalled()
  })
})
