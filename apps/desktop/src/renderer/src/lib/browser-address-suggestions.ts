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
  const rows: BrowserAddressSuggestion[] = (history?.entries ?? []).map(entry => {
    const resolved = classify(entry.text)
    const appearance = resolved.kind === 'address' ? entry.appearance : undefined
    return { text: entry.text, source: 'history' as const, kind: resolved.kind,
      title: appearance?.title || entry.text,
      detail: appearance?.url ?? (resolved.kind === 'search' ? 'Recent search' : resolved.kind === 'address' ? 'Recent address' : 'Recent input'),
      ...(appearance?.faviconDataUrl ? { faviconDataUrl: appearance.faviconDataUrl } : {}) }
  }).filter(row => !filtering || !query || `${row.text}\n${row.title}`.toLocaleLowerCase().includes(query))
  if (!filtering || !query) return rows.slice(0, 8)
  rows.sort((a, b) => Number(b.text.toLocaleLowerCase().startsWith(query)) - Number(a.text.toLocaleLowerCase().startsWith(query)))
  if (rows.some(row => row.text === value)) return rows.slice(0, 8)
  const resolved = classify(value), current: BrowserAddressSuggestion = { text: value, source: 'input', kind: resolved.kind,
    title: value, detail: resolved.kind === 'search' ? 'Search the web' : 'Open address' }
  // A prefix completion and the unchanged query remain adjacent, distinct choices.
  rows.splice(rows[0]?.text.toLocaleLowerCase().startsWith(query) ? 1 : 0, 0, current)
  return rows.slice(0, 8)
}
