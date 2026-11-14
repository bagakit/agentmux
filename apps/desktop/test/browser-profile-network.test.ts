import { describe, expect, it, vi } from 'vitest'
import { browserProfileProxyConfig, formatBrowserProfileProxyServer, normalizeBrowserProfileNetwork, parseBrowserProfileProxyLine } from '../src/shared/browser-profile-network.js'
import { createBrowserProfileSessions } from '../src/main/browser-profile-session.js'

/**
 * A Profile's route is parsed strictly because Electron accepts malformed proxy rules and then
 * connects directly. It is applied to the Profile's own session before any page of it opens; a
 * route that cannot be applied refuses to open pages and never falls back to a direct connection.
 */
describe('Profile proxy line', () => {
  it('reads the lines people paste, defaulting a bare host:port to HTTP', () => {
    expect(parseBrowserProfileProxyLine('proxy.example.com:8080')).toEqual({ scheme: 'http', host: 'proxy.example.com', port: 8080 })
    expect(parseBrowserProfileProxyLine(' SOCKS5://10.0.0.2:1080/ ')).toEqual({ scheme: 'socks5', host: '10.0.0.2', port: 1080 })
    expect(parseBrowserProfileProxyLine('https://Proxy.Example.com')).toEqual({ scheme: 'https', host: 'proxy.example.com', port: 443 })
    expect(parseBrowserProfileProxyLine('[::1]:3128')).toEqual({ scheme: 'http', host: '[::1]', port: 3128 })
    const server = parseBrowserProfileProxyLine('socks4://gw.corp.test:9050')
    expect(parseBrowserProfileProxyLine(formatBrowserProfileProxyServer(server))).toEqual(server)
  })

  it('refuses a line that Electron would quietly turn into a direct connection', () => {
    for (const line of ['', 'bad host::', 'ftp://proxy:21', 'proxy.example.com:70000', '999.1.1.1:80', 'http://proxy/path?x=1']) {
      expect(() => parseBrowserProfileProxyLine(line), line).toThrow(expect.objectContaining({ code: 'BROWSER_PROFILE_NETWORK_INVALID' }))
    }
  })

  it('refuses credentials in the line so a password is never stored or shown back', () => {
    expect(() => parseBrowserProfileProxyLine('http://me:secret@proxy.example.com:8080')).toThrow(/Leave the user name and password out/)
  })

  it('normalizes routes from any caller and maps them to Electron', () => {
    expect(normalizeBrowserProfileNetwork({ mode: 'direct', server: 'ignored' })).toEqual({ mode: 'direct' })
    const route = normalizeBrowserProfileNetwork({ mode: 'proxy', server: 'gw.corp.test:3128', bypass: [' *.corp.test ', '', '*.corp.test', '<local>'] })
    expect(route).toEqual({ mode: 'proxy', server: { scheme: 'http', host: 'gw.corp.test', port: 3128 }, bypass: ['*.corp.test', '<local>'] })
    expect(browserProfileProxyConfig(route)).toEqual({ mode: 'fixed_servers', proxyRules: 'http://gw.corp.test:3128', proxyBypassRules: '*.corp.test,<local>' })
    expect(browserProfileProxyConfig({ mode: 'system' })).toEqual({ mode: 'system' })
    expect(() => normalizeBrowserProfileNetwork({ mode: 'proxy' })).toThrow(/needs a server/)
    expect(() => normalizeBrowserProfileNetwork({ mode: 'proxy', server: 'gw:1', bypass: ['a b'] })).toThrow(/not a host/)
  })
})

function fakeSession() {
  return { setProxy: vi.fn(async (_config: unknown) => {}), closeAllConnections: vi.fn(async () => {}) }
}
function fakeContents(session: unknown) {
  return { session, isDestroyed: () => false, setWebRTCIPHandlingPolicy: vi.fn() }
}

