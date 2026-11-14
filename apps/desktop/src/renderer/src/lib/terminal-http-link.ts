const PROSE_PUNCTUATION = /[\u3000-\u303f\uff00-\uffef]/u
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u

/** Bare prose establishes the range. Explicit OSC 8 targets never use this trim. */
export function terminalHttpLinkText(token: string): string | null {
  const scheme = /^https?:\/\//i.exec(token)?.[0]
  if (!scheme) return null
  const end = token.slice(scheme.length).search(PROSE_PUNCTUATION)
  let value = end < 0 ? token : token.slice(0, scheme.length + end)
  const authority = /^([^/?#]+)(.*)$/u.exec(value.slice(scheme.length))
  if (!authority) return null
  const [, host = '', resource = ''] = authority
  // IDNs in the authority are unambiguous before a path separator. Outside
  // it, unescaped CJK is ambiguous with prose, so do not follow it.
  const prose = resource.search(CJK)
  if (prose >= 0) {
    const prefix = resource.slice(0, prose)
    if (prefix === '/' || prefix === '?' || prefix === '#') return null
    value = scheme + host + prefix
  } else if (!resource && /^[\x00-\x7f]/u.test(host)) {
    const cjk = host.search(CJK)
    if (cjk > 0 && /^[a-zA-Z0-9.-]+\.[a-zA-Z]+$/u.test(host.slice(0, cjk))) value = scheme + host.slice(0, cjk)
  }
  return trimTerminalUriPunctuation(value)
}

export function trimTerminalUriPunctuation(value: string): string {
  value = value.replace(/[.,;!]+$/u, '')
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']] as const) {
    let balance = 0
    for (const char of value) {
      if (char === open) balance++
      if (char === close) balance--
    }
    while (balance < 0 && value.endsWith(close)) {
      value = value.slice(0, -1)
      balance++
    }
  }
  return value
}
