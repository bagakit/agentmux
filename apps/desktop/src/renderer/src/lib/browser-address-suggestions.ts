import { resolveBrowserInput } from '../../../shared/browser-address'
import type { BrowserInputHistorySnapshot, BrowserInputHistoryTarget } from '../../../shared/browser-input-history'

/** Optional artwork already owned by the caller; never a reason to inspect or restore another page. */
export type BrowserAddressDescription = {
  browserId: string; workspaceId: string; profileId: string | null; mode: 'normal' | 'private'
  url: string; title: string; faviconDataUrl?: string | undefined
}
export type BrowserAddressSuggestion = {
  text: string; source: 'input' | 'history'; kind: 'address' | 'search' | 'input'
  title: string; detail: string; faviconDataUrl?: string | undefined
}

export function browserAddressSuggestions(history: BrowserInputHistorySnapshot | null, value: string, filtering: boolean,
  target: BrowserInputHistoryTarget | null, description?: BrowserAddressDescription): BrowserAddressSuggestion[] {
  const classify = (text: string) => {
    try { return resolveBrowserInput(text) }
    catch { return { kind: 'input' as const, url: '' } } // Decoration cannot change a malformed explicit address's submission.
  }
  const query = value.trim().toLocaleLowerCase()
  const rows: BrowserAddressSuggestion[] = (history?.entries ?? []).map(entry => {
    const resolved = classify(entry.text)
    const known = description && target?.kind === 'browser' && description.browserId === target.browserId &&
      description.mode === 'normal' && history!.scope.profileId !== null &&
      description.workspaceId === history!.scope.workspaceId && description.profileId === history!.scope.profileId &&
      description.profileId === target.profileId && resolved.kind === 'address' && resolved.url === description.url
    return { text: entry.text, source: 'history' as const, kind: resolved.kind,
      title: known && description.title ? description.title : entry.text,
      detail: known && description.title ? description.url : resolved.kind === 'search' ? 'Recent search' : resolved.kind === 'address' ? 'Recent address' : 'Recent input',
      ...(known && description.faviconDataUrl ? { faviconDataUrl: description.faviconDataUrl } : {}) }
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