describe('Profile session route', () => {
  it('applies the route once, closes old connections, and skips an unchanged route', async () => {
    const work = fakeSession(), order: string[] = []
    work.setProxy.mockImplementation(async () => { order.push('setProxy') })
    work.closeAllConnections.mockImplementation(async () => { order.push('close') })
    const sessions = createBrowserProfileSessions({ session: () => work as never, openContents: () => [],
      network: () => ({ mode: 'proxy', server: { scheme: 'socks5', host: '10.0.0.2', port: 1080 } }) })
    await Promise.all([sessions.prepare('p-work'), sessions.prepare('p-work')])
    await sessions.prepare('p-work')
    expect(work.setProxy).toHaveBeenCalledExactlyOnceWith({ mode: 'fixed_servers', proxyRules: 'socks5://10.0.0.2:1080', proxyBypassRules: '' })
    expect(order).toEqual(['setProxy', 'close'])
  })

  it('a Profile without a route opens in the same turn, and a removed route goes back to the system settings', async () => {
    const work = fakeSession()
    let network: Parameters<typeof sessions.apply>[1] = undefined
    const sessions = createBrowserProfileSessions({ session: () => work as never, network: () => network, openContents: () => [] })
    // A session that was never routed already follows the system settings: nothing to wait for.
    expect(sessions.prepare('p-work')).toBeUndefined()
    expect(work.setProxy).not.toHaveBeenCalled()
    network = { mode: 'direct' }
    await sessions.prepare('p-work')
    network = undefined
    await sessions.prepare('p-work')
    expect(work.setProxy.mock.calls.map(([config]) => config)).toEqual([{ mode: 'direct' }, { mode: 'system' }])
  })

  it('applies one route at a time per session, so the newer route wins', async () => {
    const work = fakeSession(), order: string[] = []
    let releaseFirst!: () => void
    work.setProxy.mockImplementationOnce(async () => { order.push('first'); await new Promise<void>(resolve => { releaseFirst = resolve }) })
    work.setProxy.mockImplementation(async () => { order.push('second') })
    const sessions = createBrowserProfileSessions({ session: () => work as never, network: () => undefined, openContents: () => [] })
    const first = sessions.apply('p-work', { mode: 'direct' })
    const second = sessions.apply('p-work', { mode: 'proxy', server: { scheme: 'http', host: 'gw.corp.test', port: 3128 } })
    await vi.waitFor(() => expect(order).toEqual(['first']))
    releaseFirst(); await Promise.all([first, second])
    expect(order).toEqual(['first', 'second'])
    expect(work.setProxy).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'fixed_servers' }))
  })

  it('a route that cannot be applied refuses by code and is tried again next time', async () => {
    const work = fakeSession()
    work.setProxy.mockRejectedValueOnce(new Error('ERR_INVALID_ARGUMENT'))
    const sessions = createBrowserProfileSessions({ session: () => work as never, openContents: () => [],
      network: () => ({ mode: 'proxy', server: { scheme: 'http', host: 'gw.corp.test', port: 3128 } }) })
    await expect(sessions.prepare('p-work')).rejects.toMatchObject({ code: 'BROWSER_PROFILE_NETWORK_UNAVAILABLE', profileId: 'p-work' })
    expect(work.closeAllConnections).not.toHaveBeenCalled()
    await sessions.prepare('p-work')
    expect(work.setProxy).toHaveBeenCalledTimes(2)
  })

  it('keeps WebRTC on the proxy for new pages and child windows of a proxied Profile only', async () => {
    const work = fakeSession(), plain = fakeSession()
    const sessions = createBrowserProfileSessions({ session: id => (id === 'p-work' ? work : plain) as never, openContents: () => [],
      network: id => id === 'p-work' ? { mode: 'proxy', server: { scheme: 'http', host: 'gw.corp.test', port: 3128 } } : { mode: 'direct' } })
    await sessions.prepare('p-work'); await sessions.prepare('p-plain')
    const page = fakeContents(work), child = fakeContents(work), other = fakeContents(plain)
    for (const contents of [page, child, other]) sessions.observe(contents as never)
    expect(page.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp')
    expect(child.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp')
    expect(other.setWebRTCIPHandlingPolicy).not.toHaveBeenCalled()
  })

  it('a saved route change moves pages already open, and back to default when the proxy is removed', async () => {
    const work = fakeSession(), open = fakeContents(work), elsewhere = fakeContents(fakeSession())
    const sessions = createBrowserProfileSessions({ session: () => work as never, network: () => ({ mode: 'direct' }), openContents: () => [open, elsewhere] as never })
    await sessions.apply('p-work', { mode: 'proxy', server: { scheme: 'http', host: 'gw.corp.test', port: 3128 } })
    expect(open.setWebRTCIPHandlingPolicy).toHaveBeenLastCalledWith('disable_non_proxied_udp')
    await sessions.apply('p-work', { mode: 'direct' })
    expect(open.setWebRTCIPHandlingPolicy).toHaveBeenLastCalledWith('default')
    expect(elsewhere.setWebRTCIPHandlingPolicy).not.toHaveBeenCalled()
  })
})
