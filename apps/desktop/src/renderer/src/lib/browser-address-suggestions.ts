import { resolveBrowserInput } from '../../../shared/browser-address'
import type { BrowserInputHistorySnapshot } from '../../../shared/browser-input-history'
export type BrowserAddressSuggestion = {
  text: string; source: 'input' | 'history'; kind: 'address' | 'search' | 'input'
  title: string; detail: string; faviconDataUrl?: string | undefined
}

export function browserAddressSuggestions(history: BrowserInputHistorySnapshot | null, value: string, filtering: boolean): BrowserAddressSuggestion[] {
  const classify = (text: string) => {
    try { return resolveBrowserInput(text) }
    catch { return { kind: 'input' as const, url: '' } } // Decoration cannot change a malformed explicit address's submission.
  }
  const query = value.trim().toLocaleLowerCase()
  const folded = (text: string) => text.toLocaleLowerCase()
  const rows = (history?.entries ?? []).map(entry => {
    const resolved = classify(entry.text)
    const appearance = resolved.kind === 'address' ? entry.appearance : undefined
    const row: BrowserAddressSuggestion = { text: entry.text, source: 'history', kind: resolved.kind,
      title: appearance?.title || entry.text,
      detail: appearance?.url ?? (resolved.kind === 'search' ? 'Recent search' : resolved.kind === 'address' ? 'Recent address' : 'Recent input'),
      ...(appearance?.faviconDataUrl ? { faviconDataUrl: appearance.faviconDataUrl } : {}) }
    return { row, url: resolved.url }
  })
  if (!filtering || !query) return rows.slice(0, 8).map(({ row }) => row)
  const matches = rows.filter(({ row }) => [row.text, row.title, row.kind === 'address' ? row.detail : ''].some(text => folded(text).includes(query)))
  if (!matches.some(({ row }) => row.text === value)) {
    const { kind, url } = classify(value)
    matches.push({ url, row: { text: value, source: 'input', kind, title: value, detail: kind === 'search' ? 'Search the web' : 'Open address' } })
  }
  const rank = ({ row, url }: (typeof rows)[number]) => {
    if (row.kind === 'address') {
      const host = URL.parse(url)?.hostname.replace(/^www\./u, '') ?? ''
      if (folded(row.title) === query || folded(host) === query) return 0
      if ([row.title, host, row.text].some(text => folded(text).startsWith(query))) return 1
    }
    if (folded(row.text) === query) return 2
    return folded(row.text).startsWith(query) ? 3 : 4
  }
  const prioritized = matches.map(candidate => ({ row: candidate.row, rank: rank(candidate) })).sort((a, b) => a.rank - b.rank)
  return prioritized.slice(0, 8).map(({ row }) => row)
}
