/** Resolve address-bar text without DNS, navigation, or host policy side effects. */
export function resolveBrowserAddress(value: string): string {
  const input = value.trim()
  if (!input || input === 'about:blank') return 'about:blank'

  if (/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::|[/?#]|$)/i.test(input)) {
    return new URL(`http://${input}`).toString()
  }

  const authority = input.split(/[/?#]/, 1)[0] ?? ''
  // A domain's numeric port is not a URI scheme; explicit schemes retain their meaning.
  const domainPort = /^[^:@\s]+\.[^:@\s]+:\d+$/.test(authority)
  if (!domainPort && /^[A-Za-z][A-Za-z\d+.-]*:/.test(input)) {
    return new URL(input).toString()
  }

  // URL rewrites numbers (including decimals) to IPv4; only four raw octets are an IP hint.
  const numericText = Number.isFinite(Number(authority)) || /^[\d.]+$/.test(authority)
  const ipv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(authority)
  const hostHint = (authority.includes('.') && (!numericText || ipv4)) || /^\[[^\]]+\](?::\d+)?$/.test(authority)
  if (hostHint && !/[@\s]/.test(authority)) return new URL(`https://${input}`).toString()
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`
}
