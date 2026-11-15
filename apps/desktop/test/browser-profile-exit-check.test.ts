import { describe, expect, it, vi } from 'vitest'
import { createBrowserProfileExitCheck } from '../src/main/browser-profile-exit-check.js'
import { BROWSER_PROFILE_EXIT_CHECK_URL_LIMIT, validBrowserProfileExitCheckUrl } from '../src/shared/browser-profile-exit-check-url.js'

/**
 * One explicit request through a Profile's own session. It goes out only after the Profile's route is
 * applied, reports status, time and a plain address, and a failure is unknown rather than an error.
 */
function setup(fetch: (url: string, init: { signal?: AbortSignal }) => Promise<Response>) {
  let clock = 1000
  const order: string[] = []
  const session = { fetch: vi.fn(async (url: string, init: { signal?: AbortSignal }) => { order.push('fetch'); clock += 184; return await fetch(url, init) }) }
  const check = createBrowserProfileExitCheck({
    session: vi.fn(() => session as never),
    prepare: vi.fn(() => { order.push('prepare'); return Promise.resolve() }),
    now: () => clock
  })
  return { check, session, order }
}

describe('Profile exit check', () => {
  it('applies the Profile route first, then sends one request and reads a plain address', async () => {
    const { check, session, order } = setup(async () => new Response(' 203.0.113.7\n', { status: 200 }))
    expect(await check('p-work', 'https://ip.example.test/')).toEqual({ status: 'reachable', httpStatus: 200, latencyMs: 184, ip: '203.0.113.7' })
    expect(order).toEqual(['prepare', 'fetch'])
    expect(session.fetch).toHaveBeenCalledExactlyOnceWith('https://ip.example.test/', expect.objectContaining({ method: 'GET', cache: 'no-store' }))
  })

  it('reports status and time without inventing an address when the body is a page', async () => {
    const { check } = setup(async () => new Response('<html>Your IP is 203.0.113.7 in Tokyo</html>', { status: 200 }))
    expect(await check('p-work', 'https://ip.example.test/')).toEqual({ status: 'reachable', httpStatus: 200, latencyMs: 184 })
  })

  it('a failed request is unknown with its reason, never an error that blocks', async () => {
    const { check } = setup(async () => { throw new Error('net::ERR_PROXY_CONNECTION_FAILED') })
    expect(await check('p-work', 'https://ip.example.test/')).toEqual({ status: 'unknown', reason: 'ERR_PROXY_CONNECTION_FAILED', latencyMs: 184 })
  })

  it('refuses a missing, plain-http or credentialed address before touching the session', async () => {
    const { check, session, order } = setup(async () => new Response('', { status: 200 }))
    const longAddress = 'https://ip.example.test/'.padEnd(BROWSER_PROFILE_EXIT_CHECK_URL_LIMIT, 'a')
    expect(validBrowserProfileExitCheckUrl(longAddress)).toBe(true)
    for (const address of ['', 'http://ip.example.test/', 'https://me:pw@ip.example.test/', 'not a url', longAddress + 'a']) {
      await expect(check('p-work', address), address).rejects.toMatchObject({ code: 'BROWSER_PROFILE_EXIT_CHECK_INVALID' })
    }
    expect(session.fetch).not.toHaveBeenCalled()
    expect(order).toEqual([])
    expect(validBrowserProfileExitCheckUrl('')).toBe(true)
  })

  it('does not infer an address from a bounded prefix of a larger response', async () => {
    const { check } = setup(async () => new Response('203.0.113.7' + ' '.repeat(4000) + '<html>Not a plain address</html>'))
    expect(await check('p-work', 'https://ip.example.test/')).toEqual({ status: 'reachable', httpStatus: 200, latencyMs: 184 })
    const invalid = setup(async () => new Response('::::'))
    expect(await invalid.check('p-work', 'https://ip.example.test/')).not.toHaveProperty('ip')
  })
})
