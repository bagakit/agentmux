/**
 * A Browser Profile's network route: how its pages reach the network.
 *
 * `system` follows the operating system's proxy settings, which is what a Profile does when it
 * names no route. `direct` connects without any proxy. `proxy` sends every request through one
 * server. The server is pasted as one line and parsed here, because Electron accepts malformed
 * proxy rules without complaint and then quietly connects directly; a route that cannot be
 * parsed is refused instead.
 *
 * Credentials never live in this record or in the line: a pasted `user:pass@` is refused, so the
 * password cannot be written to Profile metadata or shown back in the server field.
 */
export const BROWSER_PROFILE_PROXY_SCHEMES = ['http', 'https', 'socks4', 'socks5'] as const
export type BrowserProfileProxyScheme = (typeof BROWSER_PROFILE_PROXY_SCHEMES)[number]

export type BrowserProfileNetwork =
  | { mode: 'system' }
  | { mode: 'direct' }
  | { mode: 'proxy'; server: BrowserProfileProxyServer; bypass?: string[] }

export type BrowserProfileProxyServer = { scheme: BrowserProfileProxyScheme; host: string; port: number }

const DEFAULT_PORTS: Readonly<Record<BrowserProfileProxyScheme, number>> = { http: 80, https: 443, socks4: 1080, socks5: 1080 }
const BYPASS_MAX = 64
const BYPASS_RULE = /^(<local>|<-loopback>|[A-Za-z0-9*.:[\]/_-]{1,253})$/

export class BrowserProfileNetworkInvalid extends Error {
  readonly code = 'BROWSER_PROFILE_NETWORK_INVALID'
}

function hostIsValid(host: string): boolean {
  if (host.startsWith('[') && host.endsWith(']')) return /^\[[0-9a-fA-F:.]+\]$/.test(host)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host.split('.').every(part => Number(part) <= 255)
  const labels = host.split('.')
  return host.length <= 253 && labels.every(label => /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
}

/**
 * Read one pasted proxy line: `host:port`, `scheme://host:port` or `scheme://host`. A bare
 * `host:port` is HTTP, the most common proxy line people copy.
 */
export function parseBrowserProfileProxyLine(line: string): BrowserProfileProxyServer {
  const text = line.trim()
  if (!text) throw new BrowserProfileNetworkInvalid('Enter a proxy server, for example proxy.example.com:8080.')
  const match = /^(?:([A-Za-z0-9]+):\/\/)?([^/?#]+?)(?::(\d{1,5}))?\/?$/.exec(text)
  if (!match) throw new BrowserProfileNetworkInvalid(`“${text}” is not a proxy server. Use host:port or scheme://host:port.`)
  const [, rawScheme, host, rawPort] = match
  if (host!.includes('@')) {
    throw new BrowserProfileNetworkInvalid('Leave the user name and password out of the server line; AgentMux asks for them separately.')
  }
  const scheme = (rawScheme ?? 'http').toLowerCase()
  if (!(BROWSER_PROFILE_PROXY_SCHEMES as readonly string[]).includes(scheme)) {
    throw new BrowserProfileNetworkInvalid(`${scheme} is not a supported proxy type. Use http, https, socks4 or socks5.`)
  }
  if (!hostIsValid(host!)) throw new BrowserProfileNetworkInvalid(`“${host}” is not a host name or IP address.`)
  const port = rawPort === undefined ? DEFAULT_PORTS[scheme as BrowserProfileProxyScheme] : Number(rawPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new BrowserProfileNetworkInvalid(`Port ${rawPort} is out of range.`)
  return { scheme: scheme as BrowserProfileProxyScheme, host: host!.toLowerCase(), port }
}

/** The one line shown back for a parsed server; parsing it again gives the same server. */
export function formatBrowserProfileProxyServer(server: BrowserProfileProxyServer): string {
  return `${server.scheme}://${server.host}:${server.port}`
}

/** Bypass entries, one per item; empty entries are dropped and malformed ones are refused. */
export function parseBrowserProfileBypass(entries: readonly string[]): string[] {
  const rules = entries.map(entry => entry.trim()).filter(Boolean)
  if (rules.length > BYPASS_MAX) throw new BrowserProfileNetworkInvalid(`Use at most ${BYPASS_MAX} Don’t proxy entries.`)
  for (const rule of rules) if (!BYPASS_RULE.test(rule)) throw new BrowserProfileNetworkInvalid(`“${rule}” is not a host, domain or address range.`)
  return [...new Set(rules)]
}

/** Validates a route from any caller; returns the canonical value to store and apply. */
export function normalizeBrowserProfileNetwork(value: unknown): BrowserProfileNetwork {
  if (!value || typeof value !== 'object') throw new BrowserProfileNetworkInvalid('A network route needs a mode.')
  const route = value as { mode?: unknown; server?: unknown; bypass?: unknown }
  if (route.mode === 'system' || route.mode === 'direct') return { mode: route.mode }
  if (route.mode !== 'proxy') throw new BrowserProfileNetworkInvalid('A network route is system, direct or proxy.')
  const server = typeof route.server === 'string' ? parseBrowserProfileProxyLine(route.server)
    : route.server && typeof route.server === 'object'
      ? parseBrowserProfileProxyLine(formatBrowserProfileProxyServer(route.server as BrowserProfileProxyServer))
      : (() => { throw new BrowserProfileNetworkInvalid('A proxy route needs a server.') })()
  const bypass = route.bypass === undefined ? [] : Array.isArray(route.bypass) && route.bypass.every(item => typeof item === 'string')
    ? parseBrowserProfileBypass(route.bypass as string[])
    : (() => { throw new BrowserProfileNetworkInvalid('Don’t proxy entries must be a list of hosts.') })()
  return bypass.length ? { mode: 'proxy', server, bypass } : { mode: 'proxy', server }
}

/**
 * Electron's ProxyConfig for a route. Loopback is never proxied unless the person lists it, so a
 * local development server keeps working the same way as in an ordinary browser.
 */
export function browserProfileProxyConfig(network: BrowserProfileNetwork):
  { mode: 'system' } | { mode: 'direct' } | { mode: 'fixed_servers'; proxyRules: string; proxyBypassRules: string } {
  if (network.mode !== 'proxy') return { mode: network.mode }
  const { scheme, host, port } = network.server
  return { mode: 'fixed_servers', proxyRules: `${scheme}://${host}:${port}`, proxyBypassRules: (network.bypass ?? []).join(',') }
}
